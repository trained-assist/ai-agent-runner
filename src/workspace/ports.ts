/**
 * Порты модуля постоянного workspace. Всё внешнее инжектится: Git — примитивами,
 * тяжёлые байты — долговечным object storage, привязка профиля — хранилищем binding'ов,
 * создание репозитория — административным портом хоста.
 *
 * Почему так мелко: политика, диффы, three-way merge, CAS и durable-журнал живут в модуле,
 * а не в адаптере. Тогда приёмка детерминирована (фейки и локальные bare-репозитории),
 * а смена Git-транспорта не меняет смысл операций.
 *
 * Секретов в портах нет: токен передаётся параметром и не попадает ни в argv, ни в
 * журнал — см. `tokenRef` и реализацию локального git-порта.
 */

import type { BlobHead, BlobRef } from '../storage/blob-store.js';
import type { ProfileRepositoryBinding } from './contract.js';

/**
 * Object storage для тяжёлых артефактов. Структурно совместим с существующим `BlobStore`
 * runner'а — новый контракт хранилища ради этого модуля не заводится: put/get/head с
 * sha256 и размером уже закрывают требование «в git только ref/checksum».
 */
export type WorkspaceObjectStore = {
  put(key: string, bytes: Uint8Array | string, options?: { deadlineMs?: number }): Promise<BlobRef>;
  get(key: string, options?: { deadlineMs?: number }): Promise<Buffer>;
  head(key: string, options?: { deadlineMs?: number }): Promise<BlobHead>;
};

/** Создание приватного репозитория профиля. Организационный credential остаётся у хоста. */
export interface RepositoryAdminPort {
  /**
   * Идемпотентно создать или прочитать приватный репозиторий. Имя уже занято чужим
   * репозиторием — это ошибка порта (`WORKSPACE_FOREIGN_REPOSITORY`), а не тихий `exists`:
   * вызывающая сторона решает, можно ли принять существующий.
   */
  ensurePrivateRepository(input: {
    owner: string;
    name: string;
    private: boolean;
    description: string;
  }): Promise<{ fullName: string; url: string; created: boolean; private: boolean }>;
}

/** Хранилище привязки профиль → репозиторий. Источник истины о «чьё это репозиторий». */
export interface BindingStorePort {
  get(bindingId: string): Promise<ProfileRepositoryBinding | null>;
  findByProfile(tenantId: string, profileId: string): Promise<ProfileRepositoryBinding | null>;
  save(binding: ProfileRepositoryBinding): Promise<void>;
  list(tenantId?: string): Promise<ProfileRepositoryBinding[]>;
}

export interface GitTreeEntry {
  /** `100644` blob, `100755` executable blob, `120000` symlink, `160000` submodule. */
  mode: string;
  oid: string;
  path: string;
}

export const GIT_MODE_FILE = '100644';
export const GIT_MODE_EXEC = '100755';
export const GIT_MODE_LINK = '120000';
export const GIT_MODE_SUBMODULE = '160000';

export type PushOutcome = 'pushed' | 'head_changed' | 'rejected' | 'unknown';

export interface GitMirror {
  /** Локальный bare-репозиторий модуля: клон/fetch зеркала профиля. */
  dir: string;
  bindingId: string;
}

export interface TreeWrite {
  /** Путь в дереве репозитория (слеши, относительный). */
  path: string;
  /** `null` — путь удаляется из дерева. */
  oid: string | null;
  mode?: string;
}

/**
 * Git-примитивы, которых требует модуль. Реализация — `createLocalGitPort()` поверх
 * локального `git` CLI (в тестах — над `file://` bare-репозиториями, без сети).
 *
 * Ни одна операция не работает в рабочем дереве рана: clean room агента не содержит
 * `.git`, remote и тем более организационного credential'а.
 */
export interface GitRepositoryPort {
  /** Создать зеркало, если его нет; иначе привести к актуальному состоянию remote. */
  ensureMirror(binding: ProfileRepositoryBinding, credentials: GitCredentials): Promise<GitMirror>;
  fetch(mirror: GitMirror, credentials: GitCredentials): Promise<void>;
  /** null — ветка ещё не существует (репозиторий пуст). */
  head(mirror: GitMirror, ref?: string): Promise<string | null>;
  listTree(mirror: GitMirror, revision: string): Promise<GitTreeEntry[]>;
  readBlob(mirror: GitMirror, oid: string): Promise<Buffer>;
  /** Записать байты как blob и вернуть oid (объект переживает смерть VM). */
  hashObject(mirror: GitMirror, bytes: Uint8Array): Promise<string>;
  /** Собрать дерево поверх `baseRevision` из набора путей; `null` в TreeWrite = удаление. */
  writeTree(mirror: GitMirror, baseRevision: string | null, writes: readonly TreeWrite[]): Promise<string>;
  /** Коммит с заданными родителями. Пустой `parents` — первый коммит репозитория. */
  commitTree(
    mirror: GitMirror,
    input: { tree: string; parents: string[]; message: string; author: GitAuthor; metadata?: Record<string, string> },
  ): Promise<string>;
  /** Трёхстороннее слияние одного файла по blob'ам. */
  mergeBlobs(
    mirror: GitMirror,
    input: { baseOid: string | null; currentOid: string | null; otherOid: string | null },
  ): Promise<{ status: 'clean' | 'conflict' | 'unchanged'; oid: string | null; detail: string | null }>;
  /**
   * Compare-and-swap ветки. `expectedHead === null` — ветки ещё нет.
   * Контракт запрещает force push: реализация обязана вернуть `head_changed`, а не
   * перезаписать чужую голову.
   */
  pushBranch(
    mirror: GitMirror,
    input: { branch: string; commit: string; expectedHead: string | null; credentials: GitCredentials },
  ): Promise<{ outcome: PushOutcome; detail: string | null }>;
  /**
   * Push неканонического ref кандидата (`refs/workspace/publications/<id>`).
   * Он не трогает голову профиля и существует ровно для восстановления публикации.
   */
  pushCandidateRef(
    mirror: GitMirror,
    input: { ref: string; commit: string; credentials: GitCredentials },
  ): Promise<{ outcome: PushOutcome; detail: string | null }>;
  /** Есть ли коммит в репозитории (для сверки неизвестного исхода push). */
  hasCommit(mirror: GitMirror, commit: string): Promise<boolean>;
  /** Является ли `ancestor` предком `commit` (публикация уже применена иначе). */
  isAncestor(mirror: GitMirror, ancestor: string, commit: string): Promise<boolean>;
  /** Ref, в котором лежит кандидат публикации; null — ref нет (или локальный путь). */
  candidateRefCommit(mirror: GitMirror, ref: string): Promise<string | null>;
}

export interface GitAuthor {
  name: string;
  email: string;
}

export interface GitCredentials {
  /**
   * Ссылка на credential. Само значение модуль не логирует и не кладёт в argv; реализация
   * порта получает его через инжектированный резолвер (см. `CredentialResolver`).
   */
  tokenRef?: string;
}

/** Резолвер credential'а: значение уходит в git-процесс, но не в журнал и не в ошибки. */
export type CredentialResolver = (credentialRef: string) => string | undefined | Promise<string | undefined>;
