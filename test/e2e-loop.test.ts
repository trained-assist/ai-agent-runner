import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface DriverCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

interface DriverStep {
  id: string;
  title: string;
  status: 'PASS' | 'FAIL' | 'PENDING';
  durationMs: number;
  checks: DriverCheck[];
  reproduction?: string;
  issueDraft?: { title: string; body: string };
}

interface DriverReport {
  schemaVersion: number;
  tool: string;
  issue: string;
  startedAt: string;
  finishedAt: string | null;
  env: { node: string; rootDir: string; port: number | null; flags: string[] };
  steps: DriverStep[];
  summary: { total: number; passed: number; failed: number; skipped: number; ok: boolean; finalized: boolean };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const driverPath = join(repoRoot, 'scripts', 'e2e-loop.mjs');

const EXPECTED_STEPS = [
  'step-1-submit-idempotency',
  'step-2-events-stream-replay',
  'step-3-fault-injection',
  'step-4-recovery-restart',
  'step-5-security-probes',
  'step-6-artifact',
  'step-7-credential-scopes',
];

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-e2e-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface DriverRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[]): Promise<DriverRun> {
  return new Promise((resolveRun) => {
    // NODE_ENV=development: тестовое окружение может иметь NODE_ENV=production,
    // из-за которого npm ci не ставит devDependencies (vitest/tsc).
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
    const killer = setTimeout(() => child.kill('SIGKILL'), 240000);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolveRun({ code: code ?? (signal ? -1 : 0), stdout, stderr });
    });
  });
}

function runDriver(args: string[]): Promise<DriverRun> {
  return runCommand(process.execPath, [driverPath, ...args]);
}

function loadReport(path: string): DriverReport {
  expect(existsSync(path), `report file missing: ${path}`).toBe(true);
  return JSON.parse(readFileSync(path, 'utf8')) as DriverReport;
}

function failedChecks(step: DriverStep): DriverCheck[] {
  return step.checks.filter((check) => !check.ok);
}

describe('e2e acceptance loop driver (issue #2)', () => {
  it('полный цикл: все доступные шаги зелёные, отчёт финализирован', async () => {
    const dir = tempDir();
    const reportPath = join(dir, 'report.json');
    // --sudo-policy report: CI-раннер ubuntu-latest штатно даёт NOPASSWD sudo (не продуктовый хост);
    // на песочной VM цикл гоняется с дефолтным deny.
    const run = await runDriver([
      '--root',
      join(dir, 'data'),
      '--report',
      reportPath,
      '--sudo-policy',
      'report',
    ]);
    expect(run.stderr, `stderr: ${run.stderr.slice(0, 2000)}`).toBe('');
    expect(run.code, `stdout: ${run.stdout.slice(0, 4000)}`).toBe(0);

    const report = loadReport(reportPath);
    expect(report.schemaVersion).toBe(1);
    expect(report.issue).toBe('#2');
    expect(report.tool).toBe('scripts/e2e-loop.mjs');
    expect(report.steps.map((step) => step.id)).toEqual(EXPECTED_STEPS);

    const failures = report.steps.flatMap((step) => failedChecks(step).map((check) => `${step.id}: ${check.name} — ${check.detail ?? ''}`));
    expect(failures).toEqual([]);
    expect(report.steps.every((step) => step.status === 'PASS')).toBe(true);
    expect(report.steps.every((step) => step.checks.length > 0)).toBe(true);
    expect(report.summary).toMatchObject({
      total: EXPECTED_STEPS.length,
      passed: EXPECTED_STEPS.length,
      failed: 0,
      skipped: 0,
      ok: true,
      finalized: true,
    });
    expect(report.finishedAt).not.toBeNull();
    expect(report.env.port).toBeGreaterThan(0);
    expect(run.stdout).toContain(`E2E LOOP RESULT: PASS ${EXPECTED_STEPS.length}/${EXPECTED_STEPS.length}`);
  }, 240000);

  // [[ e2e-failure-detection ]]
  it('провал шага = FAIL + reproduction + черновик issue, exit code 1', async () => {
    const dir = tempDir();
    const reportPath = join(dir, 'report.json');
    const readableTarget = join(dir, 'foreign-profile.db');
    writeFileSync(readableTarget, 'E2E-CANARY-LEAKED-CONTENT\n');
    // Читаемая цель для пробы "чужой профиль" должна дать LEAKED и уронить шаг.
    const run = await runDriver([
      '--root',
      join(dir, 'data'),
      '--report',
      reportPath,
      '--only',
      'step-5',
      '--foreign-profile',
      readableTarget,
      '--sudo-policy',
      'report',
    ]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('FAIL step-5-security-probes');

    const report = loadReport(reportPath);
    expect(report.steps).toHaveLength(1);
    const step = report.steps[0]!;
    expect(step.id).toBe('step-5-security-probes');
    expect(step.status).toBe('FAIL');
    const names = failedChecks(step).map((check) => check.name).join(' | ');
    expect(names).toContain('LEAKED');
    expect(step.reproduction).toContain('--only step-5');
    expect(step.reproduction).toContain('--root');
    expect(step.issueDraft?.title).toContain('step-5-security-probes');
    expect(step.issueDraft?.body).toContain('Reproduction');
    expect(report.summary.ok).toBe(false);
    expect(report.summary.finalized).toBe(true);
    // Данные прогона сохранены для reproduction.
    expect(existsSync(join(dir, 'data', 'fixtures', 'secrets.env'))).toBe(true);
  }, 120000);
  // [[/e2e-failure-detection ]]

  it('--with-reboot отклоняется без root до старта прогона (exit 2)', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const run = await runDriver(['--with-reboot']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--with-reboot');
  }, 30000);

  // [[ e2e-reboot-persistent-paths ]]
  it('--with-reboot + --root под /tmp отклоняется до старта (issue #6, exit 2)', async () => {
    const dir = tempDir();
    const run = await runDriver(['--with-reboot', '--root', join(dir, 'data'), '--report', join(dir, 'report.json'), '--only', 'step-4b-reboot']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('reboot-state.json');
    expect(run.stderr).toContain('/tmp');
    expect(run.stderr).toContain('issue #6');
    // guard сработал до создания каталогов и сборки дистрибутива прогона
    expect(existsSync(join(dir, 'data'))).toBe(false);
  }, 60000);

  it('--with-reboot + явный --report под /tmp отклоняется до старта (issue #6, exit 2)', async () => {
    const dir = tempDir();
    const persistentRoot = join(repoRoot, '.e2e-state-guard-probe');
    const run = await runDriver(['--with-reboot', '--root', persistentRoot, '--report', join(dir, 'report.json'), '--only', 'step-4b-reboot']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('путь отчёта');
    expect(run.stderr).toContain('/tmp');
    expect(existsSync(persistentRoot)).toBe(false);
  }, 60000);

  it('step-4b-reboot входит в список шагов только с --with-reboot (в полный прогон)', async () => {
    const withoutFlag = await runDriver(['--only', 'no-such-step']);
    expect(withoutFlag.code).toBe(2);
    expect(withoutFlag.stderr).toContain('step-1-submit-idempotency');
    expect(withoutFlag.stderr).not.toContain('step-4b-reboot');

    const withFlag = await runDriver(['--with-reboot', '--only', 'no-such-step']);
    expect(withFlag.code).toBe(2);
    expect(withFlag.stderr).toContain('step-4b-reboot');
  }, 60000);
  // [[/e2e-reboot-persistent-paths ]]

  it('scripts/e2e-loop.sh запускает драйвер (обёртка из README)', async () => {
    const dir = tempDir();
    const reportPath = join(dir, 'report.json');
    const run = await runCommand('sh', [join(repoRoot, 'scripts', 'e2e-loop.sh'), '--only', 'step-1', '--report', reportPath]);
    expect(run.stderr, `stderr: ${run.stderr.slice(0, 1000)}`).toBe('');
    expect(run.code, `stdout: ${run.stdout.slice(0, 2000)}`).toBe(0);
    expect(run.stdout).toContain('E2E LOOP RESULT: PASS 1/1');
    expect(loadReport(reportPath).steps.map((step) => step.id)).toEqual(['step-1-submit-idempotency']);
  }, 120000);
});
