import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createExternalWorkers, loadAgentApiConfig } from '../src/api/config.js';
import { configuredTestRegistryBindingResolver } from '../src/adapters/remote-mcp.js';
import { AgentApi } from '../src/api/service.js';
import type { Principal } from '../src/api/auth.js';
import type { RunSpec } from '../src/contracts/run-spec.js';
import { makeRunSpec } from './helpers.js';
import { startMockWorker } from './external-worker-harness.js';

/**
 * Конфигурация воркеров — это и есть способ подключить движок. Тест закрепляет оба формата:
 * одиночный `EXTERNAL_WORKER_URL` (обратная совместимость) и список `AGENT_API_WORKERS`
 * (несколько движков, включая раннер на GitHub Actions).
 */

const base = {
  AGENT_API_KEY_REGISTRY: '/etc/agent-runner/key-registry.json',
  AGENT_API_PORT: '8787',
};

describe('конфигурация воркеров', () => {
  it('accepts a PKCS#8 DER signing key encoded for a single-line service secret', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateKeyPkcs8DerBase64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const resolver = configuredTestRegistryBindingResolver({ token: 'opaque-test-bearer-token-123', privateKeyPkcs8DerBase64,
      catalogueVersion: 'catalogue-v1', registryDigest: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9' });
    expect(resolver).toBeTypeOf('function');
  });

  it('loads the provisioned sandbox MCP secret names and digest from its pinned server policy', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const privateKeyPkcs8DerBase64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const server = {
      url: 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp',
      tokenEnvName: 'RUNNER_MCP_REGISTRY_TEST_TOKEN',
      headers: { Authorization: 'Bearer {env:RUNNER_MCP_REGISTRY_TEST_TOKEN}' },
      allowedTools: ['registry.fixture_read'],
      bindingScopes: { 'registry-mcp-test-160-read': 'registry:fixture-read' },
      startupTimeoutMs: 10000,
      policyVersion: 'registry-fixture-policy-v1',
      catalogueVersion: 'registry-fixture-catalogue-v1',
      registryDigest: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9',
    };
    const config = loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'http://127.0.0.1:8788',
      AGENT_API_REMOTE_MCP_SERVERS: JSON.stringify({ 'trained-assist-registry-test': server }),
      RUNNER_MCP_REGISTRY_TEST_TOKEN: 'opaque-test-bearer-token-123',
      RUNNER_MCP_REGISTRY_TEST_SIGNING_KEY_B64: privateKeyPkcs8DerBase64 });
    expect(config.remoteMcp?.servers['trained-assist-registry-test']?.url).toBe(server.url);
    expect(config.remoteMcp?.servers['trained-assist-registry-test']?.registryDigest).toBe(server.registryDigest);
  });

  it('process config resolves the pinned test binding after receipt runId creation and signs that runId', async () => {
    const mock = await startMockWorker({ autoDeliver: false });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    try {
      const policy = {
        'trained-assist-registry-test': {
          url: 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp', tokenEnvName: 'RUNNER_MCP_REGISTRY_TEST',
          headers: { Authorization: 'Bearer {env:RUNNER_MCP_REGISTRY_TEST}' },
          allowedTools: ['registry.fixture_read'], bindingScopes: { 'registry-mcp-test-160-read': 'registry:fixture-read' },
          startupTimeoutMs: 1000, policyVersion: 'registry-fixture-policy-v1', catalogueVersion: 'catalogue-v1',
          registryDigest: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9',
        },
      };
      const config = loadAgentApiConfig({
        ...base, EXTERNAL_WORKER_URL: mock.baseUrl, AGENT_API_PUBLIC_URL: 'https://runner.example',
        AGENT_API_REMOTE_MCP_SERVERS: JSON.stringify(policy),
        AGENT_API_TEST_MCP_BEARER: 'opaque-test-bearer-token-123',
        AGENT_API_TEST_MCP_ED25519_PRIVATE_KEY: privateKeyPem,
        AGENT_API_TEST_MCP_CATALOGUE_VERSION: 'catalogue-v1',
        AGENT_API_TEST_MCP_REGISTRY_DIGEST: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9',
      });
      const worker = createExternalWorkers(config)[0]!;
      const logs: Record<string, unknown>[] = [];
      const api = new AgentApi({ workers: [worker], logger: entry => logs.push(entry), resultGraceMs: 5 });
      const principal: Principal = { principalId: 'integration-telegram-ux-v1', profileId: 'integration-telegram-ux-v1', scopes: ['runs:read', 'runs:write'] };
      const receipt = api.submit(principal, 'test-registry-run-1', {
        engine: { name: worker.name, adapterVersion: '1' }, limits: { timeoutMs: 15000 }, envAllowlist: [], input: { inlinePrompt: 'Read the registry fixture.' },
        credentialBindings: [{ ref: 'registry-mcp-test-160-read', scope: 'registry:fixture-read' }],
        mcp: { servers: [{ serverId: 'trained-assist-registry-test', transport: 'remote', url: 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp', bindingRef: 'registry-mcp-test-160-read', allowedTools: ['registry.fixture_read'], policyVersion: 'registry-fixture-policy-v1', catalogueVersion: 'catalogue-v1' }] },
      });
      for (let i = 0; i < 50 && mock.launches.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
      expect(JSON.stringify(logs)).not.toContain('opaque-test-bearer-token-123');
      expect(JSON.stringify(logs)).not.toContain(privateKeyPem);
      expect(mock.launches, JSON.stringify(logs)).toHaveLength(1);
      const launch = mock.launches[0]!;
      const attachment = launch.mcp as { servers: Record<string, { headers: Record<string, string> }> };
      const proof = attachment.servers['trained-assist-registry-test']!.headers['X-MCP-Run-Binding']!;
      const [header, payload, signature] = proof.split('.');
      const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
      expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))).toEqual({ alg: 'EdDSA', typ: 'JWT' });
      expect(decoded).toMatchObject({ runId: receipt.runId, sub: receipt.runId, profileId: 'integration-telegram-ux-v1', userTaskId: receipt.userTaskId, policyVersion: 'registry-fixture-policy-v1', catalogueVersion: 'catalogue-v1', registryDigest: '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9' });
      expect(verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
      expect(launch.mcpSecrets).toEqual({ RUNNER_MCP_REGISTRY_TEST: 'opaque-test-bearer-token-123' });
      expect(JSON.stringify(api['opts'] ?? {})).not.toContain(privateKeyPem);
      await api.dispose();
    } finally { await mock.close(); }
  });

  it('rejects incomplete or mismatched trusted test binding configuration without echoing secrets', () => {
    expect(() => loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'https://worker.example', AGENT_API_TEST_MCP_BEARER: 'secret' })).toThrow(/requires bearer, Ed25519 key/);
    expect(() => loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'https://worker.example', AGENT_API_TEST_MCP_BEARER: 'opaque-test-bearer-token-123', AGENT_API_TEST_MCP_ED25519_PRIVATE_KEY: 'not-a-key', AGENT_API_TEST_MCP_CATALOGUE_VERSION: 'catalogue-v1', AGENT_API_TEST_MCP_REGISTRY_DIGEST: 'bad-digest' })).toThrow(/configuration is invalid/);
  });

  it('forwards only allowed host pool values to the actual launch request', async () => {
    const mock = await startMockWorker({ autoDeliver: false });
    try {
      const logs: Record<string, unknown>[] = [];
      const config = loadAgentApiConfig({
        ...base,
        EXTERNAL_WORKER_URL: mock.baseUrl,
        EXTERNAL_WORKER_TOKEN: 'worker-token-fixture',
        AGENT_API_PUBLIC_URL: 'https://runner.example',
        AGENT_API_ENV: JSON.stringify({ LLM_LADDER_TOKEN: 'model-key-fixture', ROOT_TOKEN: 'root-key-fixture', GOOGLE_APPLICATION_CREDENTIALS: '/host/only/service-account.json' }),
      });
      const worker = createExternalWorkers(config, (entry) => logs.push(entry))[0]!;
      const spec = makeRunSpec({ engine: { name: worker.name, adapterVersion: '1' }, input: { inlinePrompt: 'CSV\ncategory,amount\nfood,150' }, envAllowlist: ['LLM_LADDER_TOKEN'] });
      await worker.launch(spec);
      expect(mock.launches[0]!.env).toEqual({ LLM_LADDER_TOKEN: 'model-key-fixture' });
      expect(mock.launches[0]!.input).toEqual(spec.input);
      expect(JSON.stringify(mock.launches[0])).not.toContain('root-key-fixture');
      expect(JSON.stringify(mock.launches[0])).not.toContain('/host/only/service-account.json');
      expect(JSON.stringify(logs)).not.toContain('model-key-fixture');
      await worker.launch({ ...spec, runId: 'run-no-model-key', operationId: 'op-no-model-key', envAllowlist: [] });
      expect(mock.launches[1]!.env).toEqual({});
    } finally {
      await mock.close();
    }
  });

  it('public callback URL reaches every worker without entering the run env pool', () => {
    const config = loadAgentApiConfig({
      ...base,
      AGENT_API_PUBLIC_URL: ' https://runner.example/sandbox/ ',
      AGENT_API_WORKERS: JSON.stringify([
        { engine: 'dynamic-ip-azure-agent-run', baseUrl: 'https://azure.example', token: 'a' },
        { engine: 'github-actions-agent-run', baseUrl: 'https://receiver.example', token: 'b' },
      ]),
    });
    expect(config.publicUrl).toBe('https://runner.example/sandbox/');
    expect(config.env).toEqual({});
    const spec = { runId: 'run-callback' } as RunSpec;
    for (const worker of createExternalWorkers(config)) {
      expect(worker.resultUrlFor(spec)).toBe('https://runner.example/sandbox/v1/worker/launches/run-callback/result');
    }
  });

  it.each([undefined, '   '])('missing public callback URL retains the existing preflight refusal (%s)', (publicUrl) => {
    const config = loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'https://worker.example', AGENT_API_PUBLIC_URL: publicUrl });
    expect(config.publicUrl).toBeNull();
    expect(() => createExternalWorkers(config)[0]!.resultUrlFor({ runId: 'run-callback' } as RunSpec)).toThrowError(/does not know its own public URL/);
  });

  it('allows an explicitly configured HTTP sandbox callback', () => {
    const config = loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'https://worker.example', AGENT_API_PUBLIC_URL: 'http://runner.example:18878' });
    expect(createExternalWorkers(config)[0]!.resultUrlFor({ runId: 'run-callback' } as RunSpec)).toBe('http://runner.example:18878/v1/worker/launches/run-callback/result');
  });

  it.each(['not-a-url', 'ftp://runner.example', 'https://user:secret@runner.example', 'https://runner.example?token=secret', 'https://runner.example#fragment'])('rejects invalid callback configuration without echoing its value (%s)', (publicUrl) => {
    const load = () => loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'https://worker.example', AGENT_API_PUBLIC_URL: publicUrl });
    expect(load).toThrowError('AGENT_API_PUBLIC_URL: expected an absolute http(s) URL without credentials, query, or fragment');
    try {
      load();
    } catch (error) {
      expect((error as Error).message).not.toContain(publicUrl);
    }
  });

  it('одиночный EXTERNAL_WORKER_URL остаётся рабочим и отвечает дефолтному движку', () => {
    const config = loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'https://worker.example', EXTERNAL_WORKER_TOKEN: 'secret' });
    expect(config.workers).toEqual([
      {
        engine: 'azure-dynamic-ip-agent-run',
        baseUrl: 'https://worker.example',
        token: 'secret',
        launchDeadlineMs: 600000,
        acceptDeadlineMs: 30000,
        cancelDeadlineMs: 30000,
      },
    ]);
    expect(config.engineChain).toBeNull();
  });

  it('AGENT_API_WORKERS задаёт несколько движков, у каждого свой воркер', () => {
    const config = loadAgentApiConfig({
      ...base,
      AGENT_API_WORKERS: JSON.stringify([
        { engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://gha.example', token: 'a' },
        { engine: 'eu-vm-agent-run', baseUrl: 'https://eu.example', token: 'b' },
      ]),
    });
    expect(config.workers.map((worker) => worker.engine)).toEqual(['azure-dynamic-ip-agent-run', 'eu-vm-agent-run']);
    expect(config.workers.map((worker) => worker.baseUrl)).toEqual(['https://gha.example', 'https://eu.example']);
  });

  it('имя движка можно переопределить и в одиночном формате', () => {
    const config = loadAgentApiConfig({
      ...base,
      EXTERNAL_WORKER_URL: 'https://receiver.example',
      EXTERNAL_WORKER_ENGINE: 'eu-vm-agent-run',
    });
    expect(config.workers[0]!.engine).toBe('eu-vm-agent-run');
  });

  it('без воркера — отказ на старте: API без способа запустить агента не поднимается', () => {
    expect(() => loadAgentApiConfig({ ...base })).toThrowError(/no external worker configured/);
  });

  it('один движок дважды — отказ: запрос не должен угадывать, куда идти', () => {
    expect(() =>
      loadAgentApiConfig({
        ...base,
        AGENT_API_WORKERS: JSON.stringify([
          { engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://a.example' },
          { engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://b.example' },
        ]),
      }),
    ).toThrowError(/declared twice/);
  });

  it('не http(s) URL воркера — отказ до старта', () => {
    expect(() => loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'ftp://worker.example' })).toThrowError(/http\(s\)/);
  });

  it('таймауты воркера читаются из env и применяются ко всем движкам', () => {
    const config = loadAgentApiConfig({
      ...base,
      EXTERNAL_WORKER_URL: 'https://worker.example',
      EXTERNAL_WORKER_LAUNCH_DEADLINE_MS: '120000',
      EXTERNAL_WORKER_CANCEL_DEADLINE_MS: '5000',
    });
    expect(config.workers[0]).toMatchObject({ launchDeadlineMs: 120000, cancelDeadlineMs: 5000 });
  });

  it('пул окружения и репозиторий по умолчанию разбираются из env', () => {
    const config = loadAgentApiConfig({
      ...base,
      EXTERNAL_WORKER_URL: 'https://worker.example',
      AGENT_API_ENV: JSON.stringify({ PATH: '/usr/bin', LANG: 'C.UTF-8' }),
      RUNNER_DEFAULT_REPO: 'org/default-repo',
    });
    expect(config.env).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8' });
    expect(config.defaultRepository).toBe('org/default-repo');
  });

  it('кривой JSON в AGENT_API_WORKERS — отказ с понятной причиной, а не падение позже', () => {
    expect(() => loadAgentApiConfig({ ...base, AGENT_API_WORKERS: '{ nope' })).toThrowError(/JSON array/);
    expect(() => loadAgentApiConfig({ ...base, AGENT_API_WORKERS: '[]' })).toThrowError(/non-empty/);
  });

  it('AGENT_API_ENGINE_CHAIN задаёт порядок проб, а не сортировку имён', () => {
    const config = loadAgentApiConfig({
      ...base,
      AGENT_API_WORKERS: JSON.stringify([
        { engine: 'rf-vm-agent-run', baseUrl: 'https://rf.example', token: 'c' },
        { engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://gha.example', token: 'a' },
        { engine: 'eu-vm-agent-run', baseUrl: 'https://eu.example', token: 'b' },
      ]),
      AGENT_API_ENGINE_CHAIN: 'azure-dynamic-ip-agent-run,eu-vm-agent-run,rf-vm-agent-run',
    });
    expect(config.engineChain).toEqual(['azure-dynamic-ip-agent-run', 'eu-vm-agent-run', 'rf-vm-agent-run']);
  });

  it('бюджет приёма рана свой у каждого движка, общий — из EXTERNAL_WORKER_ACCEPT_DEADLINE_MS', () => {
    const config = loadAgentApiConfig({
      ...base,
      AGENT_API_WORKERS: JSON.stringify([
        { engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://gha.example', acceptDeadlineMs: 30000 },
        { engine: 'eu-vm-agent-run', baseUrl: 'https://eu.example' },
      ]),
      EXTERNAL_WORKER_ACCEPT_DEADLINE_MS: '120000',
    });
    expect(config.workers.map((worker) => worker.acceptDeadlineMs)).toEqual([30000, 120000]);
  });

  it('движок цепочки без воркера — отказ на старте, а не падение рана на середине цепочки', () => {
    expect(() =>
      loadAgentApiConfig({
        ...base,
        AGENT_API_WORKERS: JSON.stringify([{ engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://gha.example' }]),
        AGENT_API_ENGINE_CHAIN: 'azure-dynamic-ip-agent-run,rf-vm-agent-run',
      }),
    ).toThrowError(/has no worker/);
  });

  it('бюджет reconcile читается из env: мёртвый движок не вешает проверку на таймаут запуска', () => {
    const config = loadAgentApiConfig({
      ...base,
      EXTERNAL_WORKER_URL: 'https://worker.example',
      EXTERNAL_WORKER_RECONCILE_DEADLINE_MS: '2500',
    });
    expect(config.reconcileDeadlineMs).toBe(2500);
  });

  it('публичный адрес API читается из AGENT_API_PUBLIC_URL', () => {
    const config = loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'https://worker.example', AGENT_API_PUBLIC_URL: 'https://api.example' });
    expect(config.publicUrl).toBe('https://api.example');
  });

  it('цепочка без воркеров не объявляется: ран идёт на названный клиентом движок', () => {
    const config = loadAgentApiConfig({
      ...base,
      AGENT_API_WORKERS: JSON.stringify([{ engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://gha.example' }]),
    });
    expect(config.engineChain).toBeNull();
  });
});
