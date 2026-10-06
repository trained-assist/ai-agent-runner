import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentApi } from '../../src/api/service.js';
import { ExternalWorkerAdapter } from '../../src/adapters/external-worker-adapter.js';
import {
  REGISTRY_FIXTURE_BINDING_REF, REGISTRY_FIXTURE_CATALOGUE_VERSION, REGISTRY_FIXTURE_EXPIRY_ENV,
  REGISTRY_FIXTURE_POLICY_VERSION, REGISTRY_FIXTURE_PROFILE_ID, REGISTRY_FIXTURE_REGISTRY_DIGEST,
  REGISTRY_FIXTURE_SCOPE, REGISTRY_FIXTURE_SERVER_ID, REGISTRY_FIXTURE_SIGNING_KEY_ENV,
  REGISTRY_FIXTURE_TOKEN_ENV, REGISTRY_FIXTURE_TOOL, REGISTRY_FIXTURE_URL,
  registryFixtureBindingResolver,
} from '../../src/adapters/remote-mcp.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const TEST_TOKEN = 'offline-test-bearer-token-160';
const RUNNER_PRINCIPAL = {
  principalId: 'integration-telegram-ux-v1', profileId: REGISTRY_FIXTURE_PROFILE_ID,
  scopes: ['runs:read', 'runs:write'], engines: ['dynamic-ip-azure-agent-run'],
};

function b64(value: string): string { return Buffer.from(value).toString('base64url'); }

describe('CP serialized submit → Runner admission/proof → Host MCP', () => {
  it.skipIf(!existsSync(resolve('integration-deps/trained-assist-control-plane/src/run-spec/run-spec.ts'))
    || !existsSync(resolve('integration-deps/trained-assist-mcp-host/src/worker.mjs')))(
  'uses the receipt runId, verifies the Runner proof, and rejects claim/header drift', async () => {
    const moduleLoader = await createServer({ configFile: resolve('vitest.config.ts'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
    try {
    const cpRunSpecModule = await moduleLoader.ssrLoadModule(resolve('integration-deps/trained-assist-control-plane/src/run-spec/run-spec.ts'));
    const cpAdapterModule = await moduleLoader.ssrLoadModule(resolve('integration-deps/trained-assist-control-plane/src/runner-adapter/runner-api-adapter.ts'));
    const cpFixtureModule = await moduleLoader.ssrLoadModule(resolve('integration-deps/trained-assist-control-plane/tests/fixtures/registry-mcp-test-160-descriptor.ts'));
    const hostModule = await import(pathToFileURL(resolve('integration-deps/trained-assist-mcp-host/src/worker.mjs')).href);
    const { buildRunSpec, defaultRunSpecPolicy } = cpRunSpecModule;
    const ControlPlaneRunnerApiAdapter = cpAdapterModule.RunnerApiAdapter;
    const registryMcpTest160Descriptor = cpFixtureModule.registryMcpTest160Descriptor;
    const hostWorker = hostModule.default;
    const keys = generateKeyPairSync('ed25519');
    const signingKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const { sign } = await import('node:crypto');
    const publicJwk = keys.publicKey.export({ format: 'jwk' });
    const expiry = new Date(Date.now() + 60 * 60_000).toISOString();
    const cpSpec = buildRunSpec({
      userTaskId: 'task-integration-telegram-160', profileId: REGISTRY_FIXTURE_PROFILE_ID,
      conversationId: 'conversation-integration-telegram-160', ownerGeneration: 1,
      engineName: 'dynamic-ip-azure-agent-run', prompt: 'Read the pinned Registry fixture', refs: [],
      instructions: null, attemptRunId: null, timeoutMs: 60_000,
    }, { ...defaultRunSpecPolicy(), mcp: { servers: [registryMcpTest160Descriptor] } });

    // Exercise CP's real RunSpec projection and submit adapter before Runner admission.
    let cpBody: unknown;
    const cpAdapter = new ControlPlaneRunnerApiAdapter('https://runner.offline.test', 'offline-key', async (_url, init) => {
      cpBody = JSON.parse(String(init?.body));
      return Response.json({ requestId: 'cp-request', userTaskId: 'task-integration-telegram-160', runId: 'unused-cp-run', deduplicated: false });
    });
    await cpAdapter.submit({ userTaskId: 'task-integration-telegram-160', idempotencyKey: 'cp-attempt-1', runSpec: cpSpec.spec });
    expect(cpBody).toMatchObject({
      userTaskId: 'task-integration-telegram-160',
      mcp: { servers: [registryMcpTest160Descriptor] },
    });

    const resolver = registryFixtureBindingResolver({
      [REGISTRY_FIXTURE_SERVER_ID]: {
        url: REGISTRY_FIXTURE_URL, tokenEnvName: REGISTRY_FIXTURE_TOKEN_ENV,
        headers: { Authorization: `Bearer {env:${REGISTRY_FIXTURE_TOKEN_ENV}}` },
        bindingScopes: { [REGISTRY_FIXTURE_BINDING_REF]: REGISTRY_FIXTURE_SCOPE },
        allowedTools: [REGISTRY_FIXTURE_TOOL], startupTimeoutMs: 0,
        policyVersion: REGISTRY_FIXTURE_POLICY_VERSION,
        catalogueVersion: REGISTRY_FIXTURE_CATALOGUE_VERSION,
        registryDigest: REGISTRY_FIXTURE_REGISTRY_DIGEST,
      },
    }, TEST_TOKEN, expiry, signingKey)!;

    let launchBody: Record<string, any> | undefined;
    let externalLaunchCount = 0;
    let hostToolCalled = false;
    let finishLaunch!: () => void;
    let launchFailure: unknown;
    const launchDone = new Promise<void>(resolve => { finishLaunch = resolve; });
    const runnerWorker = new ExternalWorkerAdapter({
      baseUrl: 'https://external-worker.offline.test', engineName: 'dynamic-ip-azure-agent-run',
      baseUrlForResult: 'https://runner-api.offline.test',
      remoteMcp: { servers: {
        [REGISTRY_FIXTURE_SERVER_ID]: {
          url: REGISTRY_FIXTURE_URL, tokenEnvName: REGISTRY_FIXTURE_TOKEN_ENV,
          headers: { Authorization: `Bearer {env:${REGISTRY_FIXTURE_TOKEN_ENV}}` },
          bindingScopes: { [REGISTRY_FIXTURE_BINDING_REF]: REGISTRY_FIXTURE_SCOPE },
          allowedTools: [REGISTRY_FIXTURE_TOOL], startupTimeoutMs: 0,
          policyVersion: REGISTRY_FIXTURE_POLICY_VERSION,
          catalogueVersion: REGISTRY_FIXTURE_CATALOGUE_VERSION,
          registryDigest: REGISTRY_FIXTURE_REGISTRY_DIGEST,
        },
      }, resolveBinding: resolver },
      env: { [REGISTRY_FIXTURE_TOKEN_ENV]: TEST_TOKEN, [REGISTRY_FIXTURE_EXPIRY_ENV]: expiry, [REGISTRY_FIXTURE_SIGNING_KEY_ENV]: signingKey },
      fetchImpl: async (_url, init) => {
        if (!String(_url).endsWith('/v1/launch')) {
          const runId = new URL(String(_url)).pathname.split('/')[3] ?? 'unknown-run';
          return Response.json({ runId, status: 'running', updatedAt: new Date().toISOString() });
        }
        try {
        if (String(_url).endsWith('/v1/launch')) externalLaunchCount += 1;
        launchBody = JSON.parse(String(init?.body));
        const attached = launchBody.mcp.servers[REGISTRY_FIXTURE_SERVER_ID];
        const secrets = launchBody.mcpSecrets as Record<string, string>;
        const wireHeaders = Object.fromEntries(Object.entries(attached.headers as Record<string, string>).map(([name, value]) =>
          [name, value.replace(`{env:${REGISTRY_FIXTURE_TOKEN_ENV}}`, secrets[REGISTRY_FIXTURE_TOKEN_ENV] ?? '')]));
        const baseHeaders = { ...wireHeaders, 'content-type': 'application/json' };
        const hostEnv = {
          MCP_TEST_AUTH_TOKEN: TEST_TOKEN, MCP_TEST_PRINCIPAL_ID: 'integration-telegram-ux-v1',
          MCP_TEST_EXPIRES_AT: expiry, MCP_TEST_RUNNER_PUBLIC_JWK: JSON.stringify(publicJwk),
          MCP_TEST_CATALOGUE_VERSION: REGISTRY_FIXTURE_CATALOGUE_VERSION,
        };
        const callHost = async (headers: Record<string, string>, method: string, id: string) => hostWorker.fetch(new Request(REGISTRY_FIXTURE_URL, {
          method: 'POST', headers: { ...baseHeaders, ...headers },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(method === 'tools/call' ? { params: { name: REGISTRY_FIXTURE_TOOL, arguments: {} } } : {}) }),
        }), hostEnv);
        const initialize = await callHost({}, 'initialize', 'initialize');
        expect((await initialize.json()).result.protocolVersion).toBe('2024-11-05');
        const initialized = await hostWorker.fetch(new Request(REGISTRY_FIXTURE_URL, {
          method: 'POST', headers: { ...baseHeaders }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        }), hostEnv);
        expect(initialized.status).toBe(202);
        const list = await callHost({}, 'tools/list', 'list');
        const listPayload = await list.json();
        expect(listPayload, JSON.stringify(listPayload)).toMatchObject({ result: { tools: [{ name: REGISTRY_FIXTURE_TOOL }] } });
        const good = await callHost({}, 'tools/call', 'call');
        const goodPayload = await good.json();
        expect(JSON.parse(goodPayload.result.content[0].text)).toMatchObject({ marker: 'registry-fixture-marker-160-v1' });
        hostToolCalled = true;

        const actualHeaders = attached.headers as Record<string, string>;
        for (const [claim, value] of Object.entries({
          catalogueVersion: 'other-catalogue', policyVersion: 'other-policy', registryDigest: '0'.repeat(64), scope: 'registry:write',
          userTaskId: 'foreign-task', profileId: 'foreign-profile', runId: 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        })) {
          const parts = actualHeaders['X-MCP-Run-Binding'].split('.');
          const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
          if (claim === 'runId') { claims.runId = value; claims.sub = value; }
          else claims[claim] = value;
          const input = `${parts[0]}.${b64(JSON.stringify(claims))}`;
          const key = createPrivateKey({ key: Buffer.from(signingKey, 'base64'), format: 'der', type: 'pkcs8' });
          const mutatedProof = `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
          const response = await callHost({ 'X-MCP-Run-Binding': mutatedProof }, 'tools/call', `deny-${claim}`);
          expect((await response.json()).error.code).toBe(-32001);
        }
        for (const [header, value] of Object.entries({
          'X-MCP-User-Task-Id': 'foreign-task', 'X-MCP-Profile': 'foreign-profile',
          'X-MCP-Run-Id': 'run_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'X-MCP-Scope': 'registry:write',
        })) {
          const response = await callHost({ [header]: value }, 'tools/call', `deny-header-${header}`);
          expect((await response.json()).error.code).toBe(-32001);
        }
        const accepted = Response.json({ runId: launchBody.runId, operationId: launchBody.operationId, status: 'accepted',
          statusUrl: `https://external-worker.offline.test/v1/runs/${launchBody.runId}/status`,
          resultUrl: `https://external-worker.offline.test/v1/runs/${launchBody.runId}/result` });
        return accepted;
        } catch (error) {
          launchFailure = error;
          throw error;
        } finally {
          finishLaunch();
        }
      },
    });
    const api = new AgentApi({ workers: [runnerWorker] });
    try {
      const receipt = api.submit(RUNNER_PRINCIPAL, 'cp-attempt-1', cpBody);
      expect(receipt.runId).toMatch(/^run_[a-f0-9-]{36}$/);
      await launchDone;
      expect(launchFailure).toBeUndefined();
      expect(launchBody?.runId).toBe(receipt.runId);
      expect(launchBody?.mcp.servers[REGISTRY_FIXTURE_SERVER_ID].headers['X-MCP-Run-Id']).toBe(receipt.runId);
      const claims = JSON.parse(Buffer.from(launchBody.mcp.servers[REGISTRY_FIXTURE_SERVER_ID].headers['X-MCP-Run-Binding'].split('.')[1], 'base64url').toString());
      expect(claims).toMatchObject({ runId: receipt.runId, sub: receipt.runId, userTaskId: receipt.userTaskId,
        profileId: REGISTRY_FIXTURE_PROFILE_ID, catalogueVersion: REGISTRY_FIXTURE_CATALOGUE_VERSION,
        registryDigest: REGISTRY_FIXTURE_REGISTRY_DIGEST, scope: REGISTRY_FIXTURE_SCOPE });
      expect(hostToolCalled).toBe(true);
      const rejectedDrift = await resolver(REGISTRY_FIXTURE_BINDING_REF, {
        mode: 'launch', admittedAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
        startupTimeoutMs: 0, scope: REGISTRY_FIXTURE_SCOPE, timeoutMs: 60_000,
        runId: receipt.runId, profileId: REGISTRY_FIXTURE_PROFILE_ID, userTaskId: receipt.userTaskId,
        conversationId: 'conversation-integration-telegram-160', ownerGeneration: 1,
        operationId: 'offline-drift', engine: 'dynamic-ip-azure-agent-run', serverId: REGISTRY_FIXTURE_SERVER_ID,
        url: REGISTRY_FIXTURE_URL, allowedTools: [REGISTRY_FIXTURE_TOOL],
        catalogueVersion: REGISTRY_FIXTURE_CATALOGUE_VERSION, policyVersion: REGISTRY_FIXTURE_POLICY_VERSION,
        registryDigest: '0'.repeat(64),
      });
      expect(rejectedDrift).toBeNull();
      await expect(runnerWorker.launch({
        ...cpSpec.spec, runId: receipt.runId, userTaskId: receipt.userTaskId,
        operationId: launchBody.operationId,
        mcp: { servers: [{ ...registryMcpTest160Descriptor, registryDigest: '0'.repeat(64) }] },
      } as never)).rejects.toThrow();
      expect(externalLaunchCount).toBe(1);
    } finally {
      await api.dispose();
    }
    } finally {
      await moduleLoader.close();
    }
  }, 20000);
});
