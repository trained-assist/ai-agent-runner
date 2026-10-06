/**
 * Слой дерева: диффы, манифест изменений и трёхстороннее слияние по путям.
 *
 * Почему слияние здесь, а не в git-адаптере: правила «что считать конфликтом» — часть
 * контракта (edit/delete, add/add, rename, бинарные объекты), и они должны проверяться
 * детерминированными тестами без сети и без реального remote. Порт предоставляет только
 * примитивы чтения/записи дерева и слияние одного файла.
 *
 * Модель: версия состояния профиля = commit SHA, пустое состояние = EMPTY_TREE. Никаких
 * force push и никакой «последней записи» — публикация всегда строится поверх проверенной
 * головы и применяется compare-and-swap'ом (см. service.ts).
 */

import { sha256Hex } from '../storage/blob-store.js';
import { EMPTY_TREE, WorkspaceError, type WorkspaceChangeEntry, type WorkspaceChangeKind, type WorkspaceConflictEntry } from './contract.js';
import { GIT_MODE_LINK, GIT_MODE_SUBMODULE, type GitMirror, type GitRepositoryPort, type GitTreeEntry, type TreeWrite } from './ports.js';

export interface TreePath {
  mode: string;
  oid: string;
}

export type TreeMap = Map<string, TreePath>;

export function toTreeMap(entries: readonly GitTreeEntry[]): TreeMap {
  const map: TreeMap = new Map();
  for (const entry of entries) {
    if (entry.mode === GIT_MODE_SUBMODULE) {
      throw new WorkspaceError('WORKSPACE_PATH_DENIED', `path "${entry.path}" is a git submodule: submodules are not part of the persistent profile image`);
    }
    map.set(entry.path, { mode: entry.mode, oid: entry.oid });
  }
  return map;
}

export interface TreeDiff {
  added: string[];
  updated: string[];
  deleted: string[];
}

/**
 * Дифф двух деревьев по путям. Режим учитывается: смена 100644 → 100755 — это изменение
 * образа, а не шум.
 */
export function diffTrees(base: TreeMap, candidate: TreeMap): TreeDiff {
  const diff: TreeDiff = { added: [], updated: [], deleted: [] };
  for (const [path, entry] of candidate) {
    const before = base.get(path);
    if (!before) diff.added.push(path);
    else if (before.oid !== entry.oid || before.mode !== entry.mode) diff.updated.push(path);
  }
  for (const path of base.keys()) {
    if (!candidate.has(path)) diff.deleted.push(path);
  }
  diff.added.sort();
  diff.updated.sort();
  diff.deleted.sort();
  return diff;
}

/** sha256 содержимого blob'а. Симлинк и submodule — не содержимое, а режим. */
export async function blobSha256(git: GitRepositoryPort, mirror: GitMirror, entry: TreePath): Promise<string> {
  return sha256Hex(await git.readBlob(mirror, entry.oid));
}

export interface ChangeSetInput {
  base: TreeMap;
  candidate: TreeMap;
  /** Тяжёлые объекты публикации: путь → ref. В дереве git их нет, но в публикации — есть. */
  artifactByPath?: ReadonlyMap<string, WorkspaceChangeEntry['artifact']>;
  /** Реестр артефактов базовой ревизии: по нему видно удаление/замену тяжёлого объекта. */
  baseArtifacts?: ReadonlyMap<string, { sha256: string; size: number }>;
}

/**
 * Манифест изменений рана относительно базы: additions/updates/deletions с sha256
 * содержимого. Хэш считается по факту чтения blob'а, а не по git-oid: git-oid зависит от
 * хэш-алгоритма репозитория, а контракт манифеста и материализатора — sha256.
 */
export async function buildChangeSet(
  git: GitRepositoryPort,
  mirror: GitMirror,
  input: ChangeSetInput,
): Promise<WorkspaceChangeEntry[]> {
  const diff = diffTrees(input.base, input.candidate);
  const changes: WorkspaceChangeEntry[] = [];

  for (const [kind, paths] of [
    ['add', diff.added],
    ['update', diff.updated],
  ] as const) {
    for (const path of paths) {
      const entry = input.candidate.get(path);
      if (!entry) throw new WorkspaceError('WORKSPACE_INVALID', `internal diff error: "${path}" is missing from the candidate tree`);
      if (entry.mode === GIT_MODE_LINK) {
        throw new WorkspaceError('WORKSPACE_PATH_DENIED', `path "${path}" is a symlink in the profile image: symlinks are not published`);
      }
      const artifact = input.artifactByPath?.get(path) ?? null;
      const bytes = await git.readBlob(mirror, entry.oid);
      changes.push({
        path,
        kind: kind as WorkspaceChangeKind,
        // Тяжёлый объект лежит в object storage: его checksum — проверенный sha256
        // загрузки, а не пересчитанный хэш зеркала (в git этих байт вообще нет).
        sha256: artifact ? artifact.sha256 : sha256Hex(bytes),
        size: artifact ? artifact.size : bytes.length,
        artifact,
      });
    }
  }
  for (const path of diff.deleted) {
    changes.push({ path, kind: 'delete', sha256: null, size: 0, artifact: null });
  }

  // Тяжёлые объекты не лежат в дереве, поэтому их изменения видны только по реестру.
  // Без этого блока публикация тяжёлого файла выглядела бы как «ничего не изменилось».
  const artifacts = input.artifactByPath ?? new Map<string, WorkspaceChangeEntry['artifact']>();
  const baseArtifacts = input.baseArtifacts ?? new Map<string, { sha256: string; size: number }>();
  const artifactPaths = new Set([...artifacts.keys(), ...baseArtifacts.keys()]);
  for (const path of [...artifactPaths].sort()) {
    const next = artifacts.get(path);
    const before = baseArtifacts.get(path);
    if (next && before && next.sha256 === before.sha256 && next.size === before.size) continue;
    if (!next && !before) continue;
    if (next) changes.push({ path, kind: before ? 'update' : 'add', sha256: next.sha256, size: next.size, artifact: next });
    else changes.push({ path, kind: 'delete', sha256: null, size: 0, artifact: null });
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export interface MergeInput {
  base: TreeMap;
  /** Дерево изменений рана. */
  run: TreeMap;
  /** Актуальный голова профиля. */
  current: TreeMap;
  /** Подмножество путей, о котором идёт публикация (остальное head не трогает). */
  scope: ReadonlySet<string>;
  /** Default publication policy is deterministic by final tree byte size. */
  conflictPolicy?: 'prefer_larger_final_tree' | 'preserve_conflict';
}

export interface MergeOutcome {
  /** Записи дерева, которые надо применить к current, чтобы получить merged. */
  writes: TreeWrite[];
  conflicts: WorkspaceConflictEntry[];
  /** Конфликты, автоматически разрешённые в пользу дерева с большим финальным объёмом. */
  resolvedByLargerTree: Array<WorkspaceConflictEntry & { winner: 'run' | 'current'; runTreeBytes: number; currentTreeBytes: number }>;
  /** Разрешился ли конфликт полностью. */
  clean: boolean;
}

function samePath(a: TreePath | null, b: TreePath | null): boolean {
  if (a === null || b === null) return a === b;
  return a.oid === b.oid && a.mode === b.mode;
}

/**
 * Трёхстороннее слияние по путям: base (что видел ран), run (что ран сделал), current
 * (что успело опубликовать параллельно).
 *
 * Решения детерминированы и не требуют «интеллекта»:
 * - рана не касается пути → остаётся current;
 * - current не касается пути → берётся run;
 * - оба пришли к одному → берётся run (идемпотентно);
 * - оба изменили один файл → обычное git-слияние одного файла; неразрешимое выбирает
 *   более объёмное финальное дерево (при равенстве остаётся текущая canonical head);
 * - остальные path-level конфликты решаются тем же правилом, обе ветки остаются durable.
 *
 * Rename в git — это delete+add (объекта rename не существует). Модуль не угадывает
 * «настоящий rename» по имени, но помечает конфликт как `rename`, когда удаление и
 * добавление с тем же содержимым сделала ОДНА сторона, а вторая меняла удалённый путь:
 * оператор увидит «переименование поверх правки», а не случайное удаление. Если обе
 * стороны добавили одинаковое содержимое — это add/add, отдельный конфликт.
 */
export async function mergeTrees(git: GitRepositoryPort, mirror: GitMirror, input: MergeInput): Promise<MergeOutcome> {
  const paths = new Set<string>([...input.base.keys(), ...input.run.keys(), ...input.current.keys()]);
  const writes: TreeWrite[] = [];
  const conflicts: WorkspaceConflictEntry[] = [];
  const resolvedByLargerTree: MergeOutcome['resolvedByLargerTree'] = [];

  const hashedOf = async (tree: TreeMap, wanted: Iterable<string>): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    for (const path of wanted) {
      const entry = tree.get(path);
      if (entry && entry.mode !== GIT_MODE_LINK) out.set(path, await blobSha256(git, mirror, entry));
    }
    return out;
  };

  /**
   * deletedPath → addedPath для одной стороны. Rename — это удаление P и добавление Q с
   * тем же содержимым, поэтому сопоставление идёт по хэшу базового P, а не по
   * пересечению списков deleted/added (у rename эти списки не пересекаются вовсе).
   */
  const renamesOf = async (tree: TreeMap): Promise<Map<string, string>> => {
    const diff = diffTrees(input.base, tree);
    const deletedHashes = await hashedOf(input.base, diff.deleted);
    const addedHashes = await hashedOf(tree, diff.added);
    const out = new Map<string, string>();
    for (const [deletedPath, deletedHash] of deletedHashes) {
      for (const [addedPath, addedHash] of addedHashes) {
        if (addedPath !== deletedPath && addedHash === deletedHash) out.set(deletedPath, addedPath);
      }
    }
    return out;
  };
  const renamedFrom = new Map<string, string>([...(await renamesOf(input.run)), ...(await renamesOf(input.current))]);

  const conflicted: { path: string; runHash: string | null; currentHash: string | null; kind: WorkspaceConflictEntry['kind'] }[] = [];
  for (const path of [...paths].sort()) {
    if (input.scope.size > 0 && !input.scope.has(path)) continue;
    const base = input.base.get(path) ?? null;
    const run = input.run.get(path) ?? null;
    const current = input.current.get(path) ?? null;

    if (run === null && base === null) continue;
    if (samePath(run, base)) continue;
    if (samePath(run, current)) continue;
    if (samePath(current, base)) {
      if (run) writes.push({ path, oid: run.oid, mode: run.mode });
      else writes.push({ path, oid: null });
      continue;
    }

    const runHash = run && run.mode !== GIT_MODE_LINK ? await blobSha256(git, mirror, run) : null;
    const currentHash = current && current.mode !== GIT_MODE_LINK ? await blobSha256(git, mirror, current) : null;

    if (run === null || current === null) {
      conflicted.push({ path, runHash, currentHash, kind: renamedFrom.has(path) ? 'rename' : 'delete_modify' });
      continue;
    }
    if (base === null) {
      conflicted.push({ path, runHash, currentHash, kind: 'add_add' });
      continue;
    }
    const merged = await git.mergeBlobs(mirror, { baseOid: base.oid, currentOid: current.oid, otherOid: run.oid });
    if (merged.status === 'clean' && merged.oid !== null) {
      writes.push({ path, oid: merged.oid, mode: current.mode });
      continue;
    }
    conflicted.push({ path, runHash, currentHash, kind: merged.detail && /binary/i.test(merged.detail) ? 'binary' : 'content' });
  }

  if (conflicted.length > 0) {
    // Compare the final branch trees, not diff sizes. A delete therefore lowers that
    // branch's score by the bytes removed; it cannot silently beat a branch retaining
    // the file. Ties preserve current (already-published canonical head).
    const treeBytes = async (tree: TreeMap): Promise<number> => {
      let total = 0;
      for (const entry of tree.values()) {
        if (entry.mode === GIT_MODE_LINK || entry.mode === GIT_MODE_SUBMODULE) continue;
        total += (await git.readBlob(mirror, entry.oid)).byteLength;
      }
      return total;
    };
    if ((input.conflictPolicy ?? 'prefer_larger_final_tree') === 'preserve_conflict') {
      conflicts.push(...conflicted.map(({ path, kind, runHash, currentHash }) => ({
        path, kind, runSha256: runHash, currentSha256: currentHash,
      })));
    } else {
      const [runBytes, currentBytes] = await Promise.all([treeBytes(input.run), treeBytes(input.current)]);
      const runWins = runBytes > currentBytes;
      for (const item of conflicted) {
        const run = input.run.get(item.path) ?? null;
        const current = input.current.get(item.path) ?? null;
        const winner = runWins ? run : current;
        writes.push({ path: item.path, oid: winner?.oid ?? null, ...(winner ? { mode: winner.mode } : {}) });
        resolvedByLargerTree.push({ path: item.path, kind: item.kind, runSha256: item.runHash, currentSha256: item.currentHash,
          winner: runWins ? 'run' : 'current', runTreeBytes: runBytes, currentTreeBytes: currentBytes });
      }
    }
  }

  return { writes, conflicts, resolvedByLargerTree, clean: conflicts.length === 0 };
}

export { EMPTY_TREE };
