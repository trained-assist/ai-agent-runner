import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, waitFor } from './helpers.js';
import { logMessages } from './isolation-helpers.js';
import { createBlobStore } from '../src/storage/create-blob-store.js';
import type { BlobCallOptions, BlobHead, BlobRef, BlobStore } from '../src/storage/blob-store.js';

/**
 * Уборка проверяется, а не предполагается (issue #52; найдено на песочной VM2).
 *
 * Workspace рана может оказаться недоступен Runner'у: каталоги принадлежат слоту, а ACL,
 * выданный прежней версией хоста, мог не дойти до поддерева. Раньше `rmSync` бросал EACCES
 * прямо из `recover()`, и воркер не стартовал вообще — нечитаемая уборка одного прошлого
 * рана делала недоступным чтение всех остальных: healthz не отвечал, control plane видел
 * Runner как недоступный. Теперь это «уборка не завершена» с причиной: слот остаётся
 * заблокированным, сервис поднимается и читает тот же Run.
 *
 * Сценарий повторяет живой: экспорт не подтверждён (object storage недоступен) → выход
 * остался единственной копией → после рестарта повторяется уборка; выход на диске уже
 * нет, а workspace Runner удалить не может.
 */
/** Вернуть права на всём дереве: тест закрывает каталоги намеренно. */
function makeRemovable(path: string): void {
  try {
    chmodSync(path, 0o700);
  } catch {
    /* пути может уже не быть */
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(path);
  } catch {
    return;
  }
  for (const entry of entries) makeRemovable(join(path, entry));
}

class UnavailableBlobStore implements BlobStore {
  readonly backend = 'local-fs' as const;
  constructor(private readonly inner: BlobStore) {}
  async put(_key: string, _bytes: Uint8Array | string, _options?: BlobCallOptions): Promise<BlobRef> {
    throw Object.assign(new Error('injected object storage outage'), { code: 'BLOB_BACKEND_MISCONFIGURED' });
  }
  async get(key: string, options?: BlobCallOptions): Promise<Buffer> {
    return this.inner.get(key, options);
  }
  async head(key: string, options?: BlobCallOptions): Promise<BlobHead> {
    return this.inner.head(key, options);
  }
  async delete(key: string): Promise<void> {
    return this.inner.delete!(key);
  }
}

describe('уборка workspace, который Runner не может удалить', () => {
  it('восстановление не падает: уборка pending с причиной, тот же Run читается', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'sweep-robustness-'));
    const inner = createBlobStore({ backend: 'local-fs', localRoot: join(rootDir, 'blobs') });
    const h = createHarness({ rootDir, artifactExport: true, blob: new UnavailableBlobStore(inner) });

    const { receipt, spec } = h.start({ outputs: [{ path: 'ran.txt' }] });
    await waitFor(() => h.runner.getRun(receipt.runId)?.result !== undefined);
    await waitFor(() => h.runner.getRun(receipt.runId)?.result?.cleanup === 'pending');

    // Выход, ради которого workspace удерживался, на диске уже нет (как на VM2), и сам
    // каталог удалить нельзя: вложенный каталог mode 000 недоступен и его владельцу.
    const local = join(spec.cwd, 'ran.txt');
    expect(existsSync(local)).toBe(true);
    unlinkSync(local);
    const locked = join(spec.cwd, 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'data.bin'), 'x');
    chmodSync(locked, 0o000);
    chmodSync(spec.cwd, 0o500);

    try {
      const reopened = h.reopenWithoutDispose();
      // Раньше здесь бросалось EACCES, и старт воркера падал целиком.
      const report = await reopened.recover();
      expect(report.scanned).toBeGreaterThan(0);

      await waitFor(() => reopened.getRun(receipt.runId)?.result?.cleanupReason !== undefined);
      const snapshot = reopened.getRun(receipt.runId);
      expect(snapshot?.runId).toBe(receipt.runId);
      expect(snapshot?.result?.cleanup).toBe('pending');
      expect(snapshot?.result?.cleanupReason ?? '').toMatch(/could not be removed/);

      // Причина видна в логе рана, а не теряется в исключении старта.
      expect(logMessages(h.rootDir, receipt.runId).some((line) => line.startsWith('clean_room.sweep_failed'))).toBe(true);
      // Ничего не удалено «наполовину успешно»: непроходимый каталог остался на месте.
      expect(existsSync(locked)).toBe(true);
      // Событие рана дочитывается после рестарта — тот же Run, без повторного движка.
      const events = readFileSync(join(h.rootDir, 'runs', receipt.runId, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string });
      expect(events.filter((event) => event.type === 'started')).toHaveLength(1);
    } finally {
      // Каталоги намеренно закрыты, поэтому перед удалением права возвращаются на всём
      // дереве: иначе уборка самого теста падает вместо проверки.
      makeRemovable(rootDir);
      rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
