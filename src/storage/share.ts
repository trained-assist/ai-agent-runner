import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BlobBackend, BlobShareUrl, BlobStore } from './blob-store.js';
import { StorageError } from './errors.js';
import type { ArtifactManifest } from './manifest.js';

export const DEFAULT_SHARE_TTL_SECONDS = 600;
export const ARTIFACT_TOKEN_PARAM = 't';
export const ARTIFACT_ROUTE_PREFIXES = ['/v1/artifacts/', '/artifact/'] as const;

export interface ShareToken {
  token: string;
  expiresAt: string;
}

export interface ShareLink {
  artifactId: string;
  runId: string;
  url: string;
  expiresAt: string;
  backend: BlobBackend;
}

export interface ShareTokenIssuerOptions {
  secret?: string;
  ttlSeconds?: number;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

function hmac(secret: Buffer, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export class ShareTokenIssuer {
  readonly ttlSeconds: number;
  private readonly secret: Buffer;
  private readonly now: () => Date;

  constructor(options: ShareTokenIssuerOptions = {}) {
    const ttl = options.ttlSeconds ?? DEFAULT_SHARE_TTL_SECONDS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new StorageError('BLOB_BACKEND_MISCONFIGURED', `share ttl must be a positive number of seconds, got ${String(ttl)}`);
    }
    this.ttlSeconds = ttl;
    const env = options.env ?? process.env;
    this.secret = Buffer.from(options.secret || env['ARTIFACT_SHARE_SECRET'] || randomBytes(32).toString('hex'), 'utf8');
    this.now = options.now ?? (() => new Date());
  }

  issue(artifactId: string, options: { ttlSeconds?: number } = {}): ShareToken {
    const ttl = options.ttlSeconds ?? this.ttlSeconds;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new StorageError('BLOB_BACKEND_MISCONFIGURED', `share ttl must be a positive number of seconds, got ${String(ttl)}`);
    }
    const expiresAtMs = this.now().getTime() + ttl * 1000;
    const signature = hmac(this.secret, `${artifactId}.${expiresAtMs}`);
    return { token: `${expiresAtMs}.${signature}`, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  verify(artifactId: string, token: unknown): boolean {
    if (typeof token !== 'string') return false;
    const separator = token.indexOf('.');
    if (separator <= 0) return false;
    const expiresAtMs = Number(token.slice(0, separator));
    if (!Number.isFinite(expiresAtMs)) return false;
    if (expiresAtMs <= this.now().getTime()) return false;
    const expected = Buffer.from(hmac(this.secret, `${artifactId}.${expiresAtMs}`), 'utf8');
    const presented = Buffer.from(token.slice(separator + 1), 'utf8');
    if (expected.length !== presented.length) return false;
    return timingSafeEqual(expected, presented);
  }
}

export function artifactSharePath(baseUrl: string, artifactId: string, token: string): string {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new StorageError('BLOB_BACKEND_MISCONFIGURED', 'share links through the API require a base url (ARTIFACT_BASE_URL)');
  }
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/v1/artifacts/${encodeURIComponent(artifactId)}?${ARTIFACT_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

export interface ShareLinkDeps {
  blob: BlobStore;
  tokens?: ShareTokenIssuer;
  baseUrl?: string;
  env?: Record<string, string | undefined>;
}

export interface CreateShareLinkOptions {
  ttlSeconds?: number;
  expiresAt?: Date;
}

export async function createShareLink(deps: ShareLinkDeps, manifest: ArtifactManifest, options: CreateShareLinkOptions = {}): Promise<ShareLink> {
  const ttlSeconds = options.ttlSeconds ?? deps.tokens?.ttlSeconds ?? DEFAULT_SHARE_TTL_SECONDS;
  const expiresAt = options.expiresAt ?? new Date(Date.now() + ttlSeconds * 1000);

  if (deps.blob.shareUrl) {
    const signed: BlobShareUrl = await deps.blob.shareUrl(manifest.storageKey, { expiresAt });
    return { artifactId: manifest.artifactId, runId: manifest.runId, url: signed.url, expiresAt: signed.expiresAt, backend: deps.blob.backend };
  }

  if (deps.tokens) {
    const issued = deps.tokens.issue(manifest.artifactId, { ttlSeconds });
    const env = deps.env ?? process.env;
    const url = artifactSharePath(deps.baseUrl ?? env['ARTIFACT_BASE_URL'] ?? '', manifest.artifactId, issued.token);
    return { artifactId: manifest.artifactId, runId: manifest.runId, url, expiresAt: issued.expiresAt, backend: deps.blob.backend };
  }

  throw new StorageError(
    'BLOB_BACKEND_UNSUPPORTED',
    `no share-url support for the ${deps.blob.backend} backend: provide a ShareTokenIssuer for api-served links or a backend with presigned urls`,
  );
}
