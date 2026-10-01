import type { BlobBackend, BlobStore } from './blob-store.js';
import { DEFAULT_DEADLINE_MS } from './blob-store.js';
import { StorageError } from './errors.js';
import { createGcsBlobStore, type GcsBucketLike } from './gcs.js';
import { DEFAULT_LOCAL_FS_ROOT, createLocalFsBlobStore, type LocalFsIo } from './local-fs.js';
import { createR2BlobStore, type R2BlobStoreOptions } from './r2.js';

export type StorageEnv = Record<string, string | undefined>;

const BACKEND_ALIASES: Record<string, BlobBackend> = {
  'local-fs': 'local-fs',
  local: 'local-fs',
  fs: 'local-fs',
  gcs: 'gcs',
  'google-cloud-storage': 'gcs',
  r2: 'r2',
  s3: 'r2',
};

export function matchBackend(value: string): BlobBackend {
  const backend = BACKEND_ALIASES[value.trim().toLowerCase()];
  if (!backend) {
    throw new StorageError('BLOB_BACKEND_MISCONFIGURED', `unknown storage backend "${value}" (expected local-fs | gcs | r2)`);
  }
  return backend;
}

export function resolveBackend(env: StorageEnv): BlobBackend {
  const raw = typeof env['STORAGE_BACKEND'] === 'string' ? env['STORAGE_BACKEND'].trim() : '';
  if (raw === '') return 'local-fs';
  return matchBackend(raw);
}

export function resolveDeadlineMs(env: StorageEnv, fallback: number = DEFAULT_DEADLINE_MS): number {
  const raw = typeof env['STORAGE_DEADLINE_MS'] === 'string' ? env['STORAGE_DEADLINE_MS'].trim() : '';
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new StorageError('BLOB_BACKEND_MISCONFIGURED', `STORAGE_DEADLINE_MS must be a positive number of ms, got "${raw}"`);
  }
  return value;
}

export interface CreateBlobStoreOptions {
  backend?: string;
  env?: StorageEnv;
  localRoot?: string;
  localFs?: LocalFsIo;
  bucketName?: string;
  bucket?: GcsBucketLike;
  projectId?: string;
  deadlineMs?: number;
  r2?: R2BlobStoreOptions;
}

export function createBlobStore(options: CreateBlobStoreOptions = {}): BlobStore {
  const env = options.env ?? process.env;
  const backend = options.backend !== undefined ? matchBackend(options.backend) : resolveBackend(env);
  const deadlineMs = options.deadlineMs ?? resolveDeadlineMs(env);
  switch (backend) {
    case 'local-fs': {
      const rootDir = options.localRoot ?? env['STORAGE_LOCAL_ROOT']?.trim() ?? DEFAULT_LOCAL_FS_ROOT;
      return createLocalFsBlobStore({
        rootDir,
        deadlineMs,
        ...(options.localFs ? { io: options.localFs } : {}),
      });
    }
    case 'gcs':
      return createGcsBlobStore({
        deadlineMs,
        env,
        ...(options.bucket ? { bucket: options.bucket } : {}),
        ...(options.bucketName ? { bucketName: options.bucketName } : {}),
        ...(options.projectId ? { projectId: options.projectId } : {}),
      });
    case 'r2':
      return createR2BlobStore(options.r2 ?? {});
    default:
      throw new StorageError('BLOB_BACKEND_MISCONFIGURED', `unreachable storage backend: ${String(backend)}`);
  }
}
