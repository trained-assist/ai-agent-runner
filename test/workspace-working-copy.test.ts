import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveWorkingCopy, inspectWorkingCopy, prepareProfileTree } from '../src/workspace/working-copy.js';

const roots: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.email=wc@test', '-c', 'user.name=wc', ...args], { encoding: 'utf8' });
}

/** Клон с одним remote-коммитом: база для «чистого» и «грязного» клонов. */
function cloneWithRemote(): { origin: string; work: string } {
  const origin = tempDir('wc-origin-');
  execFileSync('git', ['init', '-q', '-b', 'main', origin]);
  writeFileSync(join(origin, 'base.txt'), 'base\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'base');
  const work = tempDir('wc-work-');
  execFileSync('git', ['clone', '-q', origin, work]);
  return { origin, work };
}

describe('working copy state', () => {
  it('reports a clean clone as replaceable (nothing to archive)', () => {
    const { work } = cloneWithRemote();
    const state = inspectWorkingCopy(work);
    expect(state.isRepository).toBe(true);
    expect(state.modified).toBe(0);
    expect(state.untracked).toBe(0);
    expect(state.unpushedCommits).toBe(0);
    expect(state.hasIrreplaceableState).toBe(false);
  });

  it('reports uncommitted edits, untracked files, local commits and branches', () => {
    const { work } = cloneWithRemote();
    writeFileSync(join(work, 'base.txt'), 'changed\n');
    writeFileSync(join(work, 'new.txt'), 'new\n');
    git(work, 'commit', '-qam', 'local commit');
    git(work, 'checkout', '-qb', 'abandoned');
    writeFileSync(join(work, 'feature.txt'), 'wip\n');
    git(work, 'add', 'feature.txt');
    git(work, 'commit', '-qm', 'unfinished feature');
    git(work, 'checkout', '-q', 'main');
    writeFileSync(join(work, 'base.txt'), 'dirty again\n');

    const state = inspectWorkingCopy(work);
    expect(state.unpushedCommits).toBe(2);
    expect(state.branches).toContain('abandoned');
    expect(state.modified).toBe(1);
    expect(state.untracked).toBe(1);
    expect(state.hasIrreplaceableState).toBe(true);
  });

  it('reports a non-repository directory as empty state', () => {
    const dir = tempDir('wc-plain-');
    const state = inspectWorkingCopy(dir);
    expect(state.isRepository).toBe(false);
    expect(state.hasIrreplaceableState).toBe(false);
  });
});

describe('archive only the changes', () => {
  it('does not archive a clean clone', () => {
    const { work } = cloneWithRemote();
    const archive = archiveWorkingCopy(work, { outDir: tempDir('wc-archive-') });
    expect(archive.bundlePath).toBeNull();
    expect(archive.patchPath).toBeNull();
    expect(archive.untrackedPath).toBeNull();
    expect(archive.bytes).toBe(0);
  });

  it('archives local commits, uncommitted edits and untracked files separately', () => {
    const { origin, work } = cloneWithRemote();
    git(work, 'checkout', '-qb', 'abandoned');
    writeFileSync(join(work, 'feature.txt'), 'unfinished\n');
    git(work, 'add', 'feature.txt');
    git(work, 'commit', '-qm', 'unfinished feature');
    git(work, 'checkout', '-q', 'main');
    writeFileSync(join(work, 'base.txt'), 'edited locally\n');
    writeFileSync(join(work, 'scratch.txt'), 'untracked\n');

    const outDir = tempDir('wc-archive-');
    const archive = archiveWorkingCopy(work, { outDir });
    expect(archive.bundlePath).not.toBeNull();
    expect(archive.patchPath).not.toBeNull();
    expect(archive.untrackedPath).not.toBeNull();
    expect(archive.bytes).toBeGreaterThan(0);

    // Bundle тонкий: локальные коммиты + их базовые коммиты из remote. Реальное
    // восстановление — клон remote, затем вливание bundle. Проверяем именно его.
    const restored = tempDir('wc-restored-');
    execFileSync('git', ['clone', '-q', origin, restored]);
    execFileSync('git', ['-C', restored, 'fetch', '-q', archive.bundlePath as string, 'refs/heads/*:refs/restored/*']);
    const restoredBranches = execFileSync('git', ['-C', restored, 'for-each-ref', '--format=%(refname:short)', 'refs/restored'], { encoding: 'utf8' });
    expect(restoredBranches).toContain('restored/abandoned');
    const manifest = JSON.parse(execFileSync('cat', [archive.manifestPath as string], { encoding: 'utf8' }));
    expect(manifest.branchTips.abandoned).toBeTruthy();
    expect(manifest.remotes[0].name).toBe('origin');
  });

  it('archives only untracked files when there are no local commits', () => {
    const { work } = cloneWithRemote();
    writeFileSync(join(work, 'only-untracked.txt'), 'x\n');
    const archive = archiveWorkingCopy(work, { outDir: tempDir('wc-archive-') });
    expect(archive.bundlePath).toBeNull();
    expect(archive.patchPath).toBeNull();
    expect(archive.untrackedPath).not.toBeNull();
  });

  it('does not modify the working copy it reads', () => {
    const { work } = cloneWithRemote();
    writeFileSync(join(work, 'base.txt'), 'edited\n');
    const before = execFileSync('git', ['-C', work, 'status', '--porcelain'], { encoding: 'utf8' });
    archiveWorkingCopy(work, { outDir: tempDir('wc-archive-') });
    const after = execFileSync('git', ['-C', work, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(after).toBe(before);
    expect(existsSync(join(work, 'base.txt'))).toBe(true);
  });
});

describe('prepareProfileTree — готовит дерево профиля к импорту', () => {
  it('архивирует изменения рабочих копий в .profile-changes и пропускает чистые клоны', async () => {
    const { compilePolicy, DEFAULT_EXPORT_POLICY } = await import('../src/workspace/policy.js');
    const { prepareProfileTree } = await import('../src/workspace/working-copy.js');
    const policy = compilePolicy(DEFAULT_EXPORT_POLICY);

    const profile = tempDir('profile-');
    // Чистый клон: не архивируется.
    const clean = cloneWithRemote();
    execFileSync('cp', ['-R', clean.work, join(profile, 'clean-clone')]);
    // Грязный клон: архивируется.
    const dirty = cloneWithRemote();
    git(dirty.work, 'checkout', '-qb', 'wip');
    writeFileSync(join(dirty.work, 'wip.txt'), 'unfinished\n');
    git(dirty.work, 'add', 'wip.txt');
    git(dirty.work, 'commit', '-qm', 'wip');
    writeFileSync(join(dirty.work, 'base.txt'), 'dirty\n');
    execFileSync('cp', ['-R', dirty.work, join(profile, 'dirty-clone')]);
    // Клон под node_modules: политика исключает — пропускается, не мусорит.
    const buried = cloneWithRemote();
    git(buried.work, 'commit', '-q', '--allow-empty', '-m', 'local');
    mkdirSync(join(profile, 'node_modules', 'dep'), { recursive: true });
    execFileSync('cp', ['-R', buried.work, join(profile, 'node_modules', 'dep')]);

    const result = prepareProfileTree(profile, { policy });
    const byPath = Object.fromEntries(result.workingCopies.map((item) => [item.path, item]));
    expect(byPath['clean-clone']?.archivePath).toBeNull();
    expect(byPath['dirty-clone']?.archivePath).toBe('.profile-changes/dirty-clone');
    expect(byPath['dirty-clone']?.bytes).toBeGreaterThan(0);
    expect(byPath['node_modules/dep']).toBeUndefined();

    // Архив реально лёг в дерево и содержит брошенную ветку.
    const archiveDir = join(profile, '.profile-changes', 'dirty-clone');
    expect(existsSync(join(archiveDir, 'local.bundle'))).toBe(true);
    expect(existsSync(join(archiveDir, 'uncommitted.patch'))).toBe(true);
    expect(existsSync(join(archiveDir, 'local.manifest.json'))).toBe(true);
    // Чистый клон не оставил архива.
    expect(existsSync(join(profile, '.profile-changes', 'clean-clone'))).toBe(false);
  });
});
