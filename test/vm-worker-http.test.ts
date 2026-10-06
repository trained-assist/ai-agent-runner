import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LaunchRequest } from '../src/adapters/external-worker-adapter.js';
import { CapacityAdmission, type HostUsageSample, type HostUsageSampler } from '../src/vm-worker/capacity-admission.js';
import { FileCapacityReservationStore } from '../src/vm-worker/file-capacity-reservation-store.js';
import { createVmWorkerServer } from '../src/vm-worker/http-server.js';
import type { VmWorkerBindingsInventory } from '../src/vm-worker/bindings-inventory.js';
import type { Runner } from '../src/runner/runner.js';
import type { RunSpec } from '../src/contracts/run-spec.js';

const TOKEN = 'vm-worker-test-secret-that-is-long-enough';
const API_ORIGIN = 'https://api.example.test';
const RUN_ID = 'run-vm-worker-test';

describe('installable VM HTTP worker', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  it('authenticates the central API, ignores caller cwd, returns durable-style receipt/status/result and replayable logs', async () => {
    const fixture = await startFixture({ engineName: 'eu-vm-agent-run' });
    cleanups.push(fixture.close);
    const live = await fetch(`${fixture.base}/healthz`);
    expect(live.status).toBe(200);
    expect((await live.json() as { service: string }).service).toBe('ai-agent-vm-worker');
    const ready = await fetch(`${fixture.base}/readyz`);
    expect(ready.status).toBe(200);
    expect((await ready.json() as { checks: { capacity: { state: string } } }).checks.capacity.state).toBe('available');

    const unauthenticated = await fetch(`${fixture.base}/v1/launch`, { method: 'POST', body: JSON.stringify(launchRequest()) });
    expect(unauthenticated.status).toBe(401);

    const request = launchRequest();
    const accepted = await launch(fixture.base, request);
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json() as Record<string, unknown>;
    expect(receipt).toMatchObject({ runId: RUN_ID, operationId: request.operationId, status: 'accepted' });
    expect(receipt.statusUrl).toBe(`https://worker.example.test/v1/runs/${RUN_ID}/status`);
    expect(fixture.runner.startCalls).toHaveLength(1);
    expect(fixture.runner.startCalls[0]!.spec.engine.name).toBe('opencode');
    expect(fixture.runner.startCalls[0]!.spec.cwd).toBe(join(fixture.dataDir, 'workspaces', RUN_ID));
    expect(fixture.runner.startCalls[0]!.spec.cwd).not.toBe(request.cwd);
    expect(fixture.runner.startCalls[0]!.runtimeEnv).toEqual({ LLM_LADDER_TOKEN: 'request-only-test-secret' });

    const duplicate = await launch(fixture.base, request);
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual(receipt);
    expect(fixture.runner.startCalls).toHaveLength(1);

    const sse = await fetch(`${fixture.base}/v1/runs/${RUN_ID}/logs?after=0`, { headers: authHeaders() });
    const stream = await sse.text();
    expect(sse.status).toBe(200);
    expect(stream).toContain('event: stdout');
    expect(stream).toContain('worker says hello');
    expect(stream).toContain('event: stderr');

    const status = await fetch(`${fixture.base}/v1/runs/${RUN_ID}/status`, { headers: authHeaders() });
    expect(await status.json()).toMatchObject({ runId: RUN_ID, status: 'succeeded' });
    const resultResponse = await fetch(`${fixture.base}/v1/runs/${RUN_ID}/result`, { headers: authHeaders() });
    const result = await resultResponse.json();
    expect(resultResponse.status).toBe(200);
    expect(result).toMatchObject({ runId: RUN_ID, status: 'started', stdout: 'worker says hello', repo: { branch: `agent-run/${RUN_ID}`, commit: null } });
  });

  it('refuses a saturated host before Runner.start with the exact capacity code', async () => {
    const fixture = await startFixture({ cpuPercent: 60 });
    cleanups.push(fixture.close);
    const response = await launch(fixture.base, launchRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ accepted: false, code: 'WORKER_CAPACITY' });
    expect(fixture.runner.startCalls).toHaveLength(0);
  });

  it('enforces Russia OpenCode policy and central callback origin before admission', async () => {
    const fixture = await startFixture({ engineName: 'rf-vm-agent-run' });
    cleanups.push(fixture.close);
    const claude = launchRequest({ engine: { name: 'rf-vm-agent-run', adapterVersion: '1', modelSettings: { model: 'claude-3.7' } } });
    const deniedModel = await launch(fixture.base, claude);
    expect(deniedModel.status).toBe(400);
    expect((await deniedModel.json() as { details: string[] }).details).toContain('Russia worker policy forbids Claude and Codex models');

    const badCallback = launchRequest({ resultUrl: 'https://attacker.example/steal' });
    const deniedCallback = await launch(fixture.base, badCallback);
    expect(deniedCallback.status).toBe(400);
    expect(fixture.runner.startCalls).toHaveLength(0);
  });

  it('reports unknown runs without inventing a receipt and rejects a disallowed repository', async () => {
    const fixture = await startFixture({ engineName: 'eu-vm-agent-run' });
    cleanups.push(fixture.close);
    const unknown = await fetch(`${fixture.base}/v1/runs/not-accepted/status`, { headers: authHeaders() });
    expect(await unknown.json()).toMatchObject({ runId: 'not-accepted', status: 'unknown' });
    const denied = await launch(fixture.base, launchRequest({ repository: { fullName: 'someone/else', branch: `agent-run/${RUN_ID}` } }));
    expect(denied.status).toBe(400);
    expect(fixture.runner.startCalls).toHaveLength(0);
  });

  it('exposes build identity and a value-free binding inventory for deployment drift checks', async () => {
    const envName = 'VM_WORKER_TEST_ONLY_BINDING';
    const prior = process.env[envName];
    process.env[envName] = 'never-return-this-secret';
    const inventory: VmWorkerBindingsInventory = {
      schemaVersion: 1,
      workerId: 'eu-test-worker',
      region: 'eu',
      bindings: [{ name: envName, required: true, secret: true, source: 'systemd:/etc/ai-agent-runner/worker.env', owner: 'platform' }],
    };
    const fixture = await startFixture({ bindingsInventory: inventory });
    cleanups.push(async () => {
      if (prior === undefined) delete process.env[envName]; else process.env[envName] = prior;
      await fixture.close();
    });
    const version = await (await fetch(`${fixture.base}/version`)).json() as any;
    expect(version.build.sourceCommit).toBe('a'.repeat(40));
    expect(version.worker).toEqual({ workerId: 'eu-test-worker', region: 'eu' });
    expect(version.bindings.inventory).toEqual([{ ...inventory.bindings[0], configured: true }]);
    expect(JSON.stringify(version)).not.toContain('never-return-this-secret');
    expect((await (await fetch(`${fixture.base}/readyz`)).json() as any).checks.bindings.ready).toBe(true);
  });
});

function launchRequest(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    runId: RUN_ID,
    jobId: 'job-vm-worker-test',
    userTaskId: 'task-vm-worker-test',
    profileId: 'profile-test',
    conversationId: 'conversation-test',
    operationId: 'operation-vm-worker-test',
    ownerGeneration: 1,
    engine: { name: 'eu-vm-agent-run', adapterVersion: '1', modelSettings: { model: 'opencode/free' } },
    input: { inlinePrompt: 'only emit a small marker' },
    cwd: '/untrusted/requested/workspace',
    envAllowlist: ['LLM_LADDER_TOKEN'],
    env: { LLM_LADDER_TOKEN: 'request-only-test-secret' },
    limits: { timeoutMs: 10_000, maxOutputBytes: 1024, maxLogBytes: 1024 },
    repository: { fullName: 'trained-assist/ai-agent-runner', branch: `agent-run/${RUN_ID}` },
    resultUrl: `${API_ORIGIN}/v1/worker/launches/${RUN_ID}/result`,
    isolation: { mode: 'none' },
    ...overrides,
  };
}

function authHeaders(): Record<string, string> { return { authorization: `Bearer ${TOKEN}` }; }

async function launch(base: string, request: LaunchRequest): Promise<Response> {
  return fetch(`${base}/v1/launch`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(request) });
}

async function startFixture(input: { engineName?: string; cpuPercent?: number; bindingsInventory?: VmWorkerBindingsInventory } = {}): Promise<{
  base: string;
  dataDir: string;
  runner: FakeRunner;
  close: () => Promise<void>;
}> {
  const parent = mkdtempSync(join(tmpdir(), 'vm-worker-http-test-'));
  chmodSync(parent, 0o700);
  const dataDir = parent;
  mkdirSync(join(dataDir, 'capacity'), { mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const store = new FileCapacityReservationStore(join(dataDir, 'capacity', 'reservations.json'));
  const runner = new FakeRunner(dataDir);
  const sampler: HostUsageSampler = { sample: async (): Promise<HostUsageSample> => ({ cpuPercent: input.cpuPercent ?? 5, memoryPercent: 10, sampledAt: new Date().toISOString() }) };
  const capacity = new CapacityAdmission({ sampler, store });
  const server = createVmWorkerServer({
    runner: runner as unknown as Runner,
    capacity,
    capacityStore: store,
    sampler,
    engineName: input.engineName ?? 'eu-vm-agent-run',
    baseUrl: 'https://worker.example.test',
    token: TOKEN,
    dataDir,
    allowedRepositories: ['trained-assist/ai-agent-runner'],
    allowedEnvironmentNames: ['LLM_LADDER_TOKEN'],
    allowedCallbackOrigins: [API_ORIGIN],
    envelope: { cpuPercent: 10, memoryPercent: 10 },
    buildInfo: { schemaVersion: 1, version: '0.1.0-test', sourceCommit: 'a'.repeat(40), builtAt: new Date().toISOString() },
    ...(input.bindingsInventory ? { bindingsInventory: input.bindingsInventory } : {}),
    engineAvailable: () => true,
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    dataDir,
    runner,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runner.dispose();
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

class FakeRunner {
  readonly startCalls: Array<{ spec: RunSpec; operationId: string; runtimeEnv: Record<string, string> }> = [];
  private state = 'queued';
  private spec: RunSpec | null = null;
  private snapshot: Record<string, any> | null = null;
  private readonly eventList: Array<Record<string, any>> = [];
  private readonly dataDir: string;

  constructor(dataDir: string) { this.dataDir = dataDir; }

  start(spec: RunSpec, operationId: string, runtimeEnv: Record<string, string>): void {
    this.startCalls.push({ spec, operationId, runtimeEnv });
    this.spec = spec;
    this.state = 'running';
    const at = new Date().toISOString();
    this.eventList.push({ type: 'log', sequence: 10, payload: { stream: 'stdout', message: 'worker says hello' } });
    this.eventList.push({ type: 'log', sequence: 11, payload: { stream: 'stderr', message: 'diagnostic' } });
    this.snapshot = { runId: spec.runId, state: 'running', updatedAt: at, ownerGeneration: spec.ownerGeneration, pid: 1234, result: null, checkpoint: null };
    setTimeout(() => {
      this.state = 'succeeded';
      this.snapshot!.state = 'succeeded';
      this.snapshot!.updatedAt = new Date().toISOString();
      this.snapshot!.result = {
        schemaVersion: 1, runId: spec.runId, jobId: spec.jobId, userTaskId: spec.userTaskId, profileId: spec.profileId,
        ownerGeneration: spec.ownerGeneration, outcome: 'succeeded', exitReason: 'completed', exitCode: 0, exitSignal: null,
        exitObserved: true, startedAt: at, finishedAt: new Date().toISOString(), usage: { status: 'unknown' }, outputRefs: [],
        persistence: 'not_required', cleanup: 'completed', cleanupReason: 'cleaned', logPath: 'runs/test/events.jsonl',
      };
      this.snapshot!.checkpoint = { answer: { text: 'worker says hello', source: 'engine_stdout' } };
    }, 60);
  }

  getRun(runId: string): Record<string, any> | null { return this.snapshot?.runId === runId ? this.snapshot : null; }
  getRunSpec(runId: string): RunSpec | null { return this.snapshot?.runId === runId ? this.spec : null; }
  events(runId: string, after = 0): Array<Record<string, any>> { return this.snapshot?.runId === runId ? this.eventList.filter((event) => event.sequence > after) : []; }
  exportManifest(): null { return null; }
  health(): { ready: boolean; droppedLogCount: number; activeRuns: number; runs: number } { return { ready: true, droppedLogCount: 0, activeRuns: this.state === 'running' ? 1 : 0, runs: this.snapshot ? 1 : 0 }; }
  cancel(runId: string): { runId: string; status: 'stopped'; state: 'cancelled' } { this.state = 'cancelled'; return { runId, status: 'stopped', state: 'cancelled' }; }
  dispose(): void { void this.dataDir; }
}
