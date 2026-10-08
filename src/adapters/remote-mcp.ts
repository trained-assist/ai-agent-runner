import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { isRemoteMcpUrl, MCP_TOOL_NAME, type McpRemoteServerSpec, type RunSpec } from '../contracts/run-spec.js';
import { PreflightError, isRecord } from '../contracts/validate.js';

export interface RemoteMcpServerPolicy {
  url: string;
  tokenEnvName: string;
  headers: Record<string, string>;
  allowedTools: string[];
  bindingScopes: Record<string, string>;
  startupTimeoutMs: number;
  policyVersion?: string;
  catalogueVersion?: string;
  /** Optional test-only pin, compared with the separately trusted test resolver config. */
  registryDigest?: string;
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
  runnerProof?: string;
}

export interface RemoteMcpBindingContext {
  mode: 'launch' | 'restore';
  admittedAt: string;
  checkedAt: string;
  startupTimeoutMs: number;
  scope: string;
  timeoutMs: number;
  signal?: AbortSignal;
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
  policyVersion?: string;
  catalogueVersion?: string;
}

export type RemoteMcpBindingResolver = (
  bindingRef: string,
  context: Readonly<RemoteMcpBindingContext>,
) => RemoteMcpBinding | null | Promise<RemoteMcpBinding | null>;

export type ManagedRemoteMcpBindingResolver = RemoteMcpBindingResolver & { dispose?: () => Promise<void> };

export interface RemoteMcpAttachment {
  mcp: { servers: Record<string, { type: 'remote'; url: string; headers: Record<string, string>; enabled: true }> };
  mcpSecrets: Record<string, string>;
}

export interface RemoteMcpHostOptions {
  servers: Readonly<Record<string, RemoteMcpServerPolicy>>;
  resolveBinding: ManagedRemoteMcpBindingResolver;
}

export interface TestRegistryBindingConfig {
  token: string;
  privateKeyPem?: string;
  privateKeyPkcs8DerBase64?: string;
  registryDigest: string;
  catalogueVersion: string;
}

const TEST_PROFILE = 'integration-telegram-ux-v1';
const TEST_SERVER = 'trained-assist-registry-test';
const TEST_REF = 'registry-mcp-test-160-read';
const TEST_TOOL = 'registry.fixture_read';
const TEST_POLICY = 'registry-fixture-policy-v1';
const TEST_URL = 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp';

/** Trusted process-only binding for the pinned Telegram UX integration profile. */
export function configuredTestRegistryBindingResolver(config: TestRegistryBindingConfig | undefined): RemoteMcpBindingResolver | undefined {
  if (!config) return undefined;
  if (!/^[A-Za-z0-9._~-]{16,2048}$/.test(config.token) || config.registryDigest !== '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9' ||
      (Boolean(config.privateKeyPem) === Boolean(config.privateKeyPkcs8DerBase64)) ||
      !/^[A-Za-z0-9._-]{1,200}$/.test(config.catalogueVersion)) throw new Error('test registry MCP binding configuration is invalid');
  let key;
  try {
    key = config.privateKeyPem
      ? createPrivateKey(config.privateKeyPem)
      : createPrivateKey({ key: Buffer.from(config.privateKeyPkcs8DerBase64!, 'base64'), format: 'der', type: 'pkcs8' });
  } catch { throw new Error('test registry MCP signing key is invalid'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('test registry MCP signing key must be Ed25519');
  return (bindingRef, context) => {
    if (bindingRef !== TEST_REF || context.profileId !== TEST_PROFILE || context.serverId !== TEST_SERVER || context.url !== TEST_URL ||
        context.allowedTools.length !== 1 || context.allowedTools[0] !== TEST_TOOL) return null;
    if (context.policyVersion !== TEST_POLICY || context.catalogueVersion !== config.catalogueVersion || context.scope !== 'registry:fixture-read') return null;
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({
      iss: 'trained-assist-agent-runner', aud: 'trained-assist:registry-mcp:test', sub: context.runId,
      runId: context.runId, userTaskId: context.userTaskId, profileId: TEST_PROFILE, principalId: TEST_PROFILE,
      serverId: TEST_SERVER, bindingRef: TEST_REF, allowedTools: [TEST_TOOL], policyVersion: TEST_POLICY,
      catalogueVersion: config.catalogueVersion, registryDigest: config.registryDigest, iat: now,
      exp: now + Math.max(60, Math.ceil((context.startupTimeoutMs + context.timeoutMs) / 1000) + 60),
    })).toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const runnerProof = `${unsigned}.${cryptoSign(null, Buffer.from(unsigned), key).toString('base64url')}`;
    return {
      runId: context.runId, profileId: context.profileId, userTaskId: context.userTaskId,
      conversationId: context.conversationId, ownerGeneration: context.ownerGeneration, engine: context.engine,
      serverId: context.serverId, url: context.url, scope: context.scope, allowedTools: [TEST_TOOL],
      expiresAt: new Date((now + Math.max(60, Math.ceil((context.startupTimeoutMs + context.timeoutMs) / 1000) + 60)) * 1000).toISOString(),
      token: config.token, runnerProof,
    };
  };
}

export interface DocumentsHttpRegistration {
  runtime: string;
  serverId: string;
  url: string;
  scope: string;
  allowedTools: string[];
  userTaskId: string;
  expectedActorProfile: 'integration-v1';
  conversationId: string;
  ownerGeneration: number;
  engine: string;
  credentialProfile: 'sandbox-integrator-google';
  mintOnResolve?: boolean;
  startOnResolve?: boolean;
  port?: number;
}

export interface DocumentsHttpStartedHost {
  server: { listening: boolean };
  isReady: () => boolean;
  close: () => Promise<void>;
}

export interface DocumentsHttpHost {
  readBinding: (runtime: string) => unknown | Promise<unknown>;
  mintBinding: (request: { runtime: string; userTaskId: string; expectedActorProfile: string; credentialProfile: string; runId: string; expiresAt: string }) => unknown | Promise<unknown>;
  createHttpHost?: (request: { runtime: string; port: number }) => Promise<DocumentsHttpStartedHost>;
}

export function localDocumentsBindingResolver(
  registrations: Readonly<Record<string, DocumentsHttpRegistration>>,
  host: DocumentsHttpHost,
): ManagedRemoteMcpBindingResolver {
  const resolveRegistered = registeredDocumentsBindingResolver(registrations, async runtime => host.readBinding(runtime), async (registered, context) => {
    if (context.mode === 'restore' || !registered.mintOnResolve || context.signal?.aborted ||
        !/^run_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(context.runId) ||
        context.startupTimeoutMs + context.timeoutMs + 60000 > 86400000) return;
    await host.mintBinding({ runtime: registered.runtime, userTaskId: context.userTaskId,
      expectedActorProfile: registered.expectedActorProfile, credentialProfile: registered.credentialProfile, runId: context.runId,
      expiresAt: new Date(Date.parse(context.admittedAt) + context.startupTimeoutMs + context.timeoutMs + 60000).toISOString() });
  });
  const started = new Map<string, { runId: string; userTaskId: string; promise: Promise<DocumentsHttpStartedHost>; closing?: Promise<void> }>();
  let disposed = false;
  let closing: Promise<void> | undefined;
  const resolver: ManagedRemoteMcpBindingResolver = async (ref, context) => {
    const registration = Object.hasOwn(registrations, ref) ? registrations[ref] : undefined;
    if (disposed || !registration?.startOnResolve || !host.createHttpHost ||
        !Number.isInteger(registration.port) || registration.port! < 1 || registration.port! > 65535 || context.signal?.aborted) return null;
    const binding = await resolveRegistered(ref, context);
    if (!binding || disposed || context.signal?.aborted) return null;
    let instance = started.get(registration.runtime);
    if (instance && (instance.closing || instance.runId !== context.runId || instance.userTaskId !== context.userTaskId)) return null;
    if (!instance) {
      instance = { runId: context.runId, userTaskId: context.userTaskId,
        promise: host.createHttpHost({ runtime: registration.runtime, port: registration.port! }) };
      started.set(registration.runtime, instance);
    }
    const current = instance;
    const promise = instance.promise;
    const abort = (): void => {
      current.closing ??= promise.then(running => running.close());
      void current.closing.catch(() => undefined);
    };
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();
    try {
      const running = await promise;
      if (disposed || context.signal?.aborted || !running.server.listening || typeof running.isReady !== 'function' || !running.isReady()) {
        abort();
        await current.closing;
        return null;
      }
      return binding;
    } finally {
      context.signal?.removeEventListener('abort', abort);
    }
  };
  resolver.dispose = () => {
    disposed = true;
    closing ??= Promise.all([...started.values()].map(async instance => {
      let running: DocumentsHttpStartedHost;
      try { running = await instance.promise; } catch { return; }
      instance.closing ??= running.close();
      await instance.closing;
    })).then(() => undefined);
    return closing;
  };
  return resolver;
}

export function configuredDocumentsBindingResolver(modulePath: string | undefined, raw: string | undefined): ManagedRemoteMcpBindingResolver | undefined {
  if (!modulePath && !raw) return undefined;
  try {
    if (!modulePath || !isAbsolute(modulePath) || !raw) throw new Error();
    const registrations: unknown = JSON.parse(raw);
    if (!isRecord(registrations) || Object.keys(registrations).length === 0 || Object.keys(registrations).length > 8) throw new Error();
    for (const [ref, registration] of Object.entries(registrations)) {
      if (!ref || ref.length > 300 || !isRecord(registration) ||
          Object.keys(registration).some(key => !['runtime', 'serverId', 'url', 'scope', 'allowedTools', 'userTaskId', 'expectedActorProfile', 'credentialProfile', 'conversationId', 'ownerGeneration', 'engine', 'mintOnResolve', 'startOnResolve', 'port'].includes(key)) ||
          typeof registration.runtime !== 'string' || !isAbsolute(registration.runtime) ||
          typeof registration.serverId !== 'string' || !isRemoteMcpUrl(registration.url) ||
          typeof registration.scope !== 'string' || !registration.scope ||
          registration.expectedActorProfile !== 'integration-v1' || registration.credentialProfile !== 'sandbox-integrator-google' ||
          typeof registration.conversationId !== 'string' || !registration.conversationId ||
          !Number.isSafeInteger(registration.ownerGeneration) || Number(registration.ownerGeneration) < 1 ||
          typeof registration.engine !== 'string' || !registration.engine ||
          typeof registration.userTaskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(registration.userTaskId) ||
          !Array.isArray(registration.allowedTools) || !registration.allowedTools.length ||
          !registration.allowedTools.every(tool => ['gdrive_create_spreadsheet', 'gdrive_read_sheet', 'gdrive_write_sheet'].includes(tool)) ||
          (registration.mintOnResolve !== undefined && typeof registration.mintOnResolve !== 'boolean') ||
          (registration.startOnResolve !== undefined && typeof registration.startOnResolve !== 'boolean') ||
          (registration.port !== undefined && (typeof registration.port !== 'number' || !Number.isInteger(registration.port) || registration.port < 1 || registration.port > 65535))) throw new Error();
    }
    const host: unknown = createRequire(import.meta.url)(modulePath);
    if (!isRecord(host) || typeof host.readBinding !== 'function' || typeof host.mintBinding !== 'function' || typeof host.createHttpHost !== 'function') throw new Error();
    return localDocumentsBindingResolver(registrations as unknown as Record<string, DocumentsHttpRegistration>, host as unknown as DocumentsHttpHost);
  } catch {
    throw new Error('documents MCP host configuration requires a trusted local module and pinned private registrations');
  }
}

export function registeredDocumentsBindingResolver(
  registrations: Readonly<Record<string, DocumentsHttpRegistration>>,
  readBinding: (runtime: string) => unknown | Promise<unknown>,
  mintMissing?: (registered: DocumentsHttpRegistration, context: Readonly<RemoteMcpBindingContext>) => Promise<void>,
): RemoteMcpBindingResolver {
  return async (bindingRef, context) => {
    const registered = Object.hasOwn(registrations, bindingRef) ? registrations[bindingRef] : undefined;
    if (!registered || registered.serverId !== context.serverId || registered.url !== context.url || registered.scope !== context.scope ||
        registered.expectedActorProfile !== 'integration-v1' || registered.credentialProfile !== 'sandbox-integrator-google' ||
        context.profileId !== registered.expectedActorProfile || context.userTaskId !== registered.userTaskId || context.signal?.aborted ||
        context.conversationId !== registered.conversationId || context.ownerGeneration !== registered.ownerGeneration || context.engine !== registered.engine ||
        !/^run_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(context.runId) ||
        !context.allowedTools.every(tool => registered.allowedTools.includes(tool))) return null;
    let native: unknown;
    try {
      native = await readBinding(registered.runtime);
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT' || !mintMissing || context.mode === 'restore' || context.signal?.aborted) throw error;
      try {
        await mintMissing(registered, context);
      } catch (mintError) {
        if (!isRecord(mintError) || mintError.code !== 'EEXIST') throw mintError;
      }
      if (context.signal?.aborted) return null;
      native = await readBinding(registered.runtime);
    }
    if (!isRecord(native) || native.runId !== context.runId || native.userTaskId !== context.userTaskId ||
        native.profile !== registered.expectedActorProfile || native.credentialProfile !== registered.credentialProfile || typeof native.expiresAt !== 'string' ||
        typeof native.authToken !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(native.authToken)) return null;
    const expiry = Date.parse(native.expiresAt);
    const deadline = Date.parse(context.admittedAt) + context.startupTimeoutMs + context.timeoutMs;
    if (!Number.isFinite(deadline) || !Number.isFinite(expiry) || expiry <= Date.parse(context.checkedAt) || expiry < deadline) return null;
    return {
      runId: context.runId, profileId: context.profileId, userTaskId: context.userTaskId,
      conversationId: context.conversationId, ownerGeneration: context.ownerGeneration,
      engine: context.engine, serverId: context.serverId, url: context.url,
      scope: registered.scope, allowedTools: [...registered.allowedTools],
      expiresAt: native.expiresAt, token: native.authToken,
    };
  };
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
          Object.keys(policy).some(key => !['url', 'tokenEnvName', 'headers', 'allowedTools', 'bindingScopes', 'startupTimeoutMs', 'policyVersion', 'catalogueVersion', 'registryDigest'].includes(key)) ||
          !isRemoteMcpUrl(policy.url) || typeof policy.tokenEnvName !== 'string' ||
          !/^RUNNER_MCP_[A-Z0-9_]{1,48}$/.test(policy.tokenEnvName) || tokenNames.has(policy.tokenEnvName) ||
          !isRecord(policy.headers) || !isRecord(policy.bindingScopes) || Object.keys(policy.bindingScopes).length === 0 ||
          !Number.isSafeInteger(policy.startupTimeoutMs) || Number(policy.startupTimeoutMs) < 0 || Number(policy.startupTimeoutMs) > 86400000 ||
          !Object.entries(policy.bindingScopes).every(([ref, scope]) => ref.length > 0 && ref.length <= 300 && typeof scope === 'string' && scope.length > 0 && scope.length <= 300) || !Array.isArray(policy.allowedTools) ||
          policy.allowedTools.length === 0 || policy.allowedTools.length > 50 ||
          !policy.allowedTools.every(tool => typeof tool === 'string' && MCP_TOOL_NAME.test(tool)) ||
          new Set(policy.allowedTools).size !== policy.allowedTools.length ||
          (policy.policyVersion !== undefined && (typeof policy.policyVersion !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(policy.policyVersion))) ||
          (policy.catalogueVersion !== undefined && (typeof policy.catalogueVersion !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(policy.catalogueVersion))) ||
          (policy.registryDigest !== undefined && (typeof policy.registryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(policy.registryDigest)))) throw new Error();
      const headers: Record<string, string> = Object.create(null);
      const entries = Object.entries(policy.headers);
      if (entries.length === 0 || entries.length > 8 || new Set(entries.map(([name]) => name.toLowerCase())).size !== entries.length ||
          !entries.some(([, template]) => template === `{env:${policy.tokenEnvName}}` || template === `Bearer {env:${policy.tokenEnvName}}`)) throw new Error();
      for (const [name, template] of entries) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || name.toLowerCase().startsWith('x-mcp-') || typeof template !== 'string' ||
            (template !== `{env:${policy.tokenEnvName}}` && template !== `Bearer {env:${policy.tokenEnvName}}`)) throw new Error();
        headers[name] = template;
      }
      tokenNames.add(policy.tokenEnvName);
      servers[serverId] = { url: policy.url, tokenEnvName: policy.tokenEnvName, headers, allowedTools: [...policy.allowedTools], bindingScopes: { ...policy.bindingScopes } as Record<string, string>, startupTimeoutMs: Number(policy.startupTimeoutMs), ...(typeof policy.policyVersion === 'string' ? { policyVersion: policy.policyVersion } : {}), ...(typeof policy.catalogueVersion === 'string' ? { catalogueVersion: policy.catalogueVersion } : {}), ...(typeof policy.registryDigest === 'string' ? { registryDigest: policy.registryDigest } : {}) };
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
  signal?: AbortSignal,
  mode: 'launch' | 'restore' = 'launch',
  admittedAt = now.toISOString(),
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
    if (policy.startupTimeoutMs + spec.limits.timeoutMs + 60000 > 86400000 || !Number.isFinite(Date.parse(admittedAt))) refuse('MCP_BINDING_EXPIRED');
    if (!server.allowedTools.every(tool => policy.allowedTools.includes(tool))) refuse('MCP_TOOL_NOT_ALLOWED');
    const isTestProfile = spec.profileId === TEST_PROFILE;
    if (isTestProfile && (server.serverId !== TEST_SERVER || server.bindingRef !== TEST_REF || server.allowedTools.length !== 1 ||
        server.allowedTools[0] !== TEST_TOOL || server.policyVersion !== TEST_POLICY || !server.catalogueVersion ||
        policy.policyVersion !== TEST_POLICY || policy.catalogueVersion !== server.catalogueVersion ||
        !host.resolveBinding)) refuse('MCP_BINDING_SCOPE_MISMATCH');
    const scope = Object.hasOwn(policy.bindingScopes, server.bindingRef) ? policy.bindingScopes[server.bindingRef] : undefined;
    if (!scope || signal?.aborted) refuse('MCP_BINDING_MISSING');
    const declared = spec.credentialBindings?.find(binding => binding.ref === server.bindingRef);
    if (declared && declared.scope !== scope) refuse('MCP_BINDING_SCOPE_MISMATCH');
    const context: RemoteMcpBindingContext = {
      mode, admittedAt, checkedAt: now.toISOString(), startupTimeoutMs: policy.startupTimeoutMs,
      timeoutMs: spec.limits.timeoutMs, signal, scope,
      runId: spec.runId, profileId: spec.profileId, userTaskId: spec.userTaskId,
      conversationId: spec.conversationId, ownerGeneration: spec.ownerGeneration,
      operationId: spec.operationId, engine: spec.engine.name,
      serverId: server.serverId, url: policy.url, allowedTools: [...server.allowedTools],
      ...(server.policyVersion ? { policyVersion: server.policyVersion } : {}),
      ...(server.catalogueVersion ? { catalogueVersion: server.catalogueVersion } : {}),
    };
    let binding: RemoteMcpBinding | null;
    try {
      binding = await host.resolveBinding(server.bindingRef, Object.freeze(context));
    } catch {
      refuse('MCP_BINDING_UNAVAILABLE');
    }
    if (!binding || typeof binding !== 'object') refuse('MCP_BINDING_UNAVAILABLE');
    if (isTestProfile && (!binding.runnerProof || server.catalogueVersion === undefined)) refuse('MCP_BINDING_UNAVAILABLE');
    for (const key of ['runId', 'profileId', 'userTaskId', 'conversationId', 'ownerGeneration', 'engine', 'serverId', 'url'] as const) {
      if (binding[key] !== context[key]) refuse('MCP_BINDING_SCOPE_MISMATCH');
    }
    if (signal?.aborted || binding.scope !== scope || !Array.isArray(binding.allowedTools) ||
        !server.allowedTools.every(tool => binding.allowedTools.includes(tool))) refuse('MCP_BINDING_SCOPE_MISMATCH');
    const originalDeadline = Date.parse(admittedAt) + policy.startupTimeoutMs + spec.limits.timeoutMs;
    if (!Number.isFinite(originalDeadline) || !(Date.parse(binding.expiresAt) > now.getTime()) ||
        !(Date.parse(binding.expiresAt) >= originalDeadline)) refuse('MCP_BINDING_EXPIRED');
    if (typeof binding.token !== 'string' || !/^[A-Za-z0-9._~-]{16,2048}$/.test(binding.token)) refuse('MCP_BINDING_INVALID');
    if (Object.hasOwn(attachment.mcpSecrets, policy.tokenEnvName)) refuse('MCP_TOKEN_NAME_CONFLICT');
    const headers: Record<string, string> = Object.create(null);
    for (const [name, template] of Object.entries(policy.headers)) {
      headers[name] = template;
    }
    headers['X-MCP-User-Task-Id'] = context.userTaskId;
    headers['X-MCP-Profile'] = context.profileId;
    headers['X-MCP-Run-Id'] = context.runId;
    if (isTestProfile) headers['X-MCP-Run-Binding'] = binding.runnerProof!;
    if (Object.values(headers).some(value => /[\r\n]/.test(value))) refuse('MCP_BINDING_SCOPE_MISMATCH');
    attachment.mcp.servers[server.serverId] = { type: 'remote', url: policy.url, headers, enabled: true };
    attachment.mcpSecrets[policy.tokenEnvName] = binding.token;
  }
  return attachment;
}
