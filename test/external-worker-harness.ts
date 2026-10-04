import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ExternalWorkerAdapter } from '../src/adapters/external-worker-adapter.js';

/**
 * Мок внешнего воркера (epic #74, шаг 8). Поднимает настоящий HTTP-сервер и отвечает по
 * контракту issue #73, чтобы адаптер ходил по сети, а не в подменённый `fetch`.
 */

export interface MockWorkerOptions {
  exitReason?: 'completed' | 'nonzero_exit' | 'timeout' | 'crash' | 'cancelled' | 'startup_failure';
  exitCode?: number | null;
  answer?: string | null;
  answerSource?: 'engine_stdout' | 'agent_file' | null;
  stdout?: string;
  stderr?: string;
  artifacts?: Array<{ path: string; name: string; mime: string; sha256: string; size: number }>;
  repo?: { fullName: string; commit: string };
  logUrl?: string | null;
  /** Задержка ответа, чтобы успеть проверить статус `running`. */
  delayMs?: number;
  /** Ответить HTTP-ошибкой вместо LaunchResult. */
  httpStatus?: number;
  /** Задержать регистрацию рана: отмена приходит раньше, чем воркер его «увидел». */
  registerAfterMs?: number;
  /** Отдать тело, не проходящее контракт. */
  malformed?: boolean;
}

export interface MockWorker {
  readonly baseUrl: string;
  readonly launches: Array<Record<string, unknown>>;
  readonly cancels: string[];
  /** Заголовок Authorization последнего launch-запроса. */
  lastAuthorization(): string | undefined;
  options: MockWorkerOptions;
  close(): Promise<void>;
}

function sha256Hex(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(64, '0');
}

export async function startMockWorker(options: MockWorkerOptions = {}): Promise<MockWorker> {
  const launches: Array<Record<string, unknown>> = [];
  const cancels: string[] = [];
  const live = new Set<{ runId: string; cancelled: boolean; pending: boolean }>();
  let lastAuthorization: string | undefined;

  const defaults = {
    exitReason: 'completed' as const,
    exitCode: 0,
    answer: 'Готово, отчёт в report.md',
    answerSource: 'engine_stdout' as const,
    stdout: 'opencode run finished',
    stderr: '',
    artifacts: [{ path: 'report.md', name: 'report.md', mime: 'text/markdown', sha256: sha256Hex('report.md'), size: 1234 }],
    repo: { fullName: 'owner/name', commit: 'abc1234' },
    logUrl: 'https://storage.googleapis.com/agent-logs/runs/PLACEHOLDER/session.log',
  };
  const settings = { ...defaults, ...options };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://worker.local');
      const auth = req.headers.authorization;
      if (typeof auth === 'string') lastAuthorization = auth;
      if (url.pathname === '/v1/launch') {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        launches.push(body);
        const runId = String(body['runId'] ?? '');
        // Регистрируем ран сразу, до задержки: отмена может прийти, пока launch ещё «думает».
        let record = [...live].find((entry) => entry.runId === runId);
        if (!record) {
          record = { runId, cancelled: false, pending: true };
          live.add(record);
          const register = (): void => {
            record!.pending = false;
          };
          if (settings.registerAfterMs && settings.registerAfterMs > 0) setTimeout(register, settings.registerAfterMs);
          else register();
        }
        if (settings.httpStatus !== undefined) {
          res.writeHead(settings.httpStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'worker is unhappy' }));
          return;
        }
        if (settings.delayMs) await new Promise((resolve) => setTimeout(resolve, settings.delayMs));
        const exitReason = record.cancelled === true ? 'cancelled' : settings.exitReason;
        const payload = settings.malformed
          ? { runId, status: 'started' }
          : {
              runId,
              status: 'started',
              pid: 4242,
              exitCode: exitReason === 'cancelled' ? null : settings.exitCode,
              exitSignal: exitReason === 'crash' ? 'SIGKILL' : null,
              exitReason,
              stdout: settings.stdout,
              stderr: settings.stderr,
              answer: settings.answer,
              answerSource: settings.answerSource,
              durationMs: 1234,
              timedOut: exitReason === 'timeout',
              outputTruncated: false,
              artifacts: settings.artifacts,
              logUrl: settings.logUrl === null ? undefined : String(settings.logUrl).replace('PLACEHOLDER', runId),
              repo: settings.repo,
            };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
      const cancelMatch = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (cancelMatch) {
        const runId = cancelMatch[1]!;
        cancels.push(runId);
        const record = [...live].find((entry) => entry.runId === runId);
        if (!record || record.pending) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'unknown_run' }));
          return;
        }
        record.cancelled = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'cancelled' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_found' }));
    })();
  };

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const worker: MockWorker = {
    baseUrl,
    launches,
    cancels,
    options,
    lastAuthorization: () => lastAuthorization,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return worker;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

export function adapterFor(
  worker: MockWorker,
  options: { token?: string; env?: Record<string, string>; deadlineMs?: number } = {},
): ExternalWorkerAdapter {
  return new ExternalWorkerAdapter({
    baseUrl: worker.baseUrl,
    ...(options.token ? { token: options.token } : {}),
    ...(options.env ? { env: options.env } : {}),
    deadlineMs: options.deadlineMs ?? 5000,
    cancelDeadlineMs: 2000,
  });
}
