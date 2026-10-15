import type { ApiPrincipal, RunnerWorkerEnv } from './types.js';
import { GITHUB_CONNECTION_ID, githubConnectionConfigured } from './github-connection.js';

const INTAKE = /^\/v1\/developer\/github\/intake\/(ghc_[0-9a-f]{32})\/([0-9a-f]{64})$/;
const CONNECTION = /^\/v1\/developer\/github\/connections(?:\/(ghc_[0-9a-f]{32}))?$/;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function fail(code: string, status: number): Response {
  return json({ error: { code, message: code.toLowerCase().replaceAll('_', ' ') } }, status);
}

function objectFor(env: RunnerWorkerEnv, id: string): { fetch(request: Request): Promise<Response> } {
  return env.RUNNER_GITHUB_CONNECTIONS!.get(env.RUNNER_GITHUB_CONNECTIONS!.idFromName(id));
}

export function isGithubIntake(pathname: string): boolean { return INTAKE.test(pathname); }
export function isGithubConnectionPath(pathname: string): boolean { return pathname.startsWith('/v1/developer/github/connections'); }

export async function githubIntake(request: Request, env: RunnerWorkerEnv): Promise<Response> {
  const match = INTAKE.exec(new URL(request.url).pathname);
  if (!match) return fail('ROUTE_NOT_FOUND', 404);
  if (!githubConnectionConfigured(env)) return fail('CONNECTION_UNAVAILABLE', 503);
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  headers.set('x-runner-intake-nonce', match[2]!);
  return objectFor(env, match[1]!).fetch(new Request('https://runner-github.internal/internal/intake', { method: 'POST', headers, body: request.body, duplex: 'half' } as RequestInit));
}

export async function githubConnections(request: Request, env: RunnerWorkerEnv, principal: ApiPrincipal): Promise<Response> {
  if (!githubConnectionConfigured(env)) return fail('CONNECTION_UNAVAILABLE', 503);
  const url = new URL(request.url);
  const match = CONNECTION.exec(url.pathname);
  if (!match || url.search) return fail('ROUTE_NOT_FOUND', 404);
  if (match[1]) {
    if (request.method !== 'GET' && request.method !== 'DELETE') return fail('METHOD_NOT_ALLOWED', 405);
    if (!principal.scopes.includes(request.method === 'GET' ? 'runs:read' : 'runs:write')) return fail('FORBIDDEN', 403);
    const headers = { 'x-runner-principal': JSON.stringify(principal) };
    return objectFor(env, match[1]).fetch(new Request(`https://runner-github.internal/internal/${request.method === 'GET' ? 'status' : 'revoke'}`, { method: request.method, headers }));
  }
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);
  if (!principal.scopes.includes('runs:write')) return fail('FORBIDDEN', 403);
  if (request.body) return fail('INVALID_REQUEST', 400);
  const id = `ghc_${[...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!GITHUB_CONNECTION_ID.test(id)) return fail('CONNECTION_UNAVAILABLE', 503);
  const connection = objectFor(env, id);
  const created = await connection.fetch(new Request('https://runner-github.internal/internal/create', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, nonce, principal }),
  }));
  if (!created.ok) return created;
  const intake = `${env.RUNNER_API_PUBLIC_URL.replace(/\/+$/, '')}/v1/developer/github/intake/${id}/${nonce}`;
  const destination = { type: 'http_post', url: intake, body: { token: '{token}' } };
  try {
    const response = await (env.FETCH ?? fetch)(`${env.ZEROCREDS_API_URL!.replace(/\/+$/, '')}/api/session/create`, {
      method: 'POST', headers: { authorization: `Bearer ${env.ZEROCREDS_INTEGRATOR_TOKEN}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ title: 'Подключить GitHub к ServerlessAgence',
        description: 'Токен будет проверен через GitHub и привязан к вашему подключению. Он не возвращается агенту.',
        fields: [{ name: 'token', label: 'GitHub personal access token', type: 'password', level: 'secret', required: true }],
        destination, ttl_minutes: 15 }),
    });
    if (!response.ok) throw new Error('zerocreds_create_failed');
    const data = await response.json() as { url?: unknown; expires_at?: unknown };
    if (typeof data.url !== 'string' || !data.url.startsWith(`${env.ZEROCREDS_API_URL!.replace(/\/+$/, '')}/f/`)) throw new Error('zerocreds_url_invalid');
    return json({ connectionId: id, status: 'pending', formUrl: data.url, expiresAt: data.expires_at ?? null }, 201);
  } catch {
    await connection.fetch(new Request('https://runner-github.internal/internal/revoke', { method: 'DELETE', headers: { 'x-runner-principal': JSON.stringify(principal) } }));
    return fail('ZEROCREDS_UNAVAILABLE', 502);
  }
}
