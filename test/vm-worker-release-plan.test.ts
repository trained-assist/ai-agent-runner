import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planWorkerRelease } from '../scripts/vm-worker-release-plan.mjs';

const pinned = {
  OPENCODE_RELEASE_TAG: 'mem-preview-20261019-mem-v2-950f0d8',
  OPENCODE_VERSION: '0.0.0-fork-at-950f0d869b8d',
  OPENCODE_SOURCE_SHA: '9'.repeat(40),
  OPENCODE_ARCHIVE_SHA256: 'c'.repeat(64),
  OPENCODE_BINARY_SHA256: 'd'.repeat(64),
};

describe('worker release plan', () => {
  it('serves the pin when the newest release bundles exactly what main pins', () => {
    const plan = planWorkerRelease({ mainPin: pinned, latestTag: 'vm-worker-v0.3.42', latestPin: pinned });
    expect(plan.needed).toBe(false);
    expect(plan.latestTag).toBe('vm-worker-v0.3.42');
    expect(plan.reason).toContain('already bundles');
    expect(plan.reason).toContain(pinned.OPENCODE_RELEASE_TAG);
  });

  it('cuts a release when the pin on main is not the build the newest release carries', () => {
    // Это недостающее звено цикла: пин доехал до main (PR смержен), а
    // деплой-часть прошлого прогона не вырезала релиз — прод продолжал
    // обслуживать старую сборку, пока человек не запустил бы релиз руками.
    const stale = { ...pinned, OPENCODE_RELEASE_TAG: 'mem-preview-20261018-trim-web-serve-17355bd', OPENCODE_SOURCE_SHA: '1'.repeat(40) };
    const plan = planWorkerRelease({ mainPin: pinned, latestTag: 'vm-worker-v0.3.42', latestPin: stale });
    expect(plan.needed).toBe(true);
    expect(plan.reason).toContain('OPENCODE_RELEASE_TAG');
    expect(plan.reason).toContain(stale.OPENCODE_RELEASE_TAG);
    expect(plan.reason).toContain(pinned.OPENCODE_RELEASE_TAG);

    const singleFieldDrift = planWorkerRelease({
      mainPin: { ...pinned, OPENCODE_BINARY_SHA256: 'e'.repeat(64) },
      latestTag: 'vm-worker-v0.3.42',
      latestPin: pinned,
    });
    expect(singleFieldDrift.needed).toBe(true);
    expect(singleFieldDrift.reason).toContain('OPENCODE_BINARY_SHA256');
  });

  it('treats a missing release or a release without a pin file as a release to cut', () => {
    expect(planWorkerRelease({ mainPin: pinned }).needed).toBe(true);
    expect(planWorkerRelease({ mainPin: pinned }).reason).toContain('first signed release');
    const withoutPin = planWorkerRelease({ mainPin: pinned, latestTag: 'vm-worker-v0.3.1', latestPin: null });
    expect(withoutPin.needed).toBe(true);
    expect(withoutPin.reason).toContain('vm-worker-v0.3.1');
  });

  it('fails loudly instead of releasing when the pin on main is malformed', () => {
    expect(() => planWorkerRelease({ mainPin: { OPENCODE_VERSION: '1.2.3' }, latestTag: 'vm-worker-v0.3.42', latestPin: pinned })).toThrow('missing OPENCODE_RELEASE_TAG');
  });

  it('writes the decision where the hook can read it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-release-plan-'));
    const mainPath = join(dir, 'main-pin.json');
    const latestPath = join(dir, 'latest-pin.json');
    const outputPath = join(dir, 'outputs');
    writeFileSync(mainPath, `${JSON.stringify(pinned, null, 2)}\n`);
    writeFileSync(latestPath, `${JSON.stringify(pinned, null, 2)}\n`);
    writeFileSync(outputPath, '');

    const script = fileURLToPath(new URL('../scripts/vm-worker-release-plan.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--main-pin', mainPath, '--latest-tag', 'vm-worker-v0.3.42', '--latest-pin', latestPath], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('release up to date');
    const outputs = new Map(
      readFileSync(outputPath, 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => line.split('='))
        .map(([key, ...value]) => [key, value.join('=')]),
    );
    expect(outputs.get('needed')).toBe('false');
    expect(outputs.get('latest_tag')).toBe('vm-worker-v0.3.42');
  });

  it('is the gate the promotion hook uses before it cuts a worker release', () => {
    const workflow = readFileSync(new URL('../.github/workflows/opencode-fork-promotion.yml', import.meta.url), 'utf8');
    // Релиз режется не «по факту, что пин поменялся», а по сверке пина main с
    // тем, что лежит в последнем подписанном релизе: только эта сверка
    // отличает «релиз уже обслуживает эту сборку» от «релиз отстал».
    expect(workflow).toContain('node scripts/vm-worker-release-plan.mjs');
    expect(workflow).toContain('git show origin/main:deploy/vm-worker/opencode-release-pin.json');
    expect(workflow).toContain('vm-worker-v$next');
    // На раннере воркера нет git identity: без неё коммит падал с
    // "empty ident name", и релиз не резался вовсе.
    expect(workflow).toContain('git config user.name "opencode-promotion"');
    expect(workflow).toContain('git config user.email "opencode-promotion@users.noreply.github.com"');
  });

  it('opens and merges the promotion pull request with the repository token', () => {
    const workflow = readFileSync(new URL('../.github/workflows/opencode-fork-promotion.yml', import.meta.url), 'utf8');
    // Токен Actions не запускает CI на ветке PR, поэтому PR и merge делаются
    // токеном из секретов: иначе «зелёный CI перед merge» не существовало бы.
    expect(workflow).toContain('${{ secrets.PROMOTION_GITHUB_TOKEN || github.token }}');
    expect(workflow).toContain('gh pr create');
    expect(workflow).toContain('gh pr merge');
    expect(workflow).toContain('statusCheckRollup');
  });
});
