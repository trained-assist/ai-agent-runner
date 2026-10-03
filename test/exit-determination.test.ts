import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineAdapter, EngineHandle, EngineStartContext } from '../src/adapters/engine/engine-adapter.js';
import { launchCommand } from '../src/adapters/engine/launch.js';
import { handleForChild } from '../src/adapters/engine/process-tree.js';
import type { RunCheckpoint } from '../src/runner/checkpoint.js';
import { createHarness, waitFor } from './helpers.js';

/**
 * #52, шаг 2: выход рана определён явно.
 *
 * Источников ровно два — объявленные клиентом выходы и финальный манифест агента.
 * Третий источник («просканировать workspace/HOME и сохранить что нашлось») запрещён:
 * это и есть тот случай, при котором чужие данные попадают в хранилище.
 *
 * Текст ответа и обязательный checkpoint обязаны переживать sweep чистой среды.
 */
class ScriptedEngine implements EngineAdapter {
  readonly name = 'fake';
  startCalls = 0;
  private readonly files: Record<string, string>;
  private readonly stdout: string;

  constructor(files: Record<string, string>, stdout = 'agent: готово\n') {
    this.files = files;
    this.stdout = stdout;
  }

  async start(ctx: EngineStartContext): Promise<EngineHandle> {
    this.startCalls += 1;
    const writes = Object.entries(this.files).map(
      ([path, content]) =>
        `require('node:fs').mkdirSync(require('node:path').dirname(${JSON.stringify(path)}), {recursive: true});` +
        `require('node:fs').writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)});`,
    );
    const script = [...writes, `console.log(${JSON.stringify(this.stdout.trim())});`, 'process.exit(0);'].join('');
    const launch = launchCommand(ctx, process.execPath, ['-e', script]);
    const child = spawn(launch.command, launch.args, {
      cwd: ctx.cwd,
      env: ctx.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return handleForChild(child, { onLog: ctx.onLog, onExit: ctx.onExit });
  }
}

function harnessWith(engine: EngineAdapter, over: Parameters<typeof createHarness>[0] = {}) {
  return createHarness({ adapters: { fake: engine }, artifactExport: true, ...over });
}

function readCheckpoint(rootDir: string, runId: string): RunCheckpoint {
  return JSON.parse(readFileSync(join(rootDir, 'runs', runId, 'checkpoint.json'), 'utf8')) as RunCheckpoint;
}

describe('определение выхода рана: объявленные выходы, манифест агента и checkpoint (#52)', () => {
  it('манифест агента добавляет выходы к объявленным, ответ сохраняется артефактом', async () => {
    const engine = new ScriptedEngine(
      {
        'report.md': '# отчёт агента\n',
        'answer.md': 'Готово: отчёт собран.\n',
        '.agent/final-manifest.json': JSON.stringify({
          outputs: [{ path: 'report.md', mime: 'text/markdown' }],
          answerFile: 'answer.md',
        }),
      },
      'агент: работаю над отчётом',
    );
    const h = harnessWith(engine);
    const { receipt } = h.start({ outputs: [{ path: 'extra.json' }] });

    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('succeeded');
    // extra.json движок не писал → он в манифесте failed; report.md пришёл из манифеста агента.
    const manifest = h.exports?.read(receipt.runId);
    expect(manifest?.totals.planned).toBe(2);
    expect(manifest?.entries.find((entry) => entry.sourcePath === 'report.md')?.status).toBe('exported');
    expect(manifest?.entries.find((entry) => entry.sourcePath === 'extra.json')?.status).toBe('missing');

    // Текст ответа взят из answerFile агента, а не из stdout, и сохранён в хранилище.
    const artifacts = await h.runner.getRun(receipt.runId)?.checkpoint;
    expect(artifacts?.answer.source).toBe('agent_file');
    expect(artifacts?.answer.text).toContain('отчёт собран');
    const answerArtifactId = artifacts?.answer.artifactId as string;
    expect(answerArtifactId).toMatch(/^art-/);
    const bytes = await (h.exports?.artifacts as unknown as { read: (runId: string, id: string) => Promise<{ bytes: Buffer }> }).read(
      receipt.runId,
      answerArtifactId,
    );
    expect(bytes.bytes.toString('utf8')).toContain('отчёт собран');
  });

  it('ответ без answerFile берётся из stdout движка', async () => {
    const engine = new ScriptedEngine({}, 'агент: ответ из stdout');
    const h = harnessWith(engine);
    const { receipt } = h.start();
    await h.runner.waitFor(receipt.runId);

    const checkpoint = readCheckpoint(h.rootDir, receipt.runId);
    expect(checkpoint.answer).toMatchObject({ present: true, source: 'engine_stdout' });
    expect(checkpoint.answer.text).toContain('ответ из stdout');
  });

  it('манифест с выходом за пределы workspace отвергается с причиной, ран не падает', async () => {
    const engine = new ScriptedEngine(
      {
        'report.md': 'ok\n',
        '.agent/final-manifest.json': JSON.stringify({ outputs: [{ path: '../../etc/passwd' }] }),
      },
      'агент: ответ',
    );
    const h = harnessWith(engine);
    const { receipt } = h.start({ outputs: [{ path: 'report.md' }] });
    const result = await h.runner.waitFor(receipt.runId);

    expect(result.outcome).toBe('succeeded');
    // Объявленный клиентом выход сохранён, ничьи чужие файлы — нет.
    expect(h.exports?.read(receipt.runId)?.entries.map((entry) => entry.sourcePath)).toEqual(['report.md']);
    const resolved = h.runner.events(receipt.runId).find((event) => event.type === 'agent_exit_resolved');
    expect(resolved?.payload).toMatchObject({ manifest: 'invalid' });
    const warn = h.runner.events(receipt.runId).find(
      (event) => event.type === 'log' && String((event.payload as { message?: string } | undefined)?.message ?? '').includes('final_manifest_invalid'),
    );
    expect(String((warn?.payload as { message?: string } | undefined)?.message)).toContain('relative path');
  });

  it('битый JSON манифеста не мешает объявленным выходам', async () => {
    const engine = new ScriptedEngine({ 'report.md': 'ok\n', '.agent/final-manifest.json': '{не json' }, 'агент: ответ');
    const h = harnessWith(engine);
    const { receipt } = h.start({ outputs: [{ path: 'report.md' }] });
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('succeeded');
    expect(h.exports?.read(receipt.runId)?.entries[0]?.status).toBe('exported');
    expect(h.runner.events(receipt.runId).find((event) => event.type === 'agent_exit_resolved')?.payload).toMatchObject({
      manifest: 'invalid',
    });
  });

  it('всё, чего агент не объявил, остаётся на диске и в хранилище не попадает', async () => {
    const engine = new ScriptedEngine(
      {
        'declared.md': 'объявленный выход\n',
        '.env': 'TOKEN=should-not-be-exported\n',
        'notes/private.txt': 'личный файл агента\n',
        '.agent/final-manifest.json': JSON.stringify({ outputs: [{ path: 'declared.md' }] }),
      },
      'агент: ответ',
    );
    // Каталоги намеренно оставлены: проверка — про то, что НЕ попало в хранилище.
    const h = harnessWith(engine, { retainWorkspaces: true });
    const { receipt, spec } = h.start();
    await h.runner.waitFor(receipt.runId);

    const exported = (h.exports?.read(receipt.runId)?.entries ?? []).map((entry) => entry.sourcePath);
    expect(exported).toEqual(['declared.md']);
    // Никакого «сканирования вслепую»: незаявленные файлы не попали в манифест экспорта.
    expect(existsSync(join(spec.cwd, '.env'))).toBe(true);
  });

  it('checkpoint обязателен, переживает рестарт воркера и читается после него', async () => {
    const engine = new ScriptedEngine({ 'report.md': 'ok\n' }, 'агент: ответ для checkpoint');
    const h = harnessWith(engine);
    const { receipt } = h.start({ outputs: [{ path: 'report.md' }] });
    await h.runner.waitFor(receipt.runId);

    const before = readCheckpoint(h.rootDir, receipt.runId);
    expect(before).toMatchObject({
      runId: receipt.runId,
      phase: 'complete',
      persistence: 'persisted',
      cleanup: { status: 'completed' },
    });
    expect(before.outputs.outputRefs).toHaveLength(1);
    expect(before.engine).toMatchObject({ exitObserved: true, exitCode: 0, exitReason: 'completed' });

    // Рестарт воркера поверх долговечного состояния: движок не перезапускается,
    // checkpoint читается как есть.
    const restarted = h.reopenWithoutDispose();
    const report = await restarted.recover();
    expect(report.checkpointsRebuilt).toBe(0);
    await waitFor(() => restarted.getRun(receipt.runId)?.state === 'succeeded', 5000, 'terminal run');
    expect(restarted.getRun(receipt.runId)?.checkpoint?.answer.text).toContain('ответ для checkpoint');
    expect((engine as ScriptedEngine).startCalls).toBe(1);
  });

  it('утраченный checkpoint достраивается при восстановлении, без повторного запуска движка', async () => {
    const engine = new ScriptedEngine({ 'report.md': 'ok\n' }, 'агент: ответ');
    const h = harnessWith(engine);
    const { receipt } = h.start({ outputs: [{ path: 'report.md' }] });
    await h.runner.waitFor(receipt.runId);

    // Сбой между записью результата и записью checkpoint: файла нет.
    const path = join(h.rootDir, 'runs', receipt.runId, 'checkpoint.json');
    expect(existsSync(path)).toBe(true);
    const { rmSync } = await import('node:fs');
    rmSync(path);

    const restarted = h.reopenWithoutDispose();
    const report = await restarted.recover();
    expect(report.checkpointsRebuilt).toBe(1);
    const rebuilt = restarted.getRun(receipt.runId)?.checkpoint as RunCheckpoint;
    expect(rebuilt.phase).toBe('complete');
    expect(rebuilt.persistence).toBe('persisted');
    expect((engine as ScriptedEngine).startCalls).toBe(1);
  });

  it('checkpoint стартового отказа тоже записан: движок не запускался — ответа нет', async () => {
    const engine = new ScriptedEngine({}, 'агент: ответ');
    const h = harnessWith(engine);
    const { receipt } = h.start({ limits: { timeoutMs: 5000 }, engine: { name: 'fake', adapterVersion: '1' }, budget: { approved: false, reason: 'нет бюджета', correlationRef: 'cor-1' } });
    const result = await h.runner.waitFor(receipt.runId);

    expect(result.outcome).toBe('failed');
    const checkpoint = readCheckpoint(h.rootDir, receipt.runId);
    expect(checkpoint.answer).toMatchObject({ present: false, source: null, text: '' });
    expect(checkpoint.answer.reason).toContain('engine never started');
    expect(checkpoint.persistence).toBe('not_required');
    expect((engine as ScriptedEngine).startCalls).toBe(0);
  });
});