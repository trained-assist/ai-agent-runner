import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { LaunchRequest } from '../src/adapters/external-worker-adapter.js';
import { CapacityAdmission, type HostUsageSample, type HostUsageSampler } from '../src/vm-worker/capacity-admission.js';
import { FileCapacityReservationStore } from '../src/vm-worker/file-capacity-reservation-store.js';
import { createVmWorkerServer } from '../src/vm-worker/http-server.js';
import type { VmWorkerBindingsInventory } from '../src/vm-worker/bindings-inventory.js';
import type { Runner } from '../src/runner/runner.js';
import type { RunSpec } from '../src/contracts/run-spec.js';
import { StorageError } from '../src/storage/errors.js';

const TOKEN = 'vm-worker-test-secret-that-is-long-enough';
const API_ORIGIN = 'https://api.example.test';
const RUN_ID = 'run-vm-worker-test';

describe('installable VM HTTP worker', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  it('authenticates the central API, ignores caller cwd, returns durable-style receipt/status/result and replayable logs', async () => {
    const fixture = await startFixture({ engineName: 'eu-vm-agent-run' });
    cleanups.push(fixture.close);
    const live = await fetch(`${fixture.base}/healthz`);
    expect(live.status).toBe(200);
    expect((await live.json() as { service: string }).service).toBe('ai-agent-vm-worker');
    const ready = await fetch(`${fixture.base}/readyz`);
    expect(ready.status).toBe(200);
    expect((await ready.json() as { checks: { capacity: { state: string } } }).checks.capacity.state).toBe('available');

    const unauthenticated = await fetch(`${fixture.base}/v1/launch`, { method: 'POST', body: JSON.stringify(launchRequest()) });
    expect(unauthenticated.status).toBe(401);

    const request = launchRequest();
    const accepted = await launch(fixture.base, request);
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json() as Record<string, unknown>;
    expect(receipt).toMatchObject({ runId: RUN_ID, operationId: request.operationId, status: 'accepted' });
    expect(receipt.statusUrl).toBe(`https://worker.example.test/v1/runs/${RUN_ID}/status`);
    expect(fixture.runner.startCalls).toHaveLength(1);
    expect(fixture.runner.startCalls[0]!.spec.engine.name).toBe('opencode');
    expect(fixture.runner.startCalls[0]!.spec.cwd).toBe(join(fixture.dataDir, 'workspaces', RUN_ID));
    expect(fixture.runner.startCalls[0]!.spec.cwd).not.toBe(request.cwd);
    expect(fixture.runner.startCalls[0]!.runtimeEnv).toEqual({ LLM_LADDER_TOKEN: 'request-only-test-secret' });

    const duplicate = await launch(fixture.base, request);
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual(receipt);
    expect(fixture.runner.startCalls).toHaveLength(1);

    const sse = await fetch(`${fixture.base}/v1/runs/${RUN_ID}/logs?after=0`, { headers: authHeaders() });
    const stream = await sse.text();
    expect(sse.status).toBe(200);
    expect(stream).toContain('event: stdout');
    expect(stream).toContain('worker says hello');
    expect(stream).toContain('event: stderr');
    expect(stream).toContain('event: assistant_message');
    expect(stream).toContain('Checking the repository first.');

    const snapshot = await fetch(`${fixture.base}/v1/runs/${RUN_ID}/logs?after=0&snapshot=1`, { headers: authHeaders() });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ runId: RUN_ID, cursor: 11, hasMore: false, logs: [
      { sequence: 10, stream: 'stdout', message: 'worker says hello' }, { sequence: 11, stream: 'stderr', message: 'diagnostic' },
    ] });

    const status = await fetch(`${fixture.base}/v1/runs/${RUN_ID}/status`, { headers: authHeaders() });
    expect(await status.json()).toMatchObject({ runId: RUN_ID, status: 'succeeded', state: 'succeeded', startPhase: 'started', startAttempts: 1 });
    const resultResponse = await fetch(`${fixture.base}/v1/runs/${RUN_ID}/result`, { headers: authHeaders() });
    const result = await resultResponse.json();
    expect(resultResponse.status).toBe(200);
    expect(result).toMatchObject({ runId: RUN_ID, status: 'started', exitObserved: true,
      stdout: 'worker says hello', repo: { branch: `agent-run/${RUN_ID}`, commit: null } });
    const historyManifestResponse = await fetch(`${fixture.base}/v1/runs/${RUN_ID}/history?manifest=1`, { headers: authHeaders() });
    expect(historyManifestResponse.status).toBe(200);
    const historyManifest = await historyManifestResponse.json() as { path: string; sha256: string; size: number };
    expect(historyManifest.path).toBe('__runner/agent-history.json');
    const historyResponse = await fetch(`${fixture.base}/v1/runs/${RUN_ID}/history`, { headers: authHeaders() });
    const historyBytes = Buffer.from(await historyResponse.arrayBuffer());
    expect(historyResponse.status).toBe(200);
    expect(historyBytes.length).toBe(historyManifest.size);
    expect(createHash('sha256').update(historyBytes).digest('hex')).toBe(historyManifest.sha256);
    expect(JSON.parse(historyBytes.toString('utf8'))).toMatchObject({ runId: RUN_ID, outcome: 'succeeded',
      entries: [{ type: 'log', text: 'worker says hello' }, { type: 'log', text: 'diagnostic' },
        { type: 'assistant_message', text: 'Checking the repository first.' }], answer: 'worker says hello' });
  });

  it('refuses a saturated host before Runner.start with the exact capacity code', async () => {
    const fixture = await startFixture({ cpuPercent: 60 });
    cleanups.push(fixture.close);
    const response = await launch(fixture.base, launchRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ accepted: false, code: 'WORKER_CAPACITY' });
    expect(fixture.runner.startCalls).toHaveLength(0);
  });

  it('enforces Russia OpenCode policy and central callback origin before admission', async () => {
    const fixture = await startFixture({ engineName: 'rf-vm-agent-run' });
    cleanups.push(fixture.close);
    const claude = launchRequest({ engine: { name: 'rf-vm-agent-run', adapterVersion: '1', modelSettings: { model: 'claude-3.7' } } });
    const deniedModel = await launch(fixture.base, claude);
    expect(deniedModel.status).toBe(400);
    expect((await deniedModel.json() as { details: string[] }).details).toContain('Russia worker policy forbids Claude and Codex models');

    const badCallback = launchRequest({ resultUrl: 'https://attacker.example/steal' });
    const deniedCallback = await launch(fixture.base, badCallback);
    expect(deniedCallback.status).toBe(400);
    expect(fixture.runner.startCalls).toHaveLength(0);
  });

  it('passes only the pinned test Registry MCP to OpenCode using memory-only secrets and config', async () => {
    const fixture = await startFixture({ allowedEnvironmentNames: ['LLM_LADDER_TOKEN'] });
    cleanups.push(fixture.close);
    const request = launchRequest({
      profileId: 'integration-telegram-ux-v1',
      mcp: { servers: { 'trained-assist-registry-test': {
        type: 'remote', url: 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp', enabled: true,
        headers: {
          Authorization: 'Bearer {env:RUNNER_MCP_REGISTRY_TEST}',
          'X-MCP-Operation': 'invocation', 'X-MCP-Scope': 'registry:fixture-read',
          'X-MCP-User-Task-Id': 'task-vm-worker-test', 'X-MCP-Profile': 'integration-telegram-ux-v1',
          'X-MCP-Run-Id': RUN_ID, 'X-MCP-Run-Binding': '{env:RUNNER_MCP_REGISTRY_TEST_PROOF}',
        },
      } } },
      mcpSecrets: { RUNNER_MCP_REGISTRY_TEST: 'test-registry-bearer-token-123', RUNNER_MCP_REGISTRY_TEST_PROOF: 'signed-run-bound-proof-123456' },
    });
    const accepted = await launch(fixture.base, request);
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    const { spec, runtimeEnv } = fixture.runner.startCalls[0]!;
    expect(spec.envAllowlist).toContain('OPENCODE_CONFIG_CONTENT');
    expect(runtimeEnv.RUNNER_MCP_REGISTRY_TEST).toBe('test-registry-bearer-token-123');
    expect(runtimeEnv.RUNNER_MCP_REGISTRY_TEST_PROOF).toBe('signed-run-bound-proof-123456');
    const config = JSON.parse(runtimeEnv.OPENCODE_CONFIG_CONTENT!) as { mcp: Record<string, { url: string; oauth: boolean; headers: Record<string, string> }> };
    expect(config.mcp['trained-assist-registry-test']!.url).toBe('https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp');
    expect(config.mcp['trained-assist-registry-test']!.oauth).toBe(false);
    expect(config.mcp['trained-assist-registry-test']!.headers.Authorization).toBe('Bearer {env:RUNNER_MCP_REGISTRY_TEST}');
    expect(JSON.stringify(spec)).not.toContain('test-registry-bearer-token-123');
    expect(JSON.stringify(spec)).not.toContain('signed-run-bound-proof-123456');
  });

  it('passes the pinned sandbox user catalog to OpenCode without persisting its token or proof', async () => {
    const fixture = await startFixture({ allowedEnvironmentNames: ['LLM_LADDER_TOKEN'] });
    cleanups.push(fixture.close);
    const request = launchRequest({ profileId: 'integration-telegram-ux-v1', mcp: { servers: { 'mem-gpt': {
      type: 'remote', url: 'https://trained-assist-mcp-user-sandbox.skillset-apply.workers.dev/mcp', enabled: true,
      headers: {
        Authorization: 'Bearer {env:RUNNER_MCP_USER_TOKEN}',
        'X-MCP-Operation': 'invocation', 'X-MCP-Scope': 'mcp:user-agent-run',
        'X-MCP-User-Task-Id': 'task-vm-worker-test', 'X-MCP-Profile': 'integration-telegram-ux-v1',
        'X-MCP-Run-Id': RUN_ID, 'X-MCP-Run-Binding': '{env:RUNNER_MCP_USER_PROOF}',
      },
    } } }, mcpSecrets: { RUNNER_MCP_USER_TOKEN: 'user-catalog-bearer-token-123456',
      RUNNER_MCP_USER_PROOF: 'signed-user-run-proof-123456' } });
    const accepted = await launch(fixture.base, request);
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    const { spec, runtimeEnv } = fixture.runner.startCalls[0]!;
    expect(runtimeEnv.RUNNER_MCP_USER_TOKEN).toBe('user-catalog-bearer-token-123456');
    expect(runtimeEnv.RUNNER_MCP_USER_PROOF).toBe('signed-user-run-proof-123456');
    expect(runtimeEnv.OPENCODE_CONFIG_CONTENT).toContain('trained-assist-mcp-user-sandbox');
    expect(JSON.parse(runtimeEnv.OPENCODE_CONFIG_CONTENT!).mcp['mem-gpt'].oauth).toBe(false);
    const openCodeConfig = JSON.parse(runtimeEnv.OPENCODE_CONFIG_CONTENT!) as { permission?: Record<string, string> };
    expect(openCodeConfig.permission).toEqual({
      mem_gpt_identity_whoami: 'allow',
      mem_gpt_google_docs_connect: 'allow',
      mem_gpt_google_docs_get_document: 'allow',
    });
    expect(JSON.stringify(spec)).not.toContain('user-catalog-bearer-token-123456');
    expect(JSON.stringify(spec)).not.toContain('signed-user-run-proof-123456');
  });

  it('rejects a multi-server MCP payload even when each entry is individually pinned', async () => {
    const fixture = await startFixture();
    cleanups.push(fixture.close);
    const headers = { Authorization: 'Bearer {env:RUNNER_MCP_USER_TOKEN}', 'X-MCP-Operation': 'invocation',
      'X-MCP-Scope': 'mcp:user-agent-run', 'X-MCP-User-Task-Id': 'task-vm-worker-test',
      'X-MCP-Profile': 'integration-telegram-ux-v1', 'X-MCP-Run-Id': RUN_ID,
      'X-MCP-Run-Binding': '{env:RUNNER_MCP_USER_PROOF}' };
    const response = await launch(fixture.base, launchRequest({ profileId: 'integration-telegram-ux-v1', mcp: { servers: {
      'mem-gpt': { type: 'remote', url: 'https://trained-assist-mcp-user-sandbox.skillset-apply.workers.dev/mcp', enabled: true, headers },
      'trained-assist-registry-test': { type: 'remote', url: 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp', enabled: true, headers },
    } }, mcpSecrets: { RUNNER_MCP_USER_TOKEN: 'user-catalog-bearer-token-123456',
      RUNNER_MCP_USER_PROOF: 'signed-user-run-proof-123456',
      RUNNER_MCP_REGISTRY_TEST: 'test-registry-bearer-token-123', RUNNER_MCP_REGISTRY_TEST_PROOF: 'signed-run-bound-proof-123456' } }));
    expect(response.status).toBe(400);
    expect(fixture.runner.startCalls).toHaveLength(0);
  });

  it('rejects caller-selected MCP endpoints before Runner admission', async () => {
    const fixture = await startFixture();
    cleanups.push(fixture.close);
    const response = await launch(fixture.base, launchRequest({ mcp: { servers: { attacker: {
      type: 'remote', url: 'https://attacker.example/mcp', enabled: true, headers: {},
    } } }, mcpSecrets: { token: 'attacker-selected-token-12345' } }));
    expect(response.status).toBe(400);
    expect(fixture.runner.startCalls).toHaveLength(0);
  });

  it('accepts run-bound callbacks behind a trusted API path prefix and rejects path or run mismatches', async () => {
    const fixture = await startFixture({ profileWorkspaceEnabled: true, profileSavebackEnabled: true });
    cleanups.push(fixture.close);
    const prefixed = launchRequest({
      resultUrl: `${API_ORIGIN}/profile-api/v1/worker/launches/${RUN_ID}/result`,
      profileWorkspace: {
        bindingId: 'binding-profile-a', snapshotUrl: 'https://example.test/snapshot', snapshotSha256: 'a'.repeat(64),
        snapshotSize: 1, savebackToken: 't'.repeat(43),
        savebackUrl: `${API_ORIGIN}/profile-api/v1/worker/launches/${RUN_ID}/profile-changes`, artifacts: [], excludedPatterns: [],
      },
    });
    const accepted = await launch(fixture.base, prefixed);
    expect(accepted.status).toBe(202);
    expect(fixture.runner.startCalls[0]!.spec.profileWorkspace?.savebackUrl).toBe(prefixed.profileWorkspace?.savebackUrl);

    const wrongRun = await launch(fixture.base, launchRequest({ resultUrl: `${API_ORIGIN}/profile-api/v1/worker/launches/another-run/result` }));
    expect(wrongRun.status).toBe(400);
    const wrongEndpoint = await launch(fixture.base, launchRequest({ resultUrl: `${API_ORIGIN}/profile-api/v1/worker/launches/${RUN_ID}/other` }));
    expect(wrongEndpoint.status).toBe(400);
    expect(fixture.runner.startCalls).toHaveLength(1);
  });

  it('accepts the run-bound result endpoint used by the Cloudflare Runner API', async () => {
    const fixture = await startFixture();
    cleanups.push(fixture.close);
    const request = launchRequest({ resultUrl: `${API_ORIGIN}/v1/runs/${RUN_ID}/result` });
    const accepted = await launch(fixture.base, request);
    expect(accepted.status).toBe(202);
    expect(fixture.runner.startCalls).toHaveLength(1);

    const wrongRun = await launch(fixture.base, launchRequest({ resultUrl: `${API_ORIGIN}/v1/runs/another-run/result` }));
    expect(wrongRun.status).toBe(400);
    expect(fixture.runner.startCalls).toHaveLength(1);
  });

  it('serves only a completed run output declared in its export manifest', async () => {
    const fixture = await startFixture();
    cleanups.push(fixture.close);
    fixture.runner.completeAfterMs = 250;
    expect((await launch(fixture.base, launchRequest())).status).toBe(202);

    const early = await fetch(`${fixture.base}/v1/runs/${RUN_ID}/artifacts?path=outputs%2Fagent-note.md`, { headers: authHeaders() });
    expect(early.status).toBe(409);

    await new Promise((resolve) => setTimeout(resolve, 280));
    const missingAuth = await fetch(`${fixture.base}/v1/runs/${RUN_ID}/artifacts?path=outputs%2Fagent-note.md`);
    expect(missingAuth.status).toBe(401);

    const undeclared = await fetch(`${fixture.base}/v1/runs/${RUN_ID}/artifacts?path=outputs%2Fother.md`, { headers: authHeaders() });
    expect(undeclared.status).toBe(404);

    const response = await fetch(`${fixture.base}/v1/runs/${RUN_ID}/artifacts?path=outputs%2Fagent-note.md`, { headers: authHeaders() });
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(bytes.toString()).toBe('sandbox artifact bytes');
    expect(response.headers.get('content-disposition')).toContain('agent-note.md');
    expect(response.headers.get('x-content-sha256')).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('preserves a trusted ingress pin for Runner and rejects a pin bound to another run', async () => {
    const fixture = await startFixture();
    cleanups.push(fixture.close);
    const pin = {
      contractVersion: 1 as const,
      manifestRef: 'manifest-task-vm',
      manifestVersion: 'b'.repeat(64),
      userTaskId: 'task-vm-worker-test',
      profileId: 'profile-test',
      runId: RUN_ID,
      ownerGeneration: 1,
    };
    const accepted = await launch(fixture.base, launchRequest({ ingressManifest: pin }));
    expect(accepted.status).toBe(202);
    expect(fixture.runner.startCalls[0]!.spec.ingressManifest).toEqual(pin);

    const mismatched = await launch(fixture.base, launchRequest({ ingressManifest: { ...pin, runId: 'different-run' } }));
    expect(mismatched.status).toBe(400);
    expect(fixture.runner.startCalls).toHaveLength(1);
  });

  it('refuses profile workspace before admission while this worker cannot publish the user branch', async () => {
    const fixture = await startFixture();
    cleanups.push(fixture.close);
    const response = await launch(fixture.base, launchRequest({
      profileWorkspace: { bindingId: 'binding-profile-a', snapshotUrl: 'https://example.test/snapshot', snapshotSha256: 'a'.repeat(64), snapshotSize: 1, savebackToken: 't'.repeat(43), savebackUrl: `${API_ORIGIN}/v1/worker/launches/${RUN_ID}/profile-changes`, artifacts: [], excludedPatterns: [] },
    }));
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ accepted: false, code: 'WORKER_PROFILE_WORKSPACE_UNSUPPORTED' });
    expect(fixture.runner.startCalls).toHaveLength(0);
  });

  it('forwards pinned profile workspace, revision and one-run publication token only to an enabled Runner', async () => {
    const fixture = await startFixture({ profileWorkspaceEnabled: true, profileSavebackEnabled: true });
    cleanups.push(fixture.close);
    const response = await launch(fixture.base, launchRequest({
      repository: { fullName: 'trained-assist/ai-agent-runner', branch: `agent-run/${RUN_ID}`, revision: 'b'.repeat(40) },
      publicationToken: 'profile-publication-token-test',
      profileWorkspace: { bindingId: 'binding-profile-a', snapshotUrl: 'https://example.test/snapshot', snapshotSha256: 'a'.repeat(64), snapshotSize: 1, savebackToken: 't'.repeat(43), savebackUrl: `${API_ORIGIN}/v1/worker/launches/${RUN_ID}/profile-changes`, artifacts: [], excludedPatterns: [] },
    }));
    expect(response.status).toBe(202);
    expect(fixture.runner.startCalls[0]!.spec.repository).toMatchObject({ revision: 'b'.repeat(40) });
    expect(fixture.runner.startCalls[0]!.spec.repository?.token).toBeUndefined();
    expect(fixture.runner.startCalls[0]!.spec.profileWorkspace).toMatchObject({ bindingId: 'binding-profile-a', savebackUrl: `${API_ORIGIN}/v1/worker/launches/${RUN_ID}/profile-changes`, artifacts: [] });
  });

  it('reports unknown runs without inventing a receipt and rejects a disallowed repository', async () => {
    const fixture = await startFixture({ engineName: 'eu-vm-agent-run' });
    cleanups.push(fixture.close);
    const unknown = await fetch(`${fixture.base}/v1/runs/not-accepted/status`, { headers: authHeaders() });
    expect(await unknown.json()).toMatchObject({ runId: 'not-accepted', status: 'unknown' });
    const denied = await launch(fixture.base, launchRequest({ repository: { fullName: 'someone/else', branch: `agent-run/${RUN_ID}` } }));
    expect(denied.status).toBe(400);
    expect(fixture.runner.startCalls).toHaveLength(0);
  });

  it('exposes build identity and a value-free binding inventory for deployment drift checks', async () => {
    const envName = 'VM_WORKER_TEST_ONLY_BINDING';
    const prior = process.env[envName];
    process.env[envName] = 'never-return-this-secret';
    const inventory: VmWorkerBindingsInventory = {
      schemaVersion: 1,
      workerId: 'eu-test-worker',
      region: 'eu',
      bindings: [{ name: envName, required: true, secret: true, source: 'systemd:/etc/ai-agent-runner/worker.env', owner: 'platform' }],
    };
    const fixture = await startFixture({ bindingsInventory: inventory });
    cleanups.push(async () => {
      if (prior === undefined) delete process.env[envName]; else process.env[envName] = prior;
      await fixture.close();
    });
    const version = await (await fetch(`${fixture.base}/version`)).json() as any;
    expect(version.build.sourceCommit).toBe('a'.repeat(40));
    expect(version.worker).toEqual({ workerId: 'eu-test-worker', region: 'eu' });
    expect(version.bindings.inventory).toEqual([{ ...inventory.bindings[0], configured: true }]);
    expect(JSON.stringify(version)).not.toContain('never-return-this-secret');
    expect((await (await fetch(`${fixture.base}/readyz`)).json() as any).checks.bindings.ready).toBe(true);
  });
});

function launchRequest(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    runId: RUN_ID,
    jobId: 'job-vm-worker-test',
    userTaskId: 'task-vm-worker-test',
    profileId: 'profile-test',
    conversationId: 'conversation-test',
    operationId: 'operation-vm-worker-test',
    ownerGeneration: 1,
    engine: { name: 'eu-vm-agent-run', adapterVersion: '1', modelSettings: { model: 'opencode/free' } },
    input: { inlinePrompt: 'only emit a small marker' },
    cwd: '/untrusted/requested/workspace',
    envAllowlist: ['LLM_LADDER_TOKEN'],
    env: { LLM_LADDER_TOKEN: 'request-only-test-secret' },
    limits: { timeoutMs: 10_000, maxOutputBytes: 1024, maxLogBytes: 1024 },
    repository: { fullName: 'trained-assist/ai-agent-runner', branch: `agent-run/${RUN_ID}` },
    resultUrl: `${API_ORIGIN}/v1/worker/launches/${RUN_ID}/result`,
    isolation: { mode: 'none' },
    ...overrides,
  };
}

function authHeaders(): Record<string, string> { return { authorization: `Bearer ${TOKEN}` }; }

async function launch(base: string, request: LaunchRequest): Promise<Response> {
  return fetch(`${base}/v1/launch`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(request) });
}

async function startFixture(input: { engineName?: string; cpuPercent?: number; bindingsInventory?: VmWorkerBindingsInventory; profileWorkspaceEnabled?: boolean; profileSavebackEnabled?: boolean; allowedEnvironmentNames?: string[] } = {}): Promise<{
  base: string;
  dataDir: string;
  runner: FakeRunner;
  close: () => Promise<void>;
}> {
  const parent = mkdtempSync(join(tmpdir(), 'vm-worker-http-test-'));
  chmodSync(parent, 0o700);
  const dataDir = parent;
  mkdirSync(join(dataDir, 'capacity'), { mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const store = new FileCapacityReservationStore(join(dataDir, 'capacity', 'reservations.json'));
  const runner = new FakeRunner(dataDir, input.profileWorkspaceEnabled ?? false, input.profileSavebackEnabled ?? false);
  const sampler: HostUsageSampler = { sample: async (): Promise<HostUsageSample> => ({ cpuPercent: input.cpuPercent ?? 5, memoryPercent: 10, sampledAt: new Date().toISOString() }) };
  const capacity = new CapacityAdmission({ sampler, store });
  const server = createVmWorkerServer({
    runner: runner as unknown as Runner,
    capacity,
    capacityStore: store,
    sampler,
    engineName: input.engineName ?? 'eu-vm-agent-run',
    baseUrl: 'https://worker.example.test',
    token: TOKEN,
    dataDir,
    allowedRepositories: ['trained-assist/ai-agent-runner'],
    allowedEnvironmentNames: input.allowedEnvironmentNames ?? ['LLM_LADDER_TOKEN'],
    allowedCallbackOrigins: [API_ORIGIN],
    envelope: { cpuPercent: 10, memoryPercent: 10 },
    buildInfo: { schemaVersion: 1, version: '0.1.0-test', sourceCommit: 'a'.repeat(40), builtAt: new Date().toISOString() },
    ...(input.bindingsInventory ? { bindingsInventory: input.bindingsInventory } : {}),
    engineAvailable: () => true,
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    dataDir,
    runner,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runner.dispose();
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

class FakeRunner {
  readonly startCalls: Array<{ spec: RunSpec; operationId: string; runtimeEnv: Record<string, string> }> = [];
  private state = 'queued';
  private spec: RunSpec | null = null;
  private snapshot: Record<string, any> | null = null;
  private readonly eventList: Array<Record<string, any>> = [];
  private readonly dataDir: string;
  private readonly profileWorkspaceEnabled: boolean;
  private readonly profileSavebackEnabled: boolean;
  completeAfterMs = 60;

  constructor(dataDir: string, profileWorkspaceEnabled = false, profileSavebackEnabled = false) { this.dataDir = dataDir; this.profileWorkspaceEnabled = profileWorkspaceEnabled; this.profileSavebackEnabled = profileSavebackEnabled; }

  start(spec: RunSpec, operationId: string, runtimeEnv: Record<string, string>): void {
    this.startCalls.push({ spec, operationId, runtimeEnv });
    this.spec = spec;
    this.state = 'running';
    const at = new Date().toISOString();
    this.eventList.push({ type: 'log', sequence: 10, payload: { stream: 'stdout', message: 'worker says hello' } });
    this.eventList.push({ type: 'log', sequence: 11, payload: { stream: 'stderr', message: 'diagnostic' } });
    this.eventList.push({ type: 'assistant_message', sequence: 12, payload: {
      sessionId: 'ses_01J9A3J9Y7V8W2K4M6N0PQRSTZ', messageId: 'msg_01J9A3J9Y7V8W2K4M6N0PQRSTZ', text: 'Checking the repository first.',
    } });
    this.snapshot = { runId: spec.runId, state: 'running', startPhase: 'started', startAttempts: 1, startedAt: at, updatedAt: at, ownerGeneration: spec.ownerGeneration, pid: 1234, result: null, checkpoint: null };
    setTimeout(() => {
      this.state = 'succeeded';
      this.snapshot!.state = 'succeeded';
      this.snapshot!.updatedAt = new Date().toISOString();
      this.snapshot!.result = {
        schemaVersion: 1, runId: spec.runId, jobId: spec.jobId, userTaskId: spec.userTaskId, profileId: spec.profileId,
        ownerGeneration: spec.ownerGeneration, outcome: 'succeeded', exitReason: 'completed', exitCode: 0, exitSignal: null,
        exitObserved: true, startedAt: at, finishedAt: new Date().toISOString(), usage: { status: 'unknown' }, outputRefs: [],
        persistence: 'not_required', cleanup: 'completed', cleanupReason: 'cleaned', logPath: 'runs/test/events.jsonl',
      };
      this.snapshot!.checkpoint = { answer: { text: 'worker says hello', source: 'engine_stdout' } };
    }, this.completeAfterMs);
  }

  getRun(runId: string): Record<string, any> | null { return this.snapshot?.runId === runId ? this.snapshot : null; }
  getRunSpec(runId: string): RunSpec | null { return this.snapshot?.runId === runId ? this.spec : null; }
  supportsProfileWorkspace(): boolean { return this.profileWorkspaceEnabled; }
  supportsProfileSaveback(): boolean { return this.profileSavebackEnabled; }
  profileWorkspaceCommit(): string | null { return null; }
  events(runId: string, after = 0): Array<Record<string, any>> { return this.snapshot?.runId === runId ? this.eventList.filter((event) => event.sequence > after) : []; }
  exportManifest(): null { return null; }
  async readExportedArtifact(runId: string, sourcePath: string) {
    if (runId !== RUN_ID || sourcePath !== 'outputs/agent-note.md') throw new StorageError('BLOB_NOT_FOUND', 'no exported artifact for path');
    const bytes = Buffer.from('sandbox artifact bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      manifest: { artifactId: 'artifact-test', name: 'agent-note.md', mime: 'text/markdown', size: bytes.length, sha256,
        storageKey: `runs/${RUN_ID}/artifacts/artifact-test`, createdAt: new Date().toISOString(), runId: RUN_ID,
        userTaskId: 'task-vm-worker-test', profileId: 'profile-test' },
      bytes,
    };
  }
  health(): { ready: boolean; droppedLogCount: number; activeRuns: number; runs: number } { return { ready: true, droppedLogCount: 0, activeRuns: this.state === 'running' ? 1 : 0, runs: this.snapshot ? 1 : 0 }; }
  cancel(runId: string): { runId: string; status: 'stopped'; state: 'cancelled' } { this.state = 'cancelled'; return { runId, status: 'stopped', state: 'cancelled' }; }
  dispose(): void { void this.dataDir; }
}
