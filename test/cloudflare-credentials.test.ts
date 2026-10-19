import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import runnerApi, { sha256 } from '../src/cloudflare/runner-api.js';
import type { RunnerWorkerEnv } from '../src/cloudflare/types.js';

const KEY = 'credential-intake-key';
const PRIVATE_JWK = (() => {
  const { privateKey } = generateKeyPairSync('ed25519');
  return JSON.stringify(privateKey.export({ format: 'jwk' }));
})();

function claimsOf(authorization: string | null): Record<string, unknown> {
  const token = (authorization ?? '').replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  expect(parts).toHaveLength(3);
  return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function environment(scopes: string[], fetchImpl: typeof fetch, profiles?: string): Promise<RunnerWorkerEnv> {
  return {
    RUNNER_API_KEYS: JSON.stringify([{ keyHash: await sha256(KEY), principalId: 'principal-one', profileId: 'profile-one',
      repository: 'team/profile-one', scopes }]),
    ZEROCREDS_WALLET_API_URL: 'https://wallet.example',
    ZEROCREDS_WALLET_ASSERTION_ISSUER: 'runner-host',
    ZEROCREDS_WALLET_ASSERTION_KID: 'runner-host-1',
    ZEROCREDS_WALLET_ASSERTION_PRIVATE_JWK: PRIVATE_JWK,
    ZEROCREDS_WALLET_PROFILES: profiles ?? JSON.stringify({ 'profile-one': { owner_id: 'owner-1', profile_id: 'wallet-profile-1' } }),
    FETCH: fetchImpl,
    RUNNER_RUNS: { idFromName: vi.fn(), get: vi.fn() },
  } as unknown as RunnerWorkerEnv;
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://api.example/v1/credentials', { method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function get(connectionId: string): Request {
  return new Request(`https://api.example/v1/credentials/${connectionId}`, { headers: { authorization: `Bearer ${KEY}` } });
}

function revoke(connectionId: string): Request {
  return new Request(`https://api.example/v1/credentials/${connectionId}`, { method: 'DELETE', headers: { authorization: `Bearer ${KEY}` } });
}

describe('Cloudflare Runner API credential intake', () => {
  it('creates a credential form for the authenticated profile and returns no secret material', async () => {
    const calls: { url: string; authorization: string | null; body: string | null }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), body: typeof init?.body === 'string' ? init.body : null });
      return Response.json({ form_id: 'a'.repeat(32), connection_id: 'conn-1', url: 'https://wallet.example/f/form-1',
        status_url: 'https://wallet.example/api/wallet/forms/form-1/status', expires_at: '2026-10-20T12:00:00.000Z', state: 'pending' });
    }) as unknown as typeof fetch;
    const env = await environment(['credentials:write'], fetchImpl);
    const response = await runnerApi.fetch(post({ provider: 'github', ttl_minutes: 60 }), env);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ connection_id: 'conn-1', form_id: 'a'.repeat(32), form_url: 'https://wallet.example/f/form-1',
      status_url: 'https://wallet.example/api/wallet/forms/form-1/status', expires_at: '2026-10-20T12:00:00.000Z', state: 'pending' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://wallet.example/api/wallet/forms');
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ provider: 'github', ttl_minutes: 60 });
    const claims = claimsOf(calls[0]!.authorization);
    expect(claims).toMatchObject({ iss: 'runner-host', aud: 'zerocreds-wallet:human', owner_id: 'owner-1', profile_id: 'wallet-profile-1',
      caller_class: 'human', operations: ['wallet.forms.create', 'wallet.connections.status'] });
    expect(String(claims['jti'])).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(Number(claims['exp']) - Number(claims['iat'])).toBeLessThanOrEqual(300);
  });

  it('mints a fresh assertion per call so the wallet never sees a replayed identifier', async () => {
    const jtis: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      jtis.push(claimsOf(new Headers(init?.headers).get('authorization'))['jti']);
      return Response.json({ form_id: 'b'.repeat(32), connection_id: 'conn-2', url: 'https://wallet.example/f/form-2', state: 'pending' });
    }) as unknown as typeof fetch;
    const env = await environment(['credentials:write'], fetchImpl);
    await runnerApi.fetch(post({ provider: 'github' }), env);
    await runnerApi.fetch(post({ provider: 'github' }), env);
    expect(jtis[0]).not.toBe(jtis[1]);
  });

  it('reads value-free connection status for a connection the profile owns', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ connection_id: 'conn-1', provider: 'github', state: 'allocated', kv_version: 3, updated_at: '2026-10-20T10:00:00.000Z' });
    }) as unknown as typeof fetch;
    const env = await environment(['credentials:read'], fetchImpl);
    const response = await runnerApi.fetch(get('conn-1'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection_id: 'conn-1', provider: 'github', state: 'allocated', kv_version: 3, updated_at: '2026-10-20T10:00:00.000Z' });
    expect(calls[0]).toBe('https://wallet.example/api/wallet/connections/conn-1');
  });

  it('requires the credential scopes and never calls the wallet without them', async () => {
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const env = await environment(['runs:read', 'runs:write'], fetchImpl);
    expect((await runnerApi.fetch(post({ provider: 'github' }), env)).status).toBe(403);
    expect((await runnerApi.fetch(get('conn-1'), env)).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a profile that has no wallet owner and profile binding', async () => {
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const env = await environment(['credentials:write'], fetchImpl, JSON.stringify({ 'other-profile': { owner_id: 'owner-1', profile_id: 'wallet-profile-1' } }));
    expect((await runnerApi.fetch(post({ provider: 'github' }), env)).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when the wallet configuration is missing or malformed', async () => {
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const base = await environment(['credentials:write'], fetchImpl);
    expect((await runnerApi.fetch(post({ provider: 'github' }), { ...base, ZEROCREDS_WALLET_API_URL: '' })).status).toBe(503);
    expect((await runnerApi.fetch(post({ provider: 'github' }), { ...base, ZEROCREDS_WALLET_ASSERTION_PRIVATE_JWK: '{not-json' })).status).toBe(503);
    expect((await runnerApi.fetch(post({ provider: 'github' }), { ...base, ZEROCREDS_WALLET_PROFILES: '[]' })).status).toBe(503);
    expect((await runnerApi.fetch(post({ provider: 'github' }), { ...base, ZEROCREDS_WALLET_API_URL: 'http://wallet.example' })).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a request that tries to choose the owner, the profile or an unknown field', async () => {
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const env = await environment(['credentials:write'], fetchImpl);
    for (const body of [{ provider: 'github', owner_id: 'attacker' }, { provider: 'github', profile_id: 'attacker' },
      { provider: 'github', destination: 'attacker' }, { provider: 'github', value: 'secret' }, { provider: '' }]) {
      expect((await runnerApi.fetch(post(body), env)).status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps wallet failures to typed errors without echoing the upstream body', async () => {
    const cases: { status: number; expected: number }[] = [
      { status: 400, expected: 400 }, { status: 401, expected: 502 }, { status: 404, expected: 404 },
      { status: 409, expected: 409 }, { status: 503, expected: 503 },
    ];
    for (const entry of cases) {
      const fetchImpl = vi.fn(async () => Response.json({ error: 'internal upstream detail' }, { status: entry.status })) as unknown as typeof fetch;
      const env = await environment(['credentials:write'], fetchImpl);
      const response = await runnerApi.fetch(post({ provider: 'github' }), env);
      expect(response.status).toBe(entry.expected);
      expect(JSON.stringify(await response.json())).not.toContain('internal upstream detail');
    }
    const failing = vi.fn(async () => { throw new Error('socket closed'); }) as unknown as typeof fetch;
    const env = await environment(['credentials:write'], failing);
    const response = await runnerApi.fetch(post({ provider: 'github' }), env);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('socket closed');
  });

  it('reports an infrastructure error in front of the wallet as unavailable, not as a missing credential', async () => {
    // Cloudflare answers a Worker-to-Worker request on the same account with a
    // plain error page instead of the wallet's JSON. Reporting that as a
    // missing credential would hide the real failure.
    const fetchImpl = vi.fn(async () => new Response('error code: 1042', { status: 404 })) as unknown as typeof fetch;
    const env = await environment(['credentials:write'], fetchImpl);
    const response = await runnerApi.fetch(post({ provider: 'github' }), env);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('1042');
  });

  it('keeps unsupported methods and unknown credential routes closed', async () => {
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const env = await environment(['credentials:write', 'credentials:read'], fetchImpl);
    expect((await runnerApi.fetch(new Request('https://api.example/v1/credentials', { headers: { authorization: `Bearer ${KEY}` } }), env)).status).toBe(405);
    expect((await runnerApi.fetch(new Request('https://api.example/v1/credentials/conn-1', { method: 'POST', headers: { authorization: `Bearer ${KEY}` } }), env)).status).toBe(405);
    expect((await runnerApi.fetch(new Request('https://api.example/v1/credentials/conn-1/secret', { headers: { authorization: `Bearer ${KEY}` } }), env)).status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('authenticates a credential principal from the dedicated credential registry alone', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ form_id: 'c'.repeat(32), connection_id: 'conn-3',
      url: 'https://wallet.example/f/form-3', state: 'pending' })) as unknown as typeof fetch;
    const base = await environment(['runs:read'], fetchImpl);
    const env = {
      ...base,
      RUNNER_API_KEYS_CREDENTIALS: JSON.stringify([{ keyHash: await sha256('credential-key'),
        principalId: 'credential-principal', profileId: 'credential-profile', repository: 'team/repo',
        scopes: ['credentials:read', 'credentials:write'] }]),
      ZEROCREDS_WALLET_PROFILES: JSON.stringify({ 'credential-profile': { owner_id: 'owner-1', profile_id: 'wallet-profile-1' } }),
    } as RunnerWorkerEnv;
    const request = new Request('https://api.example/v1/credentials', { method: 'POST',
      headers: { authorization: 'Bearer credential-key', 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'github' }) });
    const response = await runnerApi.fetch(request, env);
    expect(response.status).toBe(201);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a credential registry principal that has no credential scope', async () => {
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const base = await environment(['runs:read'], fetchImpl);
    const env = {
      ...base,
      RUNNER_API_KEYS_CREDENTIALS: JSON.stringify([{ keyHash: await sha256('credential-key'),
        principalId: 'credential-principal', profileId: 'credential-profile', repository: 'team/repo',
        scopes: ['runs:read'] }]),
    } as RunnerWorkerEnv;
    const request = new Request('https://api.example/v1/credentials', { method: 'POST',
      headers: { authorization: 'Bearer credential-key', 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'github' }) });
    expect((await runnerApi.fetch(request, env)).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('revokes a credential connection and asks the wallet to close it', async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return Response.json({ connection_id: 'conn-1', state: 'revoked' });
    }) as unknown as typeof fetch;
    const env = await environment(['credentials:write'], fetchImpl);
    const response = await runnerApi.fetch(revoke('conn-1'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection_id: 'conn-1', state: 'revoked' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://wallet.example/api/wallet/connections/conn-1/revoke');
    const claims = claimsOf(calls[0]!.authorization);
    expect(claims['operations']).toContain('wallet.connections.revoke');
    expect(claims).toMatchObject({ owner_id: 'owner-1', profile_id: 'wallet-profile-1', caller_class: 'human' });
  });

  it('refuses a revocation without the credential write scope', async () => {
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const env = await environment(['credentials:read'], fetchImpl);
    expect((await runnerApi.fetch(revoke('conn-1'), env)).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers a revocation of an unknown connection with a typed error and no upstream body', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: 'connection_unavailable' }, { status: 404 })) as unknown as typeof fetch;
    const env = await environment(['credentials:write'], fetchImpl);
    const response = await runnerApi.fetch(revoke('conn-1'), env);
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('connection_unavailable');
  });

  it('rejects a connection reference that is not a safe id before it reaches the wallet', async () => {
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const env = await environment(['credentials:write'], fetchImpl);
    expect((await runnerApi.fetch(revoke('bad$id'), env)).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
