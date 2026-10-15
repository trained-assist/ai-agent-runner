import type { ApiPrincipal, DurableObjectStateLike, RunnerWorkerEnv } from './types.js';

export const GITHUB_CONNECTION_ID = /^ghc_[0-9a-f]{32}$/;
const TTL_MS = 15 * 60_000;
const TOKEN_LIMIT = 500;

type Connection = {
  principalId: string;
  profileId: string;
  tenantId?: string;
  repository?: string;
  id: string;
  state: 'pending' | 'verifying' | 'connected' | 'revoked';
  nonceHash: string;
  expiresAt: string;
  createdAt: string;
  github?: { id: number; login: string; repositoryAccess: 'push' | 'read' | 'none' };
  secret?: { iv: string; ciphertext: string };
};

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function fail(code: string, status: number): Response {
  return response({ error: { code, message: code.toLowerCase().replaceAll('_', ' ') } }, status);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

function secretKey(env: RunnerWorkerEnv): Uint8Array | null {
  const raw = env.RUNNER_GITHUB_CONNECTION_KEY;
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) return null;
  return Uint8Array.from(raw.match(/../g)!, (pair) => Number.parseInt(pair, 16));
}

async function encrypt(token: string, env: RunnerWorkerEnv, connection: Connection): Promise<{ iv: string; ciphertext: string }> {
  const raw = secretKey(env);
  if (!raw) throw new Error('github_connection_key_unavailable');
  const key = await crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`${connection.principalId}\0${connection.profileId}\0${connection.tenantId ?? ''}\0${connection.id}`);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, new TextEncoder().encode(token)));
  return { iv: bytesToHex(iv), ciphertext: bytesToHex(ciphertext) };
}

function matches(connection: Connection, principal: ApiPrincipal): boolean {
  return connection.principalId === principal.principalId && connection.profileId === principal.profileId
    && connection.tenantId === principal.tenantId;
}

function publicView(connection: Connection): Record<string, unknown> {
  const pending = connection.state === 'pending' || connection.state === 'verifying';
  const status = pending ? Date.now() >= Date.parse(connection.expiresAt) ? 'expired' : 'pending' : connection.state;
  return { connectionId: connection.id, status, expiresAt: pending ? connection.expiresAt : null,
    createdAt: connection.createdAt, github: connection.github ?? null };
}

async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(merged);
}

export class RunnerGithubConnection {
  constructor(private readonly state: DurableObjectStateLike, private readonly env: RunnerWorkerEnv) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname;
    const current = await this.state.storage.get<Connection>('github-connection');
    if (route === '/internal/create') {
      if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);
      if (current) return fail('CONNECTION_EXISTS', 409);
      const data = await request.json() as { principal: ApiPrincipal; id: string; nonce: string };
      if (!GITHUB_CONNECTION_ID.test(data.id) || !/^[0-9a-f]{64}$/.test(data.nonce)) return fail('INVALID_REQUEST', 400);
      const connection: Connection = { id: data.id, principalId: data.principal.principalId, profileId: data.principal.profileId,
        ...(data.principal.tenantId ? { tenantId: data.principal.tenantId } : {}),
        ...(data.principal.repository ? { repository: data.principal.repository } : {}),
        state: 'pending', nonceHash: await sha256(data.nonce), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TTL_MS).toISOString() };
      await this.state.storage.put('github-connection', connection);
      return response(publicView(connection), 201);
    }
    if (!current) return fail('CONNECTION_NOT_FOUND', 404);
    if (route === '/internal/intake') {
      if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);
      const nonce = request.headers.get('x-runner-intake-nonce') ?? '';
      if (!/^[0-9a-f]{64}$/.test(nonce) || await sha256(nonce) !== current.nonceHash || current.state !== 'pending'
        || Date.now() >= Date.parse(current.expiresAt)) return fail('INTAKE_EXPIRED', 410);
      if (request.headers.get('x-zerocreds-preflight') === 'true') return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      if (Number(request.headers.get('content-length') ?? 0) > 2048) return fail('BODY_TOO_LARGE', 413);
      let body: unknown;
      try {
        const text = await readLimited(request, 2048);
        if (text === null) return fail('BODY_TOO_LARGE', 413);
        body = JSON.parse(text);
      } catch { return fail('INVALID_REQUEST', 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'token') return fail('INVALID_REQUEST', 400);
      const token = (body as Record<string, unknown>)['token'];
      if (typeof token !== 'string' || !token || token.length > TOKEN_LIMIT || /[\r\n\x00-\x1f]/.test(token)) return fail('INVALID_TOKEN', 400);
      if (!secretKey(this.env)) return fail('CONNECTION_UNAVAILABLE', 503);
      let claimed = false;
      await this.state.storage.transaction(async (tx) => {
        const latest = await tx.get<Connection>('github-connection');
        if (latest?.state !== 'pending' || latest.nonceHash !== current.nonceHash || Date.now() >= Date.parse(latest.expiresAt)) return;
        await tx.put('github-connection', { ...latest, state: 'verifying' });
        claimed = true;
      });
      if (!claimed) return fail('INTAKE_EXPIRED', 410);
      const get = this.env.FETCH ?? fetch;
      let github: Connection['github'];
      let committed = false;
      try {
        const identity = await get('https://api.github.com/user', { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'trained-assist-runner' }, signal: AbortSignal.timeout(10_000) });
        if (!identity.ok) return fail('GITHUB_TOKEN_REJECTED', 422);
        const user = await identity.json() as { id?: unknown; login?: unknown };
        if (!Number.isSafeInteger(user.id) || typeof user.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(user.login)) return fail('GITHUB_IDENTITY_INVALID', 502);
        let repositoryAccess: 'push' | 'read' | 'none' = 'none';
        if (current.repository) {
          const repository = await get(`https://api.github.com/repos/${current.repository}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'trained-assist-runner' }, signal: AbortSignal.timeout(10_000) });
          if (repository.ok) {
            const info = await repository.json() as { permissions?: { push?: boolean; pull?: boolean } };
            repositoryAccess = info.permissions?.push === true ? 'push' : info.permissions?.pull === true ? 'read' : 'none';
          }
        }
        github = { id: user.id as number, login: user.login, repositoryAccess };
        const secret = await encrypt(token, this.env, current);
        await this.state.storage.transaction(async (tx) => {
          const latest = await tx.get<Connection>('github-connection');
          if (latest?.state !== 'verifying' || latest.nonceHash !== current.nonceHash || Date.now() >= Date.parse(latest.expiresAt)) return;
          await tx.put('github-connection', { ...latest, state: 'connected', github, secret, nonceHash: '' });
          committed = true;
        });
        return committed ? response({ ok: true }) : fail('INTAKE_EXPIRED', 410);
      } catch { return fail('GITHUB_UNAVAILABLE', 502); }
      finally {
        if (!committed) await this.state.storage.transaction(async (tx) => {
          const latest = await tx.get<Connection>('github-connection');
          if (latest?.state === 'verifying' && latest.nonceHash === current.nonceHash) await tx.put('github-connection', { ...latest, state: 'pending' });
        });
      }
    }
    let principal: ApiPrincipal;
    try { principal = JSON.parse(request.headers.get('x-runner-principal') ?? 'null') as ApiPrincipal; }
    catch { return fail('UNAUTHENTICATED', 401); }
    if (!principal || !matches(current, principal)) return fail('CONNECTION_NOT_FOUND', 404);
    if (route === '/internal/status' && request.method === 'GET') return response(publicView(current));
    if (route === '/internal/revoke' && request.method === 'DELETE') {
      await this.state.storage.put('github-connection', { ...current, state: 'revoked', secret: undefined, nonceHash: '' });
      return response({ connectionId: current.id, status: 'revoked' });
    }
    return fail('ROUTE_NOT_FOUND', 404);
  }
}

export function githubConnectionConfigured(env: RunnerWorkerEnv): boolean {
  return env.DEPLOYMENT_ENV !== 'production' && env.RUNNER_DEVELOPER_API_ENABLED === 'true'
    && !!env.RUNNER_GITHUB_CONNECTIONS && !!secretKey(env)
    && !!env.ZEROCREDS_API_URL && /^https:\/\/[^/?#]+\/?$/.test(env.ZEROCREDS_API_URL)
    && !!env.ZEROCREDS_INTEGRATOR_TOKEN;
}
