import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import runnerApi from '../src/cloudflare/runner-api.js';
import { RunnerGithubConnection } from '../src/cloudflare/github-connection.js';
import type { DurableObjectStateLike, DurableStorage, RunnerWorkerEnv } from '../src/cloudflare/types.js';

class MemoryStorage implements DurableStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async setAlarm(): Promise<void> {}
  async getAlarm(): Promise<number | null> { return null; }
  async deleteAlarm(): Promise<void> {}
  async transaction<T>(callback: (transaction: DurableStorage) => Promise<T>): Promise<T> { return callback(this); }
}

describe('ZeroCreds GitHub token connection', () => {
  it('creates a one-use form, verifies GitHub, stores only ciphertext, enforces owner and revokes', async () => {
    const apiKey = 'developer-api-key';
    const githubToken = 'github_pat_test_private_value';
    const storages = new Map<string, MemoryStorage>();
    const objects = new Map<string, RunnerGithubConnection>();
    let formRequest: Record<string, unknown> | undefined;
    const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (target === 'https://zerocreds.example/api/session/create') {
        formRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ url: 'https://zerocreds.example/f/0123456789abcdef0123456789abcdef', expires_at: new Date(Date.now() + 600_000).toISOString() });
      }
      if (target === 'https://api.github.com/user') {
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${githubToken}`) return Response.json({}, { status: 401 });
        return Response.json({ id: 12345, login: 'customer' });
      }
      if (target === 'https://api.github.com/repos/trained-assist/ai-agent-runner') return Response.json({ permissions: { push: true, pull: true } });
      throw new Error(`unexpected target ${target}`);
    });
    const env = {
      RUNNER_API_KEYS: JSON.stringify([{ keyHash: createHash('sha256').update(apiKey).digest('hex'), principalId: 'customer', profileId: 'customer-profile', tenantId: 'customer-tenant',
        repository: 'trained-assist/ai-agent-runner', scopes: ['runs:read', 'runs:write'], developerApi: true }]),
      RUNNER_DEVELOPER_API_ENABLED: 'true', RUNNER_API_PUBLIC_URL: 'https://runner.example',
      RUNNER_GITHUB_CONNECTION_KEY: 'ab'.repeat(32), ZEROCREDS_API_URL: 'https://zerocreds.example', ZEROCREDS_INTEGRATOR_TOKEN: 'integrator-secret',
      RUNNER_GITHUB_CONNECTIONS: { idFromName: (name: string) => name, get: (name: string) => {
        if (!objects.has(name)) {
          const storage = new MemoryStorage(); storages.set(name, storage);
          const state: DurableObjectStateLike = { storage, blockConcurrencyWhile: async (callback) => callback() };
          objects.set(name, new RunnerGithubConnection(state, env as unknown as RunnerWorkerEnv));
        }
        return objects.get(name)!;
      } },
      FETCH: network,
    } as unknown as RunnerWorkerEnv;
    const auth = { authorization: `Bearer ${apiKey}` };
    const created = await runnerApi.fetch(new Request('https://runner.example/v1/developer/github/connections', { method: 'POST', headers: auth }), env);
    expect(created.status).toBe(201);
    const setup = await created.json() as { connectionId: string; formUrl: string };
    expect(setup.formUrl).toBe('https://zerocreds.example/f/0123456789abcdef0123456789abcdef');
    expect(JSON.stringify(setup)).not.toContain('integrator-secret');
    const destination = formRequest?.['destination'] as { url: string };
    expect(destination.url).toMatch(/^https:\/\/runner\.example\/v1\/developer\/github\/intake\/ghc_[0-9a-f]{32}\/[0-9a-f]{64}$/);
    const preflight = await runnerApi.fetch(new Request(destination.url, { method: 'POST', headers: { 'x-zerocreds-preflight': 'true', 'content-type': 'application/json' }, body: JSON.stringify({ _zerocreds_preflight: true }) }), env);
    expect(preflight.status).toBe(204);
    const invalid = await runnerApi.fetch(new Request(destination.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) }), env);
    expect(invalid.status).toBe(422);
    const intake = await runnerApi.fetch(new Request(destination.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: githubToken }) }), env);
    expect(intake.status).toBe(200);
    const stored = storages.get(setup.connectionId)!.values.get('github-connection');
    expect(JSON.stringify(stored)).not.toContain(githubToken);
    expect(JSON.stringify(stored)).not.toContain(destination.url.split('/').at(-1));
    const status = await runnerApi.fetch(new Request(`https://runner.example/v1/developer/github/connections/${setup.connectionId}`, { headers: auth }), env);
    expect(await status.json()).toMatchObject({ status: 'connected', github: { id: 12345, login: 'customer', repositoryAccess: 'push' } });
    const otherKey = 'other-developer-key';
    env.RUNNER_API_KEYS = JSON.stringify([...JSON.parse(env.RUNNER_API_KEYS) as unknown[], { keyHash: createHash('sha256').update(otherKey).digest('hex'), principalId: 'other', profileId: 'other-profile',
      repository: 'trained-assist/ai-agent-runner', scopes: ['runs:read', 'runs:write'], developerApi: true }]);
    expect((await runnerApi.fetch(new Request(`https://runner.example/v1/developer/github/connections/${setup.connectionId}`, { headers: { authorization: `Bearer ${otherKey}` } }), env)).status).toBe(404);
    expect((await runnerApi.fetch(new Request(destination.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: githubToken }) }), env)).status).toBe(410);
    const revoked = await runnerApi.fetch(new Request(`https://runner.example/v1/developer/github/connections/${setup.connectionId}`, { method: 'DELETE', headers: auth }), env);
    expect(await revoked.json()).toMatchObject({ status: 'revoked' });
    expect(JSON.stringify(storages.get(setup.connectionId)!.values.get('github-connection'))).not.toContain('ciphertext');
  });
});
