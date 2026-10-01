import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobStore, matchBackend, resolveBackend, resolveDeadlineMs } from '../src/storage/create-blob-store.js';
import type { GcsBucketLike } from '../src/storage/gcs.js';
import { LocalFsBlobStore, type LocalFsIo } from '../src/storage/local-fs.js';
import { sha256Hex } from '../src/storage/blob-store.js';

interface FakeObject {
  data: Buffer;
  generation: number;
}

interface FakeBucket {
  bucket: GcsBucketLike;
  objects: Map<string, FakeObject>;
  calls: string[];
  fail: { save?: boolean; getMetadata?: boolean; download?: boolean; slowDownloadMs?: number };
}

function notFound(): Error {
  const err = new Error('not found');
  (err as Error & { code?: number }).code = 404;
  return err;
}

function fakeBucket(): FakeBucket {
  const objects = new Map<string, FakeObject>();
  const calls: string[] = [];
  const fail: FakeBucket['fail'] = {};
  let generation = 1000;
  const bucket: GcsBucketLike = {
    name: 'fake-bucket',
    file(key: string) {
      return {
        async save(data: Buffer) {
          calls.push(`save:${key}`);
          if (fail.save) throw new Error('save failed');
          generation += 1;
          objects.set(key, { data: Buffer.from(data), generation });
        },
        async getMetadata() {
          calls.push(`getMetadata:${key}`);
          if (fail.getMetadata) throw new Error('metadata failed');
          const object = objects.get(key);
          if (!object) throw notFound();
          return [{ size: String(object.data.length), generation: String(object.generation) }];
        },
        async download() {
          calls.push(`download:${key}`);
          if (fail.slowDownloadMs) await new Promise((resolve) => setTimeout(resolve, fail.slowDownloadMs));
          if (fail.download) throw new Error('download failed');
          const object = objects.get(key);
          if (!object) throw notFound();
          return [Buffer.from(object.data)];
        },
        async exists() {
          return [objects.has(key)];
        },
        async delete() {
          calls.push(`delete:${key}`);
          if (!objects.has(key)) throw notFound();
          objects.delete(key);
        },
        async getSignedUrl(options: Record<string, unknown>) {
          calls.push(`getSignedUrl:${key}`);
          const object = objects.get(key);
          if (!object) throw notFound();
          const expires = options['expires'] as Date;
          return [`https://storage.fake.test/${key}?generation=${object.generation}&expires=${expires.toISOString()}`];
        },
      };
    },
  };
  return { bucket, objects, calls, fail };
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'storage-backends-'));
  tempDirs.push(dir);
  return dir;
}

function expectSyncStorageCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected a storage error with code ${code}`);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('backend selection by env', () => {
  it('defaults to local-fs and resolves declared backends', () => {
    expect(resolveBackend({})).toBe('local-fs');
    expect(resolveBackend({ STORAGE_BACKEND: 'local-fs' })).toBe('local-fs');
    expect(resolveBackend({ STORAGE_BACKEND: ' gcs ' })).toBe('gcs');
    expect(resolveBackend({ STORAGE_BACKEND: 's3' })).toBe('r2');
    expect(matchBackend('Google-Cloud-Storage')).toBe('gcs');
  });

  it('rejects an unknown backend and a broken deadline', () => {
    expectSyncStorageCode(() => resolveBackend({ STORAGE_BACKEND: 'ftp' }), 'BLOB_BACKEND_MISCONFIGURED');
    expectSyncStorageCode(() => matchBackend('ftp'), 'BLOB_BACKEND_MISCONFIGURED');
    expectSyncStorageCode(() => resolveDeadlineMs({ STORAGE_DEADLINE_MS: 'soon' }), 'BLOB_BACKEND_MISCONFIGURED');
    expect(resolveDeadlineMs({ STORAGE_DEADLINE_MS: '250' })).toBe(250);
    expect(resolveDeadlineMs({})).toBe(60_000);
  });

  it('builds a store per backend without touching any real storage', () => {
    expect(createBlobStore({ env: {} }).backend).toBe('local-fs');
    expect(createBlobStore({ env: { STORAGE_BACKEND: 'gcs' } }).backend).toBe('gcs');
    expect(createBlobStore({ env: { STORAGE_BACKEND: 'r2' } }).backend).toBe('r2');
    expect(createBlobStore({ env: { STORAGE_BACKEND: 'local-fs', STORAGE_LOCAL_ROOT: tempDir() } }).backend).toBe('local-fs');
  });

  it('refuses gcs without a bucket before any credential or network access', async () => {
    const store = createBlobStore({ env: { STORAGE_BACKEND: 'gcs' } });
    await expect(store.put('runs/run-1/artifacts/art-1', 'x')).rejects.toMatchObject({ code: 'BLOB_BACKEND_MISCONFIGURED' });
  });
});

describe('local-fs backend', () => {
  it('stores, stats, reads back and deletes objects under the key path', async () => {
    const rootDir = tempDir();
    const store = createBlobStore({ env: { STORAGE_LOCAL_ROOT: rootDir } });
    const key = 'runs/run-1/artifacts/art-1';
    const bytes = Buffer.from('hello storage');

    const ref = await store.put(key, bytes);
    const onDisk = readFileSync(join(rootDir, key));
    expect(ref.sha256).toBe(sha256Hex(onDisk));
    expect(ref.sha256).toBe(sha256Hex(bytes));
    expect(ref.size).toBe(bytes.length);
    expect(ref.generation).toBeTruthy();

    expect(await store.get(key)).toEqual(bytes);
    const head = await store.head(key);
    expect(head.size).toBe(bytes.length);
    expect(head.generation).toBe(ref.generation);

    await store.delete?.(key);
    await expect(store.get(key)).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
    await expect(store.head(key)).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
  });

  it('rejects unsafe keys instead of escaping the root', async () => {
    const store = new LocalFsBlobStore({ rootDir: tempDir() });
    await expect(store.put('../escape', 'x')).rejects.toMatchObject({ code: 'BLOB_UNSAFE_KEY' });
    await expect(store.get('runs/../../etc/passwd')).rejects.toMatchObject({ code: 'BLOB_UNSAFE_KEY' });
  });

  it('bounds a hanging injected io call with BLOB_TIMEOUT', async () => {
    const hangingWrite = new LocalFsBlobStore({
      rootDir: tempDir(),
      io: {
        write: () => new Promise<void>(() => undefined),
        read: () => Buffer.alloc(0),
        stat: () => ({ size: 0, mtimeMs: 1 }),
        remove: () => undefined,
      },
      deadlineMs: 25,
    });
    await expect(hangingWrite.put('runs/run-1/artifacts/art-1', 'x')).rejects.toMatchObject({ code: 'BLOB_TIMEOUT' });

    const hangingRead = new LocalFsBlobStore({
      rootDir: tempDir(),
      io: {
        write: () => undefined,
        read: () => new Promise<Buffer>(() => undefined),
        stat: () => null,
        remove: () => undefined,
      },
      deadlineMs: 25,
    });
    await expect(hangingRead.get('runs/run-1/artifacts/art-1')).rejects.toMatchObject({ code: 'BLOB_TIMEOUT' });
  });

  it('maps a missing file to BLOB_NOT_FOUND', async () => {
    const io: LocalFsIo = {
      write: () => undefined,
      read: () => {
        const err = new Error('enoent');
        (err as Error & { code?: string }).code = 'ENOENT';
        throw err;
      },
      stat: () => null,
      remove: () => undefined,
    };
    const store = new LocalFsBlobStore({ rootDir: tempDir(), io });
    await expect(store.get('runs/run-1/artifacts/art-1')).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
  });

  it('reports a read-back mismatch instead of trusting the upload', async () => {
    const io: LocalFsIo = {
      write: () => undefined,
      read: () => Buffer.from('other bytes'),
      stat: () => ({ size: 11, mtimeMs: 1 }),
      remove: () => undefined,
    };
    const store = new LocalFsBlobStore({ rootDir: tempDir(), io });
    await expect(store.put('runs/run-1/artifacts/art-1', 'uploaded')).rejects.toMatchObject({ code: 'BLOB_SHA_MISMATCH' });
  });
});

describe('gcs backend with an injected client', () => {
  it('round-trips objects and returns generation from metadata', async () => {
    const fake = fakeBucket();
    const store = createBlobStore({ backend: 'gcs', bucket: fake.bucket });
    const key = 'runs/run-1/artifacts/art-1';
    const ref = await store.put(key, 'gcs bytes');
    expect(ref.sha256).toBe(sha256Hex('gcs bytes'));
    expect(Number(ref.generation)).toBeGreaterThan(1000);
    expect(await store.get(key)).toEqual(Buffer.from('gcs bytes'));
    expect(await store.head(key)).toEqual({ size: 9, generation: ref.generation });
    expect(fake.calls).toContain(`save:${key}`);
    expect(fake.calls).toContain(`getMetadata:${key}`);
  });

  it('maps 404 to BLOB_NOT_FOUND and keeps delete idempotent', async () => {
    const fake = fakeBucket();
    const store = createBlobStore({ backend: 'gcs', bucket: fake.bucket });
    await expect(store.get('runs/run-1/artifacts/missing')).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
    await expect(store.head('runs/run-1/artifacts/missing')).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
    await expect(store.delete?.('runs/run-1/artifacts/missing')).resolves.toBeUndefined();
  });

  it('fails the upload loudly when metadata cannot be read', async () => {
    const fake = fakeBucket();
    fake.fail.getMetadata = true;
    const store = createBlobStore({ backend: 'gcs', bucket: fake.bucket });
    await expect(store.put('runs/run-1/artifacts/art-1', 'x')).rejects.toMatchObject({ code: 'BLOB_UPLOAD_UNVERIFIED' });
  });

  it('propagates a failed save', async () => {
    const fake = fakeBucket();
    fake.fail.save = true;
    const store = createBlobStore({ backend: 'gcs', bucket: fake.bucket });
    await expect(store.put('runs/run-1/artifacts/art-1', 'x')).rejects.toThrow('save failed');
  });

  it('issues a generation-bound signed url for the object', async () => {
    const fake = fakeBucket();
    const store = createBlobStore({ backend: 'gcs', bucket: fake.bucket });
    const key = 'runs/run-1/artifacts/art-1';
    await store.put(key, 'share me');
    const link = await store.shareUrl?.(key, { expiresAt: new Date('2026-10-01T12:00:00.000Z') });
    expect(link?.url).toContain(key);
    expect(link?.url).toContain('expires=2026-10-01T12:00:00.000Z');
    expect(link?.expiresAt).toBe('2026-10-01T12:00:00.000Z');
  });

  it('bounds a hanging download with BLOB_TIMEOUT', async () => {
    const fake = fakeBucket();
    const store = createBlobStore({ backend: 'gcs', bucket: fake.bucket });
    const key = 'runs/run-1/artifacts/art-1';
    await store.put(key, 'slow bytes');
    const slow = createBlobStore({ backend: 'gcs', bucket: fake.bucket, deadlineMs: 25 });
    fake.fail.slowDownloadMs = 500;
    await expect(slow.get(key)).rejects.toMatchObject({ code: 'BLOB_TIMEOUT' });
  });

  it('never uses ADC when a bucket client is injected', async () => {
    const fake = fakeBucket();
    const store = createBlobStore({ env: { STORAGE_BACKEND: 'gcs' }, bucket: fake.bucket });
    expect(store.backend).toBe('gcs');
    await expect(store.put('runs/run-1/artifacts/art-1', 'x')).resolves.toMatchObject({ size: 1 });
  });
});

describe('r2/s3 scaffold', () => {
  it('declares the missing implementation instead of pretending', async () => {
    const store = createBlobStore({ env: { STORAGE_BACKEND: 'r2' } });
    expect(store.backend).toBe('r2');
    await expect(store.put('runs/run-1/artifacts/art-1', 'x')).rejects.toMatchObject({ code: 'BLOB_BACKEND_UNSUPPORTED' });
    await expect(store.get('runs/run-1/artifacts/art-1')).rejects.toMatchObject({ code: 'BLOB_BACKEND_UNSUPPORTED' });
    await expect(store.head('runs/run-1/artifacts/art-1')).rejects.toMatchObject({ code: 'BLOB_BACKEND_UNSUPPORTED' });
    await expect(store.shareUrl?.('runs/run-1/artifacts/art-1')).rejects.toMatchObject({ code: 'BLOB_BACKEND_UNSUPPORTED' });
    await expect(store.put('runs/run-1/artifacts/art-1', 'x')).rejects.toThrow(/multipart\/resume/);
  });
});
