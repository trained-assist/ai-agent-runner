import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isRetrievableLogUrl } from '../adapters/external-worker-adapter.js';
import { TERMINAL_EVENT_TYPES } from '../contracts/events.js';
import type { KeyRegistry, Principal, Scope } from './auth.js';
import { ApiError } from './errors.js';
import type { AgentApi, ApiLogger, RunCancelReceipt } from './service.js';

/**
 * HTTP-фасад stateless API (epic #74). Маршруты те же, что у приёмника, но за каждым из них
 * стоит только память и вызов внешнего воркера: ни одного дискового маршрута, ни одного
 * процесса. Байты артефактов и содержимое логов не отдаются — только ссылки.
 */

export interface AgentApiServerOptions {
  keys: KeyRegistry;
  logger?: ApiLogger;
  maxBodyBytes?: number;
  streamPollMs?: number;
  keepaliveMs?: number;
  /** Базовый URL API: используется в ссылках, которые отдаёт сервер. */
  baseUrl?: string;
}

const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_STREAM_POLL_MS = 25;
const DEFAULT_KEEPALIVE_MS = 10_000;

export function createAgentApiServer(service: AgentApi, options: AgentApiServerOptions): Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const streamPollMs = options.streamPollMs ?? DEFAULT_STREAM_POLL_MS;
  const keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  const logger: ApiLogger = options.logger ?? (() => undefined);

  const server = createServer((req, res) => {
    const startedAt = Date.now();
    void dispatch(req, res)
      .catch((err: unknown) => {
        const apiError = err instanceof ApiError ? err : new ApiError('INTERNAL', 'internal error');
        if (!(err instanceof ApiError)) {
          logger({ event: 'internal_error', message: err instanceof Error ? err.message : String(err) });
        }
        if (res.headersSent) res.end();
        else sendJson(res, apiError.status, apiError.body());
        return apiError.status;
      })
      .then((status) => {
        logger({
          event: 'request',
          method: req.method ?? 'GET',
          path: safePath(req.url),
          status,
          durationMs: Date.now() - startedAt,
        });
      });
  });

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<number> {
    const url = new URL(req.url ?? '/', 'http://agent-api.local');
    const path = url.pathname;

    if (path === '/healthz') {
      if (req.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', 'healthz supports GET only');
      sendJson(res, 200, service.health());
      return 200;
    }

    const principal = options.keys.authenticate(req.headers['authorization']);
    if (!principal) throw new ApiError('UNAUTHENTICATED', 'a valid Bearer API key is required');

    const segments = path.split('/').filter((segment) => segment.length > 0);

    if (segments[0] === 'v1' && segments[1] === 'capabilities' && segments.length === 2) {
      if (req.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', 'capabilities supports GET only');
      sendJson(res, 200, service.capabilities());
      return 200;
    }

    if (segments[0] !== 'v1' || segments[1] !== 'runs') {
      throw new ApiError('ROUTE_NOT_FOUND', `no route for ${path}`);
    }

    if (segments.length === 2) {
      if (req.method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 'the run collection supports POST only');
      requireScope(principal, 'runs:write');
      const body = await readJsonBody(req, maxBodyBytes);
      const response = service.submit(principal, req.headers['idempotency-key'], body);
      const status = response.deduplicated ? 200 : 202;
      sendJson(res, status, response);
      return status;
    }

    const runId = segments[2];
    const action = segments[3];
    if (!runId || !action || segments.length > 4) {
      throw new ApiError('ROUTE_NOT_FOUND', `no route for ${path}`);
    }

    switch (action) {
      case 'status': {
        if (req.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', 'status supports GET only');
        requireScope(principal, 'runs:read');
        sendJson(res, 200, service.status(principal, runId));
        return 200;
      }
      case 'result': {
        if (req.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', 'result supports GET only');
        requireScope(principal, 'runs:read');
        sendJson(res, 200, service.result(principal, runId));
        return 200;
      }
      case 'artifacts': {
        if (req.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', 'run artifacts support GET only');
        requireScope(principal, 'runs:read');
        sendJson(res, 200, service.artifacts(principal, runId));
        return 200;
      }
      case 'events': {
        if (req.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', 'events supports GET only');
        requireScope(principal, 'runs:read');
        if (isEventStreamRequest(req)) {
          streamEvents(req, res, principal, runId, url);
          return 200;
        }
        const cursor = intParam(url.searchParams.get('cursor'), 'cursor', 0);
        const limit = intParam(url.searchParams.get('limit'), 'limit', 500);
        sendJson(res, 200, service.events(principal, runId, cursor, limit));
        return 200;
      }
      case 'log': {
        if (req.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', 'log supports GET only');
        requireScope(principal, 'runs:read');
        const view = service.artifacts(principal, runId);
        if (!view.logUrl) throw new ApiError('RESULT_NOT_READY', 'the worker has not published a session log for this run yet');
        // Редиректим только на настоящий URL. Воркер может вернуть `local://…` (лог остался
        // на его машине, бакета ещё нет) — редирект на такую схему клиент не откроет, и врать
        // «перейдите по ссылке» хуже, чем честно отдать её в теле.
        if (!isRetrievableLogUrl(view.logUrl)) {
          sendJson(res, 200, { runId, logUrl: view.logUrl, retrievable: false, note: 'the log is not served over HTTP yet; the worker kept it locally' });
          return 200;
        }
        res.writeHead(302, { location: view.logUrl });
        res.end();
        return 302;
      }
      case 'cancel': {
        if (req.method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 'cancel supports POST only');
        requireScope(principal, 'runs:write');
        const body = await readJsonBody(req, maxBodyBytes);
        const receipt = await service.cancel(principal, runId, body);
        if (receipt.status === 'unknown_run') throw new ApiError('NOT_FOUND', `unknown run ${runId}`);
        if (receipt.status === 'rejected') {
          // Отказ отмены — это не «stale owner generation»: причина в ответе воркера.
          throw new ApiError('CANCEL_REJECTED', `cancel for ${runId} was rejected: ${receipt.reason ?? 'the worker refused the cancellation'}`, {
            runId,
            ...(receipt.state ? { state: receipt.state } : {}),
          });
        }
        const status = cancelHttpStatus(receipt.status);
        sendJson(res, status, receipt);
        return status;
      }
      default:
        throw new ApiError('ROUTE_NOT_FOUND', `no route for ${path}`);
    }
  }

  function streamEvents(req: IncomingMessage, res: ServerResponse, principal: Principal, runId: string, url: URL): void {
    const lastEventId = req.headers['last-event-id'];
    const rawCursor = typeof lastEventId === 'string' && lastEventId.trim() !== '' ? lastEventId : url.searchParams.get('cursor');
    const cursor = intParam(rawCursor, 'cursor', 0);
    const snapshot = service.status(principal, runId);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    writeFrame(res, 'snapshot', snapshot);

    if (snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
      // Ран уже терминальный, но клиент мог подключиться с Last-Event-ID вслепую: отдаём
      // недостающие события, иначе объявленный replay не работает после рестарта соединения.
      try {
        for (const event of service.events(principal, runId, cursor, 500).events) {
          res.write(`id: ${String(event.sequence)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch {
        // Владение или состояние изменились между проверкой и чтением — поток просто закрывается.
      }
      res.end();
      return;
    }

    let closed = false;
    let last = cursor;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(keepalive);
    };
    const tick = (): void => {
      if (closed) return;
      try {
        const page = service.events(principal, runId, last, 200);
        let sawTerminal = false;
        for (const event of page.events) {
          res.write(`id: ${String(event.sequence)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          last = event.sequence;
          if ((TERMINAL_EVENT_TYPES as readonly string[]).includes(event.type)) sawTerminal = true;
        }
        if (sawTerminal) {
          cleanup();
          res.end();
        }
      } catch {
        cleanup();
        res.end();
      }
    };
    const poll = setInterval(tick, streamPollMs);
    const keepalive = setInterval(() => {
      if (closed) return;
      try {
        res.write(': keepalive\n\n');
      } catch {
        cleanup();
      }
    }, keepaliveMs);
    poll.unref?.();
    keepalive.unref?.();
    req.on('close', () => {
      cleanup();
      res.end();
    });
    tick();
  }

  return server;
}

function writeFrame(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.includes(scope)) {
    throw new ApiError('SCOPE_DENIED', `principal "${principal.principalId}" is missing scope "${scope}"`, {
      scopes: [...principal.scopes],
    });
  }
}

function isEventStreamRequest(req: IncomingMessage): boolean {
  const accept = req.headers['accept'];
  return typeof accept === 'string' && accept.includes('text/event-stream');
}

function intParam(raw: string | null, name: string, fallback: number): number {
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ApiError('INVALID_REQUEST', `${name}: expected integer, got "${raw.slice(0, 50)}"`);
  return value;
}

function cancelHttpStatus(status: RunCancelReceipt['status']): number {
  switch (status) {
    case 'stop_pending':
      return 202;
    case 'too_late':
    case 'rejected':
      return 409;
    default:
      return 200;
  }
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBodyBytes) {
      exceeded = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (exceeded) throw new ApiError('PAYLOAD_TOO_LARGE', `request body exceeds ${maxBodyBytes} bytes`);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('INVALID_REQUEST', 'request body must be valid JSON');
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function safePath(url: string | undefined): string {
  if (!url) return '/';
  const index = url.indexOf('?');
  return index >= 0 ? url.slice(0, index) : url;
}
