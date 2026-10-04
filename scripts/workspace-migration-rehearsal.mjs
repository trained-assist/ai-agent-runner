#!/usr/bin/env node
/**
 * Репетиция миграции профилей в постоянные репозитории.
 *
 * Зачем отдельно от `workspace-live-probe.mjs`: пробник проверяет модуль на синтетических
 * данных, а здесь — на **копиях настоящих профилей** и с **настоящим legacy clean list**.
 * Именно это ловит то, что синтетика не может: сессии, которые legacy держит вне текстового
 * образа, дубли содержимого, тяжёлые файлы за порогом git, права доступа и реальные имена.
 *
 * Правила безопасности (по правилам потока):
 * - исходные профили только ЧИТАЮТСЯ, копируются во временный каталог; живые данные не
 *   изменяются и не удаляются;
 * - репозитории создаются с префиксом `rehearsal-` в имени профиля, поэтому имя
 *   `profile-rehearsal-alice` не пересекается с боевым `profile-alice` реального
 *   пользователя;
 * - импорт идемпотентен по manifest hash: повторный прогон не переписывает репозиторий;
 * - токен читается из окружения, печатается только префикс.
 *
 * Запуск (после `npm run build`):
 *
 *   WORKSPACE_LIVE_OWNER=profiles-artifacts \
 *   WORKSPACE_LIVE_TOKEN_REF=github:profiles-artifacts \
 *   WORKSPACE_LIVE_TOKEN=<pat> \
 *   node scripts/workspace-migration-rehearsal.mjs [--keep] [--state <dir>]
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const DIST = join(REPO_ROOT, 'dist', 'workspace');

function usage() {
  return [
    'Usage:',
    '  WORKSPACE_LIVE_OWNER=<org> WORKSPACE_LIVE_TOKEN_REF=<ref> WORKSPACE_LIVE_TOKEN=<pat> \\',
    '    node scripts/workspace-migration-rehearsal.mjs [--keep] [--state <dir>] [--clean-list <file>]',
    '',
    'По умолчанию берутся два локальных тестовых профиля (alice, flexi-consult) и их копии.',
    'Репозитории создаются как profile-rehearsal-<name> — без пересечения с боевыми именами.',
  ].join('\n');
}

function parseArgv(argv) {
  const options = { keep: false, state: null, cleanList: null, profiles: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep') options.keep = true;
    else if (arg === '--state') options.state = argv[++i];
    else if (arg === '--clean-list') options.cleanList = argv[++i];
    else if (arg === '--profiles') options.profiles = argv[++i];
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

const { WorkspaceService, WorkspaceJournal, createLocalGitPort, createGitHubRepositoryAdmin, parseCleanList, cleanListRulesOf, compileCleanListRules } = await import(
  `file://${DIST}/index.js`
);
const { createLocalFsBlobStore } = await import(`file://${REPO_ROOT}/dist/storage/local-fs.js`);

const stateDir = options.state ?? mkdtempSync(join(tmpdir(), 'workspace-rehearsal-state-'));
mkdirSync(stateDir, { recursive: true });
const mirrorDir = join(stateDir, 'mirrors');
const blobDir = join(stateDir, 'blobs');
mkdirSync(mirrorDir, { recursive: true });
mkdirSync(blobDir, { recursive: true });

const journal = new WorkspaceJournal(join(stateDir, 'journal'));
journal.init();

// Политика: deny-list по умолчанию + правила из legacy clean list. Без clean list импорт
// притащил бы тела сессий в репозиторий профиля — они намеренно вне текстового образа.
const cleanListPath = options.cleanList ?? join(REPO_ROOT, '..', 'trained-assist-agent', 'config', 'profile-clean-list.yaml');
let policyRules = [];
let cleanListVersion = null;
if (existsSync(cleanListPath)) {
  const parsed = parseCleanList(readFileSync(cleanListPath, 'utf8'));
  cleanListVersion = parsed.version;
  // `when` обязан пережить компиляцию: без него правило `**` → ARCHIVE становится
  // безусловным и исключает весь профиль целиком.
  policyRules = compileCleanListRules(cleanListRulesOf(parsed));
} else {
  process.stdout.write(`  warn  clean list не найден по ${cleanListPath}: используется deny-list по умолчанию\n`);
}

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
  policy: buildMigrationPolicy({
    policyId: `rehearsal-clean-list-v${cleanListVersion ?? 'default'}`,
    cleanListRules: policyRules,
    compress: true,
    maxTotalBytes: 512 * 1024 * 1024,
  }),
});

// ── копии профилей ────────────────────────────────────────────────────────────

const SOURCE_ROOT = process.env.REHEARSAL_SOURCE_ROOT ?? join(REPO_ROOT, '..', '..', 'users');
const requested = options.profiles ? options.profiles.split(',') : ['alice', 'flexi-consult'];
const copies = new Map();

for (const name of requested) {
  const source = join(SOURCE_ROOT, name);
  if (!existsSync(source)) {
    process.stderr.write(`профиль не найден: ${source}\n`);
    process.exit(1);
  }
  const copyRoot = join(stateDir, 'copies');
  mkdirSync(copyRoot, { recursive: true });
  const target = join(copyRoot, name);
  // Копия, а не ссылка: импорт не должен иметь возможности изменить исходный профиль.
  cpSync(source, target, { recursive: true, dereference: false, filter: (src) => !src.includes('.git/') });
  copies.set(name, target);
}

function inventory(root) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else files.push({ path: relative, size: statSync(join(dir, entry.name)).size });
    }
  };
  walk(root, '');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

process.stdout.write(`репетиция миграции: owner=${OWNER} cleanList=v${cleanListVersion ?? 'default'} state=${stateDir}\n`);
process.stdout.write(`токен: ${TOKEN.slice(0, 8)}…\n`);
process.stdout.write(`профили: ${requested.join(', ')} (копии, исходные не трогаются)\n\n`);

const inventoryReport = new Map();
for (const [name, copy] of copies) {
  const files = inventory(copy);
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  inventoryReport.set(name, { files: files.length, bytes });
  process.stdout.write(`  ${name}: ${files.length} файлов, ${(bytes / 1024).toFixed(1)} КБ\n`);
}
process.stdout.write('\n');

// ── dry-run ───────────────────────────────────────────────────────────────────

const dryRun = await service.provisionExistingProfileRepositories({
      operationId: `rehearsal:dry:${Date.now()}`,
      tenantId: 'rehearsal',
      owner: OWNER,
      inventory: [...copies.keys()].map((profileId) => ({ profileId: `rehearsal-${profileId}`, sourcePath: copies.get(profileId) })),
      dryRun: true,
      credentialTokenRef: TOKEN_REF,
    });

process.stdout.write(`dry-run: status=${dryRun.status} processed=${dryRun.processed}\n`);
for (const result of dryRun.results) {
  process.stdout.write(`  ${result.profileId}: plan=[${result.plan.join(', ')}] files=${result.files} excluded=${result.excluded.length}\n`);
  const sessions = result.excluded.filter((item) => item.includes('sessions'));
  if (sessions.length > 0) process.stdout.write(`      исключено сессий: ${sessions.length} (clean list: sessions → ARCHIVE)\n`);
}
process.stdout.write('\n');

// ── импорт ────────────────────────────────────────────────────────────────────

const started = Date.now();
const imported = await service.provisionExistingProfileRepositories({
  operationId: `rehearsal:import:${Date.now()}`,
  tenantId: 'rehearsal',
  owner: OWNER,
  inventory: [...copies.keys()].map((profileId) => ({ profileId: `rehearsal-${profileId}`, sourcePath: copies.get(profileId) })),
  dryRun: false,
  credentialTokenRef: TOKEN_REF,
});
const elapsed = Date.now() - started;

process.stdout.write(`импорт: status=${imported.status} processed=${imported.processed} за ${(elapsed / 1000).toFixed(1)}с\n`);
for (const result of imported.results) {
  process.stdout.write(`  ${result.profileId}: status=${result.status} files=${result.files} head=${result.headRevision?.slice(0, 12) ?? 'null'}\n`);
  if (result.error) process.stdout.write(`      error: ${result.error}\n`);
  const sessions = result.excluded.filter((item) => item.includes('sessions'));
  if (sessions.length > 0) process.stdout.write(`      исключено сессий: ${sessions.length}\n`);
  const heavy = result.excluded.filter((item) => /blob\.bin|enriched\.json|index\.html/.test(item));
  if (heavy.length > 0) process.stdout.write(`      тяжёлые/большие: ${heavy.length}\n`);
}
process.stdout.write('\n');

// ── идемпотентность: повторный прогон не должен ничего переписывать ────────────

const again = await service.provisionExistingProfileRepositories({
  operationId: `rehearsal:import-again:${Date.now()}`,
  tenantId: 'rehearsal',
  owner: OWNER,
  inventory: [...copies.keys()].map((profileId) => ({ profileId: `rehearsal-${profileId}`, sourcePath: copies.get(profileId) })),
  dryRun: false,
  credentialTokenRef: TOKEN_REF,
});
// Идемпотентность проверяется по статусу повторного прогона: `verified` = переимпорта не
  // было (manifest hash совпал), `imported` = репозиторий переписали заново.
  const reImported = again.results.filter((result) => result.status === 'imported');
  process.stdout.write(`повторный прогон: status=${again.status} processed=${again.processed}, переимпортировано=${reImported.length}\n`);
for (const result of again.results) {
  process.stdout.write(`  ${result.profileId}: status=${result.status}${result.error ? ` error=${result.error}` : ''}\n`);
}
process.stdout.write('\n');

// ── проверка: репозиторий читается, сессий в нём нет ─────────────────────────

for (const [name] of copies) {
  const binding = await service.bindings.findByProfile('rehearsal', `rehearsal-${name}`);
  if (!binding) {
    process.stdout.write(`  ${name}: binding не найден\n`);
    continue;
  }
  const prepared = await service.prepareProfileWorkspace({
    operationId: `rehearsal:verify:${name}:${Date.now()}`,
    tenantId: 'rehearsal',
    profileId: `rehearsal-${name}`,
    credentialTokenRef: TOKEN_REF,
  });
  const paths = prepared.manifest.map((entry) => entry.path);
  const sessions = paths.filter((path) => path.startsWith('sessions/'));
  const heavy = prepared.manifest.filter((entry) => entry.artifact !== null);
  process.stdout.write(
    `  ${name}: repo=${binding.repository} files=${paths.length} artifacts=${prepared.artifacts} warnings=${prepared.warnings.length} sessions=${sessions.length}\n`,
  );
  if (sessions.length > 0) process.stdout.write(`      ОШИБКА: в репозитории есть сессии: ${sessions.join(', ')}\n`);
  for (const entry of heavy) {
    process.stdout.write(`      артефакт: ${entry.path} → ${entry.artifact?.key} (${entry.artifact?.size} байт)\n`);
  }
  for (const warning of prepared.warnings) process.stdout.write(`      warning: ${warning}\n`);
}
process.stdout.write('\n');

// ── отчёт ─────────────────────────────────────────────────────────────────────

const ok = imported.status === 'completed' && reImported.length === 0;
process.stdout.write(ok ? `ИТОГ: репетиция пройдена (${imported.results.length} профилей)\n` : `ИТОГ: репетизация НЕ пройдена\n`);
process.stdout.write(`journal: ${JSON.stringify(journal.stats())}\n`);

if (!options.keep) {
  rmSync(stateDir, { recursive: true, force: true });
  process.stdout.write(`state удалён: ${stateDir}\n`);
} else {
  process.stdout.write(`state оставлен: ${stateDir}\n`);
}
process.stdout.write(`репозитории: ${[...copies.keys()].map((name) => `profile-rehearsal-${name}`).join(', ')}\n`);

if (!ok) process.exitCode = 1;
