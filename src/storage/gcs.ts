import type { BlobCallOptions, BlobHead, BlobRef, BlobShareOptions, BlobShareUrl, BlobStore } from './blob-store.js';
import { DEFAULT_DEADLINE_MS, boundCall, sha256Hex, toBuffer } from './blob-store.js';
import { StorageError, isNotFound } from './errors.js';
import { assertSafeStorageKey } from './keys.js';

export interface GcsFileLike {
  save(data: Buffer, options?: Record<string, unknown>): Promise<unknown>;
  getMetadata(options?: Record<string, unknown>): Promise<unknown> | unknown;
  download(options?: Record<string, unknown>): Promise<unknown> | unknown;
  exists(options?: Record<string, unknown>): Promise<unknown> | unknown;
  delete(options?: Record<string, unknown>): Promise<unknown> | unknown;
  getSignedUrl(options: Record<string, unknown>): Promise<[string]>;
}

export interface GcsBucketLike {
  readonly name?: string;
  file(key: string): GcsFileLike;
}

export interface GcsBlobStoreOptions {
  bucket?: GcsBucketLike;
  bucketName?: string;
  projectId?: string;
  deadlineMs?: number;
  env?: Record<string, string | undefined>;
}

const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const DEFAULT_SHARE_TTL_SECONDS = 600;

const CRC32C_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0x82f63b78 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32cBase64(data: Uint8Array): string {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC32C_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(crc, 0);
  return bytes.toString('base64');
}

function firstOf<T>(value: unknown): T {
  return (Array.isArray(value) ? value[0] : value) as T;
}

function metadataOf(value: unknown): Record<string, unknown> {
  const meta = firstOf<unknown>(value);
  if (!meta || typeof meta !== 'object') return {};
  return meta as Record<string, unknown>;
}

export function resolveBucketName(env: Record<string, string | undefined>): string {
  const raw = typeof env['GCS_BUCKET'] === 'string' ? env['GCS_BUCKET'].trim() : '';
  if (!BUCKET_NAME_RE.test(raw) || raw.includes('..')) {
    throw new StorageError(
      'BLOB_BACKEND_MISCONFIGURED',
      'gcs backend requires GCS_BUCKET with a valid bucket name (3-63 chars, lowercase, alnum at the ends)',
    );
  }
  return raw;
}

export class GcsBlobStore implements BlobStore {
  readonly backend = 'gcs' as const;
  readonly bucketName: string | null;
  private readonly injected: GcsBucketLike | null;
  private readonly projectId: string | undefined;
  private readonly deadlineMs: number;
  private readonly env: Record<string, string | undefined>;
  private cached: GcsBucketLike | null = null;

  constructor(options: GcsBlobStoreOptions = {}) {
    this.injected = options.bucket ?? null;
    this.env = options.env ?? process.env;
    const envBucket = typeof this.env['GCS_BUCKET'] === 'string' ? this.env['GCS_BUCKET'].trim() : '';
    this.bucketName = options.bucketName ?? this.injected?.name ?? (envBucket !== '' ? envBucket : null);
    this.projectId = options.projectId ?? this.env['GCP_PROJECT'] ?? this.env['GOOGLE_CLOUD_PROJECT'] ?? undefined;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  private async bucket(): Promise<GcsBucketLike> {
    if (this.injected) return this.injected;
    if (this.cached) return this.cached;
    const candidate = this.bucketName;
    const bucketName =
      typeof candidate === 'string' && BUCKET_NAME_RE.test(candidate) && !candidate.includes('..') ? candidate : resolveBucketName(this.env);
    const mod = await import('@google-cloud/storage');
    const storage = new mod.Storage({ ...(this.projectId ? { projectId: this.projectId } : {}) });
    this.cached = storage.bucket(bucketName) as unknown as GcsBucketLike;
    return this.cached;
  }

  async put(key: string, bytes: Uint8Array | string, options?: BlobCallOptions): Promise<BlobRef> {
    const buf = toBuffer(bytes);
    const sha256 = sha256Hex(buf);
    return boundCall(`blob put ${key}`, options, this.deadlineMs, async () => {
      assertSafeStorageKey(key);
      const bucket = await this.bucket();
      const file = bucket.file(key);
      await file.save(buf, { contentType: 'application/octet-stream', resumable: false });
      let meta: Record<string, unknown>;
      try {
        meta = metadataOf(await file.getMetadata());
      } catch (err) {
        throw new StorageError(
          'BLOB_UPLOAD_UNVERIFIED',
          `blob put ${key} succeeded but the object metadata could not be read: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const storedCrc = typeof meta['crc32c'] === 'string' ? meta['crc32c'] : null;
      if (storedCrc === null) {
        throw new StorageError('BLOB_UPLOAD_UNVERIFIED', `blob put ${key} returned no crc32c, so the stored bytes cannot be verified`);
      }
      if (storedCrc !== crc32cBase64(buf)) {
        throw new StorageError('BLOB_SHA_MISMATCH', `stored object for ${key} does not match the uploaded bytes`);
      }
      const generation = meta['generation'] !== undefined && meta['generation'] !== null ? String(meta['generation']) : null;
      return { sha256, size: buf.length, generation };
    });
  }

  async get(key: string, options?: BlobCallOptions): Promise<Buffer> {
    return boundCall(`blob get ${key}`, options, this.deadlineMs, async () => {
      assertSafeStorageKey(key);
      const bucket = await this.bucket();
      try {
        const res = await bucket.file(key).download();
        const buf = firstOf<unknown>(res);
        return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as Uint8Array);
      } catch (err) {
        if (isNotFound(err)) throw new StorageError('BLOB_NOT_FOUND', `blob not found: ${key}`);
        throw err;
      }
    });
  }

  async head(key: string, options?: BlobCallOptions): Promise<BlobHead> {
    return boundCall(`blob head ${key}`, options, this.deadlineMs, async () => {
      assertSafeStorageKey(key);
      const bucket = await this.bucket();
      let meta: Record<string, unknown>;
      try {
        meta = metadataOf(await bucket.file(key).getMetadata());
      } catch (err) {
        if (isNotFound(err)) throw new StorageError('BLOB_NOT_FOUND', `blob not found: ${key}`);
        throw err;
      }
      const generation = meta['generation'] !== undefined && meta['generation'] !== null ? String(meta['generation']) : null;
      const size = typeof meta['size'] === 'string' || typeof meta['size'] === 'number' ? Number(meta['size']) : 0;
      return { size, generation };
    });
  }

  async delete(key: string, options?: BlobCallOptions): Promise<void> {
    await boundCall(`blob delete ${key}`, options, this.deadlineMs, async () => {
      assertSafeStorageKey(key);
      const bucket = await this.bucket();
      try {
        await bucket.file(key).delete();
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
    });
  }

  async shareUrl(key: string, options?: BlobShareOptions): Promise<BlobShareUrl> {
    return boundCall(`blob shareUrl ${key}`, options, this.deadlineMs, async () => {
      assertSafeStorageKey(key);
      const expiresAt = options?.expiresAt ?? new Date(Date.now() + DEFAULT_SHARE_TTL_SECONDS * 1000);
      const bucket = await this.bucket();
      const file = bucket.file(key);
      if (typeof file.getSignedUrl !== 'function') {
        throw new StorageError('BLOB_BACKEND_UNSUPPORTED', `gcs signed urls are unavailable for ${key}`);
      }
      try {
        const [url] = await file.getSignedUrl({ action: 'read', version: 'v4', expires: expiresAt });
        return { url, expiresAt: expiresAt.toISOString() };
      } catch (err) {
        throw new StorageError(
          'BLOB_BACKEND_UNSUPPORTED',
          `gcs signed url for ${key} could not be created: ${err instanceof Error ? err.message : String(err)} ` +
            '(v4 signing under ADC needs roles/iam.serviceAccountTokenCreator for the runtime service account; ' +
            'without it use the api share token path or an R2/S3 backend with presigned urls)',
        );
      }
    });
  }
}

export function createGcsBlobStore(options: GcsBlobStoreOptions = {}): GcsBlobStore {
  return new GcsBlobStore(options);
}
