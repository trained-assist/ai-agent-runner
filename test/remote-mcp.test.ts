import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { ExternalWorkerAdapter } from '../src/adapters/external-worker-adapter.js';
import { parseRemoteMcpServerPolicies, resolveRemoteMcpAttachment, type RemoteMcpBinding, type RemoteMcpHostOptions } from '../src/adapters/remote-mcp.js';
import { validateSubmitRequest } from '../src/api/contracts.js';
import { validateRunSpec } from '../src/contracts/run-spec.js';
import { makeRunSpec } from './helpers.js';
import { AgentApi } from '../src/api/service.js';
import type { Principal } from '../src/api/auth.js';
import { createExternalWorkers, loadAgentApiConfig } from '../src/api/config.js';
import { startMockWorker } from './external-worker-harness.js';

const now = new Date('2026-10-05T00:00:00.000Z');
const descriptor = { serverId: 'documents', transport: 'remote' as const, url: 'https://mcp.example.test/mcp', bindingRef: 'docs-binding', allowedTools: ['read_sheet'], toolTimeoutMs: 1000 };
const policies = { documents: { url: descriptor.url, tokenEnvName: 'RUNNER_MCP_DOCS_TOKEN', headers: { Authorization: 'Bearer {env:RUNNER_MCP_DOCS_TOKEN}' }, allowedTools: ['read_sheet', 'write_sheet'] } };
const token = 'opaque_fixture_token_123456';

function setup() {
  const spec = makeRunSpec({ input: { inlinePrompt: 'read approved sheet' }, mcp: { servers: [descriptor] }, credentialBindings: [{ ref: descriptor.bindingRef, scope: 'documents:approved', status: 'active' }] });
  const binding: RemoteMcpBinding = { runId: spec.runId, profileId: spec.profileId, userTaskId: spec.userTaskId, conversationId: spec.conversationId, ownerGeneration: spec.ownerGeneration, engine: spec.engine.name, serverId: descriptor.serverId, url: descriptor.url, scope: 'documents:approved', allowedTools: ['read_sheet'], expiresAt: '2026-10-05T01:00:00.000Z', token };
  const resolveBinding = vi.fn(async () => binding);
  const host: RemoteMcpHostOptions = { servers: policies, resolveBinding };
  return { spec, binding, host, resolveBinding };
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
    const receipt = api.submit(principal, 'remote-mcp-test', { engine: { name: 'dynamic-ip-azure-agent-run', adapterVersion: '1' }, input: { inlinePrompt: 'read approved sheet' }, limits: { timeoutMs: 5000 }, userTaskId: 'owner-task', mcp: { servers: [descriptor] }, credentialBindings: [{ ref: descriptor.bindingRef, scope: 'documents:approved' }] });
    await vi.waitFor(() => expect(api.status(principal, receipt.runId).state).toBe('succeeded'));
    expect(resolved).toEqual([receipt.runId]);
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
    expect(attachment?.mcp.servers.documents).toEqual({ type: 'remote', url: descriptor.url, headers: policies.documents.headers, enabled: true });
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
