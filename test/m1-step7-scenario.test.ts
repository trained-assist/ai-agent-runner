import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src/storage/artifact-store.js';
import { createLocalFsBlobStore } from '../src/storage/local-fs.js';
import { alphaKey, startHttpHarness } from './api-http-harness.js';

// Сквозной сценарий шага 7 (scripts/m1-step7-conversation-e2e.mjs) — регрессия на живом
// HTTP-контракте: пять реплик одной conversation, ожидание ответа пользователя,
// явная новая попытка продолжения, отсутствие credentials в отчёте.
// Управляемый сбой (рестарт сервиса/VM) и артефакт проверяются на песочной VM — здесь
// сценарий гонится в режиме --restart-mode none --no-artifact (без systemd и без dist).

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts', 'm1-step7-conversation-e2e.mjs');

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm1-step7-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ScenarioReport {
  conversationId: string;
  options: { engine: string; restartMode: string };
  capabilities: { interaction: { engineResume: string; continuation: { policy: string } } };
  turns: Array<{ turn: number; userTaskId: string; conversationId?: string; runId: string; state: string; transitions: Array<{ type: string; reason?: string }> }>;
  awaitingInput: { awaitingInputId: string; answeredAt: string | null; consumedByRunId: string | null } | null;
  continuation: { runId: string; previousRunId: string; userTaskId: string; newRunId: boolean; conversationId: string; state: string } | null;
  artifact: { skipped?: boolean };
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  summary: { total: number; passed: number; failed: number; ok: boolean };
}

function runScenario(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolveRun({ code: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}

describe('сквозной сценарий шага 7 (control plane ↔ Runner)', () => {
  it('пять реплик одной conversation: ожидание, явная новая попытка, без credentials в отчёте', async () => {
    const dir = tempDir();
    const reportPath = join(dir, 'report.json');
    const rootDir = join(dir, 'data');
    const store = new ArtifactStore({ rootDir, blob: createLocalFsBlobStore({ rootDir: join(rootDir, 'blobs') }) });
    const h = await startHttpHarness({ rootDir, artifacts: store });

    const run = await runScenario(
      ['--restart-mode', 'none', '--no-artifact', '--engine', 'fake', '--timeout-ms', '20000', '--report', reportPath, '--journal', join(dir, 'journal.jsonl')],
      { RUNNER_API_URL: h.base, RUNNER_API_KEY: alphaKey, RUNNER_API_KEY_FILE: '' },
    );
    expect(run.stderr, `stderr: ${run.stderr.slice(0, 1500)}`).toBe('');
    expect(run.code, `stdout: ${run.stdout.slice(0, 4000)}`).toBe(0);

    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as ScenarioReport;
    expect(report.summary.ok).toBe(true);
    expect(run.stdout).toContain('STEP7 RESULT: PASS');

    // пять реплик одной conversation; ответ пользователя (ход 3) дан явной новой попыткой,
    // которая лежит отдельно в report.continuation — шестая попытка той же задачи
    const turnNumbers = report.turns.map((entry) => entry.turn);
    expect(turnNumbers).toEqual([1, 2, 3, 4, 5]);
    for (const entry of report.turns) expect(entry.conversationId).toBe(report.conversationId);
    const turn3 = report.turns.find((entry) => entry.turn === 3)!;
    expect(report.continuation!.previousRunId).toBe(turn3.runId);
    expect(report.continuation!.userTaskId ?? turn3.userTaskId).toBe(turn3.userTaskId);

    // декларация capabilities использована, а не угадана
    expect(report.capabilities.interaction.engineResume).toBe('unsupported');
    expect(report.capabilities.interaction.continuation.policy).toBe('new_run_same_user_task');

    // ожидание ответа пользователя: открыто, закрыто ответом, израсходовано один раз
    expect(report.awaitingInput).not.toBeNull();
    expect(report.awaitingInput!.answeredAt).not.toBeNull();
    expect(report.awaitingInput!.consumedByRunId).toBe(report.continuation!.runId);

    // продолжение = новая попытка, а не молчаливый повтор
    expect(report.continuation!.newRunId).toBe(true);
    expect(report.continuation!.runId).not.toBe(report.continuation!.previousRunId);
    expect(report.continuation!.conversationId).toBe(report.conversationId);
    expect(report.continuation!.state).toBe('succeeded');

    // в каждом ходе есть ключи событий и причина перехода (требование эпика к логам)
    for (const entry of report.turns) {
      expect(entry.transitions.length).toBeGreaterThan(0);
      expect(entry.transitions.some((transition) => transition.type === 'claimed')).toBe(true);
    }

    // credentials не попали ни в отчёт, ни в stdout
    const reportText = readFileSync(reportPath, 'utf8');
    expect(reportText).not.toContain(alphaKey);
    expect(run.stdout).not.toContain(alphaKey);
  }, 180000);

  it('--resume без записи begin в журнале отклоняется, а не начинает новый разговор', async () => {
    const dir = tempDir();
    const journalPath = join(dir, 'journal.jsonl');
    writeFileSync(journalPath, `${JSON.stringify({ at: new Date().toISOString(), event: 'noise' })}\n`);
    const rootDir = join(dir, 'data');
    const store = new ArtifactStore({ rootDir, blob: createLocalFsBlobStore({ rootDir: join(rootDir, 'blobs') }) });
    const h = await startHttpHarness({ rootDir, artifacts: store });

    const run = await runScenario(['--resume', '--restart-mode', 'none', '--no-artifact', '--journal', journalPath, '--report', join(dir, 'report.json')], {
      RUNNER_API_URL: h.base,
      RUNNER_API_KEY: alphaKey,
      RUNNER_API_KEY_FILE: '',
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--resume');
    expect(run.stderr).toContain('begin');
  }, 60000);

  // Рестарт VM ловит этот класс дефектов (порядок объявлений в resume-ветке) только на
  // песочнице; здесь гоняем resume по журналу завершённого прогона и требуем, чтобы он
  // дошёл до восстановления идентичности БЕЗ падения в инициализации.
  it('--resume восстанавливает conversationId из журнала и не падает в resume-ветке', async () => {
    const dir = tempDir();
    const journalPath = join(dir, 'journal.jsonl');
    const firstReport = join(dir, 'first.json');
    const rootDir = join(dir, 'data');
    const store = new ArtifactStore({ rootDir, blob: createLocalFsBlobStore({ rootDir: join(rootDir, 'blobs') }) });
    const h = await startHttpHarness({ rootDir, artifacts: store });
    const env = { RUNNER_API_URL: h.base, RUNNER_API_KEY: alphaKey, RUNNER_API_KEY_FILE: '' };
    const conversationId = 'conv-step7-resume-test';

    const first = await runScenario(
      ['--restart-mode', 'none', '--no-artifact', '--conversation', conversationId, '--timeout-ms', '20000', '--report', firstReport, '--journal', journalPath],
      env,
    );
    expect(first.code, `stdout: ${first.stdout.slice(0, 3000)}`).toBe(0);
    const firstJson = JSON.parse(readFileSync(firstReport, 'utf8')) as ScenarioReport;
    expect(firstJson.conversationId).toBe(conversationId);

    // Повторный вход в журнал: идентичность (conversationId → idempotency-ключи) обязана
    // восстановиться, а не сгенерироваться заново.
    const resumed = await runScenario(
      ['--resume', '--restart-mode', 'none', '--no-artifact', '--timeout-ms', '20000', '--report', join(dir, 'second.json'), '--journal', journalPath],
      env,
    );
    expect(resumed.stderr).not.toContain('ReferenceError');
    expect(resumed.stdout).toContain('resume: журнал прочитан, conversationId восстановлен');
    const secondJson = JSON.parse(readFileSync(join(dir, 'second.json'), 'utf8')) as ScenarioReport;
    expect(secondJson.conversationId).toBe(conversationId);
  }, 180000);
});
