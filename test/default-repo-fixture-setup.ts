import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Каждый ран без явного repository клонирует дефолтную репу в cwd движка.
 * Без этого setup любой тестовый прогон ушёл бы в сеть за trained-assist/ai-agent-runner —
 * здесь env RUNNER_DEFAULT_REPO переводится на локальный фикстурный git-репозиторий,
 * поэтому `npm test` полностью офлайновый (см. src/runner/repository.ts).
 */
if (!process.env['RUNNER_DEFAULT_REPO']) {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-default-repo-'));
  execFileSync('git', ['init', '-q', fixtureDir]);
  writeFileSync(join(fixtureDir, 'README.md'), '# default repository fixture\n');
  execFileSync('git', ['-C', fixtureDir, 'add', 'README.md']);
  execFileSync('git', [
    '-C',
    fixtureDir,
    '-c',
    'user.email=fixture@ai-agent-runner.test',
    '-c',
    'user.name=fixture',
    'commit',
    '-qm',
    'fixture',
  ]);
  process.env['RUNNER_DEFAULT_REPO'] = fixtureDir;
  process.on('exit', () => {
    try {
      rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // best-effort очистка tmp
    }
  });
}
