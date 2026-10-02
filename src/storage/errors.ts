import { redactSecrets } from '../runner/util.js';

export type StorageErrorCode =
  | 'BLOB_UNSAFE_KEY'
  | 'BLOB_NOT_FOUND'
  | 'BLOB_TIMEOUT'
  | 'BLOB_SHA_MISMATCH'
  | 'BLOB_UPLOAD_UNVERIFIED'
  | 'BLOB_BACKEND_UNSUPPORTED'
  | 'BLOB_BACKEND_MISCONFIGURED'
  | 'ARTIFACT_CONFLICT'
  | 'ARTIFACT_MANIFEST_INVALID'
  | 'ARTIFACT_PATH_ESCAPE'
  | 'ARTIFACT_EXPORT_INVALID'
  | 'ARTIFACT_EXPORT_FAILED'
  | 'UPLOAD_SESSION_INVALID'
  | 'UPLOAD_SESSION_NOT_FOUND'
  | 'UPLOAD_SESSION_EXPIRED'
  | 'UPLOAD_HASH_MISMATCH'
  | 'UPLOAD_SIZE_MISMATCH';

const STORAGE_CODES: readonly StorageErrorCode[] = [
  'BLOB_UNSAFE_KEY',
  'BLOB_NOT_FOUND',
  'BLOB_TIMEOUT',
  'BLOB_SHA_MISMATCH',
  'BLOB_UPLOAD_UNVERIFIED',
  'BLOB_BACKEND_UNSUPPORTED',
  'BLOB_BACKEND_MISCONFIGURED',
  'ARTIFACT_CONFLICT',
  'ARTIFACT_MANIFEST_INVALID',
  'ARTIFACT_PATH_ESCAPE',
  'ARTIFACT_EXPORT_INVALID',
  'ARTIFACT_EXPORT_FAILED',
  'UPLOAD_SESSION_INVALID',
  'UPLOAD_SESSION_NOT_FOUND',
  'UPLOAD_SESSION_EXPIRED',
  'UPLOAD_HASH_MISMATCH',
  'UPLOAD_SIZE_MISMATCH',
];

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: StorageErrorCode, message: string, detail?: Record<string, unknown>) {
    super(redactSecrets(message));
    this.name = 'StorageError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export function isStorageError(err: unknown, code?: StorageErrorCode): err is StorageError {
  if (!(err instanceof StorageError)) return false;
  return code === undefined || err.code === code;
}

export function isNotFound(err: unknown): boolean {
  if (isStorageError(err, 'BLOB_NOT_FOUND')) return true;
  const candidate = err as { code?: unknown } | null;
  if (!candidate) return false;
  if (candidate.code === 404) return true;
  return candidate.code === 'ENOENT' || candidate.code === 'NotFound' || candidate.code === 'NoSuchKey';
}

export function isStorageErrorCode(value: unknown): value is StorageErrorCode {
  return typeof value === 'string' && (STORAGE_CODES as readonly string[]).includes(value);
}
