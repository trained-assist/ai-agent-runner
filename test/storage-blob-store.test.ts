import { describe, expect, it } from 'vitest';
import { StorageError, isNotFound, isStorageError } from '../src/storage/errors.js';
import {
  MAX_KEY_SEGMENT_LENGTH,
  MAX_STORAGE_KEY_LENGTH,
  assertSafeStorageKey,
  buildStorageKey,
  profileKey,
  runArtifactKey,
  slugKeySegment,
} from '../src/storage/keys.js';
import { boundCall, sha256Hex, toBuffer, withDeadline } from '../src/storage/blob-store.js';

describe('storage key builder', () => {
  it('builds run artifact and profile keys from one builder', () => {
    expect(runArtifactKey('run-1', 'art-1')).toBe('runs/run-1/artifacts/art-1');
    expect(profileKey('profile-a', 'sessions', 's1.json.gz')).toBe('profiles/profile-a/sessions/s1.json.gz');
    expect(buildStorageKey('runs', 'run-1', 'artifacts', 'art-1')).toBe(runArtifactKey('run-1', 'art-1'));
  });

  it('rejects traversal, absolute paths and control characters', () => {
    expect(() => runArtifactKey('../etc', 'art-1')).toThrow(StorageError);
    expect(() => runArtifactKey('run-1', '..')).toThrow(StorageError);
    expect(() => profileKey('profile-a', '', 'x')).toThrow(StorageError);
    expect(() => profileKey('profile-a', '.')).toThrow(StorageError);
    expect(() => buildStorageKey('runs', 'a/b')).toThrow(StorageError);
    expect(() => assertSafeStorageKey('/abs/path')).toThrow(StorageError);
    expect(() => assertSafeStorageKey('runs/a\0b')).toThrow(StorageError);
    expect(() => assertSafeStorageKey(`runs/${'a'.repeat(MAX_STORAGE_KEY_LENGTH)}`)).toThrow(StorageError);
  });

  it('reports BLOB_UNSAFE_KEY for every rejected key', () => {
    try {
      runArtifactKey('run-1', '..');
      throw new Error('expected a throw');
    } catch (err) {
      expect(isStorageError(err, 'BLOB_UNSAFE_KEY')).toBe(true);
    }
  });

  it('slugs lossy segments deterministically instead of throwing', () => {
    const slug = slugKeySegment('/home/vova/Проект');
    expect(slug).toBe(slugKeySegment('/home/vova/Проект'));
    expect(slug.length).toBeLessThanOrEqual(MAX_KEY_SEGMENT_LENGTH);
    expect(slug).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(slugKeySegment('..')).toMatch(/^s-[0-9a-f]{16}$/);
    expect(() => slugKeySegment('')).toThrow(StorageError);
  });
});

describe('blob hashing helpers', () => {
  it('hashes stored bytes with the published sha256 vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'));
  });

  it('accepts string, Buffer and Uint8Array input', () => {
    expect(toBuffer('abc')).toEqual(Buffer.from('abc'));
    expect(toBuffer(new Uint8Array([97, 98, 99]))).toEqual(Buffer.from('abc'));
    expect(toBuffer(Buffer.from('abc'))).toEqual(Buffer.from('abc'));
    expect(() => toBuffer(42 as unknown as string)).toThrow(StorageError);
  });
});

describe('deadlines', () => {
  it('rejects a hanging call with BLOB_TIMEOUT', async () => {
    const hanging = new Promise<never>(() => undefined);
    await expect(withDeadline(hanging, 20, 'blob put key')).rejects.toMatchObject({ code: 'BLOB_TIMEOUT' });
  });

  it('applies the per-call deadline through boundCall', async () => {
    const slow = (deadlineMs: number): Promise<string> =>
      boundCall('blob get key', { deadlineMs }, 60_000, () => new Promise((resolve) => setTimeout(() => resolve('late'), 200)));
    await expect(slow(20)).rejects.toMatchObject({ code: 'BLOB_TIMEOUT' });
  });

  it('passes through a call that finishes inside the deadline', async () => {
    const result = await boundCall('blob get key', { deadlineMs: 1000 }, 60_000, () => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('rejects a non-positive deadline as misconfiguration', () => {
    try {
      boundCall('blob get key', { deadlineMs: 0 }, 60_000, () => Promise.resolve('ok'));
      throw new Error('expected a throw');
    } catch (err) {
      expect(isStorageError(err, 'BLOB_BACKEND_MISCONFIGURED')).toBe(true);
    }
  });
});

describe('storage errors', () => {
  it('redacts secrets from messages', () => {
    const err = new StorageError('BLOB_TIMEOUT', 'upload failed for api_key=sk-live-123456789012');
    expect(err.message).toContain('[redacted]');
    expect(err.message).not.toContain('sk-live-123456789012');
  });

  it('classifies not-found errors from storage codes and fs/404 codes', () => {
    expect(isNotFound(new StorageError('BLOB_NOT_FOUND', 'missing'))).toBe(true);
    expect(isNotFound(Object.assign(new Error('enoent'), { code: 'ENOENT' }))).toBe(true);
    expect(isNotFound(Object.assign(new Error('gone'), { code: 404 }))).toBe(true);
    expect(isNotFound(new StorageError('BLOB_TIMEOUT', 'slow'))).toBe(false);
  });
});
