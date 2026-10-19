import type { ApiPrincipal, RunnerWorkerEnv } from './types.js';
import { developerCapabilities, developerRequest, developerWebhooks } from './developer-api.js';
import { WalletClient, WalletError } from './wallet-client.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_ENGINE = 'eu-vm-agent-run';

function fallbackExecutionRegions(env: RunnerWorkerEnv): string[] {
  if ((env.GHA_WORKER_TOKEN?.trim().length ?? 0) < 24) return [];
  try {
    const url = new URL(env.GHA_WORKER_URL?.trim() ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.pathname !== '/' || url.search) return [];
    return ['azure-cloud'];
  } catch { return []; }
}

interface KeyConfig extends ApiPrincipal { keyHash: string }

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function error(code: string, message: string, status: number, details?: unknown): Response {
  return json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function authenticate(request: Request, env: RunnerWorkerEnv): Promise<ApiPrincipal | null> {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  if (!match?.[1]) return null;
  if (match[1].length > 500) return null;
  let configured: KeyConfig[];
  if (env.DEPLOYMENT_ENV === 'production') {
    try {
      const raw: unknown = JSON.parse(env.RUNNER_API_KEYS_PRODUCTION ?? 'null');
      if (!Array.isArray(raw) || raw.some((item) => !validKeyConfig(item))) throw new Error('invalid key records');
      configured = raw as KeyConfig[];
    } catch { throw new Error('RUNNER_API_KEYS_PRODUCTION must be a valid JSON array of key hash records'); }
  } else {
    try {
      const raw: unknown = JSON.parse(env.RUNNER_API_KEYS);
      if (!Array.isArray(raw) || raw.some((item) => !validKeyConfig(item))) throw new Error('invalid key records');
      configured = raw as KeyConfig[];
    } catch { throw new Error('RUNNER_API_KEYS must be a valid JSON array of key hash records'); }
    if (env.RUNNER_API_KEYS_ADDITIONAL !== undefined) {
      try {
        const raw: unknown = JSON.parse(env.RUNNER_API_KEYS_ADDITIONAL);
        if (!Array.isArray(raw) || raw.some((item) => !validKeyConfig(item))) throw new Error('invalid key records');
        configured = [...configured, ...(raw as KeyConfig[])];
      } catch { throw new Error('RUNNER_API_KEYS_ADDITIONAL must be a valid JSON array of key hash records'); }
    }
    if (env.RUNNER_API_KEYS_SANDBOX3 !== undefined) {
      try {
        const raw: unknown = JSON.parse(env.RUNNER_API_KEYS_SANDBOX3);
        if (!Array.isArray(raw) || raw.some((item) => !validKeyConfig(item))) throw new Error('invalid key records');
        configured = [...configured, ...(raw as KeyConfig[])];
      } catch { throw new Error('RUNNER_API_KEYS_SANDBOX3 must be a valid JSON array of key hash records'); }
    }
    if (env.RUNNER_API_KEYS_DEVELOPER !== undefined) {
      try {
        const raw: unknown = JSON.parse(env.RUNNER_API_KEYS_DEVELOPER);
        if (!Array.isArray(raw) || raw.some((item) => !validKeyConfig(item) || !item.developerApi)) throw new Error('invalid developer key records');
        configured = [...configured, ...(raw as KeyConfig[])];
      } catch { throw new Error('RUNNER_API_KEYS_DEVELOPER must be a valid JSON array of developer key hash records'); }
    }
    // The credential registry is additive and independent: it holds only the
    // principals allowed to open a credential form, so provisioning it never
    // rewrites the base, sandbox3, developer or additional registries.
    if (env.RUNNER_API_KEYS_CREDENTIALS !== undefined) {
      try {
        const raw: unknown = JSON.parse(env.RUNNER_API_KEYS_CREDENTIALS);
        if (!Array.isArray(raw) || raw.some((item) => !validKeyConfig(item))) throw new Error('invalid credential key records');
        configured = [...configured, ...(raw as KeyConfig[])];
      } catch { throw new Error('RUNNER_API_KEYS_CREDENTIALS must be a valid JSON array of key hash records'); }
    }
  }
  const digest = await sha256(match[1]);
  const record = configured.find((entry) => entry.keyHash === digest);
  return record ? { principalId: record.principalId, profileId: record.profileId,
    ...(record.repository ? { repository: record.repository } : {}),
    ...(record.tenantId ? { tenantId: record.tenantId } : {}), scopes: record.scopes,
    ...(record.engines ? { engines: record.engines } : {}), ...(record.mcpBindings ? { mcpBindings: record.mcpBindings } : {}),
    ...(record.developerApi ? { developerApi: true } : {}),
    ...(record.developerGuest ? { developerGuest: true } : {}), keyHash: record.keyHash } : null;
}

async function delegatedPrincipal(request: Request, principal: ApiPrincipal, env: RunnerWorkerEnv): Promise<ApiPrincipal> {
  const profileId = request.headers.get('x-agent-profile-id')?.trim() ?? '';
  const tenantId = request.headers.get('x-agent-profile-tenant')?.trim() ?? '';
  const expiresAt = request.headers.get('x-agent-profile-exp')?.trim() ?? '';
  const signature = request.headers.get('x-agent-profile-sig')?.trim() ?? '';
  if (!profileId && !tenantId && !expiresAt && !signature) return principal;
  const now = Date.now();
  if (!env.AGENT_API_PROFILE_DELEGATION_SECRET?.trim() || !principal.tenantId
    || !profileId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(profileId)
    || !tenantId || tenantId !== principal.tenantId
    || !/^\d{13}$/.test(expiresAt) || Number(expiresAt) < now || Number(expiresAt) > now + 5 * 60_000
    || !/^[0-9a-f]{64}$/.test(signature)) {
    throw new Error('invalid_or_expired_host_profile_capability');
  }
  const message = `${principal.principalId}\0${tenantId}\0${profileId}\0${expiresAt}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AGENT_API_PROFILE_DELEGATION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signatureBytes = Uint8Array.from(signature.match(/../g)!, (byte) => Number.parseInt(byte, 16));
  const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, new TextEncoder().encode(message));
  if (!valid) throw new Error('invalid_or_expired_host_profile_capability');
  return { ...principal, profileId };
}

function validKeyConfig(value: unknown): value is KeyConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const repository = record['repository'];
  const engines = record['engines'];
  const validRepository = typeof repository === 'string'
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/.test(repository);
  const mockOnly = Array.isArray(engines) && engines.length > 0 && engines.every((engine) => engine === 'mock-test');
  const pinnedMcpOnly = record['principalId'] === 'integration-telegram-ux-v1'
    && record['profileId'] === 'integration-telegram-ux-v1'
    && Array.isArray(record['mcpBindings']) && record['mcpBindings'].length === 1
    && record['mcpBindings'][0] === 'registry-mcp-test-160-read';
  return typeof record['keyHash'] === 'string' && /^[0-9a-f]{64}$/.test(record['keyHash'])
    && typeof record['principalId'] === 'string' && !!record['principalId']
    && typeof record['profileId'] === 'string' && !!record['profileId']
    && (record['tenantId'] === undefined || typeof record['tenantId'] === 'string' && !!record['tenantId'])
    && Array.isArray(record['scopes']) && record['scopes'].length > 0 && record['scopes'].every((scope) => ['runs:read', 'runs:write', 'credentials:read', 'credentials:write'].includes(String(scope)))
    && (engines === undefined || Array.isArray(engines) && engines.every((engine) => typeof engine === 'string'))
    && (validRepository || mockOnly || pinnedMcpOnly)
    && (record['mcpBindings'] === undefined || Array.isArray(record['mcpBindings']) && record['mcpBindings'].every((binding) => typeof binding === 'string' && binding.length > 0 && binding.length <= 300))
    && (record['developerApi'] === undefined || record['developerApi'] === true)
    && (record['developerGuest'] === undefined || record['developerGuest'] === true && record['developerApi'] === true);
}

function requireScope(principal: ApiPrincipal, scope: string): boolean { return principal.scopes.includes(scope); }

const WALLET_CONNECTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Credential intake is a separate capability from run admission: a key that may
 * start runs is not automatically allowed to create credential forms, and a key
 * that may create credential forms is not automatically allowed to read them.
 */
function walletResolutionError(reason: 'not_configured' | 'invalid_config' | 'profile_unmapped'): Response {
  if (reason === 'profile_unmapped') return error('CREDENTIALS_FORBIDDEN', 'credential intake is not enabled for this profile', 403);
  return error('CREDENTIALS_UNAVAILABLE', 'credential intake is not configured on this Runner API', 503);
}

function walletFailure(failure: unknown): Response {
  const code = failure instanceof WalletError ? failure.code : 'unknown';
  console.error('[credential-intake] request failed', code);
  if (failure instanceof WalletError) {
    if (failure.code === 'invalid_request') return error('INVALID_CREDENTIAL_REQUEST', failure.message, 400);
    if (failure.code === 'not_found') return error('CREDENTIAL_NOT_FOUND', failure.message, 404);
    if (failure.code === 'conflict') return error('CREDENTIAL_CONFLICT', failure.message, 409);
    if (failure.code === 'rejected') return error('CREDENTIALS_REJECTED', failure.message, 502);
  }
  return error('CREDENTIALS_UNAVAILABLE', 'credential intake is not available', 503);
}

export default {
  async fetch(request: Request, env: RunnerWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return json({ status: 'ok', service: 'ai-agent-runner-api', placement: 'cloudflare-worker', executionWorker: 'eu-vm-agent-run' });
    if (url.pathname === '/version' && request.method === 'GET') return json({ service: 'ai-agent-runner-api', runtime: 'cloudflare-worker', contractVersion: 1, buildSha: env.BUILD_SHA ?? null });
    const guestDownload = /^\/v1\/developer\/downloads\/(run_[0-9a-f]{64}_[0-9a-f]{24})$/.exec(url.pathname);
    if (guestDownload) {
      if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'downloads support GET only', 405);
      if (env.DEPLOYMENT_ENV === 'production' || env.RUNNER_DEVELOPER_API_ENABLED !== 'true') return error('DEVELOPER_API_UNAVAILABLE', 'developer API is disabled on this lane', 503);
      const object = env.RUNNER_RUNS.get(env.RUNNER_RUNS.idFromName(`task-${guestDownload[1]!.split('_')[1]}`));
      return object.fetch(new Request(`https://runner-runs.internal/v1/runs/${guestDownload[1]}/download${url.search}`));
    }
    let authenticated: ApiPrincipal | null;
    try { authenticated = await authenticate(request, env); } catch { return error('SERVER_MISCONFIGURED', 'Runner API authentication is not configured', 503); }
    if (!authenticated) return error('UNAUTHENTICATED', 'a valid Bearer API key is required', 401);
    let principal: ApiPrincipal;
    try { principal = await delegatedPrincipal(request, authenticated, env); }
    catch { return error('FORBIDDEN', 'invalid or expired host profile capability', 403); }
    if (url.pathname === '/v1/developer/capabilities') {
      if (env.DEPLOYMENT_ENV === 'production' || env.RUNNER_DEVELOPER_API_ENABLED !== 'true') return error('DEVELOPER_API_UNAVAILABLE', 'developer API is disabled on this lane', 503);
      if (!principal.developerApi) return error('FORBIDDEN', 'developer API is not enabled for this key', 403);
      if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'capabilities supports GET only', 405);
      if (!requireScope(principal, 'runs:read')) return error('FORBIDDEN', 'runs:read scope is required', 403);
      return developerCapabilities(env, principal);
    }
    if (url.pathname === '/v1/developer/webhooks') {
      if (env.DEPLOYMENT_ENV === 'production' || env.RUNNER_DEVELOPER_API_ENABLED !== 'true') return error('DEVELOPER_API_UNAVAILABLE', 'developer API is disabled on this lane', 503);
      if (!principal.developerApi) return error('FORBIDDEN', 'developer API is not enabled for this key', 403);
      if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 'webhooks supports GET only', 405);
      if (!requireScope(principal, 'runs:read')) return error('FORBIDDEN', 'runs:read scope is required', 403);
      return developerWebhooks(env, principal);
    }
    if (url.pathname === '/v1/developer/runs' || url.pathname.startsWith('/v1/developer/runs/')) {
      if (env.DEPLOYMENT_ENV === 'production' || env.RUNNER_DEVELOPER_API_ENABLED !== 'true') return error('DEVELOPER_API_UNAVAILABLE', 'developer API is disabled on this lane', 503);
      if (!principal.developerApi) return error('FORBIDDEN', 'developer API is not enabled for this key', 403);
      return developerRequest(request, env, principal);
    }
    if (url.pathname === '/v1/capabilities' && request.method === 'GET') {
      if (!requireScope(principal, 'runs:read')) return error('FORBIDDEN', 'API key does not have the required scope', 403);
      const ghaConfigured = fallbackExecutionRegions(env).includes('azure-cloud');
      return json({ schemaVersion: 1, contract: { name: 'ai-agent-runner/serverless-agent-api', version: 1 }, placement: 'cloudflare-worker',
        events: { transports: ['json', 'sse'], replayable: true, cursor: 'sequence', retainedPerRun: 128, heartbeatSeconds: 15 },
        executionRegions: [DEFAULT_ENGINE], fallbackExecutionRegions: ghaConfigured ? ['azure-cloud'] : [], routes: { auto: { primary: DEFAULT_ENGINE, fallback: ghaConfigured ? 'azure-cloud' : null }, france: { available: true, fallback: false }, gha: { available: ghaConfigured, engine: ghaConfigured ? 'azure-cloud' : null } } });
    }
    if (url.pathname === '/v1/sandbox/cleanup-task') {
      if (request.method !== 'POST') return error('METHOD_NOT_ALLOWED', 'method not allowed', 405);
      const allowedProfiles = (env.SANDBOX_CLEANUP_PROFILES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      if (!allowedProfiles.includes(principal.profileId)) return error('FORBIDDEN', 'sandbox cleanup is not enabled for this profile', 403);
      if (!requireScope(principal, 'runs:write')) return error('FORBIDDEN', 'API key does not have the required scope', 403);
      let submitted: { userTaskId?: unknown };
      try { submitted = await request.clone().json() as { userTaskId?: unknown }; } catch { return error('INVALID_REQUEST', 'request body must be JSON', 400); }
      if (typeof submitted.userTaskId !== 'string' || !SAFE_ID.test(submitted.userTaskId)) return error('INVALID_REQUEST', 'userTaskId is required and must be a safe id', 400);
      const objectName = `task-${await sha256(`${principal.principalId}\0${principal.profileId}\0${submitted.userTaskId}`)}`;
      const object = env.RUNNER_RUNS.get(env.RUNNER_RUNS.idFromName(objectName));
      const headers = new Headers({ 'x-runner-principal': JSON.stringify(principal), 'content-type': 'application/json' });
      return object.fetch(new Request('https://runner-runs.internal/v1/sandbox/cleanup-task', { method: 'POST', headers, body: JSON.stringify({ userTaskId: submitted.userTaskId }) }));
    }
    if (url.pathname === '/v1/runs/cancel-by-idempotency-key') {
      if (request.method !== 'POST') return error('METHOD_NOT_ALLOWED', 'method not allowed', 405);
      if (!requireScope(principal, 'runs:write')) return error('FORBIDDEN', 'API key does not have the required scope', 403);
      let submitted: { userTaskId?: unknown };
      try { submitted = await request.clone().json() as { userTaskId?: unknown }; } catch { return error('INVALID_REQUEST', 'request body must be JSON', 400); }
      if (typeof submitted.userTaskId !== 'string' || !SAFE_ID.test(submitted.userTaskId)) return error('INVALID_REQUEST', 'userTaskId is required and must be a safe id', 400);
      const objectName = `task-${await sha256(`${principal.principalId}\0${principal.profileId}\0${submitted.userTaskId}`)}`;
      const object = env.RUNNER_RUNS.get(env.RUNNER_RUNS.idFromName(objectName));
      const forwarded = new Request('https://runner-runs.internal/v1/runs/cancel-by-idempotency-key', request);
      const headers = new Headers(forwarded.headers);
      headers.set('x-runner-principal', JSON.stringify(principal));
      return object.fetch(new Request(forwarded, { headers }));
    }
    const path = url.pathname.split('/').filter(Boolean);
    if (path[0] === 'v1' && path[1] === 'credentials') {
      if (path.length === 2 && request.method === 'POST') {
        if (!requireScope(principal, 'credentials:write')) return error('FORBIDDEN', 'API key does not have the required scope', 403);
        let submitted: Record<string, unknown>;
        try { submitted = await request.clone().json() as Record<string, unknown>; } catch { return error('INVALID_REQUEST', 'request body must be JSON', 400); }
        if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) return error('INVALID_REQUEST', 'request body must be an object', 400);
        const allowedFields = new Set(['provider', 'kind', 'title', 'description', 'ttl_minutes']);
        const unknownFields = Object.keys(submitted).filter((name) => !allowedFields.has(name));
        if (unknownFields.length) return error('INVALID_REQUEST', 'request contains unsupported fields', 400, { errors: unknownFields.map((name) => `request.${name}: unknown field`) });
        const provider = typeof submitted['provider'] === 'string' ? submitted['provider'].trim() : '';
        if (!provider) return error('INVALID_REQUEST', 'provider is required', 400);
        const kind = submitted['kind'] === undefined ? undefined : typeof submitted['kind'] === 'string' ? submitted['kind'] : null;
        const title = submitted['title'] === undefined ? undefined : typeof submitted['title'] === 'string' ? submitted['title'] : null;
        const description = submitted['description'] === undefined ? undefined : typeof submitted['description'] === 'string' ? submitted['description'] : null;
        const ttlMinutes = submitted['ttl_minutes'] === undefined ? undefined : typeof submitted['ttl_minutes'] === 'number' ? submitted['ttl_minutes'] : null;
        if (kind === null || title === null || description === null || ttlMinutes === null) return error('INVALID_REQUEST', 'kind, title, description and ttl_minutes must have their documented types', 400);
        if (kind !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(kind)) return error('INVALID_REQUEST', 'kind is invalid', 400);
        if (title !== undefined && (!title.trim() || title.length > 200)) return error('INVALID_REQUEST', 'title is invalid', 400);
        if (description !== undefined && description.length > 2000) return error('INVALID_REQUEST', 'description is invalid', 400);
        if (ttlMinutes !== undefined && (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440)) return error('INVALID_REQUEST', 'ttl_minutes must be an integer between 1 and 1440', 400);
        const resolution = WalletClient.resolve(principal, env);
        if (!resolution.ok) return walletResolutionError(resolution.reason);
        const idempotencyHeader = request.headers.get('idempotency-key')?.trim() ?? '';
        try {
          const form = await resolution.client.createForm({
            provider,
            ...(kind === undefined ? {} : { kind }),
            ...(title === undefined ? {} : { title }),
            ...(description === undefined ? {} : { description }),
            ...(ttlMinutes === undefined ? {} : { ttlMinutes }),
            ...(idempotencyHeader ? { idempotencyKey: await sha256(idempotencyHeader) } : {}),
          });
          return json({
            connection_id: form.connectionId,
            form_id: form.formId,
            form_url: form.url,
            status_url: form.statusUrl,
            expires_at: form.expiresAt,
            state: form.state,
          }, 201);
        } catch (failure) { return walletFailure(failure); }
      }
      if (path.length === 3 && request.method === 'GET') {
        if (!requireScope(principal, 'credentials:read')) return error('FORBIDDEN', 'API key does not have the required scope', 403);
        const connectionId = path[2] ?? '';
        if (!WALLET_CONNECTION_ID.test(connectionId)) return error('INVALID_REQUEST', 'connection id is invalid', 400);
        const resolution = WalletClient.resolve(principal, env);
        if (!resolution.ok) return walletResolutionError(resolution.reason);
        try {
          const connection = await resolution.client.getConnection(connectionId);
          return json({
            connection_id: connection.connectionId,
            provider: connection.provider,
            state: connection.state,
            kv_version: connection.kvVersion,
            updated_at: connection.updatedAt,
          });
        } catch (failure) { return walletFailure(failure); }
      }
      if (path.length === 2 || path.length === 3) return error('METHOD_NOT_ALLOWED', 'method not allowed', 405);
      return error('ROUTE_NOT_FOUND', `no route for ${url.pathname}`, 404);
    }
    if (path[0] !== 'v1' || path[1] !== 'runs') return error('ROUTE_NOT_FOUND', `no route for ${url.pathname}`, 404);
    if ((path.length === 2 && !['GET', 'POST'].includes(request.method)) || (path.length > 2 && !['GET', 'POST'].includes(request.method))) return error('METHOD_NOT_ALLOWED', 'method not allowed', 405);
    if (!requireScope(principal, path.length === 2 && request.method === 'POST' || path[3] === 'cancel' ? 'runs:write' : 'runs:read')) return error('FORBIDDEN', 'API key does not have the required scope', 403);
    let objectName: string;
    if (path.length === 2 && request.method === 'POST') {
      let submitted: { userTaskId?: unknown };
      try { submitted = await request.clone().json() as { userTaskId?: unknown }; } catch { return error('INVALID_REQUEST', 'request body must be JSON', 400); }
      if (typeof submitted.userTaskId !== 'string' || !SAFE_ID.test(submitted.userTaskId)) return error('INVALID_REQUEST', 'userTaskId is required and must be a safe id', 400);
      objectName = `task-${await sha256(`${principal.principalId}\0${principal.profileId}\0${submitted.userTaskId}`)}`;
    } else if (path.length === 2 && request.method === 'GET') {
      const taskId = url.searchParams.get('userTaskId');
      if (!taskId || !SAFE_ID.test(taskId)) return error('INVALID_REQUEST', 'userTaskId query parameter is required and must be a safe id', 400);
      const state = url.searchParams.get('state');
      if (state !== null && !['active', 'all'].includes(state)) return error('INVALID_REQUEST', 'state supports active or all', 400);
      objectName = `task-${await sha256(`${principal.principalId}\0${principal.profileId}\0${taskId}`)}`;
    } else {
      const match = /^run_([0-9a-f]{64})_[0-9a-f]{24}$/.exec(path[2] ?? '');
      if (!match?.[1]) return error('INVALID_REQUEST', 'invalid run id', 400);
      objectName = `task-${match[1]}`;
    }
    const object = env.RUNNER_RUNS.get(env.RUNNER_RUNS.idFromName(objectName));
    const forwarded = new Request(`https://runner-runs.internal${url.pathname}${url.search}`, request);
    const headers = new Headers(forwarded.headers);
    headers.set('x-runner-principal', JSON.stringify(principal));
    return object.fetch(new Request(forwarded, { headers }));
  },
};

export { DEFAULT_ENGINE, SAFE_ID, error, json, sha256 };
