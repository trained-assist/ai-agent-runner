/**
 * Работа с git-рабочими копиями внутри профиля (legacy-класс M3).
 *
 * Проблема, которую это решает: в профиле могут лежать сотни клонов GitHub-репозиториев
 * (в одном реальном профиле — 443, у 187 есть локальные коммиты или незакоммиченное).
 * Целиком их хранить нельзя: это десятки гигабайт воспроизводимого кода. Но и выбросить
 * нельзя: незакоммиченное, локальные и брошенные ветки, stash — это работа, которой нет
 * ни в одном remote, и её потеря невосстановима.
 *
 * Правило M3: чистый клон (всё есть в remote) — воспроизводим, не хранится; изменения —
 * архивируются тремя артефактами и живут вне дерева профиля:
 * - `local.bundle` — все локальные коммиты (`--branches --not --remotes`), включая
 *   брошенные ветки; из него восстанавливаются и ветки, и их история;
 * - `uncommitted.patch` — незакоммиченные правки отслеживаемых файлов (staged + unstaged);
 * - `untracked.tar` — новые файлы, которых нет в индексе.
 *
 * Модуль ничего не удаляет: он только читает рабочую копию и пишет архив в отдельный
 * каталог. Удаление клона — отдельное решение вызывающего.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceError } from './contract.js';
import { matchRule, type CompiledPolicy } from './policy.js';

export const WORKING_COPY_BUNDLE = 'local.bundle';
export const WORKING_COPY_PATCH = 'uncommitted.patch';
export const WORKING_COPY_UNTRACKED = 'untracked.tar';
export const WORKING_COPY_MANIFEST = 'local.manifest.json';

const GIT_TIMEOUT_MS = 120_000;

export interface WorkingCopyState {
  dir: string;
  /** Есть ли `.git` и отвечает ли git на команды. */
  isRepository: boolean;
  head: string | null;
  branch: string | null;
  /** Отслеживаемые правки (staged + unstaged) — их нет в коммитах. */
  modified: number;
  /** Новые файлы, которых нет в индексе. */
  untracked: number;
  /** Коммиты, которых нет ни в одном remote (включая ветки без upstream). */
  unpushedCommits: number;
  /** Локальные ветки. */
  branches: string[];
  stashes: number;
  remotes: string[];
  /**
   * Есть ли состояние, которое не восстановить из remote: незакоммиченное, локальные
   * коммиты или stash. `false` означает «чистый клон» — его можно не хранить.
   */
  hasIrreplaceableState: boolean;
}

export interface WorkingCopyArchive {
  /** null — архивировать нечего (чистый клон или не репозиторий). */
  bundlePath: string | null;
  patchPath: string | null;
  untrackedPath: string | null;
  /** Описание архива: remote, вершины веток и требуемые базовые коммиты. */
  manifestPath: string | null;
  bytes: number;
  state: WorkingCopyState;
}

export interface WorkingCopyArchiveManifest {
  schemaVersion: 1;
  /** Remote'ы, на которых основан тонкий bundle (в них лежат базовые коммиты). */
  remotes: { name: string; url: string | null }[];
  /** Вершины локальных веток, попавшие в bundle. */
  branchTips: Record<string, string>;
  /**
   * Коммиты, которых bundle требует от remote. Тонкий bundle хранит ТОЛЬКО локальные
   * коммиты; их родители остаются в remote. Восстановление: клонировать remote и влить
   * bundle (`git fetch <bundle> 'refs/heads/*:refs/restored/*'`).
   */
  requiredRefs: string[];
  patch: boolean;
  untracked: boolean;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, out };
  } catch {
    return { ok: false, out: '' };
  }
}

function lines(out: string): string[] {
  return out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Состояние рабочей копии. Разделяет «воспроизводимо из remote» и «только здесь»:
 * именно от этого зависит, хранить клон или нет.
 */
export function inspectWorkingCopy(dir: string): WorkingCopyState {
  const isRepo = git(dir, ['rev-parse', '--git-dir']).ok;
  if (!isRepo) {
    return {
      dir,
      isRepository: false,
      head: null,
      branch: null,
      modified: 0,
      untracked: 0,
      unpushedCommits: 0,
      branches: [],
      stashes: 0,
      remotes: [],
      hasIrreplaceableState: false,
    };
  }
  const head = git(dir, ['rev-parse', 'HEAD']);
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(dir, ['status', '--porcelain', '--untracked-files=normal']);
  const statusLines = status.ok ? lines(status.out) : [];
  const untracked = statusLines.filter((line) => line.startsWith('??')).length;
  const modified = statusLines.length - untracked;
  // `--branches --not --remotes` — ровно те коммиты, которых нет в remote.
  const unpushed = git(dir, ['rev-list', '--count', '--branches', '--not', '--remotes']);
  const unpushedCommits = unpushed.ok ? Number(unpushed.out.trim()) || 0 : 0;
  const branches = git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const stashes = git(dir, ['stash', 'list']);
  const remotes = git(dir, ['remote']);

  const state: WorkingCopyState = {
    dir,
    isRepository: true,
    head: head.ok ? head.out.trim() : null,
    branch: branch.ok ? branch.out.trim() : null,
    modified,
    untracked,
    unpushedCommits,
    branches: branches.ok ? lines(branches.out) : [],
    stashes: stashes.ok ? lines(stashes.out).length : 0,
    remotes: remotes.ok ? lines(remotes.out) : [],
    hasIrreplaceableState: false,
  };
  state.hasIrreplaceableState = modified > 0 || untracked > 0 || unpushedCommits > 0 || state.stashes > 0;
  return state;
}

export interface ArchiveOptions {
  /** Каталог для артефактов архива; создаётся при необходимости. */
  outDir: string;
}

/**
 * Архивирует изменения рабочей копии. Чистый клон не архивируется (`bundlePath: null`) —
 * это и есть сжатие: воспроизводимое не хранится.
 *
 * Три артефакта вместо всего клона: локальные коммиты (bundle), незакоммиченные правки
 * (patch) и новые файлы (tar). Так «брошенные недоделанные ветки» сохраняются, а десятки
 * гигабайт кода — нет.
 */
export function archiveWorkingCopy(dir: string, options: ArchiveOptions): WorkingCopyArchive {
  const state = inspectWorkingCopy(dir);
  if (!state.isRepository || !state.hasIrreplaceableState) {
    return { bundlePath: null, patchPath: null, untrackedPath: null, manifestPath: null, bytes: 0, state };
  }
  mkdirSync(options.outDir, { recursive: true });
  const bundlePath = join(options.outDir, WORKING_COPY_BUNDLE);
  const patchPath = join(options.outDir, WORKING_COPY_PATCH);
  const untrackedPath = join(options.outDir, WORKING_COPY_UNTRACKED);
  const manifestPath = join(options.outDir, WORKING_COPY_MANIFEST);

  let bytes = 0;
  const branchTips: Record<string, string> = {};
  const requiredRefs: string[] = [];

  // 1. Локальные коммиты (включая ветки, которых нет в remote). Bundle — единственный
  //    способ сохранить и историю, и ссылки на ветки в одном файле.
  if (state.unpushedCommits > 0) {
    const bundle = git(dir, ['bundle', 'create', bundlePath, '--branches', '--not', '--remotes']);
    if (!bundle.ok) {
      throw new WorkspaceError('WORKSPACE_GIT_FAILED', `could not create a bundle of local commits in ${dir}`, { retryable: true });
    }
    bytes += sizeOf(bundlePath);
    // Вершины веток и требуемые базовые коммиты — чтобы восстановление было описано, а не
    // угадано: `git bundle list-heads`/`verify` читают только что созданный файл.
    const heads = git(dir, ['bundle', 'list-heads', bundlePath]);
    if (heads.ok) {
      for (const line of lines(heads.out)) {
        const [sha, ref] = line.split(/\s+/);
        if (sha && ref) branchTips[ref.replace(/^refs\/heads\//, '')] = sha;
      }
    }
    const verify = git(dir, ['bundle', 'verify', bundlePath]);
    if (verify.ok) {
      for (const line of lines(verify.out)) {
        const match = /^([0-9a-f]{40,64})\b/.exec(line);
        if (match) requiredRefs.push(match[1] as string);
      }
    }
  }

  // 2. Незакоммиченные правки отслеживаемых файлов: `git diff HEAD` покрывает и staged,
  //    и unstaged относительно последнего коммита. `--binary` — чтобы бинарные правки
  //    тоже восстанавливались; вывод пишется напрямую, без shell-редиректа.
  if (state.modified > 0) {
    try {
      const patch = execFileSync('git', ['-C', dir, 'diff', 'HEAD', '--binary', '--no-color'], {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (patch.length > 0) {
        writeFileSync(patchPath, patch);
        bytes += patch.length;
      }
    } catch {
      throw new WorkspaceError('WORKSPACE_GIT_FAILED', `could not capture uncommitted changes in ${dir}`, { retryable: true });
    }
  }

  // 3. Новые файлы, которых нет в индексе. Их содержимое есть только здесь. Список
  //    передаётся в tar через stdin NUL-разделённым (`-T -`): argv не переживёт десятки
  //    тысяч путей.
  if (state.untracked > 0) {
    const list = git(dir, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (list.ok && list.out.length > 0) {
      const result = spawnSync('tar', ['--null', '-T', '-', '-cf', untrackedPath], {
        cwd: dir,
        input: Buffer.from(list.out, 'utf8'),
        timeout: GIT_TIMEOUT_MS,
      });
      if (result.status !== 0) {
        throw new WorkspaceError('WORKSPACE_GIT_FAILED', `could not archive untracked files in ${dir}`, { retryable: true });
      }
      bytes += sizeOf(untrackedPath);
    }
  }

  const manifest: WorkingCopyArchiveManifest = {
    schemaVersion: 1,
    remotes: state.remotes.map((name) => ({ name, url: (git(dir, ['remote', 'get-url', name]).out || '').trim() || null })),
    branchTips,
    requiredRefs,
    patch: sizeOf(patchPath) > 0,
    untracked: sizeOf(untrackedPath) > 0,
  };
  if (bytes > 0) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    bytes += sizeOf(manifestPath);
  }

  return {
    bundlePath: sizeOf(bundlePath) > 0 ? bundlePath : null,
    patchPath: sizeOf(patchPath) > 0 ? patchPath : null,
    untrackedPath: sizeOf(untrackedPath) > 0 ? untrackedPath : null,
    manifestPath: bytes > 0 ? manifestPath : null,
    bytes,
    state,
  };
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export const PROFILE_CHANGES_DIR = '.profile-changes';

export interface PreparedWorkingCopy {
  /** Относительный путь рабочей копии внутри профиля. */
  path: string;
  /** Куда положен архив (относительно профиля) или null, если архивировать нечего. */
  archivePath: string | null;
  bytes: number;
  state: WorkingCopyState;
}

export interface PrepareTreeResult {
  workingCopies: PreparedWorkingCopy[];
  /** Сколько копий архивировано (с изменениями). */
  archived: number;
  bytes: number;
}

/**
 * Готовит дерево профиля к импорту: находит git-рабочие копии, архивирует изменения
 * «грязных» в `<корень>/.profile-changes/<путь>/`, чтобы обычный скан их опубликовал, а
 * чистые клоны просто не попали в образ.
 *
 * Пишет ТОЛЬКО в `.profile-changes` внутри переданного корня и никогда не трогает сами
 * копии. Вызывающий решает, какой корень безопасен (копия профиля, не живой профиль).
 * Рабочие копии под путями, которые политика исключает (`node_modules`, `.agent-home`),
 * пропускаются: архивировать воспроизводимое — только мусорить.
 */
export function prepareProfileTree(
  sourceDir: string,
  options: { policy: CompiledPolicy; archiveRootName?: string },
): PrepareTreeResult {
  const archiveRootName = options.archiveRootName ?? PROFILE_CHANGES_DIR;
  const result: PrepareTreeResult = { workingCopies: [], archived: 0, bytes: 0 };

  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasGit = entries.some((entry) => entry.name === '.git');
    if (hasGit) {
      // Рабочая копия — один юнит: внутрь не спускаемся (вложенные субмодули не разбираем).
      if (rel.length === 0 || matchRule(options.policy, rel).action === 'exclude') return;
      const state = inspectWorkingCopy(dir);
      if (!state.hasIrreplaceableState) {
        result.workingCopies.push({ path: rel, archivePath: null, bytes: 0, state });
        return;
      }
      const archiveDir = join(sourceDir, archiveRootName, ...rel.split('/'));
      const archive = archiveWorkingCopy(dir, { outDir: archiveDir });
      result.workingCopies.push({
        path: rel,
        archivePath: archive.bytes > 0 ? join(archiveRootName, ...rel.split('/')) : null,
        bytes: archive.bytes,
        state,
      });
      result.archived += 1;
      result.bytes += archive.bytes;
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      // Исключённые поддеревья не обходим: там нет рабочих копий профиля.
      if (matchRule(options.policy, childRel).action === 'exclude') continue;
      walk(join(dir, entry.name), childRel);
    }
  };

  walk(sourceDir, '');
  return result;
}

/** Удаление артефактов архива — только явным вызовом (модуль сам ничего не чистит). */
export function removeArchive(archive: WorkingCopyArchive): void {
  for (const path of [archive.bundlePath, archive.patchPath, archive.untrackedPath, archive.manifestPath]) {
    if (path) rmSync(path, { force: true });
  }
}
