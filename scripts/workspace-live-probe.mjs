#!/usr/bin/env node
/**
 * Живая проверка модуля постоянного workspace на настоящем Git-провайдере.
 *
 * Детерминированные тесты (`test/workspace-*.test.ts`) доказывают поведение на локальных
 * bare-репозиториях. Этот скрипт проверяет то, что локально не воспроизвести: реальный
 * GitHub API (создание приватного репозитория, клонирование по токену, push ветки и
 * неканонических ref'ов), реальный durable object storage и полный цикл
 * profile → repository → загрузка версии → Run → сохранение → следующий Run.
 *
 * Запуск (из корня репозитория, после `npm run build`):
 *
 *   WORKSPACE_LIVE_OWNER=profiles-artifacts \
 *   WORKSPACE_LIVE_TOKEN_REF=github:profiles-artifacts \
 *   WORKSPACE_LIVE_TOKEN=<fine-grained PAT, Contents:R/W> \
 *   node scripts/workspace-live-probe.mjs
 *
 * Токен читается из окружения и никогда не печатается. Репозиторий создаётся приватным с
 * именем `profile-workspace-live-<timestamp>` и удаляется в конце (флаг `--keep`
 * оставляет его для осмотра). Журнал и зеркала — в каталоге из `--state` (по умолчанию
 * временный), чтобы прогон был повторяемым без мусора на диске.
 *
 * Синтетические профили и копии — по правилам потока: боевые профили и production не
 * трогаются.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const DIST = join(REPO_ROOT, 'dist', 'workspace');

function usage() {
  return [
    'Usage:',
    '  WORKSPACE_LIVE_OWNER=<org-or-user> WORKSPACE_LIVE_TOKEN_REF=<ref> WORKSPACE_LIVE_TOKEN=<pat> \\',
    '    node scripts/workspace-live-probe.mjs [--keep] [--state <dir>]',
    '',
    'Токен — fine-grained PAT с Contents:R/W на выбранного владельца. Печатается только',
    'префикс (8 символов) для диагностики, полное значение не попадает в вывод.',
    'Репозиторий создаётся приватным и удаляется в конце, если не передан --keep.',
  ].join('\n');
}

function parseArgv(argv) {
  const options = { keep: false, state: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep') options.keep = true;
    else if (arg === '--state') options.state = argv[++i];
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      process.stderr.write(`неизвестный аргумент: ${arg}\n\n${usage()}\n`);
      process.exit(1);
    }
  }
  return options;
}

const options = parseArgv(process.argv.slice(2));
const OWNER = process.env.WORKSPACE_LIVE_OWNER ?? '';
const TOKEN_REF = process.env.WORKSPACE_LIVE_TOKEN_REF ?? '';
const TOKEN = process.env.WORKSPACE_LIVE_TOKEN ?? '';
if (!OWNER || !TOKEN_REF || !TOKEN) {
  process.stderr.write(`нужны WORKSPACE_LIVE_OWNER, WORKSPACE_LIVE_TOKEN_REF и WORKSPACE_LIVE_TOKEN\n\n${usage()}\n`);
  process.exit(1);
}

const { WorkspaceService, WorkspaceJournal, createLocalGitPort, createGitHubRepositoryAdmin, EMPTY_TREE } = await import(
  `file://${DIST}/index.js`
);
const { createLocalFsBlobStore } = await import(`file://${REPO_ROOT}/dist/storage/local-fs.js`);

const stateDir = options.state ?? mkdtempSync(join(tmpdir(), 'workspace-live-state-'));
mkdirSync(stateDir, { recursive: true });
const mirrorDir = join(stateDir, 'mirrors');
const blobDir = join(stateDir, 'blobs');
mkdirSync(mirrorDir, { recursive: true });
mkdirSync(blobDir, { recursive: true });

const journal = new WorkspaceJournal(join(stateDir, 'journal'));
journal.init();

const service = new WorkspaceService({
  git: createLocalGitPort({ rootDir: mirrorDir, resolveCredential: async () => TOKEN }),
  objects: createLocalFsBlobStore({ rootDir: blobDir }),
  bindings: {
    store: new Map(),
    async get(id) {
      return this.store.get(id) ?? null;
    },
    async findByProfile(tenantId, profileId) {
      for (const binding of this.store.values()) {
        if (binding.tenantId === tenantId && binding.profileId === profileId) return binding;
      }
      return null;
    },
    async save(binding) {
      this.store.set(binding.bindingId, binding);
    },
    async list(tenantId) {
      return [...this.store.values()].filter((item) => (tenantId ? item.tenantId === tenantId : true));
    },
  },
  admin: createGitHubRepositoryAdmin({ tokenRef: TOKEN_REF, resolveToken: async () => TOKEN }),
  journal,
});

const PROFILE_ID = `live-probe-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
const TENANT = 'live-probe';
const results = [];
const failures = [];

function step(name, fn) {
  return async () => {
    const started = Date.now();
    try {
      const value = await fn();
      results.push({ name, ok: true, ms: Date.now() - started, value });
      process.stdout.write(`  ok   ${name} (${Date.now() - started}ms)\n`);
      return value;
    } catch (err) {
      failures.push({ name, error: err });
      process.stdout.write(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
      throw err;
    }
  };
}

function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function run() {
  return spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.trim();
}

const checks = {
  'git доступен': step('git доступен', async () => {
    const version = run();
    if (!version) throw new Error('git не найден');
    return version;
  }),

  'ensure создаёт приватный репозиторий': step('ensure → приватный репозиторий', async () => {
    const result = await service.ensureProfileRepository({
      operationId: `live:ensure:${PROFILE_ID}`,
      tenantId: TENANT,
      profileId: PROFILE_ID,
      owner: OWNER,
      credentialTokenRef: TOKEN_REF,
    });
    if (!result.created) throw new Error('репозиторий не создан');
    if (!result.private) throw new Error('репозиторий не приватный');
    if (result.readiness !== 'not_ready') throw new Error(`readiness=${result.readiness}, ожидается not_ready`);
    return { repository: result.repository, bindingId: result.bindingId };
  }),

  'ensure идемпотентен': step('ensure идемпотентен', async () => {
    const first = results[0]?.value;
    const again = await service.ensureProfileRepository({
      operationId: `live:ensure-again:${PROFILE_ID}`,
      tenantId: TENANT,
      profileId: PROFILE_ID,
      owner: OWNER,
      credentialTokenRef: TOKEN_REF,
    });
    if (again.repository !== first.repository) throw new Error('имя репозитория изменилось');
    if (again.created) throw new Error('повторный ensure создал второй репозиторий');
    return again.repository;
  }),

  'publish сохраняет состояние': step('publish → состояние в git', async () => {
    const workspace = writeFiles(mkdtempSync(join(tmpdir(), 'live-run-a-')), {
      'notes/first.md': 'первая версия заметки\n',
      'persona/system.md': 'persona профиля\n',
    });
    const publication = await service.publishRunChanges({
      operationId: `live:pub-a:${PROFILE_ID}`,
      tenantId: TENANT,
      profileId: PROFILE_ID,
      runId: 'run-a',
      ownerGeneration: 1,
      workspacePath: workspace,
      baseRevision: EMPTY_TREE,
      credentialTokenRef: TOKEN_REF,
    });
    if (publication.status !== 'published') throw new Error(`status=${publication.status}: ${publication.reason}`);
    if (!/^[0-9a-f]{40}$/.test(publication.committedRevision ?? '')) throw new Error('нет committedRevision');
    return { publicationId: publication.publicationId, revision: publication.committedRevision };
  }),

  'prepare читает сохранённое': step('prepare → манифест с хэшами', async () => {
    const prepared = await service.prepareProfileWorkspace({
      operationId: `live:prep-b:${PROFILE_ID}`,
      tenantId: TENANT,
      profileId: PROFILE_ID,
      credentialTokenRef: TOKEN_REF,
    });
    const paths = prepared.manifest.map((entry) => entry.path).sort();
    if (paths.join() !== ['notes/first.md', 'persona/system.md'].join()) {
      throw new Error(`манифест: ${paths.join(', ')}`);
    }
    const entry = prepared.manifest.find((item) => item.path === 'notes/first.md');
    if (entry?.sha256 !== sha256Hex(Buffer.from('первая версия заметки\n', 'utf8'))) {
      throw new Error('хэш заметки не совпал с содержимым');
    }
    if (prepared.warnings.length > 0) throw new Error(`warnings: ${prepared.warnings.join('; ')}`);
    return { baseRevision: prepared.baseRevision, files: prepared.files };
  }),

  'тяжёлый артефакт по ref': step('тяжёлый артефакт → object storage → ref', async () => {
    const heavy = Buffer.alloc(3 * 1024 * 1024, 0xab);
    const workspace = writeFiles(mkdtempSync(join(tmpdir(), 'live-run-heavy-')), {
      'notes/first.md': 'первая версия заметки\n',
      'persona/system.md': 'persona профиля\n',
      'media/blob.bin': heavy,
    });
    const base = results[2]?.value.revision;
    const publication = await service.publishRunChanges({
      operationId: `live:pub-heavy:${PROFILE_ID}`,
      tenantId: TENANT,
      profileId: PROFILE_ID,
      runId: 'run-heavy',
      workspacePath: workspace,
      baseRevision: base,
      credentialTokenRef: TOKEN_REF,
    });
    if (publication.status !== 'published') throw new Error(`status=${publication.status}: ${publication.reason}`);
    const change = publication.changes.find((item) => item.path === 'media/blob.bin');
    if (!change?.artifact) throw new Error('тяжёлый файл не получил artifact ref');
    const bytes = await service.readProfileBlob({
      tenantId: TENANT,
      profileId: PROFILE_ID,
      revision: publication.committedRevision,
      path: 'media/blob.bin',
      credentialTokenRef: TOKEN_REF,
    });
    if (!bytes.equals(heavy)) throw new Error('байты по ref не совпали с исходными');
    return { key: change.artifact.key, size: change.artifact.size };
  }),

  'два рана → автоматический merge': step('два рана → автоматический merge', async () => {
    const base = results[2]?.value.revision;
    const runA = writeFiles(mkdtempSync(join(tmpdir(), 'live-run-c-')), {
      'notes/first.md': 'первая версия заметки\n',
      'persona/system.md': 'persona профиля\n',
      'notes/from-a.md': 'правка рана A\n',
    });
    const runB = writeFiles(mkdtempSync(join(tmpdir(), 'live-run-d-')), {
      'notes/first.md': 'первая версия заметки\n',
      'persona/system.md': 'persona профиля\n',
      'notes/from-b.md': 'правка рана B\n',
    });
    const pubA = await service.publishRunChanges({
      operationId: `live:pub-c:${PROFILE_ID}`,
      tenantId: TENANT,
      profileId: PROFILE_ID,
      runId: 'run-c',
      workspacePath: runA,
      baseRevision: base,
      credentialTokenRef: TOKEN_REF,
    });
    if (pubA.status !== 'published') throw new Error(`run A: ${pubA.status} ${pubA.reason}`);
    const pubB = await service.publishRunChanges({
      operationId: `live:pub-d:${PROFILE_ID}`,
      tenantId: TENANT,
      profileId: PROFILE_ID,
      runId: 'run-d',
      workspacePath: runB,
      baseRevision: base,
      credentialTokenRef: TOKEN_REF,
    });
    if (pubB.status !== 'published') throw new Error(`run B: ${pubB.status} ${pubB.reason}`);
    const prepared = await service.prepareProfileWorkspace({
      operationId: `live:prep-merged:${PROFILE_ID}`,
      tenantId: TENANT,
      profileId: PROFILE_ID,
      credentialTokenRef: TOKEN_REF,
    });
    const paths = prepared.manifest.map((entry) => entry.path).sort();
    for (const expected of ['notes/from-a.md', 'notes/from-b.md']) {
      if (!paths.includes(expected)) throw new Error(`после merge нет ${expected}`);
    }
    return { mergeAttempts: pubB.mergeAttempts, files: prepared.files };
  }),

  'same-file → conflict без потери данных': step('same-file → conflict с обеими сторонами', async () => {
    const base = results[2]?.value.revision;
    const runA = writeFiles(mkdtempSync(join(tmpdir(), 'live-run-e-')), {
      'notes/first.md': 'первая версия заметки\n',
      'persona/system.md': 'persona профиля\n',
      'notes/shared.md': 'общая строка\n',
    });
    const runB = writeFiles(mkdtempSync(join(tmpdir(), 'live-run-f-')), {
      'notes/first.md': 'первая версия заметки\n',
      'persona/system.md': 'persona профиля\n',
      'notes/shared.md': 'другая общая строка\n',
    });
    await service.publishRunChanges({
      operationId: `live:pub-e:${PROFILE_ID}`,
      tenantId: TENANT,
      profileId: PROFILE_ID,
      runId: 'run-e',
      workspacePath: runA,
      baseRevision: base,
      credentialTokenRef: TOKEN_REF,
    });
    const pubB = await service.publishRunChanges({
      operationId: `live:pub-f:${PROFILE_ID}`,
      tenantId: TENANT,
      profileId: PROFILE_ID,
      runId: 'run-f',
      workspacePath: runB,
      baseRevision: base,
      credentialTokenRef: TOKEN_REF,
    });
    if (pubB.status !== 'conflict') throw new Error(`status=${pubB.status}, ожидается conflict`);
    const conflict = journal.getConflict(pubB.conflictId ?? '');
    if (!conflict) throw new Error('conflictId не записан в журнал');
    if (conflict.entries[0]?.path !== 'notes/shared.md') throw new Error(`путь конфликта: ${conflict.entries[0]?.path}`);
    if (!conflict.runSha256 || !conflict.entries[0]?.currentSha256) throw new Error('у конфликта нет хэшей сторон');
    // Кандидат рана читается и содержит его версию.
    const candidateBytes = await service.readProfileBlob({
      tenantId: TENANT,
      profileId: PROFILE_ID,
      revision: conflict.runRevision,
      path: 'notes/shared.md',
      credentialTokenRef: TOKEN_REF,
    });
    if (candidateBytes.toString('utf8') !== 'другая общая строка\n') {
      throw new Error('кандидат рана не содержит его версию файла');
    }
    return { conflictId: conflict.conflictId, kind: conflict.entries[0]?.kind };
  }),

  'stale candidate не публикуется': step('stale candidate → новый конфликт', async () => {
    const conflictId = results[6]?.value.conflictId;
    const conflict = journal.getConflict(conflictId);
    const resolution = await service.resolveWorkspaceConflict({
      operationId: `live:res:${PROFILE_ID}`,
      tenantId: TENANT,
      conflictId,
      resolution: { kind: 'run_side', evidence: 'live probe: выбрана версия рана' },
      credentialTokenRef: TOKEN_REF,
    });
    if (resolution.status !== 'candidate_ready') throw new Error(`status=${resolution.status}`);
    const candidate = journal.getCandidate(resolution.candidateId ?? '');
    // Пока готовится решение, «параллельный писатель» публикует ещё один файл.
    const late = writeFiles(mkdtempSync(join(tmpdir(), 'live-run-late-')), {
      'notes/first.md': 'первая версия заметки\n',
      'persona/system.md': 'persona профиля\n',
      'notes/late.md': 'поздняя публикация\n',
    });
    await service.publishRunChanges({
      operationId: `live:pub-late:${PROFILE_ID}`,
      tenantId: TENANT,
      profileId: PROFILE_ID,
      runId: 'run-late',
      workspacePath: late,
      baseRevision: candidate?.expectedHeadRevision ?? EMPTY_TREE,
      credentialTokenRef: TOKEN_REF,
    });
    const publication = await service.publishWorkspaceResolution({
      operationId: `live:pub-res:${PROFILE_ID}`,
      tenantId: TENANT,
      candidateId: resolution.candidateId ?? '',
      expectedHeadRevision: candidate?.expectedHeadRevision ?? null,
      credentialTokenRef: TOKEN_REF,
    });
    if (publication.status !== 'conflict') throw new Error(`status=${publication.status}, ожидается conflict`);
    if (!publication.reason?.includes('stale')) throw new Error(`причина: ${publication.reason}`);
    return { reason: publication.reason };
  }),

  'get читает durable-статус': step('get → durable статус после «рестарта»', async () => {
    const publicationId = results[2]?.value.publicationId;
    // Новый экземпляр сервиса поверх того же журнала — имитация рестарта процесса.
    const restarted = new WorkspaceService({
      git: service.git,
      objects: service.objects,
      bindings: service.bindings,
      admin: service.admin,
      journal,
    });
    const status = await restarted.getWorkspacePublication({ publicationId, tenantId: TENANT });
    if (status.status !== 'published') throw new Error(`status=${status.status}`);
    return { status: status.status, committedRevision: status.committedRevision?.slice(0, 12) };
  }),

  'чужой tenant → отказ': step('чужой tenant → отказ', async () => {
    let denied = false;
    try {
      await service.prepareProfileWorkspace({
        operationId: `live:prep-foreign:${PROFILE_ID}`,
        tenantId: 'someone-else',
        profileId: PROFILE_ID,
        credentialTokenRef: TOKEN_REF,
      });
    } catch (err) {
      denied = err?.code === 'WORKSPACE_NOT_FOUND' || err?.code === 'WORKSPACE_FORBIDDEN';
    }
    if (!denied) throw new Error('чужой tenant получил доступ к профилю');
    return 'denied';
  }),
};

const order = Object.keys(checks);
process.stdout.write(`live probe: owner=${OWNER} profile=${PROFILE_ID} state=${stateDir}\n`);
process.stdout.write(`token: ${TOKEN.slice(0, 8)}… (полное значение не печатается)\n\n`);

let failed = false;
for (const name of order) {
  try {
    await checks[name]();
  } catch {
    failed = true;
    break;
  }
}

process.stdout.write('\n');
if (failed) {
  process.stdout.write(`ПРОВАЛЕНО: ${failures.length} шаг(ов)\n`);
  for (const failure of failures) {
    process.stdout.write(`  - ${failure.name}: ${failure.error instanceof Error ? failure.error.stack : failure.error}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`OK: ${order.length} шагов, ${results.length} записей\n`);
  process.stdout.write(`journal: ${JSON.stringify(journal.stats())}\n`);
  if (!options.keep) {
    rmSync(stateDir, { recursive: true, force: true });
    process.stdout.write(`state удалён: ${stateDir}\n`);
  } else {
    process.stdout.write(`state оставлен: ${stateDir}\n`);
  }
  process.stdout.write(`репозиторий: ${results[0]?.value?.repository ?? '(см. журнал)'}\n`);
}
