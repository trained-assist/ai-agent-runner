import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { TERMINAL_EVENT_TYPES } from '../contracts/events.js';
import { CapabilityError, type CapabilityRegistry } from '../mcp/capabilities.js';
import type { BindingValueResolver } from '../mcp/scope.js';
import type { CancelReceipt } from '../runner/runner.js';
import type { ArtifactStore } from '../storage/artifact-store.js';
import type { RunExportStore } from '../storage/export.js';
import type { ShareTokenIssuer } from '../storage/share.js';
import type { UploadSessionStore } from '../storage/upload-session.js';
import type { WorkspaceSnapshotStore } from '../storage/workspace-snapshot.js';
import type { KeyRegistry, Principal, Scope } from './auth.js';
import { ApiError } from './errors.js';
import { newApiId } from './contracts.js';
import { handleExportAction, type ExportRouteDeps } from './export-route.js';
import { handleUploadAction, handleUploadSessionAction, type UploadRouteDeps } from './upload-route.js';
import { handleSnapshotAction, handleSnapshotFileAction, type SnapshotRouteDeps } from './snapshot-route.js';
import type { AgentApi, ApiLogger } from './service.js';

export interface AgentApiServerOptions {
  keys: KeyRegistry;
  logger?: ApiLogger;
  maxBodyBytes?: number;
  streamPollMs?: number;
  keepaliveMs?: number;
  /** Artifact store для `GET /v1/runs/{id}/artifacts` (ссылки на артефакты рана для приёмника). */
  artifacts?: ArtifactStore;
  /** Манифест экспорта для `GET|POST /v1/runs/{id}/export` (P07). */
  exports?: RunExportStore;
  /** Короткоживущие share-ссылки в представлении экспорта. */
  tokens?: ShareTokenIssuer;
  baseUrl?: string;
  /** Сессии прямой загрузки артефактов для `POST|GET /v1/runs/{id}/artifacts/upload` (P08). */
  uploads?: UploadSessionStore;
  /** Снимки workspace для P09 — версионирование файлов и обнаружение конфликтов. */
  snapshots?: WorkspaceSnapshotStore;
  /**
   * Реестр capability handler'ов (P13). Тот же реестр обслуживает вызовы MCP ран'а:
   * `POST /v1/capabilities/invoke` — второй транспортный фасад над тем же handler'ом.
   */
  capabilities?: CapabilityRegistry;
  /** Резолвер значений credential binding'ов для capability-вызовов control plane. */
  bindingResolver?: BindingValueResolver;
}

interface RequestContext {
  principalId?: string;
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
    const context: RequestContext = {};
    const startedAt = Date.now();
    void dispatch(req, res, context)
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
          ...(context.principalId ? { principalId: context.principalId } : {}),
        });
      });
  });

  async function dispatch(req: IncomingMessage, res: ServerResponse, context: RequestContext): Promise<number> {
    const url = new URL(req.url ?? '/', 'http://agent-api.local');
    const path = url.pathname;

    if (path === '/healthz') {
      if (req.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', 'healthz supports GET only');
      sendJson(res, 200, { status: 'ok', ...service.runner.health() });
      return 200;
    }

    const principal = options.keys.authenticate(req.headers['authorization']);
    if (!principal) throw new ApiError('UNAUTHENTICATED', 'a valid Bearer API key is required');
    context.principalId = principal.principalId;

    const segments = path.split('/').filter((segment) => segment.length > 0);

    if (segments[0] === 'v1' && segments[1] === 'capabilities' && segments.length === 2) {
      if (req.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', 'capabilities supports GET only');
      sendJson(res, 200, service.capabilities());
      return 200;
    }

    // Закреплённый релиз/конфиг, когорта, откат и retention-здоровье (P29). Приёмник читает
    // это вместо догадок о том, какой релиз обслуживает задачи и что будет при откате.
    if (segments[0] === 'v1' && segments[1] === 'release' && segments.length === 2) {
      if (req.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', 'release supports GET only');
      requireScope(principal, 'runs:read');
      const view = service.release();
      if (!view) throw new ApiError('ROUTE_NOT_FOUND', 'release manifest is not enabled in this deployment');
      sendJson(res, 200, view);
      return 200;
    }

    // Второй транспортный фасад над теми же capability handler'ами, что и MCP-вызовы рана (P13):
    // «Один domain handler имеет contract и разные transport facades».
    if (segments[0] === 'v1' && segments[1] === 'capabilities' && segments[2] === 'invoke' && segments.length === 3) {
      if (req.method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 'capability invoke supports POST only');
      const registry = options.capabilities;
      if (!registry) throw new ApiError('ROUTE_NOT_FOUND', 'capability handlers are not enabled in this deployment');
      requireScope(principal, 'runs:write');
      const body = await readJsonBody(req, maxBodyBytes);
      const outcome = await invokeCapabilityOverApi(registry, principal, body, options.bindingResolver);
      logger({
        event: 'capability_invoked',
        principalId: principal.principalId,
        profileId: principal.profileId,
        userTaskId: outcome.userTaskId,
        capabilityId: outcome.capabilityId,
        kind: outcome.kind,
        effectReceiptId: outcome.effectReceiptId,
        bindingRef: outcome.bindingRef,
      });
      sendJson(res, outcome.status, outcome.body);
      return outcome.status;
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

    if (action === 'export') {
      const store = options.exports;
      if (!store) throw new ApiError('ROUTE_NOT_FOUND', 'artifact export is not enabled in this deployment');
      if (req.method !== 'GET' && req.method !== 'POST') {
        throw new ApiError('METHOD_NOT_ALLOWED', 'run export supports GET and POST only');
      }
      requireScope(principal, 'runs:read');
      // владение ран проверяется до чтения манифеста экспорта
      service.status(principal, runId);
      const body = req.method === 'POST' ? await readJsonBody(req, maxBodyBytes) : {};
      const deps: ExportRouteDeps = { service, exports: store, keys: options.keys };
      if (options.tokens) deps.tokens = options.tokens;
      if (options.baseUrl !== undefined) deps.baseUrl = options.baseUrl;
      const { status, view } = await handleExportAction(deps, principal, runId, req.method, body);
      logger({
        event: 'run_export',
        method: req.method,
        runId,
        userTaskId: view.userTaskId,
        profileId: view.profileId,
        exportVersion: view.version,
        exportStatus: view.status,
        exportPartial: view.partial,
        cleanup: view.cleanup.decision,
        retained: view.cleanup.retained.length,
        reason: view.status === 'complete' ? 'export_committed' : 'export_incomplete',
      });
      sendJson(res, status, view);
      return status;
    }

    if (action === 'upload') {
      const store = options.uploads;
      if (!store) throw new ApiError('ROUTE_NOT_FOUND', 'artifact upload is not enabled in this deployment');
      if (req.method !== 'GET' && req.method !== 'POST') {
        throw new ApiError('METHOD_NOT_ALLOWED', 'upload session supports GET and POST only');
      }
      requireScope(principal, 'runs:write');
      const deps: UploadRouteDeps = { service, uploads: store, artifacts: options.artifacts!, keys: options.keys };
      const body = req.method === 'POST' ? await readJsonBody(req, maxBodyBytes) : {};
      const { status, view } = await handleUploadAction(deps, principal, runId, req.method, body);
      logger({
        event: 'upload_session',
        method: req.method,
        runId,
        userTaskId: runId,
        profileId: principal.profileId,
        reason: req.method === 'POST' ? 'session_created' : 'session_listed',
      });
      sendJson(res, status, view);
      return status;
    }

    if (action === 'upload-session') {
      const store = options.uploads;
      if (!store) throw new ApiError('ROUTE_NOT_FOUND', 'artifact upload is not enabled in this deployment');
      if (req.method !== 'GET' && req.method !== 'POST') {
        throw new ApiError('METHOD_NOT_ALLOWED', 'upload session supports GET and POST only');
      }
      requireScope(principal, 'runs:write');
      const sessionId = segments[4];
      if (!sessionId) throw new ApiError('ROUTE_NOT_FOUND', `no route for ${path}`);
      const deps: UploadRouteDeps = { service, uploads: store, artifacts: options.artifacts!, keys: options.keys };
      const body = req.method === 'POST' ? await readJsonBody(req, maxBodyBytes) : {};
      const { status, view } = await handleUploadSessionAction(deps, principal, runId, sessionId, req.method, body);
      logger({
        event: 'upload_session_action',
        method: req.method,
        runId,
        sessionId,
        userTaskId: sessionId,
        profileId: principal.profileId,
      });
      sendJson(res, status, view);
      return status;
    }

    if (action === 'snapshot') {
      const store = options.snapshots;
      if (!store) throw new ApiError('ROUTE_NOT_FOUND', 'workspace snapshots are not enabled in this deployment');
      if (req.method !== 'GET' && req.method !== 'POST') {
        throw new ApiError('METHOD_NOT_ALLOWED', 'snapshot actions support GET and POST only');
      }
      requireScope(principal, 'runs:write');
      const deps: SnapshotRouteDeps = { service, snapshots: store, artifacts: options.artifacts!, keys: options.keys };
      const body = req.method === 'POST' ? await readJsonBody(req, maxBodyBytes) : {};
      const { status, view } = await handleSnapshotAction(deps, principal, runId, req.method, body);
      logger({
        event: 'snapshot_action',
        method: req.method,
        runId,
        userTaskId: principal.profileId,
        profileId: principal.profileId,
      });
      sendJson(res, status, view);
      return status;
    }

    if (action === 'snapshot-file') {
      const store = options.snapshots;
      if (!store) throw new ApiError('ROUTE_NOT_FOUND', 'workspace snapshots are not enabled in this deployment');
      if (req.method !== 'POST') {
        throw new ApiError('METHOD_NOT_ALLOWED', 'snapshot file actions support POST only');
      }
      requireScope(principal, 'runs:write');
      const snapshotId = segments[4];
      if (!snapshotId) throw new ApiError('ROUTE_NOT_FOUND', `no route for ${path}`);
      const deps: SnapshotRouteDeps = { service, snapshots: store, artifacts: options.artifacts!, keys: options.keys };
      const body = await readJsonBody(req, maxBodyBytes);
      const { status, view } = await handleSnapshotFileAction(deps, principal, runId, snapshotId, req.method, body);
      logger({
        event: 'snapshot_file_action',
        method: req.method,
        runId,
        snapshotId,
        userTaskId: principal.profileId,
        profileId: principal.profileId,
      });
      sendJson(res, status, view);
      return status;
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
        const store = options.artifacts;
        if (!store) throw new ApiError('ROUTE_NOT_FOUND', 'artifact listing is not enabled in this deployment');
        // status() отдаёт 404 для чужого/неизвестного рана — владение проверено до чтения store
        const status = service.status(principal, runId);
        const manifests = store
          .list(runId)
          .filter((manifest) => manifest.profileId === principal.profileId)
          .map((manifest) => ({
            artifactId: manifest.artifactId,
            name: manifest.name,
            mime: manifest.mime,
            size: manifest.size,
            sha256: manifest.sha256,
            storageKey: manifest.storageKey,
            createdAt: manifest.createdAt,
            runId: manifest.runId,
            userTaskId: manifest.userTaskId,
            profileId: manifest.profileId,
          }));
        const exportManifest = options.exports?.read(runId);
        sendJson(res, 200, {
          runId,
          conversationId: status.conversationId,
          userTaskId: status.userTaskId,
          count: manifests.length,
          artifacts: manifests,
          export: exportManifest
            ? {
                version: exportManifest.version,
                attempts: exportManifest.attempts,
                status: exportManifest.status,
                partial: exportManifest.partial,
                planned: exportManifest.totals.planned,
                exported: exportManifest.totals.exported,
                failed: exportManifest.totals.failed,
                cleanup: exportManifest.cleanup.decision,
                retained: exportManifest.cleanup.retained,
              }
            : null,
        });
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
      case 'cancel': {
        if (req.method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 'cancel supports POST only');
        requireScope(principal, 'runs:write');
        const body = await readJsonBody(req, maxBodyBytes);
        const receipt = await service.cancel(principal, runId, body);
        if (receipt.status === 'unknown_run') throw new ApiError('NOT_FOUND', `unknown run ${runId}`);
        if (receipt.status === 'rejected') {
          throw new ApiError('STALE_OWNER_GENERATION', `cancel for ${runId} was rejected: ${receipt.reason ?? 'stale_owner_generation'}`, {
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

    if (isTerminalApiState(snapshot.state)) {
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

function isTerminalApiState(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
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

function cancelHttpStatus(status: CancelReceipt['status']): number {
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

interface CapabilityInvokeView {
  status: number;
  body: Record<string, unknown>;
  kind: string;
  capabilityId: string;
  userTaskId: string;
  effectReceiptId: string | null;
  bindingRef: string | null;
}

/**
 * Вызов capability через API control plane. Проверки хоста те же, что и на MCP-пути
 * (TASK-ROUTER-AND-MCP §11.2 шаг 4): capability существует, аргументы на месте, binding
 * объявлен и его scope покрывает requiredScopes handler'а. Значение binding'а приходит
 * от host-owned резолвера и наружу (в ответ/логи) не выходит.
 */
async function invokeCapabilityOverApi(
  registry: CapabilityRegistry,
  principal: Principal,
  body: unknown,
  bindingResolver?: BindingValueResolver,
): Promise<CapabilityInvokeView> {
  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const capabilityId = typeof record['capabilityId'] === 'string' ? record['capabilityId'] : '';
  const capabilityVersion = typeof record['capabilityVersion'] === 'number' ? record['capabilityVersion'] : undefined;
  const args = typeof record['arguments'] === 'object' && record['arguments'] !== null && !Array.isArray(record['arguments'])
    ? (record['arguments'] as Record<string, unknown>)
    : {};
  const bindingRef = typeof record['bindingRef'] === 'string' ? record['bindingRef'] : '';
  const userTaskId = typeof record['userTaskId'] === 'string' ? record['userTaskId'] : `capability-${newApiId('task').slice(5)}`;
  const operationId = typeof record['operationId'] === 'string' ? record['operationId'] : newApiId('op');

  if (capabilityId.length === 0) {
    throw new ApiError('INVALID_REQUEST', 'capabilityId is required');
  }

  let handler;
  try {
    handler = registry.get(capabilityId, capabilityVersion);
  } catch (err) {
    if (err instanceof CapabilityError) {
      const code = err.code === 'CAPABILITY_NOT_FOUND' ? 'CAPABILITY_NOT_FOUND' : 'INVALID_REQUEST';
      throw new ApiError(code, err.message, err.details);
    }
    throw err;
  }

  const view = (kind: string, status: number, payload: Record<string, unknown>, receiptId: string | null): CapabilityInvokeView => ({
    status,
    kind,
    capabilityId,
    userTaskId,
    effectReceiptId: receiptId,
    bindingRef: bindingRef || null,
    body: payload,
  });

  const bindingScope = typeof record['bindingScope'] === 'string' ? record['bindingScope'] : '';
  if (handler.requiredScopes.length > 0 && bindingScope.length === 0) {
    throw new ApiError('CAPABILITY_BLOCKED', `capability "${capabilityId}" requires a credential binding with scope ${handler.requiredScopes.join('|')}`, {
      capabilityId,
      requiredScopes: [...handler.requiredScopes],
    });
  }

  const bindingValue = bindingRef.length > 0 && bindingResolver ? ((await bindingResolver(bindingRef)) ?? undefined) : undefined;
  if (bindingRef.length > 0 && handler.requiredScopes.length > 0 && !bindingValue) {
    throw new ApiError('CAPABILITY_BLOCKED', `credential binding "${bindingRef}" has no value on this host`, { bindingRef });
  }

  let outcome;
  try {
    outcome = await registry.invoke(
      {
        capabilityId,
        arguments: args,
        caller: {
          principalId: principal.principalId,
          profileId: principal.profileId,
          userTaskId,
          runId: null,
          operationId,
        },
        ...(bindingRef.length > 0 ? { binding: { ref: bindingRef, scope: bindingScope } } : {}),
      },
      bindingValue,
    );
  } catch (err) {
    // Отказ хоста на MCP-пути и на этом пути должен читаться одинаково.
    if (err instanceof CapabilityError) {
      if (err.code === 'BINDING_SCOPE_MISSING') throw new ApiError('SCOPE_DENIED', err.message, err.details);
      if (err.code === 'BINDING_REQUIRED') throw new ApiError('CAPABILITY_BLOCKED', err.message, err.details);
      throw new ApiError('CAPABILITY_NOT_FOUND', err.message, err.details);
    }
    throw err;
  }

  switch (outcome.kind) {
    case 'completed':
      return view(
        'completed',
        200,
        {
          capabilityId,
          capabilityVersion: handler.capabilityVersion,
          userTaskId,
          outcome: outcome.kind,
          result: outcome.result,
          ...(outcome.effectReceipt ? { effectReceipt: outcome.effectReceipt } : {}),
        },
        outcome.effectReceipt?.receiptId ?? null,
      );
    case 'missing_input':
      return view('missing_input', 400, { capabilityId, userTaskId, outcome: outcome.kind, fields: outcome.fields }, null);
    case 'blocked':
      return view('blocked', 403, { capabilityId, userTaskId, outcome: outcome.kind, reason: outcome.reason }, null);
    case 'needs_agent':
      return view('needs_agent', 409, { capabilityId, userTaskId, outcome: outcome.kind, reason: outcome.reason }, null);
    case 'technical_error':
    default:
      return view('technical_error', 502, { capabilityId, userTaskId, outcome: 'technical_error', code: outcome.code }, null);
  }
}

function safePath(url: string | undefined): string {
  if (!url) return '/';
  const index = url.indexOf('?');
  return index >= 0 ? url.slice(0, index) : url;
}
