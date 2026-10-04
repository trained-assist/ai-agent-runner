/**
 * Profile Workspace service — восемь методов контракта PR #131
 * (AGENT-RUNNER-DATA-PERSISTENCE-IMPLEMENTATION.md, раздел «Постоянный пользовательский
 * workspace», 04.10.2026).
 *
 * Модуль не трогает lifecycle Runner, общий RunSpec, workflow и deployment: всё, что он
 * делает, — provisioning/binding, версия состояния, публикация и разрешение конфликтов
 * вокруг постоянного репозитория профиля.
 *
 * Инварианты, за которые отвечает этот файл:
 * - версия состояния = commit SHA, пустое состояние = EMPTY_TREE; git commit — не идентификатор рана;
 * - host определяет профиль и права: `tenantId`/`profileId` приходят из авторизованной
 *   identity, чужой профиль не читается и не публикуется;
 * - публикация — compare-and-swap по ожидаемой голове, без force push и молчаливого overwrite;
 * - engine status, publication status и cleanup status разделены;
 * - неопубликованные данные не удаляются: cleanup разрешён, когда кандидат и артефакты
 *   пережили удаление временной среды, иначе они остаются единственной копией;
 * - потеря связи и неизвестный исход push приводят к сверке, а не к повторному движку.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256Hex } from '../storage/blob-store.js';
import { mimeForName } from '../storage/export-manifest.js';
import { isSafeRelativePath, resolveInsideRoot } from '../storage/local-paths.js';
import {
  ARTIFACT_INDEX_PATH,
  changeSetHash,
  EMPTY_TREE,
  isCommitSha,
  PROFILE_MARKER_PATH,
  WorkspaceError,
  type EnsureProfileRepositoryResult,
  type ProfileRepositoryBinding,
  type ProfileWorkspaceSnapshot,
  type ProvisionBatchResult,
  type ProvisionProfileResult,
  type Readiness,
  type WorkspaceArtifactRef,
  type WorkspaceCandidateInput,
  type WorkspaceChangeEntry,
  type WorkspaceCleanupDecision,
  type WorkspaceConflict,
  type WorkspaceConflictEntry,
  type WorkspacePublication,
  type WorkspaceResolutionCandidate,
  type ResolveWorkspaceConflictResult,
  type SyncWorkspaceResult,
} from './contract.js';
import { branchRef, isWorkspaceBranch, runBranchName, syncBranchName } from './branches.js';
import { DEFAULT_BRANCH } from './git/local-git.js';
import type { WorkspaceJournalPort } from './journal.js';
import {
  DEFAULT_EXPORT_POLICY,
  assertWorkspaceDir,
  compilePolicy,
  matchRule,
  repositoryNameFor,
  scanWorkspace,
  type CompiledPolicy,
  type ExportPolicy,
  type ScannedFile,
} from './policy.js';
import type { BindingStorePort, GitMirror, GitRepositoryPort, RepositoryAdminPort, WorkspaceObjectStore } from './ports.js';
import { buildChangeSet, diffTrees, mergeTrees, toTreeMap, type TreeMap } from './tree.js';

export const DEFAULT_MERGE_ATTEMPTS = 3;
export const DEFAULT_RESOLUTION_ATTEMPTS = 2;
export const DEFAULT_MANIFEST_LIMITS = { maxFiles: 2000, maxBytes: 256 * 1024 * 1024 };
export const ARTIFACT_INDEX_VERSION = 1;
const COMMIT_AUTHOR = { name: 'Trained Assist Workspace', email: 'workspace@trained-assist.invalid' };

/** Служебные файлы модуля: в манифест рана не попадают, но в дереве репозитория остаются. */
const META_PATHS = new Set([PROFILE_MARKER_PATH, ARTIFACT_INDEX_PATH]);

export interface WorkspaceServiceDeps {
  git: GitRepositoryPort;
  objects: WorkspaceObjectStore;
  bindings: BindingStorePort;
  admin: RepositoryAdminPort;
  journal: WorkspaceJournalPort;
  policy?: ExportPolicy;
  /** Сколько раз пересчитать merge при конкурентной публикации, прежде чем объявить конфликт. */
  mergeAttempts?: number;
  /** Сколько попыток разрешения конфликта до `awaiting_user_input` (запрет цикла). */
  resolutionAttempts?: number;
  manifestLimits?: { maxFiles: number; maxBytes: number };
  defaultBranch?: string;
  now?: () => string;
  newId?: (prefix: string) => string;
}

export interface EnsureInput {
  operationId: string;
  tenantId: string;
  profileId: string;
  owner: string;
  private?: boolean;
  defaultBranch?: string;
  /** Ссылка на credential хоста; без неё remote не читается. */
  credentialTokenRef?: string;
  description?: string;
}

export interface ProvisionProfileInput {
  profileId: string;
  /** Копия профиля на диске: источник импорта. Боевые профили не читаются. */
  sourcePath?: string;
}

export interface ProvisionInput {
  operationId: string;
  tenantId: string;
  owner: string;
  inventory: readonly ProvisionProfileInput[];
  dryRun: boolean;
  limit?: number;
  credentialTokenRef?: string;
}

export interface PrepareInput {
  operationId: string;
  tenantId: string;
  profileId: string;
  /** Явная ревизия; по умолчанию — актуальная голова. */
  revision?: string | null;
  credentialTokenRef?: string;
}

export interface SyncInput {
  operationId: string;
  tenantId: string;
  profileId: string;
  direction: 'pull' | 'publish';
  workspacePath: string;
  paths?: readonly string[];
  baseRevision?: string;
  credentialTokenRef?: string;
}

export interface PublishRunChangesInput {
  operationId: string;
  tenantId: string;
  profileId: string;
  runId: string;
  ownerGeneration?: number;
  workspacePath: string;
  /** Версия, зафиксированная ран'ом при старте (см. `prepare_profile_workspace`). */
  baseRevision: string;
  paths?: readonly string[];
  credentialTokenRef?: string;
  message?: string;
}

export interface GetPublicationInput {
  publicationId?: string;
  operationId?: string;
  tenantId?: string;
  /** Сверка с git после неизвестного исхода push; по умолчанию включена. */
  reconcile?: boolean;
  credentialTokenRef?: string;
}

export interface ResolveConflictInput {
  operationId: string;
  tenantId: string;
  conflictId: string;
  resolution: WorkspaceCandidateInput;
  credentialTokenRef?: string;
}

export interface PublishResolutionInput {
  operationId: string;
  tenantId: string;
  candidateId: string;
  expectedHeadRevision: string | null;
  credentialTokenRef?: string;
}

interface Principal {
  tenantId: string;
  profileId: string;
  credentialTokenRef?: string;
}

interface PublishFromFilesInput {
  operationId: string;
  principal: Principal;
  binding: ProfileRepositoryBinding;
  workspacePath: string;
  files: readonly ScannedFile[];
  baseRevision: string;
  origin: WorkspacePublication['origin'];
  runId: string | null;
  ownerGeneration: number | null;
  message: string;
}

export class WorkspaceService {
  private readonly git: GitRepositoryPort;
  private readonly objects: WorkspaceObjectStore;
  private readonly bindings: BindingStorePort;
  private readonly admin: RepositoryAdminPort;
  private readonly journal: WorkspaceJournalPort;
  private readonly policy: CompiledPolicy;
  private readonly mergeAttempts: number;
  private readonly resolutionAttempts: number;
  private readonly manifestLimits: { maxFiles: number; maxBytes: number };
  private readonly branch: string;
  private readonly now: () => string;
  private readonly newId: (prefix: string) => string;

  constructor(deps: WorkspaceServiceDeps) {
    this.git = deps.git;
    this.objects = deps.objects;
    this.bindings = deps.bindings;
    this.admin = deps.admin;
    this.journal = deps.journal;
    this.policy = compilePolicy(deps.policy ?? DEFAULT_EXPORT_POLICY);
    this.mergeAttempts = Math.max(1, deps.mergeAttempts ?? DEFAULT_MERGE_ATTEMPTS);
    this.resolutionAttempts = Math.max(1, deps.resolutionAttempts ?? DEFAULT_RESOLUTION_ATTEMPTS);
    this.manifestLimits = deps.manifestLimits ?? DEFAULT_MANIFEST_LIMITS;
    this.branch = deps.defaultBranch ?? DEFAULT_BRANCH;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? ((prefix: string) => `${prefix}-${randomBytes(10).toString('hex')}`);
  }

  // ── ensure_profile_repository ────────────────────────────────────────────────

  /**
   * Идемпотентно создаёт (или проверяет) приватный репозиторий профиля и сохраняет
   * binding. Повтор с тем же `operationId` возвращает тот же результат; повтор с другим
   * `operationId` тоже не создаёт второй репозиторий — имя выводится чистой функцией из
   * `profileId`, а существующий репозиторий переиспользуется после проверки
   * принадлежности.
   */
  async ensureProfileRepository(input: EnsureInput): Promise<EnsureProfileRepositoryResult> {
    const { result } = await this.journal.runOperation({
      operationId: input.operationId,
      method: 'ensure_profile_repository',
      payload: {
        tenantId: input.tenantId,
        profileId: input.profileId,
        owner: input.owner,
        private: input.private ?? true,
        defaultBranch: input.defaultBranch ?? this.branch,
      },
      execute: () => this.ensureInternal(input),
    });
    return result;
  }

  private async ensureInternal(input: EnsureInput): Promise<EnsureProfileRepositoryResult> {
    const principal = this.principal(input.tenantId, input.profileId);
    const isPrivate = input.private ?? true;
    const branch = input.defaultBranch ?? this.branch;
    const existing = await this.bindings.findByProfile(principal.tenantId, principal.profileId);
    const name = repositoryNameFor(principal.profileId);

    const created = await this.admin.ensurePrivateRepository({
      owner: input.owner,
      name,
      private: isPrivate,
      description: input.description ?? `Trained Assist profile workspace for ${principal.profileId}`,
    });
    if (!created.private) {
      // Публичный репозиторий профиля — утечка рабочих данных пользователя. Модуль не
      // чинит это молча и не принимает такой репозиторий: ошибка видна оператору.
      throw new WorkspaceError('WORKSPACE_REPOSITORY_NOT_PRIVATE', `repository ${created.fullName} is not private; a profile workspace must be private`, {
        detail: { repository: created.fullName },
      });
    }

    const bindingId = existing?.bindingId ?? bindingIdFor(principal.tenantId, principal.profileId);
    const binding: ProfileRepositoryBinding = {
      schemaVersion: 1,
      bindingId,
      tenantId: principal.tenantId,
      profileId: principal.profileId,
      owner: input.owner,
      repository: created.fullName,
      url: created.url,
      private: created.private,
      branch,
      headRevision: existing?.headRevision ?? null,
      importedAt: existing?.importedAt ?? null,
      importManifestHash: existing?.importManifestHash ?? null,
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: this.now(),
    };

    // Принадлежность проверяется всегда, кроме репозитория, созданного этим вызовом:
    // пустой новый репозиторий проверять не о чем, а любой существующий — надо, иначе
    // чужой образ молча стал бы «профилем пользователя». Если чтение требует credential'а,
    // которого нет, ошибка приходит из git-порта: «не смог проверить» — это отказ, а не
    // тихий пропуск проверки.
    if (!created.created) {
      const mirror = await this.git.ensureMirror(binding, { tokenRef: input.credentialTokenRef });
      const head = await this.git.head(mirror, branch);
      await this.assertRepositoryOwnership(mirror, head, principal);
      binding.headRevision = head;
    }

    await this.bindings.save(binding);
    this.journal.putBinding(binding);

    const imported = binding.importedAt !== null;
    const readiness: Readiness = imported || binding.headRevision !== null ? 'ready' : 'not_ready';
    return {
      bindingId,
      tenantId: principal.tenantId,
      profileId: principal.profileId,
      repository: binding.repository,
      url: binding.url,
      branch: binding.branch,
      private: binding.private,
      created: created.created,
      headRevision: binding.headRevision,
      imported,
      readiness,
    };
  }

  /**
   * Репозиторий принадлежит профилю, если он пуст или несёт наш маркер с тем же
   * `profileId`. Чужой репозиторий с историей — ошибка, а не «попробуем»: его данные не
   * должны попасть в профиль, а профиль — в чужой образ.
   */
  private async assertRepositoryOwnership(mirror: GitMirror, head: string | null, principal: Principal): Promise<void> {
    if (head === null) return;
    const entries = toTreeMap(await this.git.listTree(mirror, head));
    const marker = entries.get(PROFILE_MARKER_PATH);
    if (!marker) {
      throw new WorkspaceError(
        'WORKSPACE_FOREIGN_REPOSITORY',
        `repository has commits but no ${PROFILE_MARKER_PATH} marker; adopting a repository of unknown provenance is an explicit operator decision`,
        { detail: { profileId: principal.profileId, headRevision: head } },
      );
    }
    let parsed: { profileId?: unknown } = {};
    try {
      parsed = JSON.parse((await this.git.readBlob(mirror, marker.oid)).toString('utf8')) as { profileId?: unknown };
    } catch {
      throw new WorkspaceError('WORKSPACE_FOREIGN_REPOSITORY', `repository marker ${PROFILE_MARKER_PATH} is not readable JSON`);
    }
    if (parsed.profileId !== principal.profileId) {
      throw new WorkspaceError('WORKSPACE_FORBIDDEN', `repository belongs to profile "${String(parsed.profileId)}", the caller acts for "${principal.profileId}"`, {
        detail: { markerProfileId: String(parsed.profileId), requestedProfileId: principal.profileId },
      });
    }
  }

  // ── provision_existing_profile_repositories ──────────────────────────────────

  /**
   * Возобновляемая batch-операция: inventory (от хоста) → dry-run → ensure → import → verify.
   * Возобновляемость держится на cursor в журнале, а не на памяти процесса: падение на
   * любом профиле не теряет сделанное и не начинает сначала. Создание пустого репозитория
   * импортом не считается: `imported` появляется только после verify содержимого.
   */
  async provisionExistingProfileRepositories(input: ProvisionInput): Promise<ProvisionBatchResult> {
    const inventory = [...input.inventory].sort((a, b) => a.profileId.localeCompare(b.profileId));
    const cursor = this.journal.getBatchCursor(input.operationId);
    const startIndex = cursor ? inventory.findIndex((item) => item.profileId === cursor) + 1 : 0;
    const limit = input.limit && input.limit > 0 ? input.limit : inventory.length;
    const results: ProvisionProfileResult[] = [];

    for (const entry of inventory.slice(Math.max(0, startIndex), Math.max(0, startIndex) + limit)) {
      const result = input.dryRun ? this.planImport(input, entry) : await this.runImport(input, entry);
      results.push(result);
      // Курсор двигается только по успешно обработанному профилю. Иначе упавший профиль
      // считался бы «пройденным», и повторный вызов никогда бы его не повторил — а
      // возобновляемость batch как раз для этого и нужна.
      if (result.status === 'failed') break;
      this.journal.setBatchCursor(input.operationId, entry.profileId);
    }

    const failed = results.filter((item) => item.status === 'failed');
    const status: ProvisionBatchResult['status'] =
      results.length === 0 ? 'completed' : failed.length === 0 ? 'completed' : failed.length === results.length ? 'failed' : 'partial';
    return {
      operationId: input.operationId,
      dryRun: input.dryRun,
      status,
      cursor: this.journal.getBatchCursor(input.operationId),
      processed: results.length,
      results,
    };
  }

  /** Dry-run: план и метрики без единого обращения к remote и без записи в git. */
  private planImport(input: ProvisionInput, entry: ProvisionProfileInput): ProvisionProfileResult {
    const repository = `${input.owner}/${repositoryNameFor(entry.profileId)}`;
    if (!entry.sourcePath) {
      return { profileId: entry.profileId, status: 'skipped', repository, plan: ['ensure'], files: 0, bytes: 0, excluded: [], headRevision: null, error: null };
    }
    const scan = scanWorkspace(this.policy, assertWorkspaceDir(entry.sourcePath));
    return {
      profileId: entry.profileId,
      status: 'skipped',
      repository,
      plan: ['ensure', `import:${scan.files.length}`, `verify:${scan.files.length}`],
      files: scan.files.length,
      bytes: scan.totalBytes,
      excluded: scan.excluded.map((item) => `${item.path}: ${item.reason}`),
      headRevision: null,
      error: null,
    };
  }

  private async runImport(input: ProvisionInput, entry: ProvisionProfileInput): Promise<ProvisionProfileResult> {
    const repository = `${input.owner}/${repositoryNameFor(entry.profileId)}`;
    const excluded = (scan: { excluded: { path: string; reason: string }[] }): string[] => scan.excluded.map((item) => `${item.path}: ${item.reason}`);
    try {
      const ensured = await this.ensureInternal({
        operationId: `${input.operationId}:ensure:${entry.profileId}`,
        tenantId: input.tenantId,
        profileId: entry.profileId,
        owner: input.owner,
        credentialTokenRef: input.credentialTokenRef,
      });
      if (!entry.sourcePath) {
        return {
          profileId: entry.profileId,
          status: ensured.imported ? 'verified' : 'ensured',
          repository: ensured.repository,
          plan: [],
          files: 0,
          bytes: 0,
          excluded: [],
          headRevision: ensured.headRevision,
          // Репозиторий создан, но данных профиля не завезено — это не импорт.
          error: ensured.imported ? null : 'repository ensured, profile data not imported (no source copy was provided)',
        };
      }
      const scan = scanWorkspace(this.policy, assertWorkspaceDir(entry.sourcePath));
      const manifestHash = sha256Hex(JSON.stringify(scan.files.map((file) => [file.path, file.sha256, file.size])));
      const binding = await this.requireBinding(input.tenantId, entry.profileId);
      if (binding.importedAt !== null && binding.importManifestHash === manifestHash) {
        // Повторный проход по уже завезённой копии — no-op: история не переписывается.
        return {
          profileId: entry.profileId,
          status: 'verified',
          repository: binding.repository,
          plan: [],
          files: scan.files.length,
          bytes: scan.totalBytes,
          excluded: excluded(scan),
          headRevision: binding.headRevision,
          error: null,
        };
      }

      const publication = await this.publishFromFiles({
        operationId: `${input.operationId}:import:${entry.profileId}`,
        principal: { tenantId: input.tenantId, profileId: entry.profileId, credentialTokenRef: input.credentialTokenRef },
        binding,
        workspacePath: assertWorkspaceDir(entry.sourcePath),
        files: scan.files,
        baseRevision: binding.headRevision ?? EMPTY_TREE,
        origin: 'sync_publish',
        runId: null,
        ownerGeneration: null,
        message: `import profile workspace: ${entry.profileId}`,
      });

      const verified = await this.verifyImport(binding, publication, scan.files);
      const at = this.now();
      const updated: ProfileRepositoryBinding = {
        ...binding,
        headRevision: publication.committedRevision ?? binding.headRevision,
        importedAt: verified.ok ? at : binding.importedAt,
        importManifestHash: verified.ok ? manifestHash : binding.importManifestHash,
        updatedAt: at,
      };
      await this.bindings.save(updated);
      this.journal.putBinding(updated);

      return {
        profileId: entry.profileId,
        status: verified.ok ? 'imported' : 'failed',
        repository: binding.repository,
        plan: ['ensure', 'import', 'verify'],
        files: scan.files.length,
        bytes: scan.totalBytes,
        excluded: excluded(scan),
        headRevision: updated.headRevision,
        error: verified.ok ? null : verified.reason,
      };
    } catch (err) {
      return {
        profileId: entry.profileId,
        status: 'failed',
        repository,
        plan: ['ensure', 'import', 'verify'],
        files: 0,
        bytes: 0,
        excluded: [],
        headRevision: null,
        error: err instanceof WorkspaceError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Проверка импорта: дерево и хэши совпадают, запрещённых путей и symlink в образе нет. */
  private async verifyImport(
    binding: ProfileRepositoryBinding,
    publication: WorkspacePublication,
    files: readonly ScannedFile[],
  ): Promise<{ ok: boolean; reason: string | null }> {
    if (publication.status !== 'published' || !publication.committedRevision) {
      return { ok: false, reason: `publication ended as "${publication.status}" (${publication.reason ?? 'no reason recorded'})` };
    }
    const mirror = await this.mirrorFor(binding);
    const entries = toTreeMap(await this.git.listTree(mirror, publication.committedRevision));
    const artifacts = await this.readArtifactIndex(mirror, publication.committedRevision);
    for (const file of files) {
      // Тяжёлый объект в дереве git отсутствует по построению: проверяется его ref.
      if (file.action === 'heavy') {
        const declared = artifacts.get(file.path);
        if (!declared || !(await this.verifyArtifact(declared))) {
          return { ok: false, reason: `artifact for "${file.path}" is not verifiable in object storage` };
        }
        continue;
      }
      const entry = entries.get(file.path);
      if (!entry) return { ok: false, reason: `imported tree has no "${file.path}"` };
      const digest = sha256Hex(await this.git.readBlob(mirror, entry.oid));
      if (digest !== file.sha256) return { ok: false, reason: `imported "${file.path}" has digest ${digest.slice(0, 12)}…, expected ${file.sha256.slice(0, 12)}…` };
    }
    for (const [path, entry] of entries) {
      if (META_PATHS.has(path)) continue;
      if (entry.mode === '120000') return { ok: false, reason: `imported tree carries a symlink at "${path}"` };
      if (matchRule(this.policy, path).action === 'exclude') {
        return { ok: false, reason: `imported tree carries a path excluded by policy: "${path}"` };
      }
    }
    return { ok: true, reason: null };
  }

  // ── prepare_profile_workspace ────────────────────────────────────────────────

  /**
   * Готовит разрешённые данные конкретного commit: возвращает `baseRevision` и манифест
   * для существующего materializer'а (#52/#69). Тяжёлые объекты представлены
   * проверенными ref'ами в object storage, а не байтами; недоступный объект в манифест
   * не попадает, а попадает в `warnings` — «снимок, который врёт про наличие данных»,
   * получить нельзя.
   */
  async prepareProfileWorkspace(input: PrepareInput): Promise<ProfileWorkspaceSnapshot> {
    const { result } = await this.journal.runOperation({
      operationId: input.operationId,
      method: 'prepare_profile_workspace',
      payload: { tenantId: input.tenantId, profileId: input.profileId, revision: input.revision ?? null },
      execute: async () => {
        const principal = this.principal(input.tenantId, input.profileId, input.credentialTokenRef);
        const binding = await this.requireBinding(principal.tenantId, principal.profileId);
        const mirror = await this.mirrorFor(binding, principal.credentialTokenRef);
        const head = await this.git.head(mirror, binding.branch);
        if (input.revision !== undefined && input.revision !== null && input.revision !== EMPTY_TREE && !isCommitSha(input.revision)) {
          throw new WorkspaceError('WORKSPACE_INVALID', `revision "${input.revision}" is neither a commit sha nor the empty tree`);
        }
        const revision = input.revision ?? head ?? EMPTY_TREE;
        if (revision !== (head ?? EMPTY_TREE)) {
          await this.assertRepositoryOwnership(mirror, revision, principal);
        }

        const entries = toTreeMap(await this.git.listTree(mirror, revision));
        const artifacts = await this.readArtifactIndex(mirror, revision);
        const warnings: string[] = [];
        const manifest: ProfileWorkspaceSnapshot['manifest'] = [];
        let bytes = 0;
        let artifactCount = 0;

        for (const [path, entry] of [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          if (META_PATHS.has(path)) continue;
          if (matchRule(this.policy, path).action === 'exclude') {
            warnings.push(`skipped ${path}: excluded by export policy`);
            continue;
          }
          if (entry.mode === '120000') {
            warnings.push(`skipped ${path}: symlink`);
            continue;
          }
          if (manifest.length >= this.manifestLimits.maxFiles) {
            throw new WorkspaceError('WORKSPACE_TOO_LARGE', `profile workspace holds more than ${this.manifestLimits.maxFiles} files`);
          }
          const declared = artifacts.get(path);
          if (declared) {
            if (!(await this.verifyArtifact(declared))) {
              warnings.push(`skipped ${path}: artifact is unavailable or does not match its checksum`);
              continue;
            }
            manifest.push({ path, sha256: declared.sha256, size: declared.size, mime: declared.mime, artifact: declared });
            artifactCount += 1;
            bytes += declared.size;
            continue;
          }
          const content = await this.git.readBlob(mirror, entry.oid);
          bytes += content.length;
          if (bytes > this.manifestLimits.maxBytes) {
            throw new WorkspaceError('WORKSPACE_TOO_LARGE', `profile workspace exceeds the ${this.manifestLimits.maxBytes} byte manifest limit`);
          }
          manifest.push({ path, sha256: sha256Hex(content), size: content.length, mime: mimeForName(path), artifact: null });
        }

        // Тяжёлые объекты в дереве git отсутствуют — они приходят из реестра артефактов.
        // Без этого блока подготовка рана «забывала» бы ровно те файлы, ради которых
        // профиль и нужен: тяжёлые.
        for (const [path, declared] of [...artifacts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          if (manifest.some((item) => item.path === path)) continue;
          if (matchRule(this.policy, path).action === 'exclude') {
            warnings.push(`skipped ${path}: excluded by export policy`);
            continue;
          }
          if (!(await this.verifyArtifact(declared))) {
            warnings.push(`skipped ${path}: artifact is unavailable or does not match its checksum`);
            continue;
          }
          if (manifest.length >= this.manifestLimits.maxFiles) {
            throw new WorkspaceError('WORKSPACE_TOO_LARGE', `profile workspace holds more than ${this.manifestLimits.maxFiles} files`);
          }
          manifest.push({ path, sha256: declared.sha256, size: declared.size, mime: declared.mime, artifact: declared });
          artifactCount += 1;
          bytes += declared.size;
          if (bytes > this.manifestLimits.maxBytes) {
            throw new WorkspaceError('WORKSPACE_TOO_LARGE', `profile workspace exceeds the ${this.manifestLimits.maxBytes} byte manifest limit`);
          }
        }
        manifest.sort((a, b) => a.path.localeCompare(b.path));

        return {
          schemaVersion: 1,
          workspaceSnapshotId: this.newId('wssnap'),
          bindingId: binding.bindingId,
          profileId: binding.profileId,
          baseRevision: revision,
          headRevision: head,
          manifest,
          files: manifest.length,
          bytes,
          artifacts: artifactCount,
          warnings,
          exportPolicyId: this.policy.policy.policyId,
          createdAt: this.now(),
        } satisfies ProfileWorkspaceSnapshot;
      },
    });
    return result;
  }

  // ── sync_profile_workspace ───────────────────────────────────────────────────

  /**
   * Явная host-команда: pull или publish. Двустороннего «last-writer-wins» нет —
   * направление задаёт вызывающий, а pull не трогает локальные изменения и сообщает о
   * них вместо затирания.
   */
  async syncProfileWorkspace(input: SyncInput): Promise<SyncWorkspaceResult> {
    if (input.direction === 'publish') {
      const { result } = await this.journal.runOperation({
        operationId: input.operationId,
        method: 'sync_profile_workspace',
        payload: {
          tenantId: input.tenantId,
          profileId: input.profileId,
          direction: 'publish',
          baseRevision: input.baseRevision ?? null,
          paths: input.paths ?? null,
        },
        execute: async () => {
          const principal = this.principal(input.tenantId, input.profileId, input.credentialTokenRef);
          const binding = await this.requireBinding(principal.tenantId, principal.profileId);
          const workspace = assertWorkspaceDir(input.workspacePath);
          const scan = scanWorkspace(this.policy, workspace, input.paths ? { paths: input.paths } : {});
          const publication = await this.publishFromFiles({
            operationId: input.operationId,
            principal,
            binding,
            workspacePath: workspace,
            files: scan.files,
            baseRevision: input.baseRevision ?? binding.headRevision ?? EMPTY_TREE,
            origin: 'sync_publish',
            runId: null,
            ownerGeneration: null,
            message: `host sync publish for ${binding.profileId}`,
          });
          return publicationToSyncResult(publication);
        },
      });
      return result;
    }

    const principal = this.principal(input.tenantId, input.profileId, input.credentialTokenRef);
    const binding = await this.requireBinding(principal.tenantId, principal.profileId);
    const workspace = assertWorkspaceDir(input.workspacePath);
    const scan = scanWorkspace(this.policy, workspace, input.paths ? { paths: input.paths } : {});
    // Пустой каталог = свежая материализация, а не «пользователь удалил всё». Различать
    // это нужно, иначе первое же pull в чистую среду отказывало бы с local_changes, а
    // publish из того же каталога честно означал бы удаление всех файлов.
    const localChanges = scan.files.length === 0 ? [] : await this.localChanges(principal, binding, workspace, scan.files);

    if (localChanges.length > 0) {
      // Незаписанные локальные изменения — причина отказа, а не предупреждение: pull их
      // не затирает и не публикует за пользователя.
      return {
        status: 'local_changes',
        bindingId: binding.bindingId,
        profileId: binding.profileId,
        localChanges,
        revision: binding.headRevision,
        publicationId: null,
        conflictId: null,
        reason: `${localChanges.length} local change(s) are not published yet; pull did not touch them`,
      };
    }

    const mirror = await this.mirrorFor(binding, principal.credentialTokenRef);
    const head = await this.git.head(mirror, binding.branch);
    if (head === null) {
      return {
        status: 'pulled',
        bindingId: binding.bindingId,
        profileId: binding.profileId,
        localChanges: [],
        revision: null,
        publicationId: null,
        conflictId: null,
        reason: 'profile repository is still empty',
      };
    }
    const entries = toTreeMap(await this.git.listTree(mirror, head));
    const artifacts = await this.readArtifactIndex(mirror, head);
    let written = 0;
    for (const [path, entry] of entries) {
      // Служебные файлы и запрещённые пути не материализуются: pull не расширяет образ
      // профиля и не достаёт credential'ы на диск.
      if (META_PATHS.has(path) || matchRule(this.policy, path).action === 'exclude' || entry.mode === '120000') continue;
      const declared = artifacts.get(path);
      const bytes = declared ? await this.readArtifactBytes(declared) : await this.git.readBlob(mirror, entry.oid);
      const target = resolveInsideRoot(workspace, path, 'sync pull path');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      written += 1;
    }
    return {
      status: 'pulled',
      bindingId: binding.bindingId,
      profileId: binding.profileId,
      localChanges: [],
      revision: head,
      publicationId: null,
      conflictId: null,
      reason: `${written} file(s) materialized from ${head.slice(0, 12)}…`,
    };
  }

  /**
   * Локальные изменения = расхождение диска с головой по разрешённым путям (плюс
   * удаления). Проверяется до pull, поэтому «затереть незаписанное» невозможно.
   */
  private async localChanges(
    principal: Principal,
    binding: ProfileRepositoryBinding,
    workspace: string,
    files: readonly ScannedFile[],
  ): Promise<WorkspaceChangeEntry[]> {
    const mirror = await this.mirrorFor(binding, principal.credentialTokenRef);
    const head = await this.git.head(mirror, binding.branch);
    const base: TreeMap = head === null ? new Map() : toTreeMap(await this.git.listTree(mirror, head));
    const artifacts = head === null ? new Map<string, WorkspaceArtifactRef>() : await this.readArtifactIndex(mirror, head);
    const changes: WorkspaceChangeEntry[] = [];
    void workspace;

    for (const file of files) {
      const entry = base.get(file.path);
      const declared = artifacts.get(file.path);
      if (!entry) {
        changes.push({ path: file.path, kind: 'add', sha256: file.sha256, size: file.size, artifact: null });
        continue;
      }
      if (entry.mode === '120000') continue;
      const headSha = declared ? declared.sha256 : sha256Hex(await this.git.readBlob(mirror, entry.oid));
      if (headSha !== file.sha256) {
        changes.push({ path: file.path, kind: 'update', sha256: file.sha256, size: file.size, artifact: null });
      }
    }
    for (const [path, entry] of base) {
      if (META_PATHS.has(path) || entry.mode === '120000' || artifacts.has(path)) continue;
      if (matchRule(this.policy, path).action === 'exclude') continue;
      if (!files.some((file) => file.path === path)) {
        changes.push({ path, kind: 'delete', sha256: null, size: 0, artifact: null });
      }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  // ── чтение байтов для materializer'а ─────────────────────────────────────────

  /**
   * Байты одного разрешённого пути на конкретной ревизии.
   *
   * Существует, чтобы интегратор не писал git-код при подключении materializer'а
   * (#52/#69): получает манифест, затем по одному пути — verified-байты. Для тяжёлого
   * объекта читается object storage с проверкой checksum, для текста — blob'а git.
   * Запрещённый политикой путь и выход за пределы workspace — отказ, а не пустой файл.
   */
  async readProfileBlob(input: {
    tenantId: string;
    profileId: string;
    revision: string;
    path: string;
    credentialTokenRef?: string;
  }): Promise<Buffer> {
    const principal = this.principal(input.tenantId, input.profileId, input.credentialTokenRef);
    if (!isCommitSha(input.revision) && input.revision !== EMPTY_TREE) {
      throw new WorkspaceError('WORKSPACE_INVALID', `revision "${input.revision}" is neither a commit sha nor the empty tree`);
    }
    if (typeof input.path !== 'string' || !isSafeRelativePath(input.path)) {
      throw new WorkspaceError('WORKSPACE_PATH_DENIED', `invalid profile path "${String(input.path)}"`);
    }
    const decision = matchRule(this.policy, input.path);
    if (decision.action === 'exclude') {
      throw new WorkspaceError('WORKSPACE_PATH_DENIED', `path "${input.path}" is excluded from the profile image: ${decision.reason}`);
    }
    const binding = await this.requireBinding(principal.tenantId, principal.profileId);
    const mirror = await this.mirrorFor(binding, principal.credentialTokenRef);
    const declared = (await this.readArtifactIndex(mirror, input.revision)).get(input.path);
    if (declared) return this.readArtifactBytes(declared);
    const entry = toTreeMap(await this.git.listTree(mirror, input.revision)).get(input.path);
    if (!entry) {
      throw new WorkspaceError('WORKSPACE_NOT_FOUND', `path "${input.path}" does not exist at revision ${input.revision}`);
    }
    if (entry.mode === '120000') {
      throw new WorkspaceError('WORKSPACE_PATH_DENIED', `path "${input.path}" is a symlink and is never materialized`);
    }
    return this.git.readBlob(mirror, entry.oid);
  }

  // ── publish_run_changes ──────────────────────────────────────────────────────

  /**
   * Сохраняет разрешённые изменения рана относительно `baseRevision`. Это операция
   * после движка: архивирование и уборка — отдельные операции, а успешный движок не
   * означает опубликованные данные (статус публикации читается отдельно).
   */
  async publishRunChanges(input: PublishRunChangesInput): Promise<WorkspacePublication> {
    if (input.runId.length === 0) {
      throw new WorkspaceError('WORKSPACE_INVALID', 'runId is required: a publication after a run must name the run it belongs to');
    }
    if (!isCommitSha(input.baseRevision) && input.baseRevision !== EMPTY_TREE) {
      throw new WorkspaceError('WORKSPACE_INVALID', `baseRevision "${input.baseRevision}" is neither a commit sha nor the empty tree`);
    }
    const { result } = await this.journal.runOperation({
      operationId: input.operationId,
      method: 'publish_run_changes',
      payload: {
        tenantId: input.tenantId,
        profileId: input.profileId,
        runId: input.runId,
        ownerGeneration: input.ownerGeneration ?? null,
        baseRevision: input.baseRevision,
        paths: input.paths ?? null,
      },
      execute: async () => {
        const principal = this.principal(input.tenantId, input.profileId, input.credentialTokenRef);
        const binding = await this.requireBinding(principal.tenantId, principal.profileId);
        const workspace = assertWorkspaceDir(input.workspacePath);
        const scan = scanWorkspace(this.policy, workspace, input.paths ? { paths: input.paths } : {});
        return this.publishFromFiles({
          operationId: input.operationId,
          principal,
          binding,
          workspacePath: workspace,
          files: scan.files,
          baseRevision: input.baseRevision,
          origin: 'run',
          runId: input.runId,
          ownerGeneration: input.ownerGeneration ?? null,
          message: input.message ?? `run ${input.runId} publishes profile workspace`,
        });
      },
    });
    return result;
  }

  // ── get_workspace_publication ────────────────────────────────────────────────

  /**
   * Durable-статус операции после reconnect/restart. Не повторяет движок: при
   * неизвестном исходе push делается сверка с git (голова и remote-кандидат), а при
   * подтверждённом «опубликовано» возвращается запись.
   */
  async getWorkspacePublication(input: GetPublicationInput): Promise<WorkspacePublication> {
    const record = input.publicationId
      ? this.journal.getPublication(input.publicationId)
      : input.operationId
        ? this.journal.findPublicationByOperation(input.operationId)
        : null;
    if (!record) {
      throw new WorkspaceError('WORKSPACE_NOT_FOUND', 'no publication is recorded for the requested publicationId/operationId');
    }
    if (input.tenantId && record.tenantId !== input.tenantId) {
      throw new WorkspaceError('WORKSPACE_FORBIDDEN', `publication ${record.publicationId} belongs to another tenant`, {
        detail: { publicationId: record.publicationId },
      });
    }
    if (input.reconcile === false) return record;
    if (record.status !== 'pending' && record.status !== 'publishing') return record;
    return this.reconcile(record, input.credentialTokenRef);
  }

  /**
   * Сверка неизвестного исхода. Три исхода проверяются по факту, а не по догадке:
   * голова == наш коммит → опубликовано; наш коммит предок головы → опубликовано
   * (это же содержимое опубликовал другой); иначе — кандидат пережил в remote, и
   * публикация доводится тем же CAS-протоколом, но без повторного движения.
   */
  private async reconcile(record: WorkspacePublication, credentialTokenRef?: string): Promise<WorkspacePublication> {
    let binding: ProfileRepositoryBinding;
    let mirror: GitMirror;
    try {
      binding = await this.requireBinding(record.tenantId, record.profileId);
      mirror = await this.mirrorFor(binding, credentialTokenRef);
    } catch (err) {
      return this.patchPublication(record, {
        status: 'pending',
        outcomeUnknown: true,
        reason: `reconcile could not reach the profile repository: ${err instanceof Error ? err.message : String(err)}`,
        cleanup: { cleanupAllowed: false, reason: 'the durable copy is not confirmed', retained: record.changes.map((item) => item.path) },
      });
    }

    const head = await this.git.head(mirror, binding.branch);
    const candidate = record.candidateCommit;
    if (candidate && head !== null) {
      if (head === candidate || (await this.git.isAncestor(mirror, candidate, head))) {
        return this.patchPublication(record, {
          status: 'published',
          committedRevision: head,
          outcomeUnknown: false,
          reason: 'reconciled: the profile head already contains this publication',
          committedAt: this.now(),
          cleanup: this.cleanupForPublished(record),
        });
      }
    }
    if (!candidate) {
      // Кандидат не построен — публиковать нечего, и повтор движка не запускается.
      return this.patchPublication(record, {
        status: 'pending',
        outcomeUnknown: true,
        reason: 'the publication has no durable candidate to complete; the engine must not be re-run to obtain one',
      });
    }
    const remoteCandidate = await this.git.candidateRefCommit(mirror, branchRef(record.branch));
    if (remoteCandidate !== candidate && !(await this.git.hasCommit(mirror, candidate))) {
      return this.patchPublication(record, {
        status: 'pending',
        outcomeUnknown: true,
        reason: 'the candidate commit is not in the profile repository; the publication cannot be completed from durable state',
        cleanup: { cleanupAllowed: false, reason: 'the candidate is not durable', retained: record.changes.map((item) => item.path) },
      });
    }

    return this.attemptPublication({
      record,
      binding,
      mirror,
      credentialTokenRef,
      runTreeSha: `${candidate}^{tree}`,
      runRevision: candidate,
      message: `completes publication ${record.publicationId}`,
    });
  }

  // ── resolve_workspace_conflict ───────────────────────────────────────────────

  /**
   * Готовит кандидата разрешения и evidence. Детерминированное слияние — первым;
   * агентский resolver приходит снаружи (модуль не строит agent runtime) и обязан
   * принести готовое дерево с `resolverRunId` и evidence. Семантическая неоднозначность →
   * `awaiting_user_input`; исчерпание попыток → тоже, но без нового автоматического раунда.
   */
  async resolveWorkspaceConflict(input: ResolveConflictInput): Promise<ResolveWorkspaceConflictResult> {
    const conflict = this.journal.getConflict(input.conflictId);
    if (!conflict) throw new WorkspaceError('WORKSPACE_NOT_FOUND', `conflict ${input.conflictId} is not in the journal`);
    if (conflict.tenantId !== input.tenantId) {
      throw new WorkspaceError('WORKSPACE_FORBIDDEN', `conflict ${input.conflictId} belongs to another tenant`);
    }
    const attempts = this.journal.bumpResolutionAttempts(conflict.conflictId);
    if (attempts > this.resolutionAttempts) {
      const reason = `resolution attempt limit reached (${this.resolutionAttempts}); the conflict needs a user decision`;
      this.markAwaitingUserInput(conflict, reason);
      return { status: 'awaiting_user_input', conflictId: conflict.conflictId, candidateId: null, attempts, entries: conflict.entries, reason };
    }

    const binding = await this.requireBinding(conflict.tenantId, conflict.profileId);
    const mirror = await this.mirrorFor(binding, input.credentialTokenRef);
    const head = await this.git.head(mirror, binding.branch);
    const source = input.resolution.kind;

    if (source === 'awaiting_user_input') {
      const reason = input.resolution.reason ?? 'the caller asked for a user decision';
      this.markAwaitingUserInput(conflict, reason);
      return { status: 'awaiting_user_input', conflictId: conflict.conflictId, candidateId: null, attempts, entries: conflict.entries, reason };
    }

    if (source === 'external_candidate') {
      if (!input.resolution.tree || !isCommitSha(input.resolution.tree)) {
        throw new WorkspaceError('WORKSPACE_INVALID', 'an external resolution candidate must carry a tree sha built in the workspace mirror');
      }
      if (!input.resolution.evidence || input.resolution.evidence.length === 0) {
        throw new WorkspaceError('WORKSPACE_INVALID', 'an external resolution candidate must carry evidence (what the resolver did and why)');
      }
      await this.assertCandidateTreeAllowed(mirror, input.resolution.tree, conflict.profileId);
      const candidate = this.newCandidate({
        conflict,
        binding,
        head,
        tree: input.resolution.tree,
        entries: conflict.entries,
        source,
        resolverRunId: input.resolution.resolverRunId ?? null,
        evidence: input.resolution.evidence,
      });
      return this.finishResolution(candidate, conflict, attempts);
    }

    const base = toTreeMap(await this.git.listTree(mirror, conflict.baseRevision));
    const current = toTreeMap(head === null ? [] : await this.git.listTree(mirror, head));
    const runTree = toTreeMap(await this.git.listTree(mirror, conflict.runRevision));
    const scope = new Set([...base.keys(), ...runTree.keys(), ...current.keys()]);
    const merged = await mergeTrees(this.git, mirror, { base, run: runTree, current, scope });
    const writes = [...merged.writes];

    if (source === 'deterministic') {
      const stillConflicting = conflict.entries.filter((entry) => merged.conflicts.some((item) => item.path === entry.path));
      if (stillConflicting.length > 0) {
        const reason = `a deterministic merge cannot resolve ${stillConflicting.length} path(s): ${stillConflicting.map((item) => item.path).join(', ')}`;
        this.markAwaitingUserInput(conflict, reason);
        return { status: 'awaiting_user_input', conflictId: conflict.conflictId, candidateId: null, attempts, entries: stillConflicting, reason };
      }
    } else {
      // Явный выбор стороны: решение оператора/хоста, а не догадка модуля. Оно
      // записывается в кандидат как источник и может быть опубликовано только при
      // ожидаемой голове.
      const side = source === 'run_side' ? runTree : current;
      for (const entry of conflict.entries) {
        const chosen = side.get(entry.path);
        writes.push(chosen ? { path: entry.path, oid: chosen.oid, mode: chosen.mode } : { path: entry.path, oid: null });
      }
    }

    const tree = await this.git.writeTree(mirror, head, writes);
    const candidate = this.newCandidate({
      conflict,
      binding,
      head,
      tree,
      entries: conflict.entries,
      source,
      resolverRunId: input.resolution.resolverRunId ?? null,
      evidence: input.resolution.evidence ?? `${source} resolution of conflict ${conflict.conflictId}`,
    });
    return this.finishResolution(candidate, conflict, attempts);
  }

  // ── publish_workspace_resolution ─────────────────────────────────────────────

  /**
   * Публикует кандидата только при ожидаемой актуальной версии. Голова успела измениться —
   * кандидат не публикуется: создаётся новый merge/конфликт, force push не используется.
   */
  async publishWorkspaceResolution(input: PublishResolutionInput): Promise<WorkspacePublication> {
    const candidate = this.journal.getCandidate(input.candidateId);
    if (!candidate) throw new WorkspaceError('WORKSPACE_NOT_FOUND', `candidate ${input.candidateId} is not in the journal`);
    if (candidate.tenantId !== input.tenantId) {
      throw new WorkspaceError('WORKSPACE_FORBIDDEN', `candidate ${input.candidateId} belongs to another tenant`);
    }
    const conflict = this.journal.getConflict(candidate.conflictId);
    if (!conflict) throw new WorkspaceError('WORKSPACE_NOT_FOUND', `conflict ${candidate.conflictId} is not in the journal`);
    const publication = this.journal
      .listPublications({ profileId: candidate.profileId })
      .find((item) => item.conflictId === conflict.conflictId);
    if (!publication) {
      throw new WorkspaceError('WORKSPACE_NOT_FOUND', `no publication is linked to conflict ${conflict.conflictId}`);
    }

    const binding = await this.requireBinding(candidate.tenantId, candidate.profileId);
    const mirror = await this.mirrorFor(binding, input.credentialTokenRef);
    const head = await this.git.head(mirror, binding.branch);

    if (candidate.expectedHeadRevision !== input.expectedHeadRevision) {
      return this.staleCandidate(publication, binding, conflict, candidate.tree, `the caller passed expectedHeadRevision ${String(input.expectedHeadRevision)}, the candidate was built against ${String(candidate.expectedHeadRevision)}`);
    }
    if (head !== input.expectedHeadRevision) {
      return this.staleCandidate(publication, binding, conflict, candidate.tree, `the profile head moved from ${input.expectedHeadRevision ?? 'null'} to ${head ?? 'null'} while the resolution was prepared`);
    }

    const current = head === null ? new Map<string, { mode: string; oid: string }>() : toTreeMap(await this.git.listTree(mirror, head));
    const candidateTree = toTreeMap(await this.git.listTree(mirror, candidate.tree));
    const diff = diffTrees(current, candidateTree);
    const writes = [
      ...[...diff.added, ...diff.updated].map((path) => ({ path, oid: candidateTree.get(path)?.oid ?? null, mode: candidateTree.get(path)?.mode })),
      ...diff.deleted.map((path) => ({ path, oid: null })),
    ];
    const tree = await this.git.writeTree(mirror, head, writes);
    const commit = await this.git.commitTree(mirror, {
      tree,
      parents: head ? [head] : [],
      message: `resolution of conflict ${conflict.conflictId} (candidate ${candidate.candidateId})`,
      author: COMMIT_AUTHOR,
      metadata: { publicationId: publication.publicationId, conflictId: conflict.conflictId, candidateId: candidate.candidateId },
    });
    const candidatePush = await this.git.pushRef(mirror, {
      ref: branchRef(publication.branch),
      commit,
      credentials: { tokenRef: input.credentialTokenRef },
    });
    const push = await this.git.pushBranch(mirror, {
      branch: binding.branch,
      commit,
      expectedHead: head,
      credentials: { tokenRef: input.credentialTokenRef },
    });
    if (push.outcome === 'head_changed') {
      return this.staleCandidate(publication, binding, conflict, candidate.tree, push.detail ?? 'the profile head changed during the resolution push');
    }
    if (push.outcome === 'unknown') {
      return this.patchPublication(publication, {
        status: 'pending',
        outcomeUnknown: true,
        candidateCommit: commit,
        candidatePushed: candidatePush.outcome === 'pushed',
        expectedHeadRevision: head,
        reason: push.detail ?? 'the resolution push has an unknown outcome; reconcile before retrying',
        cleanup: { cleanupAllowed: false, reason: 'the resolution push outcome is unknown', retained: publication.changes.map((item) => item.path) },
      });
    }
    if (push.outcome !== 'pushed') {
      return this.patchPublication(publication, {
        status: 'failed',
        reason: `the profile repository rejected the resolution: ${push.detail ?? 'no detail'}`,
        cleanup: { cleanupAllowed: false, reason: 'the resolution was not published', retained: publication.changes.map((item) => item.path) },
      });
    }
    await this.updateBindingHead(binding, commit);
    return this.patchPublication(publication, {
      status: 'published',
      committedRevision: commit,
      expectedHeadRevision: head,
      candidateCommit: commit,
      candidatePushed: candidatePush.outcome === 'pushed',
      outcomeUnknown: false,
      conflictId: null,
      candidateId: null,
      reason: `resolution candidate ${candidate.candidateId} published`,
      committedAt: this.now(),
      cleanup: this.cleanupForPublished(publication),
    });
  }

  // ── cleanup readiness ────────────────────────────────────────────────────────

  /**
   * Решение об уборке — отдельно от статуса публикации, хотя и выводится из него. Правило
   * единственное: временную среду можно удалять тогда и только тогда, когда кандидат и
   * артефакты пережили удаление. Иначе данные остаются единственной копией, и решение
   * говорит, что именно удерживается.
   */
  evaluateWorkspaceCleanup(input: { publicationId: string }): WorkspaceCleanupDecision {
    const record = this.journal.getPublication(input.publicationId);
    if (!record) throw new WorkspaceError('WORKSPACE_NOT_FOUND', `publication ${input.publicationId} is not in the journal`);
    if (record.status === 'published') return this.cleanupForPublished(record);
    // `record.cleanup.retained` — то, что было помечено единственной копией в момент
    // отказа (например, тяжёлые байты, которые не ушли в object storage). Оно важнее
    // вывода из `changes`: при отказе до расчёта манифеста changes ещё пуст.
    const retained = [...new Set([...record.cleanup.retained, ...record.changes.map((item) => item.path)])];
    if (record.candidateCommit) retained.push(`git:${record.branch}`);
    return {
      cleanupAllowed: false,
      reason: `publication ${record.publicationId} is "${record.status}"${record.reason ? `: ${record.reason}` : ''}; the unpublished state must survive the workspace removal`,
      retained,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private principal(tenantId: string, profileId: string, credentialTokenRef?: string): Principal {
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new WorkspaceError('WORKSPACE_INVALID', 'tenantId is required: the host determines the profile and its rights');
    }
    if (typeof profileId !== 'string' || profileId.length === 0) {
      throw new WorkspaceError('WORKSPACE_INVALID', 'profileId is required');
    }
    return { tenantId, profileId, credentialTokenRef };
  }

  private async requireBinding(tenantId: string, profileId: string): Promise<ProfileRepositoryBinding> {
    const binding = await this.bindings.findByProfile(tenantId, profileId);
    if (!binding) {
      throw new WorkspaceError('WORKSPACE_NOT_FOUND', `profile "${profileId}" has no workspace repository binding; run ensure_profile_repository first`, {
        detail: { tenantId, profileId },
      });
    }
    return binding;
  }

  private mirrorFor(binding: ProfileRepositoryBinding, credentialTokenRef?: string): Promise<GitMirror> {
    return this.git.ensureMirror(binding, { tokenRef: credentialTokenRef });
  }

  /**
   * Ядро публикации: скан уже сделан → артефакты → дерево-кандидат → durable ref → CAS.
   * Один и тот же путь используют `publish_run_changes`, `sync_profile_workspace`
   * (publish) и импорт batch'а — иначе у них разъедутся версии и правила.
   */
  private async publishFromFiles(input: PublishFromFilesInput): Promise<WorkspacePublication> {
    const { principal, binding } = input;
    const publicationId = this.newId('wspub');
    const record = this.newPublication({
      publicationId,
      operationId: input.operationId,
      origin: input.origin,
      binding,
      runId: input.runId,
      ownerGeneration: input.ownerGeneration,
      baseRevision: input.baseRevision,
      // Ветка рана — единица результата; для host-синхронизации (без рана) — своя ветка.
      branch: input.runId ? runBranchName(input.runId) : syncBranchName(publicationId),
    });
    // Запись ДО внешнего вызова: падение после этого места оставляет читаемый след.
    this.journal.putPublication(record);

    const mirror = await this.mirrorFor(binding, principal.credentialTokenRef);
    const artifactsByPath = new Map<string, WorkspaceArtifactRef>();
    const heavyPaths = input.files.filter((file) => file.action === 'heavy').map((file) => file.path);
    try {
      for (const file of input.files) {
        if (file.action !== 'heavy') continue;
        const bytes = this.readWorkspaceFile(input.workspacePath, file.path);
        const ref = await this.uploadArtifact(principal.profileId, publicationId, file.path, bytes);
        artifactsByPath.set(file.path, ref);
      }
    } catch (err) {
      // Хранилище недоступно: единственная копия тяжёлых байтов остаётся на диске рана.
      // Запись публикации всё равно появляется (cleanup запрещён, sole copy удерживается),
      // но вызов бросает: отказ инфраструктуры — не результат, тот же operationId должен
      // быть повторяем после восстановления хранилища.
      const failed = this.patchPublication(record, {
        status: 'failed',
        reason: `artifact upload failed: ${err instanceof WorkspaceError ? err.message : String(err)}`,
        cleanup: {
          cleanupAllowed: false,
          reason: 'heavy artifacts were not uploaded; the run workspace still holds the only copy',
          retained: heavyPaths,
        },
      });
      throw new WorkspaceError('WORKSPACE_STORAGE_UNAVAILABLE', failed.reason ?? 'artifact upload failed', {
        retryable: true,
        detail: { publicationId: failed.publicationId, retained: heavyPaths },
      });
    }

    const base = toTreeMap(await this.git.listTree(mirror, input.baseRevision));
    const baseArtifacts = await this.readArtifactIndex(mirror, input.baseRevision);
    const candidateTree = await this.buildCandidateTree({
      principal,
      mirror,
      base,
      baseRevision: input.baseRevision,
      workspacePath: input.workspacePath,
      files: input.files,
      artifacts: artifactsByPath,
    });
    const candidateEntries = toTreeMap(await this.git.listTree(mirror, candidateTree));
    const changes = await buildChangeSet(this.git, mirror, {
      base,
      candidate: candidateEntries,
      artifactByPath: artifactsByPath,
      baseArtifacts,
    });
    const prepared = this.patchPublication(record, {
      status: 'publishing',
      manifestHash: changeSetHash(changes),
      changes,
      artifacts: [...artifactsByPath.values()],
      cleanup: { cleanupAllowed: false, reason: 'the publication is in progress', retained: changes.map((item) => item.path) },
    });

    const outcome = await this.attemptPublication({
      record: prepared,
      binding,
      mirror,
      credentialTokenRef: principal.credentialTokenRef,
      runTreeSha: candidateTree,
      runRevision: null,
      message: input.message,
    });
    if (outcome.status === 'published') await this.updateBindingHead(binding, outcome.committedRevision);
    return outcome;
  }

  /** Дерево-кандидат: текст рана + реестр артефактов + маркер профиля, без тяжёлых байт. */
  private async buildCandidateTree(input: {
    principal: Principal;
    mirror: GitMirror;
    base: TreeMap;
    baseRevision: string;
    workspacePath: string;
    files: readonly ScannedFile[];
    artifacts: ReadonlyMap<string, WorkspaceArtifactRef>;
  }): Promise<string> {
    const writes: { path: string; oid: string | null; mode?: string }[] = [];
    const keep = new Set(input.files.filter((file) => file.action === 'publish').map((file) => file.path));
    for (const [path, entry] of input.base) {
      if (META_PATHS.has(path) || entry.mode === '120000') continue;
      if (keep.has(path)) continue;
      // Путь исчез из workspace рана — это удаление, а не «не заметили».
      writes.push({ path, oid: null });
      void entry;
    }
    for (const file of input.files) {
      if (file.action !== 'publish') continue;
      const bytes = this.readWorkspaceFile(input.workspacePath, file.path);
      if (sha256Hex(bytes) !== file.sha256) {
        throw new WorkspaceError('WORKSPACE_PATH_DENIED', `"${file.path}" changed while the publication was being prepared; publishing a moving file is refused`);
      }
      writes.push({ path: file.path, oid: await this.git.hashObject(input.mirror, bytes), mode: '100644' });
    }
    // Маркер детерминирован: он лежит в образе и участвует в трёхстороннем слиянии.
    // С временем в нём любая публикация конфликтовала бы с любой другой по этому пути.
    const marker = { version: 1, profileId: input.principal.profileId, tenantId: input.principal.tenantId };
    writes.push({
      path: PROFILE_MARKER_PATH,
      oid: await this.git.hashObject(input.mirror, Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, 'utf8')),
      mode: '100644',
    });
    if (input.artifacts.size > 0) {
      const index = {
        version: ARTIFACT_INDEX_VERSION,
        artifacts: [...input.artifacts.entries()]
          .map(([path, artifact]) => ({ path, key: artifact.key, sha256: artifact.sha256, size: artifact.size, mime: artifact.mime }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      };
      writes.push({
        path: ARTIFACT_INDEX_PATH,
        oid: await this.git.hashObject(input.mirror, Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8')),
        mode: '100644',
      });
    } else {
      writes.push({ path: ARTIFACT_INDEX_PATH, oid: null });
    }
    return this.git.writeTree(input.mirror, input.baseRevision === EMPTY_TREE ? null : input.baseRevision, writes);
  }

  /**
   * Публикация с ограниченным числом попыток. На каждой попытке заново читается
   * актуальная голова: непересекающиеся изменения объединяются автоматически, CAS
   * отказывает при гонке, а исчерпание попыток даёт конфликт, а не бесконечный retry.
   */
  private async attemptPublication(input: {
    record: WorkspacePublication;
    binding: ProfileRepositoryBinding;
    mirror: GitMirror;
    credentialTokenRef?: string;
    /** Дерево изменений рана: sha дерева, пришедшего из workspace или из durable-кандидата. */
    runTreeSha: string;
    /** Коммит рана, если он уже построен (восстановление после смерти VM). */
    runRevision: string | null;
    message: string;
  }): Promise<WorkspacePublication> {
    const { record, binding, mirror } = input;
    const runTree = toTreeMap(await this.git.listTree(mirror, input.runTreeSha));
    const base = toTreeMap(await this.git.listTree(mirror, record.baseRevision));
    // Область слияния = пути рана плюс те, что он удалил: удаление не выражается деревом.
    const scope = new Set([...runTree.keys(), ...base.keys()]);

    // 1. Коммит рана — изолированная работа, основанная на том, что ран видел. Он живёт в
    //    ветке рана и не зависит от того, куда ушла основная ветка за время рана.
    const runCommit =
      input.runRevision ??
      (await this.git.commitTree(mirror, {
        tree: input.runTreeSha,
        parents: record.baseRevision === EMPTY_TREE ? [] : [record.baseRevision],
        message: input.message,
        author: COMMIT_AUTHOR,
        metadata: { publicationId: record.publicationId, baseRevision: record.baseRevision, manifestHash: record.manifestHash, kind: 'run' },
      }));

    // 2. Ветка рана публикуется ДО основной: это durable-кандидат. После смерти VM
    //    публикация доводится с неё, а не повторным движком; пользователь видит её целиком.
    const candidatePush = await this.git.pushRef(mirror, {
      ref: branchRef(record.branch),
      commit: runCommit,
      credentials: { tokenRef: input.credentialTokenRef },
    });
    const withCandidate = this.patchPublication(record, {
      candidateCommit: runCommit,
      candidatePushed: candidatePush.outcome === 'pushed',
      status: 'publishing',
    });
    if (candidatePush.outcome === 'unknown') {
      return this.patchPublication(withCandidate, {
        status: 'pending',
        outcomeUnknown: true,
        reason: candidatePush.detail ?? 'the run branch push has an unknown outcome; reconcile before retrying',
        cleanup: { cleanupAllowed: false, reason: 'the run branch push outcome is unknown', retained: withCandidate.changes.map((item) => item.path) },
      });
    }
    if (candidatePush.outcome !== 'pushed') {
      return this.patchPublication(withCandidate, {
        status: 'failed',
        reason: `the profile repository rejected the run branch ${record.branch}: ${candidatePush.detail ?? 'no detail'}`,
        cleanup: { cleanupAllowed: false, reason: 'the run branch was not published', retained: withCandidate.changes.map((item) => item.path) },
      });
    }

    // 3. Основная ветка обновляется из ветки рана: fast-forward, если она не двигалась,
    //    иначе — явный merge-коммит. Так merge системный, а не «грязная» запись в main.
    for (let attempt = 1; attempt <= this.mergeAttempts; attempt += 1) {
      await this.git.fetch(mirror, { tokenRef: input.credentialTokenRef });
      const head = await this.git.head(mirror, binding.branch);
      let mainCommit: string;
      if (head === record.baseRevision || head === null) {
        // Ветка рана основана на текущей голове — main догоняет её без merge-коммита.
        mainCommit = runCommit;
      } else {
        const current = toTreeMap(await this.git.listTree(mirror, head));
        const merged = await mergeTrees(this.git, mirror, { base, run: runTree, current, scope });
        if (!merged.clean) {
          return this.recordConflict(withCandidate, binding, mirror, {
            base,
            runTreeSha: input.runTreeSha,
            currentRevision: head,
            entries: merged.conflicts,
            attempts: attempt,
            runRevision: runCommit,
          });
        }
        const tree = await this.git.writeTree(mirror, head, merged.writes);
        mainCommit = await this.git.commitTree(mirror, {
          tree,
          // Два родителя: голова профиля и ветка рана. Результат рана виден в истории, а не
          // растворяется в одном коммите.
          parents: [head, runCommit],
          message: `merge ${record.branch} into ${binding.branch}`,
          author: COMMIT_AUTHOR,
          metadata: { publicationId: record.publicationId, baseRevision: record.baseRevision, manifestHash: record.manifestHash, kind: 'merge' },
        });
      }

      const prepared = this.patchPublication(withCandidate, { expectedHeadRevision: head, mergeAttempts: attempt });
      const push = await this.git.pushBranch(mirror, {
        branch: binding.branch,
        commit: mainCommit,
        expectedHead: head,
        credentials: { tokenRef: input.credentialTokenRef },
      });

      if (push.outcome === 'pushed') {
        return this.patchPublication(prepared, {
          status: 'published',
          committedRevision: mainCommit,
          outcomeUnknown: false,
          reason: null,
          committedAt: this.now(),
          cleanup: this.cleanupForPublished(prepared),
        });
      }
      if (push.outcome === 'unknown') {
        return this.patchPublication(prepared, {
          status: 'pending',
          outcomeUnknown: true,
          reason: push.detail ?? 'the merge push has an unknown outcome; reconcile before retrying',
          cleanup: { cleanupAllowed: false, reason: 'the merge push outcome is unknown', retained: prepared.changes.map((item) => item.path) },
        });
      }
      if (push.outcome === 'rejected') {
        return this.patchPublication(prepared, {
          status: 'failed',
          reason: `the profile repository rejected the merge into ${binding.branch}: ${push.detail ?? 'no detail'}`,
          cleanup: { cleanupAllowed: false, reason: 'the merge was rejected', retained: prepared.changes.map((item) => item.path) },
        });
      }
      // head_changed: следующая попытка пересчитает merge против новой головы.
    }

    const exhausted = this.patchPublication(withCandidate, { mergeAttempts: this.mergeAttempts });
    const head = await this.git.head(mirror, binding.branch);
    return this.recordConflict(
      exhausted,
      binding,
      mirror,
      {
        base,
        runTreeSha: input.runTreeSha,
        currentRevision: head ?? EMPTY_TREE,
        entries: [{ path: `${binding.branch} (head)`, kind: 'content', runSha256: null, currentSha256: null }],
        attempts: this.mergeAttempts,
        runRevision: runCommit,
      },
      `the profile head kept changing during ${this.mergeAttempts} publication attempts`,
    );
  }

  /** Конфликт сохраняется целиком: три состояния, ref кандидата и артефакты рана. */
  private async recordConflict(
    record: WorkspacePublication,
    binding: ProfileRepositoryBinding,
    mirror: GitMirror,
    input: {
      base: TreeMap;
      runTreeSha: string;
      currentRevision: string;
      entries: WorkspaceConflictEntry[];
      attempts: number;
      runRevision: string | null;
    },
    reason?: string,
  ): Promise<WorkspacePublication> {
    // Коммит рана строится всегда: на нём держится `resolve_workspace_conflict` и он же
    // является durable-кандидатом при восстановлении.
    const runRevision =
      input.runRevision ??
      (await this.git.commitTree(mirror, {
        tree: input.runTreeSha,
        parents: record.baseRevision === EMPTY_TREE ? [] : [record.baseRevision],
        message: `run candidate for publication ${record.publicationId}`,
        author: COMMIT_AUTHOR,
        metadata: { publicationId: record.publicationId, baseRevision: record.baseRevision, manifestHash: record.manifestHash },
      }));
    const conflict: WorkspaceConflict = {
      schemaVersion: 1,
      conflictId: this.newId('wsconf'),
      publicationId: record.publicationId,
      bindingId: binding.bindingId,
      tenantId: record.tenantId,
      profileId: record.profileId,
      baseRevision: record.baseRevision,
      runRevision,
      currentRevision: input.currentRevision,
      entries: input.entries,
      artifacts: record.artifacts,
      candidateCommit: record.candidateCommit,
      resolutionAttempts: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    void input.base;
    this.journal.putConflict(conflict);
    return this.patchPublication(record, {
      status: 'conflict',
      conflictId: conflict.conflictId,
      mergeAttempts: input.attempts,
      reason: reason ?? `merge conflict on ${input.entries.length} path(s): ${input.entries.map((item) => item.path).join(', ')}`,
      cleanup: {
        cleanupAllowed: false,
        reason: 'the run changes are not published; the candidate ref and the run workspace must both survive',
        retained: [...record.changes.map((item) => item.path), ...(record.candidateCommit ? [`git:${record.branch}`] : [])],
      },
    });
  }

  /** Кандидат устарел: публикация не выполняется, конфликт пересчитывается против новой головы. */
  private async staleCandidate(
    publication: WorkspacePublication,
    binding: ProfileRepositoryBinding,
    conflict: WorkspaceConflict,
    candidateTree: string,
    reason: string,
  ): Promise<WorkspacePublication> {
    const mirror = await this.mirrorFor(binding);
    const head = await this.git.head(mirror, binding.branch);
    const base = toTreeMap(await this.git.listTree(mirror, conflict.baseRevision));
    const current = head === null ? new Map<string, { mode: string; oid: string }>() : toTreeMap(await this.git.listTree(mirror, head));
    const candidate = toTreeMap(await this.git.listTree(mirror, candidateTree));
    const merged = await mergeTrees(this.git, mirror, {
      base,
      run: candidate,
      current,
      scope: new Set([...base.keys(), ...candidate.keys(), ...current.keys()]),
    });
    const nextConflict: WorkspaceConflict = {
      ...conflict,
      conflictId: this.newId('wsconf'),
      currentRevision: head ?? EMPTY_TREE,
      entries: merged.conflicts,
      resolutionAttempts: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.journal.putConflict(nextConflict);
    return this.patchPublication(publication, {
      status: 'conflict',
      conflictId: nextConflict.conflictId,
      candidateId: null,
      reason: `a stale resolution candidate was not published: ${reason}`,
      cleanup: {
        cleanupAllowed: false,
        reason: 'the resolution candidate is stale and nothing of it is canonical',
        retained: publication.changes.map((item) => item.path),
      },
    });
  }

  /** Кандидат от агентского resolver'а проверяется тем же политикой, что и публикация. */
  private async assertCandidateTreeAllowed(mirror: GitMirror, tree: string, profileId: string): Promise<void> {
    const entries = toTreeMap(await this.git.listTree(mirror, tree));
    if (entries.size === 0) {
      throw new WorkspaceError('WORKSPACE_INVALID', 'a resolution candidate must not be empty: it would erase the profile image');
    }
    for (const [path, entry] of entries) {
      if (META_PATHS.has(path)) continue;
      if (matchRule(this.policy, path).action === 'exclude') {
        throw new WorkspaceError('WORKSPACE_PATH_DENIED', `resolution candidate of profile "${profileId}" contains a path excluded by policy: "${path}"`, {
          detail: { path },
        });
      }
      if (entry.mode === '120000') {
        throw new WorkspaceError('WORKSPACE_PATH_DENIED', `resolution candidate contains a symlink at "${path}"`);
      }
    }
  }

  private markAwaitingUserInput(conflict: WorkspaceConflict, reason: string): void {
    const publication = this.journal.listPublications({ profileId: conflict.profileId }).find((item) => item.conflictId === conflict.conflictId);
    if (!publication) return;
    this.journal.putPublication({ ...publication, status: 'awaiting_user_input', reason, updatedAt: this.now() });
  }

  private newCandidate(input: {
    conflict: WorkspaceConflict;
    binding: ProfileRepositoryBinding;
    head: string | null;
    tree: string;
    entries: WorkspaceConflictEntry[];
    source: WorkspaceResolutionCandidate['source'];
    resolverRunId: string | null;
    evidence: string;
  }): WorkspaceResolutionCandidate {
    const candidate: WorkspaceResolutionCandidate = {
      schemaVersion: 1,
      candidateId: this.newId('wscand'),
      conflictId: input.conflict.conflictId,
      bindingId: input.binding.bindingId,
      tenantId: input.conflict.tenantId,
      profileId: input.conflict.profileId,
      baseRevision: input.conflict.baseRevision,
      expectedHeadRevision: input.head,
      tree: input.tree,
      entries: input.entries,
      source: input.source,
      resolverRunId: input.resolverRunId,
      evidence: input.evidence,
      createdAt: this.now(),
    };
    this.journal.putCandidate(candidate);
    const publication = this.journal.listPublications({ profileId: input.conflict.profileId }).find((item) => item.conflictId === input.conflict.conflictId);
    if (publication) this.journal.putPublication({ ...publication, candidateId: candidate.candidateId, updatedAt: this.now() });
    return candidate;
  }

  private finishResolution(
    candidate: WorkspaceResolutionCandidate,
    conflict: WorkspaceConflict,
    attempts: number,
  ): ResolveWorkspaceConflictResult {
    return {
      status: 'candidate_ready',
      conflictId: conflict.conflictId,
      candidateId: candidate.candidateId,
      attempts,
      entries: candidate.entries,
      reason: `candidate prepared for head ${candidate.expectedHeadRevision ?? 'null'}; publishing requires expectedHeadRevision to match exactly`,
    };
  }

  /**
   * Загрузка тяжёлого объекта с проверкой: манифест не ссылается на неподтверждённые
   * байты. Ключ content-addressed, поэтому повтор после timeout/crash не создаёт дубль.
   */
  private async uploadArtifact(profileId: string, publicationId: string, path: string, bytes: Buffer): Promise<WorkspaceArtifactRef> {
    const sha256 = sha256Hex(bytes);
    const key = `profiles/${profileId}/workspace/${publicationId}/${sha256}`;
    const ref = await this.objects.put(key, bytes);
    if (ref.sha256 !== sha256) {
      throw new WorkspaceError('WORKSPACE_STORAGE_UNAVAILABLE', `object storage returned digest ${ref.sha256.slice(0, 12)}… for "${path}", uploaded ${sha256.slice(0, 12)}…`);
    }
    const head = await this.objects.head(key);
    if (head.size !== bytes.length) {
      throw new WorkspaceError('WORKSPACE_STORAGE_UNAVAILABLE', `object storage reports ${head.size} bytes for "${path}", uploaded ${bytes.length}`);
    }
    return { key, sha256, size: bytes.length, mime: mimeForName(path), verifiedAt: this.now() };
  }

  private async readArtifactBytes(artifact: WorkspaceArtifactRef): Promise<Buffer> {
    const bytes = await this.objects.get(artifact.key);
    if (sha256Hex(bytes) !== artifact.sha256) {
      throw new WorkspaceError('WORKSPACE_STORAGE_UNAVAILABLE', `artifact ${artifact.key} does not match its declared checksum`);
    }
    return bytes;
  }

  private async verifyArtifact(artifact: WorkspaceArtifactRef): Promise<boolean> {
    try {
      const head = await this.objects.head(artifact.key);
      if (head.size !== artifact.size) return false;
      const bytes = await this.objects.get(artifact.key);
      return sha256Hex(bytes) === artifact.sha256;
    } catch {
      return false;
    }
  }

  /** Реестр артефактов из дерева: path → ref. Читается на prepare/pull/verify. */
  private async readArtifactIndex(mirror: GitMirror, revision: string): Promise<Map<string, WorkspaceArtifactRef>> {
    const entries = toTreeMap(await this.git.listTree(mirror, revision));
    const entry = entries.get(ARTIFACT_INDEX_PATH);
    if (!entry) return new Map();
    let parsed: { artifacts?: unknown };
    try {
      parsed = JSON.parse((await this.git.readBlob(mirror, entry.oid)).toString('utf8')) as { artifacts?: unknown };
    } catch {
      throw new WorkspaceError('WORKSPACE_INVALID', `${ARTIFACT_INDEX_PATH} is not readable JSON`);
    }
    const result = new Map<string, WorkspaceArtifactRef>();
    for (const raw of Array.isArray(parsed.artifacts) ? parsed.artifacts : []) {
      const record = raw as { path?: unknown; key?: unknown; sha256?: unknown; size?: unknown; mime?: unknown };
      if (typeof record.path !== 'string' || typeof record.key !== 'string' || typeof record.sha256 !== 'string') continue;
      result.set(record.path, {
        key: record.key,
        sha256: record.sha256,
        size: typeof record.size === 'number' ? record.size : 0,
        mime: typeof record.mime === 'string' ? record.mime : 'application/octet-stream',
        verifiedAt: this.now(),
      });
    }
    return result;
  }

  private readWorkspaceFile(workspacePath: string, relativePath: string): Buffer {
    return readFileSync(resolveInsideRoot(workspacePath, relativePath, `publication path "${relativePath}"`));
  }

  private cleanupForPublished(record: WorkspacePublication): WorkspaceCleanupDecision {
    return {
      cleanupAllowed: true,
      reason: `publication ${record.publicationId} is published at ${(record.committedRevision ?? '').slice(0, 12)}…; the profile repository and object storage hold a durable copy`,
      retained: [],
    };
  }

  private newPublication(input: {
    publicationId: string;
    operationId: string;
    origin: WorkspacePublication['origin'];
    binding: ProfileRepositoryBinding;
    runId: string | null;
    ownerGeneration: number | null;
    baseRevision: string;
    branch: string;
  }): WorkspacePublication {
    const at = this.now();
    return {
      schemaVersion: 1,
      publicationId: input.publicationId,
      operationId: input.operationId,
      origin: input.origin,
      bindingId: input.binding.bindingId,
      tenantId: input.binding.tenantId,
      profileId: input.binding.profileId,
      runId: input.runId,
      ownerGeneration: input.ownerGeneration,
      baseRevision: input.baseRevision,
      expectedHeadRevision: null,
      committedRevision: null,
      status: 'pending',
      reason: null,
      manifestHash: changeSetHash([]),
      changes: [],
      artifacts: [],
      conflictId: null,
      candidateId: null,
      branch: input.branch,
      candidateCommit: null,
      candidatePushed: false,
      outcomeUnknown: false,
      mergeAttempts: 0,
      cleanup: { cleanupAllowed: false, reason: 'the publication has not completed', retained: [] },
      exportPolicyId: this.policy.policy.policyId,
      createdAt: at,
      updatedAt: at,
      committedAt: null,
    };
  }

  private patchPublication(record: WorkspacePublication, patch: Partial<WorkspacePublication>): WorkspacePublication {
    return this.journal.putPublication({ ...record, ...patch, updatedAt: this.now() });
  }

  private async updateBindingHead(binding: ProfileRepositoryBinding, head: string | null): Promise<void> {
    if (!head) return;
    const updated: ProfileRepositoryBinding = { ...binding, headRevision: head, updatedAt: this.now() };
    await this.bindings.save(updated);
    this.journal.putBinding(updated);
  }
}

function publicationToSyncResult(publication: WorkspacePublication): SyncWorkspaceResult {
  const status: SyncWorkspaceResult['status'] =
    publication.status === 'published'
      ? 'published'
      : publication.status === 'conflict'
        ? 'conflict'
        : publication.status === 'awaiting_user_input'
          ? 'awaiting_user_input'
          : 'failed';
  return {
    status,
    bindingId: publication.bindingId,
    profileId: publication.profileId,
    localChanges: [],
    revision: publication.committedRevision ?? publication.expectedHeadRevision,
    publicationId: publication.publicationId,
    conflictId: publication.conflictId,
    reason: publication.reason,
  };
}

/**
 * Записи дерева «база → кандидат». Служебные файлы (маркер профиля и реестр артефактов)
 * здесь НЕ фильтруются: они и есть часть образа профиля, и без них репозиторий теряет
 * принадлежность профилю и ref'ы тяжёлых объектов.
 */
function diffWrites(base: TreeMap, candidate: TreeMap): { path: string; oid: string | null; mode?: string }[] {
  const writes: { path: string; oid: string | null; mode?: string }[] = [];
  for (const [path, entry] of candidate) {
    const before = base.get(path);
    if (before && before.oid === entry.oid && before.mode === entry.mode) continue;
    writes.push({ path, oid: entry.oid, mode: entry.mode });
  }
  for (const path of base.keys()) {
    if (candidate.has(path)) continue;
    writes.push({ path, oid: null });
  }
  return writes;
}

function bindingIdFor(tenantId: string, profileId: string): string {
  return `wsbind-${sha256Hex(`${tenantId}\u0000${profileId}`).slice(0, 24)}`;
}
