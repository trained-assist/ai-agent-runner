#!/usr/bin/env node
/**
 * Read-only разбор профилей: где именно объём и что в git-рабочих копиях.
 *
 * Отвечает на два вопроса, от которых зависит сжатие образа:
 *  1. Из чего состоят «publishable» файлы: топ путей и каталогов-префиксов по объёму.
 *  2. Что в git-рабочих копиях: чистый клон (выбрасывается целиком) или есть
 *     незакоммиченное / локальные и брошенные ветки (архивируются как изменения).
 *
 * Ничего не пишет: только читает и запускает `git` на чтение в найденных копиях.
 *
 *   node workspace-working-copies.mjs --root /home/vova/users --clean-list ./profile-clean-list.yaml \
 *     [--only name] [--top 15]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'workspace');
const { parseCleanList, cleanListRulesOf } = await import(`file://${DIST}/clean-list.js`);
const { compileCleanListRules, compilePolicy, matchRule, classifyPath, buildMigrationPolicy } = await import(`file://${DIST}/policy.js`);

function parseArgv(argv) {
  const options = { root: null, cleanList: null, only: null, top: 15, compressed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') options.root = argv[++i];
    else if (arg === '--clean-list') options.cleanList = argv[++i];
    else if (arg === '--only') options.only = argv[++i];
    else if (arg === '--top') options.top = Number(argv[++i]);
    else if (arg === '--compressed') options.compressed = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write('Usage: node workspace-working-copies.mjs --root <dir> --clean-list <file> [--only name] [--top N]\n');
      process.exit(0);
    } else {
      process.stderr.write(`неизвестный аргумент: ${arg}\n`);
      process.exit(1);
    }
  }
  if (!options.root || !options.cleanList) {
    process.stderr.write('нужны --root и --clean-list\n');
    process.exit(1);
  }
  return options;
}

const options = parseArgv(process.argv.slice(2));
const parsed = parseCleanList(readFileSync(options.cleanList, 'utf8'));
const policy = compilePolicy(
  buildMigrationPolicy({
    policyId: `inventory-v${parsed.version}`,
    cleanListRules: compileCleanListRules(cleanListRulesOf(parsed)),
    compress: options.compressed,
    textMaxBytes: 1024 * 1024,
    maxFiles: 5_000_000,
    maxTotalBytes: 1024 * 1024 * 1024 * 1024,
  }),
);

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function git(cwd, args) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() };
  } catch (err) {
    return { ok: false, out: '', code: err.status ?? -1 };
  }
}

/** Состояние рабочей копии: что реально нужно сохранить, а что воспроизводимо. */
function workingCopyState(dir) {
  const status = git(dir, ['status', '--porcelain', '--untracked-files=normal']);
  const dirty = status.ok ? status.out.split('\n').filter(Boolean) : [];
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // Локальные коммиты, которых нет ни в одном remote (включая ветки без upstream).
  const unpushed = git(dir, ['log', '--branches', '--not', '--remotes', '--oneline']);
  const unpushedCount = unpushed.ok ? unpushed.out.split('\n').filter(Boolean).length : 0;
  const localBranches = git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const branches = localBranches.ok ? localBranches.out.split('\n').filter(Boolean) : [];
  const stashes = git(dir, ['stash', 'list']);
  const stashCount = stashes.ok ? stashes.out.split('\n').filter(Boolean).length : 0;
  const remotes = git(dir, ['remote']);
  return {
    branch: branch.ok ? branch.out : '?',
    dirty: dirty.length,
    untracked: dirty.filter((line) => line.startsWith('??')).length,
    modified: dirty.filter((line) => !line.startsWith('??')).length,
    unpushedCommits: unpushedCount,
    branches,
    stashes: stashCount,
    remotes: remotes.ok ? remotes.out.split('\n').filter(Boolean).length : 0,
  };
}

const profiles = readdirSync(options.root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => (options.only ? options.only.split(',').includes(name) : true))
  .sort();

for (const name of profiles) {
  const root = join(options.root, name);
  const publishable = [];
  const workingCopies = [];

  const walk = (dir, rel, insideGitRepo) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirIsWorkingCopy = entries.some((entry) => entry.name === '.git');
    const context = { insideGitRepo: insideGitRepo || dirIsWorkingCopy };
    if (dirIsWorkingCopy) {
      workingCopies.push({ path: rel || '.', state: workingCopyState(dir) });
    }
    for (const entry of entries) {
      const relativePath = rel ? `${rel}/${entry.name}` : entry.name;
      const absolutePath = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath, context.insideGitRepo);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try {
        size = statSync(absolutePath).size;
      } catch {
        continue;
      }
      const matched = matchRule(policy, relativePath, context);
      if (matched.action === 'exclude') continue;
      const decision = classifyPath(policy, relativePath, size);
      if (decision.action === 'exclude') continue;
      publishable.push({ path: relativePath, size, action: decision.action });
    }
  };
  walk(root, '', false);

  const textBytes = publishable.filter((file) => file.action === 'publish').reduce((sum, file) => sum + file.size, 0);
  const heavyBytes = publishable.filter((file) => file.action === 'heavy').reduce((sum, file) => sum + file.size, 0);
  process.stdout.write(`\n=== ${name}: текст ${publishable.filter((f) => f.action === 'publish').length} / ${fmtBytes(textBytes)}, heavy ${publishable.filter((f) => f.action === 'heavy').length} / ${fmtBytes(heavyBytes)} ===\n`);

  const topFiles = [...publishable].sort((a, b) => b.size - a.size).slice(0, options.top);
  process.stdout.write(`  топ файлов:\n`);
  for (const file of topFiles) process.stdout.write(`    ${fmtBytes(file.size).padStart(10)}  ${file.action.padEnd(8)} ${file.path}\n`);

  // Свод по каталогам-префиксам первого уровня внутри publishable.
  const byPrefix = new Map();
  for (const file of publishable) {
    const prefix = file.path.includes('/') ? file.path.slice(0, file.path.indexOf('/')) : '(root)';
    const item = byPrefix.get(prefix) ?? { files: 0, bytes: 0 };
    item.files += 1;
    item.bytes += file.size;
    byPrefix.set(prefix, item);
  }
  process.stdout.write(`  топ каталогов:\n`);
  for (const [prefix, item] of [...byPrefix.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, options.top)) {
    process.stdout.write(`    ${fmtBytes(item.bytes).padStart(10)}  ${String(item.files).padStart(7)} файлов  ${prefix}\n`);
  }

  if (workingCopies.length > 0) {
    const dirty = workingCopies.filter((item) => item.state.dirty > 0 || item.state.unpushedCommits > 0 || item.state.stashes > 0);
    process.stdout.write(`  рабочие копии: ${workingCopies.length}, из них с изменениями/ветками: ${dirty.length}\n`);
    for (const item of dirty.slice(0, options.top)) {
      const s = item.state;
      process.stdout.write(
        `    ${item.path}: dirty=${s.dirty} (mod=${s.modified} untracked=${s.untracked}) unpushed=${s.unpushedCommits} stashes=${s.stashes} branches=${s.branches.length} remotes=${s.remotes}\n`,
      );
    }
  }
}
