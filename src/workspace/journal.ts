/**
 * Durable-журнал операций workspace: идемпотентность по `operationId`, запись публикаций,
 * конфликтов и кандидатов разрешения.
 *
 * Правила, которые журнал обязан соблюдать (перенесены из legacy-принципа «запись до
 * действия», §3.5 документа о сохранении данных):
 *
 * 1. Запись состояния делается ДО внешнего вызова (push/administrative create). Падение
 *    после записи оставляет читаемый след, а не бесхозный результат.
 * 2. Никаких необратимых удалений без подтверждения: `retention` чистит только то, что
 *    удаление разрешено, и никогда — запись, на которую ссылается публикация.
 * 3. Один `operationId` с тем же payload возвращает тот же результат; другой payload под
 *    тем же ключом — ошибка `WORKSPACE_OPERATION_CONFLICT`, а не «последний победил».
 * 4. Битая запись не превращается в тихий успех: чтение валидирует схему и падает громко.
 *
 * Хранилище — файловое, атомарная запись (temp + rename). Модуль не выбирает D1/Durable
 * Object: контракт журнала описан так, чтобы интегратор подставил своё хранилище,
 * реализовав те же операции (см. `WorkspaceJournalPort`).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../contracts/run-spec.js';
import { sha256Hex } from '../storage/blob-store.js';
import {
  WorkspaceError,
  validateBinding,
  validateCandidate,
  validateConflict,
  validatePublication,
  type ProfileRepositoryBinding,
  type WorkspaceConflict,
  type WorkspacePublication,
  type WorkspaceResolutionCandidate,
} from './contract.js';

export const WORKSPACE_JOURNAL_SCHEMA_VERSION = 1 as const;

export type OperationStatus = 'completed' | 'failed';

export interface WorkspaceOperationRecord {
  operationId: string;
  method: string;
  payloadHash: string;
  status: OperationStatus;
  /** JSON-результат метода; при `failed` — код и сообщение ошибки. */
  result: unknown;
  error: { code: string; message: string } | null;
  createdAt: string;
}

export function operationPayloadHash(input: unknown): string {
  return sha256Hex(canonicalJson(input));
}

export interface WorkspaceJournalState {
  operations: Record<string, WorkspaceOperationRecord>;
  publications: Record<string, WorkspacePublication>;
  conflicts: Record<string, WorkspaceConflict>;
  candidates: Record<string, WorkspaceResolutionCandidate>;
  bindings: Record<string, ProfileRepositoryBinding>;
  /** cursor последнего завершённого шага batch-операции: возобновление без повторов. */
  batchCursors: Record<string, string>;
}

/**
 * Порт журнала. Файловая реализация — дефолт; интегратор может заменить на своё
 * долговечное хранилище, не меняя семантики операций.
 */
export interface WorkspaceJournalPort {
  read(): WorkspaceJournalState;
  /**
   * Идемпотентный запуск операции. Возвращает `replayed: true`, если результат для этого
   * `operationId` уже записан; при этом `result` — тот же самый.
   */
  runOperation<T>(input: {
    operationId: string;
    method: string;
    payload: unknown;
    execute: () => Promise<T>;
  }): Promise<{ replayed: boolean; result: T }>;
  putPublication(publication: WorkspacePublication): WorkspacePublication;
  getPublication(publicationId: string): WorkspacePublication | null;
  findPublicationByOperation(operationId: string): WorkspacePublication | null;
  listPublications(filter?: { profileId?: string; status?: string }): WorkspacePublication[];
  putConflict(conflict: WorkspaceConflict): WorkspaceConflict;
  getConflict(conflictId: string): WorkspaceConflict | null;
  listConflicts(filter?: { profileId?: string }): WorkspaceConflict[];
  putCandidate(candidate: WorkspaceResolutionCandidate): WorkspaceResolutionCandidate;
  getCandidate(candidateId: string): WorkspaceResolutionCandidate | null;
  /** Счётчик попыток разрешения конфликта: запрет бесконечного resolver-цикла. */
  bumpResolutionAttempts(conflictId: string): number;
  putBinding(binding: ProfileRepositoryBinding): ProfileRepositoryBinding;
  getBatchCursor(operationId: string): string | null;
  setBatchCursor(operationId: string, cursor: string): void;
}

interface JournalFile extends WorkspaceJournalState {
  schemaVersion: number;
}

export class WorkspaceJournal implements WorkspaceJournalPort {
  readonly rootDir: string;
  private readonly file: string;
  private state: WorkspaceJournalState = emptyState();

  constructor(rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) {
      throw new WorkspaceError('WORKSPACE_INVALID', 'workspace journal requires a root directory');
    }
    this.rootDir = rootDir;
    this.file = join(rootDir, 'workspace-journal.json');
  }

  /**
   * Загружает журнал. Отсутствующий файл — пустое состояние (первый запуск); битый файл —
   * ошибка: молчаливый сброс durable-истории хуже, чем отказ старта.
   */
  init(): void {
    if (!existsSync(this.file)) {
      this.state = emptyState();
      this.persist();
      return;
    }
    const raw = readFileSync(this.file, 'utf8');
    let parsed: JournalFile;
    try {
      parsed = JSON.parse(raw) as JournalFile;
    } catch {
      throw new WorkspaceError('WORKSPACE_INVALID', `workspace journal is not valid JSON: ${this.file}`);
    }
    if (parsed.schemaVersion !== WORKSPACE_JOURNAL_SCHEMA_VERSION) {
      throw new WorkspaceError('WORKSPACE_INVALID', `workspace journal: unsupported schemaVersion ${String(parsed.schemaVersion)}`);
    }
    const state = emptyState();
    for (const [id, record] of Object.entries(parsed.operations ?? {})) state.operations[id] = record;
    for (const [id, binding] of Object.entries(parsed.bindings ?? {})) {
      const validated = validateBinding(binding);
      if (!validated.ok) throw new WorkspaceError('WORKSPACE_INVALID', `workspace journal binding ${id} is invalid: ${validated.errors.join('; ')}`);
      state.bindings[id] = validated.value;
    }
    for (const [id, publication] of Object.entries(parsed.publications ?? {})) {
      const validated = validatePublication(publication);
      if (!validated.ok) throw new WorkspaceError('WORKSPACE_INVALID', `workspace journal publication ${id} is invalid: ${validated.errors.join('; ')}`);
      state.publications[id] = validated.value;
    }
    for (const [id, conflict] of Object.entries(parsed.conflicts ?? {})) {
      const validated = validateConflict(conflict);
      if (!validated.ok) throw new WorkspaceError('WORKSPACE_INVALID', `workspace journal conflict ${id} is invalid: ${validated.errors.join('; ')}`);
      state.conflicts[id] = validated.value;
    }
    for (const [id, candidate] of Object.entries(parsed.candidates ?? {})) {
      const validated = validateCandidate(candidate);
      if (!validated.ok) throw new WorkspaceError('WORKSPACE_INVALID', `workspace journal candidate ${id} is invalid: ${validated.errors.join('; ')}`);
      state.candidates[id] = validated.value;
    }
    for (const [id, cursor] of Object.entries(parsed.batchCursors ?? {})) state.batchCursors[id] = cursor;
    this.state = state;
  }

  read(): WorkspaceJournalState {
    return this.state;
  }

  async runOperation<T>(input: {
    operationId: string;
    method: string;
    payload: unknown;
    execute: () => Promise<T>;
  }): Promise<{ replayed: boolean; result: T }> {
    assertOperationId(input.operationId);
    const hash = operationPayloadHash(input.payload);
    const existing = this.state.operations[input.operationId];
    if (existing) {
      if (existing.payloadHash !== hash) {
        throw new WorkspaceError(
          'WORKSPACE_OPERATION_CONFLICT',
          `operation ${input.operationId} was already executed with a different payload (recorded method ${existing.method}, requested ${input.method})`,
          { detail: { operationId: input.operationId, recordedMethod: existing.method, requestedMethod: input.method } },
        );
      }
      // Отказ — не результат: тот же operationId с тем же payload повторяется после
      // починки причины (например, после восстановления object storage). Защищён от
      // повтора только completed-результат, у которого есть что вернуть.
      if (existing.status === 'failed') return this.executeAndRecord(input, hash);
      return { replayed: true, result: existing.result as T };
    }
    return this.executeAndRecord(input, hash);
  }

  private async executeAndRecord<T>(
    input: { operationId: string; method: string; payload: unknown; execute: () => Promise<T> },
    hash: string,
  ): Promise<{ replayed: boolean; result: T }> {
    try {
      const result = await input.execute();
      const record: WorkspaceOperationRecord = {
        operationId: input.operationId,
        method: input.method,
        payloadHash: hash,
        status: 'completed',
        result: result as unknown,
        error: null,
        createdAt: new Date().toISOString(),
      };
      this.state.operations[input.operationId] = record;
      this.persist();
      return { replayed: false, result };
    } catch (err) {
      // Отказ фиксируется как failed: тот же operationId с тем же payload можно повторить
      // после починки причины, тогда как completed-результат не переигрывается никогда.
      const record: WorkspaceOperationRecord = {
        operationId: input.operationId,
        method: input.method,
        payloadHash: hash,
        status: 'failed',
        result: null,
        error: {
          code: err instanceof WorkspaceError ? err.code : 'WORKSPACE_GIT_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
        createdAt: new Date().toISOString(),
      };
      this.state.operations[input.operationId] = record;
      this.persist();
      throw err;
    }
  }

  putPublication(publication: WorkspacePublication): WorkspacePublication {
    const validated = validatePublication(publication);
    if (!validated.ok) {
      throw new WorkspaceError('WORKSPACE_INVALID', `publication ${publication.publicationId} is invalid: ${validated.errors.join('; ')}`);
    }
    this.state.publications[publication.publicationId] = validated.value;
    this.persist();
    return validated.value;
  }

  getPublication(publicationId: string): WorkspacePublication | null {
    return this.state.publications[publicationId] ?? null;
  }

  findPublicationByOperation(operationId: string): WorkspacePublication | null {
    const entry = Object.values(this.state.publications).find((item) => item.operationId === operationId);
    return entry ?? null;
  }

  listPublications(filter: { profileId?: string; status?: string } = {}): WorkspacePublication[] {
    return Object.values(this.state.publications)
      .filter((item) => (filter.profileId ? item.profileId === filter.profileId : true))
      .filter((item) => (filter.status ? item.status === filter.status : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  putConflict(conflict: WorkspaceConflict): WorkspaceConflict {
    const validated = validateConflict(conflict);
    if (!validated.ok) {
      throw new WorkspaceError('WORKSPACE_INVALID', `conflict ${conflict.conflictId} is invalid: ${validated.errors.join('; ')}`);
    }
    this.state.conflicts[conflict.conflictId] = validated.value;
    this.persist();
    return validated.value;
  }

  getConflict(conflictId: string): WorkspaceConflict | null {
    return this.state.conflicts[conflictId] ?? null;
  }

  listConflicts(filter: { profileId?: string } = {}): WorkspaceConflict[] {
    return Object.values(this.state.conflicts)
      .filter((item) => (filter.profileId ? item.profileId === filter.profileId : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  putCandidate(candidate: WorkspaceResolutionCandidate): WorkspaceResolutionCandidate {
    const validated = validateCandidate(candidate);
    if (!validated.ok) {
      throw new WorkspaceError('WORKSPACE_INVALID', `candidate ${candidate.candidateId} is invalid: ${validated.errors.join('; ')}`);
    }
    this.state.candidates[candidate.candidateId] = validated.value;
    this.persist();
    return validated.value;
  }

  getCandidate(candidateId: string): WorkspaceResolutionCandidate | null {
    return this.state.candidates[candidateId] ?? null;
  }

  /**
   * Счётчик попыток разрешения. Он же — предохранитель от бесконечного цикла
   * resolver/GTD: исчерпание лимита переводит конфликт в `awaiting_user_input`,
   * а не запускает новый раунд автоматически.
   */
  bumpResolutionAttempts(conflictId: string): number {
    const conflict = this.state.conflicts[conflictId];
    if (!conflict) {
      throw new WorkspaceError('WORKSPACE_NOT_FOUND', `conflict ${conflictId} is not in the journal`);
    }
    const attempts = conflict.resolutionAttempts + 1;
    this.state.conflicts[conflictId] = { ...conflict, resolutionAttempts: attempts, updatedAt: new Date().toISOString() };
    this.persist();
    return attempts;
  }

  putBinding(binding: ProfileRepositoryBinding): ProfileRepositoryBinding {
    const validated = validateBinding(binding);
    if (!validated.ok) {
      throw new WorkspaceError('WORKSPACE_INVALID', `binding ${binding.bindingId} is invalid: ${validated.errors.join('; ')}`);
    }
    this.state.bindings[binding.bindingId] = validated.value;
    this.persist();
    return validated.value;
  }

  getBatchCursor(operationId: string): string | null {
    return this.state.batchCursors[operationId] ?? null;
  }

  setBatchCursor(operationId: string, cursor: string): void {
    this.state.batchCursors[operationId] = cursor;
    this.persist();
  }

  /**
   * Удаление записей журнала olderThan. Публикации не удаляются никогда: их читает
   * статус-путь после реконнекта, а «старая» запись может быть единственным следом
   * неизвестного исхода push. Здесь чистится только операционный мусор.
   */
  pruneOperations(olderThan: string): string[] {
    const removed: string[] = [];
    for (const [id, record] of Object.entries(this.state.operations)) {
      if (record.createdAt < olderThan) {
        delete this.state.operations[id];
        removed.push(id);
      }
    }
    if (removed.length > 0) this.persist();
    return removed;
  }

  /** Диагностика приёмки: что в журнале, без содержимого секретов. */
  stats(): { operations: number; publications: number; conflicts: number; candidates: number; bindings: number } {
    return {
      operations: Object.keys(this.state.operations).length,
      publications: Object.keys(this.state.publications).length,
      conflicts: Object.keys(this.state.conflicts).length,
      candidates: Object.keys(this.state.candidates).length,
      bindings: Object.keys(this.state.bindings).length,
    };
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const payload: JournalFile = {
      schemaVersion: WORKSPACE_JOURNAL_SCHEMA_VERSION,
      operations: this.state.operations,
      publications: this.state.publications,
      conflicts: this.state.conflicts,
      candidates: this.state.candidates,
      bindings: this.state.bindings,
      batchCursors: this.state.batchCursors,
    };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

function emptyState(): WorkspaceJournalState {
  return { operations: {}, publications: {}, conflicts: {}, candidates: {}, bindings: {}, batchCursors: {} };
}

function assertOperationId(operationId: string): void {
  if (typeof operationId !== 'string' || operationId.length === 0 || operationId.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(operationId)) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'operationId is required and must match [A-Za-z0-9][A-Za-z0-9._:-]*');
  }
}

/** In-memory журнал для детерминированных тестов и для хоста без диска. */
export class MemoryWorkspaceJournal implements WorkspaceJournalPort {
  private readonly state: WorkspaceJournalState = emptyState();
  private readonly attempts = new Map<string, number>();

  read(): WorkspaceJournalState {
    return this.state;
  }

  async runOperation<T>(input: {
    operationId: string;
    method: string;
    payload: unknown;
    execute: () => Promise<T>;
  }): Promise<{ replayed: boolean; result: T }> {
    assertOperationId(input.operationId);
    const hash = operationPayloadHash(input.payload);
    const existing = this.state.operations[input.operationId];
    if (existing) {
      if (existing.payloadHash !== hash) {
        throw new WorkspaceError('WORKSPACE_OPERATION_CONFLICT', `operation ${input.operationId} was already executed with a different payload`);
      }
      if (existing.status === 'failed') {
        return this.executeAndRecord(input, hash);
      }
      return { replayed: true, result: existing.result as T };
    }
    return this.executeAndRecord(input, hash);
  }

  private async executeAndRecord<T>(
    input: { operationId: string; method: string; payload: unknown; execute: () => Promise<T> },
    hash: string,
  ): Promise<{ replayed: boolean; result: T }> {
    try {
      const result = await input.execute();
      this.state.operations[input.operationId] = {
        operationId: input.operationId,
        method: input.method,
        payloadHash: hash,
        status: 'completed',
        result: result as unknown,
        error: null,
        createdAt: new Date().toISOString(),
      };
      return { replayed: false, result };
    } catch (err) {
      this.state.operations[input.operationId] = {
        operationId: input.operationId,
        method: input.method,
        payloadHash: hash,
        status: 'failed',
        result: null,
        error: { code: err instanceof WorkspaceError ? err.code : 'WORKSPACE_GIT_FAILED', message: err instanceof Error ? err.message : String(err) },
        createdAt: new Date().toISOString(),
      };
      throw err;
    }
  }

  putPublication(publication: WorkspacePublication): WorkspacePublication {
    const validated = validatePublication(publication);
    if (!validated.ok) throw new WorkspaceError('WORKSPACE_INVALID', `publication ${publication.publicationId} is invalid: ${validated.errors.join('; ')}`);
    this.state.publications[publication.publicationId] = validated.value;
    return validated.value;
  }

  getPublication(publicationId: string): WorkspacePublication | null {
    return this.state.publications[publicationId] ?? null;
  }

  findPublicationByOperation(operationId: string): WorkspacePublication | null {
    return Object.values(this.state.publications).find((item) => item.operationId === operationId) ?? null;
  }

  listPublications(filter: { profileId?: string; status?: string } = {}): WorkspacePublication[] {
    return Object.values(this.state.publications)
      .filter((item) => (filter.profileId ? item.profileId === filter.profileId : true))
      .filter((item) => (filter.status ? item.status === filter.status : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  putConflict(conflict: WorkspaceConflict): WorkspaceConflict {
    const validated = validateConflict(conflict);
    if (!validated.ok) throw new WorkspaceError('WORKSPACE_INVALID', `conflict ${conflict.conflictId} is invalid: ${validated.errors.join('; ')}`);
    this.state.conflicts[conflict.conflictId] = validated.value;
    return validated.value;
  }

  getConflict(conflictId: string): WorkspaceConflict | null {
    return this.state.conflicts[conflictId] ?? null;
  }

  listConflicts(filter: { profileId?: string } = {}): WorkspaceConflict[] {
    return Object.values(this.state.conflicts)
      .filter((item) => (filter.profileId ? item.profileId === filter.profileId : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  putCandidate(candidate: WorkspaceResolutionCandidate): WorkspaceResolutionCandidate {
    const validated = validateCandidate(candidate);
    if (!validated.ok) throw new WorkspaceError('WORKSPACE_INVALID', `candidate ${candidate.candidateId} is invalid: ${validated.errors.join('; ')}`);
    this.state.candidates[candidate.candidateId] = validated.value;
    return validated.value;
  }

  getCandidate(candidateId: string): WorkspaceResolutionCandidate | null {
    return this.state.candidates[candidateId] ?? null;
  }

  bumpResolutionAttempts(conflictId: string): number {
    if (!this.state.conflicts[conflictId]) throw new WorkspaceError('WORKSPACE_NOT_FOUND', `conflict ${conflictId} is not in the journal`);
    const next = (this.attempts.get(conflictId) ?? 0) + 1;
    this.attempts.set(conflictId, next);
    return next;
  }

  putBinding(binding: ProfileRepositoryBinding): ProfileRepositoryBinding {
    const validated = validateBinding(binding);
    if (!validated.ok) throw new WorkspaceError('WORKSPACE_INVALID', `binding ${binding.bindingId} is invalid: ${validated.errors.join('; ')}`);
    this.state.bindings[binding.bindingId] = validated.value;
    return validated.value;
  }

  getBatchCursor(operationId: string): string | null {
    return this.state.batchCursors[operationId] ?? null;
  }

  setBatchCursor(operationId: string, cursor: string): void {
    this.state.batchCursors[operationId] = cursor;
  }

  pruneOperations(olderThan: string): string[] {
    const removed: string[] = [];
    for (const [id, record] of Object.entries(this.state.operations)) {
      if (record.createdAt < olderThan) {
        delete this.state.operations[id];
        removed.push(id);
      }
    }
    return removed;
  }

  stats(): { operations: number; publications: number; conflicts: number; candidates: number; bindings: number } {
    return {
      operations: Object.keys(this.state.operations).length,
      publications: Object.keys(this.state.publications).length,
      conflicts: Object.keys(this.state.conflicts).length,
      candidates: Object.keys(this.state.candidates).length,
      bindings: Object.keys(this.state.bindings).length,
    };
  }
}

/** Удаление корня журнала — только в тестах/песочнице; в проде записи переживают VM. */
export function removeJournalRoot(rootDir: string): void {
  rmSync(rootDir, { recursive: true, force: true });
  if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true });
}

export function listJournalFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir).filter((name) => name.endsWith('.json'));
}
