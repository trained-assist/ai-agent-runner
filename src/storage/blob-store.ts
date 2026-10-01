import { createHash } from 'node:crypto';
import { StorageError } from './errors.js';

export type BlobBackend = 'local-fs' | 'gcs' | 'r2';

export const DEFAULT_DEADLINE_MS = 60_000;

export interface BlobRef {
  sha256: string;
  size: number;
  generation: string | null;
}

export interface BlobHead {
  size: number;
  generation: string | null;
}

export interface BlobShareUrl {
  url: string;
  expiresAt: string;
}

export interface BlobCallOptions {
  deadlineMs?: number;
}

export interface BlobShareOptions extends BlobCallOptions {
  expiresAt?: Date;
}

export interface BlobStore {
  readonly backend: BlobBackend;
  put(key: string, bytes: Uint8Array | string, options?: BlobCallOptions): Promise<BlobRef>;
  get(key: string, options?: BlobCallOptions): Promise<Buffer>;
  head(key: string, options?: BlobCallOptions): Promise<BlobHead>;
  delete?(key: string, options?: BlobCallOptions): Promise<void>;
  shareUrl?(key: string, options?: BlobShareOptions): Promise<BlobShareUrl>;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function toBuffer(data: Uint8Array | string): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  throw new StorageError('BLOB_UPLOAD_UNVERIFIED', `blob bytes must be a Buffer, Uint8Array or string, got ${typeof data}`);
}

export function resolveDeadline(option: number | undefined, fallback: number): number {
  if (option === undefined) return fallback;
  if (!Number.isFinite(option) || option <= 0) {
    throw new StorageError('BLOB_BACKEND_MISCONFIGURED', `deadline must be a positive number of ms, got ${String(option)}`);
  }
  return option;
}

export function withDeadline<T>(promise: Promise<T>, deadlineMs: number, label: string): Promise<T> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return promise;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StorageError('BLOB_TIMEOUT', `${label} timed out after ${deadlineMs}ms`)), deadlineMs);
    timer.unref?.();
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function boundCall<T>(label: string, options: BlobCallOptions | undefined, fallback: number, run: (deadlineMs: number) => Promise<T>): Promise<T> {
  const deadlineMs = resolveDeadline(options?.deadlineMs, fallback);
  return withDeadline(run(deadlineMs), deadlineMs, label);
}
