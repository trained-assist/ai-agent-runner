import { createServer, type Server, type Socket } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CapabilityError, type CapabilityCaller, type CapabilityOutcome, type CapabilityRegistry } from './capabilities.js';
import type { McpRunScope } from './scope.js';
import type { McpLogger } from './session.js';

/**
 * Хостовый мост рана: unix socket + run token, поверх которого дочерние процессы рана
 * (MCP-сервер и broker) получают tools/list, tools/call и вызов capability.
 *
 * Значения credential binding'ов по мосту не передаются: дочерний процесс присылает
 * только capabilityId и аргументы, а binding и caller подставляет хост из scoped bindings
 * рана. Модель/процесс не могут выбрать, под каким binding'ом исполнить действие.
 */

export interface McpBridgeCaller extends CapabilityCaller {}

export interface McpBridgeTool {
  serverId: string;
  name: string;
  description: string;
  bindingRef: string | null;
  bindingScope: string | null;
  requiredScopes: readonly string[];
  effect: 'read' | 'write';
  capabilityVersion: number;
}

export interface McpBridgeToolsList {
  tools: McpBridgeTool[];
}

export type McpBridgeCallResult =
  | { ok: true; serverId: string; tool: string; result: Record<string, unknown> }
  | { ok: false; serverId: string; tool: string; reason: string; detail?: string };

export type McpBridgeCapabilityResult =
  | { ok: true; outcome: CapabilityOutcome }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

export interface McpBridgeHandlers {
  toolsList(): Promise<McpBridgeToolsList>;
  callTool(request: { serverId: string; tool: string; arguments: Record<string, unknown> }): Promise<McpBridgeCallResult>;
  capabilityInvoke(request: { serverId: string; capabilityId: string; arguments: Record<string, unknown> }): Promise<McpBridgeCapabilityResult>;
}

export interface McpBridgeCallRequest {
  serverId: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface McpBridgeListenOptions {
  socketPath: string;
  runToken: string;
  runId: string;
  scope: McpRunScope;
  registry: CapabilityRegistry | null;
  log: McpLogger;
  caller: McpBridgeCaller;
  /** Значение binding'а для исходящего вызова capability; наружу (в дочерний процесс) не уходит. */
  bindingValue: (serverId: string) => Promise<string | undefined>;
  /** Вызов инструмента в stdio-сессии сервера (scope проверяется здесь, до похода в процесс). */
  callTool: (request: McpBridgeCallRequest) => Promise<McpBridgeCallResult>;
}

/** Короткий путь сокета: unix-sock лимит ~104 байт, длинный rootDir уводит его в tmpdir. */
export function bridgeSocketPath(rootDir: string, runId: string): string {
  const digest = createHash('sha256').update(runId).digest('hex').slice(0, 10);
  const direct = join(rootDir, 'mcp', `b-${digest}.sock`);
  if (direct.length <= 100) return direct;
  return join(tmpdir(), `mcp-${digest}.sock`);
}

export function newBridgeToken(): string {
  return randomBytes(24).toString('hex');
}

interface Connection {
  authenticated: boolean;
  buffer: string;
}

export class McpBridgeServer {
  private closed = false;

  private constructor(
    private readonly server: Server,
    private readonly options: McpBridgeListenOptions,
    private readonly handlers: McpBridgeHandlers,
    readonly socketPath: string,
    private readonly sockets: Set<Socket>,
  ) {}

  get url(): string {
    return `unix://${this.socketPath}`;
  }

  static async listen(options: McpBridgeListenOptions): Promise<McpBridgeServer> {
    const dir = options.socketPath.slice(0, options.socketPath.lastIndexOf('/')) || '/';
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // каталог мог создаться раньше с другими правами — сокет всё равно 0600 ниже
    }
    rmSync(options.socketPath, { force: true });

    const registry = options.registry;
    const handlers: McpBridgeHandlers = {
      toolsList: async () => {
        const sessionTools = await options.scope.toolView();
        const tools: McpBridgeTool[] = sessionTools.map((tool) => {
          const handler = registry?.get(tool.name);
          return {
            serverId: tool.serverId,
            name: tool.name,
            description: handler?.description ?? '',
            bindingRef: tool.bindingRef,
            bindingScope: tool.bindingScope,
            requiredScopes: handler?.requiredScopes ?? [],
            effect: handler?.effect ?? 'read',
            capabilityVersion: handler?.capabilityVersion ?? 0,
          };
        });
        return { tools };
      },
      callTool: async (request) => {
        const decision = options.scope.authorizeTool(request.serverId, request.tool);
        if (!decision.allowed) {
          options.log('warn', 'mcp.tool_denied', { serverId: request.serverId, tool: request.tool, reason: decision.reason, via: 'bridge' });
          return { ok: false, serverId: request.serverId, tool: request.tool, reason: decision.reason };
        }
        return options.callTool(request);
      },
      capabilityInvoke: async (request) => {
        return invokeCapability(options, request);
      },
    };

    const sockets = new Set<Socket>();
    const server = createServer((socket) => handleConnection(socket, options, handlers, sockets));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    chmodSync(options.socketPath, 0o600);
    return new McpBridgeServer(server, options, handlers, options.socketPath, sockets);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    rmSync(this.socketPath, { force: true });
  }
}

/**
 * capability/invoke — единственная точка, где дочерний процесс рана превращается в
 * доменное действие. Проверки хоста идут в этом порядке: инструмент в scope рана →
 * binding объявлен → scope binding'а покрывает requiredScopes → исполнение handler'а.
 */
async function invokeCapability(options: McpBridgeListenOptions, request: { serverId: string; capabilityId: string; arguments: Record<string, unknown> }): Promise<McpBridgeCapabilityResult> {
  const scoped = options.scope.server(request.serverId);
  if (!scoped) {
    options.log('warn', 'mcp.tool_denied', { serverId: request.serverId, tool: request.capabilityId, reason: 'unknown_server', via: 'capability_invoke' });
    return { ok: false, code: 'UNKNOWN_SERVER', message: `mcp server "${request.serverId}" is not part of this run` };
  }
  const decision = options.scope.authorizeTool(request.serverId, request.capabilityId);
  if (!decision.allowed) {
    options.log('warn', 'mcp.tool_denied', {
      serverId: request.serverId,
      tool: request.capabilityId,
      reason: decision.reason,
      via: 'capability_invoke',
    });
    return { ok: false, code: decision.reason.toUpperCase(), message: `tool "${request.capabilityId}" is not in the scoped bindings of this run` };
  }
  if (!options.registry) {
    return { ok: false, code: 'CAPABILITY_REGISTRY_EMPTY', message: 'this host has no capability registry; domain handlers are not registered' };
  }
  if (!scoped.binding) {
    options.log('warn', 'mcp.tool_denied', {
      serverId: request.serverId,
      tool: request.capabilityId,
      reason: 'binding_not_declared',
      via: 'capability_invoke',
    });
    return { ok: false, code: 'BINDING_REQUIRED', message: `mcp server "${request.serverId}" has no credential binding for this capability` };
  }

  const bindingValue = await options.bindingValue(request.serverId);
  if (bindingValue === undefined) {
    options.log('error', 'mcp.binding_unavailable', { serverId: request.serverId, bindingRef: scoped.binding.ref, via: 'capability_invoke' });
    return {
      ok: false,
      code: 'MCP_BINDING_VALUE_UNAVAILABLE',
      message: `credential binding "${scoped.binding.ref}" has no value on this host`,
      details: { bindingRef: scoped.binding.ref },
    };
  }

  options.log('info', 'mcp.capability_invoked', {
    serverId: request.serverId,
    capabilityId: request.capabilityId,
    bindingRef: scoped.binding.ref,
    bindingScope: scoped.binding.scope,
    runId: options.runId,
  });

  try {
    const outcome = await options.registry.invoke(
      {
        capabilityId: request.capabilityId,
        arguments: request.arguments ?? {},
        caller: options.caller,
        binding: scoped.binding,
      },
      bindingValue,
    );
    return { ok: true, outcome };
  } catch (err) {
    if (err instanceof CapabilityError) {
      options.log('warn', 'mcp.capability_denied', {
        serverId: request.serverId,
        capabilityId: request.capabilityId,
        code: err.code,
        bindingRef: scoped.binding.ref,
        bindingScope: scoped.binding.scope,
      });
      return { ok: false, code: err.code, message: err.message, details: err.details };
    }
    options.log('error', 'mcp.capability_failed', {
      serverId: request.serverId,
      capabilityId: request.capabilityId,
      detail: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: 'CAPABILITY_THREW', message: err instanceof Error ? err.message : String(err) };
  }
}

function handleConnection(socket: Socket, options: McpBridgeListenOptions, handlers: McpBridgeHandlers, sockets: Set<Socket>): void {
  const connection: Connection = { authenticated: false, buffer: '' };
  sockets.add(socket);
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    connection.buffer += chunk;
    let index = connection.buffer.indexOf('\n');
    while (index >= 0) {
      const line = connection.buffer.slice(0, index).replace(/\r$/, '');
      connection.buffer = connection.buffer.slice(index + 1);
      void handleLine(connection, line, options, handlers, socket);
      index = connection.buffer.indexOf('\n');
    }
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    sockets.delete(socket);
    options.log('info', 'mcp.bridge_disconnected', { runId: options.runId });
  });
}

async function handleLine(
  connection: Connection,
  line: string,
  options: McpBridgeListenOptions,
  handlers: McpBridgeHandlers,
  socket: Socket,
): Promise<void> {
  if (line.trim().length === 0) return;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    write(socket, { error: { code: 'BAD_REQUEST', message: 'bridge expects one JSON object per line' } });
    return;
  }

  const op = typeof message['op'] === 'string' ? message['op'] : '';
  const requestId = typeof message['requestId'] === 'string' ? message['requestId'] : '';

  if (op === 'hello') {
    const presented = typeof message['runToken'] === 'string' ? (message['runToken'] as string) : '';
    if (!tokensMatch(presented, options.runToken)) {
      options.log('warn', 'mcp.bridge_unauthenticated', { runId: options.runId, reason: 'run_token_mismatch' });
      write(socket, { requestId, error: { code: 'UNAUTHENTICATED', message: 'run token mismatch' } });
      socket.destroy();
      return;
    }
    connection.authenticated = true;
    write(socket, { requestId, ok: true, runId: options.runId, pid: process.pid });
    return;
  }

  if (!connection.authenticated) {
    write(socket, { requestId, error: { code: 'UNAUTHENTICATED', message: 'hello with the run token is required first' } });
    socket.destroy();
    return;
  }

  switch (op) {
    case 'ping':
      write(socket, { requestId, ok: true });
      return;
    case 'tools/list':
      write(socket, { requestId, ...(await handlers.toolsList()) });
      return;
    case 'tools/call': {
      const args = isRecord(message['arguments']) ? (message['arguments'] as Record<string, unknown>) : {};
      const result = await handlers.callTool({
        serverId: typeof message['serverId'] === 'string' ? message['serverId'] : '',
        tool: typeof message['tool'] === 'string' ? message['tool'] : '',
        arguments: args,
      });
      write(socket, { requestId, ...result });
      return;
    }
    case 'capability/invoke': {
      const args = isRecord(message['arguments']) ? (message['arguments'] as Record<string, unknown>) : {};
      const result = await handlers.capabilityInvoke({
        serverId: typeof message['serverId'] === 'string' ? message['serverId'] : '',
        capabilityId: typeof message['capabilityId'] === 'string' ? message['capabilityId'] : '',
        arguments: args,
      });
      write(socket, { requestId, ...result });
      return;
    }
    default:
      write(socket, { requestId, error: { code: 'UNKNOWN_OP', message: `unsupported bridge op "${op}"` } });
  }
}

function write(socket: Socket, payload: Record<string, unknown>): void {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(payload)}\n`);
}

function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
