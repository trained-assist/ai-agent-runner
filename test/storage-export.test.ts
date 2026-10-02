import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../src/storage/artifact-store.js';
import type { BlobHead, BlobRef, BlobStore } from '../src/storage/blob-store.js';
import { sha256Hex } from '../src/storage/blob-store.js';
import { RunExportStore } from '../src/storage/export.js';
import { validateRunExportManifest } from '../src/storage/export-manifest.js';
import { createLocalFsBlobStore } from '../src/storage/local-fs.js';

interface MemoryBlob extends BlobStore {
  backend: 'local-fs';
  objects: Map<string, Buffer>;
  failPutFor: Set<string>;
  puts: string[];
}

function memoryBlob(): MemoryBlob {
  const objects = new Map<string, Buffer>();
  const store: MemoryBlob = {
    backend: 'local-fs',
    objects,
    failPutFor: new Set<string>(),
    puts: [],
    async put(key, bytes) {
      store.puts.push(key);
      if (store.failPutFor.has(key)) {
        throw Object.assign(new Error('injected object storage outage'), { code: 'BLOB_BACKEND_MISCONFIGURED' });
      }
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array | string);
      objects.set(key, Buffer.from(buf));
      const ref: BlobRef = { sha256: sha256Hex(buf), size: buf.length, generation: 'gen-1' };
      return ref;
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
  const dir = mkdtempSync(join(tmpdir(), 'run-export-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const clock = { current: '2026-10-02T10:00:00.000Z' };
const now = () => new Date(clock.current);

function workspace(rootDir: string, runId: string): string {
  const dir = join(rootDir, 'workspaces', runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeOutput(rootDir: string, runId: string, relPath: string, content: string): string {
  const target = join(workspace(rootDir, runId), ...relPath.split('/'));
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function makeStore(rootDir: string, blob: BlobStore): RunExportStore {
  return new RunExportStore({ rootDir, artifacts: new ArtifactStore({ rootDir, blob, now }), now });
}

const CTX = { runId: 'run-1', userTaskId: 'task-1', profileId: 'profile-a', ownerGeneration: 1 };

describe('run export manifest schema', () => {
  it('requires an explicit partial flag consistent with the status', () => {
    const base = {
      schemaVersion: 1,
      runId: 'run-1',
      userTaskId: 'task-1',
      profileId: 'profile-a',
      ownerGeneration: 1,
      version: 2,
      attempts: 1,
      status: 'complete',
      partial: false,
      createdByRun: 'run-1',
      entries: [],
      totals: { planned: 0, exported: 0, failed: 0, bytes: 0 },
      cleanup: { decision: 'nothing_to_prune', reason: 'no local copy was removed', retained: [] },
      startedAt: '2026-10-02T10:00:00.000Z',
      updatedAt: '2026-10-02T10:00:00.000Z',
      committedAt: '2026-10-02T10:00:00.000Z',
    };
    expect(validateRunExportManifest(base).ok).toBe(true);
    expect(validateRunExportManifest({ ...base, status: 'complete', partial: true }).ok).toBe(false);
    expect(validateRunExportManifest({ ...base, status: 'partial', partial: false }).ok).toBe(false);
    expect(validateRunExportManifest({ ...base, status: 'in_progress', committedAt: null }).ok).toBe(true);
    expect(validateRunExportManifest({ ...base, status: 'in_progress' }).ok).toBe(false);
    expect(validateRunExportManifest({ ...base, version: 0 }).ok).toBe(false);
    expect(validateRunExportManifest({ ...base, entries: [{ sourcePath: 'a', name: 'a', mime: 'text/plain', size: 0, sha256: null, artifactId: null, status: 'exported', reason: null, localCopyRetained: false }] }).ok).toBe(false);
    expect(validateRunExportManifest({ ...base, secret: 'x' }).ok).toBe(false);
  });
});

describe('run export store', () => {
  it('moves local files into object storage and commits a manifest with bytes, hash and mime', async () => {
    const rootDir = root();
    const blob = memoryBlob();
    const exports = makeStore(rootDir, blob);
    writeOutput(rootDir, 'run-1', 'report.txt', 'hello artifact');
    writeOutput(rootDir, 'run-1', 'pages/index.html', '<h1>hi</h1>');

    exports.begin(CTX, [{ path: 'report.txt' }, { path: 'pages/index.html' }]);
    for (const relPath of ['report.txt', 'pages/index.html']) {
      const bytes = readFileSync(join(workspace(rootDir, 'run-1'), ...relPath.split('/')));
      const manifest = await exports.artifacts.put({
        runId: 'run-1',
        userTaskId: 'task-1',
        profileId: 'profile-a',
        name: relPath.split('/').pop() as string,
        mime: 'text/plain',
        bytes,
      });
      exports.recordExported(CTX, relPath, manifest);
    }
    const committed = await exports.commit(CTX, { cwd: workspace(rootDir, 'run-1') });

    expect(committed.status).toBe('complete');
    expect(committed.partial).toBe(false);
    expect(committed.version).toBe(2);
    expect(committed.totals).toMatchObject({ planned: 2, exported: 2, failed: 0, bytes: 25 });
    expect(committed.entries.map((entry) => entry.sourcePath)).toEqual(['report.txt', 'pages/index.html']);
    expect(committed.entries[0]).toMatchObject({ artifactId: expect.stringMatching(/^art-/), size: 14, sha256: sha256Hex('hello artifact') });
    expect(committed.cleanup.decision).toBe('pruned');
    expect(committed.cleanup.retained).toEqual([]);
    expect(committed.committedAt).toBe('2026-10-02T10:00:00.000Z');

    // обе копии удалены только после подтверждённого чтения из object storage
    expect(existsSync(join(workspace(rootDir, 'run-1'), 'report.txt'))).toBe(false);
    expect(existsSync(join(workspace(rootDir, 'run-1'), 'pages', 'index.html'))).toBe(false);

    const artifacts = exports.artifacts.list('run-1');
    expect(artifacts.map((a) => a.name).sort()).toEqual(['index.html', 'report.txt']);
    expect(await exports.artifacts.read('run-1', artifacts[0]!.artifactId)).toBeTruthy();
  });

  it('keeps committed versions immutable and points latest at the newest one', async () => {
    const rootDir = root();
    const exports = makeStore(rootDir, memoryBlob());
    writeOutput(rootDir, 'run-1', 'a.txt', 'first');

    exports.begin(CTX, [{ path: 'a.txt' }]);
    const manifest = await exports.artifacts.put({
      runId: 'run-1',
      userTaskId: 'task-1',
      profileId: 'profile-a',
      name: 'a.txt',
      mime: 'text/plain',
      bytes: 'first',
    });
    exports.recordExported(CTX, 'a.txt', manifest);
    const first = await exports.commit(CTX, { cwd: workspace(rootDir, 'run-1') });

    expect(exports.versions('run-1')).toEqual([1, 2]);
    expect(exports.read('run-1')?.version).toBe(2);
    expect(readFileSync(exports.versionPath('run-1', 2), 'utf8')).toBe(`${JSON.stringify(first, null, 2)}\n`);

    // повторный commit второй попытки не переписывает v2, а добавляет v3/v4
    exports.begin(CTX, [{ path: 'a.txt' }]);
    const second = await exports.commit(CTX, { cwd: workspace(rootDir, 'run-1') });
    expect(second.version).toBe(4);
    expect(second.attempts).toBe(2);
    expect(readFileSync(exports.versionPath('run-1', 2), 'utf8')).toBe(`${JSON.stringify(first, null, 2)}\n`);
    expect(exports.read('run-1')?.version).toBe(4);

    // третий раз уже не коммитится: draft закрыт
    expect(exports.read('run-1')?.status).toBe('complete');
  });

  it('declares a partial manifest and retains the sole copy when object storage fails', async () => {
    const rootDir = root();
    const blob = memoryBlob();
    blob.failPutFor.add('runs/run-1/artifacts/art-does-not-matter');
    const exports = makeStore(rootDir, blob);
    const heavyPath = writeOutput(rootDir, 'run-1', 'big.bin', Buffer.alloc(4096, 7).toString('binary'));

    exports.begin(CTX, [{ path: 'big.bin' }]);
    blob.failPutFor.add('runs/run-1/artifacts/art-later');
    // любая запись в blob.store падает — эмулируем отказ object storage на тяжёлом файле
    const original = blob.put.bind(blob);
    blob.put = async (key, bytes, options) => {
      throw Object.assign(new Error(`object storage refused ${key}`), { code: 'BLOB_BACKEND_MISCONFIGURED' });
    };
    try {
      await expect(
        exports.artifacts.put({
          runId: 'run-1',
          userTaskId: 'task-1',
          profileId: 'profile-a',
          name: 'big.bin',
          mime: 'application/octet-stream',
          bytes: readFileSync(heavyPath),
        }),
      ).rejects.toThrow(/refused/);
      exports.recordFailure(CTX, 'big.bin', 'StorageError: object storage refused runs/run-1/artifacts/art-x');
    } finally {
      blob.put = original;
    }

    const committed = await exports.commit(CTX, { cwd: workspace(rootDir, 'run-1') });
    expect(committed.status).toBe('failed');
    expect(committed.partial).toBe(true);
    expect(committed.totals).toMatchObject({ planned: 1, exported: 0, failed: 1 });
    expect(committed.entries[0]).toMatchObject({ status: 'failed', localCopyRetained: true, reason: expect.stringContaining('refused') });
    expect(committed.cleanup.decision).toBe('retained_sole_copy');
    expect(committed.cleanup.retained).toEqual(['big.bin']);
    // единственная копия осталась на диске: очистка не удалила её при сбое export
    expect(existsSync(heavyPath)).toBe(true);
    expect(readFileSync(heavyPath).length).toBe(4096);
  });

  it('marks a declared output that the engine never produced as missing, not silently ok', async () => {
    const rootDir = root();
    const exports = makeStore(rootDir, memoryBlob());
    exports.begin(CTX, [{ path: 'never-written.txt' }]);
    exports.recordMissing(CTX, 'never-written.txt', 'declared output is not a regular file in the workspace');
    const committed = await exports.commit(CTX, { cwd: workspace(rootDir, 'run-1') });

    expect(committed.status).toBe('failed');
    expect(committed.partial).toBe(true);
    expect(committed.entries[0]).toMatchObject({ status: 'missing', localCopyRetained: true });
  });

  it('rejects a workspace path that escapes the run root, including through a symlink', () => {
    const rootDir = root();
    const exports = makeStore(rootDir, memoryBlob());
    workspace(rootDir, 'run-1');
    const outside = join(rootDir, 'secret.txt');
    writeFileSync(outside, 'not yours');
    symlinkSync(outside, join(workspace(rootDir, 'run-1'), 'leak.txt'));

    expect(() => exports.workspaceFile(workspace(rootDir, 'run-1'), '../secret.txt')).toThrow(/expected a relative path inside the run workspace/);
    expect(() => exports.workspaceFile(workspace(rootDir, 'run-1'), '/etc/passwd')).toThrow(/relative path/);
    expect(() => exports.workspaceFile(workspace(rootDir, 'run-1'), 'nested/../../secret.txt')).toThrow(/relative path/);
    expect(() => exports.workspaceFile(workspace(rootDir, 'run-1'), './a.txt')).toThrow(/relative path/);
    expect(() => exports.workspaceFile(workspace(rootDir, 'run-1'), 'leak.txt')).toThrow(/through a link/);
  });

  it('carries progress across a restart and refuses to declare an undeclared output', async () => {
    const rootDir = root();
    const blob = memoryBlob();
    const first = makeStore(rootDir, blob);
    writeOutput(rootDir, 'run-1', 'a.txt', 'aaa');
    writeOutput(rootDir, 'run-1', 'b.txt', 'bbb');

    first.begin(CTX, [{ path: 'a.txt' }, { path: 'b.txt' }]);
    const a = await first.artifacts.put({ runId: 'run-1', userTaskId: 'task-1', profileId: 'profile-a', name: 'a.txt', mime: 'text/plain', bytes: 'aaa' });
    first.recordExported(CTX, 'a.txt', a);
    // воркер упал до второго файла

    const reopened = makeStore(rootDir, blob);
    const carried = reopened.begin(CTX, [{ path: 'a.txt' }, { path: 'b.txt' }]);
    expect(carried.attempts).toBe(2);
    expect(carried.entries.find((entry) => entry.sourcePath === 'a.txt')).toMatchObject({ status: 'exported', artifactId: a.artifactId });
    expect(carried.entries.find((entry) => entry.sourcePath === 'b.txt')).toMatchObject({ status: 'missing' });
    expect(() => reopened.recordMissing(CTX, 'undeclared.txt', 'x')).toThrow(/not declared in the export plan/);
    await expect(reopened.commit(CTX)).resolves.toMatchObject({ status: 'partial', version: 3 });
    // повторный commit того же черновика отвергается: версия закрыта
    await expect(reopened.commit(CTX)).rejects.toThrow(/already committed/);
  });

  it('keeps the local copy when pruning is switched off and says so in the cleanup decision', async () => {
    const rootDir = root();
    const blob = memoryBlob();
    const exports = new RunExportStore({ rootDir, artifacts: new ArtifactStore({ rootDir, blob, now }), now, pruneLocalCopies: false });
    const path = writeOutput(rootDir, 'run-1', 'keep.txt', 'keep me');

    exports.begin(CTX, [{ path: 'keep.txt' }]);
    const manifest = await exports.artifacts.put({ runId: 'run-1', userTaskId: 'task-1', profileId: 'profile-a', name: 'keep.txt', mime: 'text/plain', bytes: 'keep me' });
    exports.recordExported(CTX, 'keep.txt', manifest);
    const committed = await exports.commit(CTX, { cwd: workspace(rootDir, 'run-1') });

    expect(existsSync(path)).toBe(true);
    expect(committed.entries[0]?.localCopyRetained).toBe(true);
    expect(committed.cleanup.decision).toBe('retained_sole_copy');
    expect(committed.cleanup.retained).toContain('keep.txt');
  });

  it('works end to end on the real local-fs backend', async () => {
    const rootDir = root();
    const blob = createLocalFsBlobStore({ rootDir: join(rootDir, 'blobs') });
    const exports = makeStore(rootDir, blob);
    const path = writeOutput(rootDir, 'run-1', 'source.js', 'console.log(1)');

    exports.begin(CTX, [{ path: 'source.js' }]);
    const manifest = await exports.artifacts.put({ runId: 'run-1', userTaskId: 'task-1', profileId: 'profile-a', name: 'source.js', mime: 'application/javascript', bytes: readFileSync(path) });
    exports.recordExported(CTX, 'source.js', manifest);
    const committed = await exports.commit(CTX, { cwd: workspace(rootDir, 'run-1') });

    expect(committed.status).toBe('complete');
    expect(committed.entries[0]?.mime).toBe('application/javascript');
    expect(committed.entries[0]?.sha256).toBe(sha256Hex('console.log(1)'));
    expect(existsSync(join(rootDir, 'blobs', 'runs', 'run-1', 'artifacts', `${manifest.artifactId}`))).toBe(true);
    const readBack = await exports.artifacts.read('run-1', manifest.artifactId);
    expect(readBack.bytes.toString('utf8')).toBe('console.log(1)');
  });
});