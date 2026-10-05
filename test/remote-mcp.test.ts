import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { ExternalWorkerAdapter } from '../src/adapters/external-worker-adapter.js';
import { configuredDocumentsBindingResolver, localDocumentsBindingResolver, parseRemoteMcpServerPolicies, registeredDocumentsBindingResolver, resolveRemoteMcpAttachment, type DocumentsHttpRegistration, type RemoteMcpBinding, type RemoteMcpHostOptions } from '../src/adapters/remote-mcp.js';
import { validateSubmitRequest } from '../src/api/contracts.js';
import { validateRunSpec } from '../src/contracts/run-spec.js';
import { makeRunSpec } from './helpers.js';
import { AgentApi } from '../src/api/service.js';
import type { Principal } from '../src/api/auth.js';
import { createExternalWorkers, loadAgentApiConfig } from '../src/api/config.js';
import { startMockWorker } from './external-worker-harness.js';

const now = new Date('2026-10-05T00:00:00.000Z');
const descriptor = { serverId: 'documents', transport: 'remote' as const, url: 'https://mcp.example.test/mcp', bindingRef: 'docs-binding', allowedTools: ['read_sheet'], toolTimeoutMs: 1000 };
const policies = { documents: { url: descriptor.url, tokenEnvName: 'RUNNER_MCP_DOCS_TOKEN', headers: { Authorization: 'Bearer {env:RUNNER_MCP_DOCS_TOKEN}' }, allowedTools: ['read_sheet', 'write_sheet'], bindingScopes: { 'docs-binding': 'documents:approved' } } };
const token = 'opaque_fixture_token_123456';

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
  spec.runId = '01234567-89ab-cdef-0123-456789abcdef';
  host.servers = { documents: { ...policies.documents, transportProfileId: 'sandbox-integrator-google' } };
  const registration: DocumentsHttpRegistration = { runtime: '/private/documents-runtime', serverId: descriptor.serverId, url: descriptor.url, scope: 'documents:approved', allowedTools: descriptor.allowedTools, userTaskId: spec.userTaskId, actorProfileId: 'integration-v1', transportProfileId: 'sandbox-integrator-google', mintOnResolve: true };
  return { spec, host, registrations: { [descriptor.bindingRef]: registration } };
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

describe('trusted host attachment', () => {
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
    const mintBinding = vi.fn(request => { native = { ...request, authToken: 'a'.repeat(43) }; });
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding, mintBinding });
    const first = await resolveRemoteMcpAttachment(spec, host, now);
    expect(await resolveRemoteMcpAttachment(spec, host, now)).toEqual(first);
    expect(mintBinding).toHaveBeenCalledTimes(1);
    expect(mintBinding).toHaveBeenCalledWith(expect.objectContaining({ runId: spec.runId, userTaskId: spec.userTaskId, profile: 'sandbox-integrator-google' }));
    expect(first?.mcp.servers.documents?.headers).toMatchObject({ 'X-MCP-Profile': 'sandbox-integrator-google', 'X-MCP-Run-Id': spec.runId });
    readBinding.mockClear();
    spec.profileId = 'other-actor';
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(readBinding).not.toHaveBeenCalled();
    expect(mintBinding).toHaveBeenCalledTimes(1);
  });

  it('does not mint invalid existing records or when opt-in is disabled', async () => {
    const { spec, host, registrations } = documentsSetup();
    const mintBinding = vi.fn();
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding: () => { throw new Error('unsafe'); }, mintBinding });
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    registrations[descriptor.bindingRef]!.mintOnResolve = false;
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, mintBinding });
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(mintBinding).not.toHaveBeenCalled();
  });

  it('verifies exclusive-create races rather than replacing another registration', async () => {
    const { spec, host, registrations } = documentsSetup();
    const readBinding = vi.fn().mockImplementationOnce(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }).mockReturnValue({ runId: 'another-run', userTaskId: spec.userTaskId, profile: 'sandbox-integrator-google', expiresAt: new Date(Date.now() + 60000).toISOString(), authToken: 'a'.repeat(43) });
    const mintBinding = vi.fn(() => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); });
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding, mintBinding });
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
    expect(mintBinding).toHaveBeenCalledTimes(1);
    expect(readBinding).toHaveBeenCalledTimes(2);
  });

  it('prevents late local mint after the bounded resolver deadline', async () => {
    const { spec, host, registrations } = documentsSetup();
    const mintBinding = vi.fn();
    host.resolveBinding = localDocumentsBindingResolver(registrations, { readBinding: async () => { await new Promise(resolve => setTimeout(resolve, 40)); throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, mintBinding });
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
    host.servers = { documents: { ...policies.documents, transportProfileId: 'sandbox-integrator-google' } };
    spec.runId = 'run_01234567-89ab-cdef-0123-456789abcdef';
    const opaque = 'a'.repeat(43);
    const native = { runId: spec.runId, userTaskId: spec.userTaskId, profile: 'sandbox-integrator-google', expiresAt: '2026-10-05T01:00:00.000Z', authToken: opaque };
    const readBinding = vi.fn(() => native);
    host.resolveBinding = registeredDocumentsBindingResolver({ [descriptor.bindingRef]: { runtime: '/private/documents-runtime', serverId: descriptor.serverId, url: descriptor.url, scope: 'documents:approved', allowedTools: descriptor.allowedTools, userTaskId: spec.userTaskId, actorProfileId: 'integration-v1', transportProfileId: 'sandbox-integrator-google' } }, readBinding);
    const first = await resolveRemoteMcpAttachment(spec, host, now);
    const repeat = await resolveRemoteMcpAttachment(spec, host, now);
    expect(first).toEqual(repeat);
    expect(first?.mcpSecrets.RUNNER_MCP_DOCS_TOKEN).toBe(opaque);
    expect(first?.mcp.servers.documents?.headers['X-MCP-Profile']).toBe('sandbox-integrator-google');
    expect(readBinding).toHaveBeenCalledWith('/private/documents-runtime');
    expect(JSON.stringify(first)).not.toContain('/private/documents-runtime');
    spec.runId = spec.runId.slice(4);
    await expect(resolveRemoteMcpAttachment(spec, host, now)).rejects.toMatchObject({ code: 'MCP_BINDING_UNAVAILABLE' });
  });

  it.each(['profile', 'userTaskId', 'runId'] as const)('rejects native registered wrapper mismatched %s', async field => {
    const { spec, host } = setup();
    spec.profileId = 'integration-v1';
    host.servers = { documents: { ...policies.documents, transportProfileId: 'sandbox-integrator-google' } };
    const native = { runId: spec.runId, userTaskId: spec.userTaskId, profile: 'sandbox-integrator-google', expiresAt: '2026-10-05T01:00:00.000Z', authToken: 'a'.repeat(43) };
    native[field] = 'other';
    host.resolveBinding = registeredDocumentsBindingResolver({ [descriptor.bindingRef]: { runtime: '/private/documents-runtime', serverId: descriptor.serverId, url: descriptor.url, scope: 'documents:approved', allowedTools: descriptor.allowedTools, userTaskId: spec.userTaskId, actorProfileId: 'integration-v1', transportProfileId: 'sandbox-integrator-google' } }, () => native);
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
    expect(receipt.runId).toMatch(/^[a-f0-9-]{36}$/);
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
