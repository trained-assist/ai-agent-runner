import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ArtifactStore } from '../storage/artifact-store.js';
import { ARTIFACT_ROUTE_PREFIXES, ARTIFACT_TOKEN_PARAM, type ShareTokenIssuer } from '../storage/share.js';
import type { KeyRegistry, Principal } from './auth.js';
import { ApiError } from './errors.js';

export interface ArtifactRouteDeps {
  artifacts: ArtifactStore;
  keys: KeyRegistry;
  tokens?: ShareTokenIssuer;
  logger?: (entry: Record<string, unknown>) => void;
}

export interface ArtifactRouteContext {
  artifactId: string;
  runId: string;
  action: 'download' | 'meta';
  auth: 'token' | 'key';
  principalId?: string;
}

type AuthOutcome = { mode: 'token' } | { mode: 'key'; principal: Principal };

export async function handleArtifactRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ArtifactRouteDeps,
  context?: Partial<ArtifactRouteContext>,
): Promise<number | null> {
  const url = new URL(req.url ?? '/', 'http://agent-api.local');
  const prefix = ARTIFACT_ROUTE_PREFIXES.find((candidate) => url.pathname.startsWith(candidate));
  if (!prefix) return null;
  if (req.method !== 'GET') throw new ApiError('METHOD_NOT_ALLOWED', 'artifact routes support GET only');

  const segments = url.pathname.slice(prefix.length).split('/').filter((segment) => segment.length > 0);
  const artifactId = segments[0];
  if (!artifactId || segments.length > 2 || (segments[1] !== undefined && segments[1] !== 'meta')) {
    throw new ApiError('ROUTE_NOT_FOUND', `no route for ${url.pathname}`);
  }
  const action: 'download' | 'meta' = segments[1] === 'meta' ? 'meta' : 'download';

  const auth = authenticate(req, url, deps, artifactId);
  const located = deps.artifacts.find(artifactId);
  if (!located) throw new ApiError('NOT_FOUND', `unknown artifact ${artifactId}`);
  if (auth.mode === 'key' && auth.principal.profileId !== located.manifest.profileId) {
    throw new ApiError('NOT_FOUND', `unknown artifact ${artifactId}`);
  }

  const { manifest } = located;
  if (context) {
    context.artifactId = manifest.artifactId;
    context.runId = manifest.runId;
    context.action = action;
    context.auth = auth.mode;
    if (auth.mode === 'key') context.principalId = auth.principal.principalId;
  }

  if (action === 'meta') {
    sendJson(res, 200, manifest, { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    return 200;
  }

  const { bytes } = await deps.artifacts.read(manifest.runId, manifest.artifactId);
  res.writeHead(200, {
    'content-type': manifest.mime,
    'content-length': String(bytes.length),
    etag: `"${manifest.sha256}"`,
    'x-artifact-sha256': manifest.sha256,
    'x-artifact-id': manifest.artifactId,
    'x-content-type-options': 'nosniff',
    'content-disposition': `attachment; filename="${safeFileName(manifest.name)}"`,
    'cache-control': 'private, no-store',
  });
  res.end(bytes);
  return 200;
}

export function createArtifactServer(deps: ArtifactRouteDeps): Server {
  const logger = deps.logger ?? (() => undefined);
  return createServer((req, res) => {
    const startedAt = Date.now();
    const context: Partial<ArtifactRouteContext> = {};
    void handleArtifactRequest(req, res, deps, context)
      .catch((err: unknown): number => {
        const apiError = err instanceof ApiError ? err : new ApiError('INTERNAL', 'internal error');
        if (!(err instanceof ApiError)) {
          logger({ event: 'artifact_internal_error', message: err instanceof Error ? err.message : String(err) });
        }
        if (res.headersSent) res.end();
        else sendJson(res, apiError.status, apiError.body());
        return apiError.status;
      })
      .then((status: number | null) => {
        if (status === null) {
          sendJson(res, 404, new ApiError('ROUTE_NOT_FOUND', `no route for ${safePath(req.url)}`).body());
          status = 404;
        }
        logger({
          event: 'artifact_request',
          method: req.method ?? 'GET',
          path: safePath(req.url),
          status,
          durationMs: Date.now() - startedAt,
          ...(context.artifactId ? { artifactId: context.artifactId } : {}),
          ...(context.runId ? { runId: context.runId } : {}),
          ...(context.action ? { action: context.action } : {}),
          ...(context.auth ? { auth: context.auth } : {}),
          ...(context.principalId ? { principalId: context.principalId } : {}),
        });
      });
  });
}

function authenticate(req: IncomingMessage, url: URL, deps: ArtifactRouteDeps, artifactId: string): AuthOutcome {
  const token = url.searchParams.get(ARTIFACT_TOKEN_PARAM);
  if (token !== null) {
    if (!deps.tokens || !deps.tokens.verify(artifactId, token)) {
      throw new ApiError('UNAUTHENTICATED', 'invalid or expired artifact share token');
    }
    return { mode: 'token' };
  }
  const principal = deps.keys.authenticate(req.headers['authorization']);
  if (!principal) throw new ApiError('UNAUTHENTICATED', 'a valid Bearer API key or artifact share token is required');
  if (!principal.scopes.includes('runs:read')) {
    throw new ApiError('SCOPE_DENIED', `principal "${principal.principalId}" is missing scope "runs:read"`);
  }
  return { mode: 'key', principal };
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 150) : 'artifact';
}

function sendJson(res: ServerResponse, status: number, data: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function safePath(url: string | undefined): string {
  if (!url) return '/';
  const index = url.indexOf('?');
  return index >= 0 ? url.slice(0, index) : url;
}
