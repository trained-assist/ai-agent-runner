import { describe, expect, it } from 'vitest';
import { RunnerRunCoordinator } from '../src/cloudflare/run-coordinator.js';
import type { ApiPrincipal, DurableObjectStateLike, DurableStorage, RunnerWorkerEnv } from '../src/cloudflare/types.js';

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
      if (url.pathname.endsWith('/status')) return Response.json({ status: ++poll === 1 ? 'running' : 'succeeded' });
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

describe('Cloudflare Runner run coordinator', () => {
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

  it('launches through the configured VM worker and persists status/result across alarm cycles', async () => {
    const { coordinator, launched } = setup();
    const response = await coordinator.fetch(call('/v1/runs', body, { 'idempotency-key': 'attempt-2' }));
    const receipt = await response.json() as { runId: string };
    await coordinator.alarm();
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ engine: { name: 'eu-vm-agent-run' }, input: { inlinePrompt: 'say done' }, resultUrl: `https://runner-api.example/v1/runs/${receipt.runId}/result` });
    await coordinator.alarm();
    await coordinator.alarm();
    const status = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/status`));
    expect(await status.json()).toMatchObject({ state: 'succeeded', answer: 'done' });
    const result = await coordinator.fetch(call(`/v1/runs/${receipt.runId}/result`));
    expect(await result.json()).toMatchObject({ outcome: 'succeeded', text: 'done' });
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
});
