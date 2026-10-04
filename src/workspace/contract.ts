/**
 * Контракт постоянного пользовательского workspace (архитектурный поток PR #131
 * trained-assist/trained-agent-architecture, раздел «Постоянный пользовательский workspace —
 * контракт методов», 04.10.2026).
 *
 * Модуль самодостаточен: он не импортирует внутренности legacy и не меняет lifecycle Runner.
 * Всё внешнее (Git, object storage, binding-хранилище, репозиторная админка) приходит портами,
 * поэтому приёмка детерминирована и не требует сети.
 *
 * Разделение, которое документ проводит и здесь:
 * - `engine status` — исполнился ли ран; этого модуля он не касается;
 * - `publication status` — стало ли состояние пользователя каноническим (здесь);
 * - `cleanup status` — можно ли удалить временную среду (решение здесь, действие у хоста).
 */

import { ErrorCollector, checkArray, checkKeys, checkObject, checkSafeId, checkString, isUtcTimestamp, type ValidationResult } from '../contracts/validate.js';
import { isSafeRelativePath } from '../storage/local-paths.js';
import { sha256Hex } from '../storage/blob-store.js';

export const WORKSPACE_CONTRACT_VERSION = 1 as const;

/**
 * Пустое дерево git — версия «в репозитории ещё ничего нет». Оно же база первого
 * коммита публикации: отсутствие head не значит отсутствие базы (в отличие от
 * `null`, которым помечается «состояние неизвестно»).
 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const COMMIT_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** Маркер репозитория: доказывает принадлежность репозитория профилю. */
export const PROFILE_MARKER_PATH = '.trained-assist/profile.json';
/** Реестр тяжёлых артефактов: в git лежит только ref/checksum, байты — в object storage. */
export const ARTIFACT_INDEX_PATH = '.trained-assist/artifacts.json';

export function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_SHA.test(value);
}

/** Принимает и пустое дерево, и настоящий commit: это две валидные «версии состояния». */
export function isRevision(value: unknown): value is string {
  return value === EMPTY_TREE || isCommitSha(value);
}

// ── Binding профиля ────────────────────────────────────────────────────────────

export interface ProfileRepositoryBinding {
  schemaVersion: typeof WORKSPACE_CONTRACT_VERSION;
  bindingId: string;
  tenantId: string;
  profileId: string;
  /** Владелец репозитория (организация). Задаётся хостом, не выводится из профиля. */
  owner: string;
  /** `owner/name` — единственное имя, по которому резолвится репозиторий. */
  repository: string;
  url: string;
  private: boolean;
  branch: string;
  headRevision: string | null;
  /** null — репозиторий создан, данных профиля ещё не завозили (создание ≠ импорт). */
  importedAt: string | null;
  importManifestHash: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Снимок для materialize ─────────────────────────────────────────────────────

export interface WorkspaceArtifactRef {
  /** Ключ в долговечном object storage. Байты лежат там, а не в git. */
  key: string;
  sha256: string;
  size: number;
  mime: string;
  verifiedAt: string;
}

export interface WorkspaceManifestEntry {
  /** Относительный путь в профиле — так его видит агент. */
  path: string;
  sha256: string;
  size: number;
  mime: string;
  /** null — байты лежат в git; иначе тяжёлый объект вне git с проверенным ref. */
  artifact: WorkspaceArtifactRef | null;
}

export interface ProfileWorkspaceSnapshot {
  schemaVersion: typeof WORKSPACE_CONTRACT_VERSION;
  workspaceSnapshotId: string;
  bindingId: string;
  profileId: string;
  /** Версия состояния, от которого считаются изменения рана. */
  baseRevision: string;
  headRevision: string | null;
  manifest: WorkspaceManifestEntry[];
  files: number;
  bytes: number;
  artifacts: number;
  /**
   * Что не попало в манифест и почему (недоступный артефакт, symlink). Манифест не ссылается
   * на неподтверждённые байты, но вызывающий должен видеть, что именно выпало.
   */
  warnings: string[];
  exportPolicyId: string;
  createdAt: string;
}

/**
 * Запрос разрешения конфликта. `external_candidate` — единственный путь для агентского
 * resolver'а: модуль принимает готовое дерево с evidence и не строит agent runtime.
 */
export interface WorkspaceCandidateInput {
  kind: 'deterministic' | 'run_side' | 'current_side' | 'external_candidate' | 'awaiting_user_input';
  /** Обязателен для `external_candidate`: tree sha кандидата в зеркале модуля. */
  tree?: string;
  resolverRunId?: string;
  evidence?: string;
  reason?: string;
}

// ── Изменения публикации ───────────────────────────────────────────────────────

export type WorkspaceChangeKind = 'add' | 'update' | 'delete';

export interface WorkspaceChangeEntry {
  path: string;
  kind: WorkspaceChangeKind;
  /** null для удаления; для add/update — sha256 байтов, которые попадут в git. */
  sha256: string | null;
  size: number;
  /** Тяжёлый объект вынесен из git; null для текста. */
  artifact: WorkspaceArtifactRef | null;
}

export function changeSetHash(changes: readonly WorkspaceChangeEntry[]): string {
  const canonical = changes
    .map((entry) => [entry.path, entry.kind, entry.sha256 ?? '', String(entry.size), entry.artifact?.sha256 ?? ''])
    .sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
  return sha256Hex(JSON.stringify(canonical));
}

// ── Статусы публикации ────────────────────────────────────────────────────────

export type PublicationStatus = 'pending' | 'publishing' | 'published' | 'conflict' | 'awaiting_user_input' | 'failed';

export type PublicationOrigin = 'run' | 'sync_publish' | 'resolution';

export type ConflictKind = 'content' | 'delete_modify' | 'add_add' | 'rename' | 'binary';

export interface WorkspaceConflictEntry {
  path: string;
  kind: ConflictKind;
  /** sha256 варианта рана (null — рана тронул не этот путь). */
  runSha256: string | null;
  /** sha256 варианта актуального head (null — head тронул не этот путь). */
  currentSha256: string | null;
}

export interface WorkspaceCleanupDecision {
  /** true только когда всё нужное пережило удаление временной среды. */
  cleanupAllowed: boolean;
  reason: string;
  /** Что намеренно остаётся единственной копией (пути/ключи), если false. */
  retained: string[];
}

export interface WorkspacePublication {
  schemaVersion: typeof WORKSPACE_CONTRACT_VERSION;
  publicationId: string;
  operationId: string;
  origin: PublicationOrigin;
  bindingId: string;
  tenantId: string;
  profileId: string;
  runId: string | null;
  ownerGeneration: number | null;
  /** Версия, от которой считали изменения. */
  baseRevision: string;
  /** Версия head, под которой считали merge и в которую публиковали. */
  expectedHeadRevision: string | null;
  committedRevision: string | null;
  status: PublicationStatus;
  reason: string | null;
  /** Хэш канонического манифеста изменений: дедупликация и проверка повторного вызова. */
  manifestHash: string;
  changes: WorkspaceChangeEntry[];
  artifacts: WorkspaceArtifactRef[];
  conflictId: string | null;
  candidateId: string | null;
  /** Коммит кандидата в remote ref `refs/workspace/publications/<publicationId>`. */
  candidateCommit: string | null;
  candidatePushed: boolean;
  /** Исход push неизвестен: сверять с git/binding-журналом, не повторять движок. */
  outcomeUnknown: boolean;
  /** Сколько попыток пересчёта merge при конкурентной публикации. */
  mergeAttempts: number;
  cleanup: WorkspaceCleanupDecision;
  exportPolicyId: string;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
}

// ── Конфликт и кандидат разрешения ─────────────────────────────────────────────

export interface WorkspaceConflict {
  schemaVersion: typeof WORKSPACE_CONTRACT_VERSION;
  conflictId: string;
  publicationId: string;
  bindingId: string;
  tenantId: string;
  profileId: string;
  baseRevision: string;
  runRevision: string;
  currentRevision: string;
  entries: WorkspaceConflictEntry[];
  artifacts: WorkspaceArtifactRef[];
  /** Коммит изменений рана — сохранённый кандидат, с которого resolution строит merge. */
  candidateCommit: string | null;
  /** Сколько раз уже разрешали этот конфликт: предохранитель от бесконечного цикла. */
  resolutionAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export type ResolutionSource = 'deterministic' | 'run_side' | 'current_side' | 'external_candidate' | 'user_input';

export interface WorkspaceResolutionCandidate {
  schemaVersion: typeof WORKSPACE_CONTRACT_VERSION;
  candidateId: string;
  conflictId: string;
  bindingId: string;
  tenantId: string;
  profileId: string;
  baseRevision: string;
  /** Head, под которым кандидат собран; публикация требует ровно его. */
  expectedHeadRevision: string | null;
  /** Дерево кандидата (tree sha) в локальном зеркале модуля. */
  tree: string;
  entries: WorkspaceConflictEntry[];
  source: ResolutionSource;
  resolverRunId: string | null;
  evidence: string | null;
  createdAt: string;
}

// ── Результаты методов ─────────────────────────────────────────────────────────

export type Readiness = 'ready' | 'awaiting_import' | 'not_ready';

export interface EnsureProfileRepositoryResult {
  bindingId: string;
  tenantId: string;
  profileId: string;
  repository: string;
  url: string;
  branch: string;
  private: boolean;
  /** Репозиторий создан этим вызовом; false — идемпотентный повтор. */
  created: boolean;
  headRevision: string | null;
  imported: boolean;
  readiness: Readiness;
}

export interface ProvisionProfileResult {
  profileId: string;
  status: 'ensured' | 'imported' | 'verified' | 'failed' | 'skipped';
  repository: string | null;
  /** Планируемые действия без их выполнения (dry-run). */
  plan: string[];
  files: number;
  bytes: number;
  /** Что исключено политикой: credentials, runtime, symlinks. */
  excluded: string[];
  headRevision: string | null;
  error: string | null;
}

export interface ProvisionBatchResult {
  operationId: string;
  dryRun: boolean;
  status: 'completed' | 'partial' | 'failed';
  /** Возобновление: последний обработанный профиль. */
  cursor: string | null;
  processed: number;
  results: ProvisionProfileResult[];
}

export interface SyncWorkspaceResult {
  status: 'pulled' | 'published' | 'local_changes' | 'conflict' | 'awaiting_user_input' | 'failed';
  bindingId: string;
  profileId: string;
  /** Незаписанные локальные изменения: pull их не трогает и не затирает. */
  localChanges: WorkspaceChangeEntry[];
  /** Целевая/текущая версия состояния. */
  revision: string | null;
  publicationId: string | null;
  conflictId: string | null;
  reason: string | null;
}

export interface ResolveWorkspaceConflictResult {
  status: 'candidate_ready' | 'awaiting_user_input' | 'unresolved';
  conflictId: string;
  candidateId: string | null;
  /** Сколько раз уже пробовали разрешить этот конфликт: цикл запрещён. */
  attempts: number;
  entries: WorkspaceConflictEntry[];
  reason: string;
}

export type WorkspaceErrorCode =
  | 'WORKSPACE_INVALID'
  | 'WORKSPACE_OPERATION_CONFLICT'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_FORBIDDEN'
  | 'WORKSPACE_REPOSITORY_NAME_TAKEN'
  | 'WORKSPACE_FOREIGN_REPOSITORY'
  | 'WORKSPACE_REPOSITORY_NOT_PRIVATE'
  | 'WORKSPACE_HEAD_CHANGED'
  | 'WORKSPACE_CLEANUP_NOT_ALLOWED'
  | 'WORKSPACE_STORAGE_UNAVAILABLE'
  | 'WORKSPACE_PUBLISH_OUTCOME_UNKNOWN'
  | 'WORKSPACE_GIT_FAILED'
  | 'WORKSPACE_PATH_DENIED'
  | 'WORKSPACE_TOO_LARGE';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly retryable: boolean;
  readonly detail?: Record<string, unknown>;

  constructor(code: WorkspaceErrorCode, message: string, options?: { retryable?: boolean; detail?: Record<string, unknown> }) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    if (options?.detail !== undefined) this.detail = options.detail;
  }
}

export function isWorkspaceError(err: unknown): err is WorkspaceError {
  return err instanceof WorkspaceError;
}

// ── Валидация входа методов ────────────────────────────────────────────────────

const BINDING_KEYS = [
  'schemaVersion',
  'bindingId',
  'tenantId',
  'profileId',
  'owner',
  'repository',
  'url',
  'private',
  'branch',
  'headRevision',
  'importedAt',
  'importManifestHash',
  'createdAt',
  'updatedAt',
] as const;

export function validateBinding(input: unknown): ValidationResult<ProfileRepositoryBinding> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'binding', collector)) return collector.finish(undefined as never);
  checkKeys(input, BINDING_KEYS, BINDING_KEYS, 'binding', collector);
  if (input['schemaVersion'] !== WORKSPACE_CONTRACT_VERSION) collector.push('binding.schemaVersion: expected 1');
  for (const key of ['bindingId', 'tenantId', 'profileId'] as const) checkSafeId(input[key], `binding.${key}`, collector);
  checkString(input['owner'], 'binding.owner', collector, 200);
  checkString(input['repository'], 'binding.repository', collector, 300);
  checkString(input['url'], 'binding.url', collector, 500);
  if (typeof input['private'] !== 'boolean') collector.push('binding.private: expected boolean');
  if (typeof input['branch'] !== 'string' || input['branch'].length === 0) collector.push('binding.branch: expected non-empty string');
  if (input['headRevision'] !== null && !isRevision(input['headRevision'])) collector.push('binding.headRevision: expected a revision or null');
  for (const key of ['importedAt', 'importManifestHash'] as const) {
    const value = input[key];
    if (value !== null && typeof value !== 'string') collector.push(`binding.${key}: expected a string or null`);
  }
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (!isUtcTimestamp(input[key])) collector.push(`binding.${key}: expected UTC ISO timestamp`);
  }
  return collector.finish(input as unknown as ProfileRepositoryBinding);
}

const ARTIFACT_REF_KEYS = ['key', 'sha256', 'size', 'mime', 'verifiedAt'] as const;

export function validateArtifactRef(value: unknown, path: string, collector: ErrorCollector): void {
  if (!checkObject(value, path, collector)) return;
  checkKeys(value, ARTIFACT_REF_KEYS, ARTIFACT_REF_KEYS, path, collector);
  checkString(value['key'], `${path}.key`, collector, 500);
  checkString(value['sha256'], `${path}.sha256`, collector, 64);
  if (!/^[0-9a-f]{64}$/.test(String(value['sha256']))) collector.push(`${path}.sha256: expected 64 lowercase hex chars`);
  if (typeof value['size'] !== 'number' || !Number.isInteger(value['size']) || value['size'] < 0) {
    collector.push(`${path}.size: expected non-negative integer`);
  }
  checkString(value['mime'], `${path}.mime`, collector, 100);
  if (!isUtcTimestamp(value['verifiedAt'])) collector.push(`${path}.verifiedAt: expected UTC ISO timestamp`);
}

const MANIFEST_ENTRY_KEYS = ['path', 'sha256', 'size', 'mime', 'artifact'] as const;

export function validateManifestEntry(value: unknown, path: string, collector: ErrorCollector): void {
  if (!checkObject(value, path, collector)) return;
  checkKeys(value, MANIFEST_ENTRY_KEYS, MANIFEST_ENTRY_KEYS, path, collector);
  if (!isSafeRelativePath(value['path'])) collector.push(`${path}.path: expected a relative path without "..", "." or a leading "/"`);
  if (!/^[0-9a-f]{64}$/.test(String(value['sha256']))) collector.push(`${path}.sha256: expected 64 lowercase hex chars`);
  if (typeof value['size'] !== 'number' || !Number.isInteger(value['size']) || value['size'] < 0) {
    collector.push(`${path}.size: expected non-negative integer`);
  }
  checkString(value['mime'], `${path}.mime`, collector, 100);
  if (value['artifact'] !== null) validateArtifactRef(value['artifact'], `${path}.artifact`, collector);
}

const CHANGE_ENTRY_KEYS = ['path', 'kind', 'sha256', 'size', 'artifact'] as const;

export function validateChangeEntry(value: unknown, path: string, collector: ErrorCollector): void {
  if (!checkObject(value, path, collector)) return;
  checkKeys(value, CHANGE_ENTRY_KEYS, CHANGE_ENTRY_KEYS, path, collector);
  if (!isSafeRelativePath(value['path'])) collector.push(`${path}.path: expected a relative path without "..", "." or a leading "/"`);
  if (value['kind'] !== 'add' && value['kind'] !== 'update' && value['kind'] !== 'delete') {
    collector.push(`${path}.kind: expected add | update | delete`);
  }
  if (typeof value['size'] !== 'number' || !Number.isInteger(value['size']) || value['size'] < 0) {
    collector.push(`${path}.size: expected non-negative integer`);
  }
  const deleting = value['kind'] === 'delete';
  if (deleting) {
    if (value['sha256'] !== null) collector.push(`${path}.sha256: a deleted path carries no content hash`);
    if (value['size'] !== 0) collector.push(`${path}.size: a deleted path has no size`);
    if (value['artifact'] !== null) collector.push(`${path}.artifact: a deleted path carries no artifact ref`);
  } else {
    if (!/^[0-9a-f]{64}$/.test(String(value['sha256']))) collector.push(`${path}.sha256: expected 64 lowercase hex chars`);
    if (value['artifact'] !== null) validateArtifactRef(value['artifact'], `${path}.artifact`, collector);
  }
}

const CLEANUP_KEYS = ['cleanupAllowed', 'reason', 'retained'] as const;

export function validateCleanupDecision(value: unknown, path: string, collector: ErrorCollector): void {
  if (!checkObject(value, path, collector)) return;
  checkKeys(value, CLEANUP_KEYS, CLEANUP_KEYS, path, collector);
  if (typeof value['cleanupAllowed'] !== 'boolean') collector.push(`${path}.cleanupAllowed: expected boolean`);
  checkString(value['reason'], `${path}.reason`, collector, 300);
  if (checkArray(value['retained'], `${path}.retained`, collector)) {
    value['retained'].forEach((entry, i) => checkString(entry, `${path}.retained[${i}]`, collector, 600));
  }
}

const PUBLICATION_KEYS = [
  'schemaVersion',
  'publicationId',
  'operationId',
  'origin',
  'bindingId',
  'tenantId',
  'profileId',
  'runId',
  'ownerGeneration',
  'baseRevision',
  'expectedHeadRevision',
  'committedRevision',
  'status',
  'reason',
  'manifestHash',
  'changes',
  'artifacts',
  'conflictId',
  'candidateId',
  'candidateCommit',
  'candidatePushed',
  'outcomeUnknown',
  'mergeAttempts',
  'cleanup',
  'exportPolicyId',
  'createdAt',
  'updatedAt',
  'committedAt',
] as const;

const CONFLICT_ENTRY_KEYS = ['path', 'kind', 'runSha256', 'currentSha256'] as const;
const CONFLICT_KINDS: readonly ConflictKind[] = ['content', 'delete_modify', 'add_add', 'rename', 'binary'];
const PUBLICATION_STATUSES: readonly PublicationStatus[] = ['pending', 'publishing', 'published', 'conflict', 'awaiting_user_input', 'failed'];
const ORIGINS: readonly PublicationOrigin[] = ['run', 'sync_publish', 'resolution'];

/**
 * Валидация durable записи публикации. Запись переживает рестарт и читается другим
 * владельцем, поэтому проверяется целиком: битая запись должна остановить публикацию,
 * а не превратиться в «успешный» результат.
 */
export function validatePublication(input: unknown): ValidationResult<WorkspacePublication> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'publication', collector)) return collector.finish(undefined as never);
  checkKeys(input, PUBLICATION_KEYS, PUBLICATION_KEYS, 'publication', collector);
  if (input['schemaVersion'] !== WORKSPACE_CONTRACT_VERSION) collector.push('publication.schemaVersion: expected 1');
  for (const key of ['publicationId', 'operationId', 'bindingId', 'tenantId', 'profileId', 'manifestHash', 'exportPolicyId'] as const) {
    checkString(input[key], `publication.${key}`, collector, 300);
  }
  if (input['runId'] !== null) checkSafeId(input['runId'], 'publication.runId', collector);
  if (input['ownerGeneration'] !== null && (typeof input['ownerGeneration'] !== 'number' || !Number.isInteger(input['ownerGeneration']) || (input['ownerGeneration'] as number) < 0)) {
    collector.push('publication.ownerGeneration: expected a non-negative integer or null');
  }
  if (!isRevision(input['baseRevision'])) collector.push('publication.baseRevision: expected a revision');
  for (const key of ['expectedHeadRevision', 'committedRevision'] as const) {
    const value = input[key];
    if (value !== null && !isCommitSha(value)) collector.push(`publication.${key}: expected a commit sha or null`);
  }
  if (!PUBLICATION_STATUSES.includes(input['status'] as PublicationStatus)) {
    collector.push(`publication.status: expected one of ${PUBLICATION_STATUSES.join(', ')}`);
  }
  if (!ORIGINS.includes(input['origin'] as PublicationOrigin)) {
    collector.push(`publication.origin: expected one of ${ORIGINS.join(', ')}`);
  }
  if (input['reason'] !== null && typeof input['reason'] !== 'string') collector.push('publication.reason: expected a string or null');
  if (!/^[0-9a-f]{64}$/.test(String(input['manifestHash']))) collector.push('publication.manifestHash: expected 64 lowercase hex chars');
  if (checkArray(input['changes'], 'publication.changes', collector)) {
    if (input['changes'].length > 2000) collector.push('publication.changes: too many entries');
    const seen = new Set<string>();
    input['changes'].forEach((entry, i) => {
      validateChangeEntry(entry, `publication.changes[${i}]`, collector);
      const path = (entry as { path?: unknown } | null)?.path;
      if (typeof path === 'string') {
        if (seen.has(path)) collector.push(`publication.changes[${i}].path: duplicate path "${path}"`);
        seen.add(path);
      }
    });
  }
  if (checkArray(input['artifacts'], 'publication.artifacts', collector)) {
    input['artifacts'].forEach((entry, i) => validateArtifactRef(entry, `publication.artifacts[${i}]`, collector));
  }
  if (input['conflictId'] !== null) checkString(input['conflictId'], 'publication.conflictId', collector, 300);
  if (input['candidateId'] !== null) checkString(input['candidateId'], 'publication.candidateId', collector, 300);
  if (input['candidateCommit'] !== null && !isCommitSha(input['candidateCommit'])) {
    collector.push('publication.candidateCommit: expected a commit sha or null');
  }
  for (const key of ['candidatePushed', 'outcomeUnknown'] as const) {
    if (typeof input[key] !== 'boolean') collector.push(`publication.${key}: expected boolean`);
  }
  if (typeof input['mergeAttempts'] !== 'number' || !Number.isInteger(input['mergeAttempts']) || (input['mergeAttempts'] as number) < 0) {
    collector.push('publication.mergeAttempts: expected a non-negative integer');
  }
  validateCleanupDecision(input['cleanup'], 'publication.cleanup', collector);
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (!isUtcTimestamp(input[key])) collector.push(`publication.${key}: expected UTC ISO timestamp`);
  }
  if (input['committedAt'] !== null && !isUtcTimestamp(input['committedAt'])) {
    collector.push('publication.committedAt: expected a UTC ISO timestamp or null');
  }
  if (input['status'] === 'published' && !isCommitSha(input['committedRevision'])) {
    collector.push('publication.committedRevision: a published record must carry the committed revision');
  }
  const cleanup = input['cleanup'] as { cleanupAllowed?: unknown } | undefined;
  if (input['status'] === 'published' && cleanup?.cleanupAllowed === false) {
    collector.push('publication.cleanup: a published publication must allow cleanup of the run workspace');
  }
  return collector.finish(input as unknown as WorkspacePublication);
}

const CONFLICT_KEYS = [
  'schemaVersion',
  'conflictId',
  'publicationId',
  'bindingId',
  'tenantId',
  'profileId',
  'baseRevision',
  'runRevision',
  'currentRevision',
  'entries',
  'artifacts',
  'candidateCommit',
  'resolutionAttempts',
  'createdAt',
  'updatedAt',
] as const;

export function validateConflict(input: unknown): ValidationResult<WorkspaceConflict> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'conflict', collector)) return collector.finish(undefined as never);
  checkKeys(input, CONFLICT_KEYS, CONFLICT_KEYS, 'conflict', collector);
  if (input['schemaVersion'] !== WORKSPACE_CONTRACT_VERSION) collector.push('conflict.schemaVersion: expected 1');
  for (const key of ['conflictId', 'publicationId', 'bindingId', 'tenantId', 'profileId'] as const) {
    checkString(input[key], `conflict.${key}`, collector, 300);
  }
  for (const key of ['baseRevision', 'runRevision', 'currentRevision'] as const) {
    if (!isRevision(input[key])) collector.push(`conflict.${key}: expected a revision`);
  }
  if (checkArray(input['entries'], 'conflict.entries', collector)) {
    input['entries'].forEach((entry, i) => {
      const path = `conflict.entries[${i}]`;
      if (!checkObject(entry, path, collector)) return;
      checkKeys(entry, CONFLICT_ENTRY_KEYS, CONFLICT_ENTRY_KEYS, path, collector);
      if (!isSafeRelativePath(entry['path'])) collector.push(`${path}.path: expected a relative path`);
      if (!CONFLICT_KINDS.includes(entry['kind'] as ConflictKind)) {
        collector.push(`${path}.kind: expected one of ${CONFLICT_KINDS.join(', ')}`);
      }
      for (const key of ['runSha256', 'currentSha256'] as const) {
        const value = entry[key];
        if (value !== null && !/^[0-9a-f]{64}$/.test(String(value))) collector.push(`${path}.${key}: expected 64 lowercase hex chars or null`);
      }
    });
  }
  if (checkArray(input['artifacts'], 'conflict.artifacts', collector)) {
    input['artifacts'].forEach((entry, i) => validateArtifactRef(entry, `conflict.artifacts[${i}]`, collector));
  }
  if (input['candidateCommit'] !== null && !isCommitSha(input['candidateCommit'])) {
    collector.push('conflict.candidateCommit: expected a commit sha or null');
  }
  if (typeof input['resolutionAttempts'] !== 'number' || !Number.isInteger(input['resolutionAttempts']) || (input['resolutionAttempts'] as number) < 0) {
    collector.push('conflict.resolutionAttempts: expected a non-negative integer');
  }
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (!isUtcTimestamp(input[key])) collector.push(`conflict.${key}: expected UTC ISO timestamp`);
  }
  return collector.finish(input as unknown as WorkspaceConflict);
}

const CANDIDATE_KEYS = [
  'schemaVersion',
  'candidateId',
  'conflictId',
  'bindingId',
  'tenantId',
  'profileId',
  'baseRevision',
  'expectedHeadRevision',
  'tree',
  'entries',
  'source',
  'resolverRunId',
  'evidence',
  'createdAt',
] as const;

export function validateCandidate(input: unknown): ValidationResult<WorkspaceResolutionCandidate> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'candidate', collector)) return collector.finish(undefined as never);
  checkKeys(input, CANDIDATE_KEYS, CANDIDATE_KEYS, 'candidate', collector);
  if (input['schemaVersion'] !== WORKSPACE_CONTRACT_VERSION) collector.push('candidate.schemaVersion: expected 1');
  for (const key of ['candidateId', 'conflictId', 'bindingId', 'tenantId', 'profileId'] as const) {
    checkString(input[key], `candidate.${key}`, collector, 300);
  }
  if (!isRevision(input['baseRevision'])) collector.push('candidate.baseRevision: expected a revision');
  if (input['expectedHeadRevision'] !== null && !isCommitSha(input['expectedHeadRevision'])) {
    collector.push('candidate.expectedHeadRevision: expected a commit sha or null');
  }
  if (!isCommitSha(input['tree'])) collector.push('candidate.tree: expected a tree sha');
  if (checkArray(input['entries'], 'candidate.entries', collector)) {
    input['entries'].forEach((entry, i) => {
      const path = `candidate.entries[${i}]`;
      if (!checkObject(entry, path, collector)) return;
      checkKeys(entry, CONFLICT_ENTRY_KEYS, CONFLICT_ENTRY_KEYS, path, collector);
      if (!isSafeRelativePath(entry['path'])) collector.push(`${path}.path: expected a relative path`);
    });
  }
  if (input['resolverRunId'] !== null) checkSafeId(input['resolverRunId'], 'candidate.resolverRunId', collector);
  if (input['evidence'] !== null && typeof input['evidence'] !== 'string') collector.push('candidate.evidence: expected a string or null');
  if (!isUtcTimestamp(input['createdAt'])) collector.push('candidate.createdAt: expected UTC ISO timestamp');
  return collector.finish(input as unknown as WorkspaceResolutionCandidate);
}

const SNAPSHOT_KEYS = [
  'schemaVersion',
  'workspaceSnapshotId',
  'bindingId',
  'profileId',
  'baseRevision',
  'headRevision',
  'manifest',
  'files',
  'bytes',
  'artifacts',
  'warnings',
  'exportPolicyId',
  'createdAt',
] as const;

export function validateWorkspaceSnapshot(input: unknown): ValidationResult<ProfileWorkspaceSnapshot> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'snapshot', collector)) return collector.finish(undefined as never);
  checkKeys(input, SNAPSHOT_KEYS, SNAPSHOT_KEYS, 'snapshot', collector);
  if (input['schemaVersion'] !== WORKSPACE_CONTRACT_VERSION) collector.push('snapshot.schemaVersion: expected 1');
  for (const key of ['workspaceSnapshotId', 'bindingId', 'profileId', 'exportPolicyId'] as const) {
    checkString(input[key], `snapshot.${key}`, collector, 300);
  }
  if (!isRevision(input['baseRevision'])) collector.push('snapshot.baseRevision: expected a revision');
  if (input['headRevision'] !== null && !isCommitSha(input['headRevision'])) {
    collector.push('snapshot.headRevision: expected a commit sha or null');
  }
  if (checkArray(input['manifest'], 'snapshot.manifest', collector)) {
    input['manifest'].forEach((entry, i) => validateManifestEntry(entry, `snapshot.manifest[${i}]`, collector));
  }
  if (checkArray(input['warnings'], 'snapshot.warnings', collector)) {
    input['warnings'].forEach((entry, i) => checkString(entry, `snapshot.warnings[${i}]`, collector, 500));
  }
  for (const key of ['files', 'bytes', 'artifacts'] as const) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) collector.push(`snapshot.${key}: expected a non-negative integer`);
  }
  if (!isUtcTimestamp(input['createdAt'])) collector.push('snapshot.createdAt: expected UTC ISO timestamp');
  return collector.finish(input as unknown as ProfileWorkspaceSnapshot);
}
