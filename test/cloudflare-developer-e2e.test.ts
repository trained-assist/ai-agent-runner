import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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
    const guestToken = 'guest-end-to-end-key';
    const launched: unknown[] = [];
    const historyBytes = JSON.stringify({ schemaVersion: 1, entries: [{ type: 'assistant_message', text: 'Checking the repository.' }] });
    const historySha = createHash('sha256').update(historyBytes).digest('hex');
    const storage = new MemoryStorage();
    const state: DurableObjectStateLike = { storage, blockConcurrencyWhile: async (fn) => fn() };
    let coordinator: RunnerRunCoordinator;
    const env = {
      RUNNER_API_KEYS: JSON.stringify([{ keyHash: await sha256(token), principalId: 'developer', profileId: 'developer-profile',
        tenantId: 'tenant-a', repository: 'trained-assist/ai-agent-runner', scopes: ['runs:read', 'runs:write'], developerApi: true },
      { keyHash: await sha256(guestToken), principalId: 'guest', profileId: 'guest-profile',
        repository: 'trained-assist/ai-agent-runner', scopes: ['runs:read', 'runs:write'], developerApi: true, developerGuest: true }]),
      VM_WORKER_URL: 'https://france.example', VM_WORKER_TOKEN: 'worker-secret',
      RUNNER_API_PUBLIC_URL: 'https://api.example', RUN_LAUNCH_ENCRYPTION_KEY: 'test-encryption-key-with-more-than-32-characters',
      RUNNER_ENGINE: 'eu-vm-agent-run', LLM_LADDER_TOKEN: 'managed-token',
      RUNNER_DEVELOPER_API_ENABLED: 'true',
      RUNNER_GUEST_DOWNLOAD_SECRET: 'a-guest-download-signing-secret-at-least-32-characters',
      ALLOWED_ENVIRONMENT_NAMES: 'LLM_LADDER_TOKEN', ALLOWED_REPOSITORIES: 'trained-assist/ai-agent-runner',
      RUNNER_RUNS: { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => coordinator.fetch(request) }) },
      FETCH: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const path = url.pathname;
        if (path === '/v1/launch') {
          const launch = JSON.parse(String(init?.body)) as Record<string, unknown>;
          launched.push(launch);
          return Response.json({ runId: launch['runId'], operationId: launch['operationId'], status: 'accepted',
            statusUrl: 'https://france.example/status', resultUrl: 'https://france.example/result' }, { status: 202 });
        }
        if (path.endsWith('/status')) return Response.json({ status: 'succeeded', state: 'succeeded' });
        if (path.endsWith('/result')) return Response.json({ exitReason: 'completed', exitCode: 0, exitSignal: null,
          answer: 'SDK generated', artifacts: [{ path: 'output/readme.txt', name: 'readme.txt', mime: 'text/plain', size: 3,
            sha256: 'a'.repeat(64) }], logUrl: '', repo: null });
        if (path.endsWith('/logs')) return Response.json({ logs: [], cursor: 0, hasMore: false, state: 'succeeded' });
        if (path.endsWith('/history')) {
          if (url.searchParams.get('manifest') === '1') return Response.json({ path: '__runner/agent-history.json',
            name: 'agent-history.json', mime: 'application/json', size: Buffer.byteLength(historyBytes), sha256: historySha });
          return new Response(historyBytes, { headers: { 'content-type': 'application/json', 'x-content-sha256': historySha } });
        }
        if (path.endsWith('/artifacts') && url.searchParams.get('path') === 'output/readme.txt') {
          return new Response('SDK', { headers: { 'content-type': 'text/plain', 'x-content-sha256': 'a'.repeat(64) } });
        }
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
    expect(await status.json()).toMatchObject({ state: 'succeeded', createdAt: expect.any(String), finishedAt: expect.any(String) });
    const result = await runnerApi.fetch(new Request(`https://api.example/v1/developer/runs/${receipt.runId}/result`, { headers }), env);
    const registeredResult = await result.json() as { text: string; outputRefs: string[] };
    expect(registeredResult.text).toBe('SDK generated');
    const registeredHistoryUrl = `https://api.example/v1/developer/runs/${receipt.runId}/artifacts?path=__runner%2Fagent-history.json`;
    expect(registeredResult.outputRefs).toContain(registeredHistoryUrl);
    const registeredHistory = await runnerApi.fetch(new Request(registeredHistoryUrl, { headers }), env);
    expect(await registeredHistory.json()).toMatchObject({ entries: [{ type: 'assistant_message' }] });
    expect((await runnerApi.fetch(new Request(registeredHistoryUrl, { headers: { authorization: `Bearer ${guestToken}` } }), env)).status).toBe(404);
    const cancel = await runnerApi.fetch(new Request(`https://api.example/v1/developer/runs/${receipt.runId}/cancel`, {
      method: 'POST', headers,
    }), env);
    expect(await cancel.json()).toMatchObject({ status: 'already_terminal', runId: receipt.runId });
    const capabilities = await runnerApi.fetch(new Request('https://api.example/v1/developer/capabilities', { headers }), env);
    expect(await capabilities.json()).toMatchObject({ managedAvailable: true, features: { billing: false } });

    const guestHeaders = { authorization: `Bearer ${guestToken}`, 'idempotency-key': 'guest-task-1', 'content-type': 'application/json' };
    const guestSubmit = await runnerApi.fetch(new Request('https://api.example/v1/developer/runs', { method: 'POST', headers: guestHeaders,
      body: JSON.stringify({ prompt: 'Generate a file', model: { mode: 'managed' } }) }), env);
    expect(guestSubmit.status).toBe(202);
    const guestRunId = (await guestSubmit.json() as { runId: string }).runId;
    for (let attempt = 0; attempt < 4; attempt++) await coordinator.alarm();
    const guestResultResponse = await runnerApi.fetch(new Request(`https://api.example/v1/developer/runs/${guestRunId}/result`, { headers: guestHeaders }), env);
    const guestResult = await guestResultResponse.json() as { outputRefs: string[]; artifacts: Array<{ path: string; downloadUrl: string; expiresAt: string }> };
    expect(guestResult.artifacts).toHaveLength(2);
    expect(guestResult.outputRefs).toEqual(guestResult.artifacts.map((artifact) => artifact.downloadUrl));
    const history = guestResult.artifacts.find((artifact) => artifact.path === '__runner/agent-history.json')!;
    expect(Date.parse(history.expiresAt) - Date.now()).toBeGreaterThan(23 * 60 * 60_000);
    const historyDownload = await runnerApi.fetch(new Request(history.downloadUrl), env);
    expect(await historyDownload.json()).toMatchObject({ entries: [{ type: 'assistant_message', text: 'Checking the repository.' }] });
    const link = guestResult.artifacts[0]!.downloadUrl;
    const downloaded = await runnerApi.fetch(new Request(link), env);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe('SDK');
    const tampered = new URL(link);
    tampered.searchParams.set('path', 'output/other.txt');
    expect((await runnerApi.fetch(new Request(tampered), env)).status).toBe(404);
    const forgedSignature = new URL(link);
    forgedSignature.searchParams.set('signature', '0'.repeat(64));
    expect((await runnerApi.fetch(new Request(forgedSignature), env)).status).toBe(404);
    expect((await runnerApi.fetch(new Request(`https://api.example/v1/developer/downloads/${receipt.runId}?${new URL(link).searchParams}`), env)).status).toBe(404);
    const normalArtifacts = await runnerApi.fetch(new Request(`https://api.example/v1/developer/runs/${receipt.runId}/artifacts`, { headers }), env);
    expect((await normalArtifacts.json() as { artifacts: Array<Record<string, unknown>> }).artifacts[0]).not.toHaveProperty('downloadUrl');
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(guestResult.artifacts[0]!.expiresAt) + 1);
    try {
      expect((await runnerApi.fetch(new Request(link), env)).status).toBe(410);
      expect((await runnerApi.fetch(new Request(history.downloadUrl), env)).status).toBe(410);
      expect((await runnerApi.fetch(new Request(`https://api.example/v1/developer/runs/${guestRunId}/artifacts`, { headers: guestHeaders }), env)).status).toBe(410);
    } finally { dateNow.mockRestore(); }
  });
});
