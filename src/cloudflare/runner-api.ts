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
    ...(record.engines ? { engines: record.engines } : {}), keyHash: record.keyHash } : null;
}

function validKeyConfig(value: unknown): value is KeyConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const repository = record['repository'];
  const engines = record['engines'];
  const validRepository = typeof repository === 'string'
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/.test(repository);
  const mockOnly = Array.isArray(engines) && engines.length > 0 && engines.every((engine) => engine === 'mock-test');
  return typeof record['keyHash'] === 'string' && /^[0-9a-f]{64}$/.test(record['keyHash'])
    && typeof record['principalId'] === 'string' && !!record['principalId']
    && typeof record['profileId'] === 'string' && !!record['profileId']
    && (record['tenantId'] === undefined || typeof record['tenantId'] === 'string' && !!record['tenantId'])
    && Array.isArray(record['scopes']) && record['scopes'].length > 0 && record['scopes'].every((scope) => ['runs:read', 'runs:write'].includes(String(scope)))
    && (engines === undefined || Array.isArray(engines) && engines.every((engine) => typeof engine === 'string'))
    && (validRepository || mockOnly);
}

function requireScope(principal: ApiPrincipal, scope: string): boolean { return principal.scopes.includes(scope); }

export default {
  async fetch(request: Request, env: RunnerWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return json({ status: 'ok', service: 'ai-agent-runner-api', placement: 'cloudflare-worker', executionWorker: 'eu-vm-agent-run' });
    if (url.pathname === '/version' && request.method === 'GET') return json({ service: 'ai-agent-runner-api', runtime: 'cloudflare-worker', contractVersion: 1 });
    let principal: ApiPrincipal | null;
    try { principal = await authenticate(request, env); } catch { return error('SERVER_MISCONFIGURED', 'Runner API authentication is not configured', 503); }
    if (!principal) return error('UNAUTHENTICATED', 'a valid Bearer API key is required', 401);
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
