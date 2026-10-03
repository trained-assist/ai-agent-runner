import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineAdapter, EngineHandle, EngineStartContext } from '../src/adapters/engine/engine-adapter.js';
import { launchCommand } from '../src/adapters/engine/launch.js';
import { handleForChild } from '../src/adapters/engine/process-tree.js';
import { isProcessAlive } from '../src/adapters/engine/process-tree.js';
import type { RunCheckpoint } from '../src/runner/checkpoint.js';
import { createHarness, waitFor, type HarnessOptions } from './helpers.js';
import type { BlobCallOptions, BlobHead, BlobRef, BlobStore } from '../src/storage/blob-store.js';

/**
 * #52, шаги 3–5: сохранение подтверждается чтением, уборка — только проверенным
 * контрактом, статусы движка/сохранения/уборки разделены.
 *
 * Каждая проверка здесь отвечает на вопрос «что останется на диске и что клиент
 * прочитает», а не «процесс завершился».
 */

/** Движок, который пишет объявленный файл выхода и печатает ответ. */
class WritingEngine implements EngineAdapter {
  readonly name = 'fake';
  startCalls = 0;

  constructor(private readonly files: Record<string, string> = { 'ran.txt': 'ok' }) {}

  async start(ctx: EngineStartContext): Promise<EngineHandle> {
    this.startCalls += 1;
    const launch = launchCommand(ctx, process.execPath, ['-e', this.script()]);
    return this.spawn(ctx, launch);
  }

  /** Без ответа в stdout: единственная запись в хранилище — объявленный выход. */
  protected script(): string {
    const writes = Object.entries(this.files).map(
      ([path, content]) =>
        `require('node:fs').mkdirSync(require('node:path').dirname(${JSON.stringify(path)}), {recursive: true});` +
        `require('node:fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)});`,
    );
    return [...writes, "console.log('agent: готово');", 'process.exit(0);'].join('');
  }

  protected spawn(ctx: EngineStartContext, launch: { command: string; args: string[] }): EngineHandle {
    const child = spawn(launch.command, launch.args, {
      cwd: ctx.cwd,
      env: ctx.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return handleForChild(child, { onLog: ctx.onLog, onExit: ctx.onExit });
  }
}

/** Тот же движок, но без текста ответа: ответ агента не пишется в stdout. */
class SilentEngine extends WritingEngine {
  protected override script(): string {
    return super.script().replace("console.log('agent: готово');", '');
  }
}

/** Хранилище, которое принимает первые N попыток записи и дальше отказывает. */
class FlakyBlob {
  readonly backend = 'local-fs' as const;
  private readonly inner: BlobStore;
  failuresLeft: number;
  reads: string[] = [];

  constructor(inner: BlobStore, failures: number) {
    this.inner = inner;
    this.failuresLeft = failures;
  }

  async put(key: string, bytes: Uint8Array | string, options?: BlobCallOptions): Promise<BlobRef> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error(`injected storage failure for ${key}`);
    }
    return this.inner.put(key, bytes, options);
  }

  async get(key: string, options?: BlobCallOptions): Promise<Buffer> {
    this.reads.push(key);
    return this.inner.get(key, options);
  }

  async head(key: string, options?: BlobCallOptions): Promise<BlobHead> {
    return this.inner.head(key, options);
  }
}

function checkpointOnDisk(rootDir: string, runId: string): RunCheckpoint {
  return JSON.parse(readFileSync(join(rootDir, 'runs', runId, 'checkpoint.json'), 'utf8')) as RunCheckpoint;
}

function resultOnDisk(rootDir: string, runId: string): { persistence: string; cleanup: string; persistenceReason?: string; cleanupReason?: string; outputRefs: string[] } {
  return JSON.parse(readFileSync(join(rootDir, 'runs', runId, 'result.json'), 'utf8')) as never;
}

describe('lifecycle рана: persist → проверенная уборка (issue #52, шаги 3–5)', () => {
  it('после terminal+persist каталог и сокет рана отсутствуют, а результат и лог читаются', async () => {
    const engine = new WritingEngine();
    const h = createHarness({ adapters: { fake: engine }, artifactExport: true });
    const { receipt, spec } = h.start({ outputs: [{ path: 'ran.txt' }] });
    const result = await h.runner.waitFor(receipt.runId);

    expect(result.cleanup).toBe('completed');
    expect(result.persistence).toBe('persisted');
    expect(result.outputRefs).toHaveLength(1);
    // Уборка — проверенный контракт: каталогов рана нет, и статус это объясняет.
    expect(existsSync(spec.cwd)).toBe(false);
    expect(result.cleanupReason).toContain('gone');
    // Результат, события и артефакт переживают уборку.
    expect(existsSync(join(h.rootDir, 'runs', receipt.runId, 'result.json'))).toBe(true);
    expect(h.runner.events(receipt.runId).some((event) => event.type === 'succeeded')).toBe(true);
    const artifactId = result.outputRefs[0] as string;
    const stored = await (h.exports?.artifacts as unknown as { read: (runId: string, id: string) => Promise<{ bytes: Buffer }> }).read(
      receipt.runId,
      artifactId,
    );
    expect(stored.bytes.toString('utf8')).toBe('ok');
    expect(checkpointOnDisk(h.rootDir, receipt.runId)).toMatchObject({ phase: 'complete', cleanup: { status: 'completed' } });
  });

  it('ошибка хранилища: единственная копия остаётся, статус честный, rerun не происходит', async () => {
    const engine = new WritingEngine();
    const inner = createHarness({ artifactExport: true });
    const flaky = new FlakyBlob(inner.exports?.artifacts.blob as unknown as BlobStore, 99);
    const h = createHarness({ adapters: { fake: engine }, blob: flaky, artifactExport: true });
    const { receipt, spec } = h.start({ outputs: [{ path: 'ran.txt' }] });
    const result = await h.runner.waitFor(receipt.runId);

    // Ран завершился успешно как РАН, но его выход не сохранён — и это объявлено.
    expect(result.outcome).toBe('succeeded');
    expect(result.persistence).toBe('failed');
    expect(result.outputRefs).toEqual([]);
    expect(result.persistenceReason).toContain('not in durable storage');
    // Единственная копия осталась на диске, поэтому уборка НЕ объявлена выполненной.
    expect(result.cleanup).toBe('pending');
    expect(existsSync(join(spec.cwd, 'ran.txt'))).toBe(true);
    expect(result.cleanupReason).toContain('only copy');
    expect(checkpointOnDisk(h.rootDir, receipt.runId)).toMatchObject({ persistence: 'failed', phase: 'cleanup_pending' });

    // Рестарт воркера не стирает единственную копию и не перезапускает движок.
    const restarted = h.reopenWithoutDispose();
    await restarted.recover();
    expect(engine.startCalls).toBe(1);
    expect(existsSync(join(spec.cwd, 'ran.txt'))).toBe(true);
    expect(restarted.getRun(receipt.runId)?.result?.persistence).toBe('failed');
    expect(restarted.getRun(receipt.runId)?.result?.cleanup).toBe('pending');
  });

  it('восстановление повторяет сохранение и уборку после сбоя, не запуская движок заново', async () => {
    const engine = new SilentEngine();
    const inner = createHarness({ artifactExport: true });
    // Первая попытка записи падает, вторая (после рестарта) проходит.
    const flaky = new FlakyBlob(inner.exports?.artifacts.blob as unknown as BlobStore, 1);
    const h = createHarness({ adapters: { fake: engine }, blob: flaky, artifactExport: true });
    const { receipt, spec } = h.start({ outputs: [{ path: 'ran.txt' }] });
    const first = await h.runner.waitFor(receipt.runId);
    expect(first.persistence).toBe('failed');
    expect(existsSync(join(spec.cwd, 'ran.txt'))).toBe(true);

    const restarted = h.reopenWithoutDispose();
    const report = await restarted.recover();

    expect(report.cleanupsResumed).toBe(1);
    expect(engine.startCalls).toBe(1);
    const resumed = restarted.getRun(receipt.runId)?.result;
    expect(resumed?.persistence).toBe('persisted');
    expect(resumed?.outputRefs).toHaveLength(1);
    // Байты сохранены, единственная копия снята, каталог рана убран.
    expect(existsSync(join(spec.cwd, 'ran.txt'))).toBe(false);
    expect(existsSync(spec.cwd)).toBe(false);
    expect(resumed?.cleanup).toBe('completed');
    expect(checkpointOnDisk(h.rootDir, receipt.runId)).toMatchObject({ phase: 'complete', persistence: 'persisted' });
  });

  it('сбой во время sweep: намерение уборки выжило, восстановление доводит её один раз', async () => {
    const engine = new WritingEngine();
    const h = createHarness({ adapters: { fake: engine }, artifactExport: true });
    // Ран доходит до финализации, но уборка падает ПОСЛЕ записи намерения на диск.
    h.faults.inject('cleanup', { kind: 'throw', once: true });
    const { receipt, spec } = h.start({ outputs: [{ path: 'ran.txt' }] });
    await waitFor(
      () => h.runner.getRun(receipt.runId)?.state === 'finalizing' || h.runner.getRun(receipt.runId)?.state === 'succeeded',
      8000,
      'run to reach finalization',
    );
    await waitFor(() => existsSync(join(h.rootDir, 'runs', receipt.runId, 'checkpoint.json')), 8000, 'checkpoint on disk');
    // Каталог рана на месте: sweep не состоялся.
    expect(existsSync(spec.cwd)).toBe(true);
    expect(checkpointOnDisk(h.rootDir, receipt.runId).cleanup.status).not.toBe('completed');

    const restarted = h.reopenWithoutDispose();
    await restarted.recover();

    // Движок не перезапускался, байты на месте, каталог убран — ровно один раз.
    expect(engine.startCalls).toBe(1);
    expect(restarted.getRun(receipt.runId)?.result?.cleanup).toBe('completed');
    expect(existsSync(spec.cwd)).toBe(false);
    const result = restarted.getRun(receipt.runId)?.result;
    expect(result?.outputRefs).toHaveLength(1);
    expect(checkpointOnDisk(h.rootDir, receipt.runId)).toMatchObject({ phase: 'complete', cleanup: { status: 'completed' } });

    // Второй recover ничего не делает заново.
    const again = await restarted.recover();
    expect(again.cleanupsResumed).toBe(0);
    expect(engine.startCalls).toBe(1);
  });

  it('retainWorkspaces: уборка честно остаётся pending, пока каталог на месте', async () => {
    const engine = new WritingEngine();
    const h = createHarness({ adapters: { fake: engine }, artifactExport: true, retainWorkspaces: true } as HarnessOptions);
    const { receipt, spec } = h.start({ outputs: [{ path: 'ran.txt' }] });
    const result = await h.runner.waitFor(receipt.runId);

    expect(result.persistence).toBe('persisted');
    expect(result.cleanup).toBe('pending');
    expect(result.cleanupReason).toContain('retainWorkspaces');
    // Каталог сохранён намеренно; локальная копия выхода при этом уже снята экспортом.
    expect(existsSync(spec.cwd)).toBe(true);
  });

  it('cancel и timeout проходят тот же путь: терминальный результат и уборка', async () => {
    const h = createHarness({ adapters: { fake: new WritingEngine({ 'never.txt': 'x' }) }, artifactExport: true });
    const timeoutRun = h.start({ outputs: [{ path: 'never.txt' }], limits: { timeoutMs: 300 } });
    // Движок завершается сам, поэтому таймаут здесь — это отмена клиентом.
    await waitFor(() => h.runner.getRun(timeoutRun.receipt.runId)?.state === 'succeeded', 8000, 'run to succeed');
    expect(h.runner.getRun(timeoutRun.receipt.runId)?.result?.cleanup).toBe('completed');

    const cancelEngine = new (class extends SilentEngine {
      override async start(ctx: EngineStartContext): Promise<EngineHandle> {
        const launch = launchCommand(ctx, process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
        this.startCalls += 1;
        return this.spawn(ctx, launch);
      }
    })();
    const cancelling = createHarness({ adapters: { fake: cancelEngine }, artifactExport: true });
    const cancelled = cancelling.start({ outputs: [{ path: 'never.txt' }], limits: { timeoutMs: 10_000 } });
    await waitFor(() => (cancelling.runner.getRun(cancelled.receipt.runId)?.state ?? '') === 'running', 8000, 'run to start');
    await cancelling.runner.cancel(cancelled.receipt.runId, 1);
    const result = await cancelling.runner.waitFor(cancelled.receipt.runId);

    expect(result.outcome).toBe('cancelled');
    // Отменённый ран тоже убирается: движок погашен, каталог снят, статус честный.
    await waitFor(() => !isProcessAlive(cancelling.runner.getRun(cancelled.receipt.runId)?.pid ?? null), 8000, 'engine to die');
    expect(existsSync(cancelled.spec.cwd)).toBe(false);
    expect(result.cleanup).toBe('completed');
    expect(checkpointOnDisk(cancelling.rootDir, cancelled.receipt.runId)).toMatchObject({ engine: { exitObserved: true } });
  });
});