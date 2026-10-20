import { describe, expect, it } from 'vitest';
import { RunnerRunCoordinator, parseSandboxCredentials } from '../src/cloudflare/run-coordinator.js';
import type { ApiPrincipal, DurableObjectStateLike, DurableStorage, RunnerWorkerEnv } from '../src/cloudflare/types.js';
import { generateKeyPairSync } from 'node:crypto';

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
const PRIVATE_JWK = (() => {
  const { privateKey } = generateKeyPairSync('ed25519');
  return JSON.stringify(privateKey.export({ format: 'jwk' }));
})();
const SECRET = 'ghp_live_value_never_in_the_record';
const REGISTRY = JSON.stringify({ github: { connection_id: 'conn-1', env: 'GITHUB_TOKEN', field: 'token', scope: 'repo' } });

function claimsOf(authorization: string | null): Record<string, unknown> {
  const token = (authorization ?? '').replace(/^Bearer\s+/i, '');
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function setup(options: { bindingsEnabled?: string; registry?: string; grant?: () => Response } = {}) {
  const storage = new MemoryStorage();
  const launched: Record<string, unknown>[] = [];
  const walletCalls: { url: string; authorization: string | null }[] = [];
  let poll = 0;
  const state: DurableObjectStateLike = { storage, blockConcurrencyWhile: async (fn) => fn() };
  const env: RunnerWorkerEnv = {
    RUNNER_API_KEYS: '[]', VM_WORKER_URL: 'https://france.example', VM_WORKER_TOKEN: 'worker-secret',
    RUNNER_API_PUBLIC_URL: 'https://runner-api.example', RUN_LAUNCH_ENCRYPTION_KEY: 'encryption-key-long-enough-for-test-only',
    RUNNER_ENGINE: 'eu-vm-agent-run',
    ALLOWED_REPOSITORIES: 'trained-assist/ai-agent-runner', ALLOWED_ENVIRONMENT_NAMES: '', RUNNER_RUNS: {} as RunnerWorkerEnv['RUNNER_RUNS'],
    RUNNER_CREDENTIAL_BINDINGS_ENABLED: options.bindingsEnabled ?? 'true',
    ZEROCREDS_WALLET_CREDENTIALS: options.registry ?? REGISTRY,
    ZEROCREDS_WALLET_API_URL: 'https://wallet.example',
    ZEROCREDS_WALLET_ASSERTION_ISSUER: 'runner-host',
    ZEROCREDS_WALLET_ASSERTION_KID: 'runner-host-1',
    ZEROCREDS_WALLET_ASSERTION_PRIVATE_JWK: PRIVATE_JWK,
    ZEROCREDS_WALLET_PROFILES: JSON.stringify({ 'profile-a': { owner_id: 'owner-1', profile_id: 'wallet-profile-1' } }),
    FETCH: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === 'wallet.example') {
        walletCalls.push({ url: url.href, authorization: new Headers(init?.headers).get('authorization') });
        return options.grant ? options.grant() : Response.json({ connection_id: 'conn-1', value: { token: SECRET }, version: 3, expires_at: '2026-10-20T12:05:00.000Z' });
      }
      if (url.pathname === '/v1/launch') {
        launched.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ runId: launched.at(-1)?.['runId'], operationId: 'op-test', status: 'accepted' }, { status: 202 });
      }
      if (url.pathname.endsWith('/status')) {
        const status = ++poll === 1 ? 'running' : 'succeeded';
        return Response.json({ status, state: status });
      }
      if (url.pathname.endsWith('/logs')) return Response.json({ cursor: 0, hasMore: false, state: 'running', logs: [] });
      if (url.pathname.endsWith('/result')) return Response.json({ exitReason: 'completed', exitCode: 0, answer: 'done', artifacts: [], logUrl: '', repo: null });
      return Response.json({ status: 'cancelled' });
    },
  };
  const coordinator = new RunnerRunCoordinator(state, env);
  return { coordinator, storage, launched, walletCalls, env };
}

function call(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://runner-runs.internal${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-runner-principal': JSON.stringify(principal), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

const body = { userTaskId: 'task-a', input: { inlinePrompt: 'say done' }, envAllowlist: [], limits: { timeoutMs: 300_000 } };

describe('Cloudflare Runner credential bindings', () => {
  it('resolves a declared credential at dispatch and keeps the value out of the record', async () => {
    const { coordinator, storage, launched, walletCalls } = setup();
    const submitted = await coordinator.fetch(call('/v1/runs', { ...body, credentialBindings: [{ ref: 'github', scope: 'repo' }] }, { 'idempotency-key': 'credential-run' }));
    expect(submitted.status).toBe(202);
    const { runId } = await submitted.json() as { runId: string };

    // Nothing is asked for at admission: the value is resolved when the run starts.
    expect(walletCalls).toHaveLength(0);
    await coordinator.alarm();
    expect(walletCalls).toHaveLength(1);
    expect(walletCalls[0]!.url).toBe('https://wallet.example/api/wallet/connections/conn-1/grants');
    const claims = claimsOf(walletCalls[0]!.authorization);
    expect(claims).toMatchObject({ iss: 'runner-host', aud: 'zerocreds-wallet:machine', caller_class: 'machine',
      owner_id: 'owner-1', profile_id: 'wallet-profile-1', run_id: runId });
    expect(claims['operations']).toContain('wallet.connections.grant');

    expect(launched).toHaveLength(1);
    expect(launched[0]!['env']).toMatchObject({ GITHUB_TOKEN: SECRET });
    expect(launched[0]!['envAllowlist']).toContain('GITHUB_TOKEN');

    // The stored record and the answers never hold the value.
    const stored = storage.values.get('runner-v1') as { runs: Record<string, unknown> };
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(JSON.stringify(stored.runs[runId])).not.toContain(SECRET);
    const status = await coordinator.fetch(call(`/v1/runs/${runId}/status`));
    expect(await status.text()).not.toContain(SECRET);
  });

  it('refuses a binding that the host policy does not allow', async () => {
    const { coordinator, launched } = setup();
    const unknown = await coordinator.fetch(call('/v1/runs', { ...body, credentialBindings: [{ ref: 'other', scope: 'repo' }] }, { 'idempotency-key': 'unknown-ref' }));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'CREDENTIAL_NOT_FOUND' } });

    const scope = await coordinator.fetch(call('/v1/runs', { ...body, credentialBindings: [{ ref: 'github', scope: 'admin' }] }, { 'idempotency-key': 'wrong-scope' }));
    expect(scope.status).toBe(403);
    expect(await scope.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const malformed = await coordinator.fetch(call('/v1/runs', { ...body, credentialBindings: [{ ref: 'github', scope: 'repo', env: 'OTHER' }] }, { 'idempotency-key': 'malformed' }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIAL_BINDING' } });

    expect(launched).toHaveLength(0);
  });

  it('keeps the feature off unless the lane enables it', async () => {
    const { coordinator } = setup({ bindingsEnabled: 'false' });
    const response = await coordinator.fetch(call('/v1/runs', { ...body, credentialBindings: [{ ref: 'github', scope: 'repo' }] }, { 'idempotency-key': 'disabled' }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'FEATURE_UNSUPPORTED' } });
  });

  it('fails the run closed when the credential was revoked after intake', async () => {
    const { coordinator, launched, walletCalls } = setup({
      grant: () => Response.json({ error: 'value_unavailable' }, { status: 404 }),
    });
    const submitted = await coordinator.fetch(call('/v1/runs', { ...body, credentialBindings: [{ ref: 'github', scope: 'repo' }] }, { 'idempotency-key': 'revoked' }));
    const { runId } = await submitted.json() as { runId: string };
    await coordinator.alarm();
    expect(walletCalls).toHaveLength(1);
    expect(launched).toHaveLength(0);
    const status = await coordinator.fetch(call(`/v1/runs/${runId}/status`));
    expect(await status.json()).toMatchObject({ state: 'failed' });
  });

  it('parses a host credential registry and refuses a malformed one', () => {
    const registry = parseSandboxCredentials(REGISTRY);
    expect(registry['github']).toMatchObject({ connectionId: 'conn-1', env: 'GITHUB_TOKEN', field: 'token', scope: 'repo' });
    expect(parseSandboxCredentials(undefined)).toEqual({});
    expect(() => parseSandboxCredentials('not json')).toThrow();
    expect(() => parseSandboxCredentials(JSON.stringify({ github: { connection_id: 'c', env: 'lowercase', scope: 'repo' } }))).toThrow();
    expect(() => parseSandboxCredentials(JSON.stringify({ github: { connection_id: 'c', env: 'GITHUB_TOKEN', scope: 'repo', extra: 1 } }))).toThrow();
  });
});
