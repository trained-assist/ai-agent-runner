import { createHash } from 'node:crypto';
import { StorageError } from './errors.js';

export const MAX_STORAGE_KEY_LENGTH = 1024;
export const MAX_KEY_SEGMENT_LENGTH = 200;

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEY_CHAR_RE = /^[A-Za-z0-9._/-]+$/;

export function isSafeKeySegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_KEY_SEGMENT_LENGTH &&
    SEGMENT_RE.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

export function assertSafeKeySegment(value: unknown, field: string): string {
  if (!isSafeKeySegment(value)) {
    throw new StorageError('BLOB_UNSAFE_KEY', `invalid ${field}: expected one path segment matching ${SEGMENT_RE.source}`);
  }
  return value;
}

export function assertSafeStorageKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_STORAGE_KEY_LENGTH ||
    value.includes('\0') ||
    value.startsWith('/') ||
    !KEY_CHAR_RE.test(value)
  ) {
    throw new StorageError('BLOB_UNSAFE_KEY', 'invalid storage key: expected a relative POSIX path of safe characters');
  }
  const segments = value.split('/');
  if (!segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')) {
    throw new StorageError('BLOB_UNSAFE_KEY', 'invalid storage key: no empty, "." or ".." segments');
  }
  return value;
}

export function buildStorageKey(...segments: string[]): string {
  const parts = segments.map((segment, index) => assertSafeKeySegment(segment, `storage key segment ${index}`));
  return assertSafeStorageKey(parts.join('/'));
}

export function runArtifactKey(runId: string, artifactId: string): string {
  return buildStorageKey('runs', runId, 'artifacts', artifactId);
}

export function profileKey(profileId: string, ...rest: string[]): string {
  return buildStorageKey('profiles', profileId, ...rest);
}

export function slugKeySegment(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StorageError('BLOB_UNSAFE_KEY', 'slugKeySegment: a non-empty string is required');
  }
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 16);
  let slug = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || slug === '.' || slug === '..') return `s-${hash}`;
  if (slug.length > MAX_KEY_SEGMENT_LENGTH - 21) {
    slug = `${slug.slice(0, MAX_KEY_SEGMENT_LENGTH - 21).replace(/-+$/, '')}-${hash}`;
  }
  if (!SEGMENT_RE.test(slug)) return `s-${hash}`;
  return slug;
}
