import type { ApiPrincipal, DurableObjectStateLike, RunnerWorkerEnv } from './types.js';
import { DEFAULT_ENGINE, SAFE_ID, error, json } from './runner-api.js';

type State = 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
interface RunRecord {
  requestId: string; runId: string; userTaskId: string; conversationId: string; jobId: string;
  ownerGeneration: number;
  principalId: string; profileId: string; tenantId?: string; idempotencyKey: string; payloadHash: string;
  engine: string; state: State; sequence: number; createdAt: string; updatedAt: string; startedAt: string | null;
  finishedAt: string | null; answer: string | null; cancelRequested: boolean; launchCiphertext: string;
  launchAttempts: number; result?: Record<string, unknown>; workerReceipt?: Record<string, unknown>;
  launchRejection?: { status: number; code: string };
  lastError?: string;
  artifacts: Array<Record<string, unknown>>; repo: Record<string, unknown> | null; logUrl: string | null;
  events: Array<Record<string, unknown>>;
}
interface Stored { runs: Record<string, RunRecord>; idempotency: Record<string, string>; latestOwnerGeneration: number; requestId?: string; jobId?: string }

const INIT: Stored = { runs: {}, idempotency: {}, latestOwnerGeneration: 0 };
const ACTIVE = new Set<State>(['queued', 'starting', 'running']);
const TERMINAL = new Set<State>(['succeeded', 'failed', 'cancelled']);
const now = (): string => new Date().toISOString();
const stateKey = 'runner-v1';
const MCP_TEST = Object.freeze({
  profile: 'integration-telegram-ux-v1', principal: 'integration-telegram-ux-v1',
  server: 'trained-assist-registry-test', binding: 'registry-mcp-test-160-read',
  tool: 'registry.fixture_read', scope: 'registry:fixture-read', policy: 'registry-fixture-policy-v1',
  audience: 'trained-assist:registry-mcp:test', issuer: 'trained-assist-agent-runner',
  url: 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp',
  digest: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9',
  tokenEnv: 'RUNNER_MCP_REGISTRY_TEST',
});

function principalOf(request: Request): ApiPrincipal | null {
  try { return JSON.parse(request.headers.get('x-runner-principal') ?? 'null') as ApiPrincipal | null; } catch { return null; }
}

function view(run: RunRecord): Record<string, unknown> {
  return { requestId: run.requestId, userTaskId: run.userTaskId, conversationId: run.conversationId, runId: run.runId,
    ownerGeneration: run.ownerGeneration, state: run.state, engine: run.engine, cancelRequested: run.cancelRequested, connectionLost: run.state === 'unknown',
    observedAt: run.updatedAt, sequence: run.sequence, fencing: { rejected: 0 }, answer: run.answer };
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

function refusedLaunchResult(run: RunRecord): Record<string, unknown> {
  const status = run.launchRejection?.status ?? Number(run.lastError?.match(/HTTP (4\d\d)/)?.[1] ?? 400);
  const code = run.launchRejection?.code ?? 'WORKER_LAUNCH_REJECTED';
  return {
    schemaVersion: 1, runId: run.runId, jobId: run.jobId, userTaskId: run.userTaskId,
    profileId: run.profileId, ownerGeneration: run.ownerGeneration, outcome: 'failed',
    exitReason: 'preflight_refused', exitCode: null, exitSignal: null, exitObserved: false,
    startedAt: run.startedAt ?? run.createdAt, finishedAt: run.finishedAt ?? now(),
    failure: { code: code.startsWith('WORKER_') ? code : `WORKER_${code}`, failureClass: 'preflight',
      safeSummary: `The France execution worker refused the run before accepting it (HTTP ${status}, ${code}).`, retryable: false },
    usage: { status: 'unknown' }, outputRefs: [], persistence: 'not_required',
    persistenceReason: 'The execution worker did not accept the run; there is nothing to persist.',
    cleanup: 'completed', cleanupReason: 'No execution receipt was issued by the worker.',
    logPath: `runner-api://worker-launch-refusal/${run.runId}`,
  };
}

function nextEvent(run: RunRecord, type: string, payload: unknown = {}): void {
  run.sequence += 1;
  run.updatedAt = now();
  run.events.push({ eventId: `runner-${run.runId}-${run.sequence}`, runId: run.runId, jobId: run.jobId,
    userTaskId: run.userTaskId, profileId: run.profileId, ownerGeneration: run.ownerGeneration, sequence: run.sequence,
    timestamp: run.updatedAt, type, payload });
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

  constructor(state: DurableObjectStateLike, env: RunnerWorkerEnv) {
    this.state = state;
    this.env = env;
    this.ready = state.blockConcurrencyWhile(async () => { if (!(await state.storage.get<Stored>(stateKey))) await state.storage.put(stateKey, INIT); });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const principal = principalOf(request);
    if (!principal) return error('UNAUTHENTICATED', 'authenticated principal missing', 401);
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
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
        const cursor = Math.max(0, Number(url.searchParams.get('cursor') ?? 0) || 0);
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 500) || 500));
        const events = run.events.filter((event) => Number(event['sequence']) > cursor).slice(0, limit);
        return json({ runId, events, cursor: events.at(-1)?.['sequence'] ?? cursor, hasMore: false,
          snapshot: { state: run.state, connectionLost: run.state === 'unknown', sequence: run.sequence, ownerGeneration: run.ownerGeneration }, droppedEvents: 0, logUrl: run.logUrl });
      }
      case 'artifacts':
        if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'artifacts supports GET only', 405);
        return json({ runId, conversationId: run.conversationId, userTaskId: run.userTaskId, repo: run.repo, branchUrl: null, mergeUrl: null, count: run.artifacts.length, artifacts: run.artifacts, logUrl: run.logUrl, note: run.artifacts.length ? 'artifacts are committed by the VM worker to the run branch' : 'the VM worker reported no artifacts' });
      case 'cancel': return request.method === 'POST' ? this.cancel(request, runId, principal) : error('METHOD_NOT_ALLOWED', 'cancel supports POST only', 405);
      default: return error('ROUTE_NOT_FOUND', `no route for ${url.pathname}`, 404);
    }
  }

  private async submit(request: Request, principal: ApiPrincipal): Promise<Response> {
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
    const allowedFields = new Set(['userTaskId', 'conversationId', 'engine', 'input', 'ingressManifest', 'envAllowlist', 'limits', 'deadline', 'regionConstraints', 'credentialBindings', 'mcp', 'budget', 'result', 'outputs', 'traceId', 'instructions', 'repository', 'isolation']);
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
    if (Array.isArray(body.input?.refs) && body.input.refs.length) return error('INPUT_REFS_UNSUPPORTED', 'input refs need a durable workspace and are not supported by this Worker API yet', 422);
    const mcp = body.mcp?.servers?.length ? body.mcp.servers : [];
    if (!Array.isArray(mcp) || mcp.length > 1) return error('MCP_HOST_POLICY_MISSING', 'only the pinned test Registry MCP server is supported by this Worker API', 422);
    if (mcp.length === 1) {
      const server = mcp[0];
      const fields = ['serverId', 'transport', 'url', 'bindingRef', 'allowedTools', 'policyVersion', 'catalogueVersion'];
      if (!server || typeof server !== 'object' || Object.keys(server).some((field) => !fields.includes(field)) ||
          principal.profileId !== MCP_TEST.profile || principal.principalId !== MCP_TEST.principal ||
          !principal.mcpBindings?.includes(MCP_TEST.binding) || server.serverId !== MCP_TEST.server ||
          server.transport !== 'remote' || server.url !== MCP_TEST.url || server.bindingRef !== MCP_TEST.binding ||
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
    }
    if (body.profileWorkspace || body.ingressManifest || body.credentialBindings?.length) return error('FEATURE_UNSUPPORTED', 'profile workspace, ingress manifests, and credential bindings are not supported by this Worker API yet', 422);
    if (body.isolation !== undefined && body.isolation?.mode !== 'none') return error('ISOLATION_UNSUPPORTED', 'the France VM worker currently supports isolation.mode=none only', 422);
    if (body.regionConstraints?.allowedRegions && !body.regionConstraints.allowedRegions.includes('eu')) return error('REGION_UNAVAILABLE', 'this Runner API only dispatches to the France EU worker', 422);
    const engine = typeof body.engine?.name === 'string' ? body.engine.name : (this.env.RUNNER_ENGINE || DEFAULT_ENGINE);
    const mockTest = engine === 'mock-test';
    if ((engine !== (this.env.RUNNER_ENGINE || DEFAULT_ENGINE) && !(mockTest && this.env.MOCK_TEST_ENABLED === 'true')) || (principal.engines && !principal.engines.includes(engine))) return error('FORBIDDEN', 'requested engine is not allowed for this key', 403);
    const allowedRepositories = new Set(this.env.ALLOWED_REPOSITORIES.split(',').map((item) => item.trim()).filter(Boolean));
    const requestedRepository = body.repository?.fullName;
    if (principal.repository && requestedRepository && requestedRepository !== principal.repository) return error('REPOSITORY_BINDING_MISMATCH', 'request repository does not match the authenticated profile binding', 403);
    if (!mockTest && !principal.repository) return error('SERVER_MISCONFIGURED', 'authenticated profile has no repository binding', 503);
    const repository = mockTest ? '' : principal.repository!;
    if (repository && !allowedRepositories.has(repository)) return error('INVALID_REPOSITORY', 'repository is not approved on this Runner API', 400);
    if (body.repository?.token !== undefined && (typeof body.repository.token !== 'string' || body.repository.token.length > 500)) return error('INVALID_REQUEST', 'repository.token is invalid', 400);
    const requestedEnv = Array.isArray(body.envAllowlist) ? body.envAllowlist : [];
    const allowedEnv = new Set((this.env.ALLOWED_ENVIRONMENT_NAMES ?? '').split(',').map((item) => item.trim()).filter(Boolean));
    if (requestedEnv.some((name: unknown) => typeof name !== 'string' || !allowedEnv.has(name))) return error('FORBIDDEN', 'envAllowlist requests a name not approved for this Runner API', 403);
    const envAllowlist = requestedEnv as string[];
    const launchEnv = runtimeEnv(this.env, envAllowlist);
    if (envAllowlist.some((name) => !launchEnv[name])) return error('SERVER_MISCONFIGURED', 'an approved runtime environment secret is missing', 503);
    const idemKey = `${principal.principalId}\0${key}`;
    const hashInput = structuredClone(body);
    if (hashInput.repository && typeof hashInput.repository === 'object') delete hashInput.repository.token;
    const payloadHash = await digest(canonicalJson(hashInput));
    let record!: RunRecord;
    let deduplicated = false;
    let conflict = false;
    await this.state.storage.transaction(async (tx) => {
      const stored = await tx.get<Stored>(stateKey) ?? structuredClone(INIT);
      const expiration = Date.now() - 24 * 60 * 60 * 1000;
      for (const [oldRunId, oldRun] of Object.entries(stored.runs)) {
        if (TERMINAL.has(oldRun.state) && oldRun.finishedAt && Date.parse(oldRun.finishedAt) < expiration) {
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
      const taskHash = await digest(`${principal.principalId}\0${principal.profileId}\0${taskId}`);
      const runId = `run_${taskHash}_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const requestId = prior?.requestId ?? stored.requestId ?? `req_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const time = now();
      const jobId = prior?.jobId ?? stored.jobId ?? `job_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const resultUrl = `${this.env.RUNNER_API_PUBLIC_URL.replace(/\/+$/, '')}/v1/runs/${runId}/result`;
      const limits = body.limits;
      const launch = { runId, jobId, userTaskId: taskId, profileId: principal.profileId, conversationId, operationId: `op_${await digest(`${taskId}:${ownerGeneration}`).then((h) => h.slice(0, 24))}`,
          ownerGeneration, engine: { name: engine, adapterVersion: body.engine?.adapterVersion ?? '1', ...(body.engine?.modelSettings?.model ? { modelSettings: { model: body.engine.modelSettings.model } } : {}) },
          input: { inlinePrompt: `${typeof inputPrompt === 'string' ? inputPrompt : ''}${instructions ? `${inputPrompt ? '\n\nAdditional instructions: ' : ''}${instructions}` : ''}` }, cwd: `/tmp/runner/${runId}`, envAllowlist, env: launchEnv, limits: { timeoutMs: clampInteger(limits.timeoutMs, 300_000, 1_000, 86_400_000), maxOutputBytes: clampInteger(limits.maxOutputBytes, 5_000_000, 1, 100_000_000), maxLogBytes: clampInteger(limits.maxLogBytes, 5_000_000, 1, 100_000_000) },
          repository: { fullName: repository ?? '', branch: `agent-run/${runId}`, ...(body.repository?.revision ? { revision: body.repository.revision } : {}) },
          ...(typeof body.repository?.token === 'string' ? { publicationToken: body.repository.token } : {}),
          resultUrl, isolation: body.isolation ?? { mode: 'none' }, outputs: Array.isArray(body.outputs) ? body.outputs : [],
          ...(mcp.length ? { mcp: await this.testRegistryAttachment(mcp[0], { runId, taskId, profileId: principal.profileId, timeoutMs: clampInteger(limits.timeoutMs, 300_000, 1_000, 86_400_000) }) } : {}) };
      record = { requestId, runId, userTaskId: taskId, conversationId, jobId, ownerGeneration, principalId: principal.principalId, profileId: principal.profileId,
        ...(principal.tenantId ? { tenantId: principal.tenantId } : {}), idempotencyKey: idemKey, payloadHash, engine, state: 'queued', sequence: 0,
        createdAt: time, updatedAt: time, startedAt: null, finishedAt: null, answer: null, cancelRequested: false, launchAttempts: 0, events: [], artifacts: [], repo: null, logUrl: null, launchCiphertext: await encrypt(JSON.stringify(launch), this.env.RUN_LAUNCH_ENCRYPTION_KEY) };
      nextEvent(record, 'run_queued');
      stored.runs[runId] = record;
      stored.idempotency[idemKey] = runId;
      stored.latestOwnerGeneration = ownerGeneration;
      stored.requestId = requestId;
      stored.jobId = jobId;
      await tx.put(stateKey, stored);
    });
    if (conflict) return error(record && ACTIVE.has(record.state) ? 'TASK_ATTEMPT_ACTIVE' : 'IDEMPOTENCY_CONFLICT', record && ACTIVE.has(record.state) ? `task ${record.userTaskId} already has an active attempt` : 'the same Idempotency-Key was already used with a different request', 409, record && ACTIVE.has(record.state) ? { runId: record.runId, state: record.state } : undefined);
    if (!deduplicated) await this.state.storage.setAlarm(Date.now() + 100);
    if (!record!) return error('INTERNAL', 'run could not be admitted', 500);
    if (deduplicated) return json({ requestId: record.requestId, userTaskId: record.userTaskId, runId: record.runId, deduplicated: true }, 200);
    return json({ requestId: record.requestId, userTaskId: record.userTaskId, runId: record.runId, deduplicated: false }, 202);
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
      run.updatedAt = now();
      stored.runs[runId] = run;
      await tx.put(stateKey, stored);
    });
    if (failure) return failure;
    if (!run) return error('NOT_FOUND', `unknown run ${runId}`, 404);
    if (TERMINAL.has(run.state)) return json({ runId, status: 'already_terminal', state: run.state });
    if (run.workerReceipt) await this.worker(`/v1/runs/${runId}/cancel`, 'POST', {});
    await this.state.storage.setAlarm(Date.now() + 100);
    return json({ runId, status: run.workerReceipt ? 'stop_pending' : 'stopped', state: run.state }, run.workerReceipt ? 202 : 200);
  }

  private async testRegistryAttachment(server: Record<string, unknown>, context: { runId: string; taskId: string; profileId: string; timeoutMs: number }): Promise<Record<string, unknown>> {
    const expiresAt = Date.parse(this.env.MCP_TEST_EXPIRES_AT!);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const exp = Math.min(Math.floor(expiresAt / 1000), nowSeconds + Math.max(60, Math.ceil(context.timeoutMs / 1000) + 60));
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
      servers: { [MCP_TEST.server]: { type: 'remote', url: MCP_TEST.url, enabled: true, headers: {
        Authorization: `Bearer ${this.env.MCP_TEST_AUTH_TOKEN}`,
        'X-MCP-Operation': 'invocation', 'X-MCP-Scope': MCP_TEST.scope,
        'X-MCP-User-Task-Id': context.taskId, 'X-MCP-Profile': context.profileId,
        'X-MCP-Run-Id': context.runId, 'X-MCP-Run-Binding': proof,
      } } },
      mcpSecrets: { [MCP_TEST.tokenEnv]: this.env.MCP_TEST_AUTH_TOKEN },
    };
  }

  async alarm(): Promise<void> {
    await this.ready;
    const stored = await this.read();
    let changed = false;
    const pendingRuns = Object.values(stored.runs).filter((run) => ACTIVE.has(run.state));
    for (const run of pendingRuns) {
      try {
        if (run.engine === 'mock-test') {
          const finishedAt = now();
          run.startedAt = run.createdAt;
          run.answer = 'pong';
          run.result = { schemaVersion: 1, runId: run.runId, jobId: run.jobId, userTaskId: run.userTaskId, profileId: run.profileId,
            ownerGeneration: run.ownerGeneration, outcome: 'succeeded', exitReason: 'completed', exitCode: 0, exitSignal: null, exitObserved: true,
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
        if (run.cancelRequested && run.workerReceipt) await this.worker(`/v1/runs/${run.runId}/cancel`, 'POST', {});
        if (!run.workerReceipt) {
          run.launchAttempts += 1;
          transition(run, 'starting');
          const launch = JSON.parse(await decrypt(run.launchCiphertext, this.env.RUN_LAUNCH_ENCRYPTION_KEY)) as Record<string, unknown>;
          const response = await this.worker('/v1/launch', 'POST', launch);
          if (!response.ok) {
            if (response.status < 500 || response.status === 503) {
              const rejection = await response.clone().json().catch(() => null);
              const code = workerRefusalCode(rejection, response.status);
              run.launchRejection = { status: response.status, code };
              run.result = refusedLaunchResult(run);
              transition(run, 'failed', { reason: `worker_rejected_${response.status}`, code });
              run.lastError = `worker launch rejected with HTTP ${response.status}`;
              changed = true;
              continue;
            }
            throw new Error(`worker launch HTTP ${response.status}`);
          }
          run.workerReceipt = await response.json() as Record<string, unknown>;
          transition(run, 'running');
        } else {
          const statusResponse = await this.worker(`/v1/runs/${run.runId}/status`);
          const workerStatus = statusResponse.ok ? await statusResponse.json() as { status?: string } : null;
          if (workerStatus?.status === 'unknown' || workerStatus?.status === 'unknown_run') {
            if (run.launchAttempts < 3) { run.workerReceipt = undefined; run.state = 'queued'; }
            else transition(run, 'unknown', { reason: 'worker_no_longer_knows_run' });
          } else if (workerStatus?.status === 'running' || workerStatus?.status === 'accepted') {
            if (run.state !== 'running') transition(run, 'running');
          } else if (['succeeded', 'failed', 'cancelled'].includes(workerStatus?.status ?? '')) {
            const resultResponse = await this.worker(`/v1/runs/${run.runId}/result`);
            if (resultResponse.ok) {
              const launchResult = await resultResponse.json() as Record<string, any>;
              run.answer = typeof launchResult.answer === 'string' ? launchResult.answer : null;
              run.repo = launchResult.repo && typeof launchResult.repo === 'object' ? launchResult.repo as Record<string, unknown> : null;
              run.logUrl = typeof launchResult.logUrl === 'string' && launchResult.logUrl ? launchResult.logUrl : null;
              const repo = run.repo;
              run.artifacts = Array.isArray(launchResult.artifacts) ? launchResult.artifacts.map((artifact: Record<string, any>) => ({ ...artifact,
                url: repo && typeof repo['fullName'] === 'string' ? `https://github.com/${repo['fullName']}/${typeof repo['commit'] === 'string' && repo['commit'] ? `blob/${repo['commit']}` : `tree/${String(repo['branch'] ?? '')}`}/${String(artifact.path ?? '').split('/').map(encodeURIComponent).join('/')}` : String(artifact.path ?? '') })) : [];
              const outcome = launchResult.exitReason === 'completed' ? 'succeeded' : launchResult.exitReason === 'cancelled' ? 'cancelled' : 'failed';
              run.result = { schemaVersion: 1, runId: run.runId, jobId: run.jobId, userTaskId: run.userTaskId, profileId: run.profileId, ownerGeneration: run.ownerGeneration,
                outcome, exitReason: launchResult.exitReason ?? 'worker_crash', exitCode: launchResult.exitCode ?? null, exitSignal: launchResult.exitSignal ?? null,
                exitObserved: launchResult.exitCode != null || launchResult.exitSignal != null, startedAt: run.startedAt ?? run.createdAt, finishedAt: now(),
                ...(run.answer !== null ? { text: run.answer } : {}), ...(launchResult.failure ? { failure: launchResult.failure } : {}), usage: { status: 'unknown' },
                outputRefs: run.artifacts.map((artifact) => String(artifact['url'])), persistence: run.artifacts.length ? 'persisted' : 'not_required', persistenceReason: run.artifacts.length ? `artifacts are committed to ${String(repo?.['fullName'] ?? 'the repository')}` : 'the worker reported no artifacts', cleanup: 'completed', cleanupReason: 'execution workspace is owned by the France VM worker', logPath: run.logUrl ?? `vm-run:${run.runId}` };
              transition(run, outcome, { exitReason: launchResult.exitReason });
            }
          }
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!run.workerReceipt) {
          try {
            const statusResponse = await this.worker(`/v1/runs/${run.runId}/status`);
            const observed = statusResponse.ok ? await statusResponse.json() as { status?: string } : null;
            if (observed?.status && !['unknown', 'unknown_run'].includes(observed.status)) {
              run.workerReceipt = { runId: run.runId, status: 'accepted', operationId: 'reconciled' };
              transition(run, ['succeeded', 'failed', 'cancelled'].includes(observed.status) ? observed.status as State : 'running', { reconciled: true });
            } else if (run.launchAttempts >= 5) transition(run, 'unknown', { reason: 'worker_acceptance_could_not_be_confirmed' });
            else { run.state = 'queued'; run.updatedAt = now(); }
          } catch {
            if (run.launchAttempts >= 5) transition(run, 'unknown', { reason: 'worker_acceptance_could_not_be_confirmed' });
            else { run.state = 'queued'; run.updatedAt = now(); }
          }
        } else { run.state = 'running'; run.updatedAt = now(); }
        run['lastError'] = message.slice(0, 200);
      }
      changed = true;
    }
    if (changed) await Promise.all(pendingRuns.map((run) => this.writeRun(run)));
    if (Object.values(stored.runs).some((run) => ACTIVE.has(run.state))) await this.state.storage.setAlarm(Date.now() + 5_000);
  }

  private async worker(path: string, method = 'GET', body?: unknown): Promise<Response> {
    const base = this.env.VM_WORKER_URL.replace(/\/+$/, '');
    if (!/^https:\/\//.test(base)) throw new Error('VM_WORKER_URL must be an https origin');
    const send = this.env.FETCH ?? fetch;
    return send(`${base}${path}`, { method, headers: { authorization: `Bearer ${this.env.VM_WORKER_TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8_000) });
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

