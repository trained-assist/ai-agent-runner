import { describe, expect, it, vi } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import runnerApi, { sha256 } from '../src/cloudflare/runner-api.js';
import type { RunnerWorkerEnv } from '../src/cloudflare/types.js';

describe('Cloudflare Runner API Worker', () => {
  it('authenticates hashed API keys and dispatches only to the Durable Object coordinator', async () => {
    const token = 'runner-api-secret';
    const keyHash = await sha256(token);
    const coordinatorFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get('x-runner-principal')).toContain('profile-one');
      expect(request.url).toBe('https://runner-runs.internal/v1/runs');
      return Response.json({ runId: 'run-1', deduplicated: false }, { status: 202 });
    });
    const env = {
      RUNNER_API_KEYS: JSON.stringify([{ keyHash, principalId: 'principal-one', profileId: 'profile-one', repository: 'team/profile-one', scopes: ['runs:read', 'runs:write'] }]),
      VM_WORKER_URL: 'https://france.example', VM_WORKER_TOKEN: 'worker-secret', RUNNER_API_PUBLIC_URL: 'https://api.example',
      RUN_LAUNCH_ENCRYPTION_KEY: 'test-only-encryption-key-at-least-32-chars', RUNNER_ENGINE: 'eu-vm-agent-run',
      ALLOWED_REPOSITORIES: 'trained-assist/ai-agent-runner', RUNNER_RUNS: { idFromName: vi.fn().mockReturnValue('runs-do'), get: vi.fn().mockReturnValue({ fetch: coordinatorFetch }) },
    } as unknown as RunnerWorkerEnv;
    const request = new Request('https://api.example/v1/runs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'attempt-1', 'content-type': 'application/json' }, body: JSON.stringify({ userTaskId: 'task-one' }) });
    const response = await runnerApi.fetch(request, env);
    expect(response.status).toBe(202);
    expect(JSON.parse(coordinatorFetch.mock.calls[0]![0].headers.get('x-runner-principal')!)).toMatchObject({ repository: 'team/profile-one' });
    expect(env.RUNNER_RUNS.idFromName).toHaveBeenCalledWith(expect.stringMatching(/^task-[0-9a-f]{64}$/));
    expect(coordinatorFetch).toHaveBeenCalledOnce();
  });

  it('rejects an invalid key before any coordinator call', async () => {
    const get = vi.fn();
    const env = { RUNNER_API_KEYS: '[]', RUNNER_RUNS: { idFromName: vi.fn(), get } } as unknown as RunnerWorkerEnv;
    const response = await runnerApi.fetch(new Request('https://api.example/v1/runs', { method: 'POST' }), env);
    expect(response.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects a real execution principal without a trusted repository binding', async () => {
    const get = vi.fn();
    const env = {
      RUNNER_API_KEYS: JSON.stringify([{ keyHash: await sha256('runner-api-secret'), principalId: 'principal-one', profileId: 'profile-one', scopes: ['runs:read', 'runs:write'] }]),
      RUNNER_RUNS: { idFromName: vi.fn(), get },
    } as unknown as RunnerWorkerEnv;
    const response = await runnerApi.fetch(new Request('https://api.example/v1/capabilities', { headers: { authorization: 'Bearer runner-api-secret' } }), env);
    expect(response.status).toBe(503);
    expect(get).not.toHaveBeenCalled();
  });

  it('accepts the exact pinned test MCP principal without a repository binding', async () => {
    const token = 'runner-api-mcp-test';
    const keyHash = await sha256(token);
    const coordinatorFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get('x-runner-principal')).toContain('registry-mcp-test-160-read');
      return Response.json({ runId: 'run-test' }, { status: 202 });
    });
    const env = {
      RUNNER_API_KEYS: JSON.stringify([{ keyHash, principalId: 'integration-telegram-ux-v1', profileId: 'integration-telegram-ux-v1', scopes: ['runs:read', 'runs:write'], mcpBindings: ['registry-mcp-test-160-read'] }]),
      RUNNER_RUNS: { idFromName: vi.fn().mockReturnValue('runs-do'), get: vi.fn().mockReturnValue({ fetch: coordinatorFetch }) },
    } as unknown as RunnerWorkerEnv;
    const response = await runnerApi.fetch(new Request('https://api.example/v1/runs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'mcp-test', 'content-type': 'application/json' }, body: JSON.stringify({ userTaskId: 'task-telegram' }) }), env);
    expect(response.status).toBe(202);
    expect(coordinatorFetch).toHaveBeenCalledOnce();
  });
});

describe('Cloudflare Runner delegated profile capability', () => {
  const apiKey = 'delegated-test-api-key';
  const delegationSecret = 'delegated-test-profile-secret';
  const tenantId = 'tenant-a';
  const profileId = 'profile-delegated';

  function delegatedSetup() {
    const coordinatorFetch = vi.fn(async (request: Request) => Response.json({
      principal: JSON.parse(request.headers.get('x-runner-principal')!),
    }, { status: 202 }));
    const principal = { principalId: 'cp-service-principal', tenantId, profileId: 'service-profile',
      repository: 'trained-assist/ai-agent-runner', scopes: ['runs:read', 'runs:write'] };
    const idFromName = vi.fn((name: string) => name);
    const env = {
      RUNNER_API_KEYS: JSON.stringify([{ ...principal, keyHash: createHash('sha256').update(apiKey).digest('hex') }]),
      AGENT_API_PROFILE_DELEGATION_SECRET: delegationSecret,
      RUNNER_RUNS: { idFromName, get: vi.fn().mockReturnValue({ fetch: coordinatorFetch }) },
    } as unknown as RunnerWorkerEnv;
    return { env, coordinatorFetch, idFromName };
  }

  function signedHeaders(principalId: string, delegatedProfile = profileId, tenant = tenantId,
    expiresAt = String(Date.now() + 60_000)) {
    const message = `${principalId}\0${tenant}\0${delegatedProfile}\0${expiresAt}`;
    const signature = createHmac('sha256', delegationSecret).update(message).digest('hex');
    return { 'x-agent-profile-id': delegatedProfile, 'x-agent-profile-tenant': tenant,
      'x-agent-profile-exp': expiresAt, 'x-agent-profile-sig': signature };
  }

  function submit(env: RunnerWorkerEnv, headers: Record<string, string>) {
    return runnerApi.fetch(new Request('https://api.example/v1/runs', { method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ userTaskId: 'task-delegated' }) }), env);
  }

  it('verifies the capability and applies the signed profile before identity hashing and dispatch', async () => {
    const { env, coordinatorFetch, idFromName } = delegatedSetup();
    const response = await submit(env, signedHeaders('cp-service-principal'));
    expect(response.status).toBe(202);
    expect(JSON.parse(coordinatorFetch.mock.calls[0]![0].headers.get('x-runner-principal')!))
      .toMatchObject({ principalId: 'cp-service-principal', tenantId, profileId });
    expect(idFromName).toHaveBeenCalledWith(`task-${createHash('sha256').update(`cp-service-principal\0${profileId}\0task-delegated`).digest('hex')}`);
  });

  it('rejects forged, expired, cross-tenant and partial capabilities before dispatch', async () => {
    const { env, coordinatorFetch } = delegatedSetup();
    const forged = signedHeaders('another-principal');
    const expired = signedHeaders('cp-service-principal', profileId, tenantId, String(Date.now() - 1));
    const crossTenant = signedHeaders('cp-service-principal', profileId, 'tenant-b');
    for (const headers of [forged, expired, crossTenant, { 'x-agent-profile-id': profileId }]) {
      expect((await submit(env, headers)).status).toBe(403);
    }
    expect(coordinatorFetch).not.toHaveBeenCalled();
  });

  it('rejects delegated capability headers when the verifier secret is missing', async () => {
    const { env, coordinatorFetch } = delegatedSetup();
    delete (env as unknown as Record<string, unknown>).AGENT_API_PROFILE_DELEGATION_SECRET;
    expect((await submit(env, signedHeaders('cp-service-principal'))).status).toBe(403);
    expect(coordinatorFetch).not.toHaveBeenCalled();
  });
});
