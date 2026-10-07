import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { LaunchArtifact, LaunchRequest, LaunchResult, WorkerRunStatus } from '../adapters/external-worker-adapter.js';
import { isEnvName, isSafeId } from '../contracts/validate.js';
import type { RunSpec } from '../contracts/run-spec.js';
import { Runner } from '../runner/runner.js';
import { isTerminalState } from '../runner/state-machine.js';
import type { CapacityAdmission, CapacityEnvelope, CapacityReservationStore, HostUsageSampler } from './capacity-admission.js';
import { redactSecrets } from '../redact.js';
import { checkVmWorkerBindings, type VmWorkerBindingsInventory } from './bindings-inventory.js';
import type { VmWorkerBuildInfo } from './build-info.js';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const WORKER_ENGINES = new Set(['eu-vm-agent-run', 'rf-vm-agent-run']);

export interface VmWorkerServerOptions {
  runner: Runner;
  capacity: CapacityAdmission;
  capacityStore: CapacityReservationStore;
  sampler: HostUsageSampler;
  engineName: string;
  baseUrl: string;
  token: string;
  dataDir: string;
  allowedRepositories: readonly string[];
  allowedEnvironmentNames: readonly string[];
  allowedCallbackOrigins: readonly string[];
  envelope: CapacityEnvelope;
  buildInfo?: VmWorkerBuildInfo;
  bindingsInventory?: VmWorkerBindingsInventory;
  engineAvailable?: () => boolean;
}

export interface VmWorkerServer extends Server {
  resumeCapacityMonitors(): Promise<number>;
}

/** Create the installable VM worker HTTP surface consumed by ExternalWorkerAdapter. */
export function createVmWorkerServer(options: VmWorkerServerOptions): VmWorkerServer {
  validateOptions(options);
  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${JSON.stringify({ event: 'vm_worker_request_failed', message: redactSecrets(message).slice(0, 300) })}\n`);
      sendJson(res, 500, { error: 'INTERNAL', message: 'worker request failed' });
    });
  }) as VmWorkerServer;

  server.resumeCapacityMonitors = async () => {
    const active = await options.capacityStore.withTransaction(async (tx) => tx.list().filter((entry) => entry.active));
    let resumed = 0;
    for (const reservation of active) {
      if (!options.runner.getRun(reservation.runId)) continue; // fail closed; operator reconciliation is required
      observeProcessTreeExit(options, reservation.operationId, reservation.runId);
      resumed += 1;
    }
    return resumed;
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://worker.local');
    if (url.pathname === '/healthz' && method === 'GET') {
      sendJson(res, 200, { status: 'ok', service: 'ai-agent-vm-worker' });
      return;
    }
    if (url.pathname === '/version' && method === 'GET') {
      const bindings = options.bindingsInventory
        ? checkVmWorkerBindings(options.bindingsInventory, process.env)
        : { ready: true, bindings: [], missingRequired: [], warnings: [] };
      sendJson(res, 200, {
        service: 'ai-agent-vm-worker',
        build: options.buildInfo ?? { schemaVersion: 1, version: '0.0.0-dev', sourceCommit: 'unknown', builtAt: new Date(0).toISOString() },
        worker: options.bindingsInventory ? { workerId: options.bindingsInventory.workerId, region: options.bindingsInventory.region } : null,
        bindings: { ready: bindings.ready, missingRequired: bindings.missingRequired, warnings: bindings.warnings, inventory: bindings.bindings },
      });
      return;
    }
    if (url.pathname === '/readyz' && method === 'GET') {
      const readiness = await readinessView(options);
      sendJson(res, readiness.ready ? 200 : 503, readiness);
      return;
    }
    if (!authorized(req, options.token)) {
      sendJson(res, 401, { error: 'UNAUTHENTICATED', message: 'a valid worker Bearer token is required' });
      return;
    }
    if (url.pathname === '/v1/launch' && method === 'POST') {
      let raw: unknown;
      try { raw = await readJson(req); } catch (error) {
        sendJson(res, 400, { error: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'invalid request body' });
        return;
      }
      const parsed = parseLaunchRequest(raw, options);
      if (!parsed.ok) { sendJson(res, 400, { error: 'INVALID_REQUEST', details: parsed.errors }); return; }
      const request = parsed.value;
      if (request.profileWorkspace && options.runner.supportsProfileWorkspace?.() !== true) {
        sendJson(res, 501, { accepted: false, code: 'WORKER_PROFILE_WORKSPACE_UNSUPPORTED' });
        return;
      }
      if (request.profileWorkspace?.savebackUrl && options.runner.supportsProfileSaveback?.() !== true) {
        sendJson(res, 501, { accepted: false, code: 'WORKER_PROFILE_WORKSPACE_UNSUPPORTED' });
        return;
      }
      const spec = toRunSpec(request, options);
      const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      const admission = await options.capacity.start<LaunchReceiptLike>({
        operationId: request.operationId,
        runId: request.runId,
        engineName: 'opencode',
        requestFingerprint: fingerprint,
        envelope: options.envelope,
        start: async () => {
          options.runner.start(spec, request.operationId, request.env);
          const receipt = makeReceipt(request, options.baseUrl);
          return { receipt, processTreeExited: waitUntilTerminal(options.runner, request.runId) };
        },
      });
      if (!admission.accepted) {
        sendJson(res, 503, {
          accepted: false,
          code: admission.code,
          ...('cpuPercent' in admission && admission.cpuPercent !== undefined ? { cpuPercent: admission.cpuPercent } : {}),
          ...('memoryPercent' in admission && admission.memoryPercent !== undefined ? { memoryPercent: admission.memoryPercent } : {}),
          ...('sampledAt' in admission && admission.sampledAt !== undefined ? { sampledAt: admission.sampledAt } : {}),
        });
        return;
      }
      if (admission.duplicate) observeProcessTreeExit(options, request.operationId, request.runId);
      sendJson(res, 202, admission.receipt);
      return;
    }

    const runPath = /^\/v1\/runs\/([^/]+)(?:\/(status|result|cancel|logs))?$/.exec(url.pathname);
    if (!runPath) { sendJson(res, 404, { error: 'NOT_FOUND' }); return; }
    let runId: string;
    try { runId = decodeURIComponent(runPath[1]!); } catch { sendJson(res, 400, { error: 'INVALID_REQUEST' }); return; }
    if (!isSafeId(runId)) { sendJson(res, 400, { error: 'INVALID_REQUEST' }); return; }
    const endpoint = runPath[2] ?? 'status';
    const snapshot = options.runner.getRun(runId);
    if (endpoint === 'status' && method === 'GET') {
      const status: WorkerRunStatus = snapshot ? stateToWorkerStatus(snapshot.state) : 'unknown';
      sendJson(res, 200, { runId, status, ...(snapshot ? { updatedAt: snapshot.updatedAt } : {}) });
      return;
    }
    if (!snapshot) { sendJson(res, endpoint === 'result' ? 404 : 200, endpoint === 'result' ? { error: 'NOT_FOUND' } : { runId, status: 'unknown_run' }); return; }
    if (endpoint === 'result' && method === 'GET') {
      const result = toLaunchResult(options, snapshot);
      if (!result) { sendJson(res, 409, { error: 'RESULT_NOT_READY' }); return; }
      sendJson(res, 200, result);
      return;
    }
    if (endpoint === 'cancel' && method === 'POST') {
      const receipt = await options.runner.cancel(runId, snapshot.ownerGeneration);
      sendJson(res, 200, receipt);
      return;
    }
    if (endpoint === 'logs' && method === 'GET') {
      await streamLogs(req, res, options.runner, runId, Number(url.searchParams.get('after') ?? '0'));
      return;
    }
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  }

  return server;
}

interface LaunchReceiptLike { runId: string; operationId: string; status: 'accepted'; statusUrl: string; resultUrl: string }

function makeReceipt(request: LaunchRequest, baseUrl: string): LaunchReceiptLike {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = `/v1/runs/${encodeURIComponent(request.runId)}`;
  return { runId: request.runId, operationId: request.operationId, status: 'accepted', statusUrl: `${base}${suffix}/status`, resultUrl: `${base}${suffix}/result` };
}

function toRunSpec(request: LaunchRequest, options: VmWorkerServerOptions): RunSpec {
  const repo = request.repository.fullName;
  const token = request.profileWorkspace?.savebackUrl ? undefined : request.publicationToken ?? process.env['RUNNER_GIT_TOKEN'];
  return {
    contractVersion: 1,
    jobId: request.jobId,
    runId: request.runId,
    operationId: request.operationId,
    userTaskId: request.userTaskId,
    profileId: request.profileId,
    conversationId: request.conversationId,
    ownerGeneration: request.ownerGeneration,
    engine: { name: 'opencode', adapterVersion: request.engine.adapterVersion, ...(request.engine.modelSettings ? { modelSettings: request.engine.modelSettings } : {}) },
    cwd: join(options.dataDir, 'workspaces', request.runId),
    envAllowlist: [...request.envAllowlist],
    limits: { timeoutMs: request.limits.timeoutMs, maxOutputBytes: request.limits.maxOutputBytes, maxLogBytes: request.limits.maxLogBytes },
    input: { inlinePrompt: request.input.inlinePrompt },
    isolation: { mode: request.isolation.mode as NonNullable<RunSpec['isolation']>['mode'] },
    repository: { fullName: repo, ...(request.repository.revision ? { revision: request.repository.revision } : {}), ...(token ? { token } : {}) },
    ...(request.profileWorkspace ? { profileWorkspace: request.profileWorkspace } : {}),
    ...(request.ingressManifest ? { ingressManifest: request.ingressManifest } : {}),
    ...(request.outputs ? { outputs: request.outputs.map((output) => ({ ...output })) } : {}),
  };
}

function parseLaunchRequest(value: unknown, options: VmWorkerServerOptions): { ok: true; value: LaunchRequest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['body must be an object'] };
  const requiredStrings = ['runId', 'jobId', 'userTaskId', 'profileId', 'conversationId', 'operationId', 'resultUrl'] as const;
  for (const key of requiredStrings) if (typeof value[key] !== 'string' || !value[key]) errors.push(`${key} is required`);
  if (!isSafeId(value['runId'])) errors.push('runId is invalid');
  if (!isSafeId(value['jobId'])) errors.push('jobId is invalid');
  if (!isSafeId(value['operationId'])) errors.push('operationId is invalid');
  if (!isRecord(value['engine']) || value['engine']['name'] !== options.engineName || typeof value['engine']['adapterVersion'] !== 'string') errors.push('engine does not match this worker');
  if (options.engineName === 'rf-vm-agent-run' && isRecord(value['engine']) && isRecord(value['engine']['modelSettings'])
    && typeof value['engine']['modelSettings']['model'] === 'string'
    && /(?:claude|codex)/i.test(value['engine']['modelSettings']['model'])) errors.push('Russia worker policy forbids Claude and Codex models');
  if (!isRecord(value['input']) || typeof value['input']['inlinePrompt'] !== 'string' || value['input']['inlinePrompt'].length === 0) errors.push('input.inlinePrompt is required');
  if (!isRecord(value['limits']) || !positiveInt(value['limits']['timeoutMs']) || !positiveInt(value['limits']['maxOutputBytes']) || !positiveInt(value['limits']['maxLogBytes'])) errors.push('limits are invalid');
  if (!Array.isArray(value['envAllowlist']) || value['envAllowlist'].some((name) => typeof name !== 'string' || !isEnvName(name) || !options.allowedEnvironmentNames.includes(name))) errors.push('envAllowlist contains an unapproved variable');
  if (!isRecord(value['env'])) errors.push('env must be an object');
  else for (const [key, envValue] of Object.entries(value['env'])) {
    if (!value['envAllowlist']?.includes(key) || typeof envValue !== 'string' || envValue.length > 100_000) errors.push(`env.${key} is invalid or not allowed`);
  }
  if (!isRecord(value['repository']) || typeof value['repository']['fullName'] !== 'string' || typeof value['repository']['branch'] !== 'string') errors.push('repository is invalid');
  else if (!options.allowedRepositories.includes(value['repository']['fullName'])) errors.push('repository is not approved on this host');
  if (!isRecord(value['isolation']) || typeof value['isolation']['mode'] !== 'string') errors.push('isolation is invalid');
  else if (value['isolation']['mode'] !== 'none') errors.push('this VM worker build only supports isolation.mode=none; per-run Unix identities are not provisioned');
  if (typeof value['cwd'] !== 'string') errors.push('cwd is required'); // validated, then deliberately ignored; host chooses the actual path
  if (typeof value['resultUrl'] === 'string' && !validCallbackUrl(value['resultUrl'], String(value['runId']), options.allowedCallbackOrigins)) errors.push('resultUrl is not an approved central API callback URL');
  if (isRecord(value['profileWorkspace']) && value['profileWorkspace']['savebackUrl'] !== undefined
    && (typeof value['profileWorkspace']['savebackUrl'] !== 'string' || !validSavebackUrl(value['profileWorkspace']['savebackUrl'], String(value['runId']), options.allowedCallbackOrigins))) {
    errors.push('profileWorkspace.savebackUrl is not an approved central API saveback URL');
  }
  if (typeof value['repository'] === 'object' && value['repository'] !== null && typeof (value['repository'] as Record<string, unknown>)['branch'] === 'string'
    && (value['repository'] as Record<string, unknown>)['branch'] !== `agent-run/${String(value['runId'])}`) errors.push('repository.branch must be the run-scoped branch');
  if (value['ingressManifest'] !== undefined) {
    const pin = value['ingressManifest'];
    if (!isRecord(pin) || pin['contractVersion'] !== 1 || typeof pin['manifestRef'] !== 'string' || !pin['manifestRef']
      || typeof pin['manifestVersion'] !== 'string' || !/^[0-9a-f]{64}$/.test(pin['manifestVersion'])
      || pin['userTaskId'] !== value['userTaskId'] || pin['profileId'] !== value['profileId']
      || pin['runId'] !== value['runId'] || pin['ownerGeneration'] !== value['ownerGeneration']) {
      errors.push('ingressManifest must be pinned to this run, task, profile, and owner generation');
    }
  }
  if (Array.isArray(value['outputs']) && value['outputs'].length > 100) errors.push('outputs exceeds the supported limit');
  if (value['outputs'] !== undefined && (!Array.isArray(value['outputs']) || value['outputs'].some((entry) => !isRecord(entry) || typeof entry['path'] !== 'string'))) errors.push('outputs is invalid');
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: value as unknown as LaunchRequest };
}

function validCallbackUrl(raw: string, runId: string, allowedOrigins: readonly string[]): boolean {
  try {
    const url = new URL(raw);
    return allowedOrigins.includes(url.origin)
      && isSecureOrLoopback(url)
      && !url.username && !url.password && !url.search && !url.hash
      && hasRunBoundCallbackPath(url.pathname, runId, 'result');
  } catch { return false; }
}

function validSavebackUrl(raw: string, runId: string, allowedOrigins: readonly string[]): boolean {
  try {
    const url = new URL(raw);
    return allowedOrigins.includes(url.origin) && isSecureOrLoopback(url)
      && !url.username && !url.password && !url.search && !url.hash
      && hasRunBoundCallbackPath(url.pathname, runId, 'profile-changes');
  } catch { return false; }
}

/** Accept an optional reverse-proxy base path, while keeping the endpoint suffix exact and run-bound. */
function hasRunBoundCallbackPath(pathname: string, runId: string, endpoint: 'result' | 'profile-changes'): boolean {
  const suffix = `/v1/worker/launches/${encodeURIComponent(runId)}/${endpoint}`;
  return pathname.endsWith(suffix);
}

function isSecureOrLoopback(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}

function stateToWorkerStatus(state: string): WorkerRunStatus {
  if (state === 'queued') return 'accepted';
  if (state === 'starting' || state === 'running' || state === 'finalizing') return 'running';
  if (state === 'succeeded' || state === 'failed' || state === 'cancelled') return state;
  return 'unknown';
}

function toLaunchResult(options: VmWorkerServerOptions, snapshot: NonNullable<ReturnType<Runner['getRun']>>): LaunchResult | null {
  const result = snapshot.result;
  if (!result) return null;
  const spec = options.runner.getRunSpec(snapshot.runId);
  const events = options.runner.events(snapshot.runId);
  let stdout = '';
  let stderr = '';
  for (const event of events) {
    if (event.type !== 'log') continue;
    if (event.payload.stream === 'stdout') stdout += `${stdout ? '\n' : ''}${event.payload.message}`;
    else if (event.payload.stream === 'stderr') stderr += `${stderr ? '\n' : ''}${event.payload.message}`;
  }
  const checkpoint = snapshot.checkpoint;
  const manifest = options.runner.exportManifest(snapshot.runId);
  const artifacts: LaunchArtifact[] = manifest?.entries
    .filter((entry) => entry.status === 'exported' && entry.sha256 && entry.artifactId)
    .map((entry) => ({ path: entry.sourcePath, name: entry.name, mime: entry.mime, sha256: entry.sha256!, size: entry.size })) ?? [];
  const started = Date.parse(result.startedAt);
  const finished = Date.parse(result.finishedAt);
  const launch: LaunchResult = {
    runId: snapshot.runId,
    status: result.exitObserved ? 'started' : 'failed',
    ...(snapshot.pid ? { pid: snapshot.pid } : { pid: null }),
    exitCode: result.exitCode,
    exitSignal: result.exitSignal,
    exitReason: result.exitReason,
    stdout,
    stderr,
    answer: checkpoint?.answer.text ?? null,
    answerSource: checkpoint?.answer.source ?? null,
    durationMs: Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0,
    timedOut: result.exitReason === 'timeout',
    outputTruncated: stdout.length + stderr.length >= (spec?.limits.maxOutputBytes ?? 1_000_000),
    artifacts,
    logUrl: `local://runs/${encodeURIComponent(snapshot.runId)}/logs`,
    repo: { fullName: spec?.repository?.fullName ?? '', branch: `agent-run/${snapshot.runId}`, commit: options.runner.profileWorkspaceCommit?.(snapshot.runId) ?? null },
    ...(result.failure ? { failure: { ...result.failure } } : {}),
    ...(result.profileChanges ? { profileChanges: result.profileChanges } : {}),
    ...(!result.profileChanges && result.persistence === 'failed' && spec?.profileWorkspace?.savebackUrl ? {
      failure: { code: 'ARTIFACTS_PUSH_FAILED', failureClass: 'finalization' as const, safeSummary: 'profile saveback upload failed; the VM retained the run workspace', retryable: true },
    } : {}),
  };
  return launch;
}

function observeProcessTreeExit(options: VmWorkerServerOptions, operationId: string, runId: string): void {
  void waitUntilTerminal(options.runner, runId).then(() => options.capacityStore.withTransaction(async (tx) => tx.release(operationId))).catch(() => undefined);
}

async function waitUntilTerminal(runner: Runner, runId: string): Promise<void> {
  for (;;) {
    const snapshot = runner.getRun(runId);
    if (snapshot && isTerminalState(snapshot.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function streamLogs(req: IncomingMessage, res: ServerResponse, runner: Runner, runId: string, after: number): Promise<void> {
  if (!Number.isSafeInteger(after) || after < 0) { sendJson(res, 400, { error: 'INVALID_CURSOR' }); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  let cursor = after;
  let closed = false;
  res.on('close', () => { closed = true; });
  while (!closed) {
    const events = runner.events(runId, cursor);
    for (const event of events) {
      cursor = Math.max(cursor, event.sequence);
      if (event.type !== 'log') continue;
      const stream = event.payload.stream;
      if (stream !== 'stdout' && stream !== 'stderr') continue;
      res.write(`id: ${event.sequence}\nevent: ${stream}\ndata: ${JSON.stringify(event.payload.message)}\n\n`);
    }
    const snapshot = runner.getRun(runId);
    if (!snapshot || isTerminalState(snapshot.state)) { res.write(`id: ${cursor + 1}\nevent: end\ndata: {}\n\n`); break; }
    res.write(': keepalive\n\n');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  res.end();
}

async function readinessView(options: VmWorkerServerOptions): Promise<{ status: string; service: string; ready: boolean; checks: Record<string, unknown> }> {
  let storeReady = false;
  let activeReservations = 0;
  let capacity: Record<string, unknown> = { state: 'unknown' };
  try {
    activeReservations = await options.capacityStore.withTransaction(async (tx) => tx.list().filter((item) => item.active).length);
    storeReady = true;
  } catch { /* fail closed */ }
  try {
    const sample = await options.sampler.sample();
    const sampledAgeMs = Date.now() - Date.parse(sample.sampledAt);
    const projectedCpuPercent = sample.cpuPercent + activeReservations * options.envelope.cpuPercent + options.envelope.cpuPercent;
    const projectedMemoryPercent = sample.memoryPercent + activeReservations * options.envelope.memoryPercent + options.envelope.memoryPercent;
    const state = sampledAgeMs >= 0 && sampledAgeMs <= 5_000
      ? (sample.cpuPercent >= 60 || sample.memoryPercent >= 60 || projectedCpuPercent >= 60 || projectedMemoryPercent >= 60 ? 'saturated' : 'available')
      : 'unknown';
    capacity = { state, cpuPercent: sample.cpuPercent, memoryPercent: sample.memoryPercent, projectedCpuPercent, projectedMemoryPercent, sampledAt: sample.sampledAt, activeReservations };
  } catch { capacity = { state: 'unknown', activeReservations }; }
  const runner = options.runner.health();
  const engineReady = options.engineAvailable?.() ?? true;
  const bindings = options.bindingsInventory
    ? checkVmWorkerBindings(options.bindingsInventory, process.env)
    : { ready: true, bindings: [], missingRequired: [], warnings: [] };
  const checks = { runner: runner.ready, engine: engineReady, capacityStore: storeReady, capacity, bindings, activeRuns: runner.activeRuns, runs: runner.runs };
  const capacityState = typeof capacity['state'] === 'string' ? capacity['state'] : 'unknown';
  const ready = runner.ready && engineReady && storeReady && capacityState === 'available' && bindings.ready;
  return { status: ready ? 'ready' : 'not_ready', service: 'ai-agent-vm-worker', ready, checks };
}

function validateOptions(options: VmWorkerServerOptions): void {
  if (!WORKER_ENGINES.has(options.engineName)) throw new Error('VM worker engine must be eu-vm-agent-run or rf-vm-agent-run');
  if (!options.token || options.token.length < 24) throw new Error('VM_WORKER_TOKEN must contain at least 24 characters');
  const base = new URL(options.baseUrl);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.username || base.password || base.search || base.hash) throw new Error('VM worker public base URL must be an HTTPS origin without credentials, path, query, or fragment');
  if (!options.allowedRepositories.length) throw new Error('at least one trusted repository must be configured');
  if (!options.allowedEnvironmentNames.every(isEnvName)) throw new Error('allowed environment names must be valid environment identifiers');
  if (!options.allowedCallbackOrigins.length) throw new Error('at least one central callback origin must be configured');
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const presented = Buffer.from(match[1]!, 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('request body exceeds the configured limit');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown; } catch { throw new Error('request body must be valid JSON'); }
}

async function sendJson(res: ServerResponse, status: number, value: unknown): Promise<void> {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function positiveInt(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
