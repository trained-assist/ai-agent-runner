import type { ChildProcess } from 'node:child_process';

/**
 * JSON-RPC 2.0 по stdio (newline-delimited JSON) — тот же кадр, который используют
 * MCP-серверы. Клиент намеренно минимальный: он не решает, что такое MCP, и не знает
 * про capabilities — только кадрирует сообщения, коррелирует ответы и отсекает висящие
 * запросы по таймауту.
 */

export const JSONRPC_VERSION = '2.0' as const;

/** Стандартные коды JSON-RPC + два наших для транспортных отказов. */
export const RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Инструмент вне scoped bindings рана (приёмка AC-115: чужой binding недоступен). */
  toolNotInScope: -32001,
  /** Транспорт/таймаут на стороне MCP-сервера. */
  transportTimeout: -32002,
} as const;

export type StdioRpcFailure = 'timeout' | 'transport_closed' | 'rpc_error';

export class StdioRpcError extends Error {
  readonly reason: StdioRpcFailure;
  readonly code: number | null;
  readonly data: unknown;
  /** Процесс сервера уже завершился (важно отличить «упал при старте» от «закрыл транспорт»). */
  readonly exited: boolean;

  constructor(reason: StdioRpcFailure, message: string, code: number | null = null, data: unknown = undefined, exited = false) {
    super(message);
    this.name = 'StdioRpcError';
    this.reason = reason;
    this.code = code;
    this.data = data;
    this.exited = exited;
  }
}

export interface StdioJsonRpcOptions {
  /** Строка stderr дочернего процесса (сырой поток, до redaction на стороне рана). */
  onStderr?: (line: string) => void;
  /** Потолок непрочитанного stdout без перевода строки: защита от залипшего сервера. */
  maxBufferBytes?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: StdioRpcError) => void;
  timer: NodeJS.Timeout;
  method: string;
}

const DEFAULT_MAX_BUFFER_BYTES = 1_000_000;

export class StdioJsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private closed = false;
  private readonly maxBufferBytes: number;

  constructor(
    private readonly child: ChildProcess,
    private readonly options: StdioJsonRpcOptions = {},
  ) {
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.attach();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private attach(): void {
    const stdout = this.child.stdout;
    if (stdout) {
      stdout.setEncoding('utf8');
      stdout.on('data', (chunk: string) => this.onStdout(chunk));
      // Закрытый stdout = сервер больше не ответит ни на что: для старта это отказ, а не пауза.
      stdout.on('end', () => this.failAll('transport_closed', 'mcp server closed its stdout', true));
      stdout.on('error', () => this.failAll('transport_closed', 'mcp server stdout failed'));
    } else {
      this.failAll('transport_closed', 'mcp server has no stdout pipe');
    }
    const stderr = this.child.stderr;
    if (stderr && this.options.onStderr) {
      const onStderr = this.options.onStderr;
      stderr.setEncoding('utf8');
      let errBuffer = '';
      stderr.on('data', (chunk: string) => {
        errBuffer += chunk;
        let index = errBuffer.indexOf('\n');
        while (index >= 0) {
          onStderr(errBuffer.slice(0, index).replace(/\r$/, ''));
          errBuffer = errBuffer.slice(index + 1);
          index = errBuffer.indexOf('\n');
        }
      });
      stderr.on('end', () => {
        const rest = errBuffer.replace(/\r$/, '');
        errBuffer = '';
        if (rest.length > 0) onStderr(rest);
      });
    }
    this.child.once('exit', (code, signal) => {
      this.failAll('transport_closed', `mcp server exited before answering (code=${String(code)}, signal=${String(signal)})`, true);
    });
    this.child.once('error', (err) => {
      this.failAll('transport_closed', `mcp server process error: ${err.message}`);
    });
  }

  private onStdout(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > this.maxBufferBytes) {
      this.failAll('transport_closed', `mcp server wrote more than ${this.maxBufferBytes} bytes without a newline`);
      return;
    }
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length > 0) this.onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Мусор в stdout не должен ронять handshake: это диагностика, а не протокол.
      this.options.onStderr?.(`[non-json stdout] ${line.slice(0, 500)}`);
      return;
    }
    const id = message['id'];
    if (typeof id !== 'number') return; // notification или серверный запрос — нас не интересует
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = message['error'];
    if (isRecord(error)) {
      pending.reject(
        new StdioRpcError(
          'rpc_error',
          typeof error['message'] === 'string' ? error['message'] : `rpc error for "${pending.method}"`,
          typeof error['code'] === 'number' ? error['code'] : RPC_ERROR_CODES.internalError,
          error['data'],
        ),
      );
      return;
    }
    pending.resolve(message['result']);
  }

  private failAll(reason: StdioRpcFailure, message: string, exited = false): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, pending] of entries) {
      clearTimeout(pending.timer);
      pending.reject(new StdioRpcError(reason, message, null, undefined, exited));
    }
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) throw new StdioRpcError('transport_closed', 'mcp server stdin is not writable');
    stdin.write(`${JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params })}\n`);
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) throw new StdioRpcError('transport_closed', 'mcp server stdin is not writable');
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new StdioRpcError('timeout', `"${method}" did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      stdin.write(`${JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params })}\n`);
    });
  }

  dispose(): void {
    this.failAll('transport_closed', 'mcp session disposed');
    this.buffer = '';
    this.child.stdout?.removeAllListeners();
    this.child.stderr?.removeAllListeners();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
