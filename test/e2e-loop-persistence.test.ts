import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PERSISTENT_ROOT_BASE, isInside, isTempPath, persistentRootDefault, rebootGuards } from '../scripts/e2e-loop/persistence.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-persistence-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('isTempPath (issue #6: состояние должно пережить reboot)', () => {
  it('ловит /tmp, системный tmpdir и их подкаталоги', () => {
    expect(isTempPath('/tmp')).toBe(true);
    expect(isTempPath('/tmp/ai-agent-runner-e2e-pEwI0E/reboot-state.json')).toBe(true);
    expect(isTempPath('/private/tmp/x')).toBe(true);
    expect(isTempPath(tmpdir())).toBe(true);
    expect(isTempPath(join(tempDir(), 'reboot-state.json'))).toBe(true);
  });

  it('пропускает персистентные и продуктовые пути', () => {
    expect(isTempPath('/var/lib/e2e-loop/e2e-1/reboot-state.json')).toBe(false);
    expect(isTempPath('/var/lib/agent-runner/runs/x/state.json')).toBe(false);
    expect(isTempPath('/opt/sb/ai-agent-runner/e2e-loop-report.json')).toBe(false);
    expect(isTempPath(join(repoRoot, '.e2e-state', 'e2e-1'))).toBe(false);
    expect(isTempPath('')).toBe(false);
  });
});

describe('persistentRootDefault', () => {
  it('под root — персистентный /var/lib/e2e-loop/<id> с префиксом e2e-', () => {
    const path = persistentRootDefault({ uid: 0, repoRoot });
    expect(path.startsWith(`${PERSISTENT_ROOT_BASE}/e2e-`)).toBe(true);
    expect(isTempPath(path)).toBe(false);
  });

  it('вне root — <repo>/.e2e-state/<id> (в gitignore)', () => {
    const path = persistentRootDefault({ uid: 1000, repoRoot });
    expect(path).toBe(join(repoRoot, '.e2e-state', path.split('/').pop() as string));
    expect(path.startsWith(join(repoRoot, '.e2e-state', 'e2e-'))).toBe(true);
    expect(isTempPath(path)).toBe(false);
  });

  it('каталог не создаётся вызовом (guard срабатывает до mkdir)', () => {
    const path = persistentRootDefault({ uid: 0, repoRoot, id: 'e2e-probe-not-created' });
    expect(path).toBe(join(PERSISTENT_ROOT_BASE, 'e2e-probe-not-created'));
  });
});

describe('rebootGuards', () => {
  const persistentRoot = '/var/lib/e2e-loop/e2e-guard-test';
  const persistentReport = '/var/lib/e2e-loop/e2e-guard-test/report.json';

  it('чистая персистентная конфигурация под root — без замечаний', () => {
    expect(
      rebootGuards({ rootDir: persistentRoot, reportPath: persistentReport, reportExplicit: true, uid: 0, systemctlOk: true }),
    ).toEqual([]);
  });

  it('не root / без systemd → отказ до старта', () => {
    const problems = rebootGuards({ rootDir: persistentRoot, reportPath: persistentReport, reportExplicit: false, uid: 1000, systemctlOk: true });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('--with-reboot');
    expect(problems[0]).toContain('root');

    const noSystemctl = rebootGuards({ rootDir: persistentRoot, reportPath: persistentReport, reportExplicit: false, uid: 0, systemctlOk: false });
    expect(noSystemctl).toHaveLength(1);
    expect(noSystemctl[0]).toContain('systemd');
  });

  it('--root под /tmp → отказ с причиной про reboot-state (вместо тихого ENOENT)', () => {
    const problems = rebootGuards({
      rootDir: '/tmp/ai-agent-runner-e2e-pEwI0E',
      reportPath: persistentReport,
      reportExplicit: true,
      uid: 0,
      systemctlOk: true,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('/tmp');
    expect(problems[0]).toContain('issue #6');
    expect(problems[0]).toContain('reboot-state.json');
  });

  it('явный --report под /tmp → отказ; дефолтный отчёт из /tmp не считается ошибкой', () => {
    const explicit = rebootGuards({
      rootDir: persistentRoot,
      reportPath: '/tmp/report.json',
      reportExplicit: true,
      uid: 0,
      systemctlOk: true,
    });
    expect(explicit).toHaveLength(1);
    expect(explicit[0]).toContain('путь отчёта');

    const defaulted = rebootGuards({
      rootDir: persistentRoot,
      reportPath: '/tmp/report.json',
      reportExplicit: false,
      uid: 0,
      systemctlOk: true,
    });
    expect(defaulted).toEqual([]);
  });

  it('все проблемы перечисляются разом (root + /tmp + отчёт)', () => {
    const problems = rebootGuards({ rootDir: '/tmp/x', reportPath: '/tmp/y.json', reportExplicit: true, uid: 501, systemctlOk: false });
    expect(problems).toHaveLength(3);
  });
});

describe('isInside', () => {
  it('отчёт внутри каталога данных → true, снаружи → false', () => {
    expect(isInside('/var/lib/e2e-loop/run-1', '/var/lib/e2e-loop/run-1/report.json')).toBe(true);
    expect(isInside('/var/lib/e2e-loop/run-1', '/var/lib/e2e-loop/run-1')).toBe(true);
    expect(isInside('/var/lib/e2e-loop/run-1', '/var/lib/e2e-loop/run-10/report.json')).toBe(false);
    expect(isInside('/opt/sb/ai-agent-runner', '/opt/sb/ai-agent-runner/e2e-loop-report.json')).toBe(true);
  });
});
