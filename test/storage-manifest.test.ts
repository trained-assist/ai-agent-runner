import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobHead, BlobRef, BlobStore } from '../src/storage/blob-store.js';
import { sha256Hex } from '../src/storage/blob-store.js';
import { ArtifactStore } from '../src/storage/artifact-store.js';
import { validateArtifactManifest } from '../src/storage/manifest.js';
import { createLocalFsBlobStore } from '../src/storage/local-fs.js';

interface MemoryBlob extends BlobStore {
  backend: 'local-fs';
  objects: Map<string, Buffer>;
  lieSha: boolean;
  put(key: string, bytes: Uint8Array | string): Promise<BlobRef>;
}

function memoryBlob(): MemoryBlob {
  const objects = new Map<string, Buffer>();
  const store: MemoryBlob = {
    backend: 'local-fs',
    objects,
    lieSha: false,
    async put(key, bytes) {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array | string);
      objects.set(key, Buffer.from(buf));
      return { sha256: store.lieSha ? 'f'.repeat(64) : sha256Hex(buf), size: buf.length, generation: 'gen-1' };
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) throw Object.assign(new Error('missing'), { code: 404 });
      return Buffer.from(object);
    },
    async head(key): Promise<BlobHead> {
      const object = objects.get(key);
      if (!object) throw Object.assign(new Error('missing'), { code: 404 });
      return { size: object.length, generation: 'gen-1' };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  return store;
}

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'storage-manifest-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const clock = { current: '2026-10-01T10:00:00.000Z' };
const now = () => new Date(clock.current);

function putInput(over: Partial<Parameters<ArtifactStore['put']>[0]> = {}): Parameters<ArtifactStore['put']>[0] {
  return {
    runId: 'run-1',
    userTaskId: 'task-1',
    profileId: 'profile-a',
    name: 'report.txt',
    mime: 'text/plain',
    bytes: 'hello artifact',
    ...over,
  };
}

describe('artifact manifest schema', () => {
  it('accepts the documented field set', () => {
    const result = validateArtifactManifest({
      artifactId: 'art-1',
      runId: 'run-1',
      userTaskId: 'task-1',
      profileId: 'profile-a',
      name: 'report.txt',
      mime: 'text/plain',
      size: 15,
      sha256: sha256Hex('hello artifact'),
      storageKey: 'runs/run-1/artifacts/art-1',
      createdAt: '2026-10-01T10:00:00.000Z',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects share urls, tokens and any unknown field', () => {
    const base = {
      artifactId: 'art-1',
      runId: 'run-1',
      userTaskId: 'task-1',
      profileId: 'profile-a',
      name: 'report.txt',
      mime: 'text/plain',
      size: 15,
      sha256: sha256Hex('hello artifact'),
      storageKey: 'runs/run-1/artifacts/art-1',
      createdAt: '2026-10-01T10:00:00.000Z',
    };
    for (const extra of [{ url: 'https://storage.example/obj?X-Goog-Signature=abc' }, { token: 't.deadbeef' }, { downloadUrl: '/x' }]) {
      const result = validateArtifactManifest({ ...base, ...extra });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(' ')).toContain('unknown field');
    }
  });

  it('rejects digests, mime, names and keys that break the contract', () => {
    const base = {
      artifactId: 'art-1',
      runId: 'run-1',
      userTaskId: 'task-1',
      profileId: 'profile-a',
      name: 'report.txt',
      mime: 'text/plain',
      size: 15,
      sha256: sha256Hex('hello artifact'),
      storageKey: 'runs/run-1/artifacts/art-1',
      createdAt: '2026-10-01T10:00:00.000Z',
    };
    expect(validateArtifactManifest({ ...base, sha256: 'nope' }).ok).toBe(false);
    expect(validateArtifactManifest({ ...base, mime: 'text' }).ok).toBe(false);
    expect(validateArtifactManifest({ ...base, name: '../report.txt' }).ok).toBe(false);
    expect(validateArtifactManifest({ ...base, size: -1 }).ok).toBe(false);
    expect(validateArtifactManifest({ ...base, storageKey: 'runs/other/artifacts/art-1' }).ok).toBe(false);
    expect(validateArtifactManifest({ ...base, createdAt: 'yesterday' }).ok).toBe(false);
  });
});

describe('artifact store', () => {
  it('commits a manifest next to the run and round-trips it through a new instance', async () => {
    const rootDir = root();
    const blob = memoryBlob();
    const store = new ArtifactStore({ rootDir, blob, now });
    const manifest = await store.put(putInput({ artifactId: 'art-1' }));

    expect(manifest).toMatchObject({
      artifactId: 'art-1',
      runId: 'run-1',
      storageKey: 'runs/run-1/artifacts/art-1',
      sha256: sha256Hex('hello artifact'),
      size: 14,
      createdAt: '2026-10-01T10:00:00.000Z',
    });

    const path = join(rootDir, 'runs', 'run-1', 'artifacts', 'art-1.json');
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(onDisk['url']).toBeUndefined();
    expect(JSON.stringify(onDisk)).not.toContain('https://');

    const reopened = new ArtifactStore({ rootDir, blob, now });
    expect(reopened.list('run-1')).toEqual([manifest]);
    expect(reopened.getManifest('run-1', 'art-1')).toEqual(manifest);
    expect(reopened.find('art-1')).toEqual({ runId: 'run-1', manifest });
    expect(reopened.list('run-2')).toEqual([]);
    expect(reopened.find('art-missing')).toBeNull();
  });

  it('is idempotent for the same bytes and refuses a conflicting rewrite', async () => {
    const blob = memoryBlob();
    const store = new ArtifactStore({ rootDir: root(), blob, now });
    const first = await store.put(putInput({ artifactId: 'art-1' }));
    clock.current = '2026-10-02T10:00:00.000Z';
    const again = await store.put(putInput({ artifactId: 'art-1' }));
    expect(again).toEqual(first);
    await expect(store.put(putInput({ artifactId: 'art-1', bytes: 'other bytes' }))).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' });
    clock.current = '2026-10-01T10:00:00.000Z';
  });

  it('refuses a backend that reports a digest of bytes it did not store', async () => {
    const blob = memoryBlob();
    blob.lieSha = true;
    const store = new ArtifactStore({ rootDir: root(), blob, now });
    await expect(store.put(putInput({ artifactId: 'art-1' }))).rejects.toMatchObject({ code: 'BLOB_SHA_MISMATCH' });
    expect(store.list('run-1')).toEqual([]);
  });

  it('verifies stored bytes against the manifest on read', async () => {
    const blob = memoryBlob();
    const store = new ArtifactStore({ rootDir: root(), blob, now });
    const manifest = await store.put(putInput({ artifactId: 'art-1' }));

    const read = await store.read('run-1', 'art-1');
    expect(read.bytes).toEqual(Buffer.from('hello artifact'));
    expect(read.manifest).toEqual(manifest);

    blob.objects.set(manifest.storageKey, Buffer.from('tampered bytes'));
    await expect(store.read('run-1', 'art-1')).rejects.toMatchObject({ code: 'BLOB_SHA_MISMATCH' });
    await expect(store.read('run-1', 'art-missing')).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
  });

  it('commits without rewriting anything and reports loss instead of guessing', async () => {
    const blob = memoryBlob();
    const store = new ArtifactStore({ rootDir: root(), blob, now });
    const manifest = await store.put(putInput({ artifactId: 'art-1' }));

    expect(await store.commit('run-1', 'art-1')).toMatchObject({ status: 'verified' });

    blob.objects.delete(manifest.storageKey);
    expect(await store.commit('run-1', 'art-1')).toMatchObject({ status: 'missing' });
    await expect(store.commit('run-1', 'art-missing')).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });

    await store.put(putInput({ artifactId: 'art-1' }));
    blob.objects.set(manifest.storageKey, Buffer.from('tampered bytes'));
    expect(await store.commit('run-1', 'art-1')).toMatchObject({ status: 'corrupt' });

    blob.objects.set(manifest.storageKey, Buffer.from('short'));
    expect(await store.commit('run-1', 'art-1')).toMatchObject({ status: 'size_mismatch' });
  });

  it('exports a receipt with shallow and deep verification', async () => {
    const blob = memoryBlob();
    const store = new ArtifactStore({ rootDir: root(), blob, now });
    const kept = await store.put(putInput({ artifactId: 'art-1' }));
    await store.put(putInput({ artifactId: 'art-2', name: 'second.bin', mime: 'application/octet-stream', bytes: 'second' }));
    blob.objects.delete('runs/run-1/artifacts/art-2');

    const shallow = await store.export('run-1');
    expect(shallow).toMatchObject({ backend: 'local-fs', ok: 1, failed: 1, exportedAt: '2026-10-01T10:00:00.000Z' });
    expect(shallow.artifacts.find((item) => item.artifactId === 'art-1')?.status).toBe('present');
    expect(shallow.artifacts.find((item) => item.artifactId === 'art-2')?.status).toBe('missing');

    const deep = await store.export('run-1', { deep: true });
    expect(deep.artifacts.find((item) => item.artifactId === kept.artifactId)?.status).toBe('verified');
    expect(deep.failed).toBe(1);
    expect(await store.export('run-2')).toMatchObject({ ok: 0, failed: 0, artifacts: [] });
  });

  it('surfaces a corrupt manifest instead of dropping it silently', async () => {
    const rootDir = root();
    const blob = memoryBlob();
    const store = new ArtifactStore({ rootDir, blob, now });
    await store.put(putInput({ artifactId: 'art-1' }));
    writeFileSync(join(rootDir, 'runs', 'run-1', 'artifacts', 'art-1.json'), '{ torn');
    try {
      store.list('run-1');
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('ARTIFACT_MANIFEST_INVALID');
    }
  });

  it('works on the real local-fs backend', async () => {
    const rootDir = root();
    const blob = createLocalFsBlobStore({ rootDir: join(rootDir, 'blobs') });
    const store = new ArtifactStore({ rootDir, blob, now });
    const manifest = await store.put(putInput({ artifactId: 'art-1' }));
    const read = await store.read('run-1', 'art-1');
    expect(read.bytes).toEqual(Buffer.from('hello artifact'));
    expect(await store.commit('run-1', 'art-1')).toMatchObject({ status: 'verified' });
    expect(manifest.storageKey).toBe('runs/run-1/artifacts/art-1');
  });
});
