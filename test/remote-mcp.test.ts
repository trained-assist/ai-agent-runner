import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { ExternalWorkerAdapter } from '../src/adapters/external-worker-adapter.js';
import { configuredDocumentsBindingResolver, localDocumentsBindingResolver, parseRemoteMcpServerPolicies, registeredDocumentsBindingResolver, registryFixtureBindingResolver, REGISTRY_FIXTURE_BINDING_REF, REGISTRY_FIXTURE_CATALOGUE_VERSION, REGISTRY_FIXTURE_EXPIRY_ENV, REGISTRY_FIXTURE_POLICY_VERSION, REGISTRY_FIXTURE_PROFILE_ID, REGISTRY_FIXTURE_REGISTRY_DIGEST, REGISTRY_FIXTURE_SCOPE, REGISTRY_FIXTURE_SERVER_ID, REGISTRY_FIXTURE_TOKEN_ENV, REGISTRY_FIXTURE_TOOL, REGISTRY_FIXTURE_URL, resolveRemoteMcpAttachment, type DocumentsHttpRegistration, type RemoteMcpBinding, type RemoteMcpBindingContext, type RemoteMcpHostOptions } from '../src/adapters/remote-mcp.js';
import { validateSubmitRequest } from '../src/api/contracts.js';
import { validateRunSpec, type RunSpec } from '../src/contracts/run-spec.js';
import { makeRunSpec } from './helpers.js';
import { AgentApi } from '../src/api/service.js';
import type { Principal } from '../src/api/auth.js';
import { createExternalWorkers, loadAgentApiConfig } from '../src/api/config.js';
import { startMockWorker } from './external-worker-harness.js';
import { StatelessStore } from '../src/api/stateless-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';
import type { ExternalWorker } from '../src/adapters/external-worker-adapter.js';

const now = new Date('2026-10-05T00:00:00.000Z');
const descriptor = { serverId: 'documents', transport: 'remote' as const, url: 'https://mcp.example.test/mcp', bindingRef: 'docs-binding', allowedTools: ['read_sheet'], toolTimeoutMs: 1000 };
const policies = { documents: { url: descriptor.url, tokenEnvName: 'RUNNER_MCP_DOCS_TOKEN', headers: { Authorization: 'Bearer {env:RUNNER_MCP_DOCS_TOKEN}' }, allowedTools: ['read_sheet', 'write_sheet'], bindingScopes: { 'docs-binding': 'documents:approved' }, startupTimeoutMs: 0 } };
const token = 'opaque_fixture_token_123456';
import { registryMcpTest160Descriptor as cpDescriptorFixture } from './fixtures/registry-mcp-test-160-descriptor.js';

function setup() {
  const spec = makeRunSpec({ input: { inlinePrompt: 'read approved sheet' }, mcp: { servers: [descriptor] }, credentialBindings: [{ ref: descriptor.bindingRef, scope: 'documents:approved', status: 'active' }] });
  const binding: RemoteMcpBinding = { runId: spec.runId, profileId: spec.profileId, userTaskId: spec.userTaskId, conversationId: spec.conversationId, ownerGeneration: spec.ownerGeneration, engine: spec.engine.name, serverId: descriptor.serverId, url: descriptor.url, scope: 'documents:approved', allowedTools: ['read_sheet'], expiresAt: '2026-10-05T01:00:00.000Z', token };
  const resolveBinding = vi.fn(async () => binding);
  const host: RemoteMcpHostOptions = { servers: policies, resolveBinding };
  return { spec, binding, host, resolveBinding };
}

function documentsSetup() {
  const { spec, host } = setup();
  spec.profileId = 'integration-v1';
  spec.runId = 'run_01234567-89ab-cdef-0123-456789abcdef';
  const registration: DocumentsHttpRegistration = { runtime: '/private/documents-runtime', serverId: descriptor.serverId, url: descriptor.url, scope: 'documents:approved', allowedTools: descriptor.allowedTools, userTaskId: spec.userTaskId, expectedActorProfile: 'integration-v1', credentialProfile: 'sandbox-integrator-google', conversationId: spec.conversationId, ownerGeneration: spec.ownerGeneration, engine: spec.engine.name, mintOnResolve: true, startOnResolve: true, port: 8791 };
  return { spec, host, registrations: { [descriptor.bindingRef]: registration } };
}

function fakeStartup() {
  return vi.fn(async () => ({ server: { listening: true }, isReady: () => true, close: vi.fn(async () => undefined) }));
}

function journaledRun(spec: RunSpec, admittedAt: string): StatelessStore {
  const directory = mkdtempSync(join(tmpdir(), 'runner-mcp-replay-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const journal = join(directory, 'admissions.jsonl');
  const original = new StatelessStore({}, journal);
  original.put({ schemaVersion: 2, requestId: 'request-replay', principalId: 'principal-replay', profileId: spec.profileId, userTaskId: spec.userTaskId, conversationId: spec.conversationId, jobId: spec.jobId, idempotencyKey: 'replay-key', payloadHash: 'replay-hash', runId: spec.runId, operationId: spec.operationId, ownerGeneration: spec.ownerGeneration, spec, createdAt: admittedAt });
  original.appendDispatched(spec.runId, spec.engine.name, admittedAt);
  return new StatelessStore({}, journal);
}

describe('remote MCP public contract', () => {
  it('preserves descriptor through Submit normalization', () => {
    const { spec } = setup();
    const result = validateSubmitRequest({ engine: spec.engine, limits: spec.limits, input: spec.input, credentialBindings: spec.credentialBindings, mcp: spec.mcp });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mcp).toEqual(spec.mcp);
  });

  it.each([{ headers: { Authorization: token } }, { mcpSecrets: { token } }, { bindingRef: undefined }, { url: 'https://user:secret@mcp.example.test/mcp' }, { url: 'https://mcp.example.test/mcp?token=secret' }, { url: 'http://mcp.example.test/mcp' }])('rejects unsafe public descriptor %j', change => {
    const { spec } = setup();
    expect(validateRunSpec({ ...spec, mcp: { servers: [{ ...descriptor, ...change }] } }).ok).toBe(false);
  });
});

describe('trusted registry fixture binding', () => {
  const expiry = '2026-10-05T01:00:00.000Z';
  const fixtureSigningKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const registryPolicy = {
    [REGISTRY_FIXTURE_SERVER_ID]: {
      url: REGISTRY_FIXTURE_URL,
      tokenEnvName: REGISTRY_FIXTURE_TOKEN_ENV,
      headers: { Authorization: `Bearer {env:${REGISTRY_FIXTURE_TOKEN_ENV}}` },
      bindingScopes: { [REGISTRY_FIXTURE_BINDING_REF]: 'registry:fixture-read' },
      allowedTools: [REGISTRY_FIXTURE_TOOL],
      startupTimeoutMs: 0,
      policyVersion: REGISTRY_FIXTURE_POLICY_VERSION,
      catalogueVersion: REGISTRY_FIXTURE_CATALOGUE_VERSION,
      registryDigest: REGISTRY_FIXTURE_REGISTRY_DIGEST,
    },
  };
  const context: RemoteMcpBindingContext = {
    mode: 'launch', admittedAt: now.toISOString(), checkedAt: now.toISOString(), startupTimeoutMs: 0,
    scope: 'registry:fixture-read', timeoutMs: 30000, runId: 'run_01234567-89ab-cdef-0123-456789abcdef',
    profileId: REGISTRY_FIXTURE_PROFILE_ID, userTaskId: 'telegram-task-160', conversationId: 'telegram-conversation-160',
    ownerGeneration: 1, operationId: 'operation-160', engine: 'dynamic-ip-azure-agent-run',
    serverId: REGISTRY_FIXTURE_SERVER_ID, url: REGISTRY_FIXTURE_URL, allowedTools: [REGISTRY_FIXTURE_TOOL],
    catalogueVersion: REGISTRY_FIXTURE_CATALOGUE_VERSION, policyVersion: REGISTRY_FIXTURE_POLICY_VERSION,
    registryDigest: REGISTRY_FIXTURE_REGISTRY_DIGEST,
  };

  it('creates a run-scoped binding only for the pinned test profile/server/tool and shared expiry', async () => {
    const signing = generateKeyPairSync('ed25519');
    const signingKey = signing.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const resolver = registryFixtureBindingResolver(registryPolicy, token, expiry, signingKey);
    expect(resolver).toBeDefined();
    const binding = await resolver!(REGISTRY_FIXTURE_BINDING_REF, context);
    expect(binding).toEqual({
      runId: context.runId, profileId: context.profileId, userTaskId: context.userTaskId,
      conversationId: context.conversationId, ownerGeneration: context.ownerGeneration,
      engine: context.engine, serverId: REGISTRY_FIXTURE_SERVER_ID, url: REGISTRY_FIXTURE_URL,
      scope: 'registry:fixture-read', allowedTools: [REGISTRY_FIXTURE_TOOL], expiresAt: expiry, token, runBinding: expect.any(String),
    });
    const parts = binding!.runBinding!.split('.');
    expect(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))).toMatchObject({
      iss: 'trained-assist-agent-runner', aud: 'trained-assist:registry-mcp:test',
      sub: context.runId, runId: context.runId, userTaskId: context.userTaskId,
      profileId: REGISTRY_FIXTURE_PROFILE_ID, principalId: 'integration-telegram-ux-v1',
      serverId: REGISTRY_FIXTURE_SERVER_ID, bindingRef: REGISTRY_FIXTURE_BINDING_REF,
      allowedTools: [REGISTRY_FIXTURE_TOOL], policyVersion: 'registry-fixture-policy-v1',
      catalogueVersion: 'registry-fixture-catalogue-v1',
      registryDigest: REGISTRY_FIXTURE_REGISTRY_DIGEST, scope: REGISTRY_FIXTURE_SCOPE,
    });
    expect(verifySignature(null, Buffer.from(`${parts[0]}.${parts[1]}`), signing.publicKey, Buffer.from(parts[2]!, 'base64url'))).toBe(true);
  });

  it.each([
    { label: 'binding ref', ref: 'other-binding', change: {} },
    { label: 'server id', ref: REGISTRY_FIXTURE_BINDING_REF, change: { serverId: 'other-server' } },
    { label: 'endpoint', ref: REGISTRY_FIXTURE_BINDING_REF, change: { url: 'https://other.example.test/mcp' } },
    { label: 'profile', ref: REGISTRY_FIXTURE_BINDING_REF, change: { profileId: 'integration-v1' } },
    { label: 'catalogue version', ref: REGISTRY_FIXTURE_BINDING_REF, change: { catalogueVersion: 'other-catalogue' } },
    { label: 'policy version', ref: REGISTRY_FIXTURE_BINDING_REF, change: { policyVersion: 'other-policy' } },
    { label: 'scope', ref: REGISTRY_FIXTURE_BINDING_REF, change: { scope: 'registry:write' } },
    { label: 'registry digest', ref: REGISTRY_FIXTURE_BINDING_REF, change: { registryDigest: '0'.repeat(64) } },
    { label: 'tool', ref: REGISTRY_FIXTURE_BINDING_REF, change: { allowedTools: ['registry.fixture_write'] } },
    { label: 'multiple tools', ref: REGISTRY_FIXTURE_BINDING_REF, change: { allowedTools: [REGISTRY_FIXTURE_TOOL, 'registry.fixture_write'] } },
  ] as Array<{ label: string; ref: string; change: Partial<RemoteMcpBindingContext> }>)('refuses a mismatched $label', async ({ ref, change }) => {
    const resolver = registryFixtureBindingResolver(registryPolicy, token, expiry, fixtureSigningKey)!;
    expect(await resolver(ref, { ...context, ...change })).toBeNull();
  });

  it.each([
    ['missing token', undefined, expiry],
    ['missing expiry', token, undefined],
    ['expired lease', token, '2026-10-04T23:59:59.000Z'],
    ['short lease', token, '2026-10-05T00:00:20.000Z'],
    ['lease over 24 hours', token, '2026-10-06T01:00:01.000Z'],
    ['invalid token', 'contains spaces', expiry],
  ] as const)('fails closed for %s', async (_label, configuredToken, configuredExpiry) => {
    const resolver = registryFixtureBindingResolver(registryPolicy, configuredToken, configuredExpiry, fixtureSigningKey)!;
    expect(await resolver(REGISTRY_FIXTURE_BINDING_REF, context)).toBeNull();
  });

  it('reserves the test binding ref and fails startup on a broadened endpoint/tool policy', () => {
    expect(() => registryFixtureBindingResolver({ [REGISTRY_FIXTURE_SERVER_ID]: {
      ...registryPolicy[REGISTRY_FIXTURE_SERVER_ID], allowedTools: [REGISTRY_FIXTURE_TOOL, 'registry.fixture_write'],
    } }, token, expiry, fixtureSigningKey)).toThrow(/single read-only tool/);
    expect(() => registryFixtureBindingResolver({ [REGISTRY_FIXTURE_SERVER_ID]: {
      ...registryPolicy[REGISTRY_FIXTURE_SERVER_ID], registryDigest: '0'.repeat(64),
    } }, token, expiry, fixtureSigningKey)).toThrow(/single read-only tool/);
    expect(registryFixtureBindingResolver({}, token, expiry)).toBeUndefined();
  });

  it('attaches the signed run proof only to the isolated fixture invocation', async () => {
    const spec = makeRunSpec({
      profileId: REGISTRY_FIXTURE_PROFILE_ID,
      userTaskId: context.userTaskId,
      mcp: { servers: [cpDescriptorFixture] },
    });
    spec.runId = context.runId;
    const resolver = registryFixtureBindingResolver(registryPolicy, token, expiry, fixtureSigningKey)!;
    const attachment = await resolveRemoteMcpAttachment(spec, { servers: registryPolicy, resolveBinding: resolver }, now);
    const headers = attachment!.mcp.servers[REGISTRY_FIXTURE_SERVER_ID]!.headers;
    expect(headers['X-MCP-Operation']).toBe('invocation');
    const parts = headers['X-MCP-Run-Binding']!.split('.');
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    expect(payload).toMatchObject({ runId: context.runId, userTaskId: context.userTaskId, allowedTools: [REGISTRY_FIXTURE_TOOL] });
    expect(headers['X-MCP-Run-Id']).toBe(context.runId);
    expect(headers['X-MCP-Scope']).toBe(REGISTRY_FIXTURE_SCOPE);
    expect(attachment!.mcpSecrets[REGISTRY_FIXTURE_TOKEN_ENV]).toBe(token);
  });

  it.each([
    { label: 'scope', patch: { scope: 'registry:write' } },
    { label: 'Registry digest', patch: { registryDigest: '0'.repeat(64) } },
    { label: 'catalogue version', patch: { catalogueVersion: 'another-catalogue' } },
    { label: 'policy version', patch: { policyVersion: 'another-policy' } },
    { label: 'binding reference', patch: { bindingRef: 'another-binding' } },
    { label: 'tool allowlist', patch: { allowedTools: ['registry.fixture_write'] } },
  ])('refuses a drifted CP descriptor ($label) before calling the binding resolver', async ({ patch }) => {
    const descriptor = { ...cpDescriptorFixture, ...patch };
    const spec = makeRunSpec({ profileId: REGISTRY_FIXTURE_PROFILE_ID, mcp: { servers: [descriptor] } });
    const resolver = vi.fn(registryFixtureBindingResolver(registryPolicy, token, expiry, fixtureSigningKey)!);
    await expect(resolveRemoteMcpAttachment(spec, { servers: registryPolicy, resolveBinding: resolver }, now)).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('loads test credentials only from dedicated host env and fails closed when incomplete', async () => {
    const signingKey = fixtureSigningKey;
    const config = loadAgentApiConfig({
      AGENT_API_KEY_REGISTRY: '/private/keys.json',
      EXTERNAL_WORKER_URL: 'https://worker.example.test',
      AGENT_API_REMOTE_MCP_SERVERS: JSON.stringify(registryPolicy),
      [REGISTRY_FIXTURE_TOKEN_ENV]: token,
      [REGISTRY_FIXTURE_EXPIRY_ENV]: expiry,
      RUNNER_MCP_REGISTRY_TEST_SIGNING_KEY_B64: signingKey,
    });
    const binding = await config.remoteMcp!.resolveBinding(REGISTRY_FIXTURE_BINDING_REF, context);
    expect(binding?.runId).toBe(context.runId);
    expect(binding?.token).toBe(token);
    expect(JSON.stringify(config.env)).not.toContain(token);

    await expect(config.remoteMcp!.resolveBinding(REGISTRY_FIXTURE_BINDING_REF, { ...context, profileId: 'integration-v1' })).resolves.toBeNull();
    expect(() => loadAgentApiConfig({
      AGENT_API_KEY_REGISTRY: '/private/keys.json',
      EXTERNAL_WORKER_URL: 'https://worker.example.test',
      [REGISTRY_FIXTURE_TOKEN_ENV]: token,
    })).toThrow(`${REGISTRY_FIXTURE_TOKEN_ENV}, ${REGISTRY_FIXTURE_EXPIRY_ENV}, and RUNNER_MCP_REGISTRY_TEST_SIGNING_KEY_B64 must be configured together`);
  });
});

describe('trusted host attachment', () => {
  it('refuses budgets over 24 hours before resolving a credential', async () => {
    const { spec, host, resolveBinding } = setup();
    host.servers = { documents: { ...policies.documents, startupTimeoutMs: 86400000 } };
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_EXPIRED' });
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it.each([false, true])('checks native status then restores a nonterminal journaled run without launch; refused=%s', async refused => {
    const { spec } = documentsSetup();
    spec.engine.name = 'dynamic-ip-azure-agent-run';
    const admittedAt = new Date().toISOString();
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const restoreMcp = vi.fn(async () => {
      order.push('restore');
      await pending;
      if (refused) throw new Error('scope unavailable');
    });
    const status = vi.fn(async () => { order.push('poll'); return { runId: spec.runId, status: 'running' as const }; });
    const launch = vi.fn();
    const worker: ExternalWorker = { name: spec.engine.name, baseUrl: null, restoreMcp, status, launch, result: vi.fn(), cancel: vi.fn() };
    const restored = journaledRun(spec, admittedAt);
    const api = new AgentApi({ workers: [worker], store: restored });
    onTestFinished(() => api.dispose());
    expect(api.resumeDispatched()).toBe(1);
    expect(api.resumeDispatched()).toBe(0);
    await vi.waitFor(() => expect(restoreMcp).toHaveBeenCalledTimes(1));
    expect(status).toHaveBeenCalledTimes(1);
    expect(restoreMcp).toHaveBeenCalledWith(expect.objectContaining({ runId: spec.runId, userTaskId: spec.userTaskId, conversationId: spec.conversationId, ownerGeneration: spec.ownerGeneration, engine: spec.engine }), admittedAt);
    release?.();
    if (refused) {
      await vi.waitFor(() => expect(restored.progressOf(spec.runId)?.state).toBe('unknown'));
      expect(status).toHaveBeenCalledTimes(1);
    } else {
      await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
      expect(order.slice(0, 3)).toEqual(['poll', 'restore', 'poll']);
    }
    expect(launch).not.toHaveBeenCalled();
    await api.dispose();
  });

  it.each((['missing', 'expired'] as const).flatMap(bindingState => (['succeeded', 'failed', 'cancelled'] as const).map(terminalStatus => ({ bindingState, terminalStatus }))))('retrieves $terminalStatus native result with $bindingState binding; nonterminal stays fail closed', async ({ bindingState, terminalStatus }) => {
    const { spec, host, registrations } = documentsSetup();
    spec.engine.name = 'dynamic-ip-azure-agent-run';
    registrations[descriptor.bindingRef]!.engine = spec.engine.name;
    const readBinding = vi.fn(() => {
      if (bindingState === 'missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { runId: spec.runId, userTaskId: spec.userTaskId, profile: 'integration-v1', credentialProfile: 'sandbox-integrator-google', expiresAt: '2026-10-04T00:00:00.000Z', authToken: 'a'.repeat(43) };
    });
    const mintBinding = vi.fn();
    const createHttpHost = fakeStartup();
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding, mintBinding, createHttpHost });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/status')) return Response.json({ runId: spec.runId, status: terminalStatus });
      if (String(url).endsWith('/result')) return Response.json({ runId: spec.runId, status: 'started', pid: 4242, exitCode: terminalStatus === 'cancelled' ? null : terminalStatus === 'failed' ? 1 : 0, exitSignal: null, exitReason: terminalStatus === 'cancelled' ? 'cancelled' : terminalStatus === 'failed' ? 'nonzero_exit' : 'completed', stdout: 'fixture result', stderr: '', answer: 'fixture answer', answerSource: 'engine_stdout', durationMs: 1000, timedOut: false, outputTruncated: false, artifacts: [], logUrl: 'https://logs.example.test/run.log', repo: { fullName: 'owner/name', branch: `agent-run/${spec.runId}`, commit: 'abc1234' } });
      throw new Error('unexpected worker request');
    });
    const adapter = new ExternalWorkerAdapter({ baseUrl: 'https://worker.example.test', baseUrlForResult: 'https://api.example.test', remoteMcp: host, now: () => now, fetchImpl });
    const restore = vi.spyOn(adapter, 'restoreMcp');
    const launch = vi.spyOn(adapter, 'launch');
    const restored = journaledRun(spec, now.toISOString());
    const api = new AgentApi({ workers: [adapter], store: restored });
    onTestFinished(() => api.dispose());
    expect(api.resumeDispatched()).toBe(1);
    await vi.waitFor(() => expect(restored.progressOf(spec.runId)?.state).toBe(terminalStatus));
    expect(restored.progressOf(spec.runId)?.result).toMatchObject({ runId: spec.runId, userTaskId: spec.userTaskId, ownerGeneration: spec.ownerGeneration, exitReason: terminalStatus === 'cancelled' ? 'cancelled' : terminalStatus === 'failed' ? 'nonzero_exit' : 'completed' });
    expect(restored.progressOf(spec.runId)?.answer).toBe('fixture answer');
    expect(fetchImpl.mock.calls.map(([url]) => String(url).split('/').pop())).toEqual(['status', 'result']);
    expect(readBinding).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(api.resumeDispatched()).toBe(0);
    await api.dispose();

    const runningFetch = vi.fn(async () => Response.json({ runId: spec.runId, status: 'running' }));
    const runningAdapter = new ExternalWorkerAdapter({ baseUrl: 'https://worker.example.test', baseUrlForResult: 'https://api.example.test', remoteMcp: { ...host, resolveBinding: localDocumentsBindingResolver(registrations, { readBinding, mintBinding, createHttpHost }) }, now: () => now, fetchImpl: runningFetch });
    const runningLaunch = vi.spyOn(runningAdapter, 'launch');
    const runningStore = journaledRun(spec, now.toISOString());
    const runningApi = new AgentApi({ workers: [runningAdapter], store: runningStore });
    onTestFinished(() => runningApi.dispose());
    expect(runningApi.resumeDispatched()).toBe(1);
    await vi.waitFor(() => expect(runningStore.progressOf(spec.runId)?.state).toBe('unknown'));
    expect(runningFetch).toHaveBeenCalledTimes(1);
    expect(readBinding).toHaveBeenCalledTimes(1);
    expect(mintBinding).not.toHaveBeenCalled();
    expect(createHttpHost).not.toHaveBeenCalled();
    expect(runningLaunch).not.toHaveBeenCalled();
    await runningApi.dispose();
  });

  it.each(['conversationId', 'ownerGeneration', 'engine'] as const)('checks registered %s before reading or minting', async field => {
    const { spec, host, registrations } = documentsSetup();
    const registration = registrations[descriptor.bindingRef]!;
    if (field === 'ownerGeneration') registration.ownerGeneration += 1;
    else registration[field] = 'wrong-pin';
    const readBinding = vi.fn();
    const mintBinding = vi.fn();
    const createHttpHost = fakeStartup();
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding, mintBinding, createHttpHost });
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(readBinding).not.toHaveBeenCalled();
    expect(mintBinding).not.toHaveBeenCalled();
    expect(createHttpHost).not.toHaveBeenCalled();
  });

  it('includes trusted startup budget and preserves the original admission lease on restore', async () => {
    const { spec, host, registrations } = documentsSetup();
    spec.limits.timeoutMs = 300000;
    host.servers = { documents: { ...policies.documents, startupTimeoutMs: 600000 } };
    let native: unknown;
    const readBinding = vi.fn(() => {
      if (!native) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return native;
    });
    const mintBinding = vi.fn((request: Record<string, unknown>) => { native = { ...request, profile: request.expectedActorProfile, authToken: 'a'.repeat(43) }; });
    const createHttpHost = fakeStartup();
    const first = localDocumentsBindingResolver(registrations, { readBinding, mintBinding, createHttpHost });
    host.resolveBinding = first;
    await resolveRemoteMcpAttachment(spec, host, new Date(now.getTime() + 100000), undefined, 'launch', now.toISOString());
    expect(mintBinding).toHaveBeenCalledWith(expect.objectContaining({ runId: spec.runId, expiresAt: '2026-10-05T00:16:00.000Z' }));
    await first.dispose?.();
    const restored = localDocumentsBindingResolver(registrations, { readBinding, mintBinding, createHttpHost });
    host.resolveBinding = restored;
    const attachment = await resolveRemoteMcpAttachment(spec, host, new Date(now.getTime() + 700000), undefined, 'restore', now.toISOString());
    expect(attachment?.mcpSecrets.RUNNER_MCP_DOCS_TOKEN).toBe('a'.repeat(43));
    expect(mintBinding).toHaveBeenCalledTimes(1);
    expect(createHttpHost).toHaveBeenCalledTimes(2);
    await restored.dispose?.();
  });

  it('never mints a missing binding during replay', async () => {
    const { spec, host, registrations } = documentsSetup();
    const mintBinding = vi.fn();
    const createHttpHost = fakeStartup();
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, mintBinding, createHttpHost });
    const fetchImpl = vi.fn();
    const adapter = new ExternalWorkerAdapter({ baseUrl: 'https://worker.example.test', baseUrlForResult: 'https://api.example.test', remoteMcp: host, now: () => now, fetchImpl });
    await expect(adapter.restoreMcp(spec, now.toISOString())).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(mintBinding).not.toHaveBeenCalled();
    expect(createHttpHost).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  it.each(['2026-10-05T00:11:00.000Z', '2026-10-05T00:14:00.000Z'])('refuses expired or insufficient original lease before restoring host: %s', async expiresAt => {
    const { spec, host, registrations } = documentsSetup();
    spec.limits.timeoutMs = 300000;
    host.servers = { documents: { ...policies.documents, startupTimeoutMs: 600000 } };
    const mintBinding = vi.fn();
    const createHttpHost = fakeStartup();
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding: () => ({ runId: spec.runId, userTaskId: spec.userTaskId, profile: 'integration-v1', credentialProfile: 'sandbox-integrator-google', expiresAt, authToken: 'a'.repeat(43) }), mintBinding, createHttpHost });
    await expect(resolveRemoteMcpAttachment(spec, host, new Date(now.getTime() + 700000), undefined, 'restore', now.toISOString())).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(mintBinding).not.toHaveBeenCalled();
    expect(createHttpHost).not.toHaveBeenCalled();
  });

  it('invalidates an unready cached child without restarting it', async () => {
    const { spec, host, registrations } = documentsSetup();
    let ready = true;
    const close = vi.fn(async () => undefined);
    const createHttpHost = vi.fn(async () => ({ server: { listening: true }, isReady: () => ready, close }));
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding: () => ({ runId: spec.runId, userTaskId: spec.userTaskId, profile: 'integration-v1', credentialProfile: 'sandbox-integrator-google', expiresAt: '2026-10-05T01:00:00.000Z', authToken: 'a'.repeat(43) }), mintBinding: vi.fn(), createHttpHost });
    await resolveRemoteMcpAttachment(spec, host, now);
    ready = false;
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(createHttpHost).toHaveBeenCalledTimes(1);
  });

  it('refuses mint-only configuration without a registered startup hook', async () => {
    const { spec, host, registrations } = documentsSetup();
    const readBinding = vi.fn();
    const mintBinding = vi.fn();
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding, mintBinding });
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(readBinding).not.toHaveBeenCalled();
    expect(mintBinding).not.toHaveBeenCalled();
  });

  it('fails closed on startup failure and does not automatically restart the domain', async () => {
    const { spec, host, registrations } = documentsSetup();
    const native = { runId: spec.runId, userTaskId: spec.userTaskId, profile: 'integration-v1', credentialProfile: 'sandbox-integrator-google', expiresAt: '2026-10-05T01:00:00.000Z', authToken: 'a'.repeat(43) };
    const createHttpHost = vi.fn(async () => { throw new Error('DOMAIN_NOT_READY'); });
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding: () => native, mintBinding: vi.fn(), createHttpHost });
    const fetchImpl = vi.fn();
    const adapter = new ExternalWorkerAdapter({ baseUrl: 'https://worker.example.test', baseUrlForResult: 'https://api.example.test', remoteMcp: host, now: () => now, fetchImpl });
    await expect(adapter.launch(spec)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    await expect(adapter.launch(spec)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(createHttpHost).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    await adapter.dispose();
  });

  it('closes a late-starting domain after deadline and disposes it only once', async () => {
    const { spec, host, registrations } = documentsSetup();
    const native = { runId: spec.runId, userTaskId: spec.userTaskId, profile: 'integration-v1', credentialProfile: 'sandbox-integrator-google', expiresAt: '2026-10-05T01:00:00.000Z', authToken: 'a'.repeat(43) };
    const close = vi.fn(async () => undefined);
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding: () => native, mintBinding: vi.fn(), createHttpHost: async () => { await new Promise(resolve => setTimeout(resolve, 40)); return { server: { listening: true }, isReady: () => true, close }; } });
    const fetchImpl = vi.fn();
    const adapter = new ExternalWorkerAdapter({ baseUrl: 'https://worker.example.test', baseUrlForResult: 'https://api.example.test', deadlineMs: 10, remoteMcp: host, now: () => now, fetchImpl });
    await expect(adapter.launch(spec)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(close).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    await adapter.dispose();
    await adapter.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects bare UUIDs before native binding access or mint', async () => {
    const { spec, host, registrations } = documentsSetup();
    spec.runId = spec.runId.slice(4);
    const readBinding = vi.fn();
    const mintBinding = vi.fn();
    const createHttpHost = fakeStartup();
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding, mintBinding, createHttpHost });
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(readBinding).not.toHaveBeenCalled();
    expect(mintBinding).not.toHaveBeenCalled();
    expect(createHttpHost).not.toHaveBeenCalled();
  });

  it('uses host scope metadata without CP credential declarations', async () => {
    const { spec, host } = setup();
    delete spec.credentialBindings;
    expect(await resolveRemoteMcpAttachment(spec, host, now)).toBeDefined();
    host.resolveBinding = () => null;
    spec.credentialBindings = [{ ref: descriptor.bindingRef, scope: 'documents:approved', status: 'active' }];
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
  });

  it('refuses an undeclared host reference before invoking privileged resolution', async () => {
    const { spec, host, resolveBinding } = setup();
    spec.mcp!.servers[0] = { ...descriptor, bindingRef: 'unapproved-ref' };
    spec.credentialBindings = [{ ref: 'unapproved-ref', scope: 'documents:approved', status: 'active' }];
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_MISSING' });
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it('mints locally once for an explicitly registered actor/task and reuses exact scope', async () => {
    const { spec, host, registrations } = documentsSetup();
    let native: unknown;
    const readBinding = vi.fn(() => {
      if (!native) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return native;
    });
    const mintBinding = vi.fn(request => { native = { ...request, profile: request.expectedActorProfile, authToken: 'a'.repeat(43) }; });
    const createHttpHost = fakeStartup();
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding, mintBinding, createHttpHost });
    const first = await resolveRemoteMcpAttachment(spec, host, now);
    expect(await resolveRemoteMcpAttachment(spec, host, now)).toEqual(first);
    expect(mintBinding).toHaveBeenCalledTimes(1);
    expect(mintBinding).toHaveBeenCalledWith(expect.objectContaining({ runId: spec.runId, userTaskId: spec.userTaskId, expectedActorProfile: 'integration-v1', credentialProfile: 'sandbox-integrator-google' }));
    expect(first?.mcp.servers.documents?.headers).toMatchObject({ 'X-MCP-Profile': 'integration-v1', 'X-MCP-Run-Id': spec.runId });
    expect(createHttpHost).toHaveBeenCalledTimes(1);
    await host.resolveBinding.dispose?.();
    readBinding.mockClear();
    spec.profileId = 'other-actor';
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(readBinding).not.toHaveBeenCalled();
    expect(mintBinding).toHaveBeenCalledTimes(1);
  });

  it('does not mint invalid existing records or when opt-in is disabled', async () => {
    const { spec, host, registrations } = documentsSetup();
    const mintBinding = vi.fn();
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding: () => { throw new Error('unsafe'); }, mintBinding, createHttpHost: fakeStartup() });
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    registrations[descriptor.bindingRef]!.mintOnResolve = false;
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, mintBinding, createHttpHost: fakeStartup() });
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(mintBinding).not.toHaveBeenCalled();
  });

  it('verifies exclusive-create races rather than replacing another registration', async () => {
    const { spec, host, registrations } = documentsSetup();
    const readBinding = vi.fn().mockImplementationOnce(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }).mockReturnValue({ runId: 'another-run', userTaskId: spec.userTaskId, profile: 'integration-v1', credentialProfile: 'sandbox-integrator-google', expiresAt: new Date(Date.now() + 60000).toISOString(), authToken: 'a'.repeat(43) });
    const mintBinding = vi.fn(() => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); });
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding, mintBinding, createHttpHost: fakeStartup() });
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(mintBinding).toHaveBeenCalledTimes(1);
    expect(readBinding).toHaveBeenCalledTimes(2);
  });

  it('prevents late local mint after the bounded resolver deadline', async () => {
    const { spec, host, registrations } = documentsSetup();
    const mintBinding = vi.fn();
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding: async () => { await new Promise(resolve => setTimeout(resolve, 40)); throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, mintBinding, createHttpHost: fakeStartup() });
    const fetchImpl = vi.fn();
    const adapter = new ExternalWorkerAdapter({ baseUrl: 'https://worker.example.test', baseUrlForResult: 'https://api.example.test', deadlineMs: 10, remoteMcp: host, now: () => now, fetchImpl });
    await expect(adapter.launch(spec)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(mintBinding).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed for incomplete host module configuration without echoing private values', () => {
    expect(configuredDocumentsBindingResolver(undefined, undefined)).toBeUndefined();
    expect(() => configuredDocumentsBindingResolver('/private/missing/module.cjs', '{}')).toThrow('trusted local module');
  });

  it('renders wrapper-required scope headers only from generated context', async () => {
    const { spec, host } = setup();
    const attached = await resolveRemoteMcpAttachment(spec, host, now);
    expect(attached?.mcp.servers.documents?.headers).toEqual({ Authorization: 'Bearer {env:RUNNER_MCP_DOCS_TOKEN}', 'X-MCP-User-Task-Id': spec.userTaskId, 'X-MCP-Profile': spec.profileId, 'X-MCP-Run-Id': spec.runId });
    expect(attached?.mcpSecrets).toEqual({ RUNNER_MCP_DOCS_TOKEN: token });
  });

  it('reads the native registered wrapper binding without mint or SA access', async () => {
    const { spec, host } = setup();
    spec.profileId = 'integration-v1';
    spec.runId = 'run_01234567-89ab-cdef-0123-456789abcdef';
    const opaque = 'a'.repeat(43);
    const native = { runId: spec.runId, userTaskId: spec.userTaskId, profile: 'integration-v1', credentialProfile: 'sandbox-integrator-google', expiresAt: '2026-10-05T01:00:00.000Z', authToken: opaque };
    const readBinding = vi.fn(() => native);
    host.resolveBinding = registeredDocumentsBindingResolver({ [descriptor.bindingRef]: { runtime: '/private/documents-runtime', serverId: descriptor.serverId, url: descriptor.url, scope: 'documents:approved', allowedTools: descriptor.allowedTools, userTaskId: spec.userTaskId, expectedActorProfile: 'integration-v1', credentialProfile: 'sandbox-integrator-google', conversationId: spec.conversationId, ownerGeneration: spec.ownerGeneration, engine: spec.engine.name } }, readBinding);
    const first = await resolveRemoteMcpAttachment(spec, host, now);
    const repeat = await resolveRemoteMcpAttachment(spec, host, now);
    expect(first).toEqual(repeat);
    expect(first?.mcpSecrets.RUNNER_MCP_DOCS_TOKEN).toBe(opaque);
    expect(first?.mcp.servers.documents?.headers['X-MCP-Profile']).toBe('integration-v1');
    expect(readBinding).toHaveBeenCalledWith('/private/documents-runtime');
    expect(JSON.stringify(first)).not.toContain('/private/documents-runtime');
    spec.runId = spec.runId.slice(4);
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
  });

  it.each(['profile', 'credentialProfile', 'userTaskId', 'runId'] as const)('rejects native registered wrapper mismatched %s', async field => {
    const { spec, host } = setup();
    spec.profileId = 'integration-v1';
    spec.runId = 'run_01234567-89ab-cdef-0123-456789abcdef';
    const native = { runId: spec.runId, userTaskId: spec.userTaskId, profile: 'integration-v1', credentialProfile: 'sandbox-integrator-google', expiresAt: '2026-10-05T01:00:00.000Z', authToken: 'a'.repeat(43) };
    native[field] = 'other';
    host.resolveBinding = registeredDocumentsBindingResolver({ [descriptor.bindingRef]: { runtime: '/private/documents-runtime', serverId: descriptor.serverId, url: descriptor.url, scope: 'documents:approved', allowedTools: descriptor.allowedTools, userTaskId: spec.userTaskId, expectedActorProfile: 'integration-v1', credentialProfile: 'sandbox-integrator-google', conversationId: spec.conversationId, ownerGeneration: spec.ownerGeneration, engine: spec.engine.name } }, () => native);
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
  });

  it('rejects caller-looking static scope headers and scope-only auth configuration', () => {
    expect(() => parseRemoteMcpServerPolicies(JSON.stringify({ documents: { ...policies.documents, headers: { ...policies.documents.headers, 'X-MCP-Run-Id': 'fixed-run' } } }))).toThrow();
    expect(() => parseRemoteMcpServerPolicies(JSON.stringify({ documents: { ...policies.documents, headers: { 'X-MCP-Run-Id': '{scope:runId}' } } }))).toThrow();
  });

  it('preserves Submit descriptors into the generated scoped worker run', async () => {
    const worker = await startMockWorker();
    onTestFinished(() => worker.close());
    const resolved: string[] = [];
    const config = loadAgentApiConfig({ AGENT_API_KEY_REGISTRY: '/private/keys.json', EXTERNAL_WORKER_URL: worker.baseUrl, AGENT_API_PUBLIC_URL: 'https://api.example.test', AGENT_API_REMOTE_MCP_SERVERS: JSON.stringify(policies) });
    const workers = createExternalWorkers(config, () => undefined, async (_ref, context) => {
      resolved.push(context.runId);
      return { ...context, scope: 'documents:approved', expiresAt: new Date(Date.now() + 60000).toISOString(), token };
    });
    const api = new AgentApi({ workers, logger: () => undefined });
    onTestFinished(() => api.dispose());
    const principal: Principal = { principalId: 'p-test', profileId: 'profile-owner', scopes: ['runs:read', 'runs:write'], engines: ['dynamic-ip-azure-agent-run'] };
    const receipt = api.submit(principal, 'remote-mcp-test', { engine: { name: 'dynamic-ip-azure-agent-run', adapterVersion: '1' }, input: { inlinePrompt: 'read approved sheet' }, limits: { timeoutMs: 5000 }, userTaskId: 'owner-task', mcp: { servers: [descriptor] } });
    await vi.waitFor(() => expect(api.status(principal, receipt.runId).state).toBe('succeeded'));
    expect(resolved).toEqual([receipt.runId]);
    expect(receipt.runId).toMatch(/^run_[a-f0-9-]{36}$/);
    expect(api.capabilities().mcp.remoteTransport).toBe('worker_remote');
    expect(JSON.stringify(api.result(principal, receipt.runId))).not.toContain(token);
  });

  it('bounds a hung trusted resolver without contacting the worker', async () => {
    const { spec, host } = setup();
    host.resolveBinding = () => new Promise(() => undefined);
    const fetchImpl = vi.fn();
    const adapter = new ExternalWorkerAdapter({ baseUrl: 'https://worker.example.test', baseUrlForResult: 'https://api.example.test', deadlineMs: 20, remoteMcp: host, now: () => now, fetchImpl });
    await expect(adapter.launch(spec)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps named servers and separates opaque secrets from ordinary env', async () => {
    const { spec, host, resolveBinding } = setup();
    const attachment = await resolveRemoteMcpAttachment(spec, host, now);
    expect(attachment?.mcp.servers.documents).toMatchObject({ type: 'remote', url: descriptor.url, headers: policies.documents.headers, enabled: true });
    expect(attachment?.mcpSecrets).toEqual({ RUNNER_MCP_DOCS_TOKEN: token });
    expect(resolveBinding).toHaveBeenCalledWith(descriptor.bindingRef, expect.objectContaining({ runId: spec.runId, profileId: spec.profileId, userTaskId: spec.userTaskId, url: descriptor.url }));
    expect(JSON.stringify(attachment?.mcp)).not.toContain(token);
  });

  it.each(['runId', 'profileId', 'userTaskId', 'conversationId', 'engine', 'serverId', 'url', 'scope'] as const)('refuses mismatched %s', async field => {
    const { spec, host, binding } = setup();
    binding[field] = 'wrong';
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_SCOPE_MISMATCH' });
  });

  it.each(['missing', 'expired', 'tools', 'endpoint', 'generation'] as const)('fails closed for %s', async failure => {
    const { spec, host, binding } = setup();
    if (failure === 'missing') host.resolveBinding = () => null;
    if (failure === 'expired') binding.expiresAt = now.toISOString();
    if (failure === 'tools') binding.allowedTools = [];
    if (failure === 'endpoint') spec.mcp!.servers[0] = { ...descriptor, url: 'https://other.example.test/mcp' };
    if (failure === 'generation') binding.ownerGeneration += 1;
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ failureClass: 'preflight', retryable: false });
  });

  it('refuses literal credentials in host header templates', () => {
    expect(() => parseRemoteMcpServerPolicies(JSON.stringify({ documents: { ...policies.documents, headers: { Authorization: `Bearer ${token}` } } }))).toThrow('opaque-token header templates');
  });

  it('does not contact worker without a binding', async () => {
    const { spec, host } = setup();
    host.resolveBinding = () => null;
    const fetchImpl = vi.fn();
    const adapter = new ExternalWorkerAdapter({ baseUrl: 'https://worker.example.test', baseUrlForResult: 'https://api.example.test', remoteMcp: host, now: () => now, fetchImpl });
    await expect(adapter.launch(spec)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts opaque token echoes in transport errors', async () => {
    const { spec, host } = setup();
    const log = vi.fn();
    const fetchImpl = vi.fn(async () => { throw new Error(token); });
    const adapter = new ExternalWorkerAdapter({ baseUrl: 'https://worker.example.test', baseUrlForResult: 'https://api.example.test', remoteMcp: host, now: () => now, fetchImpl, log });
    await expect(adapter.launch(spec)).rejects.toMatchObject({ code: 'WORKER_LAUNCH_UNREACHABLE' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  });

  it('serializes existing worker protocol and redacts rejected token echoes', async () => {
    const { spec, host } = setup();
    const log = vi.fn();
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.mcp.servers.documents.headers.Authorization).toBe('Bearer {env:RUNNER_MCP_DOCS_TOKEN}');
      expect(request.mcpSecrets.RUNNER_MCP_DOCS_TOKEN).toBe(token);
      expect(request.env).toEqual({});
      expect(request).not.toHaveProperty('taskId');
      return new Response(token, { status: 400 });
    });
    const adapter = new ExternalWorkerAdapter({ baseUrl: 'https://worker.example.test', baseUrlForResult: 'https://api.example.test', remoteMcp: host, now: () => now, fetchImpl, log });
    await expect(adapter.launch(spec)).rejects.toMatchObject({ code: 'WORKER_HTTP_ERROR' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  });
});
