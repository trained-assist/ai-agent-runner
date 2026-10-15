import { describe, expect, it, vi } from 'vitest';
import runnerApi, { sha256 } from '../src/cloudflare/runner-api.js';
import { RunnerRunCoordinator } from '../src/cloudflare/run-coordinator.js';
import type { DurableObjectStateLike, DurableStorage, RunnerWorkerEnv } from '../src/cloudflare/types.js';

class MemoryStorage implements DurableStorage {
  values = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async setAlarm(value: number | Date): Promise<void> { this.alarmAt = Number(value); }
  async getAlarm(): Promise<number | null> { return this.alarmAt; }
  async deleteAlarm(): Promise<void> { this.alarmAt = null; }
  async transaction<T>(callback: (transaction: DurableStorage) => Promise<T>): Promise<T> { return callback(this); }
}

describe('developer API through the live coordinator contract', () => {
  it('runs a managed prompt to a result and deduplicates the same request', async () => {
    const token = 'developer-end-to-end-key';
    const launched: unknown[] = [];
    const storage = new MemoryStorage();
    const state: DurableObjectStateLike = { storage, blockConcurrencyWhile: async (fn) => fn() };
    let coordinator: RunnerRunCoordinator;
    const env = {
      RUNNER_API_KEYS: JSON.stringify([{ keyHash: await sha256(token), principalId: 'developer', profileId: 'developer-profile',
        tenantId: 'tenant-a', repository: 'trained-assist/ai-agent-runner', scopes: ['runs:read', 'runs:write'], developerApi: true }]),
      VM_WORKER_URL: 'https://france.example', VM_WORKER_TOKEN: 'worker-secret',
      RUNNER_API_PUBLIC_URL: 'https://api.example', RUN_LAUNCH_ENCRYPTION_KEY: 'test-encryption-key-with-more-than-32-characters',
      RUNNER_ENGINE: 'eu-vm-agent-run', LLM_LADDER_TOKEN: 'managed-token',
      RUNNER_DEVELOPER_API_ENABLED: 'true',
      ALLOWED_ENVIRONMENT_NAMES: 'LLM_LADDER_TOKEN', ALLOWED_REPOSITORIES: 'trained-assist/ai-agent-runner',
      RUNNER_RUNS: { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }) },
      FETCH: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
        if (path === '/v1/launch') {
          const launch = JSON.parse(String(init?.body)) as Record<string, unknown>;
          launched.push(launch);
          return Response.json({ runId: launch['runId'], operationId: launch['operationId'], status: 'accepted',
            statusUrl: 'https://france.example/status', resultUrl: 'https://france.example/result' }, { status: 202 });
        }
        if (path.endsWith('/status')) return Response.json({ status: 'succeeded', state: 'succeeded' });
        if (path.endsWith('/result')) return Response.json({ exitReason: 'completed', exitCode: 0, exitSignal: null,
          answer: 'SDK generated', artifacts: [], logUrl: '', repo: null });
        if (path.endsWith('/logs')) return Response.json({ logs: [], cursor: 0, hasMore: false, state: 'succeeded' });
        return Response.json({ status: 'ok' });
      }),
    } as unknown as RunnerWorkerEnv;
    coordinator = new RunnerRunCoordinator(state, env);
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'sdk-task-1', 'content-type': 'application/json' };
    const submit = () => runnerApi.fetch(new Request('https://api.example/v1/developer/runs', { method: 'POST', headers,
      body: JSON.stringify({ prompt: 'Generate an SDK', model: { mode: 'managed' } }) }), env);
    const first = await submit();
    expect(first.status).toBe(202);
    const receipt = await first.json() as { runId: string };
    const duplicate = await submit();
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json() as { runId: string }).runId).toBe(receipt.runId);
    for (let attempt = 0; attempt < 4; attempt++) await coordinator.alarm();
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ input: { inlinePrompt: 'Generate an SDK' }, envAllowlist: ['LLM_LADDER_TOKEN'] });
    const status = await runnerApi.fetch(new Request(`https://api.example/v1/developer/runs/${receipt.runId}`, { headers }), env);
    expect((await status.json() as { state: string }).state).toBe('succeeded');
    const result = await runnerApi.fetch(new Request(`https://api.example/v1/developer/runs/${receipt.runId}/result`, { headers }), env);
    expect((await result.json() as { text: string }).text).toBe('SDK generated');
    const capabilities = await runnerApi.fetch(new Request('https://api.example/v1/developer/capabilities', { headers }), env);
    expect(await capabilities.json()).toMatchObject({ managedAvailable: true, features: { billing: false } });
  });
});
