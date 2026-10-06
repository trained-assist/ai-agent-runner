import { readFile, stat } from 'node:fs/promises';
import { createPrivateKey, sign as signBytes, type KeyObject } from 'node:crypto';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
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
  runBinding?: string;
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
  catalogueVersion?: string;
  policyVersion?: string;
  registryDigest?: string;
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

export const REGISTRY_FIXTURE_SERVER_ID = 'trained-assist-registry-test';
export const REGISTRY_FIXTURE_BINDING_REF = 'registry-mcp-test-160-read';
export const REGISTRY_FIXTURE_URL = 'https://registry-test.trainedassist.store/mcp';
export const REGISTRY_FIXTURE_PROFILE_ID = 'integration-telegram-ux-v1';
export const REGISTRY_FIXTURE_TOOL = 'registry.fixture_read';
export const REGISTRY_FIXTURE_TOKEN_ENV = 'RUNNER_MCP_REGISTRY_TEST_TOKEN';
export const REGISTRY_FIXTURE_EXPIRY_ENV = 'RUNNER_MCP_REGISTRY_TEST_EXPIRES_AT';
export const REGISTRY_FIXTURE_SIGNING_KEY_ENV = 'RUNNER_MCP_REGISTRY_TEST_SIGNING_KEY_B64';
export const REGISTRY_FIXTURE_PRINCIPAL_ID = 'integration-telegram-ux-v1';
export const REGISTRY_FIXTURE_POLICY_VERSION = 'registry-fixture-policy-v1';
export const REGISTRY_FIXTURE_CATALOGUE_VERSION = 'registry-fixture-catalogue-v1';
export const REGISTRY_FIXTURE_REGISTRY_DIGEST = '129ab5033964c3ed5be47414711026cc2469b3d9af90ce83ee071cba7f005ea9';
export const REGISTRY_FIXTURE_SCOPE = 'registry:fixture-read';

function registryFixtureSigningKey(value: string | undefined): KeyObject | undefined {
  if (!value || !/^[A-Za-z0-9+/]+=*$/.test(value)) return undefined;
  try {
    const key = createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/**
 * Narrow test-only resolver for the #160 fixture registry. The opaque bearer and expiry
 * are supplied separately by the host secret store; callers can provide only the public
 * descriptor. Run/task/conversation identities come from the already validated Runner
 * context, so this resolver never fabricates a run ID or accepts caller scope headers.
 */
export function registryFixtureBindingResolver(
  servers: Readonly<Record<string, RemoteMcpServerPolicy>>,
  token: string | undefined,
  expiresAt: string | undefined,
  signingKeyValue?: string,
): RemoteMcpBindingResolver | undefined {
  const policy = servers[REGISTRY_FIXTURE_SERVER_ID];
  if (!policy) return undefined;
  if (policy.url !== REGISTRY_FIXTURE_URL || policy.tokenEnvName !== REGISTRY_FIXTURE_TOKEN_ENV ||
      policy.allowedTools.length !== 1 || policy.allowedTools[0] !== REGISTRY_FIXTURE_TOOL ||
      policy.policyVersion !== REGISTRY_FIXTURE_POLICY_VERSION || policy.catalogueVersion !== REGISTRY_FIXTURE_CATALOGUE_VERSION ||
      policy.registryDigest !== REGISTRY_FIXTURE_REGISTRY_DIGEST ||
      policy.bindingScopes[REGISTRY_FIXTURE_BINDING_REF] !== REGISTRY_FIXTURE_SCOPE ||
      !Object.hasOwn(policy.bindingScopes, REGISTRY_FIXTURE_BINDING_REF)) {
    throw new Error('registry fixture MCP policy must pin its test endpoint, binding and single read-only tool');
  }
  const signingKey = registryFixtureSigningKey(signingKeyValue);

  return async (bindingRef, context) => {
    if (bindingRef !== REGISTRY_FIXTURE_BINDING_REF || context.serverId !== REGISTRY_FIXTURE_SERVER_ID ||
        context.url !== REGISTRY_FIXTURE_URL || context.profileId !== REGISTRY_FIXTURE_PROFILE_ID ||
        context.catalogueVersion !== REGISTRY_FIXTURE_CATALOGUE_VERSION || context.policyVersion !== REGISTRY_FIXTURE_POLICY_VERSION ||
        context.registryDigest !== REGISTRY_FIXTURE_REGISTRY_DIGEST || context.scope !== REGISTRY_FIXTURE_SCOPE ||
        context.allowedTools.length !== 1 || context.allowedTools[0] !== REGISTRY_FIXTURE_TOOL || !signingKey ||
        context.signal?.aborted || !token || !expiresAt || !/^[A-Za-z0-9._~-]{16,2048}$/.test(token)) return null;

    const expiryMs = Date.parse(expiresAt);
    const checkedAtMs = Date.parse(context.checkedAt);
    const deadlineMs = Date.parse(context.admittedAt) + context.startupTimeoutMs + context.timeoutMs;
    if (!Number.isFinite(expiryMs) || !Number.isFinite(checkedAtMs) || !Number.isFinite(deadlineMs) ||
        expiryMs <= checkedAtMs || expiryMs < deadlineMs || expiryMs - checkedAtMs > 24 * 60 * 60 * 1000) return null;

    const issuedAt = Math.floor(checkedAtMs / 1000);
    const expires = Math.floor(expiryMs / 1000);
    const claims = {
      iss: 'trained-assist-agent-runner', aud: 'trained-assist:registry-mcp:test',
      sub: context.runId, runId: context.runId, userTaskId: context.userTaskId,
      profileId: REGISTRY_FIXTURE_PROFILE_ID, principalId: REGISTRY_FIXTURE_PRINCIPAL_ID,
      serverId: REGISTRY_FIXTURE_SERVER_ID, bindingRef: REGISTRY_FIXTURE_BINDING_REF,
      allowedTools: [REGISTRY_FIXTURE_TOOL], policyVersion: REGISTRY_FIXTURE_POLICY_VERSION,
      catalogueVersion: REGISTRY_FIXTURE_CATALOGUE_VERSION, registryDigest: REGISTRY_FIXTURE_REGISTRY_DIGEST,
      scope: REGISTRY_FIXTURE_SCOPE,
      iat: issuedAt, exp: expires,
    };
    const signingInput = `${base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
    const runBinding = `${signingInput}.${signBytes(null, Buffer.from(signingInput), signingKey).toString('base64url')}`;

    return {
      runId: context.runId,
      profileId: context.profileId,
      userTaskId: context.userTaskId,
      conversationId: context.conversationId,
      ownerGeneration: context.ownerGeneration,
      engine: context.engine,
      serverId: context.serverId,
      url: context.url,
      scope: policy.bindingScopes[REGISTRY_FIXTURE_BINDING_REF]!,
      allowedTools: [REGISTRY_FIXTURE_TOOL],
      expiresAt,
      token,
      runBinding,
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
          (policy.policyVersion !== undefined && (typeof policy.policyVersion !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(policy.policyVersion))) ||
          (policy.catalogueVersion !== undefined && (typeof policy.catalogueVersion !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(policy.catalogueVersion))) ||
          (policy.registryDigest !== undefined && (typeof policy.registryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(policy.registryDigest))) ||
          new Set(policy.allowedTools).size !== policy.allowedTools.length) throw new Error();
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
    const scope = Object.hasOwn(policy.bindingScopes, server.bindingRef) ? policy.bindingScopes[server.bindingRef] : undefined;
    if (!scope || signal?.aborted) refuse('MCP_BINDING_MISSING');
    if ((server.scope !== undefined && server.scope !== scope)
        || (server.policyVersion !== undefined && server.policyVersion !== policy.policyVersion)
        || (server.catalogueVersion !== undefined && server.catalogueVersion !== policy.catalogueVersion)
        || (server.registryDigest !== undefined && server.registryDigest !== policy.registryDigest)) refuse('MCP_BINDING_SCOPE_MISMATCH');
    if (spec.profileId === REGISTRY_FIXTURE_PROFILE_ID && (server.serverId !== REGISTRY_FIXTURE_SERVER_ID
        || server.bindingRef !== REGISTRY_FIXTURE_BINDING_REF || scope !== REGISTRY_FIXTURE_SCOPE
        || server.scope !== REGISTRY_FIXTURE_SCOPE || server.policyVersion !== REGISTRY_FIXTURE_POLICY_VERSION
        || server.catalogueVersion !== REGISTRY_FIXTURE_CATALOGUE_VERSION
        || server.registryDigest !== REGISTRY_FIXTURE_REGISTRY_DIGEST
        || server.allowedTools.length !== 1 || server.allowedTools[0] !== REGISTRY_FIXTURE_TOOL)) refuse('MCP_POLICY_DRIFT');
    const declared = spec.credentialBindings?.find(binding => binding.ref === server.bindingRef);
    if (declared && declared.scope !== scope) refuse('MCP_BINDING_SCOPE_MISMATCH');
    const context: RemoteMcpBindingContext = {
      mode, admittedAt, checkedAt: now.toISOString(), startupTimeoutMs: policy.startupTimeoutMs,
      timeoutMs: spec.limits.timeoutMs, signal, scope,
      runId: spec.runId, profileId: spec.profileId, userTaskId: spec.userTaskId,
      conversationId: spec.conversationId, ownerGeneration: spec.ownerGeneration,
      operationId: spec.operationId, engine: spec.engine.name,
      serverId: server.serverId, url: policy.url, allowedTools: [...server.allowedTools],
      catalogueVersion: server.catalogueVersion, policyVersion: server.policyVersion, registryDigest: server.registryDigest,
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
    if (binding.runBinding) {
      headers['X-MCP-Scope'] = scope;
      headers['X-MCP-Operation'] = 'invocation';
      headers['X-MCP-Run-Binding'] = binding.runBinding;
    }
    if (Object.values(headers).some(value => /[\r\n]/.test(value))) refuse('MCP_BINDING_SCOPE_MISMATCH');
    attachment.mcp.servers[server.serverId] = { type: 'remote', url: policy.url, headers, enabled: true };
    attachment.mcpSecrets[policy.tokenEnvName] = binding.token;
  }
  return attachment;
}
