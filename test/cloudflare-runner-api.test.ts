import { describe, expect, it, vi } from 'vitest';
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
      RUNNER_API_KEYS: JSON.stringify([{ keyHash, principalId: 'principal-one', profileId: 'profile-one', scopes: ['runs:read', 'runs:write'] }]),
      VM_WORKER_URL: 'https://france.example', VM_WORKER_TOKEN: 'worker-secret', RUNNER_API_PUBLIC_URL: 'https://api.example',
      RUN_LAUNCH_ENCRYPTION_KEY: 'test-only-encryption-key-at-least-32-chars', RUNNER_ENGINE: 'eu-vm-agent-run',
      ALLOWED_REPOSITORIES: 'trained-assist/ai-agent-runner', RUNNER_RUNS: { idFromName: vi.fn().mockReturnValue('runs-do'), get: vi.fn().mockReturnValue({ fetch: coordinatorFetch }) },
    } as unknown as RunnerWorkerEnv;
    const request = new Request('https://api.example/v1/runs', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'attempt-1', 'content-type': 'application/json' }, body: JSON.stringify({ userTaskId: 'task-one' }) });
    const response = await runnerApi.fetch(request, env);
    expect(response.status).toBe(202);
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
});
