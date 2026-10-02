import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex, type BlobCallOptions, type BlobHead, type BlobRef } from '../src/storage/blob-store.js';
import { isTerminalState } from '../src/runner/state-machine.js';
import { createHarness, sleep, waitFor } from './helpers.js';
import type { BlobStore } from '../src/storage/blob-store.js';
import { createBlobStore } from '../src/storage/create-blob-store.js';
import { ArtifactStore } from '../src/storage/artifact-store.js';
import { RunExportStore } from '../src/storage/export.js';

async function runToTerminal(harness: ReturnType<typeof createHarness>, over: Parameters<typeof harness.makeSpec>[0] = {}) {
  const { receipt } = harness.start(over);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snap = harness.runner.getRun(receipt.runId);
    if (snap && isTerminalState(snap.state)) return receipt.runId;
    await sleep(20);
  }
  throw new Error(`run ${receipt.runId} did not become terminal`);
}

function workspaceOf(harness: ReturnType<typeof createHarness>, runId: string): string {
  return join(harness.rootDir, 'ws', runId);
}

class FailingBlobStore implements BlobStore {
  readonly backend = 'local-fs' as const;
  private readonly inner: BlobStore;
  constructor(inner: BlobStore) {
    this.inner = inner;
  }
  async put(_key: string, _bytes: Uint8Array | string, options?: BlobCallOptions): Promise<BlobRef> {
    throw Object.assign(new Error('injected object storage outage'), { code: 'BLOB_BACKEND_MISCONFIGURED' });
  }
  async get(key: string, options?: BlobCallOptions): Promise<Buffer> { return this.inner.get(key, options); }
  async head(key: string, options?: BlobCallOptions): Promise<BlobHead> { return this.inner.head(key, options); }
  async delete(key: string, options?: BlobCallOptions): Promise<void> { return this.inner.delete!(key, options); }
}

describe('artifact export during finalization (P07 / AC-75, AC-76)', () => {
  it('экспортирует объявленные выходы в object storage и коммитит манифест с байтами, хэшем и mime', async () => {
    const harness = createHarness({ artifactExport: true });
    const runId = await runToTerminal(harness, {
      outputs: [{ path: 'ran.txt', name: 'ran.txt', mime: 'text/plain' }],
    });

    const manifest = harness.exports?.read(runId);
    expect(manifest).not.toBeNull();
    expect(manifest?.status).toBe('complete');
    expect(manifest?.partial).toBe(false);
    expect(manifest?.entries).toHaveLength(1);
    expect(manifest?.entries[0]).toMatchObject({
      sourcePath: 'ran.txt',
      status: 'exported',
      size: 2,
      sha256: sha256Hex('ok'),
      localCopyRetained: false,
    });
    expect(manifest?.cleanup.decision).toBe('pruned');
    expect(manifest?.totals).toMatchObject({ planned: 1, exported: 1, failed: 0, bytes: 2 });

    const snapshot = harness.runner.getRun(runId);
    expect(snapshot?.export).toMatchObject({ status: 'complete', planned: 1, exported: 1, failed: 0, cleanup: 'pruned' });
    expect(snapshot?.result?.outputRefs).toEqual([manifest?.entries[0]?.artifactId]);
    expect(snapshot?.result?.cleanup).toBe('completed');

    // локальная копия удалена только после подтверждённого сохранения
    expect(existsSync(join(workspaceOf(harness, runId), 'ran.txt'))).toBe(false);

    // артефакт читается обратно с теми же байтами
    const artifactId = manifest?.entries[0]?.artifactId;
    if (!artifactId) throw new Error('artifactId missing');
    const read = await harness.exports?.artifacts.read(runId, artifactId);
    expect(read?.bytes.toString('utf8')).toBe('ok');
    expect(read?.manifest.sha256).toBe(sha256Hex('ok'));
  });

  it('сбой object storage не удаляет единственную копию и объявляет partial манифест', async () => {
    const rootDir = join('/tmp', `ai-agent-runner-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(rootDir, { recursive: true });
    const inner = createBlobStore({ backend: 'local-fs', localRoot: join(rootDir, 'blobs') });
    const failing = new FailingBlobStore(inner);
    const harness = createHarness({ artifactExport: true, blob: failing, pruneLocalCopies: true });

    try {
      const runId = await runToTerminal(harness, {
        outputs: [{ path: 'ran.txt' }],
      });

      const manifest = harness.exports?.read(runId);
      expect(manifest?.status).toBe('failed');
      expect(manifest?.partial).toBe(true);
      expect(manifest?.entries[0]).toMatchObject({ status: 'failed', localCopyRetained: true });
      expect(manifest?.cleanup.decision).toBe('retained_sole_copy');
      expect(manifest?.cleanup.retained).toEqual(['ran.txt']);

      // единственная копия осталась на диске
      const local = join(workspaceOf(harness, runId), 'ran.txt');
      expect(existsSync(local)).toBe(true);
      expect(readFileSync(local, 'utf8')).toBe('ok');

      const snapshot = harness.runner.getRun(runId);
      expect(snapshot?.result?.cleanup).toBe('pending');
      expect(snapshot?.result?.outputRefs).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('краш воркера в финализации не запускает движок заново и не теряет экспорт', async () => {
    const harness = createHarness({ artifactExport: true });
    const { receipt } = harness.start({ outputs: [{ path: 'ran.txt' }] });
    await waitFor(() => harness.runner.getRun(receipt.runId)?.state === 'finalizing');

    // краш воркера посередине финализации: движок уже завершён, экспорт ещё не завершён
    harness.reopen();
    await harness.runner.recover();
    const runId = receipt.runId;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const snap = harness.runner.getRun(runId);
      if (snap && isTerminalState(snap.state)) break;
      await sleep(20);
    }

    expect(harness.fake.startCalls).toBe(1);
    const manifest = harness.exports?.read(runId);
    expect(manifest?.status).toBe('complete');
    expect(manifest?.entries[0]).toMatchObject({ status: 'exported', localCopyRetained: false });
    expect(manifest?.attempts).toBeGreaterThanOrEqual(1);
  });

  it('повторный commit экспорта не запускает движок и не перезаписывает закоммиченную версию', async () => {
    const harness = createHarness({ artifactExport: true });
    const runId = await runToTerminal(harness, { outputs: [{ path: 'ran.txt' }] });
    const first = harness.exports?.read(runId);
    expect(first?.status).toBe('complete');
    const versionBefore = first?.version;

    const recommit = await harness.runner.recommitExport(runId);
    // каждый recommit создаёт in_progress + committed версии: +2 к версии
    expect(recommit?.version).toBe((versionBefore ?? 0) + 2);
    // attempts растёт на 1 (begin инкрементирует attempts, commit не)
    expect(recommit?.attempts).toBe((first?.attempts ?? 0) + 1);
    expect(harness.fake.startCalls).toBe(1);

    // закоммиченная версия не переписана
    const immutable = harness.exports?.readVersion(runId, versionBefore ?? 0);
    expect(immutable?.status).toBe('complete');
    expect(immutable?.version).toBe(versionBefore);
    expect(harness.exports?.versions(runId)).toContain(versionBefore ?? 0);
  });

  it('управляемый сбой в точке export оставляет ран в finalizing и повторяем без движка', async () => {
    const harness = createHarness({ artifactExport: true });
    harness.faults.inject('export', { kind: 'throw', once: true });
    const { receipt } = harness.start({ outputs: [{ path: 'ran.txt' }] });

    await waitFor(() => {
      const snap = harness.runner.getRun(receipt.runId);
      return snap !== null && snap.state === 'finalizing';
    });
    // движок уже завершён, но ран не терминален: сбой экспорта не роняет ран молча
    const stuck = harness.runner.getRun(receipt.runId);
    expect(stuck?.state).toBe('finalizing');
    expect(stuck?.finalized).toBe(false);
    expect(harness.fake.startCalls).toBe(1);

    // повторная финализация доводит экспорт до конца без второго запуска движка
    const result = await harness.runner.finalize(receipt.runId);
    expect(result.outcome).toBe('succeeded');
    expect(harness.fake.startCalls).toBe(1);
    const manifest = harness.exports?.read(receipt.runId);
    expect(manifest?.status).toBe('complete');
    expect(manifest?.entries[0]).toMatchObject({ status: 'exported' });
  });

  it('объявленный выход, которого движок не создал, объявлен как missing, а не как успех', async () => {
    const harness = createHarness({ artifactExport: true });
    const runId = await runToTerminal(harness, { outputs: [{ path: 'absent.txt' }] });
    const manifest = harness.exports?.read(runId);
    expect(manifest?.status).toBe('failed');
    expect(manifest?.partial).toBe(true);
    expect(manifest?.entries[0]).toMatchObject({ status: 'missing', localCopyRetained: true });
    expect(manifest?.cleanup.decision).toBe('retained_sole_copy');
  });

  it('путь выхода за пределы workspace отвергается на этапе валидации спецификации', async () => {
    const harness = createHarness({ artifactExport: true });
    expect(() => harness.makeSpec({ outputs: [{ path: '../escape.txt' }] })).toThrow(/relative path inside the run workspace/);
  });

  it('без объявленных выходов экспорт не открывается и не мешает финализации', async () => {
    const harness = createHarness({ artifactExport: true });
    const runId = await runToTerminal(harness);
    expect(harness.exports?.read(runId)).toBeNull();
    expect(harness.runner.getRun(runId)?.export).toBeNull();
    expect(harness.runner.getRun(runId)?.result?.cleanup).toBe('completed');
  });
});