import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type LaunchResult, ExternalWorkerAdapter } from '../src/adapters/external-worker-adapter.js';

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
  repo?: { fullName: string; commit: string; baseRef?: string };
  logUrl?: string | null;
  /** Задержка ответа, чтобы успеть проверить статус `running`. */
  delayMs?: number;
  /** Ответить HTTP-ошибкой вместо LaunchResult. */
  httpStatus?: number;
  /** Задержать регистрацию рана: отмена приходит раньше, чем воркер его «увидел». */
  registerAfterMs?: number;
  /** Отдать тело, не проходящее контракт. */
  malformed?: boolean;
  /** Отдать тело результата, не проходящее контракт. */
  malformedResult?: boolean;
  /** Терминальный статус рана у воркера (асинхронный контракт, #73). `unknown` — исход не установлен. */
  terminalStatus?: 'succeeded' | 'failed' | 'cancelled' | 'running' | 'unknown';
  /** Задержка доставки результата через callback (мс). */
  resultDelayMs?: number;
  /** Не доставлять результат самому: тест забирает его опросом. */
  autoDeliver?: boolean;
  /** Промежуточный статус, который воркер отдаёт до терминального. */
  runningStatus?: 'running';
  /** Ответить HTTP-ошибкой на запрос статуса: воркер недоступен для reconcile (#73, п. 4). */
  statusHttpStatus?: number;
  /** Задержать ответ на статус: воркер жив, но отвечает дольше бюджета reconcile. */
  statusDelayMs?: number;
}

export interface MockWorker {
  readonly baseUrl: string;
  readonly launches: Array<Record<string, unknown>>;
  readonly cancels: string[];
  /** Доставленные через callback результаты. */
  readonly results: Array<Record<string, unknown>>;
  /** Автоматически доставлять результат через resultUrl (по умолчанию да). */
  autoDeliver: boolean;
  /** Приёмник результата вместо HTTP-callback (для локальных тестов). */
  resultSink: ((runId: string, payload: unknown, bearer: string | undefined) => unknown) | null;
  /** Заголовок Authorization последнего launch-запроса. */
  lastAuthorization(): string | undefined;
  /** Дослать результат рана (тесты вручную, минуя autoDeliver). */
  deliverResult(runId: string, over?: Partial<LaunchResult>, token?: string): Promise<Response>;
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
  const results: Array<Record<string, unknown>> = [];
  const live = new Set<{ runId: string; cancelled: boolean; pending: boolean }>();
  let lastAuthorization: string | undefined;

  const defaults = {
    exitReason: 'completed' as const,
    terminalStatus: 'succeeded' as const,
    exitCode: 0,
    answer: 'Готово, отчёт в report.md',
    answerSource: 'engine_stdout' as const,
    stdout: 'opencode run finished',
    stderr: '',
    artifacts: [{ path: 'report.md', name: 'report.md', mime: 'text/markdown', sha256: sha256Hex('report.md'), size: 1234 }],
    repo: { fullName: 'owner/name', commit: 'abc1234', baseRef: 'main' },
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
        // HTTP-ошибка = запуск НЕ принят: ран не регистрируем. Иначе «воркер отказал» было
        // бы неотличимо от «воркер принял, но ответ потерялся», и reconcile (#73 §4) не
        // проверить: он бы всегда находил ран у отказавшего воркера.
        if (settings.httpStatus !== undefined) {
          res.writeHead(settings.httpStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'worker is unhappy' }));
          return;
        }
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
        if (settings.delayMs) await new Promise((resolve) => setTimeout(resolve, settings.delayMs));
        // Асинхронный контракт: воркер принял ран и ушёл работать. Квитанция несёт адреса,
        // по которым наш API будет спрашивать статус и забирать результат.
        const operationId = String(body['operationId'] ?? `op-${runId}`);
        // Адреса возврата — наши собственные эндпоинты, ровно те, что запрашивает адаптер.
        const statusUrl = `http://127.0.0.1:${port}/v1/runs/${runId}/status`;
        const resultUrl = `http://127.0.0.1:${port}/v1/runs/${runId}/result`;
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            settings.malformed
              ? { runId }
              : { runId, operationId, status: 'accepted', statusUrl, resultUrl },
          ),
        );
        // Автодоставка повторяет обычное поведение воркера: принял ран → отработал → отдал
        // результат. Тест, который этого не хочет, выключает её через `autoDeliver`.
        if (worker.autoDeliver) {
          const delay = settings.resultDelayMs ?? 20;
          setTimeout(() => {
            worker.deliverResult(runId).catch((err) => console.log('DELIVER FAILED', err instanceof Error ? err.message : String(err)));
          }, delay);
        }
        return;
      }

      // Статус рана: наш API опрашивает его, пока ран не станет терминальным.
      const statusMatch = /^\/v1\/runs\/([^/]+)\/status$/.exec(url.pathname);
      if (statusMatch) {
        if (settings.statusHttpStatus !== undefined) {
          res.writeHead(settings.statusHttpStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'worker is unreachable' }));
          return;
        }
        const runId = statusMatch[1]!;
        if (settings.statusDelayMs) await new Promise((resolve) => setTimeout(resolve, settings.statusDelayMs));
        const record = [...live].find((entry) => entry.runId === runId);
        if (!record || record.pending) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ runId, status: 'unknown', updatedAt: new Date().toISOString() }));
          return;
        }
        const status = record.cancelled ? 'cancelled' : settings.terminalStatus;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runId, status, updatedAt: new Date().toISOString() }));
        return;
      }

// Результат рана: отдаём только когда ран терминальный, иначе 409. Отменённый ран —
        // исключение: он закончен отменой, и результат обязан вернуться, даже если настроенный
        // терминальный статус воркера — `running` (иначе отмена не закрыла бы ран).
        const resultMatch = /^\/v1\/runs\/([^/]+)\/result$/.exec(url.pathname);
        if (resultMatch) {
          const runId = resultMatch[1]!;
          const record = [...live].find((entry) => entry.runId === runId);
          if (!record || record.pending || (!TERMINAL.has(settings.terminalStatus) && !record.cancelled)) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ runId, status: 'not_ready' }));
          return;
        }
        const exitReason = record.cancelled ? 'cancelled' : settings.exitReason;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(buildResult(runId, exitReason, settings)));
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
    results,
    autoDeliver: true,
    resultSink: null,
    options,
    lastAuthorization: () => lastAuthorization,
    async deliverResult(runId: string, over: Partial<LaunchResult> = {}, token?: string): Promise<Response> {
      const launch = launches.find((entry) => entry['runId'] === runId);
      const resultUrl = launch ? requestedResultUrl(launch) : '';
      if (!resultUrl) throw new Error(`run ${runId} was never launched; no resultUrl to post to`);
      const cancelled = [...live].some((entry) => entry.runId === runId && entry.cancelled);
      const exitReason = cancelled ? 'cancelled' : settings.exitReason;
      const payload = {
        runId,
        status: 'started',
        pid: 4242,
        exitCode: exitReason === 'cancelled' ? null : (settings['exitCode'] as number | undefined) ?? 0,
        exitSignal: exitReason === 'crash' ? 'SIGKILL' : null,
        exitReason,
        stdout: (settings['stdout'] as string | undefined) ?? '',
        stderr: (settings['stderr'] as string | undefined) ?? '',
        answer: settings['answer'] as string | undefined ?? null,
        answerSource: (settings['answerSource'] as string | undefined) ?? null,
        durationMs: 1234,
        timedOut: exitReason === 'timeout',
        outputTruncated: false,
        artifacts: (settings['artifacts'] as unknown[] | undefined) ?? [],
        logUrl: settings['logUrl'] === null ? undefined : String(settings['logUrl']).replace('PLACEHOLDER', runId),
        repo: { fullName: 'owner/name', branch: `agent-run/${runId}`, commit: 'abc1234', baseRef: 'main' },
        ...over,
      } as unknown as LaunchResult;
      if (settings.malformedResult) delete (payload as Partial<LaunchResult>).artifacts;
      results.push(payload as unknown as Record<string, unknown>);
      // Воркер предъявляет тот же общий секрет, которым мы аутентифицировали его на launch.
      const bearer = token ?? lastAuthorization?.replace(/^Bearer\s+/i, '');
      if (worker.resultSink) {
        return { status: 202, ok: true, body: await worker.resultSink(runId, payload, bearer) } as unknown as Response;
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (bearer !== undefined) headers['authorization'] = `Bearer ${bearer}`;
      return fetch(resultUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return worker;
}

/** Статусы, при которых воркер отдаёт результат, а не 409. */
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/** Тело результата рана по настройкам мока. */
function buildResult(runId: string, exitReason: string, settings: MockWorkerOptions & Record<string, unknown>): Record<string, unknown> {
  return {
    runId,
    status: 'started',
    pid: 4242,
    exitCode: exitReason === 'cancelled' ? null : (settings['exitCode'] as number | undefined) ?? 0,
    exitSignal: exitReason === 'crash' ? 'SIGKILL' : null,
    exitReason,
    stdout: (settings['stdout'] as string | undefined) ?? '',
    stderr: (settings['stderr'] as string | undefined) ?? '',
    answer: settings['answer'] as string | undefined ?? null,
    answerSource: (settings['answerSource'] as string | undefined) ?? null,
    durationMs: 1234,
    timedOut: exitReason === 'timeout',
    outputTruncated: false,
    artifacts: (settings['artifacts'] as unknown[] | undefined) ?? [],
    logUrl: settings['logUrl'] === null ? undefined : String(settings['logUrl']).replace('PLACEHOLDER', runId),
    repo: { fullName: 'owner/name', branch: `agent-run/${runId}`, commit: 'abc1234', baseRef: 'main' },
  };
}

/** Адрес возврата результата, который наш API передал воркеру в запросе запуска. */
function requestedResultUrl(body: Record<string, unknown>): string {
  const url = body['resultUrl'];
  return typeof url === 'string' ? url : '';
}

function requestedBranch(body: Record<string, unknown>): string {
  const repository = body['repository'];
  if (typeof repository !== 'object' || repository === null) return '';
  const branch = (repository as Record<string, unknown>)['branch'];
  return typeof branch === 'string' ? branch : '';
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

export function adapterFor(
  worker: MockWorker,
  options: { token?: string; env?: Record<string, string>; deadlineMs?: number; acceptDeadlineMs?: number; engineName?: string; noResultBase?: boolean } = {},
): ExternalWorkerAdapter {
  return new ExternalWorkerAdapter({
    baseUrl: worker.baseUrl,
    ...(options.token ? { token: options.token } : {}),
    ...(options.engineName ? { engineName: options.engineName } : {}),
    ...(options.env ? { env: options.env } : {}),
    deadlineMs: options.deadlineMs ?? 5000,
    // Бюджет приёма рана — свой у каждого движка (issue #100); без него он равен deadlineMs.
    ...(options.acceptDeadlineMs !== undefined ? { acceptDeadlineMs: options.acceptDeadlineMs } : {}),
    cancelDeadlineMs: 2000,
    // Тесты без HTTP-сервера всё равно получают осмысленный LaunchRequest.resultUrl.
    ...(options.noResultBase ? {} : { baseUrlForResult: 'https://api.test' }),
  });
}
