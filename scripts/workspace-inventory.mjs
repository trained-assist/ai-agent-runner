#!/usr/bin/env node
/**
 * Read-only inventory профилей: что реально попадёт в постоянный репозиторий, если применить
 * legacy clean list.
 *
 * Ничего не пишет и никуда не ходит по сети: только читает каталоги профилей и классифицирует
 * их тем же кодом политики, что использует импорт. Запускается там, где лежат данные (VM),
 * потому что копировать десятки гигабайт ради инвентаря нельзя.
 *
 * Отчёт по каждому профилю: publishable (текст в git), heavy (в object storage по ref),
 * excluded по категориям (sessions, рабочие копии, кэши, секреты, прочее) и общий объём.
 *
 * Запуск (после сборки рядом лежит dist/):
 *   node workspace-inventory.mjs --root /home/vova/users --clean-list ./profile-clean-list.yaml [--json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// dist ищется рядом со скриптом (скрипт в scripts/, dist — sibling): так его можно
// распаковать на любой машине, не подгоняя пути.
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'workspace');
const { parseCleanList, cleanListRulesOf } = await import(`file://${DIST}/clean-list.js`);
const { compileCleanListRules, compilePolicy, matchRule, classifyPath } = await import(`file://${DIST}/policy.js`);

function parseArgv(argv) {
  const options = { root: null, cleanList: null, json: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') options.root = argv[++i];
    else if (arg === '--clean-list') options.cleanList = argv[++i];
    else if (arg === '--only') options.only = argv[++i];
    else if (arg === '--json') options.json = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write('Usage: node workspace-inventory.mjs --root <dir> --clean-list <file> [--only name1,name2] [--json]\n');
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
const policy = compilePolicy({
  policyId: `inventory-clean-list-v${parsed.version}`,
  version: 1,
  // Щедрые лимиты: инвентарь измеряет, а не отказывает.
  textMaxBytes: 1024 * 1024,
  maxFiles: 5_000_000,
  maxTotalBytes: 1024 * 1024 * 1024 * 1024,
  rules: compileCleanListRules(cleanListRulesOf(parsed)),
});

/** Категория исключения по причине из clean list — для сводки, а не для решения. */
function categorize(reason) {
  if (/session|M2/i.test(reason)) return 'sessions';
  if (/working copy|clone|M3/i.test(reason)) return 'working_copies';
  if (/regenerable|cache|log/i.test(reason)) return 'regenerable';
  if (/EXCLUDE|secret|oauth|credential|cookie|password/i.test(reason)) return 'secrets';
  return 'other';
}

function inventoryProfile(profileDir) {
  const result = {
    publishable: { files: 0, bytes: 0 },
    heavy: { files: 0, bytes: 0 },
    excluded: { files: 0, bytes: 0, byCategory: {} },
    unreadable: 0,
  };

  const walk = (absoluteDir, relativeDir, insideGitRepo) => {
    let entries;
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      result.unreadable += 1;
      return;
    }
    const dirIsWorkingCopy = entries.some((entry) => entry.name === '.git');
    const context = { insideGitRepo: insideGitRepo || dirIsWorkingCopy };
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolutePath = join(absoluteDir, entry.name);
      if (entry.isSymbolicLink()) {
        result.excluded.files += 1;
        const category = 'other';
        result.excluded.byCategory[category] = (result.excluded.byCategory[category] ?? 0) + 1;
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath, context.insideGitRepo);
        continue;
      }
      if (!entry.isFile()) {
        result.excluded.files += 1;
        continue;
      }
      let size = 0;
      try {
        size = statSync(absolutePath).size;
      } catch {
        result.unreadable += 1;
        continue;
      }
      const matched = matchRule(policy, relativePath, context);
      if (matched.action === 'exclude') {
        result.excluded.files += 1;
        result.excluded.bytes += size;
        const category = categorize(matched.reason);
        result.excluded.byCategory[category] = (result.excluded.byCategory[category] ?? 0) + 1;
        continue;
      }
      const decision = classifyPath(policy, relativePath, size);
      if (decision.action === 'exclude') {
        result.excluded.files += 1;
        result.excluded.bytes += size;
        const category = categorize(decision.reason);
        result.excluded.byCategory[category] = (result.excluded.byCategory[category] ?? 0) + 1;
      } else if (decision.action === 'heavy') {
        result.heavy.files += 1;
        result.heavy.bytes += size;
      } else {
        result.publishable.files += 1;
        result.publishable.bytes += size;
      }
    }
  };

  walk(profileDir, '', false);
  return result;
}

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const profiles = readdirSync(options.root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => (options.only ? options.only.split(',').includes(name) : true))
  .sort();

const report = {};
for (const name of profiles) {
  report[name] = inventoryProfile(join(options.root, name));
}

if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const totals = { publishable: { files: 0, bytes: 0 }, heavy: { files: 0, bytes: 0 }, excluded: { files: 0, bytes: 0 }, byCategory: {} };
  process.stdout.write(`inventory: ${profiles.length} профилей, clean list v${parsed.version}\n\n`);
  process.stdout.write(`${'profile'.padEnd(34)} ${'текст'.padStart(12)} ${'heavy'.padStart(12)} ${'исключено'.padStart(14)}  категории\n`);
  for (const [name, item] of Object.entries(report)) {
    totals.publishable.files += item.publishable.files;
    totals.publishable.bytes += item.publishable.bytes;
    totals.heavy.files += item.heavy.files;
    totals.heavy.bytes += item.heavy.bytes;
    totals.excluded.files += item.excluded.files;
    totals.excluded.bytes += item.excluded.bytes;
    for (const [category, count] of Object.entries(item.excluded.byCategory)) {
      totals.byCategory[category] = (totals.byCategory[category] ?? 0) + count;
    }
    const categories = Object.entries(item.excluded.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `${category}=${count}`)
      .join(' ');
    process.stdout.write(
      `${name.padEnd(34)} ${`${item.publishable.files} / ${fmtBytes(item.publishable.bytes)}`.padStart(12)} ${`${item.heavy.files} / ${fmtBytes(item.heavy.bytes)}`.padStart(12)} ${`${item.excluded.files} / ${fmtBytes(item.excluded.bytes)}`.padStart(14)}  ${categories}\n`,
    );
  }
  process.stdout.write('\n');
  process.stdout.write(`ИТОГО текст:    ${totals.publishable.files} файлов, ${fmtBytes(totals.publishable.bytes)}\n`);
  process.stdout.write(`ИТОГО heavy:    ${totals.heavy.files} файлов, ${fmtBytes(totals.heavy.bytes)}\n`);
  process.stdout.write(`ИТОГО исключено:${totals.excluded.files} файлов, ${fmtBytes(totals.excluded.bytes)}\n`);
  process.stdout.write(`по категориям:  ${Object.entries(totals.byCategory).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(' ')}\n`);
}
