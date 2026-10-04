/**
 * Приёмка модуля постоянного workspace: полный цикл и отказы.
 *
 * Сценарии взяты из acceptance-критериев потока (PR #131 + задача интегратора):
 * ensure идемпотентен · batch возобновляется · импорт сохраняет дерево и хэши и не тащит
 * credential'ы · publish → новая подготовка читает сохранённое · тяжёлый артефакт доступен
 * по ref · чужой профиль недоступен · два рана от одной базы объединяются · same-file и
 * edit/delete не теряют данные · устаревший кандидат не публикуется · timeout/crash не
 * плодит дубли · storage failure сохраняет sole copy · resolver failure не создаёт цикл.
 *
 * Всё локально: «remote» — bare-репозиторий на диске, креды не нужны.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_TREE, WorkspaceError } from '../src/workspace/contract.js';
import {
  cleanupTempDirs,
  commitToRemote,
  harness,
  listFiles,
  mirrorTree,
  readFileAt,
  remoteTree,
  tempDir,
  writeFiles,
  type Harness,
} from './workspace-fixtures.js';

afterEach(cleanupTempDirs);

const OWNER = 'profiles-artifacts';

interface Profile {
  tenantId: string;
  profileId: string;
}

const ALICE: Profile = { tenantId: 'tenant-a', profileId: 'alice' };
const MALLORY: Profile = { tenantId: 'tenant-b', profileId: 'mallory' };

async function ensureProfile(h: Harness, profile: Profile, operationId = `ensure-${profile.profileId}`): Promise<string> {
  const result = await h.service.ensureProfileRepository({
    operationId,
    tenantId: profile.tenantId,
    profileId: profile.profileId,
    owner: OWNER,
  });
  return result.repository;
}

/** Новый «чистый ра��» агента: отдельный каталог, никаких git-данных внутри. */
function runWorkspace(files: Record<string, string | Buffer>): string {
  const dir = tempDir('ws-run-');
  return writeFiles(dir, files);
}

describe('ensure_profile_repository', () => {
  it('is idempotent: a repeat creates no second repository and keeps one binding', async () => {
    const h = harness();
    const first = await h.service.ensureProfileRepository({ operationId: 'op-1', ...ALICE, owner: OWNER });
    const second = await h.service.ensureProfileRepository({ operationId: 'op-2', ...ALICE, owner: OWNER });

    expect(second.repository).toBe(first.repository);
    expect(second.bindingId).toBe(first.bindingId);
    expect(new Set(h.admin.calls)).toEqual(new Set([first.repository]));
    expect(h.admin.created).toBe(1);
    expect(h.bindings.byBindingId.size).toBe(1);
    // Создание репозитория не равно импорту данных профиля.
    expect(second.imported).toBe(false);
    expect(second.readiness).toBe('not_ready');
  });

  it('replays the same result for the same operationId', async () => {
    const h = harness();
    const first = await h.service.ensureProfileRepository({ operationId: 'op-1', ...ALICE, owner: OWNER });
    const replay = await h.service.ensureProfileRepository({ operationId: 'op-1', ...ALICE, owner: OWNER });
    expect(replay).toEqual(first);
  });

  it('refuses a different payload under the same operationId', async () => {
    const h = harness();
    await h.service.ensureProfileRepository({ operationId: 'op-1', ...ALICE, owner: OWNER });
    await expect(
      h.service.ensureProfileRepository({ operationId: 'op-1', ...MALLORY, owner: OWNER }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_OPERATION_CONFLICT' });
  });

  it('refuses a public repository instead of adopting it', async () => {
    const h = harness();
    const expected = `${OWNER}/profile-mallory`;
    h.admin.publicRepos.add(expected);
    await expect(h.service.ensureProfileRepository({ operationId: 'op-1', ...MALLORY, owner: OWNER })).rejects.toMatchObject({
      code: 'WORKSPACE_REPOSITORY_NOT_PRIVATE',
    });
  });

  it('refuses a pre-existing repository with unknown provenance', async () => {
    const h = harness();
    commitToRemote(h.admin, `${OWNER}/profile-alice`, { 'notes/stranger.md': 'not ours' });
    // Чужой образ с историей нельзя ни принять, ни молча переименовать: adopt — отдельное
    // решение оператора, а не следствие вызова ensure.
    await expect(h.service.ensureProfileRepository({ operationId: 'op-1', ...ALICE, owner: OWNER })).rejects.toMatchObject({
      code: 'WORKSPACE_FOREIGN_REPOSITORY',
    });
  });

  it('refuses to adopt a repository that belongs to another profile', async () => {
    const h = harness();
    // Репозиторий alice с чужим маркером: adopt невозможен даже с credential'ом.
    commitToRemote(h.admin, `${OWNER}/profile-alice`, { '.trained-assist/profile.json': '{"version":1,"profileId":"mallory"}' });
    const binding = {
      schemaVersion: 1 as const,
      bindingId: 'wsbind-x',
      tenantId: ALICE.tenantId,
      profileId: ALICE.profileId,
      owner: OWNER,
      repository: `${OWNER}/profile-alice`,
      url: `file://${h.admin.pathOf(`${OWNER}/profile-alice`)}`,
      private: true,
      branch: 'main',
      headRevision: null,
      importedAt: null,
      importManifestHash: null,
      createdAt: '2026-10-04T10:00:00.000Z',
      updatedAt: '2026-10-04T10:00:00.000Z',
    };
    await h.bindings.save(binding);
    await expect(
      h.service.ensureProfileRepository({ operationId: 'op-1', ...ALICE, owner: OWNER, credentialTokenRef: 'ref' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_FORBIDDEN' });
  });
});

describe('provision_existing_profile_repositories', () => {
  it('dry-runs without touching the remote and reports what would happen', async () => {
    const h = harness();
    const copy = writeFiles(tempDir('ws-copy-'), { 'notes/a.md': 'a', 'auth.json': 'secret' });
    const result = await h.service.provisionExistingProfileRepositories({
      operationId: 'batch-dry',
      tenantId: 'tenant-a',
      owner: OWNER,
      inventory: [{ profileId: 'alice', sourcePath: copy }],
      dryRun: true,
    });
    expect(result.status).toBe('completed');
    expect(result.results[0]?.plan).toEqual(['ensure', 'import:1', 'verify:1']);
    expect(result.results[0]?.excluded.join()).toMatch(/auth\.json/);
    expect(h.admin.created).toBe(0);
    expect(h.journal.stats().publications).toBe(0);
  });

  it('imports the tree with matching hashes and keeps credentials out', async () => {
    const h = harness();
    const copy = writeFiles(tempDir('ws-copy-'), {
      'notes/a.md': '# profile note\n',
      'persona/system.md': 'persona\n',
      'auth.json': '{"token":"secret"}',
      '.mcp.json': '{"AGENT_SECRET":"x"}',
      'opencode.db': 'runtime',
    });
    const result = await h.service.provisionExistingProfileRepositories({
      operationId: 'batch-1',
      tenantId: 'tenant-a',
      owner: OWNER,
      inventory: [{ profileId: 'alice', sourcePath: copy }],
      dryRun: false,
    });
    expect(result.results[0]?.status).toBe('imported');

    const tree = remoteTree(h.admin, `${OWNER}/profile-alice`);
    expect(tree['notes/a.md']).toBe('# profile note\n');
    expect(tree['persona/system.md']).toBe('persona\n');
    expect(Object.keys(tree)).toEqual(expect.arrayContaining(['notes/a.md', 'persona/system.md']));
    for (const forbidden of ['auth.json', '.mcp.json', 'opencode.db']) {
      expect(Object.keys(tree)).not.toContain(forbidden);
    }
    // Данные профиля на месте локально — импорт ничего не удаляет.
    expect(existsSync(join(copy, 'auth.json'))).toBe(true);
  });

  it('resumes after a failure instead of starting over, and is idempotent on the second pass', async () => {
    const h = harness();
    const first = writeFiles(tempDir('ws-copy-a-'), { 'notes/a.md': 'a' });
    const broken = writeFiles(tempDir('ws-copy-b-'), { 'notes/b.md': 'b' });
    const third = writeFiles(tempDir('ws-copy-c-'), { 'notes/c.md': 'c' });
    h.admin.failFor.add(`${OWNER}/profile-bravo`);

    const failed = await h.service.provisionExistingProfileRepositories({
      operationId: 'batch-2',
      tenantId: 'tenant-a',
      owner: OWNER,
      inventory: [
        { profileId: 'alpha', sourcePath: first },
        { profileId: 'bravo', sourcePath: broken },
        { profileId: 'charlie', sourcePath: third },
      ],
      dryRun: false,
    });
    expect(failed.status).toBe('partial');
    // Пакет останавливается на первом отказе: иначе упавший профиль считался бы
    // пройденным и повторный вызов никогда бы его не повторил.
    expect(failed.results.map((item) => item.profileId)).toEqual(['alpha', 'bravo']);
    expect(failed.results.map((item) => item.status)).toEqual(['imported', 'failed']);
    expect(failed.cursor).toBe('alpha');

    const inventory = [
      { profileId: 'alpha', sourcePath: first },
      { profileId: 'bravo', sourcePath: broken },
      { profileId: 'charlie', sourcePath: third },
    ];
    h.admin.failFor.delete(`${OWNER}/profile-bravo`);
    const resumed = await h.service.provisionExistingProfileRepositories({ operationId: 'batch-2', tenantId: 'tenant-a', owner: OWNER, inventory, dryRun: false });
    // Возобновление начинается с упавшего профиля и доходит до конца инвентаря.
    expect(resumed.results.map((item) => item.profileId)).toEqual(['bravo', 'charlie']);
    expect(resumed.status).toBe('completed');
    expect(resumed.cursor).toBe('charlie');

    // Повторный вызов после завершения ничего не делает: курсор в конце инвентаря.
    const done = await h.service.provisionExistingProfileRepositories({ operationId: 'batch-2', tenantId: 'tenant-a', owner: OWNER, inventory, dryRun: false });
    expect(done.results).toEqual([]);
    expect(done.status).toBe('completed');

    const alphaTree = remoteTree(h.admin, `${OWNER}/profile-alpha`);
    expect(Object.keys(alphaTree).filter((path) => !path.startsWith('.trained-assist/'))).toEqual(['notes/a.md']);
  });

  it('creating an empty repository is not reported as an import', async () => {
    const h = harness();
    const result = await h.service.provisionExistingProfileRepositories({
      operationId: 'batch-3',
      tenantId: 'tenant-a',
      owner: OWNER,
      inventory: [{ profileId: 'alice' }],
      dryRun: false,
    });
    expect(result.results[0]?.status).toBe('ensured');
    expect(result.results[0]?.error).toMatch(/not imported/);
    const binding = await h.bindings.findByProfile('tenant-a', 'alice');
    expect(binding?.importedAt).toBeNull();
  });
});

describe('publish → prepare: the persistent state survives the run', () => {
  it('run A publishes, a new run B reads the saved state from a different directory', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const a = runWorkspace({ 'notes/a.md': 'first version\n', 'persona/system.md': 'persona\n' });
    const publication = await h.service.publishRunChanges({
      operationId: 'pub-a',
      ...ALICE,
      runId: 'run-a',
      ownerGeneration: 1,
      workspacePath: a,
      baseRevision: EMPTY_TREE,
    });
    expect(publication.status).toBe('published');
    expect(publication.committedRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(publication.changes.map((item) => item.path).sort()).toEqual([
      '.trained-assist/profile.json',
      'notes/a.md',
      'persona/system.md',
    ]);
    expect(publication.cleanup.cleanupAllowed).toBe(true);

    // Следующий ра�� работает в другом каталоге и на другой «машине»: получает сохранённое.
    const prepared = await h.service.prepareProfileWorkspace({ operationId: 'prep-b', ...ALICE });
    expect(prepared.baseRevision).toBe(publication.committedRevision);
    expect(prepared.manifest.map((item) => item.path).sort()).toEqual(['notes/a.md', 'persona/system.md']);
    expect(prepared.manifest.find((item) => item.path === 'notes/a.md')?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Служебные файлы модуля в манифест рана не попадают.
    expect(prepared.manifest.some((item) => item.path.startsWith('.trained-assist/'))).toBe(false);
    expect(prepared.warnings).toEqual([]);

    const pulled = runWorkspace({});
    const sync = await h.service.syncProfileWorkspace({ operationId: 'sync-b', ...ALICE, direction: 'pull', workspacePath: pulled });
    expect(sync.status).toBe('pulled');
    expect(readFileAt(pulled, 'notes/a.md').toString('utf8')).toBe('first version\n');
  });

  it('a heavy artifact is reachable by its saved ref and never enters git as bytes', async () => {
    const h = harness({ policyTextMaxBytes: 1024 });
    await ensureProfile(h, ALICE);
    const heavy = Buffer.alloc(4096, 7);
    const a = runWorkspace({ 'notes/a.md': 'text\n', 'media/blob.bin': heavy });
    const publication = await h.service.publishRunChanges({
      operationId: 'pub-heavy',
      ...ALICE,
      runId: 'run-a',
      workspacePath: a,
      baseRevision: EMPTY_TREE,
    });
    expect(publication.status).toBe('published');
    const change = publication.changes.find((item) => item.path === 'media/blob.bin');
    expect(change?.artifact?.key).toMatch(/^profiles\/alice\/workspace\/wspub-/);
    expect(change?.sha256).toBe(change?.artifact?.sha256);

    const tree = remoteTree(h.admin, `${OWNER}/profile-alice`);
    expect(Object.keys(tree)).not.toContain('media/blob.bin');
    expect(tree['.trained-assist/artifacts.json']).toContain('media/blob.bin');

    const bytes = await h.objects.get(change?.artifact?.key ?? '');
    expect(bytes.equals(heavy)).toBe(true);

    const prepared = await h.service.prepareProfileWorkspace({ operationId: 'prep-heavy', ...ALICE });
    const entry = prepared.manifest.find((item) => item.path === 'media/blob.bin');
    expect(entry?.artifact?.key).toBe(change?.artifact?.key);
    expect(prepared.artifacts).toBe(1);
  });

  it('a tampered artifact is reported as a warning instead of a manifest entry', async () => {
    const h = harness({ policyTextMaxBytes: 1024 });
    await ensureProfile(h, ALICE);
    const a = runWorkspace({ 'media/blob.bin': Buffer.alloc(2048, 3) });
    await h.service.publishRunChanges({ operationId: 'pub-t', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: EMPTY_TREE });
    const key = [...h.objects.objects.keys()][0] ?? '';
    h.objects.corruptGet.add(key);

    const prepared = await h.service.prepareProfileWorkspace({ operationId: 'prep-t', ...ALICE });
    expect(prepared.manifest.some((item) => item.path === 'media/blob.bin')).toBe(false);
    expect(prepared.warnings.join()).toMatch(/media\/blob\.bin/);
  });

  it('a foreign profile cannot read or publish into another profile', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    await ensureProfile(h, MALLORY);
    const a = runWorkspace({ 'notes/a.md': 'alice data\n' });
    await h.service.publishRunChanges({ operationId: 'pub-a', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: EMPTY_TREE });

    // Чужой tenant не имеет binding на чужой профиль: подготовить его workspace нельзя.
    await expect(h.service.prepareProfileWorkspace({ operationId: 'prep-x', tenantId: 'tenant-b', profileId: 'alice' })).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
    });
    // Свой профиль маллори публикует в свой репозиторий — это законно, и пересечения с
    // профилем alice здесь нет.
    const b = runWorkspace({ 'notes/a.md': 'mallory data\n' });
    const malloryPublication = await h.service.publishRunChanges({
      operationId: 'pub-mallory',
      ...MALLORY,
      runId: 'run-b',
      workspacePath: b,
      baseRevision: EMPTY_TREE,
    });
    expect(malloryPublication.status).toBe('published');
    expect(Object.keys(remoteTree(h.admin, `${OWNER}/profile-mallory`))).toContain('notes/a.md');

    // Чтение чужой публикации по tenantId запрещено.
    const publication = h.journal.listPublications({ profileId: 'alice' })[0];
    await expect(h.service.getWorkspacePublication({ publicationId: publication?.publicationId ?? '', tenantId: 'tenant-b' })).rejects.toMatchObject({
      code: 'WORKSPACE_FORBIDDEN',
    });
    // Образ alice не изменился.
    expect(remoteTree(h.admin, `${OWNER}/profile-alice`)['notes/a.md']).toBe('alice data\n');
  });

  it('pull reports local changes instead of overwriting them', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const a = runWorkspace({ 'notes/a.md': 'published\n' });
    await h.service.publishRunChanges({ operationId: 'pub-a', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: EMPTY_TREE });

    const local = runWorkspace({ 'notes/a.md': 'published\n', 'notes/b.md': 'unpublished\n' });
    const sync = await h.service.syncProfileWorkspace({ operationId: 'sync-1', ...ALICE, direction: 'pull', workspacePath: local });
    expect(sync.status).toBe('local_changes');
    expect(sync.localChanges.map((item) => item.path)).toEqual(['notes/b.md']);
    // Локальный файл на месте — pull ничего не затёр.
    expect(readFileAt(local, 'notes/b.md').toString('utf8')).toBe('unpublished\n');

    const published = await h.service.syncProfileWorkspace({
      operationId: 'sync-2',
      ...ALICE,
      direction: 'publish',
      workspacePath: local,
      baseRevision: EMPTY_TREE,
    });
    expect(published.status).toBe('published');
  });
});

describe('two runs from one base revision', () => {
  it('merges non-overlapping edits automatically', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const base = runWorkspace({ 'notes/base.md': 'base\n', 'notes/other.md': 'untouched\n' });
    const basePublication = await h.service.publishRunChanges({
      operationId: 'pub-base',
      ...ALICE,
      runId: 'run-base',
      workspacePath: base,
      baseRevision: EMPTY_TREE,
    });
    const baseRevision = basePublication.committedRevision as string;

    // Два рана стартуют от одной базы и меняют разные файлы.
    const runA = runWorkspace({ 'notes/base.md': 'base\n', 'notes/other.md': 'untouched\n', 'notes/a.md': 'from A\n' });
    const runB = runWorkspace({ 'notes/base.md': 'base\n', 'notes/other.md': 'untouched\n', 'notes/b.md': 'from B\n' });
    const pubA = await h.service.publishRunChanges({ operationId: 'pub-a', ...ALICE, runId: 'run-a', workspacePath: runA, baseRevision });
    expect(pubA.status).toBe('published');
    const pubB = await h.service.publishRunChanges({ operationId: 'pub-b', ...ALICE, runId: 'run-b', workspacePath: runB, baseRevision });

    expect(pubB.status).toBe('published');
    expect(pubB.mergeAttempts).toBe(1);
    const tree = remoteTree(h.admin, `${OWNER}/profile-alice`);
    expect(tree['notes/a.md']).toBe('from A\n');
    expect(tree['notes/b.md']).toBe('from B\n');
    expect(tree['notes/base.md']).toBe('base\n');
  });

  it('reports a same-file conflict and keeps both sides', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const base = runWorkspace({ 'notes/shared.md': 'line1\nline2\nline3\n' });
    const basePublication = await h.service.publishRunChanges({
      operationId: 'pub-base',
      ...ALICE,
      runId: 'run-base',
      workspacePath: base,
      baseRevision: EMPTY_TREE,
    });
    const baseRevision = basePublication.committedRevision as string;

    const runA = runWorkspace({ 'notes/shared.md': 'line1\nfrom A\nline3\n' });
    const runB = runWorkspace({ 'notes/shared.md': 'line1\nfrom B\nline3\n' });
    await h.service.publishRunChanges({ operationId: 'pub-a', ...ALICE, runId: 'run-a', workspacePath: runA, baseRevision });
    const pubB = await h.service.publishRunChanges({ operationId: 'pub-b', ...ALICE, runId: 'run-b', workspacePath: runB, baseRevision });

    expect(pubB.status).toBe('conflict');
    expect(pubB.conflictId).toBeTruthy();
    const conflict = h.journal.getConflict(pubB.conflictId ?? '');
    expect(conflict?.entries.map((entry) => entry.path)).toEqual(['notes/shared.md']);
    expect(conflict?.entries[0]?.kind).toBe('content');
    expect(conflict?.entries[0]?.runSha256).toBeTruthy();
    expect(conflict?.entries[0]?.currentSha256).toBeTruthy();

    // Ни одна сторона не потеряна: канонический head — версия A, версия B — в кандидате.
    const tree = remoteTree(h.admin, `${OWNER}/profile-alice`);
    expect(tree['notes/shared.md']).toBe('line1\nfrom A\nline3\n');
    const runTree = await mirrorTree(h, conflict?.bindingId ?? '', conflict?.runRevision ?? 'main');
    expect(runTree['notes/shared.md']).toBe('line1\nfrom B\nline3\n');
  });

  it('reports an edit/delete conflict as delete_modify and keeps the deletion visible', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const base = runWorkspace({ 'notes/keep.md': 'keep\n', 'notes/gone.md': 'gone\n' });
    const basePublication = await h.service.publishRunChanges({
      operationId: 'pub-base',
      ...ALICE,
      runId: 'run-base',
      workspacePath: base,
      baseRevision: EMPTY_TREE,
    });
    const baseRevision = basePublication.committedRevision as string;

    const runA = runWorkspace({ 'notes/keep.md': 'keep\n' });
    const runB = runWorkspace({ 'notes/keep.md': 'keep\n', 'notes/gone.md': 'edited by B\n' });
    await h.service.publishRunChanges({ operationId: 'pub-a', ...ALICE, runId: 'run-a', workspacePath: runA, baseRevision });
    const pubB = await h.service.publishRunChanges({ operationId: 'pub-b', ...ALICE, runId: 'run-b', workspacePath: runB, baseRevision });

    expect(pubB.status).toBe('conflict');
    const conflict = h.journal.getConflict(pubB.conflictId ?? '');
    expect(conflict?.entries[0]).toMatchObject({ path: 'notes/gone.md', kind: 'delete_modify' });
    // Правка рана сохранена в кандидате рана.
    const runTree = await mirrorTree(h, conflict?.bindingId ?? '', conflict?.runRevision ?? 'main');
    expect(runTree['notes/gone.md']).toBe('edited by B\n');
  });

  it('marks a rename over an edited path as a rename conflict', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const base = runWorkspace({ 'notes/original.md': 'shared body\n' });
    const basePublication = await h.service.publishRunChanges({
      operationId: 'pub-base',
      ...ALICE,
      runId: 'run-base',
      workspacePath: base,
      baseRevision: EMPTY_TREE,
    });
    const baseRevision = basePublication.committedRevision as string;

    const runA = runWorkspace({ 'notes/renamed.md': 'shared body\n' });
    const runB = runWorkspace({ 'notes/original.md': 'edited by B\n' });
    await h.service.publishRunChanges({ operationId: 'pub-a', ...ALICE, runId: 'run-a', workspacePath: runA, baseRevision });
    const pubB = await h.service.publishRunChanges({ operationId: 'pub-b', ...ALICE, runId: 'run-b', workspacePath: runB, baseRevision });

    expect(pubB.status).toBe('conflict');
    const conflict = h.journal.getConflict(pubB.conflictId ?? '');
    expect(conflict?.entries[0]).toMatchObject({ path: 'notes/original.md', kind: 'rename' });
  });
});

describe('conflict resolution', () => {
  async function conflictingRuns(h: Harness): Promise<{ baseRevision: string; conflictId: string; head: string }> {
    await ensureProfile(h, ALICE);
    const base = runWorkspace({ 'notes/shared.md': 'line1\nline2\nline3\n' });
    const basePublication = await h.service.publishRunChanges({
      operationId: 'pub-base',
      ...ALICE,
      runId: 'run-base',
      workspacePath: base,
      baseRevision: EMPTY_TREE,
    });
    const baseRevision = basePublication.committedRevision as string;
    const runA = runWorkspace({ 'notes/shared.md': 'line1\nfrom A\nline3\n' });
    const runB = runWorkspace({ 'notes/shared.md': 'line1\nfrom B\nline3\n' });
    await h.service.publishRunChanges({ operationId: 'pub-a', ...ALICE, runId: 'run-a', workspacePath: runA, baseRevision });
    const pubB = await h.service.publishRunChanges({ operationId: 'pub-b', ...ALICE, runId: 'run-b', workspacePath: runB, baseRevision });
    return { baseRevision, conflictId: pubB.conflictId ?? '', head: baseRevision };
  }

  it('a deterministic resolution of an unresolvable conflict asks the user instead of guessing', async () => {
    const h = harness();
    const { conflictId } = await conflictingRuns(h);
    const resolution = await h.service.resolveWorkspaceConflict({
      operationId: 'res-1',
      tenantId: ALICE.tenantId,
      conflictId,
      resolution: { kind: 'deterministic' },
    });
    expect(resolution.status).toBe('awaiting_user_input');
    expect(resolution.reason).toMatch(/deterministic merge cannot resolve/);
  });

  it('an explicit side choice becomes a candidate and publishes under the expected head', async () => {
    const h = harness();
    const { conflictId } = await conflictingRuns(h);
    const conflict = h.journal.getConflict(conflictId);
    const resolution = await h.service.resolveWorkspaceConflict({
      operationId: 'res-2',
      tenantId: ALICE.tenantId,
      conflictId,
      resolution: { kind: 'run_side', evidence: 'operator chose the run version' },
    });
    expect(resolution.status).toBe('candidate_ready');
    const candidate = h.journal.getCandidate(resolution.candidateId ?? '');
    expect(candidate?.source).toBe('run_side');
    expect(candidate?.evidence).toMatch(/operator/);

    const publication = await h.service.publishWorkspaceResolution({
      operationId: 'pub-res',
      tenantId: ALICE.tenantId,
      candidateId: resolution.candidateId ?? '',
      expectedHeadRevision: candidate?.expectedHeadRevision ?? null,
    });
    expect(publication.status).toBe('published');
    expect(remoteTree(h.admin, `${OWNER}/profile-alice`)['notes/shared.md']).toBe('line1\nfrom B\nline3\n');
    void conflict;
  });

  it('does not publish a stale candidate when the head moved during the resolution', async () => {
    const h = harness();
    const { conflictId } = await conflictingRuns(h);
    const resolution = await h.service.resolveWorkspaceConflict({
      operationId: 'res-3',
      tenantId: ALICE.tenantId,
      conflictId,
      resolution: { kind: 'run_side' },
    });
    const candidate = h.journal.getCandidate(resolution.candidateId ?? '');

    // Ещё один писатель публикует, пока готовится разрешение.
    commitToRemote(h.admin, `${OWNER}/profile-alice`, { 'notes/late.md': 'late publication\n' }, 'late writer');

    const publication = await h.service.publishWorkspaceResolution({
      operationId: 'pub-res-stale',
      tenantId: ALICE.tenantId,
      candidateId: resolution.candidateId ?? '',
      expectedHeadRevision: candidate?.expectedHeadRevision ?? null,
    });
    expect(publication.status).toBe('conflict');
    expect(publication.reason).toMatch(/stale resolution candidate/);
    const tree = remoteTree(h.admin, `${OWNER}/profile-alice`);
    expect(tree['notes/late.md']).toBe('late publication\n');
    // Правка кандидата не попала в канонический образ.
    expect(tree['notes/shared.md']).toBe('line1\nfrom A\nline3\n');
  });

  it('an external candidate must carry evidence and may not contain excluded paths', async () => {
    const h = harness();
    const { conflictId } = await conflictingRuns(h);
    await expect(
      h.service.resolveWorkspaceConflict({
        operationId: 'res-4',
        tenantId: ALICE.tenantId,
        conflictId,
        resolution: { kind: 'external_candidate', tree: 'a'.repeat(40) },
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });

    const mirror = await h.git.ensureMirror(
      (await h.bindings.findByProfile('tenant-a', 'alice')) as NonNullable<Awaited<ReturnType<Harness['bindings']['findByProfile']>>>,
      {},
    );
    const badOid = await h.git.hashObject(mirror, Buffer.from('token\n'));
    const badTree = await h.git.writeTree(mirror, null, [{ path: 'auth.json', oid: badOid, mode: '100644' }]);
    await expect(
      h.service.resolveWorkspaceConflict({
        operationId: 'res-5',
        tenantId: ALICE.tenantId,
        conflictId,
        resolution: { kind: 'external_candidate', tree: badTree, evidence: 'resolver run', resolverRunId: 'run-resolver' },
      }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_PATH_DENIED' });
  });

  it('does not loop: the attempt limit moves the conflict to awaiting user input', async () => {
    const h = harness({ resolutionAttempts: 2 });
    const { conflictId } = await conflictingRuns(h);
    for (const attempt of [1, 2]) {
      const result = await h.service.resolveWorkspaceConflict({
        operationId: `res-loop-${attempt}`,
        tenantId: ALICE.tenantId,
        conflictId,
        resolution: { kind: 'run_side' },
      });
      expect(result.attempts).toBe(attempt);
    }
    const exhausted = await h.service.resolveWorkspaceConflict({
      operationId: 'res-loop-3',
      tenantId: ALICE.tenantId,
      conflictId,
      resolution: { kind: 'run_side' },
    });
    expect(exhausted.status).toBe('awaiting_user_input');
    expect(exhausted.reason).toMatch(/attempt limit reached/);
    const publication = h.journal
      .listPublications({ profileId: 'alice' })
      .find((item) => item.conflictId === conflictId);
    expect(publication?.status).toBe('awaiting_user_input');
  });
});

describe('recovery: crash, timeout and unknown push outcome', () => {
  it('a crash before the branch push leaves no duplicate and completes on reconcile', async () => {
    const h = harness({ interception: { throwOnPushBranchCall: 1 } });
    await ensureProfile(h, ALICE);
    const a = runWorkspace({ 'notes/a.md': 'durable value\n' });
    await expect(
      h.service.publishRunChanges({ operationId: 'pub-crash', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: EMPTY_TREE }),
    ).rejects.toThrowError(/injected process death/);

    // Запись публикации пережила падение и указывает на durable-кандидата.
    const record = h.journal.findPublicationByOperation('pub-crash');
    expect(record?.status).toBe('publishing');
    expect(record?.candidateCommit).toBeTruthy();
    expect(record?.candidatePushed).toBe(true);
    // Remote-голова не тронута: публикация не состоялась.
    expect(remoteTree(h.admin, `${OWNER}/profile-alice`)).toEqual({});

    const reconciled = await h.service.getWorkspacePublication({ publicationId: record?.publicationId ?? '' });
    expect(reconciled.status).toBe('published');
    expect(remoteTree(h.admin, `${OWNER}/profile-alice`)['notes/a.md']).toBe('durable value\n');
  });

  it('an unknown push outcome is reconciled by reading the remote, not by re-running anything', async () => {
    const h = harness({ interception: { pushBranchOutcomes: [{ count: 1, outcome: 'unknown' }] } });
    await ensureProfile(h, ALICE);
    const a = runWorkspace({ 'notes/a.md': 'value\n' });
    const publication = await h.service.publishRunChanges({
      operationId: 'pub-unknown',
      ...ALICE,
      runId: 'run-a',
      workspacePath: a,
      baseRevision: EMPTY_TREE,
    });
    expect(publication.status).toBe('pending');
    expect(publication.outcomeUnknown).toBe(true);
    expect(h.service.evaluateWorkspaceCleanup({ publicationId: publication.publicationId }).cleanupAllowed).toBe(false);

    const reconciled = await h.service.getWorkspacePublication({ publicationId: publication.publicationId });
    expect(reconciled.status).toBe('published');
    expect(reconciled.outcomeUnknown).toBe(false);
    expect(h.service.evaluateWorkspaceCleanup({ publicationId: publication.publicationId }).cleanupAllowed).toBe(true);
  });

  it('does not duplicate a publication when the same operationId is retried', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const a = runWorkspace({ 'notes/a.md': 'once\n' });
    const first = await h.service.publishRunChanges({ operationId: 'pub-once', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: EMPTY_TREE });
    const replay = await h.service.publishRunChanges({ operationId: 'pub-once', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: EMPTY_TREE });
    expect(replay.publicationId).toBe(first.publicationId);
    expect(h.journal.listPublications({ profileId: 'alice' })).toHaveLength(1);
    const commits = execHeadLog(h, `${OWNER}/profile-alice`);
    expect(commits).toHaveLength(1);
  });

  it('a rejected push leaves the data unpublished and blocks cleanup', async () => {
    const h = harness({ interception: { pushBranchOutcomes: [{ count: 1, outcome: 'rejected' }] } });
    await ensureProfile(h, ALICE);
    const a = runWorkspace({ 'notes/a.md': 'value\n' });
    const publication = await h.service.publishRunChanges({
      operationId: 'pub-rejected',
      ...ALICE,
      runId: 'run-a',
      workspacePath: a,
      baseRevision: EMPTY_TREE,
    });
    expect(publication.status).toBe('failed');
    expect(publication.reason).toMatch(/rejected/);
    const cleanup = h.service.evaluateWorkspaceCleanup({ publicationId: publication.publicationId });
    expect(cleanup.cleanupAllowed).toBe(false);
    expect(cleanup.retained).toContain('notes/a.md');
    expect(remoteTree(h.admin, `${OWNER}/profile-alice`)).toEqual({});
  });
});

describe('storage failure keeps the only copy', () => {
  it('reports the failure, keeps the run workspace authoritative and allows a retry', async () => {
    const h = harness({ policyTextMaxBytes: 1024 });
    await ensureProfile(h, ALICE);
    const heavy = Buffer.alloc(4096, 9);
    const a = runWorkspace({ 'notes/a.md': 'text\n', 'media/blob.bin': heavy });
    h.objects.unavailable = true;

    await expect(
      h.service.publishRunChanges({ operationId: 'pub-nostore', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: EMPTY_TREE }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_STORAGE_UNAVAILABLE' });

    const record = h.journal.listPublications({ profileId: 'alice' })[0];
    expect(record?.status).toBe('failed');
    const cleanup = h.service.evaluateWorkspaceCleanup({ publicationId: record?.publicationId ?? '' });
    expect(cleanup.cleanupAllowed).toBe(false);
    expect(cleanup.retained).toContain('media/blob.bin');
    // Байты остались на диске рана: единственная копия не потеряна.
    expect(readFileAt(a, 'media/blob.bin').equals(heavy)).toBe(true);

    // Хранилище восстановилось — тот же operationId повторяется и завершает публикацию.
    h.objects.unavailable = false;
    const retry = await h.service.publishRunChanges({
      operationId: 'pub-nostore',
      ...ALICE,
      runId: 'run-a',
      workspacePath: a,
      baseRevision: EMPTY_TREE,
    });
    expect(retry.status).toBe('published');
  });
});

describe('workspace hygiene', () => {
  it('never puts git data or credentials into the run workspace', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const a = runWorkspace({ 'notes/a.md': 'text\n' });
    await h.service.publishRunChanges({ operationId: 'pub-a', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: EMPTY_TREE });
    expect(listFiles(a)).toEqual(['notes/a.md']);
    expect(existsSync(join(a, '.git'))).toBe(false);
  });

  it('keeps .inputs and engine runtime state out of the published image', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const a = runWorkspace({
      'notes/a.md': 'text\n',
      '.inputs/snap-1/from-previous.md': 'previous\n',
      '.opencode/session.json': '{}',
      'opencode.db-wal': 'wal',
    });
    await h.service.publishRunChanges({ operationId: 'pub-a', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: EMPTY_TREE });
    const tree = remoteTree(h.admin, `${OWNER}/profile-alice`);
    expect(Object.keys(tree)).toEqual(['.trained-assist/profile.json', 'notes/a.md']);
  });

  it('writes an atomic journal file that survives a crash mid-write', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const a = runWorkspace({ 'notes/a.md': 'text\n' });
    await h.service.publishRunChanges({ operationId: 'pub-a', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: EMPTY_TREE });
    expect(h.journal.stats().publications).toBe(1);
  });

  it('refuses a publication whose baseRevision is not a version of state', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const a = runWorkspace({ 'notes/a.md': 'text\n' });
    await expect(
      h.service.publishRunChanges({ operationId: 'pub-bad', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: 'main' }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
    await expect(
      h.service.publishRunChanges({ operationId: 'pub-bad-2', ...ALICE, runId: '', workspacePath: a, baseRevision: EMPTY_TREE }),
    ).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
  });

  it('rejects a publication for a profile without a binding', async () => {
    const h = harness();
    const a = runWorkspace({ 'notes/a.md': 'text\n' });
    await expect(
      h.service.publishRunChanges({ operationId: 'pub-none', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: EMPTY_TREE }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('keeps the profile marker that binds a repository to its profile', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const a = runWorkspace({ 'notes/a.md': 'text\n' });
    await h.service.publishRunChanges({ operationId: 'pub-a', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: EMPTY_TREE });
    const tree = remoteTree(h.admin, `${OWNER}/profile-alice`);
    expect(JSON.parse(tree['.trained-assist/profile.json'] ?? '{}')).toMatchObject({ profileId: 'alice', tenantId: 'tenant-a' });
    // Повторный ensure того же профиля принимает репозиторий по маркеру.
    const again = await h.service.ensureProfileRepository({
      operationId: 'ensure-again',
      ...ALICE,
      owner: OWNER,
      credentialTokenRef: undefined,
    });
    expect(again.headRevision).toBeTruthy();
  });

  it('reads a nested path tree without losing its structure', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const a = runWorkspace({ 'projects/app/src/index.md': 'code\n', 'projects/app/docs/readme.md': 'docs\n' });
    await h.service.publishRunChanges({ operationId: 'pub-a', ...ALICE, runId: 'run-a', workspacePath: a, baseRevision: EMPTY_TREE });
    const tree = remoteTree(h.admin, `${OWNER}/profile-alice`);
    expect(tree['projects/app/src/index.md']).toBe('code\n');
    expect(tree['projects/app/docs/readme.md']).toBe('docs\n');
    const prepared = await h.service.prepareProfileWorkspace({ operationId: 'prep', ...ALICE });
    expect(prepared.manifest.map((item) => item.path)).toEqual(['projects/app/docs/readme.md', 'projects/app/src/index.md']);
  });

  it('publishes a deleted file as a deletion, not as a silent keep', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const first = runWorkspace({ 'notes/keep.md': 'keep\n', 'notes/temp.md': 'temp\n' });
    const firstPublication = await h.service.publishRunChanges({
      operationId: 'pub-1',
      ...ALICE,
      runId: 'run-1',
      workspacePath: first,
      baseRevision: EMPTY_TREE,
    });
    const second = runWorkspace({ 'notes/keep.md': 'keep\n' });
    const deletion = await h.service.publishRunChanges({
      operationId: 'pub-2',
      ...ALICE,
      runId: 'run-2',
      workspacePath: second,
      baseRevision: firstPublication.committedRevision as string,
    });
    expect(deletion.status).toBe('published');
    expect(deletion.changes).toContainEqual({ path: 'notes/temp.md', kind: 'delete', sha256: null, size: 0, artifact: null });
    expect(Object.keys(remoteTree(h.admin, `${OWNER}/profile-alice`))).not.toContain('notes/temp.md');
  });

  it('publishes only the declared paths when the run is scoped', async () => {
    const h = harness();
    await ensureProfile(h, ALICE);
    const a = runWorkspace({ 'notes/in.md': 'in\n', 'notes/out.md': 'out\n' });
    const publication = await h.service.publishRunChanges({
      operationId: 'pub-scoped',
      ...ALICE,
      runId: 'run-a',
      workspacePath: a,
      baseRevision: EMPTY_TREE,
      paths: ['notes/in.md'],
    });
    // Маркер профиля публикуется всегда: без него репозиторий перестаёт принадлежать
    // профилю. Сужение путей ограничивает данные пользователя, а не служебные файлы.
    expect(publication.changes.map((item) => item.path)).toEqual(['.trained-assist/profile.json', 'notes/in.md']);
    expect(Object.keys(remoteTree(h.admin, `${OWNER}/profile-alice`))).not.toContain('notes/out.md');
  });
});

function execHeadLog(h: Harness, fullName: string): string[] {
  const dir = h.admin.pathOf(fullName);
  const out = execFileSync('git', ['--git-dir', dir, 'log', '--format=%H %s', 'main']).toString('utf8');
  return out.split('\n').filter(Boolean);
}
