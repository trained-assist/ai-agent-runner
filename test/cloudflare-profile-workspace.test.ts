import { describe, expect, it } from 'vitest';
import { RunnerRunCoordinator } from '../src/cloudflare/run-coordinator.js';
import { EMPTY_PROFILE_SNAPSHOT_SHA256, emptyProfileSnapshotBytes } from '../src/cloudflare/profile-workspace.js';
import type { ApiPrincipal, DurableObjectStateLike, DurableStorage, RunnerWorkerEnv } from '../src/cloudflare/types.js';
import { createHash } from 'node:crypto';

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
const LAUNCH_KEY = 'encryption-key-long-enough-for-test-only';

function setup(options: { result?: Record<string, unknown> } = {}) {
  const storage = new MemoryStorage();
  const launched: Record<string, unknown>[] = [];
  let poll = 0;
  const state: DurableObjectStateLike = { storage, blockConcurrencyWhile: async (fn) => fn() };
  const env: RunnerWorkerEnv = {
    RUNNER_API_KEYS: '[]', VM_WORKER_URL: 'https://france.example', VM_WORKER_TOKEN: 'worker-secret',
    RUNNER_API_PUBLIC_URL: 'https://runner-api.example', RUN_LAUNCH_ENCRYPTION_KEY: LAUNCH_KEY,
    RUNNER_ENGINE: 'eu-vm-agent-run',
    ALLOWED_REPOSITORIES: 'trained-assist/ai-agent-runner', ALLOWED_ENVIRONMENT_NAMES: '', RUNNER_RUNS: {} as RunnerWorkerEnv['RUNNER_RUNS'],
    FETCH: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/v1/launch') {
        launched.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ runId: launched.at(-1)?.['runId'], operationId: 'op-test', status: 'accepted' }, { status: 202 });
      }
      if (url.pathname.endsWith('/status')) {
        const status = ++poll === 1 ? 'running' : 'succeeded';
        return Response.json({ status, state: status });
      }
      if (url.pathname.endsWith('/logs')) return Response.json({ cursor: 0, hasMore: false, state: 'running', logs: [] });
      if (url.pathname.endsWith('/result')) {
        return Response.json({ exitReason: 'completed', exitCode: 0, answer: 'done', artifacts: [], logUrl: '', repo: null, ...(options.result ?? {}) });
      }
      return Response.json({ status: 'cancelled' });
    },
  };
  const coordinator = new RunnerRunCoordinator(state, env);
  return { coordinator, storage, launched };
}

async function decryptLaunch(ciphertext: string): Promise<Record<string, any>> {
  const [iv, cipher] = ciphertext.split('.');
  const key = await crypto.subtle.importKey('raw', new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(LAUNCH_KEY))),
    { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv!, 'base64url') }, key, Buffer.from(cipher!, 'base64url'));
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, any>;
}

function call(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://runner-runs.internal${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-runner-principal': JSON.stringify(principal), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

const body = { userTaskId: 'task-a', input: { inlinePrompt: 'say done' }, envAllowlist: [], limits: { timeoutMs: 300_000 } };

async function admittedRun(coordinator: RunnerRunCoordinator, extra: Record<string, unknown> = {}): Promise<string> {
  const submitted = await coordinator.fetch(call('/v1/runs', { ...body, ...extra }, { 'idempotency-key': `profile-${Math.random()}` }));
  expect(submitted.status).toBe(202);
  const { runId } = await submitted.json() as { runId: string };
  return runId;
}

describe('the Cloudflare lane profile workspace', () => {
  it('pins the base, mints the capability and names its own origin', async () => {
    const { coordinator, storage, launched } = setup();
    const runId = await admittedRun(coordinator, { profileWorkspace: {} });
    await coordinator.alarm();

    const stored = storage.values.get('runner-v1') as { runs: Record<string, { launchCiphertext: string }> };
    const launch = await decryptLaunch(stored.runs[runId]!.launchCiphertext);
    const workspace = launch['profileWorkspace'];
    expect(workspace).toMatchObject({ snapshotSha256: EMPTY_PROFILE_SNAPSHOT_SHA256, snapshotSize: 45,
      savebackUrl: `https://runner-api.example/v1/worker/launches/${runId}/profile-changes` });
    expect(String(workspace['snapshotUrl'])).toMatch(new RegExp(`/v1/worker/launches/${runId}/profile-snapshot$`));
    expect(String(workspace['savebackToken']).length).toBeGreaterThanOrEqual(32);

    // The base is pinned: the runner asks every profile workspace for a pinned base.
    expect(launch['repository']).toMatchObject({ revision: EMPTY_PROFILE_SNAPSHOT_SHA256.slice(0, 40) });

    // The launch carries the workspace to the worker and no GitHub credential.
    expect(launched).toHaveLength(1);
    expect(launched[0]!['profileWorkspace']).toMatchObject({ savebackUrl: workspace['savebackUrl'] });
    expect(launched[0]!['publicationToken']).toBeUndefined();
  });

  it('does not let the request choose the base, the destination or the capability', async () => {
    const { coordinator } = setup();
    const refused = await coordinator.fetch(call('/v1/runs', { ...body, profileWorkspace: { snapshotUrl: 'https://elsewhere.example/snapshot.tar.gz' } },
      { 'idempotency-key': 'profile-choose' }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('accepts the published bytes only with the run-scoped capability', async () => {
    const { coordinator, storage } = setup();
    const runId = await admittedRun(coordinator, { profileWorkspace: {} });
    const stored = storage.values.get('runner-v1') as { runs: Record<string, { launchCiphertext: string }> };
    const launch = await decryptLaunch(stored.runs[runId]!.launchCiphertext);
    const token = String(launch['profileWorkspace']['savebackToken']);
    const bytes = Buffer.from('token=[redacted]\n');
    const digest = createHash('sha256').update(bytes).digest('hex');

    const wrong = await coordinator.fetch(new Request(`https://runner-runs.internal/v1/worker/launches/${runId}/profile-changes?path=blast/leak.txt`,
      { method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(43)}`, 'x-content-sha256': digest, 'content-type': 'application/octet-stream' }, body: bytes }));
    expect(wrong.status).toBe(403);

    const mismatched = await coordinator.fetch(new Request(`https://runner-runs.internal/v1/worker/launches/${runId}/profile-changes?path=blast/leak.txt`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-content-sha256': 'b'.repeat(64), 'content-type': 'application/octet-stream' }, body: bytes }));
    expect(mismatched.status).toBe(400);

    const accepted = await coordinator.fetch(new Request(`https://runner-runs.internal/v1/worker/launches/${runId}/profile-changes?path=blast/leak.txt`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-content-sha256': digest, 'content-type': 'application/octet-stream' }, body: bytes }));
    expect(accepted.status).toBe(201);
    expect(await accepted.json() as { sha256: string }).toMatchObject({ sha256: digest });
  });

  it('serves back the bytes that landed, not only a hash of them', async () => {
    const { coordinator, storage } = setup();
    const runId = await admittedRun(coordinator, { profileWorkspace: {} });
    const stored = storage.values.get('runner-v1') as { runs: Record<string, { launchCiphertext: string }> };
    const launch = await decryptLaunch(stored.runs[runId]!.launchCiphertext);
    const token = String(launch['profileWorkspace']['savebackToken']);
    const bytes = Buffer.from('token=[redacted]\n');
    const digest = createHash('sha256').update(bytes).digest('hex');
    await coordinator.fetch(new Request(`https://runner-runs.internal/v1/worker/launches/${runId}/profile-changes?path=blast/leak.txt`,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-content-sha256': digest, 'content-type': 'application/octet-stream' }, body: bytes }));

    const manifest = await coordinator.fetch(call(`/v1/runs/${runId}/profile-changes`));
    expect(manifest.status).toBe(200);
    const body = await manifest.json() as { received: Array<{ path: string; sha256: string; size: number }> };
    expect(body.received).toEqual([{ path: 'blast/leak.txt', sha256: digest, size: bytes.length }]);

    const read = await coordinator.fetch(call(`/v1/runs/${runId}/profile-changes?path=${encodeURIComponent('blast/leak.txt')}`));
    expect(read.status).toBe(200);
    expect(read.headers.get('x-content-sha256')).toBe(digest);
    expect(await read.text()).toBe('token=[redacted]\n');

    const refused = await coordinator.fetch(call(`/v1/runs/${runId}/profile-changes?path=${encodeURIComponent('../escape')}`));
    expect(refused.status).toBe(400);
  });

  it('reports the manifest the worker published in the run result', async () => {
    const manifest = { files: [{ path: 'blast/leak.txt', sha256: 'c'.repeat(64), size: 15 }], deletes: [] };
    const { coordinator } = setup({ result: { profileChanges: manifest } });
    const runId = await admittedRun(coordinator, { profileWorkspace: {} });
    // One pass dispatches, the next polls the worker, the one after it takes the result.
    for (let pass = 0; pass < 3; pass += 1) await coordinator.alarm();
    const result = await coordinator.fetch(call(`/v1/runs/${runId}/result`));
    expect(result.status).toBe(200);
    const body = await result.json() as { profileChanges?: unknown; publicationOutcome?: string };
    expect(body.profileChanges).toEqual(manifest);
    expect(body.publicationOutcome).toBe('published');
  });

  it('serves the base it pinned: the snapshot bytes match the digest in the launch', async () => {
    const bytes = emptyProfileSnapshotBytes();
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(EMPTY_PROFILE_SNAPSHOT_SHA256);
    expect(bytes.length).toBe(45);
  });
});
