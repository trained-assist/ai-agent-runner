import type { ApiPrincipal, RunnerWorkerEnv } from './types.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_ENGINE = 'eu-vm-agent-run';

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
  try {
    const raw: unknown = JSON.parse(env.RUNNER_API_KEYS);
    if (!Array.isArray(raw) || raw.some((item) => !validKeyConfig(item))) throw new Error('invalid key records');
    configured = raw as KeyConfig[];
  } catch { throw new Error('RUNNER_API_KEYS must be a valid JSON array of key hash records'); }
  const digest = await sha256(match[1]);
  const record = configured.find((entry) => entry.keyHash === digest);
  return record ? { principalId: record.principalId, profileId: record.profileId,
    ...(record.repository ? { repository: record.repository } : {}),
    ...(record.tenantId ? { tenantId: record.tenantId } : {}), scopes: record.scopes,
    ...(record.engines ? { engines: record.engines } : {}), ...(record.mcpBindings ? { mcpBindings: record.mcpBindings } : {}), keyHash: record.keyHash } : null;
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
    && Array.isArray(record['scopes']) && record['scopes'].length > 0 && record['scopes'].every((scope) => ['runs:read', 'runs:write'].includes(String(scope)))
    && (engines === undefined || Array.isArray(engines) && engines.every((engine) => typeof engine === 'string'))
    && (validRepository || mockOnly || pinnedMcpOnly)
    && (record['mcpBindings'] === undefined || Array.isArray(record['mcpBindings']) && record['mcpBindings'].every((binding) => typeof binding === 'string' && binding.length > 0 && binding.length <= 300));
}

function requireScope(principal: ApiPrincipal, scope: string): boolean { return principal.scopes.includes(scope); }

export default {
  async fetch(request: Request, env: RunnerWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return json({ status: 'ok', service: 'ai-agent-runner-api', placement: 'cloudflare-worker', executionWorker: 'eu-vm-agent-run' });
    if (url.pathname === '/version' && request.method === 'GET') return json({ service: 'ai-agent-runner-api', runtime: 'cloudflare-worker', contractVersion: 1, buildSha: env.BUILD_SHA ?? null });
    let authenticated: ApiPrincipal | null;
    try { authenticated = await authenticate(request, env); } catch { return error('SERVER_MISCONFIGURED', 'Runner API authentication is not configured', 503); }
    if (!authenticated) return error('UNAUTHENTICATED', 'a valid Bearer API key is required', 401);
    let principal: ApiPrincipal;
    try { principal = await delegatedPrincipal(request, authenticated, env); }
    catch { return error('FORBIDDEN', 'invalid or expired host profile capability', 403); }
    if (url.pathname === '/v1/capabilities' && request.method === 'GET') {
      if (!requireScope(principal, 'runs:read')) return error('FORBIDDEN', 'API key does not have the required scope', 403);
      return json({ schemaVersion: 1, contract: { name: 'ai-agent-runner/serverless-agent-api', version: 1 }, placement: 'cloudflare-worker', executionRegions: ['eu-vm-agent-run'] });
    }
    const path = url.pathname.split('/').filter(Boolean);
    if (path[0] !== 'v1' || path[1] !== 'runs') return error('ROUTE_NOT_FOUND', `no route for ${url.pathname}`, 404);
    if ((path.length === 2 && request.method !== 'POST') || (path.length > 2 && !['GET', 'POST'].includes(request.method))) return error('METHOD_NOT_ALLOWED', 'method not allowed', 405);
    if (!requireScope(principal, path.length === 2 || path[3] === 'cancel' ? 'runs:write' : 'runs:read')) return error('FORBIDDEN', 'API key does not have the required scope', 403);
    let objectName: string;
    if (path.length === 2 && request.method === 'POST') {
      let submitted: { userTaskId?: unknown };
      try { submitted = await request.clone().json() as { userTaskId?: unknown }; } catch { return error('INVALID_REQUEST', 'request body must be JSON', 400); }
      if (typeof submitted.userTaskId !== 'string' || !SAFE_ID.test(submitted.userTaskId)) return error('INVALID_REQUEST', 'userTaskId is required and must be a safe id', 400);
      objectName = `task-${await sha256(`${principal.principalId}\0${principal.profileId}\0${submitted.userTaskId}`)}`;
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
