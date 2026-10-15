import { describe, expect, it, vi } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import runnerApi, { sha256 } from '../src/cloudflare/runner-api.js';
import type { RunnerWorkerEnv } from '../src/cloudflare/types.js';

describe('Cloudflare Runner API Worker', () => {
  it('accepts a separate sandbox developer registry without changing legacy keys or production authentication', async () => {
    const legacyKey = 'legacy-sandbox-key';
    const developerKey = 'dedicated-developer-key';
    const developerRecord = { keyHash: await sha256(developerKey), principalId: 'local-developer', profileId: 'local-developer',
      repository: 'trained-assist/ai-agent-runner', scopes: ['runs:read', 'runs:write'], developerApi: true };
    const sandbox = {
      RUNNER_API_KEYS: JSON.stringify([{ keyHash: await sha256(legacyKey), principalId: 'legacy', profileId: 'legacy',
        repository: 'trained-assist/ai-agent-runner', scopes: ['runs:read'] }]),
      RUNNER_API_KEYS_DEVELOPER: JSON.stringify([developerRecord]), RUNNER_DEVELOPER_API_ENABLED: 'true',
      RUNNER_RUNS: { idFromName: vi.fn(), get: vi.fn() },
    } as unknown as RunnerWorkerEnv;
    const capabilities = (key: string, env: RunnerWorkerEnv) => runnerApi.fetch(new Request('https://api.example/v1/developer/capabilities', {
      headers: { authorization: `Bearer ${key}` },
    }), env);
    expect((await capabilities(developerKey, sandbox)).status).toBe(200);
    expect((await capabilities(legacyKey, sandbox)).status).toBe(403);
    const oldRoute = await runnerApi.fetch(new Request('https://api.example/v1/capabilities', {
      headers: { authorization: `Bearer ${legacyKey}` },
    }), sandbox);
    expect(oldRoute.status).toBe(200);
    const production = { ...sandbox, DEPLOYMENT_ENV: 'production', RUNNER_API_KEYS_PRODUCTION: '[]' };
    expect((await capabilities(developerKey, production)).status).toBe(401);
  });

  it('fails closed for malformed sandbox developer registry', async () => {
    const env = { RUNNER_API_KEYS: '[]', RUNNER_API_KEYS_DEVELOPER: JSON.stringify([{ principalId: 'bad' }]) } as unknown as RunnerWorkerEnv;
    const response = await runnerApi.fetch(new Request('https://api.example/v1/capabilities', {
      headers: { authorization: 'Bearer any-key' },
    }), env);
    expect(response.status).toBe(503);
  });

  it('uses the dedicated production registry without replacing or reading other registries', async () => {
    const productionKey = 'production-only-key';
    const env = {
      DEPLOYMENT_ENV: 'production',
      RUNNER_API_KEYS: '{preserved-but-not-used}',
      RUNNER_API_KEYS_ADDITIONAL: '{also-preserved}',
      RUNNER_API_KEYS_PRODUCTION: JSON.stringify([{ keyHash: await sha256(productionKey), principalId: 'production', profileId: 'production-base', tenantId: 'production-tenant', repository: 'trained-assist/ai-agent-runner', scopes: ['runs:read'], engines: ['eu-vm-agent-run'] }]),
      RUNNER_RUNS: { idFromName: vi.fn(), get: vi.fn() },
    } as unknown as RunnerWorkerEnv;
    const admitted = await runnerApi.fetch(new Request('https://api.example/v1/capabilities', { headers: { authorization: `Bearer ${productionKey}` } }), env);
    const ignored = await runnerApi.fetch(new Request('https://api.example/v1/capabilities', { headers: { authorization: 'preserved-key' } }), env);
    expect(admitted.status).toBe(200);
    expect(ignored.status).toBe(401);
  });

  it('reports GHA only as a configured fallback while France remains the caller-facing engine', async () => {
    const token = 'capabilities-fallback-key';
    const env = {
      RUNNER_API_KEYS: JSON.stringify([{ keyHash: await sha256(token), principalId: 'runner', profileId: 'profile', repository: 'team/repo', scopes: ['runs:read'] }]),
      RUNNER_ENGINE: 'eu-vm-agent-run', GHA_WORKER_URL: 'https://opencode-gha-runner-gateway.skillset-apply.workers.dev',
      GHA_WORKER_TOKEN: 'g'.repeat(32), RUNNER_RUNS: { idFromName: vi.fn(), get: vi.fn() },
    } as unknown as RunnerWorkerEnv;
    const response = await runnerApi.fetch(new Request('https://api.example/v1/capabilities', { headers: { authorization: `Bearer ${token}` } }), env);
    expect(await response.json()).toMatchObject({ executionRegions: ['eu-vm-agent-run'], fallbackExecutionRegions: ['azure-cloud'], routes: { auto: { primary: 'eu-vm-agent-run', fallback: 'azure-cloud' }, france: { available: true, fallback: false }, gha: { available: true, engine: 'azure-cloud' } } });

    const notProvisioned = await runnerApi.fetch(new Request('https://api.example/v1/capabilities', { headers: { authorization: `Bearer ${token}` } }), { ...env, GHA_WORKER_TOKEN: '' });
    expect(await notProvisioned.json()).toMatchObject({ executionRegions: ['eu-vm-agent-run'], fallbackExecutionRegions: [], routes: { auto: { primary: 'eu-vm-agent-run', fallback: null }, gha: { available: false, engine: null } } });
  });

  it('reports the deployed Cloudflare Worker build identity', async () => {
    const env = { BUILD_SHA: 'a'.repeat(40) } as unknown as RunnerWorkerEnv;
    const response = await runnerApi.fetch(new Request('https://api.example/version'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runtime: 'cloudflare-worker', buildSha: 'a'.repeat(40) });
  });

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

  it('routes sandbox cleanup only for an explicitly enabled profile and write scope', async () => {
    const token = 'runner-api-cleanup';
    const keyHash = await sha256(token);
    const coordinatorFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://runner-runs.internal/v1/sandbox/cleanup-task');
      expect(await request.json()).toEqual({ userTaskId: 'task-cleanup' });
      return Response.json({ status: 'cleaned', deletedRuns: 1 });
    });
    const env = {
      RUNNER_API_KEYS: JSON.stringify([{ keyHash, principalId: 'test-principal', profileId: 'test-profile', repository: 'team/test', scopes: ['runs:write'] }]),
      SANDBOX_CLEANUP_PROFILES: 'test-profile',
      RUNNER_RUNS: { idFromName: vi.fn((name) => name), get: vi.fn().mockReturnValue({ fetch: coordinatorFetch }) },
    } as unknown as RunnerWorkerEnv;
    const response = await runnerApi.fetch(new Request('https://api.example/v1/sandbox/cleanup-task', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ userTaskId: 'task-cleanup' }),
    }), env);
    expect(response.status).toBe(200);
    expect(env.RUNNER_RUNS.idFromName).toHaveBeenCalledWith(expect.stringMatching(/^task-[0-9a-f]{64}$/));
    expect(coordinatorFetch).toHaveBeenCalledOnce();

    const disabled = await runnerApi.fetch(new Request('https://api.example/v1/sandbox/cleanup-task', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ userTaskId: 'task-cleanup' }),
    }), { ...env, SANDBOX_CLEANUP_PROFILES: '' });
    expect(disabled.status).toBe(403);
    expect(coordinatorFetch).toHaveBeenCalledOnce();
  });

  it('routes cancel-by-idempotency-key to the task coordinator and requires write scope', async () => {
    const token = 'runner-api-cancel-by-key';
    const keyHash = await sha256(token);
    const coordinatorFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://runner-runs.internal/v1/runs/cancel-by-idempotency-key');
      expect(await request.json()).toEqual({ userTaskId: 'task-cancel-by-key', idempotencyKey: 'attempt-key', ownerGeneration: 3 });
      return Response.json({ status: 'cancelled_before_admission', userTaskId: 'task-cancel-by-key', ownerGeneration: 3, runId: null });
    });
    const env = {
      RUNNER_API_KEYS: JSON.stringify([{ keyHash, principalId: 'cancel-principal', profileId: 'cancel-profile', repository: 'team/test', scopes: ['runs:write'] }]),
      RUNNER_RUNS: { idFromName: vi.fn((name) => name), get: vi.fn().mockReturnValue({ fetch: coordinatorFetch }) },
    } as unknown as RunnerWorkerEnv;
    const response = await runnerApi.fetch(new Request('https://api.example/v1/runs/cancel-by-idempotency-key', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userTaskId: 'task-cancel-by-key', idempotencyKey: 'attempt-key', ownerGeneration: 3 }),
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'cancelled_before_admission' });
    expect(env.RUNNER_RUNS.idFromName).toHaveBeenCalledWith(expect.stringMatching(/^task-[0-9a-f]{64}$/));
    expect(coordinatorFetch).toHaveBeenCalledOnce();

    const readOnlyEnv = { ...env, RUNNER_API_KEYS: JSON.stringify([{ keyHash, principalId: 'cancel-principal', profileId: 'cancel-profile', repository: 'team/test', scopes: ['runs:read'] }]) };
    const denied = await runnerApi.fetch(new Request('https://api.example/v1/runs/cancel-by-idempotency-key', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userTaskId: 'task-cancel-by-key', idempotencyKey: 'attempt-key', ownerGeneration: 3 }),
    }), readOnlyEnv);
    expect(denied.status).toBe(403);
    expect(coordinatorFetch).toHaveBeenCalledOnce();
  });

  it('rejects an invalid key before any coordinator call', async () => {
    const get = vi.fn();
    const env = { RUNNER_API_KEYS: '[]', RUNNER_RUNS: { idFromName: vi.fn(), get } } as unknown as RunnerWorkerEnv;
    const response = await runnerApi.fetch(new Request('https://api.example/v1/runs', { method: 'POST' }), env);
    expect(response.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it('accepts principals from the additive registry while preserving the base registry', async () => {
    const baseKey = 'base-registry-key';
    const additionalKey = 'additional-registry-key';
    const idFromName = vi.fn((name) => name);
    const coordinatorFetch = vi.fn(async () => Response.json({ ok: true }));
    const env = {
      RUNNER_API_KEYS: JSON.stringify([{ keyHash: await sha256(baseKey), principalId: 'base', profileId: 'base-profile', repository: 'team/base', scopes: ['runs:read'] }]),
      RUNNER_API_KEYS_ADDITIONAL: JSON.stringify([{ keyHash: await sha256(additionalKey), principalId: 'additional', profileId: 'additional-profile', repository: 'team/additional', scopes: ['runs:read'] }]),
      RUNNER_RUNS: { idFromName, get: vi.fn().mockReturnValue({ fetch: coordinatorFetch }) },
    } as unknown as RunnerWorkerEnv;

    const baseResponse = await runnerApi.fetch(new Request('https://api.example/v1/capabilities', { headers: { authorization: `Bearer ${baseKey}` } }), env);
    const additionalResponse = await runnerApi.fetch(new Request('https://api.example/v1/capabilities', { headers: { authorization: `Bearer ${additionalKey}` } }), env);
    expect(baseResponse.status).toBe(200);
    expect(additionalResponse.status).toBe(200);
  });

  it('loads a dedicated sandbox3 registry without changing the base or additive registries', async () => {
    const baseKey = 'base-registry-key';
    const canaryKey = 'existing-canary-key';
    const sandbox3Key = 'sandbox3-profile-key';
    const env = {
      RUNNER_API_KEYS: JSON.stringify([{ keyHash: await sha256(baseKey), principalId: 'base', profileId: 'base-profile', repository: 'team/base', scopes: ['runs:read'] }]),
      RUNNER_API_KEYS_ADDITIONAL: JSON.stringify([{ keyHash: await sha256(canaryKey), principalId: 'existing-canary', profileId: 'canary-profile', repository: 'team/canary', scopes: ['runs:read'] }]),
      RUNNER_API_KEYS_SANDBOX3: JSON.stringify([{ keyHash: await sha256(sandbox3Key), principalId: 'sandbox3-cp-principal', tenantId: 'sandbox3-tenant', profileId: 'service-profile', repository: 'trained-assist/ai-agent-runner', scopes: ['runs:read', 'runs:write'], engines: ['eu-vm-agent-run'] }]),
    } as unknown as RunnerWorkerEnv;

    for (const key of [baseKey, canaryKey, sandbox3Key]) {
      const response = await runnerApi.fetch(new Request('https://api.example/v1/capabilities', { headers: { authorization: `Bearer ${key}` } }), env);
      expect(response.status).toBe(200);
    }
  });

  it('fails closed when the dedicated sandbox3 registry is malformed', async () => {
    const env = { RUNNER_API_KEYS: '[]', RUNNER_API_KEYS_SANDBOX3: '{bad-json' } as unknown as RunnerWorkerEnv;
    const response = await runnerApi.fetch(new Request('https://api.example/v1/capabilities', { headers: { authorization: 'Bearer any-key' } }), env);
    expect(response.status).toBe(503);
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

describe('opt-in developer API', () => {
  const token = 'developer-api-test-key';
  async function setup(developerApi = true) {
    const calls: Request[] = [];
    const coordinatorFetch = vi.fn(async (request: Request) => {
      calls.push(request);
      if (request.method === 'POST') return Response.json({ runId: `run_${'a'.repeat(64)}_${'b'.repeat(24)}`, deduplicated: false }, { status: 202 });
      return Response.json({ runId: `run_${'a'.repeat(64)}_${'b'.repeat(24)}`, state: 'running', lastHeartbeatAt: null });
    });
    const env = {
      RUNNER_API_KEYS: JSON.stringify([{ keyHash: await sha256(token), principalId: 'developer', profileId: 'dev-profile', tenantId: 'tenant-a',
        repository: 'team/repo', scopes: ['runs:read', 'runs:write'], ...(developerApi ? { developerApi: true } : {}) }]),
      LLM_LADDER_TOKEN: 'managed-model-token', ALLOWED_ENVIRONMENT_NAMES: 'LLM_LADDER_TOKEN,OPENAI_API_KEY',
      RUNNER_DEVELOPER_API_ENABLED: 'true', RUNNER_BYOK_ENABLED: 'true',
      RUNNER_RUNS: { idFromName: vi.fn((name) => name), get: vi.fn().mockReturnValue({ fetch: coordinatorFetch }) },
    } as unknown as RunnerWorkerEnv;
    return { env, calls };
  }

  it('normalizes a prompt to the existing coordinator without changing its receipt and status path', async () => {
    const { env, calls } = await setup();
    const make = () => new Request('https://api.example/v1/developer/runs', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'idempotency-key': 'first-task', 'content-type': 'application/json',
    }, body: JSON.stringify({ prompt: 'Write a small SDK', model: { mode: 'managed' }, limits: { timeoutSeconds: 120 } }) });
    const first = await runnerApi.fetch(make(), env);
    const second = await runnerApi.fetch(make(), env);
    expect(first.status).toBe(202);
    expect((await first.json() as { id: string }).id).toMatch(/^run_/);
    const firstBody = await calls[0]!.json() as Record<string, any>;
    const secondBody = await calls[1]!.json() as Record<string, any>;
    expect(firstBody).toEqual(secondBody);
    expect(firstBody).toMatchObject({ input: { inlinePrompt: 'Write a small SDK' }, envAllowlist: ['LLM_LADDER_TOKEN'], limits: { timeoutMs: 120_000 } });
    expect(firstBody['userTaskId']).toMatch(/^dev-[0-9a-f]{48}$/);
    expect(calls[0]!.url).toBe('https://runner-runs.internal/v1/runs');
    expect((calls[0]!.headers.get('x-runner-principal') ?? '')).not.toContain(token);
    const runId = `run_${'a'.repeat(64)}_${'b'.repeat(24)}`;
    const status = await runnerApi.fetch(new Request(`https://api.example/v1/developer/runs/${runId}`, { headers: { authorization: `Bearer ${token}` } }), env);
    expect(status.status).toBe(200);
    expect(calls[2]!.url).toBe(`https://runner-runs.internal/v1/runs/${runId}/status`);
  });

  it('requires explicit key opt-in and refuses raw secrets or unsupported billing fields', async () => {
    const disabled = await setup(false);
    const url = 'https://api.example/v1/developer/runs';
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'x', 'content-type': 'application/json' };
    expect((await runnerApi.fetch(new Request(url, { method: 'POST', headers, body: JSON.stringify({ prompt: 'test', model: { mode: 'managed' } }) }), disabled.env)).status).toBe(403);
    const { env, calls } = await setup();
    for (const body of [
      { prompt: 'test', model: { mode: 'byok', connectionId: 'conn-a' }, apiKey: 'raw-secret' },
      { prompt: 'test', model: { mode: 'managed' }, billing: { maxCostUsd: 1 } },
      { prompt: 'test', model: { mode: 'managed', connectionId: 'conn-a' } },
    ]) expect((await runnerApi.fetch(new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }), env)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('keeps developer admission closed on production and without the lane switch', async () => {
    const { env, calls } = await setup();
    const request = () => new Request('https://api.example/v1/developer/runs', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'idempotency-key': 'gated', 'content-type': 'application/json',
    }, body: JSON.stringify({ prompt: 'test', model: { mode: 'managed' } }) });
    expect((await runnerApi.fetch(request(), { ...env, DEPLOYMENT_ENV: 'production' })).status).toBe(503);
    expect((await runnerApi.fetch(request(), { ...env, RUNNER_DEVELOPER_API_ENABLED: undefined })).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('passes only a BYOK connection reference and keeps unrelated credentials out of the request', async () => {
    const { env, calls } = await setup();
    const response = await runnerApi.fetch(new Request('https://api.example/v1/developer/runs', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'idempotency-key': 'byok-test', 'content-type': 'application/json',
    }, body: JSON.stringify({ prompt: 'Answer briefly', model: { mode: 'byok', connectionId: 'conn-a' } }) }), env);
    expect(response.status).toBe(202);
    expect(await calls[0]!.json()).toMatchObject({ envAllowlist: [], credentialBindings: [{ type: 'openai', connectionId: 'conn-a' }] });
  });

  it('lists only registered webhooks and forwards only the webhook ID on submission', async () => {
    const { env, calls } = await setup();
    env.RUNNER_WEBHOOKS_ENABLED = 'true';
    env.RUNNER_WEBHOOKS = JSON.stringify([
      { webhookId: 'wh-mine', principalId: 'developer', profileId: 'dev-profile', tenantId: 'tenant-a',
        url: 'https://hooks.customer.com/agent', secretBinding: 'RUNNER_WEBHOOK_SECRET_A' },
      { webhookId: 'wh-foreign', principalId: 'other', profileId: 'other-profile', tenantId: 'other-tenant',
        url: 'https://hooks.other.com/agent', secretBinding: 'RUNNER_WEBHOOK_SECRET_OTHER' },
    ]);
    env['RUNNER_WEBHOOK_SECRET_A'] = 'test-webhook-signing-secret-long-enough';
    env['RUNNER_WEBHOOK_SECRET_OTHER'] = 'other-webhook-signing-secret-long-enough';
    const list = await runnerApi.fetch(new Request('https://api.example/v1/developer/webhooks', { headers: { authorization: `Bearer ${token}` } }), env);
    expect(await list.json()).toEqual({ webhooks: [{ webhookId: 'wh-mine', url: 'https://hooks.customer.com/agent' }] });
    const response = await runnerApi.fetch(new Request('https://api.example/v1/developer/runs', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'idempotency-key': 'webhook-1', 'content-type': 'application/json',
    }, body: JSON.stringify({ prompt: 'answer', model: { mode: 'managed' }, webhookId: 'wh-mine' }) }), env);
    expect(response.status).toBe(202);
    const forwarded = await calls[0]!.json() as Record<string, unknown>;
    expect(forwarded['webhookId']).toBe('wh-mine');
    expect(JSON.stringify(forwarded)).not.toContain('hooks.customer.com');
    expect(JSON.stringify(forwarded)).not.toContain('test-webhook-signing-secret');
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
