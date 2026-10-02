import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Регрессия issue #31: resume-режим шага 4b.
//  1) exit code: FAIL-отчёт → юнит обязан выйти с 1 (раньше unref-таймер + смерть
//     дочернего сервера давали естественный exit 0 — systemd видел «успешно»).
//  2) проверка «движок не стартовал повторно»: startsByEngine — счётчик в памяти
//     процесса и пережить reboot не может; сравнение «до/после» валит зелёный шаг.
//  3) cleanup: без --keep-data resume удаляет каталог данных после записи отчёта.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const driverPath = join(repoRoot, 'scripts', 'e2e-loop.mjs');

interface DriverRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[]): Promise<DriverRun> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: 'development' },
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
    const killer = setTimeout(() => child.kill('SIGKILL'), 180000);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolveRun({ code: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-resume-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ReportCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

interface ReportStep {
  id: string;
  status: string;
  checks: ReportCheck[];
}

interface ReportFile {
  steps: ReportStep[];
  summary: { ok: boolean; finalized: boolean };
}

describe('reboot-resume: exit code и проверки после рестарта процесса (issue #31)', () => {
  it('FAIL-отчёт → exit 1, проверка движения не требует in-memory счётчика, cleanup без --keep-data', async () => {
    const dir = tempDir();
    const rootDir = join(dir, 'data');
    const reportPath = join(dir, 'report.json');

    // Реальный прогон шага 1: валидный durable store + отчёт.
    const first = await runCommand(process.execPath, [driverPath, '--only', 'step-1', '--root', rootDir, '--report', reportPath, '--keep-data']);
    expect(first.stderr, `stderr: ${first.stderr.slice(0, 2000)}`).toBe('');
    expect(first.code, `stdout: ${first.stdout.slice(0, 3000)}`).toBe(0);
    expect(existsSync(join(rootDir, 'api', 'admissions.json'))).toBe(true);

    // Ключ из keys-файла восстановить нельзя — подменяем hash на наш ключ,
    // principal остаётся прежним, dedup-путь.resume идёт как тот же клиент.
    const keysPath = join(rootDir, 'e2e-keys.json');
    const keys = JSON.parse(readFileSync(keysPath, 'utf8')) as { principals: Array<Record<string, unknown>> };
    const ourKey = `ak_${'c0ffee'.repeat(8)}`;
    keys.principals[0]!.keyHash = sha256Hex(ourKey);
    writeFileSync(keysPath, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });

    const storeFile = JSON.parse(readFileSync(join(rootDir, 'api', 'admissions.json'), 'utf8')) as {
      admissions: Array<{ runId: string; idempotencyKey: string }>;
    };
    expect(storeFile.admissions).toHaveLength(1);
    const runId = storeFile.admissions[0]!.runId;

    const statePath = join(rootDir, 'reboot-state.json');
    const state = {
      statePath,
      rootDir,
      reportPath,
      port: 0,
      controlToken: 'test-control-token',
      keysPath,
      credsPath: join(rootDir, 'e2e-credentials.json'),
      key: ourKey,
      runId,
      idempotencyKey: 'e2e-step-1',
      // дословно body шага 1 (steps.mjs engineBody): payloadHash должен совпасть для dedup
      body: {
        engine: { name: 'fake', adapterVersion: '1' },
        limits: { timeoutMs: 15000 },
        envAllowlist: [],
        input: { inlinePrompt: 'e2e step 1: idempotent submit' },
      },
      preReboot: { admissions: 1, startsFakeTimeout: 1 },
      node: process.execPath,
      script: driverPath,
      keepData: true,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

    // Resume: run уже succeeded (не failed) → часть проверок честно FAIL → exit 1.
    const resume = await runCommand(process.execPath, [driverPath, '--reboot-resume', statePath]);
    expect(resume.stderr, `stderr: ${resume.stderr.slice(0, 2000)}`).toBe('');
    // регрессия exit code: раньше exit 0 при FAIL (unref-таймер не срабатывал)
    expect(resume.code, `stdout: ${resume.stdout.slice(0, 3000)}`).toBe(1);
    expect(resume.stdout).toContain('E2E LOOP RESULT: FAIL');

    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as ReportFile;
    expect(report.summary.finalized).toBe(true);
    expect(report.summary.ok).toBe(false);
    const step = report.steps.find((entry) => entry.id === 'step-4b-reboot');
    expect(step, 'step-4b-reboot отсутствует в отчёте').toBeDefined();
    expect(step!.status).toBe('FAIL');

    const checkOf = (name: string): ReportCheck | undefined => step!.checks.find((check) => check.name === name);
    // регрессия P1: старая проверка сравнивала pre=1 с post=undefined → FAIL зелёного шага
    const engineCheck = checkOf('движок не стартовал повторно после reboot');
    expect(engineCheck, 'проверка движения отсутствует').toBeDefined();
    expect(engineCheck!.ok).toBe(true);
    expect(engineCheck!.detail).toContain('post-reboot=0');

    // resume-путь, который в зелёном reboot-прогоне обязан проходить
    expect(checkOf('status читается после reboot')?.ok).toBe(true);
    expect(checkOf('повторный submit deduplicated=true')?.ok).toBe(true);
    expect(checkOf('admissions не выросли (нет второго run)')?.ok).toBe(true);
    expect(checkOf('claimed ровно один')?.ok).toBe(true);
    // зелёный сценарий ожидает failed/worker_crash — наш ран succeeded, поэтому FAIL (exit 1 выше)
    expect(checkOf('run финализирован как failed/worker_crash (не rerun)')?.ok).toBe(false);

    // keepData: каталог данных сохранён
    expect(existsSync(rootDir)).toBe(true);

    // Повторный resume без --keep-data: отчёт переживает, каталог данных удаляется.
    state.keepData = false;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    const second = await runCommand(process.execPath, [driverPath, '--reboot-resume', statePath]);
    expect(second.code).toBe(1);
    expect(existsSync(rootDir)).toBe(false);
    expect(existsSync(reportPath)).toBe(true);
    const finalReport = JSON.parse(readFileSync(reportPath, 'utf8')) as ReportFile;
    expect(finalReport.summary.finalized).toBe(true);
    expect(finalReport.steps.filter((entry) => entry.id === 'step-4b-reboot')).toHaveLength(1);
  }, 240000);

  it('resume без reboot-state.json → exit 1 с явной ошибкой про issue #6, не stack trace ENOENT', async () => {
    const dir = tempDir();
    const statePath = join(dir, 'reboot-state.json');
    const run = await runCommand(process.execPath, [driverPath, '--reboot-resume', statePath]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('reboot-state');
    expect(run.stderr).toContain('issue #6');
    expect(run.stderr).not.toContain('at readFileSync');
  }, 30000);
});
