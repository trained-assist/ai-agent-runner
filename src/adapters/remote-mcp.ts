import { readFile, stat } from 'node:fs/promises';
import { isRemoteMcpUrl, MCP_TOOL_NAME, type McpRemoteServerSpec, type RunSpec } from '../contracts/run-spec.js';
import { PreflightError, isRecord } from '../contracts/validate.js';

export interface RemoteMcpServerPolicy {
  url: string;
  tokenEnvName: string;
  headers: Record<string, string>;
  allowedTools: string[];
}

export interface RemoteMcpBinding {
  runId: string;
  profileId: string;
  userTaskId: string;
  conversationId: string;
  ownerGeneration: number;
  engine: string;
  serverId: string;
  url: string;
  scope: string;
  allowedTools: string[];
  expiresAt: string;
  token: string;
}

export interface RemoteMcpBindingContext {
  runId: string;
  profileId: string;
  userTaskId: string;
  conversationId: string;
  ownerGeneration: number;
  operationId: string;
  engine: string;
  serverId: string;
  url: string;
  allowedTools: string[];
}

export type RemoteMcpBindingResolver = (
  bindingRef: string,
  context: Readonly<RemoteMcpBindingContext>,
) => RemoteMcpBinding | null | Promise<RemoteMcpBinding | null>;

export interface RemoteMcpAttachment {
  mcp: { servers: Record<string, { type: 'remote'; url: string; headers: Record<string, string>; enabled: true }> };
  mcpSecrets: Record<string, string>;
}

export interface RemoteMcpHostOptions {
  servers: Readonly<Record<string, RemoteMcpServerPolicy>>;
  resolveBinding: RemoteMcpBindingResolver;
}

function refuse(code: string): never {
  throw new PreflightError(code, 'remote MCP attachment refused by trusted host policy', { failureClass: 'preflight', retryable: false });
}

export function parseRemoteMcpServerPolicies(raw: string | undefined): Record<string, RemoteMcpServerPolicy> {
  if (!raw?.trim()) return {};
  try {
    const input: unknown = JSON.parse(raw);
    if (!isRecord(input) || Object.keys(input).length > 8) throw new Error();
    const servers: Record<string, RemoteMcpServerPolicy> = Object.create(null);
    const tokenNames = new Set<string>();
    for (const [serverId, policy] of Object.entries(input)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(serverId) || !isRecord(policy) ||
          Object.keys(policy).some(key => !['url', 'tokenEnvName', 'headers', 'allowedTools'].includes(key)) ||
          !isRemoteMcpUrl(policy.url) || typeof policy.tokenEnvName !== 'string' ||
          !/^RUNNER_MCP_[A-Z0-9_]{1,48}$/.test(policy.tokenEnvName) || tokenNames.has(policy.tokenEnvName) ||
          !isRecord(policy.headers) || !Array.isArray(policy.allowedTools) ||
          policy.allowedTools.length === 0 || policy.allowedTools.length > 50 ||
          !policy.allowedTools.every(tool => typeof tool === 'string' && MCP_TOOL_NAME.test(tool)) ||
          new Set(policy.allowedTools).size !== policy.allowedTools.length) throw new Error();
      const headers: Record<string, string> = Object.create(null);
      const entries = Object.entries(policy.headers);
      if (entries.length === 0 || entries.length > 8) throw new Error();
      for (const [name, template] of entries) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(name) ||
            (template !== `{env:${policy.tokenEnvName}}` && template !== `Bearer {env:${policy.tokenEnvName}}`)) throw new Error();
        headers[name] = template;
      }
      tokenNames.add(policy.tokenEnvName);
      servers[serverId] = { url: policy.url, tokenEnvName: policy.tokenEnvName, headers, allowedTools: [...policy.allowedTools] };
    }
    return servers;
  } catch {
    throw new Error('AGENT_API_REMOTE_MCP_SERVERS: expected approved HTTPS endpoints, opaque-token header templates and tool allowlists');
  }
}

export function bindingFileResolver(file: string | undefined): RemoteMcpBindingResolver {
  return async bindingRef => {
    if (!file) return null;
    try {
      const metadata = await stat(file);
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) return null;
      const bindings: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!isRecord(bindings) || !Object.hasOwn(bindings, bindingRef)) return null;
      return bindings[bindingRef] as RemoteMcpBinding;
    } catch {
      return null;
    }
  };
}

export async function resolveRemoteMcpAttachment(
  spec: RunSpec,
  host: RemoteMcpHostOptions | undefined,
  now: Date,
): Promise<RemoteMcpAttachment | undefined> {
  const servers = spec.mcp?.servers ?? [];
  if (servers.length === 0) return undefined;
  if (servers.some(server => server.transport !== 'remote')) refuse('MCP_TRANSPORT_UNSUPPORTED');
  if (!host) refuse('MCP_HOST_POLICY_MISSING');
  let policies: Record<string, RemoteMcpServerPolicy>;
  try {
    policies = parseRemoteMcpServerPolicies(JSON.stringify(host.servers));
  } catch {
    refuse('MCP_HOST_POLICY_INVALID');
  }
  const attachment: RemoteMcpAttachment = { mcp: { servers: Object.create(null) }, mcpSecrets: Object.create(null) };
  for (const server of servers as McpRemoteServerSpec[]) {
    const policy = Object.hasOwn(policies, server.serverId) ? policies[server.serverId] : undefined;
    if (!policy || policy.url !== server.url) refuse('MCP_ENDPOINT_NOT_ALLOWED');
    if (!server.allowedTools.every(tool => policy.allowedTools.includes(tool))) refuse('MCP_TOOL_NOT_ALLOWED');
    const declared = spec.credentialBindings?.find(binding => binding.ref === server.bindingRef);
    if (!declared || declared.status === 'missing' || declared.status === 'expired' ||
        (declared.expiresAt !== undefined && !(Date.parse(declared.expiresAt) > now.getTime()))) refuse('MCP_BINDING_MISSING');
    const context: RemoteMcpBindingContext = {
      runId: spec.runId, profileId: spec.profileId, userTaskId: spec.userTaskId,
      conversationId: spec.conversationId, ownerGeneration: spec.ownerGeneration,
      operationId: spec.operationId, engine: spec.engine.name,
      serverId: server.serverId, url: policy.url, allowedTools: [...server.allowedTools],
    };
    let binding: RemoteMcpBinding | null;
    try {
      binding = await host.resolveBinding(server.bindingRef, Object.freeze(context));
    } catch {
      refuse('MCP_BINDING_UNAVAILABLE');
    }
    if (!binding || typeof binding !== 'object') refuse('MCP_BINDING_UNAVAILABLE');
    for (const key of ['runId', 'profileId', 'userTaskId', 'conversationId', 'ownerGeneration', 'engine', 'serverId', 'url'] as const) {
      if (binding[key] !== context[key]) refuse('MCP_BINDING_SCOPE_MISMATCH');
    }
    if (binding.scope !== declared.scope || !Array.isArray(binding.allowedTools) ||
        !server.allowedTools.every(tool => binding.allowedTools.includes(tool))) refuse('MCP_BINDING_SCOPE_MISMATCH');
    if (!(Date.parse(binding.expiresAt) >= now.getTime() + spec.limits.timeoutMs)) refuse('MCP_BINDING_EXPIRED');
    if (typeof binding.token !== 'string' || !/^[A-Za-z0-9._~-]{16,2048}$/.test(binding.token)) refuse('MCP_BINDING_INVALID');
    if (Object.hasOwn(attachment.mcpSecrets, policy.tokenEnvName)) refuse('MCP_TOKEN_NAME_CONFLICT');
    attachment.mcp.servers[server.serverId] = { type: 'remote', url: policy.url, headers: { ...policy.headers }, enabled: true };
    attachment.mcpSecrets[policy.tokenEnvName] = binding.token;
  }
  return attachment;
}
