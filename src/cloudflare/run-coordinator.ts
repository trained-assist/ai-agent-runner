import type { ApiPrincipal, DurableObjectStateLike, RunnerWorkerEnv } from './types.js';
import { DEFAULT_ENGINE, SAFE_ID, error, json } from './runner-api.js';
import { deliverTerminalWebhook, resolveWebhook, type WebhookConnection, type WebhookDelivery } from './webhooks.js';
import { redactSecrets } from '../redact.js';

const AGENT_HISTORY_PATH = '__runner/agent-history.json';

type State = 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
interface RunRecord {
  requestId: string; runId: string; userTaskId: string; conversationId: string; jobId: string;
  ownerGeneration: number;
  principalId: string; profileId: string; tenantId?: string; idempotencyKey: string; payloadHash: string;
  engine: string; routeMode: 'auto' | 'france' | 'gha'; state: State; sequence: number; createdAt: string; updatedAt: string; startedAt: string | null;
  finishedAt: string | null; answer: string | null; cancelRequested: boolean; launchCiphertext: string;
  lastHeartbeatAt?: string | null; logCursor?: number; output?: { stdout: string; stderr: string; updatedAt: string | null; truncated: boolean };
  /** Worker contact and worker-reported run progress are separate signals. */
  workerReportedUpdatedAt?: string | null;
  workerProgressObservedAt?: string | null;
  workerStartPhase?: string | null;
  workerStartAttempts?: number | null;
  workerStartedAt?: string | null;
  workerFinalizingObservedAt?: string | null;
  logsPending?: boolean;
  launchAttempts: number; result?: Record<string, unknown>; workerReceipt?: Record<string, unknown>;
  capacityRetryAttempts?: number;
  capacityRetryAt?: string;
  capacityQueuedAt?: string;
  capacityWaitMs?: number;
  launchRejection?: { status: number; code: string; fields: string[] };
  lastError?: string;
  artifacts: Array<Record<string, unknown>>; repo: Record<string, unknown> | null; logUrl: string | null;
  events: Array<Record<string, unknown>>;
  eventsDroppedThrough?: number;
  webhook?: WebhookDelivery;
  developerGuest?: boolean;
  developerApi?: boolean;
  artifactExpiresAt?: string;
}
interface CancellationFence { userTaskId: string; ownerGeneration: number; principalId: string; profileId: string; tenantId?: string; createdAt: string }
interface Stored { runs: Record<string, RunRecord>; idempotency: Record<string, string>; cancellationFences?: Record<string, CancellationFence>; latestOwnerGeneration: number; requestId?: string; jobId?: string }
interface ModelConnection { connectionId: string; principalId: string; profileId: string; tenantId?: string; provider: 'openai'; model: string; secretBinding: string }

const INIT: Stored = { runs: {}, idempotency: {}, latestOwnerGeneration: 0 };
const ACTIVE = new Set<State>(['queued', 'starting', 'running']);
const TERMINAL = new Set<State>(['succeeded', 'failed', 'cancelled']);
const UNKNOWN_RECONCILE_MS = 30 * 60_000;
const CAPACITY_RETRY_BASE_MS = 2_000;
const CAPACITY_RETRY_MAX_MS = 30_000;
const MAX_WEBHOOK_ATTEMPTS = 8;
const MAX_RUN_EVENTS = 128;
const MAX_OUTPUT_EVENT_CHARS = 2_000;
const MAX_LIVE_EVENT_SUBSCRIBERS = 32;
const GUEST_ARTIFACT_TTL_MS = 24 * 60 * 60_000;
const now = (): string => new Date().toISOString();
const stateKey = 'runner-v1';
const FRANCE_ENGINE = 'eu-vm-agent-run';
const GHA_ENGINE = 'azure-cloud';
const MCP_TEST = Object.freeze({
  profile: 'integration-telegram-ux-v1', principal: 'integration-telegram-ux-v1',
  server: 'trained-assist-registry-test', binding: 'registry-mcp-test-160-read',
  tool: 'registry.fixture_read', scope: 'registry:fixture-read', policy: 'registry-fixture-policy-v1',
  audience: 'trained-assist:registry-mcp:test', issuer: 'trained-assist-agent-runner',
  url: 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp',
  digest: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9',
  tokenEnv: 'RUNNER_MCP_REGISTRY_TEST',
});
const MCP_USER = Object.freeze({
  profile: 'integration-telegram-ux-v1', principal: 'integration-telegram-ux-v1',
  server: 'mem-gpt', binding: 'mem-gpt-user-sandbox', scope: 'mcp:user-agent-run',
  policy: 'mem-gpt-user-run-v1', audience: 'trained-assist:mcp:user', issuer: 'trained-assist-agent-runner',
  url: 'https://trained-assist-mcp-user-sandbox.skillset-apply.workers.dev/mcp',
  digest: '8c17e64a0d71123698b139bd5957a10fff71a2b15f12601a95adcde150350e71',
  catalogue: 'mem-gpt-user-catalogue-v1', tokenEnv: 'RUNNER_MCP_USER_TOKEN', proofEnv: 'RUNNER_MCP_USER_PROOF',
  tools: ['identity.whoami', 'google_docs.connect', 'google_docs.get_document'],
});

function principalOf(request: Request): ApiPrincipal | null {
  try { return JSON.parse(request.headers.get('x-runner-principal') ?? 'null') as ApiPrincipal | null; } catch { return null; }
}

async function guestSignature(secret: string, runId: string, path: string, expiresAt: string): Promise<string> {
  if (secret.length < 32) throw new Error('RUNNER_GUEST_DOWNLOAD_SECRET must contain at least 32 characters');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${runId}\n${path}\n${expiresAt}`)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function guestDownloadUrl(env: RunnerWorkerEnv, run: RunRecord, path: string): Promise<string> {
  const expiresAt = run.artifactExpiresAt!;
  const signature = await guestSignature(env.RUNNER_GUEST_DOWNLOAD_SECRET ?? '', run.runId, path, expiresAt);
  const url = new URL(`/v1/developer/downloads/${run.runId}`, env.RUNNER_API_PUBLIC_URL);
  url.search = new URLSearchParams({ path, expires: expiresAt, signature }).toString();
  return url.href;
}

function view(run: RunRecord): Record<string, unknown> {
  const progressAgeMs = run.workerReportedUpdatedAt ? Date.now() - Date.parse(run.workerReportedUpdatedAt) : null;
  return { requestId: run.requestId, userTaskId: run.userTaskId, conversationId: run.conversationId, runId: run.runId,
    ownerGeneration: run.ownerGeneration, state: run.state, engine: run.engine, routeMode: run.routeMode ?? 'auto', cancelRequested: run.cancelRequested, connectionLost: run.state === 'unknown',
    createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
    observedAt: run.updatedAt, lastHeartbeatAt: run.lastHeartbeatAt ?? null,
    statusFreshness: run.lastHeartbeatAt && Date.now() - Date.parse(run.lastHeartbeatAt) > 30_000 ? 'stale' : run.lastHeartbeatAt ? 'fresh' : 'unobserved',
    workerReportedUpdatedAt: run.workerReportedUpdatedAt ?? null,
    workerProgressObservedAt: run.workerProgressObservedAt ?? null,
    workerStartPhase: run.workerStartPhase ?? null,
    workerStartAttempts: run.workerStartAttempts ?? null,
    workerStartedAt: run.workerStartedAt ?? null,
    workerProgressFreshness: progressAgeMs === null || !Number.isFinite(progressAgeMs) ? 'unobserved' : progressAgeMs > 30_000 ? 'stale' : 'fresh',
    ...(run.capacityRetryAt ? { queueReason: 'worker_capacity', retryAt: run.capacityRetryAt } : {}),
    ...(run.capacityQueuedAt ? { capacityQueuedAt: run.capacityQueuedAt, capacityWaitMs: run.capacityWaitMs ?? Date.now() - Date.parse(run.capacityQueuedAt) }
      : run.capacityWaitMs !== undefined ? { capacityWaitMs: run.capacityWaitMs } : {}),
    output: run.output ?? { stdout: '', stderr: '', updatedAt: null, truncated: false },
    sequence: run.sequence, fencing: { rejected: 0 }, answer: run.answer };
}

function workerRefusalCode(body: unknown, status: number): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const value = body as Record<string, unknown>;
    for (const candidate of [value.code, value.error]) {
      if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate)) return candidate;
    }
  }
  return `HTTP_${status}`;
}

function isConfirmedCapacityRefusal(body: unknown, status: number): boolean {
  return status === 503 && !!body && typeof body === 'object' && !Array.isArray(body)
    && (body as Record<string, unknown>)['accepted'] === false
    && (body as Record<string, unknown>)['code'] === 'WORKER_CAPACITY';
}

function workerRefusalFields(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const value = body as Record<string, unknown>;
  const details = Array.isArray(value.details) ? value.details : Array.isArray(value.errors) ? value.errors : [];
  const fields = new Set<string>();
  for (const detail of details) {
    if (typeof detail !== 'string') continue;
    const match = /^([A-Za-z][A-Za-z0-9_.[\]-]{0,159})(?::|\s+(?:is|does|must|contains|are|was|required)\b)/i.exec(detail);
    if (match?.[1]) fields.add(match[1]);
    if (fields.size >= 12) break;
  }
  return [...fields];
}

function refusedLaunchResult(run: RunRecord): Record<string, unknown> {
  const status = run.launchRejection?.status ?? Number(run.lastError?.match(/HTTP (4\d\d)/)?.[1] ?? 400);
  const code = run.launchRejection?.code ?? 'WORKER_LAUNCH_REJECTED';
  const fields = run.launchRejection?.fields ?? [];
  const fieldSummary = fields.length ? `; rejected fields: ${fields.join(', ')}` : '';
  return {
    schemaVersion: 1, runId: run.runId, jobId: run.jobId, userTaskId: run.userTaskId,
    profileId: run.profileId, ownerGeneration: run.ownerGeneration, outcome: 'failed',
    exitReason: 'preflight_refused', exitCode: null, exitSignal: null, exitObserved: false, engineStart: 'not_started',
    startedAt: run.startedAt ?? run.createdAt, finishedAt: run.finishedAt ?? now(),
    failure: { code: code.startsWith('WORKER_') ? code : `WORKER_${code}`, failureClass: 'preflight',
      safeSummary: `The ${run.engine} execution worker refused the run before accepting it (HTTP ${status}, ${code}${fieldSummary}).`, retryable: false },
    usage: { status: 'unknown' }, outputRefs: [], persistence: 'not_required',
    persistenceReason: 'The execution worker did not accept the run; there is nothing to persist.',
    cleanup: 'completed', cleanupReason: 'No execution receipt was issued by the worker.',
    logPath: `runner-api://worker-launch-refusal/${run.runId}`,
  };
}

function requestedRepositoryAccessToken(requestedToken: unknown): string | undefined {
  return typeof requestedToken === 'string' && requestedToken.trim().length > 0 ? requestedToken : undefined;
}

function nextEvent(run: RunRecord, type: string, payload: unknown = {}): void {
  if (type === 'opencode_output' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const value = payload as Record<string, unknown>;
    if (typeof value['text'] === 'string') {
      const safeText = redactSecrets(value['text']);
      value['truncated'] = value['truncated'] === true || safeText.length > MAX_OUTPUT_EVENT_CHARS;
      value['text'] = safeText.slice(-MAX_OUTPUT_EVENT_CHARS);
    }
  }
  run.sequence += 1;
  run.updatedAt = now();
  run.events.push({ eventId: `runner-${run.runId}-${run.sequence}`, runId: run.runId, jobId: run.jobId,
    userTaskId: run.userTaskId, profileId: run.profileId, ownerGeneration: run.ownerGeneration, sequence: run.sequence,
    timestamp: run.updatedAt, type, payload });
  while (run.events.length > MAX_RUN_EVENTS) {
    const removed = run.events.shift();
    if (removed && Number.isSafeInteger(removed['sequence'])) run.eventsDroppedThrough = Number(removed['sequence']);
  }
}

function transition(run: RunRecord, next: State, payload?: unknown): void {
  if (run.state === next) return;
  run.state = next;
  if (next === 'running' && !run.startedAt) run.startedAt = now();
  if (TERMINAL.has(next)) run.finishedAt = now();
  const event = next === 'running' ? 'run_started' : next === 'succeeded' ? 'run_succeeded' : next === 'cancelled' ? 'run_cancelled' : next === 'failed' ? 'run_failed' : 'run_state_changed';
  nextEvent(run, event, payload);
}

export class RunnerRunCoordinator {
  private readonly state: DurableObjectStateLike;
  private readonly env: RunnerWorkerEnv;
  private readonly ready: Promise<unknown>;
  private readonly eventVersions = new Map<string, number>();
  private readonly eventWaiters = new Map<string, Set<() => void>>();
  private readonly liveSubscribers = new Map<string, number>();

  constructor(state: DurableObjectStateLike, env: RunnerWorkerEnv) {
    this.state = state;
    this.env = env;
    this.ready = state.blockConcurrencyWhile(async () => { if (!(await state.storage.get<Stored>(stateKey))) await state.storage.put(stateKey, INIT); });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 4 && segments[0] === 'v1' && segments[1] === 'runs' && segments[3] === 'download') {
      return this.guestDownload(request, segments[2]!);
    }
    const principal = principalOf(request);
    if (!principal) return error('UNAUTHENTICATED', 'authenticated principal missing', 401);
    if (url.pathname === '/v1/sandbox/cleanup-task') return request.method === 'POST' ? this.cleanupTask(request, principal) : error('METHOD_NOT_ALLOWED', 'method not allowed', 405);
    if (url.pathname === '/v1/runs/cancel-by-idempotency-key') return request.method === 'POST' ? this.cancelByIdempotencyKey(request, principal) : error('METHOD_NOT_ALLOWED', 'method not allowed', 405);
    if (segments.length === 2 && request.method === 'GET') return this.listTaskRuns(url, principal);
    if (segments.length === 2 && request.method === 'POST') return this.submit(request, principal);
    if (segments.length !== 4) return error('ROUTE_NOT_FOUND', `no route for ${url.pathname}`, 404);
    let runId: string;
    try { runId = decodeURIComponent(segments[2]!); } catch { return error('INVALID_REQUEST', 'invalid run id', 400); }
    if (!SAFE_ID.test(runId)) return error('INVALID_REQUEST', 'invalid run id', 400);
    const stored = await this.read();
    const run = stored.runs[runId];
    if (!run || !owns(run, principal)) return error('NOT_FOUND', `unknown run ${runId}`, 404);
    switch (segments[3]) {
      case 'status': return request.method === 'GET' ? json(view(run)) : error('METHOD_NOT_ALLOWED', 'status supports GET only', 405);
      case 'result':
        if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'result supports GET only', 405);
        if (run.result) return json(run.result);
        // A 4xx launch refusal is terminal proof that France never accepted an
        // execution. Keep old records compatible by materializing their result
        // lazily when the status poller requests it after this code is deployed.
        if (run.state === 'failed' && !run.workerReceipt && run.launchAttempts > 0) {
          run.result = refusedLaunchResult(run);
          await this.state.storage.put(stateKey, stored);
          return json(run.result);
        }
        return error('RESULT_NOT_READY', 'run result is not ready', 409);
      case 'events': {
        if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'events supports GET only', 405);
        const lastEventId = request.headers.get('last-event-id');
        const rawCursor = lastEventId?.trim() || url.searchParams.get('cursor');
        const cursor = rawCursor === null ? 0 : Number(rawCursor);
        if (!Number.isSafeInteger(cursor) || cursor < 0) return error('INVALID_CURSOR', 'event cursor must be a non-negative integer', 400);
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 500) || 500));
        if (request.headers.get('accept')?.includes('text/event-stream')) {
          return this.streamEvents(request, run, cursor, rawCursor !== null, principal);
        }
        const resetRequired = cursor < (run.eventsDroppedThrough ?? 0);
        const available = resetRequired ? [] : run.events.filter((event) => Number(event['sequence']) > cursor);
        const events = available.slice(0, limit);
        return json({ runId, events, cursor: resetRequired ? run.sequence : events.at(-1)?.['sequence'] ?? cursor,
          hasMore: available.length > events.length, resetRequired,
          ...(resetRequired ? { oldestAvailableSequence: run.events[0]?.['sequence'] ?? null } : {}),
          snapshot: { state: run.state, connectionLost: run.state === 'unknown', sequence: run.sequence, ownerGeneration: run.ownerGeneration,
            observedAt: run.updatedAt, lastHeartbeatAt: run.lastHeartbeatAt ?? null,
            statusFreshness: run.lastHeartbeatAt && Date.now() - Date.parse(run.lastHeartbeatAt) > 30_000 ? 'stale' : run.lastHeartbeatAt ? 'fresh' : 'unobserved',
            output: run.output ?? { stdout: '', stderr: '', updatedAt: null, truncated: false } },
          droppedEvents: run.eventsDroppedThrough ?? 0, logUrl: run.logUrl });
      }
      case 'artifacts':
        if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'artifacts supports GET only', 405);
        if (run.developerGuest && run.artifactExpiresAt && Date.now() >= Date.parse(run.artifactExpiresAt)) return error('ARTIFACT_EXPIRED', 'guest artifacts are no longer available', 410);
        if (url.searchParams.has('path')) {
          return this.artifactBytes(run, url.searchParams.get('path') ?? '');
        }
        return json({ runId, conversationId: run.conversationId, userTaskId: run.userTaskId, repo: run.developerGuest ? null : run.repo, branchUrl: null, mergeUrl: null, count: run.artifacts.length, artifacts: run.artifacts, logUrl: run.logUrl,
          ...(run.developerGuest ? { expiresAt: run.artifactExpiresAt ?? null } : {}),
          note: run.artifacts.length ? run.developerGuest ? 'guest downloads expire 24 hours after result collection' : 'artifacts are committed by the VM worker to the run branch' : 'the VM worker reported no artifacts' });
      case 'log': {
        if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'log supports GET only', 405);
        let refreshed: string | null = null;
        let failureCode: string | null = null;
        try {
          const response = await this.worker(run.engine, `/v1/runs/${encodeURIComponent(runId)}/log-url`);
          if (response.ok) {
            const value = await response.json() as { logUrl?: unknown; failureCode?: unknown };
            if (typeof value.logUrl === 'string') refreshed = value.logUrl;
            if (typeof value.failureCode === 'string') failureCode = value.failureCode;
          } else {
            failureCode = `WORKER_HTTP_${response.status}`;
          }
        } catch {
          // Report an unavailable log below; never turn a temporary signer failure
          // into a redirect to an expired URL saved with the original result.
        }
        const target = retrievableLogUrl(refreshed);
        if (!target) return json({ runId, logUrl: run.logUrl, retrievable: false,
          ...(failureCode ? { failureCode } : {}),
          note: run.logUrl ? 'the worker could not issue a fresh Google Storage download URL' : 'the worker has not published a retrievable session log' });
        return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'private, no-store' } });
      }
      case 'webhook':
        if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'webhook supports GET only', 405);
        if (!run.webhook) return error('WEBHOOK_NOT_CONFIGURED', 'run has no webhook', 404);
        return json({ runId, webhookId: run.webhook.webhookId, status: run.webhook.deliveredAt ? 'delivered' : run.webhook.exhaustedAt ? 'failed' : 'pending',
          attempts: run.webhook.attempts, nextAttemptAt: run.webhook.deliveredAt || run.webhook.exhaustedAt ? null : run.webhook.nextAttemptAt,
          deliveredAt: run.webhook.deliveredAt ?? null, lastStatus: run.webhook.lastStatus ?? null,
          lastError: run.webhook.lastError ?? null });
      case 'cancel': return request.method === 'POST' ? this.cancel(request, runId, principal) : error('METHOD_NOT_ALLOWED', 'cancel supports POST only', 405);
      default: return error('ROUTE_NOT_FOUND', `no route for ${url.pathname}`, 404);
    }
  }

  private async guestDownload(request: Request, runId: string): Promise<Response> {
    if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'downloads support GET only', 405);
    if (!SAFE_ID.test(runId)) return error('INVALID_REQUEST', 'invalid run id', 400);
    const run = (await this.read()).runs[runId];
    if (!run?.developerGuest || !run.artifactExpiresAt) return error('NOT_FOUND', 'download not found', 404);
    const url = new URL(request.url);
    const path = url.searchParams.get('path') ?? '';
    const expires = url.searchParams.get('expires') ?? '';
    const signature = url.searchParams.get('signature') ?? '';
    if (!path || expires !== run.artifactExpiresAt || !/^[0-9a-f]{64}$/.test(signature)) return error('NOT_FOUND', 'download not found', 404);
    if (Date.now() >= Date.parse(expires)) return error('ARTIFACT_EXPIRED', 'guest artifact link has expired', 410);
    if (!run.artifacts.some((artifact) => artifact['path'] === path)) return error('NOT_FOUND', 'download not found', 404);
    const receivedBytes = Uint8Array.from(signature.match(/../g)!, (byte) => Number.parseInt(byte, 16));
    const secret = this.env.RUNNER_GUEST_DOWNLOAD_SECRET ?? '';
    if (secret.length < 32) return error('SERVER_MISCONFIGURED', 'guest download signing is unavailable', 503);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, receivedBytes, new TextEncoder().encode(`${runId}\n${path}\n${expires}`));
    if (!valid) return error('NOT_FOUND', 'download not found', 404);
    return this.artifactBytes(run, path);
  }

  private async artifactBytes(run: RunRecord, sourcePath: string): Promise<Response> {
    if (!TERMINAL.has(run.state)) return error('RESULT_NOT_READY', 'run outputs are not available before completion', 409);
    if (!sourcePath || sourcePath.length > 512 || /[\x00-\x1f\x7f]/.test(sourcePath)) return error('INVALID_REQUEST', 'a valid artifact path is required', 400);
    if (!run.artifacts.some((artifact) => artifact['path'] === sourcePath)) return error('NOT_FOUND', 'artifact path is not part of this run', 404);
    const query = new URLSearchParams({ path: sourcePath });
    const response = await this.worker(run.engine, sourcePath === AGENT_HISTORY_PATH && run.developerApi
      ? `/v1/runs/${encodeURIComponent(run.runId)}/history`
      : `/v1/runs/${encodeURIComponent(run.runId)}/artifacts?${query.toString()}`, 'GET', undefined, 30_000);
    const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    for (const name of ['content-type', 'content-length', 'content-disposition', 'x-content-sha256']) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  }

  private async listTaskRuns(url: URL, principal: ApiPrincipal): Promise<Response> {
    const taskId = url.searchParams.get('userTaskId');
    if (!taskId || !SAFE_ID.test(taskId)) return error('INVALID_REQUEST', 'userTaskId query parameter is required and must be a safe id', 400);
    const stateFilter = url.searchParams.get('state');
    if (stateFilter !== null && !['active', 'all'].includes(stateFilter)) return error('INVALID_REQUEST', 'state supports active or all', 400);
    const stored = await this.read();
    const runs = Object.values(stored.runs)
      .filter((run) => run.userTaskId === taskId && owns(run, principal)
        && (stateFilter === 'all' || !['succeeded', 'failed', 'cancelled'].includes(run.state)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId))
      .map((run) => ({ runId: run.runId, userTaskId: run.userTaskId, state: run.state,
        createdAt: run.createdAt, updatedAt: run.updatedAt, startedAt: run.startedAt,
        workerStartPhase: run.workerStartPhase ?? null, workerStartAttempts: run.workerStartAttempts ?? null,
        workerProgressFreshness: run.workerReportedUpdatedAt
          ? Date.now() - Date.parse(run.workerReportedUpdatedAt) > 30_000 ? 'stale' : 'fresh' : 'unobserved',
        links: { status: `/v1/runs/${encodeURIComponent(run.runId)}/status`, result: `/v1/runs/${encodeURIComponent(run.runId)}/result` } }));
    return json({ runs, nextCursor: null });
  }

  private async cleanupTask(request: Request, principal: ApiPrincipal): Promise<Response> {
    let body: { userTaskId?: unknown };
    try { body = await request.json() as { userTaskId?: unknown }; } catch { return error('INVALID_REQUEST', 'request body must be JSON', 400); }
    if (typeof body.userTaskId !== 'string' || !SAFE_ID.test(body.userTaskId)) return error('INVALID_REQUEST', 'userTaskId is required and must be a safe id', 400);
    return this.state.storage.transaction(async (tx) => {
      const stored = await tx.get<Stored>(stateKey) ?? structuredClone(INIT);
      const entries = Object.values(stored.runs).filter((run) => run.userTaskId === body.userTaskId);
      if (Object.keys(stored.runs).length !== entries.length) return error('TASK_STATE_MISMATCH', 'Durable Object contains state for a different task', 409);
      if (!entries.length) {
        const fences = Object.fromEntries(Object.entries(stored.cancellationFences ?? {}).filter(([, fence]) => fence.userTaskId === body.userTaskId));
        if (Object.keys(fences).length) await tx.put(stateKey, { ...structuredClone(INIT), cancellationFences: fences, latestOwnerGeneration: stored.latestOwnerGeneration });
        else await tx.delete(stateKey);
        await this.state.storage.deleteAlarm();
        return json({ status: 'already-empty', userTaskId: body.userTaskId, deletedRuns: 0 });
      }
      if (entries.some((run) => !owns(run, principal))) return error('FORBIDDEN', 'task state is not owned by this principal', 403);
      if (entries.some((run) => ACTIVE.has(run.state) || run.state === 'unknown' || !TERMINAL.has(run.state))) return error('RUN_NOT_TERMINAL', 'active or unknown runs cannot be cleaned up', 409);
      if (entries.some((run) => run.webhook && !run.webhook.deliveredAt && !run.webhook.exhaustedAt)) return error('WEBHOOK_DELIVERY_PENDING', 'pending webhook delivery cannot be cleaned up', 409);
      // This Durable Object is keyed to one task ID. Remove the whole record so
      // idempotency keys, owner generations, events, and results are reset too.
      const fences = Object.fromEntries(Object.entries(stored.cancellationFences ?? {}).filter(([, fence]) => fence.userTaskId === body.userTaskId));
      if (Object.keys(fences).length) await tx.put(stateKey, { ...structuredClone(INIT), cancellationFences: fences, latestOwnerGeneration: stored.latestOwnerGeneration });
      else await tx.delete(stateKey);
      await this.state.storage.deleteAlarm();
      return json({ status: 'cleaned', userTaskId: body.userTaskId, deletedRuns: entries.length });
    });
  }

  private async submit(request: Request, principal: ApiPrincipal): Promise<Response> {
    if (principal.developerGuest && (this.env.RUNNER_GUEST_DOWNLOAD_SECRET?.length ?? 0) < 32) {
      return error('SERVER_MISCONFIGURED', 'guest download signing is unavailable', 503);
    }
    const key = request.headers.get('idempotency-key')?.trim() ?? '';
    if (!key || key.length > 200) return error('MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required and must be at most 200 characters', 400);
    let body: Record<string, any>;
    const contentLength = Number(request.headers.get('content-length') ?? 0);
    if (contentLength > 1_000_000) return error('BODY_TOO_LARGE', 'request body exceeds 1000000 bytes', 413);
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > 1_000_000) return error('BODY_TOO_LARGE', 'request body exceeds 1000000 bytes', 413);
      body = JSON.parse(text) as Record<string, any>;
    } catch { return error('INVALID_REQUEST', 'request body must be JSON', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error('INVALID_REQUEST', 'request body must be an object', 400);
    const allowedFields = new Set(['userTaskId', 'conversationId', 'engine', 'routeMode', 'input', 'ingressManifest', 'envAllowlist', 'limits', 'deadline', 'regionConstraints', 'credentialBindings', 'mcp', 'budget', 'result', 'outputs', 'publicationMode', 'traceId', 'instructions', 'repository', 'isolation', 'webhookId']);
    if (body.publicationMode !== undefined && body.publicationMode !== 'git' && body.publicationMode !== 'none') return error('INVALID_REQUEST', 'publicationMode must be git or none', 400);
    if (body.publicationMode === 'none' && ((Array.isArray(body.outputs) && body.outputs.length > 0) || body.profileWorkspace !== undefined)) return error('INVALID_REQUEST', 'publicationMode none cannot be combined with outputs or profileWorkspace', 400);
    const unknownFields = Object.keys(body).filter((name) => !allowedFields.has(name));
    if (unknownFields.length) return error('INVALID_REQUEST', 'request contains unsupported fields', 400, { errors: unknownFields.map((name) => `request.${name}: unknown field`) });
    if (!Array.isArray(body.envAllowlist) || !body.limits || !Number.isSafeInteger(body.limits.timeoutMs) || body.limits.timeoutMs <= 0 || body.limits.timeoutMs > 86_400_000) return error('INVALID_REQUEST', 'envAllowlist and a valid limits.timeoutMs are required', 400);
    if (body.engine !== undefined && (!body.engine || typeof body.engine.name !== 'string' || typeof body.engine.adapterVersion !== 'string')) return error('INVALID_REQUEST', 'engine.name and engine.adapterVersion are required when engine is supplied', 400);
    if (body.repository !== undefined && (!body.repository || typeof body.repository.fullName !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/.test(body.repository.fullName))) return error('INVALID_REPOSITORY', 'repository.fullName must be an owner/name pair', 400);
    const taskId = typeof body.userTaskId === 'string' && SAFE_ID.test(body.userTaskId) ? body.userTaskId : '';
    const conversationId = typeof body.conversationId === 'string' && SAFE_ID.test(body.conversationId) ? body.conversationId : taskId;
    const inputPrompt = body.input?.inlinePrompt;
    const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
    if (!taskId || (typeof inputPrompt !== 'string' || !inputPrompt.trim()) && !instructions) return error('INVALID_REQUEST', 'userTaskId and a non-empty prompt or instructions are required', 400, { errors: ['userTaskId: expected safe id', 'input.inlinePrompt: expected non-empty string'] });
    if ((typeof inputPrompt === 'string' && inputPrompt.length > 100_000) || instructions.length > 10_000) return error('INVALID_REQUEST', 'prompt or instructions exceed their size limit', 400);
    const ingressManifest = body.ingressManifest;
    if (ingressManifest !== undefined && (!ingressManifest || typeof ingressManifest !== 'object' || Array.isArray(ingressManifest)
      || Object.keys(ingressManifest).sort().join(',') !== 'contractVersion,manifestRef,manifestVersion'
      || ingressManifest.contractVersion !== 1
      || ingressManifest.manifestRef !== `cp-input-manifest:${taskId}`
      || typeof ingressManifest.manifestVersion !== 'string' || !/^[0-9a-f]{64}$/.test(ingressManifest.manifestVersion))) {
      return error('INVALID_INGRESS_MANIFEST', 'ingressManifest must be a task-scoped Control Plane manifest pin', 400);
    }
    if (Array.isArray(body.input?.refs) && body.input.refs.length) return error('INPUT_REFS_UNSUPPORTED', 'input refs need a durable workspace and are not supported by this Worker API yet', 422);
    const mcp = body.mcp?.servers?.length ? body.mcp.servers : [];
    if (!Array.isArray(mcp) || mcp.length > 1) return error('MCP_HOST_POLICY_MISSING', 'only one host-pinned MCP server is supported by this Worker API', 422);
    let userMcp = false;
    if (mcp.length === 1) {
      const server = mcp[0];
      const fields = ['serverId', 'transport', 'url', 'bindingRef', 'allowedTools', 'policyVersion', 'catalogueVersion'];
      if (!server || typeof server !== 'object' || Object.keys(server).some((field) => !fields.includes(field))) return error('MCP_HOST_POLICY_MISSING', 'MCP descriptor contains unsupported fields', 422);
      if (server.serverId === MCP_TEST.server) {
        if (principal.profileId !== MCP_TEST.profile || principal.principalId !== MCP_TEST.principal ||
            !principal.mcpBindings?.includes(MCP_TEST.binding) || server.transport !== 'remote' || server.url !== MCP_TEST.url || server.bindingRef !== MCP_TEST.binding ||
            !Array.isArray(server.allowedTools) || server.allowedTools.length !== 1 || server.allowedTools[0] !== MCP_TEST.tool ||
            server.policyVersion !== MCP_TEST.policy || typeof server.catalogueVersion !== 'string' ||
            !/^[A-Za-z0-9._~-]{1,200}$/.test(server.catalogueVersion) ||
            (this.env.MCP_TEST_CATALOGUE_VERSION && server.catalogueVersion !== this.env.MCP_TEST_CATALOGUE_VERSION)) {
          return error('MCP_HOST_POLICY_MISSING', 'MCP descriptor is outside this principal’s pinned test Registry policy', 422);
        }
        if (!this.env.MCP_TEST_AUTH_TOKEN || !this.env.MCP_TEST_RUNNER_PRIVATE_JWK || !this.env.MCP_TEST_CATALOGUE_VERSION || !this.env.MCP_TEST_EXPIRES_AT ||
            !Number.isFinite(Date.parse(this.env.MCP_TEST_EXPIRES_AT)) || Date.parse(this.env.MCP_TEST_EXPIRES_AT) <= Date.now()) {
          return error('MCP_BINDING_UNAVAILABLE', 'pinned test Registry MCP secrets or lease are not configured', 503);
        }
      } else if (server.serverId === MCP_USER.server) {
        if (principal.profileId !== MCP_USER.profile || principal.principalId !== MCP_USER.principal ||
            server.transport !== 'remote' || server.url !== MCP_USER.url || server.bindingRef !== MCP_USER.binding ||
            !Array.isArray(server.allowedTools) || server.allowedTools.length !== MCP_USER.tools.length ||
            MCP_USER.tools.some((tool, index) => server.allowedTools[index] !== tool) ||
            server.policyVersion !== MCP_USER.policy || server.catalogueVersion !== MCP_USER.catalogue) {
          return error('MCP_HOST_POLICY_MISSING', 'MCP descriptor is outside this profile’s pinned user catalog policy', 422);
        }
        if (!this.env.MCP_USER_AUTH_TOKEN || this.env.MCP_USER_AUTH_TOKEN.length < 32 || !this.env.MCP_USER_RUNNER_PRIVATE_JWK ||
            this.env.MCP_USER_CATALOGUE_VERSION !== MCP_USER.catalogue || this.env.MCP_USER_CATALOGUE_DIGEST !== MCP_USER.digest) {
          return error('MCP_BINDING_UNAVAILABLE', 'pinned sandbox user catalog credentials or digest are not configured', 503);
        }
        let profileUsers: Record<string, string>;
        try {
          const parsed: unknown = JSON.parse(this.env.MCP_USER_PROFILE_USER_IDS ?? 'null');
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(profile => profile !== MCP_USER.profile) ||
              Object.values(parsed).some(value => typeof value !== 'string' || !/^[A-Za-z0-9._:@-]{1,200}$/.test(value))) throw new Error();
          profileUsers = parsed as Record<string, string>;
        } catch { return error('MCP_BINDING_UNAVAILABLE', 'sandbox user catalog profile mapping is invalid', 503); }
        if (!profileUsers[principal.profileId]) return error('MCP_BINDING_UNAVAILABLE', 'sandbox user catalog has no user mapping for this profile', 503);
        userMcp = true;
      } else return error('MCP_HOST_POLICY_MISSING', 'MCP server is not host approved', 422);
    }
    if (userMcp && body.limits.timeoutMs > 7_140_000) return error('MCP_GRANT_MAX_LIFETIME', 'sandbox user catalog runs are limited to a grant lifetime of two hours', 422);
    if (body.profileWorkspace) return error('FEATURE_UNSUPPORTED', 'profile workspace is not supported by this Worker API yet', 422);
    if (body.isolation !== undefined && body.isolation?.mode !== 'none') return error('ISOLATION_UNSUPPORTED', 'the France VM worker currently supports isolation.mode=none only', 422);
    const routeMode = body.routeMode === undefined ? 'auto' : body.routeMode;
    if (routeMode !== 'auto' && routeMode !== 'france' && routeMode !== 'gha') return error('INVALID_REQUEST', 'routeMode must be auto, france, or gha', 400);
    if (routeMode === 'gha' && !this.hasGhaWorker()) return error('ROUTE_UNAVAILABLE', 'the GHA/Azure route is not configured for this Runner API', 503);
    if (routeMode !== 'gha' && body.regionConstraints?.allowedRegions && !body.regionConstraints.allowedRegions.includes('eu')) return error('REGION_UNAVAILABLE', 'this Runner API only dispatches to the France EU worker', 422);
    const mockTest = body.engine?.name === 'mock-test' && this.env.MOCK_TEST_ENABLED === 'true';
    const engine = mockTest ? 'mock-test' : routeMode === 'gha' ? GHA_ENGINE : FRANCE_ENGINE;
    if (routeMode !== 'gha' && engine === GHA_ENGINE) return error('INVALID_REQUEST', 'use routeMode=gha to select the GHA/Azure execution route', 400);
    if (routeMode === 'gha' && body.engine?.name !== undefined && body.engine.name !== GHA_ENGINE) return error('INVALID_REQUEST', 'engine.name must be azure-cloud when routeMode=gha', 400);
    if (!mockTest && body.engine?.name !== undefined && body.engine.name !== engine) return error('INVALID_REQUEST', `engine.name must be ${engine} for routeMode=${routeMode}`, 400);
    if ((engine !== FRANCE_ENGINE && engine !== GHA_ENGINE && !(mockTest && this.env.MOCK_TEST_ENABLED === 'true')) || (principal.engines && !principal.engines.includes(engine))) return error('FORBIDDEN', 'requested engine is not allowed for this key', 403);
    const allowedRepositories = new Set(this.env.ALLOWED_REPOSITORIES.split(',').map((item) => item.trim()).filter(Boolean));
    const requestedRepository = body.repository?.fullName;
    if (principal.repository && requestedRepository && requestedRepository !== principal.repository) return error('REPOSITORY_BINDING_MISMATCH', 'request repository does not match the authenticated profile binding', 403);
    if (!mockTest && !principal.repository) return error('SERVER_MISCONFIGURED', 'authenticated profile has no repository binding', 503);
    const repository = mockTest ? '' : principal.repository!;
    if (repository && !allowedRepositories.has(repository)) return error('INVALID_REPOSITORY', 'repository is not approved on this Runner API', 400);
    if (body.repository?.token !== undefined && (typeof body.repository.token !== 'string' || body.repository.token.length > 500)) return error('INVALID_REQUEST', 'repository.token is invalid', 400);
    const repositoryToken = requestedRepositoryAccessToken(body.repository?.token);
    const requestedEnv = Array.isArray(body.envAllowlist) ? body.envAllowlist : [];
    const allowedEnv = new Set((this.env.ALLOWED_ENVIRONMENT_NAMES ?? '').split(',').map((item) => item.trim()).filter(Boolean));
    if (requestedEnv.some((name: unknown) => typeof name !== 'string' || !allowedEnv.has(name))) return error('FORBIDDEN', 'envAllowlist requests a name not approved for this Runner API', 403);
    const envAllowlist = requestedEnv as string[];
    const launchEnv = runtimeEnv(this.env, envAllowlist);
    if (envAllowlist.some((name) => !launchEnv[name])) return error('SERVER_MISCONFIGURED', 'an approved runtime environment secret is missing', 503);
    let boundModel: string | undefined;
    if (body.credentialBindings !== undefined && !(Array.isArray(body.credentialBindings) && body.credentialBindings.length === 0)) {
      if (this.env.DEPLOYMENT_ENV === 'production' || this.env.RUNNER_BYOK_ENABLED !== 'true') {
        return error('FEATURE_UNSUPPORTED', 'hosted model connections are disabled on this lane', 422);
      }
      const bindings = body.credentialBindings;
      if (!Array.isArray(bindings) || bindings.length !== 1 || !bindings[0] ||
          Object.keys(bindings[0]).sort().join(',') !== 'connectionId,type' || bindings[0].type !== 'openai' ||
          typeof bindings[0].connectionId !== 'string' || !SAFE_ID.test(bindings[0].connectionId)) {
        return error('INVALID_CREDENTIAL_BINDING', 'exactly one OpenAI connectionId binding is supported', 400);
      }
      if (envAllowlist.length || body.engine?.modelSettings?.model !== undefined) {
        return error('INVALID_CREDENTIAL_BINDING', 'a model connection cannot be combined with runtime secrets or a caller-selected model', 400);
      }
      const allowedOnWorker = new Set((this.env.ALLOWED_ENVIRONMENT_NAMES ?? '').split(',').map((name) => name.trim()));
      if (!allowedOnWorker.has('OPENAI_API_KEY')) return error('SERVER_MISCONFIGURED', 'OpenAI BYOK is not enabled on this lane', 503);
      let connections: ModelConnection[];
      try {
        const parsed: unknown = JSON.parse(this.env.RUNNER_MODEL_CONNECTIONS ?? 'null');
        if (!Array.isArray(parsed) || parsed.some((entry) => !validModelConnection(entry))) throw new Error('invalid connections');
        connections = parsed as ModelConnection[];
      } catch { return error('SERVER_MISCONFIGURED', 'model connection registry is invalid', 503); }
      const selected = connections.find((entry) => entry.connectionId === bindings[0].connectionId &&
        entry.principalId === principal.principalId && entry.profileId === principal.profileId && entry.tenantId === principal.tenantId);
      if (!selected) return error('MODEL_CONNECTION_NOT_FOUND', 'model connection is not available to this principal', 404);
      const secret = this.env[selected.secretBinding];
      if (typeof secret !== 'string' || !secret || secret.length > 100_000) return error('SERVER_MISCONFIGURED', 'model connection secret is unavailable', 503);
      envAllowlist.push('OPENAI_API_KEY');
      launchEnv.OPENAI_API_KEY = secret;
      boundModel = selected.model;
    }
    let webhook: WebhookDelivery | undefined;
    if (body.webhookId !== undefined) {
      if (this.env.DEPLOYMENT_ENV === 'production' || this.env.RUNNER_WEBHOOKS_ENABLED !== 'true') return error('FEATURE_UNSUPPORTED', 'webhook delivery is disabled on this lane', 422);
      if (typeof body.webhookId !== 'string' || !SAFE_ID.test(body.webhookId)) return error('INVALID_REQUEST', 'webhookId must be a safe ID', 400);
      let connection: WebhookConnection | null;
      try { connection = resolveWebhook(this.env, principal, body.webhookId); }
      catch { return error('SERVER_MISCONFIGURED', 'webhook registry is invalid', 503); }
      if (!connection) return error('WEBHOOK_NOT_FOUND', 'webhook is not available to this principal', 404);
      const secret = this.env[connection.secretBinding];
      if (typeof secret !== 'string' || secret.length < 24) return error('SERVER_MISCONFIGURED', 'webhook signing secret is unavailable', 503);
      webhook = { webhookId: connection.webhookId, url: connection.url, secretBinding: connection.secretBinding,
        attempts: 0, nextAttemptAt: now() };
    }
    const idemKey = `${principal.principalId}\0${key}`;
    const hashInput = structuredClone(body);
    if (hashInput.repository && typeof hashInput.repository === 'object') delete hashInput.repository.token;
    const payloadHash = await digest(canonicalJson(hashInput));
    let record!: RunRecord;
    let deduplicated = false;
    let conflict = false;
    let cancelledBeforeAdmission = false;
    await this.state.storage.transaction(async (tx) => {
      const stored = await tx.get<Stored>(stateKey) ?? structuredClone(INIT);
      const expiration = Date.now() - 24 * 60 * 60 * 1000;
      for (const [oldRunId, oldRun] of Object.entries(stored.runs)) {
        if (TERMINAL.has(oldRun.state) && oldRun.finishedAt && Date.parse(oldRun.finishedAt) < expiration
          && (!oldRun.webhook || oldRun.webhook.deliveredAt || oldRun.webhook.exhaustedAt)) {
          delete stored.runs[oldRunId];
          for (const [oldKey, mappedRun] of Object.entries(stored.idempotency)) if (mappedRun === oldRunId) delete stored.idempotency[oldKey];
        }
      }
      const existingId = stored.idempotency[idemKey];
      const existing = existingId ? stored.runs[existingId] : undefined;
      if (existing) {
        if (existing.payloadHash !== payloadHash) { conflict = true; return; }
        record = existing;
        deduplicated = true;
        return;
      }
      const prior = Object.values(stored.runs).filter((candidate) => candidate.principalId === principal.principalId && candidate.profileId === principal.profileId && candidate.userTaskId === taskId)
        .sort((a, b) => b.ownerGeneration - a.ownerGeneration)[0];
      if (prior && ACTIVE.has(prior.state)) {
        record = prior;
        conflict = true;
        return;
      }
      const ownerGeneration = Math.max(prior?.ownerGeneration ?? 0, stored.latestOwnerGeneration) + 1;
      const cancellationFence = stored.cancellationFences?.[idemKey];
      if (cancellationFence && cancellationFence.userTaskId === taskId &&
          cancellationFence.principalId === principal.principalId && cancellationFence.profileId === principal.profileId && cancellationFence.tenantId === principal.tenantId) {
        conflict = true;
        cancelledBeforeAdmission = true;
        return;
      }
      const taskHash = await digest(`${principal.principalId}\0${principal.profileId}\0${taskId}`);
      const runId = `run_${taskHash}_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const requestId = prior?.requestId ?? stored.requestId ?? `req_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const time = now();
      const jobId = prior?.jobId ?? stored.jobId ?? `job_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const resultUrl = `${this.env.RUNNER_API_PUBLIC_URL.replace(/\/+$/, '')}/v1/runs/${runId}/result`;
      const limits = body.limits;
      const launch = { runId, jobId, userTaskId: taskId, profileId: principal.profileId, conversationId, operationId: `op_${await digest(`${taskId}:${ownerGeneration}`).then((h) => h.slice(0, 24))}`,
          ownerGeneration, engine: { name: engine, adapterVersion: body.engine?.adapterVersion ?? '1', ...(boundModel || body.engine?.modelSettings?.model ? { modelSettings: { model: boundModel ?? body.engine.modelSettings.model } } : {}) },
          input: { inlinePrompt: `${typeof inputPrompt === 'string' ? inputPrompt : ''}${instructions ? `${inputPrompt ? '\n\nAdditional instructions: ' : ''}${instructions}` : ''}` }, cwd: `/tmp/runner/${runId}`, envAllowlist, env: launchEnv, limits: { timeoutMs: clampInteger(limits.timeoutMs, 300_000, 1_000, 86_400_000), maxOutputBytes: clampInteger(limits.maxOutputBytes, 5_000_000, 1, 100_000_000), maxLogBytes: clampInteger(limits.maxLogBytes, 5_000_000, 1, 100_000_000) },
          ...(ingressManifest ? { ingressManifest: { ...ingressManifest, userTaskId: taskId, profileId: principal.profileId, runId, ownerGeneration } } : {}),
          repository: { fullName: repository ?? '', branch: `agent-run/${runId}`, ...(body.repository?.revision ? { revision: body.repository.revision } : {}) },
          ...(repositoryToken ? { publicationToken: repositoryToken } : {}),
          resultUrl, isolation: body.isolation ?? { mode: 'none' }, outputs: Array.isArray(body.outputs) ? body.outputs : [], ...(body.publicationMode ? { publicationMode: body.publicationMode } : {}),
          ...(mcp.length ? userMcp
            ? await this.userCatalogAttachment({ runId, taskId, profileId: principal.profileId, ownerGeneration, timeoutMs: clampInteger(limits.timeoutMs, 300_000, 1_000, 86_400_000) })
            : await this.testRegistryAttachment(mcp[0], { runId, taskId, profileId: principal.profileId, timeoutMs: clampInteger(limits.timeoutMs, 300_000, 1_000, 86_400_000) }) : {}) };
      record = { requestId, runId, userTaskId: taskId, conversationId, jobId, ownerGeneration, principalId: principal.principalId, profileId: principal.profileId,
        ...(principal.developerApi ? { developerApi: true } : {}),
        ...(principal.developerGuest ? { developerGuest: true } : {}),
        ...(principal.tenantId ? { tenantId: principal.tenantId } : {}), idempotencyKey: idemKey, payloadHash, engine, routeMode, state: 'queued', sequence: 0,
        createdAt: time, updatedAt: time, startedAt: null, finishedAt: null, answer: null, cancelRequested: false, launchAttempts: 0, events: [], artifacts: [], repo: null, logUrl: null,
        ...(webhook ? { webhook } : {}), launchCiphertext: await encrypt(JSON.stringify(launch), this.env.RUN_LAUNCH_ENCRYPTION_KEY) }
      nextEvent(record, 'run_queued');
      stored.runs[runId] = record;
      stored.idempotency[idemKey] = runId;
      stored.latestOwnerGeneration = ownerGeneration;
      stored.requestId = requestId;
      stored.jobId = jobId;
      await tx.put(stateKey, stored);
    });
    if (conflict) return error(cancelledBeforeAdmission ? 'CANCELLED_BEFORE_ADMISSION' : record && ACTIVE.has(record.state) ? 'TASK_ATTEMPT_ACTIVE' : 'IDEMPOTENCY_CONFLICT', cancelledBeforeAdmission ? 'the attempt was durably cancelled before admission' : record && ACTIVE.has(record.state) ? `task ${record.userTaskId} already has an active attempt` : 'the same Idempotency-Key was already used with a different request', 409, record && ACTIVE.has(record.state) ? { runId: record.runId, state: record.state } : undefined);
    if (!deduplicated && record) this.signalRunChanged(record.runId);
    if (!deduplicated) await this.state.storage.setAlarm(Date.now() + 100);
    if (!record!) return error('INTERNAL', 'run could not be admitted', 500);
    if (deduplicated) return json({ requestId: record.requestId, userTaskId: record.userTaskId, runId: record.runId, deduplicated: true }, 200);
    return json({ requestId: record.requestId, userTaskId: record.userTaskId, runId: record.runId, deduplicated: false }, 202);
  }

  private async cancelByIdempotencyKey(request: Request, principal: ApiPrincipal): Promise<Response> {
    let body: { userTaskId?: unknown; idempotencyKey?: unknown; ownerGeneration?: unknown };
    try { body = await request.json() as typeof body; } catch { return error('INVALID_REQUEST', 'cancel body must be valid JSON', 400); }
    if (typeof body.userTaskId !== 'string' || !SAFE_ID.test(body.userTaskId) ||
        typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200 ||
        !Number.isSafeInteger(body.ownerGeneration) || Number(body.ownerGeneration) < 1) {
      return error('INVALID_REQUEST', 'userTaskId, idempotencyKey, and a positive ownerGeneration are required', 400);
    }
    const taskId = body.userTaskId;
    const idempotencyKey = body.idempotencyKey.trim();
    const ownerGeneration = Number(body.ownerGeneration);
    const idemKey = `${principal.principalId}\0${idempotencyKey}`;
    let response: Record<string, unknown> | undefined;
    let failure: Response | undefined;
    let runToCancel: RunRecord | undefined;
    await this.state.storage.transaction(async (tx) => {
      const stored = await tx.get<Stored>(stateKey) ?? structuredClone(INIT);
      const mappedRunId = stored.idempotency[idemKey];
      const run = mappedRunId ? stored.runs[mappedRunId] : undefined;
      if (run) {
        if (!owns(run, principal)) { failure = error('FORBIDDEN', 'run is not owned by this principal', 403); return; }
        if (run.userTaskId !== taskId || run.ownerGeneration !== ownerGeneration) {
          failure = error('CANCEL_IDENTITY_MISMATCH', 'idempotency key belongs to a different task or owner generation', 409); return;
        }
        if (TERMINAL.has(run.state)) {
          response = { status: 'already_terminal', userTaskId: run.userTaskId, ownerGeneration: run.ownerGeneration, runId: run.runId, state: run.state };
          return;
        }
        run.cancelRequested = true;
        nextEvent(run, 'run_cancel_requested');
        run.updatedAt = now();
        stored.runs[run.runId] = run;
        await tx.put(stateKey, stored);
        runToCancel = run;
        response = { status: 'stop_pending', userTaskId: run.userTaskId, ownerGeneration: run.ownerGeneration, runId: run.runId, state: run.state };
        return;
      }
      const fences = stored.cancellationFences ??= {};
      const existingFence = fences[idemKey];
      if (existingFence && (existingFence.userTaskId !== taskId || existingFence.ownerGeneration !== ownerGeneration ||
          existingFence.principalId !== principal.principalId || existingFence.profileId !== principal.profileId || existingFence.tenantId !== principal.tenantId)) {
        failure = error('CANCEL_IDENTITY_MISMATCH', 'idempotency key is already fenced for a different task or owner generation', 409); return;
      }
      if (!existingFence) {
        const taskRuns = Object.values(stored.runs).filter((candidate) => candidate.principalId === principal.principalId &&
          candidate.profileId === principal.profileId && candidate.userTaskId === taskId);
        if (taskRuns.some((candidate) => ACTIVE.has(candidate.state) || candidate.state === 'unknown')) {
          failure = error('TASK_ATTEMPT_ACTIVE', 'task has an admitted attempt that must be cancelled by run id', 409); return;
        }
        const expectedGeneration = Math.max(stored.latestOwnerGeneration, ...taskRuns.map((candidate) => candidate.ownerGeneration), 0) + 1;
        if (ownerGeneration !== expectedGeneration) {
          failure = error('STALE_OWNER_GENERATION', 'cancel does not name the next task owner generation', 409, { ownerGeneration: expectedGeneration }); return;
        }
        fences[idemKey] = { userTaskId: taskId, ownerGeneration, principalId: principal.principalId,
          profileId: principal.profileId, ...(principal.tenantId ? { tenantId: principal.tenantId } : {}), createdAt: now() };
        stored.latestOwnerGeneration = Math.max(stored.latestOwnerGeneration, ownerGeneration);
        await tx.put(stateKey, stored);
      }
      response = { status: 'cancelled_before_admission', userTaskId: taskId, ownerGeneration, runId: null };
    });
    if (failure) return failure;
    if (runToCancel) this.signalRunChanged(runToCancel.runId);
    if (runToCancel?.workerReceipt) {
      try { await this.worker(runToCancel.engine, `/v1/runs/${runToCancel.runId}/cancel`, 'POST', {}); }
      catch { /* durable cancelRequested is reconciled by the alarm */ }
    }
    if (runToCancel) await this.state.storage.setAlarm(Date.now() + 100);
    return json(response);
  }

  private async cancel(request: Request, runId: string, principal: ApiPrincipal): Promise<Response> {
    let body: { ownerGeneration?: unknown } = {};
    try { body = await request.json() as { ownerGeneration?: unknown }; } catch { return error('INVALID_REQUEST', 'cancel body must be valid JSON', 400); }
    let run: RunRecord | undefined;
    let failure: Response | undefined;
    await this.state.storage.transaction(async (tx) => {
      const stored = await tx.get<Stored>(stateKey) ?? structuredClone(INIT);
      run = stored.runs[runId];
      if (!run || !owns(run, principal)) { failure = error('NOT_FOUND', `unknown run ${runId}`, 404); return; }
      if (body.ownerGeneration !== undefined && body.ownerGeneration !== run.ownerGeneration) { failure = error('STALE_OWNER_GENERATION', 'cancel names a stale owner generation', 409, { ownerGeneration: run.ownerGeneration }); return; }
      if (TERMINAL.has(run.state)) return;
      run.cancelRequested = true;
      nextEvent(run, 'run_cancel_requested');
      run.updatedAt = now();
      stored.runs[runId] = run;
      await tx.put(stateKey, stored);
    });
    if (failure) return failure;
    if (!run) return error('NOT_FOUND', `unknown run ${runId}`, 404);
    this.signalRunChanged(runId);
    if (TERMINAL.has(run.state)) return json({ runId, status: 'already_terminal', state: run.state });
    if (run.workerReceipt) await this.worker(run.engine, `/v1/runs/${runId}/cancel`, 'POST', {});
    await this.state.storage.setAlarm(Date.now() + 100);
    return json({ runId, status: run.workerReceipt ? 'stop_pending' : 'stopped', state: run.state }, run.workerReceipt ? 202 : 200);
  }

  private async streamEvents(request: Request, initialRun: RunRecord, requestedCursor: number, hasCursor: boolean, principal: ApiPrincipal): Promise<Response> {
    const runId = initialRun.runId;
    const subscribers = this.liveSubscribers.get(runId) ?? 0;
    if (subscribers >= MAX_LIVE_EVENT_SUBSCRIBERS) return error('STREAM_CAPACITY', 'too many event stream subscribers for this run', 429);
    this.liveSubscribers.set(runId, subscribers + 1);
    await this.state.storage.setAlarm(Date.now() + 100);

    let cursor = requestedCursor;
    let initialized = false;
    let closed = false;
    let cleaned = false;
    const abort = new AbortController();
    const encoder = new TextEncoder();
    const clear = (): void => {
      if (cleaned) return;
      cleaned = true;
      const count = this.liveSubscribers.get(runId) ?? 1;
      if (count <= 1) this.liveSubscribers.delete(runId);
      else this.liveSubscribers.set(runId, count - 1);
      if (!this.eventWaiters.has(runId)) this.eventVersions.delete(runId);
      request.signal.removeEventListener('abort', onRequestAbort);
      abort.abort();
    };
    const onRequestAbort = (): void => clear();
    request.signal.addEventListener('abort', onRequestAbort, { once: true });

    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (!closed) {
          const observedVersion = this.eventVersions.get(runId) ?? 0;
          try {
          const stored = await this.read();
          const run = stored.runs[runId];
          if (!run || !owns(run, principal)) {
            closed = true;
            clear();
            controller.close();
            return;
          }

          if (!initialized) {
            initialized = true;
            const resetRequired = hasCursor && (cursor > run.sequence || cursor < (run.eventsDroppedThrough ?? 0));
            if (!hasCursor || resetRequired) {
              cursor = run.sequence;
              const type = resetRequired ? 'reset' : 'snapshot';
              controller.enqueue(encoder.encode(`id: ${cursor}\nevent: ${type}\ndata: ${JSON.stringify(view(run))}\n\n`));
              if (TERMINAL.has(run.state)) {
                closed = true;
                clear();
                controller.close();
              }
              return;
            }
          }

          if (hasCursor && cursor < (run.eventsDroppedThrough ?? 0)) {
            cursor = run.sequence;
            controller.enqueue(encoder.encode(`id: ${cursor}\nevent: reset\ndata: ${JSON.stringify(view(run))}\n\n`));
            if (TERMINAL.has(run.state)) {
              closed = true;
              clear();
              controller.close();
            }
            return;
          }

          const next = run.events.find((event) => Number(event['sequence']) > cursor);
          if (next) {
            cursor = Number(next['sequence']);
            controller.enqueue(encoder.encode(`id: ${cursor}\nevent: ${String(next['type'] ?? 'message')}\ndata: ${JSON.stringify(next)}\n\n`));
            return;
          }
          if (TERMINAL.has(run.state)) {
            closed = true;
            clear();
            controller.enqueue(encoder.encode(`event: end\ndata: ${JSON.stringify({ runId, sequence: run.sequence })}\n\n`));
            controller.close();
            return;
          }

          const changed = await this.waitForEvent(runId, observedVersion, abort.signal, 15_000);
          if (closed) return;
          if (abort.signal.aborted) {
            closed = true;
            clear();
            controller.close();
            return;
          }
          if (!changed) {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
            return;
          }
          } catch (cause) {
            closed = true;
            clear();
            controller.error(cause);
          }
        }
      },
      cancel: () => {
        closed = true;
        clear();
      },
    }, { highWaterMark: 1 });

    return new Response(stream, { status: 200, headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    } });
  }

  private async waitForEvent(runId: string, version: number, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    if (signal.aborted || (this.eventVersions.get(runId) ?? 0) !== version) return !signal.aborted;
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const listeners = this.eventWaiters.get(runId) ?? new Set<() => void>();
      this.eventWaiters.set(runId, listeners);
      const finish = (changed: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        listeners.delete(onChange);
        signal.removeEventListener('abort', onAbort);
        if (!listeners.size) this.eventWaiters.delete(runId);
        if (!listeners.size && !this.liveSubscribers.has(runId)) this.eventVersions.delete(runId);
        resolve(changed);
      };
      const onChange = (): void => finish(true);
      const onAbort = (): void => finish(false);
      listeners.add(onChange);
      timer = setTimeout(() => finish(false), timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      if ((this.eventVersions.get(runId) ?? 0) !== version) finish(true);
    });
  }

  private signalRunChanged(runId: string): void {
    const waiters = this.eventWaiters.get(runId);
    if (!this.liveSubscribers.has(runId) && !waiters?.size) return;
    this.eventVersions.set(runId, (this.eventVersions.get(runId) ?? 0) + 1);
    for (const wake of waiters ?? []) wake();
  }

  private async testRegistryAttachment(server: Record<string, unknown>, context: { runId: string; taskId: string; profileId: string; timeoutMs: number }): Promise<Record<string, unknown>> {
    const expiresAt = Date.parse(this.env.MCP_TEST_EXPIRES_AT!);
    const nowSeconds = Math.floor(Date.now() / 1000);
    // GHA may spend several minutes queued and provisioning before the first MCP
    // request. Keep the proof valid for that startup window plus the run limit.
    const exp = Math.min(Math.floor(expiresAt / 1000), nowSeconds + Math.max(60, Math.ceil(context.timeoutMs / 1000) + 600));
    if (exp <= nowSeconds) throw new Error('MCP_TEST_EXPIRES_AT lease has expired');
    let jwk: JsonWebKey;
    try { jwk = JSON.parse(this.env.MCP_TEST_RUNNER_PRIVATE_JWK!) as JsonWebKey; } catch { throw new Error('MCP_TEST_RUNNER_PRIVATE_JWK is invalid'); }
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string') throw new Error('MCP test signing key must be an Ed25519 private JWK');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
    const claims = {
      iss: MCP_TEST.issuer, aud: MCP_TEST.audience, sub: context.runId, runId: context.runId,
      userTaskId: context.taskId, profileId: MCP_TEST.profile, principalId: MCP_TEST.principal,
      serverId: MCP_TEST.server, bindingRef: MCP_TEST.binding, allowedTools: [MCP_TEST.tool], scope: MCP_TEST.scope,
      policyVersion: MCP_TEST.policy, catalogueVersion: String(server['catalogueVersion']), registryDigest: MCP_TEST.digest,
      iat: nowSeconds, exp,
    };
    const encode = (value: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(value)));
    const signingInput = `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(signingInput));
    const proof = `${signingInput}.${base64Url(new Uint8Array(signature))}`;
    return {
      mcp: { servers: { [MCP_TEST.server]: { type: 'remote', url: MCP_TEST.url, enabled: true, headers: {
        Authorization: `Bearer {env:${MCP_TEST.tokenEnv}}`,
        'X-MCP-Operation': 'invocation', 'X-MCP-Scope': MCP_TEST.scope,
        'X-MCP-User-Task-Id': context.taskId, 'X-MCP-Profile': context.profileId,
        'X-MCP-Run-Id': context.runId, 'X-MCP-Run-Binding': '{env:RUNNER_MCP_REGISTRY_TEST_PROOF}',
      } } } },
      mcpSecrets: { [MCP_TEST.tokenEnv]: this.env.MCP_TEST_AUTH_TOKEN, RUNNER_MCP_REGISTRY_TEST_PROOF: proof },
    };
  }

  private async userCatalogAttachment(context: { runId: string; taskId: string; profileId: string; ownerGeneration: number; timeoutMs: number }): Promise<Record<string, unknown>> {
    let profileUsers: Record<string, string>;
    let jwk: JsonWebKey;
    try {
      profileUsers = JSON.parse(this.env.MCP_USER_PROFILE_USER_IDS ?? 'null') as Record<string, string>;
      jwk = JSON.parse(this.env.MCP_USER_RUNNER_PRIVATE_JWK ?? 'null') as JsonWebKey;
    } catch { throw new Error('sandbox user catalog signing configuration is invalid'); }
    const userId = profileUsers?.[context.profileId];
    if (typeof userId !== 'string' || !/^[A-Za-z0-9._:@-]{1,200}$/.test(userId) ||
        jwk?.kty !== 'OKP' || jwk?.crv !== 'Ed25519' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string') {
      throw new Error('sandbox user catalog subject or Ed25519 key is unavailable');
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const exp = nowSeconds + Math.ceil(context.timeoutMs / 1000) + 60;
    if (exp - nowSeconds > 7200) throw new Error('sandbox user catalog grant would exceed its maximum lifetime');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
    const claims = {
      iss: MCP_USER.issuer, aud: MCP_USER.audience, sub: context.runId,
      userId, runId: context.runId, userTaskId: context.taskId, profileId: context.profileId,
      ownerGeneration: context.ownerGeneration, serverId: MCP_USER.server,
      bindingRef: MCP_USER.binding, scope: MCP_USER.scope, policyVersion: MCP_USER.policy,
      catalogueVersion: MCP_USER.catalogue, catalogueDigest: MCP_USER.digest,
      allowedTools: MCP_USER.tools, iat: nowSeconds, exp,
    };
    const encode = (value: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(value)));
    const signingInput = `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(signingInput));
    const proof = `${signingInput}.${base64Url(new Uint8Array(signature))}`;
    return {
      mcp: { servers: { [MCP_USER.server]: { type: 'remote', url: MCP_USER.url, enabled: true, headers: {
        Authorization: `Bearer {env:${MCP_USER.tokenEnv}}`,
        'X-MCP-Operation': 'invocation', 'X-MCP-Scope': MCP_USER.scope,
        'X-MCP-User-Task-Id': context.taskId, 'X-MCP-Profile': context.profileId,
        'X-MCP-Run-Id': context.runId, 'X-MCP-Run-Binding': `{env:${MCP_USER.proofEnv}}`,
      } } } },
      mcpSecrets: { [MCP_USER.tokenEnv]: this.env.MCP_USER_AUTH_TOKEN, [MCP_USER.proofEnv]: proof },
    };
  }

  async alarm(): Promise<void> {
    await this.ready;
    const stored = await this.read();
    let changed = false;
    const pendingRuns = Object.values(stored.runs).filter((run) => ACTIVE.has(run.state)
      || run.state === 'unknown' && !!run.workerReceipt && Date.now() - Date.parse(run.updatedAt) < UNKNOWN_RECONCILE_MS)
      .filter((run) => !run.capacityRetryAt || Date.parse(run.capacityRetryAt) <= Date.now());
    for (const run of pendingRuns) {
      try {
        if (run.engine === 'mock-test') {
          const finishedAt = now();
          run.startedAt = run.createdAt;
          run.answer = 'pong';
          run.result = { schemaVersion: 1, runId: run.runId, jobId: run.jobId, userTaskId: run.userTaskId, profileId: run.profileId,
            ownerGeneration: run.ownerGeneration, outcome: 'succeeded', exitReason: 'completed', exitCode: 0, exitSignal: null, exitObserved: true, engineStart: 'started',
            startedAt: run.startedAt, finishedAt, text: 'pong', usage: { status: 'unknown' }, outputRefs: [], persistence: 'not_required',
            persistenceReason: 'mock-test creates no repository or artifacts', cleanup: 'completed', cleanupReason: 'mock-test creates no workspace', logPath: `mock-test://${run.runId}` };
          transition(run, 'succeeded', { engine: 'mock-test' });
          changed = true;
          continue;
        }
        if (run.cancelRequested && !run.workerReceipt) {
          transition(run, 'cancelled', { reason: 'cancelled_before_dispatch' });
          changed = true;
          continue;
        }
        if (run.cancelRequested && run.workerReceipt) await this.worker(run.engine, `/v1/runs/${run.runId}/cancel`, 'POST', {});
        if (!run.workerReceipt) {
          for (;;) {
            run.launchAttempts += 1;
            transition(run, 'starting');
            nextEvent(run, 'run_dispatching', { attempt: run.launchAttempts });
            await this.writeRun(run);
            const launch = JSON.parse(await decrypt(run.launchCiphertext, this.env.RUN_LAUNCH_ENCRYPTION_KEY)) as Record<string, unknown>;
            const response = await this.worker(run.engine, '/v1/launch', 'POST', launch);
            if (!response.ok) {
              const rejection = await response.clone().json().catch(() => null);
              const code = workerRefusalCode(rejection, response.status);
              if ((run.routeMode === 'auto' || !run.routeMode) && run.engine === FRANCE_ENGINE && isConfirmedCapacityRefusal(rejection, response.status) && this.hasGhaWorker()) {
                const engine = launch['engine'] as Record<string, unknown> | undefined;
                if (!engine || engine['name'] !== FRANCE_ENGINE) throw new Error('France launch engine does not match its persisted route');
                launch['engine'] = { ...engine, name: GHA_ENGINE };
                run.engine = GHA_ENGINE;
                run.launchCiphertext = await encrypt(JSON.stringify(launch), this.env.RUN_LAUNCH_ENCRYPTION_KEY);
                run.lastError = 'France refused before admission: WORKER_CAPACITY';
                console.warn(JSON.stringify({ event: 'runner.capacity_fallback', requestId: run.requestId, runId: run.runId,
                  from: FRANCE_ENGINE, to: GHA_ENGINE, routeMode: run.routeMode ?? 'auto', launchAttempt: run.launchAttempts }));
                transition(run, 'queued', { reason: 'capacity_cutover', from: FRANCE_ENGINE, to: GHA_ENGINE, code });
                // Persist route and updated launch before contacting the next worker. A crash
                // after this write resumes against GHA with the same run/operation identity.
                await this.writeRun(run);
                continue;
              }
              if (isConfirmedCapacityRefusal(rejection, response.status)) {
                run.capacityRetryAttempts = (run.capacityRetryAttempts ?? 0) + 1;
                run.capacityQueuedAt ??= now();
                const delay = Math.min(CAPACITY_RETRY_MAX_MS, CAPACITY_RETRY_BASE_MS * 2 ** Math.min(4, run.capacityRetryAttempts - 1));
                run.capacityRetryAt = new Date(Date.now() + delay).toISOString();
                run.lastError = `Worker capacity is full; retry ${run.capacityRetryAttempts} scheduled`;
                transition(run, 'queued', { reason: 'capacity_queued', engine: run.engine, retryAt: run.capacityRetryAt, attempt: run.capacityRetryAttempts });
                console.warn(JSON.stringify({ event: 'runner.capacity_queued', requestId: run.requestId, runId: run.runId,
                  engine: run.engine, routeMode: run.routeMode ?? 'auto', attempt: run.capacityRetryAttempts,
                  retryAt: run.capacityRetryAt, status: response.status, code }));
                changed = true;
                await this.writeRun(run);
                break;
              }
              if (response.status < 500 || response.status === 503) {
                const fields = workerRefusalFields(rejection);
                run.launchRejection = { status: response.status, code, fields };
                run.result = refusedLaunchResult(run);
                transition(run, 'failed', { reason: `worker_rejected_${response.status}`, code, ...(fields.length ? { fields } : {}) });
                run.lastError = `worker launch rejected with HTTP ${response.status}`;
                changed = true;
                break;
              }
              throw new Error(`worker launch HTTP ${response.status}`);
            }
            run.workerReceipt = await response.json() as Record<string, unknown>;
            run.capacityRetryAt = undefined;
            run.capacityRetryAttempts = 0;
            if (run.capacityQueuedAt) {
              run.capacityWaitMs = Date.now() - Date.parse(run.capacityQueuedAt);
              console.info(JSON.stringify({ event: 'runner.capacity_queue_drained', requestId: run.requestId, runId: run.runId,
                engine: run.engine, capacityWaitMs: run.capacityWaitMs }));
              run.capacityQueuedAt = undefined;
            }
            // A 202 receipt proves durable admission only. The next worker status
            // poll must report process state before the run is marked running.
            break;
          }
        } else {
          const statusResponse = await this.worker(run.engine, `/v1/runs/${run.runId}/status`);
          if (!statusResponse.ok) throw new Error(`worker status HTTP ${statusResponse.status}`);
          const workerStatus = await statusResponse.json() as { status?: string; state?: string; startPhase?: string; startAttempts?: number; startedAt?: string; updatedAt?: string };
          run.lastHeartbeatAt = now();
          const phaseChanged = typeof workerStatus.startPhase === 'string' && workerStatus.startPhase !== run.workerStartPhase;
          const attemptsChanged = Number.isSafeInteger(workerStatus.startAttempts) && workerStatus.startAttempts !== run.workerStartAttempts;
          if (typeof workerStatus.startPhase === 'string') run.workerStartPhase = workerStatus.startPhase;
          if (Number.isSafeInteger(workerStatus.startAttempts)) run.workerStartAttempts = workerStatus.startAttempts;
          if (typeof workerStatus.startedAt === 'string') run.workerStartedAt = workerStatus.startedAt;
          if (phaseChanged || attemptsChanged) nextEvent(run, 'opencode_start_phase', {
            phase: run.workerStartPhase ?? null, attempts: run.workerStartAttempts ?? null,
            startedAt: run.workerStartedAt ?? null,
          });
          if (typeof workerStatus.updatedAt === 'string' && Number.isFinite(Date.parse(workerStatus.updatedAt))) {
            const progressChanged = workerStatus.updatedAt !== run.workerReportedUpdatedAt;
            if (progressChanged) {
              run.workerProgressObservedAt = now();
              nextEvent(run, 'worker_progress', { workerUpdatedAt: workerStatus.updatedAt, observedAt: run.workerProgressObservedAt });
            }
            run.workerReportedUpdatedAt = workerStatus.updatedAt;
          }
          const logsResponse = await this.worker(run.engine, `/v1/runs/${run.runId}/logs?after=${run.logCursor ?? 0}&snapshot=1`);
          if (logsResponse.ok) {
            const batch = await logsResponse.json() as { cursor?: number; hasMore?: boolean; logs?: Array<{ sequence?: number; stream?: string; message?: string; truncated?: boolean }> };
            const output = run.output ?? { stdout: '', stderr: '', updatedAt: null, truncated: false };
            let received = false;
            for (const entry of batch.logs ?? []) {
              if ((entry.stream !== 'stdout' && entry.stream !== 'stderr') || typeof entry.message !== 'string'
                || !Number.isSafeInteger(entry.sequence) || Number(entry.sequence) <= (run.logCursor ?? 0)) continue;
              const safeMessage = redactSecrets(entry.message);
              const previous = output[entry.stream];
              output[entry.stream] = `${previous}${previous ? '\n' : ''}${safeMessage}`.slice(-24_000);
              output.truncated ||= entry.truncated === true || previous.length + safeMessage.length > 24_000;
              nextEvent(run, 'opencode_output', { stream: entry.stream, text: safeMessage,
                workerSequence: Number(entry.sequence), truncated: entry.truncated === true });
              run.logCursor = Number(entry.sequence);
              received = true;
            }
            run.logsPending = batch.hasMore === true;
            if (!run.logsPending && Number.isSafeInteger(batch.cursor) && Number(batch.cursor) >= (run.logCursor ?? 0)) run.logCursor = Number(batch.cursor);
            if (received) output.updatedAt = now();
            run.output = output;
          }
          if (workerStatus?.status === 'unknown' || workerStatus?.status === 'unknown_run') {
            // The worker already issued an admission receipt. Its later lack of
            // knowledge is not proof that execution did not start, so a fresh
            // launch could run the task twice. Reconciliation/fencing owns the
            // next decision; the coordinator must preserve this uncertainty.
            transition(run, 'unknown', { reason: 'worker_no_longer_knows_run' });
          } else if (workerStatus.status === 'running' || workerStatus.status === 'accepted') {
            // Some external workers (including the GHA gateway) expose their
            // lifecycle in `status`; VM workers also provide a more detailed
            // `state`. A reported `status: running` is already execution proof.
            const workerReportsProcess = workerStatus.state === 'running' || workerStatus.state === 'finalizing'
              || (workerStatus.state === undefined && workerStatus.status === 'running');
            const observedState: State = workerReportsProcess ? 'running' : 'starting';
            if (run.state !== observedState) transition(run, observedState,
              observedState === 'running' ? { evidence: 'worker_process_state' } : { evidence: 'worker_accepted' });
          } else if (['succeeded', 'failed', 'cancelled'].includes(workerStatus?.status ?? '')) {
            if (!run.workerFinalizingObservedAt) {
              run.workerFinalizingObservedAt = now();
              nextEvent(run, 'run_finalizing', { workerState: workerStatus.status, observedAt: run.workerFinalizingObservedAt });
            }
            const resultResponse = await this.worker(run.engine, `/v1/runs/${run.runId}/result`);
            if (resultResponse.ok) {
              const launchResult = await resultResponse.json() as Record<string, any>;
              const explicitAnswer = typeof launchResult.answer === 'string' && launchResult.answer.trim().length > 0
                ? launchResult.answer : null;
              // Older VM worker releases can return a completed OpenCode stdout
              // without the normalized `answer` checkpoint field. Preserve that
              // captured output as a bounded fallback so the public result does
              // not silently discard a response. Do not treat a truncated stdout
              // buffer as a complete user answer.
              const stdoutAnswer = !launchResult.outputTruncated && typeof launchResult.stdout === 'string'
                && launchResult.stdout.trim().length > 0
                ? launchResult.stdout.trim().slice(0, 100_000) : null;
              run.answer = explicitAnswer ?? stdoutAnswer;
              run.repo = launchResult.repo && typeof launchResult.repo === 'object' ? launchResult.repo as Record<string, unknown> : null;
              run.logUrl = typeof launchResult.logUrl === 'string' && launchResult.logUrl ? launchResult.logUrl : null;
              const repo = run.repo;
              run.artifacts = Array.isArray(launchResult.artifacts) ? launchResult.artifacts.filter((artifact: Record<string, any>) => !run.developerApi || artifact.path !== AGENT_HISTORY_PATH).map((artifact: Record<string, any>) => ({ ...artifact,
                url: repo && typeof repo['fullName'] === 'string' ? `https://github.com/${repo['fullName']}/${typeof repo['commit'] === 'string' && repo['commit'] ? `blob/${repo['commit']}` : `tree/${String(repo['branch'] ?? '')}`}/${String(artifact.path ?? '').split('/').map(encodeURIComponent).join('/')}` : String(artifact.path ?? '') })) : [];
              if (run.developerApi) {
                const history = await this.worker(run.engine, `/v1/runs/${run.runId}/history?manifest=1`);
                if (history.ok) {
                  const manifest = await history.json() as Record<string, unknown>;
                  if (manifest['path'] === AGENT_HISTORY_PATH && manifest['name'] === 'agent-history.json'
                    && manifest['mime'] === 'application/json' && typeof manifest['size'] === 'number'
                    && Number.isSafeInteger(manifest['size']) && manifest['size'] >= 0 && manifest['size'] <= 20 * 1024 * 1024
                    && typeof manifest['sha256'] === 'string' && /^[0-9a-f]{64}$/.test(manifest['sha256'])) {
                    const historyUrl = new URL(`/v1/developer/runs/${run.runId}/artifacts`, this.env.RUNNER_API_PUBLIC_URL);
                    historyUrl.search = new URLSearchParams({ path: AGENT_HISTORY_PATH }).toString();
                    run.artifacts.push({ ...manifest, url: historyUrl.href, downloadUrl: historyUrl.href });
                  }
                }
              }
              if (run.developerGuest) {
                run.artifactExpiresAt = new Date(Date.now() + GUEST_ARTIFACT_TTL_MS).toISOString();
                run.artifacts = await Promise.all(run.artifacts.map(async (artifact) => {
                  const downloadUrl = await guestDownloadUrl(this.env, run, String(artifact['path']));
                  return { ...artifact, url: downloadUrl, downloadUrl, expiresAt: run.artifactExpiresAt };
                }));
              }
              const outcome = launchResult.exitReason === 'completed' ? 'succeeded' : launchResult.exitReason === 'cancelled' ? 'cancelled' : 'failed';
              run.result = { schemaVersion: 1, runId: run.runId, jobId: run.jobId, userTaskId: run.userTaskId, profileId: run.profileId, ownerGeneration: run.ownerGeneration,
                outcome, exitReason: launchResult.exitReason ?? 'worker_crash', exitCode: launchResult.exitCode ?? null, exitSignal: launchResult.exitSignal ?? null,
                engineStart: launchResult.engineStart === 'not_started' || launchResult.engineStart === 'started' ? launchResult.engineStart : 'unknown',
                exitObserved: typeof launchResult.exitObserved === 'boolean' ? launchResult.exitObserved
                  : launchResult.exitCode != null || launchResult.exitSignal != null,
                startedAt: run.startedAt ?? run.createdAt, finishedAt: now(),
                ...(run.answer !== null ? { text: run.answer } : {}), ...(launchResult.failure ? { failure: launchResult.failure } : {}), usage: { status: 'unknown' },
                outputRefs: run.artifacts.map((artifact) => String(run.developerGuest ? artifact['downloadUrl'] : artifact['url'])),
                ...(run.developerApi ? { artifacts: run.artifacts } : {}),
                ...(run.developerGuest ? { artifactExpiresAt: run.artifactExpiresAt } : {}),
                persistence: run.artifacts.length ? 'persisted' : 'not_required', publicationOutcome: launchResult.publicationOutcome ?? (launchResult.failure?.code === 'ARTIFACTS_PUSH_FAILED' ? 'failed' : run.artifacts.length ? 'published' : 'not_requested'), persistenceReason: run.artifacts.length ? run.developerGuest ? 'artifacts were exported by the execution worker' : `artifacts are committed to ${String(repo?.['fullName'] ?? 'the repository')}` : 'the worker reported no artifacts', cleanup: 'completed', cleanupReason: 'execution workspace is owned by the selected worker', logPath: run.logUrl ?? `worker-run:${run.runId}` };
              transition(run, outcome, { exitReason: launchResult.exitReason });
            }
          }
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!run.workerReceipt) {
          try {
            const statusResponse = await this.worker(run.engine, `/v1/runs/${run.runId}/status`);
            const observed = statusResponse.ok ? await statusResponse.json() as { status?: string; state?: string; startPhase?: string; startAttempts?: number; startedAt?: string; updatedAt?: string } : null;
            if (observed?.status && !['unknown', 'unknown_run'].includes(observed.status)) {
              run.workerReceipt = { runId: run.runId, status: 'accepted', operationId: 'reconciled' };
              run.lastHeartbeatAt = now();
              if (typeof observed.startPhase === 'string') run.workerStartPhase = observed.startPhase;
              if (Number.isSafeInteger(observed.startAttempts)) run.workerStartAttempts = observed.startAttempts;
              if (typeof observed.startedAt === 'string') run.workerStartedAt = observed.startedAt;
              if (typeof observed.updatedAt === 'string' && Number.isFinite(Date.parse(observed.updatedAt))) {
                if (observed.updatedAt !== run.workerReportedUpdatedAt) run.workerProgressObservedAt = now();
                run.workerReportedUpdatedAt = observed.updatedAt;
              }
              const observedState = ['succeeded', 'failed', 'cancelled'].includes(observed.status) ? observed.status as State
                : observed.state === 'running' || observed.state === 'finalizing' ? 'running' : 'starting';
              transition(run, observedState, { reconciled: true, evidence: observedState === 'running' ? 'worker_process_state' : 'worker_accepted' });
            } else transition(run, 'unknown', { reason: 'worker_acceptance_could_not_be_confirmed' });
          } catch {
            transition(run, 'unknown', { reason: 'worker_acceptance_could_not_be_confirmed' });
          }
        } else {
          const lastHeartbeat = run.lastHeartbeatAt ? Date.parse(run.lastHeartbeatAt) : Date.parse(run.startedAt ?? run.updatedAt);
          if (Number.isFinite(lastHeartbeat) && Date.now() - lastHeartbeat > 30_000) transition(run, 'unknown', { reason: 'worker_status_stale' });
        }
        run['lastError'] = message.slice(0, 200);
      }
      changed = true;
    }
    if (changed) await Promise.all(pendingRuns.map((run) => this.writeRun(run)));
    const afterPolling = await this.read();
    for (const run of Object.values(afterPolling.runs)) {
      const delivery = run.webhook;
      if (!TERMINAL.has(run.state) || !delivery || delivery.deliveredAt || delivery.exhaustedAt
        || Date.parse(delivery.nextAttemptAt) > Date.now()) continue;
      // Persist an attempt and a future retry before network I/O. A crash after
      // receiver acceptance can cause a duplicate; eventId lets receivers dedupe.
      delivery.attempts += 1;
      delivery.nextAttemptAt = new Date(Date.now() + Math.min(300_000, 5_000 * 2 ** (delivery.attempts - 1))).toISOString();
      await this.writeRun(run);
      try {
        const status = await deliverTerminalWebhook(this.env, delivery, run);
        delivery.lastStatus = status;
        if (status >= 200 && status < 300) {
          delivery.deliveredAt = now();
          delivery.lastError = undefined;
        } else delivery.lastError = `HTTP_${status}`;
      } catch { delivery.lastError = 'delivery_failed'; }
      if (!delivery.deliveredAt && delivery.attempts >= MAX_WEBHOOK_ATTEMPTS) delivery.exhaustedAt = now();
      await this.writeRun(run);
    }
    const latest = await this.read();
    const activeRuns = Object.values(latest.runs).filter((run) => (ACTIVE.has(run.state)
      || run.state === 'unknown' && !!run.workerReceipt && Date.now() - Date.parse(run.updatedAt) < UNKNOWN_RECONCILE_MS)
      && (!run.capacityRetryAt || Date.parse(run.capacityRetryAt) <= Date.now()));
    const activeNext = activeRuns.length
      ? Date.now() + (activeRuns.some((run) => run.logsPending) ? 100 : activeRuns.some((run) => (this.liveSubscribers.get(run.runId) ?? 0) > 0) ? 1_000 : 5_000)
      : Infinity;
    const capacityRetryNext = Object.values(latest.runs).reduce((next, run) => {
      if (!ACTIVE.has(run.state) || !run.capacityRetryAt) return next;
      const dueAt = Date.parse(run.capacityRetryAt);
      return Number.isFinite(dueAt) ? Math.min(next, dueAt) : next;
    }, Infinity);
    let webhookNext = Infinity;
    for (const run of Object.values(latest.runs)) {
      if (TERMINAL.has(run.state) && run.webhook && !run.webhook.deliveredAt && !run.webhook.exhaustedAt) {
        const dueAt = Date.parse(run.webhook.nextAttemptAt);
        webhookNext = Math.min(webhookNext, Number.isFinite(dueAt) ? dueAt : Date.now() + 5_000);
      }
    }
    const nextAlarm = Math.min(activeNext, capacityRetryNext, webhookNext);
    if (Number.isFinite(nextAlarm)) await this.state.storage.setAlarm(Math.max(Date.now() + 100, nextAlarm));
  }

  private hasGhaWorker(): boolean {
    const token = this.env.GHA_WORKER_TOKEN?.trim() ?? '';
    try {
      const url = new URL(this.env.GHA_WORKER_URL?.trim() ?? '');
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash && token.length >= 24;
    } catch { return false; }
  }

  private async worker(engine: string, path: string, method = 'GET', body?: unknown, timeoutMs = 8_000): Promise<Response> {
    const route = engine === FRANCE_ENGINE
      ? { base: this.env.VM_WORKER_URL, token: this.env.VM_WORKER_TOKEN }
      : engine === GHA_ENGINE
        ? { base: this.env.GHA_WORKER_URL, token: this.env.GHA_WORKER_TOKEN }
        : null;
    if (!route) throw new Error(`worker route is not supported for ${engine}`);
    const { base: baseValue, token } = route;
    if (!baseValue || !token) throw new Error(`worker route is not configured for ${engine}`);
    const base = baseValue.replace(/\/+$/, '');
    if (!/^https:\/\//.test(base)) throw new Error(`worker URL must be an https origin for ${engine}`);
    const send = this.env.FETCH ?? fetch;
    return send(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
  }

  private async read(): Promise<Stored> { return await this.state.storage.get<Stored>(stateKey) ?? structuredClone(INIT); }
  private async writeRun(run: RunRecord): Promise<void> {
    await this.state.storage.transaction(async (tx) => {
      const stored = await tx.get<Stored>(stateKey) ?? structuredClone(INIT);
      const latest = stored.runs[run.runId];
      if (!latest) return;
      stored.runs[run.runId] = { ...run, cancelRequested: run.cancelRequested || latest.cancelRequested };
      await tx.put(stateKey, stored);
    });
    this.signalRunChanged(run.runId);
  }
}

function owns(run: RunRecord, principal: ApiPrincipal): boolean { return run.principalId === principal.principalId && run.profileId === principal.profileId && run.tenantId === principal.tenantId; }
function clampInteger(value: unknown, fallback: number, min: number, max: number): number { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback; }
async function digest(value: string): Promise<string> { const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function runtimeEnv(env: RunnerWorkerEnv, names: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = (env as unknown as Record<string, unknown>)[name];
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}

function retrievableLogUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'storage.googleapis.com' ? url.href : null;
  } catch {
    return null;
  }
}

function validModelConnection(value: unknown): value is ModelConnection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).every((key) => ['connectionId', 'principalId', 'profileId', 'tenantId', 'provider', 'model', 'secretBinding'].includes(key))
    && typeof entry['connectionId'] === 'string' && SAFE_ID.test(entry['connectionId'])
    && typeof entry['principalId'] === 'string' && entry['principalId'].length > 0
    && typeof entry['profileId'] === 'string' && entry['profileId'].length > 0
    && (entry['tenantId'] === undefined || typeof entry['tenantId'] === 'string' && entry['tenantId'].length > 0)
    && entry['provider'] === 'openai'
    && typeof entry['model'] === 'string' && /^openai\/[A-Za-z0-9._:-]{1,100}$/.test(entry['model'])
    && typeof entry['secretBinding'] === 'string' && /^RUNNER_MODEL_SECRET_[A-Z0-9_]{1,80}$/.test(entry['secretBinding']);
}

async function encryptionKey(raw: string): Promise<CryptoKey> {
  if (!raw || raw.length < 32) throw new Error('RUN_LAUNCH_ENCRYPTION_KEY must contain at least 32 characters');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(plain: string, rawKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(rawKey), new TextEncoder().encode(plain));
  return `${base64(iv)}.${base64(new Uint8Array(cipher))}`;
}

async function decrypt(value: string, rawKey: string): Promise<string> {
  const [iv, cipher] = value.split('.');
  if (!iv || !cipher) throw new Error('encrypted launch record is malformed');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) as BufferSource }, await encryptionKey(rawKey), fromBase64(cipher) as BufferSource);
  return new TextDecoder().decode(plain);
}

function base64(bytes: Uint8Array): string { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function fromBase64(value: string): Uint8Array { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
function base64Url(bytes: Uint8Array): string { return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }

