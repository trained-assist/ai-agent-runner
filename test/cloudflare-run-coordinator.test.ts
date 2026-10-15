import { describe, expect, it } from 'vitest';
import { RunnerRunCoordinator } from '../src/cloudflare/run-coordinator.js';
import runnerWorker from '../src/cloudflare/runner-api.js';
import type { ApiPrincipal, DurableObjectStateLike, DurableStorage, RunnerWorkerEnv } from '../src/cloudflare/types.js';
import { createHash, createHmac, generateKeyPairSync, verify } from 'node:crypto';

class MemoryStorage implements DurableStorage {
  values = new Map<string, unknown>();
  alarmAt: number | Date | null = null;
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async setAlarm(value: number | Date): Promise<void> { this.alarmAt = value; }
  async getAlarm(): Promise<number | null> { return this.alarmAt === null ? null : Number(this.alarmAt); }
  async deleteAlarm(): Promise<void> { this.alarmAt = null; }
  async transaction<T>(callback: (transaction: DurableStorage) => Promise<T>): Promise<T> { return callback(this); }
}

const principal: ApiPrincipal = { principalId: 'principal-a', profileId: 'profile-a', repository: 'trained-assist/ai-agent-runner', scopes: ['runs:read', 'runs:write'], keyHash: 'a'.repeat(64) };

function setup() {
  const storage = new MemoryStorage();
  const launched: Record<string, unknown>[] = [];
  let poll = 0;
  const state: DurableObjectStateLike = { storage, blockConcurrencyWhile: async (fn) => fn() };
  const env: RunnerWorkerEnv = {
    RUNNER_API_KEYS: '[]', VM_WORKER_URL: 'https://france.example', VM_WORKER_TOKEN: 'worker-secret',
    RUNNER_API_PUBLIC_URL: 'https://runner-api.example', RUN_LAUNCH_ENCRYPTION_KEY: 'encryption-key-long-enough-for-test-only',
    RUNNER_ENGINE: 'eu-vm-agent-run',
    ALLOWED_REPOSITORIES: 'trained-assist/ai-agent-runner,team/profile-one', ALLOWED_ENVIRONMENT_NAMES: '', RUNNER_RUNS: {} as RunnerWorkerEnv['RUNNER_RUNS'],
    FETCH: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/v1/launch') {
        launched.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ runId: launched.at(-1)?.['runId'], operationId: 'op-test', status: 'accepted', statusUrl: 'https://france.example/status', resultUrl: 'https://france.example/result' }, { status: 202 });
      }
      if (url.pathname.endsWith('/status')) {
        const status = ++poll === 1 ? 'running' : 'succeeded';
        return Response.json({ status, state: status });
      }
      if (url.pathname.endsWith('/logs')) {
        const after = Number(url.searchParams.get('after') ?? 0);
        const logs = [{ sequence: 1, stream: 'stdout', message: 'step 1: inspect' }, { sequence: 2, stream: 'stderr', message: 'progress warning' }].filter((entry) => entry.sequence > after);
        return Response.json({ runId: url.pathname.split('/').at(-2), cursor: logs.at(-1)?.sequence ?? after, hasMore: false, state: 'running', logs });
      }
      if (url.pathname.endsWith('/result')) return Response.json({ exitReason: 'completed', exitCode: 0, exitSignal: null, answer: 'done', artifacts: [], logUrl: '', repo: null });
      return Response.json({ status: 'cancelled' });
    },
  };
  const coordinator = new RunnerRunCoordinator(state, env);
  return { coordinator, storage, launched, env };
}

function call(path: string, body?: unknown, headers: Record<string, string> = {}, actingPrincipal: ApiPrincipal = principal): Request {
  return new Request(`https://runner-runs.internal${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-runner-principal': JSON.stringify(actingPrincipal), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

const body = { userTaskId: 'task-a', input: { inlinePrompt: 'say done' }, envAllowlist: [], limits: { timeoutMs: 300_000 } };
const testMcp = { servers: [{ serverId: 'trained-assist-registry-test', transport: 'remote', url: 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp', bindingRef: 'registry-mcp-test-160-read', allowedTools: ['registry.fixture_read'], policyVersion: 'registry-fixture-policy-v1', catalogueVersion: 'registry-fixture-catalogue-v1' }] };
const userMcp = { servers: [{ serverId: 'mem-gpt', transport: 'remote', url: 'https://trained-assist-mcp-user-sandbox.skillset-apply.workers.dev/mcp', bindingRef: 'mem-gpt-user-sandbox', allowedTools: ['identity.whoami', 'google_docs.connect', 'google_docs.get_document'], policyVersion: 'mem-gpt-user-run-v1', catalogueVersion: 'mem-gpt-user-catalogue-v1' }] };

describe('Cloudflare Runner run coordinator', () => {
  it('lists only active metadata for one task and enforces principal ownership', async () => {
    const { coordinator, storage } = setup();
    const submitted = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'scoped-active-list' }));
    expect(submitted.status).toBe(202);
    const receipt = await submitted.json() as { runId: string };

    const response = await coordinator.fetch(call('/v1/runs?userTaskId=task-a&state=active'));
    expect(response.status).toBe(200);
    const page = await response.json() as { runs: Array<Record<string, unknown>>; nextCursor: string | null };
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]).toMatchObject({ runId: receipt.runId, userTaskId: 'task-a' });
    expect(page.runs[0]).not.toHaveProperty('answer');
    expect(page.runs[0]).not.toHaveProperty('events');
    expect(page.nextCursor).toBeNull();

    const foreign = await coordinator.fetch(call('/v1/runs?userTaskId=task-a&state=active', undefined, {}, {
      ...principal, principalId: 'principal-b', keyHash: 'b'.repeat(64),
    }));
    expect((await foreign.json() as { runs: unknown[] }).runs).toEqual([]);

    const stored = storage.values.get('runner-v1') as { runs: Record<string, { state: string }> };
    stored.runs[receipt.runId]!.state = 'succeeded';
    expect((await (await coordinator.fetch(call('/v1/runs?userTaskId=task-a&state=active'))).json() as { runs: unknown[] }).runs).toEqual([]);
    const allStates = await coordinator.fetch(call('/v1/runs?userTaskId=task-a&state=all'));
    expect((await allStates.json() as { runs: Array<Record<string, unknown>> }).runs).toMatchObject([{ runId: receipt.runId, state: 'succeeded' }]);
  });

  it('cleans terminal task state and refuses active, unknown, or foreign runs', async () => {
    const { coordinator, storage } = setup();
    const submitted = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'cleanup-terminal' }));
    expect(submitted.status).toBe(202);
    const receipt = await submitted.json() as { runId: string };
    const active = await coordinator.fetch(call('/v1/sandbox/cleanup-task', { userTaskId: body.userTaskId }));
    expect(active.status).toBe(409);

    const stored = storage.values.get('runner-v1') as { runs: Record<string, { state: string }> };
    stored.runs[receipt.runId]!.state = 'succeeded';
    const cleaned = await coordinator.fetch(call('/v1/sandbox/cleanup-task', { userTaskId: body.userTaskId }));
    expect(cleaned.status).toBe(200);
    expect(await cleaned.json()).toMatchObject({ status: 'cleaned', deletedRuns: 1 });
    expect(storage.values.has('runner-v1')).toBe(false);
    expect(storage.alarmAt).toBeNull();
    const repeated = await coordinator.fetch(call('/v1/sandbox/cleanup-task', { userTaskId: body.userTaskId }));
    expect(await repeated.json()).toMatchObject({ status: 'already-empty', deletedRuns: 0 });
  });

  it('does not clean unknown or foreign task state', async () => {
    const { coordinator, storage } = setup();
    const submitted = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'cleanup-foreign' }));
    const receipt = await submitted.json() as { runId: string };
    const stored = storage.values.get('runner-v1') as { runs: Record<string, { state: string; principalId: string }> };
    stored.runs[receipt.runId]!.state = 'unknown';
    expect((await coordinator.fetch(call('/v1/sandbox/cleanup-task', { userTaskId: body.userTaskId }))).status).toBe(409);
    stored.runs[receipt.runId]!.state = 'succeeded';
    stored.runs[receipt.runId]!.principalId = 'other-principal';
    expect((await coordinator.fetch(call('/v1/sandbox/cleanup-task', { userTaskId: body.userTaskId }))).status).toBe(403);
  });

  it('durably deduplicates submissions and never stores a publication token as plaintext', async () => {
    const { coordinator, storage } = setup();
    const response = await coordinator.fetch(call('/v1/runs', { ...body, repository: { fullName: 'trained-assist/ai-agent-runner', token: 'publication-secret' } }, { 'idempotency-key': 'attempt-1' }));
    expect(response.status).toBe(202);
    const receipt = await response.json() as { runId: string };
    const repeated = await coordinator.fetch(call('/v1/runs', { ...body, repository: { fullName: 'trained-assist/ai-agent-runner', token: 'publication-secret' } }, { 'idempotency-key': 'attempt-1' }));
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ runId: receipt.runId, deduplicated: true });
    const stored = JSON.stringify(storage.values.get('runner-v1'));
    expect(stored).not.toContain('publication-secret');
    const conflict = await coordinator.fetch(call('/v1/runs', { ...body, input: { inlinePrompt: 'different' } }, { 'idempotency-key': 'attempt-1' }));
    expect(conflict.status).toBe(409);
  });

  it('fences cancellation before admission and prevents a late submit from launching', async () => {
    const { coordinator, storage, launched } = setup();
    const cancelBody = { userTaskId: body.userTaskId, idempotencyKey: 'late-submit', ownerGeneration: 1 };
    const cancelled = await coordinator.fetch(call('/v1/runs/cancel-by-idempotency-key', cancelBody));
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled_before_admission', userTaskId: body.userTaskId, ownerGeneration: 1, runId: null });

    const submit = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'late-submit' }));
    expect(submit.status).toBe(409);
    expect(await submit.json()).toMatchObject({ error: { code: 'CANCELLED_BEFORE_ADMISSION' } });
    await coordinator.alarm();
    expect(launched).toHaveLength(0);

    // Cleanup may clear the test run state, but it must not open the late-submit race.
    await coordinator.fetch(call('/v1/sandbox/cleanup-task', { userTaskId: body.userTaskId }));
    const lateRetry = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'late-submit' }));
    expect(lateRetry.status).toBe(409);
    expect(launched).toHaveLength(0);
    expect(storage.values.get('runner-v1')).toMatchObject({ cancellationFences: expect.any(Object) });

    const nextGeneration = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'next-generation' }));
    expect(nextGeneration.status).toBe(202);
    const nextReceipt = await nextGeneration.json() as { runId: string };
    await coordinator.alarm();
    const stored = storage.values.get('runner-v1') as { runs: Record<string, { state: string }> };
    stored.runs[nextReceipt.runId]!.state = 'succeeded';
    await storage.put('runner-v1', stored);
    await coordinator.fetch(call('/v1/sandbox/cleanup-task', { userTaskId: body.userTaskId }));
    const staleReplayAfterLaterGeneration = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'late-submit' }));
    expect(staleReplayAfterLaterGeneration.status).toBe(409);
    expect(await staleReplayAfterLaterGeneration.json()).toMatchObject({ error: { code: 'CANCELLED_BEFORE_ADMISSION' } });
    expect(launched).toHaveLength(1);
  });

  it('cancels the exact admitted generation by idempotency key and rejects identity mismatches', async () => {
    const { coordinator, launched } = setup();
    const submit = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'admitted-run' }));
    const receipt = await submit.json() as { runId: string };
    await coordinator.alarm();
    expect(launched).toHaveLength(1);

    const mismatch = await coordinator.fetch(call('/v1/runs/cancel-by-idempotency-key', { userTaskId: body.userTaskId, idempotencyKey: 'admitted-run', ownerGeneration: 2 }));
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ error: { code: 'CANCEL_IDENTITY_MISMATCH' } });

    const cancelled = await coordinator.fetch(call('/v1/runs/cancel-by-idempotency-key', { userTaskId: body.userTaskId, idempotencyKey: 'admitted-run', ownerGeneration: 1 }));
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: 'stop_pending', runId: receipt.runId, ownerGeneration: 1 });
    const status = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/status`));
    expect(await status.json()).toMatchObject({ runId: receipt.runId, cancelRequested: true });
  });

  it('launches through the configured VM worker and persists status/result across alarm cycles', async () => {
    const { coordinator, launched } = setup();
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'attempt-2' }));
    const receipt = await response.json() as { runId: string };
    await coordinator.alarm();
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ engine: { name: 'eu-vm-agent-run' }, input: { inlinePrompt: 'say done' }, resultUrl: `https://runner-api.example/v1/runs/${receipt.runId}/result` });
    expect(await (await coordinator.fetch(call(`/v1/runs/${receipt.runId}/status`))).json()).toMatchObject({ state: 'starting', statusFreshness: 'unobserved' });
    await coordinator.alarm();
    const live = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/events?cursor=0`));
    expect(await live.json()).toMatchObject({ snapshot: { state: 'running', statusFreshness: 'fresh', output: {
      stdout: 'step 1: inspect', stderr: 'progress warning', updatedAt: expect.any(String),
    } } });
    await coordinator.alarm();
    const status = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/status`));
    expect(await status.json()).toMatchObject({ state: 'succeeded', answer: 'done' });
    const result = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/result`));
    expect(await result.json()).toMatchObject({ outcome: 'succeeded', text: 'done' });
  });

  it('cuts over from France to GHA only on confirmed pre-admission capacity refusal and pins the run there', async () => {
    const { coordinator, env, storage } = setup();
    env.GHA_WORKER_URL = 'https://gha.example';
    env.GHA_WORKER_TOKEN = 'gha-worker-secret-for-test-only';
    const calls: Array<{ host: string; path: string; authorization: string; body?: Record<string, unknown> }> = [];
    let ghaStatusPolls = 0;
    env.FETCH = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      const parsedBody = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ host: url.host, path: url.pathname, authorization: headers.get('authorization') ?? '', ...(parsedBody ? { body: parsedBody } : {}) });
      if (url.host === 'france.example') return Response.json({ accepted: false, code: 'WORKER_CAPACITY', cpuPercent: 60.1 }, { status: 503 });
      if (url.pathname === '/v1/launch') return Response.json({ runId: parsedBody?.['runId'], operationId: 'op-test', status: 'accepted' }, { status: 202 });
      if (url.pathname.endsWith('/status')) return Response.json({ status: ++ghaStatusPolls === 1 ? 'running' : 'succeeded' });
      if (url.pathname.endsWith('/result')) return Response.json({ exitReason: 'completed', exitCode: 0, exitSignal: null, answer: 'done on GHA', artifacts: [], logUrl: '', repo: null });
      return Response.json({ status: 'cancelled' });
    };

    const submitted = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'capacity-cutover' }));
    const receipt = await submitted.json() as { runId: string };
    await coordinator.alarm();

    const launchCalls = calls.filter((entry) => entry.path === '/v1/launch');
    expect(launchCalls.map((entry) => entry.host)).toEqual(['france.example', 'gha.example']);
    expect(launchCalls[0]?.authorization).toBe('Bearer worker-secret');
    expect(launchCalls[1]?.authorization).toBe('Bearer gha-worker-secret-for-test-only');
    expect(launchCalls[1]?.body).toMatchObject({ runId: receipt.runId, operationId: launchCalls[0]?.body?.['operationId'], engine: { name: 'azure-cloud' } });
    expect(storage.values.get('runner-v1')).toMatchObject({ runs: { [receipt.runId]: { engine: 'azure-cloud', state: 'starting' } } });

    const recovered = new RunnerRunCoordinator({ storage, blockConcurrencyWhile: async (fn) => fn() }, env);
    await recovered.alarm();
    await recovered.alarm();
    expect(calls.filter((entry) => entry.path.endsWith('/status')).every((entry) => entry.host === 'gha.example')).toBe(true);
    expect(calls.filter((entry) => entry.path.endsWith('/result')).every((entry) => entry.host === 'gha.example')).toBe(true);
    const result = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/result`));
    expect(await result.json()).toMatchObject({ outcome: 'succeeded', text: 'done on GHA' });
  });

  it('supports strict France and strict GHA API routes in addition to auto selection', async () => {
    const france = setup();
    france.env.GHA_WORKER_URL = 'https://gha.example';
    france.env.GHA_WORKER_TOKEN = 'gha-worker-secret-for-test-only';
    const franceHosts: string[] = [];
    france.env.FETCH = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      franceHosts.push(url.host);
      return Response.json({ accepted: false, code: 'WORKER_CAPACITY' }, { status: 503 });
    };
    const franceAccepted = await france.coordinator.fetch(call('/v1/runs', { ...body, routeMode: 'france' }, { 'idempotency-key': 'strict-france' }));
    expect(franceAccepted.status).toBe(202);
    const franceReceipt = await franceAccepted.json() as { runId: string };
    await france.coordinator.alarm();
    expect(franceHosts).toEqual(['france.example']);
    expect(await (await france.coordinator.fetch(call(`/v1/runs/${franceReceipt.runId}/result`))).json()).toMatchObject({ outcome: 'failed', failure: { code: 'WORKER_CAPACITY' } });

    const gha = setup();
    gha.env.GHA_WORKER_URL = 'https://gha.example';
    gha.env.GHA_WORKER_TOKEN = 'gha-worker-secret-for-test-only';
    const ghaHosts: string[] = [];
    gha.env.FETCH = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      ghaHosts.push(url.host);
      const launch = JSON.parse(String(init?.body)) as { runId: string };
      return Response.json({ runId: launch.runId, operationId: 'op-gha', status: 'accepted' }, { status: 202 });
    };
    const ghaAccepted = await gha.coordinator.fetch(call('/v1/runs', { ...body, routeMode: 'gha', engine: { name: 'azure-cloud', adapterVersion: '1' } }, { 'idempotency-key': 'strict-gha' }));
    expect(ghaAccepted.status).toBe(202);
    const ghaReceipt = await ghaAccepted.json() as { runId: string };
    await gha.coordinator.alarm();
    expect(ghaHosts).toEqual(['gha.example']);
    expect(gha.storage.values.get('runner-v1')).toMatchObject({ runs: { [ghaReceipt.runId]: { engine: 'azure-cloud', routeMode: 'gha', state: 'starting' } } });
    expect(await (await gha.coordinator.fetch(call(`/v1/runs/${ghaReceipt.runId}/status`))).json()).toMatchObject({ engine: 'azure-cloud', routeMode: 'gha', state: 'starting' });
  });

  it('does not cut over to GHA for a non-capacity France refusal', async () => {
    const { coordinator, env } = setup();
    env.GHA_WORKER_URL = 'https://gha.example';
    env.GHA_WORKER_TOKEN = 'gha-worker-secret-for-test-only';
    const hosts: string[] = [];
    env.FETCH = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      hosts.push(url.host);
      return Response.json({ accepted: false, code: 'WORKER_PROFILE_WORKSPACE_UNSUPPORTED' }, { status: 503 });
    };
    const submitted = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'no-cutover-on-other-refusal' }));
    const receipt = await submitted.json() as { runId: string };
    await coordinator.alarm();
    expect(hosts).toEqual(['france.example']);
    const result = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/result`));
    expect(await result.json()).toMatchObject({ outcome: 'failed', failure: { code: 'WORKER_PROFILE_WORKSPACE_UNSUPPORTED' } });
  });

  it('keeps sandbox3 France-only when the optional GHA credential is not provisioned', async () => {
    const { coordinator, env } = setup();
    env.GHA_WORKER_URL = 'https://gha.example';
    const hosts: string[] = [];
    env.FETCH = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      hosts.push(url.host);
      return Response.json({ accepted: false, code: 'WORKER_CAPACITY' }, { status: 503 });
    };
    const submitted = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'capacity-without-gha-secret' }));
    const receipt = await submitted.json() as { runId: string };
    await coordinator.alarm();
    expect(hosts).toEqual(['france.example']);
    const result = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/result`));
    expect(await result.json()).toMatchObject({ outcome: 'failed', failure: { code: 'WORKER_CAPACITY' } });
  });

  // Regressions from current main: preserve answers, stale-status recovery and process-start visibility.
  it('preserves a non-truncated OpenCode stdout answer when an older worker omits answer', async () => {
    const { coordinator, env } = setup();
    const previousFetch = env.FETCH!;
    env.FETCH = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith('/result')) {
        return Response.json({ exitReason: 'completed', exitCode: 0, exitSignal: null, answer: null,
          stdout: 'GitHub auth is connected.', stderr: '', outputTruncated: false, artifacts: [], logUrl: '', repo: null });
      }
      return previousFetch(input, init);
    };
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'stdout-answer-fallback' }));
    const receipt = await response.json() as { runId: string };
    await coordinator.alarm();
    await coordinator.alarm();
    await coordinator.alarm();

    const status = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/status`));
    expect(await status.json()).toMatchObject({ state: 'succeeded', answer: 'GitHub auth is connected.' });
    const result = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/result`));
    expect(await result.json()).toMatchObject({ outcome: 'succeeded', text: 'GitHub auth is connected.' });
  });

  it('does not promote a truncated stdout buffer to the answer', async () => {
    const { coordinator, env } = setup();
    const previousFetch = env.FETCH!;
    env.FETCH = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith('/result')) {
        return Response.json({ exitReason: 'completed', exitCode: 0, exitSignal: null, answer: null,
          stdout: 'partial response', stderr: '', outputTruncated: true, artifacts: [], logUrl: '', repo: null });
      }
      return previousFetch(input, init);
    };
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'truncated-stdout-answer' }));
    const receipt = await response.json() as { runId: string };
    await coordinator.alarm();
    await coordinator.alarm();
    await coordinator.alarm();

    const status = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/status`));
    expect(await status.json()).toMatchObject({ state: 'succeeded', answer: null });
    const result = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/result`));
    expect(await result.json()).not.toHaveProperty('text');
  });

  it('marks a receipt-backed run unknown after stale worker status and resumes polling without relaunching', async () => {
    const { coordinator, storage, launched, env } = setup();
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'stale-status-recovery' }));
    const receipt = await response.json() as { runId: string };
    await coordinator.alarm();
    const stored = storage.values.get('runner-v1') as { runs: Record<string, { lastHeartbeatAt?: string }> };
    stored.runs[receipt.runId]!.lastHeartbeatAt = new Date(Date.now() - 60_000).toISOString();
    env.FETCH = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith('/status')) throw new Error('worker unavailable');
      throw new Error('unexpected request');
    };
    await coordinator.alarm();
    expect(await (await coordinator.fetch(call(`/v1/runs/${receipt.runId}/status`))).json()).toMatchObject({ state: 'unknown', connectionLost: true, statusFreshness: 'stale' });
    expect(launched).toHaveLength(1);
    expect(storage.alarmAt).not.toBeNull();

    env.FETCH = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith('/status')) return Response.json({ status: 'running', state: 'running' });
      if (url.pathname.endsWith('/logs')) return Response.json({ cursor: 0, logs: [] });
      throw new Error('unexpected request');
    };
    await coordinator.alarm();
    expect(await (await coordinator.fetch(call(`/v1/runs/${receipt.runId}/status`))).json()).toMatchObject({ state: 'running', connectionLost: false, statusFreshness: 'fresh' });
    expect(launched).toHaveLength(1);
  });

  it('does not confuse a fresh poll with worker progress while a run is stuck before process start', async () => {
    const { coordinator, env, launched } = setup();
    const stuckSince = new Date(Date.now() - 10 * 60_000).toISOString();
    env.FETCH = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/v1/launch') {
        const launch = JSON.parse(String(init?.body)) as { runId: string };
        launched.push(launch);
        return Response.json({ runId: launch.runId, operationId: 'op-stuck-start', status: 'accepted' }, { status: 202 });
      }
      if (url.pathname.endsWith('/status')) return Response.json({ status: 'running', state: 'starting', startPhase: 'materialize', startAttempts: 1, startedAt: null, updatedAt: stuckSince });
      if (url.pathname.endsWith('/logs')) return Response.json({ cursor: 0, logs: [] });
      if (url.pathname.endsWith('/cancel')) return Response.json({ status: 'stop_pending' });
      throw new Error(`unexpected worker request ${url.pathname}`);
    };
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'stuck-before-engine-start' }));
    const receipt = await response.json() as { runId: string };

    await coordinator.alarm(); // accepted by France worker
    await coordinator.alarm(); // first status poll observes starting
    await coordinator.alarm(); // identical worker updatedAt, but successful contact

    const status = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/status`));
    expect(await status.json()).toMatchObject({ state: 'starting', statusFreshness: 'fresh',
      workerReportedUpdatedAt: stuckSince, workerProgressFreshness: 'stale', workerStartPhase: 'materialize', workerStartAttempts: 1, workerStartedAt: null });
    expect(launched).toHaveLength(1);

    // A stuck accepted run stays fenced: it must not be resent merely because
    // progress stopped. Restart policy may act only after pre-start is proven.
    await coordinator.alarm();
    expect(launched).toHaveLength(1);
  });

  it('proxies only a completed run output path to the VM worker', async () => {
    const { coordinator, env, storage } = setup();
    const bytes = Buffer.from('artifact bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const workerCalls: string[] = [];
    env.FETCH = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      workerCalls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer worker-secret');
      if (url.pathname === '/v1/launch') {
        const launch = JSON.parse(String(init?.body)) as { runId: string };
        return Response.json({ runId: launch.runId, operationId: 'op-artifact', status: 'accepted', statusUrl: '', resultUrl: '' }, { status: 202 });
      }
      if (url.pathname.endsWith('/status')) return Response.json({ status: 'succeeded' });
      if (url.pathname.endsWith('/result')) return Response.json({ exitReason: 'completed', exitCode: 0, exitSignal: null,
        answer: 'done', artifacts: [{ path: 'outputs/agent-note.md', name: 'agent-note.md', mime: 'text/markdown', size: bytes.length, sha256 }],
        logUrl: '', repo: { fullName: 'team/private-profile', branch: 'agent-run/artifact-run' } });
      if (url.pathname.endsWith('/artifacts') && url.searchParams.get('path') === 'outputs/agent-note.md') {
        return new Response(bytes, { status: 200, headers: { 'content-type': 'text/markdown', 'content-length': String(bytes.length),
          'content-disposition': 'attachment; filename="agent-note.md"', 'x-content-sha256': sha256, 'x-content-type-options': 'nosniff' } });
      }
      return Response.json({ error: 'ARTIFACT_NOT_FOUND' }, { status: 404 });
    };

    const accepted = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'artifact-download' }));
    const receipt = await accepted.json() as { runId: string };
    await coordinator.alarm(); // dispatch to France VM
    const pendingDownload = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/artifacts?path=outputs%2Fagent-note.md`));
    expect(pendingDownload.status).toBe(409);
    await coordinator.alarm(); // save terminal result and artifact metadata

    const foreign = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/artifacts?path=outputs%2Fagent-note.md`, undefined, {}, { ...principal, principalId: 'foreign' }));
    expect(foreign.status).toBe(404);
    const wrongPath = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/artifacts?path=outputs%2Fother.md`));
    expect(wrongPath.status).toBe(404);

    const response = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/artifacts?path=outputs%2Fagent-note.md`));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('artifact bytes');
    expect(response.headers.get('x-content-sha256')).toBe(sha256);
    expect(workerCalls).toContain(`GET /v1/runs/${receipt.runId}/artifacts?path=outputs%2Fagent-note.md`);
    expect(storage.values.get('runner-v1')).not.toBeUndefined();
  });

  it('preserves worker process-exit evidence for cancellation without code or signal', async () => {
    const { coordinator, env } = setup();
    env.FETCH = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/v1/launch') {
        const launch = JSON.parse(String(init?.body)) as { runId: string };
        return Response.json({ runId: launch.runId, operationId: 'op-cancel', status: 'accepted',
          statusUrl: `https://france.example/v1/runs/${launch.runId}/status`, resultUrl: `https://france.example/v1/runs/${launch.runId}/result` }, { status: 202 });
      }
      if (url.pathname.endsWith('/status')) return Response.json({ status: 'cancelled' });
      if (url.pathname.endsWith('/result')) return Response.json({ exitReason: 'cancelled', exitCode: null,
        exitSignal: null, exitObserved: true, artifacts: [], logUrl: '', repo: null });
      return Response.json({ status: 'stopped' });
    };
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'cancel-exit-evidence' }));
    const receipt = await response.json() as { runId: string };
    await coordinator.alarm(); // dispatch
    await coordinator.alarm(); // reconcile terminal worker result

    const result = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/result`));
    expect(await result.json()).toMatchObject({ outcome: 'cancelled', exitObserved: true, exitCode: null, exitSignal: null });
  });

  it('forwards a task-scoped ingress manifest pin enriched with the admitted run identity', async () => {
    const { coordinator, launched, storage } = setup();
    const pin = { contractVersion: 1, manifestRef: 'cp-input-manifest:task-file', manifestVersion: 'd'.repeat(64) };
    const response = await coordinator.fetch(call('/v1/runs', {
      ...body, userTaskId: 'task-file', ingressManifest: pin,
    }, { 'idempotency-key': 'file-ingress-admission' }));
    expect(response.status).toBe(202);
    const receipt = await response.json() as { runId: string };
    await coordinator.alarm();

    expect(launched).toHaveLength(1);
    expect(launched[0]?.['ingressManifest']).toEqual({
      ...pin, userTaskId: 'task-file', profileId: principal.profileId,
      runId: receipt.runId, ownerGeneration: 1,
    });
    expect(JSON.stringify(storage.values.get('runner-v1'))).not.toContain('manifestVersion');
  });

  it('rejects malformed or cross-task ingress manifest pins before storing or launching', async () => {
    const { coordinator, launched, storage } = setup();
    const invalidPins = [
      { contractVersion: 2, manifestRef: 'cp-input-manifest:task-a', manifestVersion: 'e'.repeat(64) },
      { contractVersion: 1, manifestRef: 'cp-input-manifest:other-task', manifestVersion: 'e'.repeat(64) },
      { contractVersion: 1, manifestRef: 'cp-input-manifest:task-a', manifestVersion: 'bad' },
      { contractVersion: 1, manifestRef: 'cp-input-manifest:task-a', manifestVersion: 'e'.repeat(64), runId: 'caller-chosen' },
    ];
    for (const [index, ingressManifest] of invalidPins.entries()) {
      const response = await coordinator.fetch(call('/v1/runs', { ...body, ingressManifest }, { 'idempotency-key': `bad-ingress-${index}` }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INGRESS_MANIFEST' } });
    }
    expect(storage.values.get('runner-v1')).toMatchObject({ runs: {}, idempotency: {} });
    expect(launched).toHaveLength(0);
  });

  it('returns a terminal preflight result when France refuses the launch before admission', async () => {
    const { coordinator, env, storage } = setup();
    env.FETCH = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/v1/launch') return Response.json({ error: 'INVALID_REQUEST',
        details: ['launch.region: unsupported', 'engine does not match this worker',
          'token=never-log-this-value'] }, { status: 400 });
      return Response.json({ status: 'unknown' });
    };
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'worker-refusal' }));
    const receipt = await response.json() as { runId: string };
    await coordinator.alarm();

    const status = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/status`));
    expect(await status.json()).toMatchObject({ state: 'failed', connectionLost: false });
    const resultResponse = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/result`));
    expect(resultResponse.status).toBe(200);
    const result = await resultResponse.json() as Record<string, unknown>;
    expect(result).toMatchObject({
      runId: receipt.runId, userTaskId: 'task-a', outcome: 'failed', exitReason: 'preflight_refused',
      exitObserved: false, failure: { code: 'WORKER_INVALID_REQUEST', failureClass: 'preflight', retryable: false,
        safeSummary: expect.stringContaining('rejected fields: launch.region, engine') },
    });
    expect(JSON.stringify(result)).not.toContain('never-log-this-value');

    // Older deployed records can be terminal without a stored result. A poll
    // after upgrading must still receive proof of non-admission, not a 409.
    const stored = storage.values.get('runner-v1') as { runs: Record<string, { result?: unknown; launchRejection?: unknown }> };
    delete stored.runs[receipt.runId]!.result;
    delete stored.runs[receipt.runId]!.launchRejection;
    await storage.put('runner-v1', stored);
    const legacyResult = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/result`));
    expect(legacyResult.status).toBe(200);
    expect(await legacyResult.json()).toMatchObject({ exitReason: 'preflight_refused', exitObserved: false,
      failure: { code: 'WORKER_LAUNCH_REJECTED', failureClass: 'preflight' } });
  });

  it('does not redispatch an execution after the worker reports an unknown run', async () => {
    const { coordinator, env, launched } = setup();
    env.FETCH = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/v1/launch') {
        launched.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ runId: launched.at(-1)?.['runId'], operationId: 'op-test', status: 'accepted' }, { status: 202 });
      }
      if (url.pathname.endsWith('/status')) return Response.json({ status: 'unknown_run' });
      return Response.json({ error: 'unexpected worker call' }, { status: 500 });
    };
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'unknown-does-not-retry' }));
    const receipt = await response.json() as { runId: string };

    await coordinator.alarm(); // receipt from launch
    await coordinator.alarm(); // worker no longer knows the run
    await coordinator.alarm(); // unknown runs are not eligible for dispatch

    expect(launched).toHaveLength(1);
    const status = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/status`));
    expect(await status.json()).toMatchObject({ state: 'unknown', connectionLost: true });
  });

  it('does not redispatch when launch delivery is ambiguous and reconciliation is unknown', async () => {
    const { coordinator, env } = setup();
    let launchCalls = 0;
    env.FETCH = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/v1/launch') {
        launchCalls += 1;
        throw new Error('connection reset after launch write');
      }
      if (url.pathname.endsWith('/status')) return Response.json({ status: 'unknown_run' });
      return Response.json({ error: 'unexpected worker call' }, { status: 500 });
    };
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'ambiguous-launch-does-not-retry' }));
    const receipt = await response.json() as { runId: string };

    await coordinator.alarm();
    await coordinator.alarm();

    expect(launchCalls).toBe(1);
    const status = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/status`));
    expect(await status.json()).toMatchObject({ state: 'unknown', connectionLost: true });
  });

  it('uses the authenticated principal repository and rejects request attempts to override it', async () => {
    const boundPrincipal: ApiPrincipal = { ...principal, repository: 'team/profile-one' };
    const { coordinator, launched, storage } = setup();
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'bound-repository' }, boundPrincipal));
    expect(response.status).toBe(202);
    await coordinator.alarm();
    expect(launched[0]?.['repository']).toMatchObject({ fullName: 'team/profile-one' });

    const rejected = await coordinator.fetch(call('/v1/runs', { ...body, repository: { fullName: 'other/profile' } }, { 'idempotency-key': 'override-repository' }, boundPrincipal));
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: { code: 'REPOSITORY_BINDING_MISMATCH' } });
    expect(storage.values.size).toBe(1);
  });

  it('uses only the trusted Telegram UX task repository binding and does not inject a repository credential', async () => {
    const { coordinator, launched, storage } = setup();
    const pinnedPrincipal: ApiPrincipal = {
      ...principal,
      principalId: 'integration-telegram-ux-v1',
      profileId: 'integration-telegram-ux-v1',
      repository: 'trained-assist/ai-agent-runner',
    };
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'telegram-ux-repository-token' }, pinnedPrincipal));
    expect(response.status).toBe(202);
    await coordinator.alarm();
    expect(launched[0]).toMatchObject({
      repository: { fullName: 'trained-assist/ai-agent-runner' },
    });
    expect(launched[0]).not.toHaveProperty('publicationToken');

    const rejected = await coordinator.fetch(call('/v1/runs', {
      ...body, userTaskId: 'task-other', repository: { fullName: 'vovalikessmoothy-png/gha-env-config' },
    }, { 'idempotency-key': 'gha-config-cannot-be-task-repository' }, pinnedPrincipal));
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: { code: 'REPOSITORY_BINDING_MISMATCH' } });
    expect(storage.values.size).toBe(1);
    expect(launched).toHaveLength(1);
  });

  it('fails closed when a real execution principal has no repository binding', async () => {
    const { coordinator, storage, launched } = setup();
    const unboundPrincipal: ApiPrincipal = { ...principal, repository: undefined };
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'missing-repository-binding' }, unboundPrincipal));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'SERVER_MISCONFIGURED' } });
    expect(storage.values.get('runner-v1')).toMatchObject({ runs: {}, idempotency: {} });
    expect(launched).toHaveLength(0);
  });

  it('does not reveal runs to a different principal', async () => {
    const { coordinator } = setup();
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'attempt-3' }));
    const receipt = await response.json() as { runId: string };
    const other: ApiPrincipal = { ...principal, principalId: 'principal-b' };
    const status = await coordinator.fetch(new Request(`https://runner-runs.internal/v1/runs/${receipt.runId}/status`, { headers: { 'x-runner-principal': JSON.stringify(other) } }));
    expect(status.status).toBe(404);
  });

  it('increments owner generation for a new attempt after the previous attempt is terminal', async () => {
    const { coordinator, launched } = setup();
    const first = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'generation-1' }));
    const firstReceipt = await first.json() as { runId: string; requestId: string };
    await coordinator.alarm();
    await coordinator.alarm();
    await coordinator.alarm();
    const second = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'generation-2' }));
    const secondReceipt = await second.json() as { runId: string; requestId: string };
    await coordinator.alarm();
    expect(launched).toHaveLength(2);
    expect(launched[0]?.['ownerGeneration']).toBe(1);
    expect(launched[1]?.['ownerGeneration']).toBe(2);
    expect(launched[0]?.['operationId']).not.toBe(launched[1]?.['operationId']);
    expect(secondReceipt.runId).not.toBe(firstReceipt.runId);
    expect(secondReceipt.requestId).toBe(firstReceipt.requestId);
  });

  it('runs the sandbox mock-test engine without calling the France VM', async () => {
    const { coordinator, launched, env } = setup();
    env.MOCK_TEST_ENABLED = 'true';
    const response = await coordinator.fetch(call('/v1/runs', { ...body, engine: { name: 'mock-test', adapterVersion: '1' } }, { 'idempotency-key': 'mock-ping' }));
    const receipt = await response.json() as { runId: string };
    await coordinator.alarm();
    expect(launched).toHaveLength(0);
    const status = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/status`));
    expect(await status.json()).toMatchObject({ state: 'succeeded', engine: 'mock-test', answer: 'pong' });
  });

  it('attaches a run-bound proof and bearer only for the pinned Registry MCP principal', async () => {
    const pair = generateKeyPairSync('ed25519');
    const privateJwk = pair.privateKey.export({ format: 'jwk' });
    const publicJwk = pair.publicKey.export({ format: 'jwk' });
    const { coordinator, launched, env } = setup();
    env.MCP_TEST_AUTH_TOKEN = 'test-host-bearer-token-123';
    env.MCP_TEST_RUNNER_PRIVATE_JWK = JSON.stringify(privateJwk);
    env.MCP_TEST_CATALOGUE_VERSION = 'registry-fixture-catalogue-v1';
    env.MCP_TEST_EXPIRES_AT = new Date(Date.now() + 60 * 60_000).toISOString();
    const mcpPrincipal: ApiPrincipal = { ...principal, principalId: 'integration-telegram-ux-v1', profileId: 'integration-telegram-ux-v1', mcpBindings: ['registry-mcp-test-160-read'] };
    const request = new Request('https://runner-runs.internal/v1/runs', { method: 'POST', headers: { 'x-runner-principal': JSON.stringify(mcpPrincipal), 'idempotency-key': 'pinned-mcp-run', 'content-type': 'application/json' }, body: JSON.stringify({ ...body, mcp: testMcp }) });
    const response = await coordinator.fetch(request);
    expect(response.status).toBe(202);
    const receipt = await response.json() as { runId: string };
    await coordinator.alarm();
    const launch = launched[0]!;
    const attachment = { mcp: launch.mcp as { servers: Record<string, { headers: Record<string, string> }> },
      mcpSecrets: launch.mcpSecrets as Record<string, string> };
    expect(Object.keys(launch).sort()).toContain('mcpSecrets');
    expect(Object.keys(attachment.mcp.servers)).toEqual(['trained-assist-registry-test']);
    const server = attachment.mcp.servers['trained-assist-registry-test']!;
    expect(server.headers['X-MCP-Run-Binding']).toBe('{env:RUNNER_MCP_REGISTRY_TEST_PROOF}');
    const proof = attachment.mcpSecrets['RUNNER_MCP_REGISTRY_TEST_PROOF']!;
    const [header, payload, signature] = proof.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))).toEqual({ alg: 'EdDSA', typ: 'JWT' });
    expect(claims).toMatchObject({ runId: receipt.runId, sub: receipt.runId, userTaskId: 'task-a', profileId: 'integration-telegram-ux-v1', principalId: 'integration-telegram-ux-v1', scope: 'registry:fixture-read', serverId: 'trained-assist-registry-test', bindingRef: 'registry-mcp-test-160-read', catalogueVersion: 'registry-fixture-catalogue-v1', registryDigest: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9' });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(900);
    expect(Object.keys(claims).sort()).toEqual(['allowedTools', 'aud', 'bindingRef', 'catalogueVersion', 'exp', 'iat', 'iss', 'policyVersion', 'principalId', 'profileId', 'registryDigest', 'runId', 'scope', 'serverId', 'sub', 'userTaskId'].sort());
    expect(verify(null, Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(server.headers).toMatchObject({ Authorization: 'Bearer {env:RUNNER_MCP_REGISTRY_TEST}', 'X-MCP-Operation': 'invocation', 'X-MCP-Scope': 'registry:fixture-read', 'X-MCP-Run-Id': receipt.runId, 'X-MCP-User-Task-Id': 'task-a' });
    expect(attachment.mcpSecrets).toMatchObject({ RUNNER_MCP_REGISTRY_TEST: 'test-host-bearer-token-123', RUNNER_MCP_REGISTRY_TEST_PROOF: proof });
    expect(JSON.stringify((await coordinator['read']()).runs[receipt.runId])).not.toContain('test-host-bearer-token-123');
  });

  it('attaches a short-lived per-run proof to the pinned product user catalog without persisting secrets', async () => {
    const pair = generateKeyPairSync('ed25519');
    const privateJwk = pair.privateKey.export({ format: 'jwk' });
    const { coordinator, launched, env } = setup();
    env.MCP_USER_AUTH_TOKEN = 'product-user-mcp-transport-token-123';
    env.MCP_USER_RUNNER_PRIVATE_JWK = JSON.stringify(privateJwk);
    env.MCP_USER_PROFILE_USER_IDS = JSON.stringify({ 'integration-telegram-ux-v1': 'sandbox-user-1' });
    env.MCP_USER_CATALOGUE_VERSION = 'mem-gpt-user-catalogue-v1';
    env.MCP_USER_CATALOGUE_DIGEST = '8c17e64a0d71123698b139bd5957a10fff71a2b15f12601a95adcde150350e71';
    const mcpPrincipal: ApiPrincipal = { ...principal, principalId: 'integration-telegram-ux-v1', profileId: 'integration-telegram-ux-v1' };
    const response = await coordinator.fetch(call('/v1/runs', { ...body, mcp: userMcp }, { 'idempotency-key': 'product-user-mcp-run' }, mcpPrincipal));
    expect(response.status, await response.clone().text()).toBe(202);
    const receipt = await response.json() as { runId: string };
    await coordinator.alarm();
    const launch = launched[0]!;
    const attachment = { mcp: launch.mcp as { servers: Record<string, { headers: Record<string, string> }> },
      mcpSecrets: launch.mcpSecrets as Record<string, string> };
    expect(Object.keys(attachment.mcp.servers)).toEqual(['mem-gpt']);
    const server = attachment.mcp.servers['mem-gpt']!;
    expect(server.headers).toMatchObject({
      Authorization: 'Bearer {env:RUNNER_MCP_USER_TOKEN}',
      'X-MCP-Operation': 'invocation', 'X-MCP-Scope': 'mcp:user-agent-run',
      'X-MCP-Run-Id': receipt.runId, 'X-MCP-User-Task-Id': 'task-a',
      'X-MCP-Run-Binding': '{env:RUNNER_MCP_USER_PROOF}',
    });
    const proof = attachment.mcpSecrets['RUNNER_MCP_USER_PROOF']!;
    const [header, payload, signature] = proof.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(claims).toMatchObject({ userId: 'sandbox-user-1', runId: receipt.runId, userTaskId: 'task-a',
      profileId: 'integration-telegram-ux-v1', ownerGeneration: 1, serverId: 'mem-gpt',
      bindingRef: 'mem-gpt-user-sandbox', scope: 'mcp:user-agent-run',
      catalogueVersion: 'mem-gpt-user-catalogue-v1',
      catalogueDigest: '8c17e64a0d71123698b139bd5957a10fff71a2b15f12601a95adcde150350e71' });
    expect(verify(null, Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(attachment.mcpSecrets['RUNNER_MCP_USER_TOKEN']).toBe('product-user-mcp-transport-token-123');
    expect(JSON.stringify((await coordinator['read']()).runs[receipt.runId])).not.toContain('product-user-mcp-transport-token-123');
    expect(JSON.stringify((await coordinator['read']()).runs[receipt.runId])).not.toContain(proof);
  });

  it('refuses a user-catalog descriptor outside the trusted profile or grant lifetime before admission', async () => {
    const { coordinator, storage, env } = setup();
    env.MCP_USER_AUTH_TOKEN = 'product-user-mcp-transport-token-123';
    env.MCP_USER_RUNNER_PRIVATE_JWK = JSON.stringify(generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }));
    env.MCP_USER_PROFILE_USER_IDS = JSON.stringify({ 'integration-telegram-ux-v1': 'sandbox-user-1' });
    env.MCP_USER_CATALOGUE_VERSION = 'mem-gpt-user-catalogue-v1';
    env.MCP_USER_CATALOGUE_DIGEST = '8c17e64a0d71123698b139bd5957a10fff71a2b15f12601a95adcde150350e71';
    const owner: ApiPrincipal = { ...principal, principalId: 'integration-telegram-ux-v1', profileId: 'integration-telegram-ux-v1' };
    const wrongProfile = await coordinator.fetch(call('/v1/runs', { ...body, mcp: userMcp }, { 'idempotency-key': 'user-mcp-wrong-profile' }, principal));
    expect(wrongProfile.status).toBe(422);
    const longRun = await coordinator.fetch(call('/v1/runs', { ...body, mcp: userMcp, limits: { timeoutMs: 7_200_000 } }, { 'idempotency-key': 'user-mcp-too-long' }, owner));
    expect(longRun.status).toBe(422);
    expect(JSON.stringify(storage.values.get('runner-v1') ?? {})).not.toContain('sandbox-user-1');
  });

  it('rejects unbound or altered MCP descriptors before storing a run', async () => {
    const { coordinator, storage, env } = setup();
    env.MCP_TEST_AUTH_TOKEN = 'test-host-bearer-token-123';
    env.MCP_TEST_RUNNER_PRIVATE_JWK = JSON.stringify(generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }));
    env.MCP_TEST_CATALOGUE_VERSION = 'registry-fixture-catalogue-v1';
    env.MCP_TEST_EXPIRES_AT = new Date(Date.now() + 60 * 60_000).toISOString();
    const bodyWith = (principalValue: ApiPrincipal, descriptor: unknown, key: string) => new Request('https://runner-runs.internal/v1/runs', { method: 'POST', headers: { 'x-runner-principal': JSON.stringify(principalValue), 'idempotency-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, mcp: descriptor }) });
    const wrongPrincipal = await coordinator.fetch(bodyWith(principal, testMcp, 'wrong-principal'));
    expect(wrongPrincipal.status).toBe(422);
    const badEndpoint = await coordinator.fetch(bodyWith({ ...principal, principalId: 'integration-telegram-ux-v1', profileId: 'integration-telegram-ux-v1', mcpBindings: ['registry-mcp-test-160-read'] }, { servers: [{ ...testMcp.servers[0], url: 'https://attacker.example/mcp' }] }, 'wrong-endpoint'));
    expect(badEndpoint.status).toBe(422);
    expect(JSON.stringify(storage.values.get('runner-v1'))).not.toContain('test-host-bearer-token-123');
  });
});

describe('tenant-bound model connections', () => {
  const byokBody = { ...body, envAllowlist: [], credentialBindings: [{ type: 'openai', connectionId: 'conn-openai-a' }] };
  function provision(env: RunnerWorkerEnv) {
    env.RUNNER_BYOK_ENABLED = 'true';
    env.ALLOWED_ENVIRONMENT_NAMES = 'OPENAI_API_KEY';
    env.RUNNER_MODEL_CONNECTIONS = JSON.stringify([{ connectionId: 'conn-openai-a', principalId: principal.principalId,
      profileId: principal.profileId, provider: 'openai', model: 'openai/gpt-5', secretBinding: 'RUNNER_MODEL_SECRET_A' }]);
    env['RUNNER_MODEL_SECRET_A'] = 'test-only-provider-secret';
  }

  it('uses the principal-owned connection and encrypts the provider secret before storage', async () => {
    const { coordinator, env, storage, launched } = setup();
    provision(env);
    const response = await coordinator.fetch(call('/v1/runs', byokBody, { 'idempotency-key': 'byok-1' }));
    expect(response.status).toBe(202);
    const stored = JSON.stringify(storage.values.get('runner-v1'));
    expect(stored).not.toContain('test-only-provider-secret');
    await coordinator.alarm();
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ envAllowlist: ['OPENAI_API_KEY'], env: { OPENAI_API_KEY: 'test-only-provider-secret' },
      engine: { modelSettings: { model: 'openai/gpt-5' } } });
    const status = await coordinator.fetch(call(`/v1/runs/${(await response.json() as { runId: string }).runId}/status`));
    expect(JSON.stringify(await status.json())).not.toContain('test-only-provider-secret');
  });

  it('cannot use another tenant connection or mix BYOK with managed secrets', async () => {
    const { coordinator, env, storage } = setup();
    provision(env);
    const foreign = await coordinator.fetch(call('/v1/runs', byokBody, { 'idempotency-key': 'foreign' },
      { ...principal, principalId: 'different-principal' }));
    expect(foreign.status).toBe(404);
    const mixed = await coordinator.fetch(call('/v1/runs', { ...byokBody, envAllowlist: ['LLM_LADDER_TOKEN'] }, { 'idempotency-key': 'mixed' }));
    expect(mixed.status).toBe(403);
    const missing = await coordinator.fetch(call('/v1/runs', { ...byokBody, credentialBindings: [{ type: 'openai', connectionId: 'missing' }] }, { 'idempotency-key': 'missing' }));
    expect(missing.status).toBe(404);
    expect((storage.values.get('runner-v1') as { runs: Record<string, unknown> }).runs).toEqual({});
  });

  it('keeps legacy requests with an empty credentialBindings array compatible', async () => {
    const { coordinator } = setup();
    const response = await coordinator.fetch(call('/v1/runs', { ...body, credentialBindings: [] }, { 'idempotency-key': 'legacy-empty' }));
    expect(response.status).toBe(202);
  });

  it('does not admit BYOK on production or without the lane switch', async () => {
    const { coordinator, env } = setup();
    provision(env);
    env.DEPLOYMENT_ENV = 'production';
    expect((await coordinator.fetch(call('/v1/runs', byokBody, { 'idempotency-key': 'prod-byok' }))).status).toBe(422);
    env.DEPLOYMENT_ENV = undefined;
    env.RUNNER_BYOK_ENABLED = undefined;
    expect((await coordinator.fetch(call('/v1/runs', byokBody, { 'idempotency-key': 'disabled-byok' }))).status).toBe(422);
  });
});

describe('principal-bound terminal webhooks', () => {
  const webhookSecret = 'sandbox-webhook-signing-secret-at-least-24';
  function provision(env: RunnerWorkerEnv) {
    env.RUNNER_WEBHOOKS_ENABLED = 'true';
    env.RUNNER_WEBHOOKS = JSON.stringify([{ webhookId: 'wh-a', principalId: principal.principalId,
      profileId: principal.profileId, url: 'https://hooks.customer.com/runner', secretBinding: 'RUNNER_WEBHOOK_SECRET_A' }]);
    env['RUNNER_WEBHOOK_SECRET_A'] = webhookSecret;
  }

  it('delivers a signed terminal event, retries a 5xx, and reports the final delivery state', async () => {
    const { coordinator, env, storage } = setup();
    provision(env);
    const sent: Array<{ headers: Headers; body: string }> = [];
    const workerFetch = env.FETCH!;
    env.FETCH = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname !== 'hooks.customer.com') return workerFetch(input, init);
      sent.push({ headers: new Headers(init?.headers), body: String(init?.body) });
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: sent.length === 1 ? 503 : 204 });
    };
    const submitted = await coordinator.fetch(call('/v1/runs', { ...body, webhookId: 'wh-a' }, { 'idempotency-key': 'webhook-attempt' }));
    expect(submitted.status).toBe(202);
    const { runId } = await submitted.json() as { runId: string };
    await coordinator.alarm();
    await coordinator.alarm();
    await coordinator.alarm();
    expect(sent).toHaveLength(1);
    const first = sent[0]!;
    const payload = JSON.parse(first.body) as Record<string, unknown>;
    expect(payload).toMatchObject({ eventId: `terminal:${runId}`, type: 'run.terminal', runId, state: 'succeeded',
      resultUrl: `https://runner-api.example/v1/developer/runs/${runId}/result`, result: { text: 'done' } });
    expect(first.headers.get('x-serverlessagence-signature')).toBe(`v1=${createHmac('sha256', webhookSecret)
      .update(`${first.headers.get('x-serverlessagence-timestamp')}.${first.body}`).digest('hex')}`);
    const pending = await coordinator.fetch(call(`/v1/runs/${runId}/webhook`));
    expect(await pending.json()).toMatchObject({ status: 'pending', attempts: 1, lastStatus: 503 });
    const persisted = storage.values.get('runner-v1') as { runs: Record<string, { webhook: { nextAttemptAt: string } }> };
    expect(JSON.stringify(persisted)).not.toContain(webhookSecret);
    persisted.runs[runId]!.webhook.nextAttemptAt = new Date(0).toISOString();
    await coordinator.alarm();
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]!.body)).toMatchObject({ eventId: `terminal:${runId}` });
    const delivered = await coordinator.fetch(call(`/v1/runs/${runId}/webhook`));
    expect(await delivered.json()).toMatchObject({ status: 'delivered', attempts: 2, lastStatus: 204 });
    await coordinator.alarm();
    expect(sent).toHaveLength(2);
  });

  it('rejects a foreign or unregistered webhook without creating a run', async () => {
    const { coordinator, env, storage } = setup();
    provision(env);
    const foreign = await coordinator.fetch(call('/v1/runs', { ...body, webhookId: 'wh-a' }, { 'idempotency-key': 'foreign-webhook' },
      { ...principal, principalId: 'other-principal' }));
    expect(foreign.status).toBe(404);
    const unknown = await coordinator.fetch(call('/v1/runs', { ...body, webhookId: 'not-registered' }, { 'idempotency-key': 'unknown-webhook' }));
    expect(unknown.status).toBe(404);
    expect((storage.values.get('runner-v1') as { runs: Record<string, unknown> }).runs).toEqual({});
  });

  it('refuses insecure endpoint configuration and keeps production webhook admission closed', async () => {
    const { coordinator, env } = setup();
    provision(env);
    env.RUNNER_WEBHOOKS = JSON.stringify([{ webhookId: 'wh-a', principalId: principal.principalId, profileId: principal.profileId,
      url: 'http://127.0.0.1/collect', secretBinding: 'RUNNER_WEBHOOK_SECRET_A' }]);
    expect((await coordinator.fetch(call('/v1/runs', { ...body, webhookId: 'wh-a' }, { 'idempotency-key': 'bad-url' }))).status).toBe(503);
    provision(env);
    env.DEPLOYMENT_ENV = 'production';
    expect((await coordinator.fetch(call('/v1/runs', { ...body, webhookId: 'wh-a' }, { 'idempotency-key': 'prod-webhook' }))).status).toBe(422);
  });

  it('stops after eight failed deliveries and protects a pending webhook from cleanup', async () => {
    const { coordinator, env, storage } = setup();
    provision(env);
    let sent = 0;
    const workerFetch = env.FETCH!;
    env.FETCH = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname !== 'hooks.customer.com') return workerFetch(input, init);
      sent += 1;
      return new Response(null, { status: 503 });
    };
    const submitted = await coordinator.fetch(call('/v1/runs', { ...body, webhookId: 'wh-a' }, { 'idempotency-key': 'webhook-exhaustion' }));
    const { runId } = await submitted.json() as { runId: string };
    await coordinator.alarm();
    await coordinator.alarm();
    await coordinator.alarm();
    expect(sent).toBe(1);
    expect((await coordinator.fetch(call('/v1/sandbox/cleanup-task', { userTaskId: body.userTaskId }))).status).toBe(409);
    for (let attempt = 2; attempt <= 8; attempt++) {
      const persisted = storage.values.get('runner-v1') as { runs: Record<string, { webhook: { nextAttemptAt: string } }> };
      persisted.runs[runId]!.webhook.nextAttemptAt = new Date(0).toISOString();
      await coordinator.alarm();
    }
    expect(sent).toBe(8);
    const status = await coordinator.fetch(call(`/v1/runs/${runId}/webhook`));
    expect(await status.json()).toMatchObject({ status: 'failed', attempts: 8, lastStatus: 503 });
    await coordinator.alarm();
    expect(sent).toBe(8);
  });
});

describe('Cloudflare Runner API scoped active-run lookup route', () => {
  it('routes GET by exact task id and requires runs:read', async () => {
    const secret = 'production-api-key-for-test-only';
    const keyHash = createHash('sha256').update(secret).digest('hex');
    const calls: Request[] = [];
    const makeEnv = (scopes: string[]) => ({
      DEPLOYMENT_ENV: 'production',
      RUNNER_API_KEYS_PRODUCTION: JSON.stringify([{ keyHash, principalId: 'cp', tenantId: 'tenant', profileId: 'profile',
        repository: 'trained-assist/ai-agent-runner', scopes, engines: ['eu-vm-agent-run'] }]),
      RUNNER_API_KEYS: '[]', VM_WORKER_URL: 'https://france.example', VM_WORKER_TOKEN: 'test-worker-token',
      RUNNER_API_PUBLIC_URL: 'https://runner.example', RUN_LAUNCH_ENCRYPTION_KEY: 'test-launch-key-at-least-32-characters',
      ALLOWED_REPOSITORIES: 'trained-assist/ai-agent-runner', RUNNER_RUNS: {
        idFromName: (name: string) => name,
        get: (_id: unknown) => ({ fetch: async (request: Request) => {
          calls.push(request);
          return Response.json({ runs: [], nextCursor: null });
        } }),
      },
    }) as unknown as RunnerWorkerEnv;

    const headers = { authorization: `Bearer ${secret}` };
    const response = await runnerWorker.fetch(new Request('https://runner.example/v1/runs?state=active&userTaskId=task-1', { headers }), makeEnv(['runs:read']));
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('userTaskId=task-1');
    expect(calls[0]?.headers.get('x-runner-principal')).toContain('"principalId":"cp"');

    const malformed = await runnerWorker.fetch(new Request('https://runner.example/v1/runs?state=active&userTaskId=bad%20id', { headers }), makeEnv(['runs:read']));
    expect(malformed.status).toBe(400);
    const forbidden = await runnerWorker.fetch(new Request('https://runner.example/v1/runs?state=active&userTaskId=task-1', { headers }), makeEnv(['runs:write']));
    expect(forbidden.status).toBe(403);
    expect(calls).toHaveLength(1);
  });
});
