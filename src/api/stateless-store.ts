import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { TERMINAL_EVENT_TYPES, type RunnerEvent } from '../contracts/events.js';
import type { RunResult } from '../contracts/result.js';
import { redactRepositoryToken, type RunSpec } from '../contracts/run-spec.js';
import type { LaunchArtifact, LaunchRepo } from '../adapters/external-worker-adapter.js';
import type { ApiRunState } from './contracts.js';

/**
 * In-memory состояние API (эпик #74). Приёмные записи и прогресс ранов живут в памяти
 * процесса — но приёмные записи дублируются в долговечный журнал, чтобы дедупликация по
 * `Idempotency-Key` переживала рестарт API (пересчитанный критический путь, шаг 1).
 * Без этого свойства повторный submit с тем же ключом после рестарта запускал бы
 * второй ран там, где первый ещё идёт.
 *
 * Журнал — построчный JSON (по записи на строку), дописывается атомарно. При чтении
 * повреждённые хвостовые строки пропускаются: журнал — оптимизация восстановления,
 * а не источник истины для несохранённого выхода.
 */

export const STATELESS_STORE_SCHEMA_VERSION = 2 as const;

/**
 * Строка журнала. Приёмная запись нужна для дедупликации; отметка `dispatched` —
 * чтобы после рестарта API перезапустить поллеры ранов, которые воркер уже принял.
 * Без неё принятый ран навсегда остаётся `queued`: результат не прочитать, а повтор
 * с новым ключом завёл бы второй ран.
 */
export type JournalLine =
  | { kind: 'admission'; record: AdmissionRecord }
  | { kind: 'prepared'; runId: string; repository: { fullName: string; revision?: string }; profileWorkspace?: RunSpec['profileWorkspace'] }
  | { kind: 'launch_intent'; runId: string; engine: string; at: string }
  | { kind: 'dispatched'; runId: string; engine: string; at: string }
  | { kind: 'worker_log_cursor'; runId: string; sourceSequence: number; apiSequence: number }
  | { kind: 'completed'; runId: string; patch: CompletedRunPatch };

export interface AdmissionRecord {
  schemaVersion: typeof STATELESS_STORE_SCHEMA_VERSION;
  requestId: string;
  userTaskId: string;
  conversationId: string;
  principalId: string;
  tenantId?: string;
  profileId: string;
  jobId: string;
  idempotencyKey: string;
  payloadHash: string;
  runId: string;
  operationId: string;
  ownerGeneration: number;
  spec: RunSpec;
  /**
   * Кандидаты приёма рана в порядке проб (issue #100). Хранится в записи, а не пересобирается
   * в `execute`: после рестарта API цепочка рана обязана быть той же, что была при приёме.
   * У записей до появления цепочки поля нет — тогда кандидат один, названный клиентом.
   */
  engineChain?: string[];
  createdAt: string;
}

export interface RunProgress {
  state: ApiRunState;
  sequence: number;
  events: RunnerEvent[];
  /** Сколько событий отброшено по лимиту памяти процесса. */
  droppedEvents: number;
  cancelRequested: 'cancel' | 'timeout' | null;
  connectionLost: boolean;
  result: RunResult | null;
  artifacts: LaunchArtifact[];
  repo: LaunchRepo | null;
  logUrl: string | null;
  answer: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  fencing: { rejected: number };
  /**
   * Движок, который отработал ран (issue #100): тот, на котором идёт попытка приёма, а после
   * квитанции — тот, который ран принял. Клиент видит его в `RunStatusView.engine`.
   */
  engine: string;
  publication: { status: string; committedRevision: string | null; conflictId: string | null; publicationId: string | null; reason: string | null } | null;
}

export interface CompletedRunPatch {
  state: ApiRunState;
  result: RunResult;
  artifacts: LaunchArtifact[];
  repo: LaunchRepo | null;
  logUrl: string | null;
  answer: string | null;
  finishedAt: string;
  publication?: RunProgress['publication'];
}

export interface StatelessStoreLimits {
  /** Сколько приёмных записей (вместе с ранами) держим в памяти. */
  maxRuns: number;
  /** Сколько незавершённых ранов держим: память процесса нельзя докупить. */
  maxActiveRuns: number;
  /** Сколько событий храним на один ран. */
  maxEventsPerRun: number;
  /** Через сколько после финализации терминальный ран выбрасывается из памяти. */
  terminalRunTtlMs: number;
}

export const DEFAULT_STATELESS_LIMITS: StatelessStoreLimits = {
  maxRuns: 500,
  maxActiveRuns: 200,
  maxEventsPerRun: 2000,
  terminalRunTtlMs: 60 * 60 * 1000,
};

const TERMINAL_API_STATES: readonly ApiRunState[] = ['succeeded', 'failed', 'cancelled'];

export function isTerminalApiState(state: ApiRunState): boolean {
  return TERMINAL_API_STATES.includes(state);
}

export class StatelessStore {
  private readonly byAdmission = new Map<string, AdmissionRecord>();
  private readonly byRun = new Map<string, AdmissionRecord>();
  private readonly byPrincipalTask = new Map<string, AdmissionRecord[]>();
  private readonly progress = new Map<string, RunProgress>();
  private readonly limits: StatelessStoreLimits;
  /** Куда дублируются приёмные записи; null = дедупликация только в памяти процесса. */
  private readonly persistPath: string | null;
  private readonly strictPersistence: boolean;
  /** Раны, отправленные воркеру: нужны, чтобы поллеры пережили рестарт API. */
  private readonly dispatched = new Map<string, { runId: string; engine: string; at: string }>();
  private readonly workerLogCursors = new Map<string, { sourceSequence: number; apiSequence: number }>();

  constructor(limits: Partial<StatelessStoreLimits> = {}, persistPath: string | null = null, strictPersistence = false) {
    this.limits = { ...DEFAULT_STATELESS_LIMITS, ...limits };
    this.persistPath = persistPath;
    this.strictPersistence = strictPersistence;
    if (persistPath) this.replay(persistPath);
  }

  /**
   * Дописать приёмную запись в долговечный журнал. Одна строка = одна запись, поэтому
   * запись переживает падение процесса целиком (строка либо есть, либо нет).
   *
   * `repository.token` из строки вычищается: журнал — это файл на диске, и секрет,
   * который туда попал, переживает ротацию ключей. В памяти процесса токен остаётся —
   * оттуда его берёт адаптер, который передаёт токен воркеру.
   */
  appendAdmission(record: AdmissionRecord): void {
    this.write({ kind: 'admission', record: { ...record, spec: redactRepositoryToken(record.spec) } });
  }

  appendPrepared(runId: string, repository: { fullName: string; revision?: string }, profileWorkspace?: RunSpec['profileWorkspace']): void {
    // Signed snapshot URLs and run-scoped write capabilities are transient secrets. The
    // worker already holds them; durable admission state needs only the profile binding.
    const persistedProfile = profileWorkspace ? {
      ...profileWorkspace,
      snapshotUrl: '',
      savebackToken: '',
    } : undefined;
    this.write({ kind: 'prepared', runId, repository, ...(persistedProfile ? { profileWorkspace: persistedProfile } : {}) });
  }

  /** Ран принят воркером: помечаем, чтобы поллер пережил рестарт API. */
  appendDispatched(runId: string, engine: string, at: string): void {
    this.write({ kind: 'dispatched', runId, engine, at });
    this.dispatched.set(runId, { runId, engine, at });
  }

  appendLaunchIntent(runId: string, engine: string, at: string): void {
    this.write({ kind: 'launch_intent', runId, engine, at });
    this.dispatched.set(runId, { runId, engine, at });
  }

  /** Persist the VM log source cursor alongside the central event cursor for restart-safe tailing. */
  recordWorkerLogCursor(runId: string, sourceSequence: number, apiSequence: number): void {
    const prior = this.workerLogCursors.get(runId);
    if (prior && sourceSequence <= prior.sourceSequence) return;
    const next = { sourceSequence: Math.max(sourceSequence, prior?.sourceSequence ?? 0), apiSequence: Math.max(apiSequence, prior?.apiSequence ?? 0) };
    this.workerLogCursors.set(runId, next);
    const progress = this.progress.get(runId);
    if (progress) progress.sequence = Math.max(progress.sequence, next.apiSequence);
    this.write({ kind: 'worker_log_cursor', runId, ...next });
  }

  workerLogCursor(runId: string): { sourceSequence: number; apiSequence: number } {
    return this.workerLogCursors.get(runId) ?? { sourceSequence: 0, apiSequence: 0 };
  }

  /** Раны, отправленные воркеру. */
  dispatchedRuns(): Array<{ runId: string; engine: string; at: string }> {
    return [...this.dispatched.values()];
  }

  private write(line: JournalLine): void {
    if (!this.persistPath) return;
    try {
      if (this.strictPersistence) {
        const fd = openSync(this.persistPath, 'a', 0o600);
        try {
          writeSync(fd, `${JSON.stringify(line)}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } else {
        appendFileSync(this.persistPath, `${JSON.stringify(line)}\n`, 'utf8');
      }
    } catch (err) {
      if (this.strictPersistence) throw err;
      // Журнал не должен ронять приём задачи: при недоступном журнале дедупликация
      // сохраняется в памяти процесса, а факт отказа виден в логе.
      const what = line.kind === 'admission' ? line.record.requestId : line.runId;
      console.warn(`[stateless-store] persist failed for ${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Восстановить приёмные записи из журнала. Повреждённые хвостовые строки пропускаются. */
  private replay(path: string): void {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return; // журнала ещё нет — это первый запуск
    }
    let restored = 0;
    let resumed = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as JournalLine;
        if (entry.kind === 'dispatched' || entry.kind === 'launch_intent') {
          if (typeof entry.runId === 'string' && entry.runId.length > 0) {
            this.dispatched.set(entry.runId, { runId: entry.runId, engine: String(entry.engine ?? ''), at: String(entry.at ?? '') });
            resumed += 1;
          }
          continue;
        }
        if (entry.kind === 'worker_log_cursor') {
          if (typeof entry.runId === 'string' && Number.isSafeInteger(entry.sourceSequence) && entry.sourceSequence >= 0 &&
              Number.isSafeInteger(entry.apiSequence) && entry.apiSequence >= 0) {
            const prior = this.workerLogCursors.get(entry.runId);
            this.workerLogCursors.set(entry.runId, {
              sourceSequence: Math.max(prior?.sourceSequence ?? 0, entry.sourceSequence),
              apiSequence: Math.max(prior?.apiSequence ?? 0, entry.apiSequence),
            });
          }
          continue;
        }
        if (entry.kind === 'prepared') {
          const record = this.byRun.get(entry.runId);
          if (record) {
            record.spec.repository = entry.repository;
            if (entry.profileWorkspace) record.spec.profileWorkspace = entry.profileWorkspace;
          }
          continue;
        }
        if (entry.kind === 'completed') {
          const record = this.byRun.get(entry.runId);
          if (record) {
            this.open(entry.runId, record.createdAt, record.spec.engine.name);
            this.complete(entry.runId, entry.patch, false);
          }
          continue;
        }
        if (entry.kind !== 'admission') continue;
        const record = entry.record;
        if (record?.schemaVersion !== STATELESS_STORE_SCHEMA_VERSION) continue;
        if (typeof record.runId !== 'string' || record.runId.length === 0) continue;
        this.index(record);
        restored += 1;
      } catch {
        // Обрыв записи в момент падения — пропускаем хвост, сохраняем остальное.
      }
    }
    if (restored > 0) console.warn(`[stateless-store] restored ${restored} admission records from ${path}`);
    if (resumed > 0) console.warn(`[stateless-store] ${resumed} dispatched runs will resume polling`);
  }

  /** Перестроить индексы из записи без проверки лимита (восстановление при старте). */
  private index(record: AdmissionRecord): void {
    this.byAdmission.set(admissionKey(record.principalId, record.idempotencyKey), record);
    this.byRun.set(record.runId, record);
    const indexKey = taskKey(record.principalId, record.userTaskId);
    const attempts = this.byPrincipalTask.get(indexKey) ?? [];
    attempts.push(record);
    attempts.sort((left, right) => left.ownerGeneration - right.ownerGeneration);
    this.byPrincipalTask.set(indexKey, attempts);
  }

  put(record: AdmissionRecord): void {
    this.appendAdmission(record);
    this.index(record);
    this.evictIfNeeded();
  }

  getByAdmission(principalId: string, idempotencyKey: string): AdmissionRecord | null {
    return this.byAdmission.get(admissionKey(principalId, idempotencyKey)) ?? null;
  }

  getByRun(runId: string): AdmissionRecord | null {
    return this.byRun.get(runId) ?? null;
  }

  attempts(principalId: string, userTaskId: string): AdmissionRecord[] {
    return [...(this.byPrincipalTask.get(taskKey(principalId, userTaskId)) ?? [])];
  }

  currentAttempt(principalId: string, userTaskId: string): AdmissionRecord | null {
    const attempts = this.byPrincipalTask.get(taskKey(principalId, userTaskId));
    if (!attempts || attempts.length === 0) return null;
    return attempts[attempts.length - 1]!;
  }

  listAll(): AdmissionRecord[] {
    return [...this.byAdmission.values()];
  }

  open(runId: string, startedAt: string, engine?: string): RunProgress {
    const existing = this.progress.get(runId);
    if (existing) return existing;
    const created: RunProgress = {
      state: 'queued',
      sequence: this.workerLogCursors.get(runId)?.apiSequence ?? 0,
      events: [],
      droppedEvents: 0,
      cancelRequested: null,
      connectionLost: false,
      result: null,
      artifacts: [],
      repo: null,
      logUrl: null,
      answer: null,
      startedAt,
      updatedAt: startedAt,
      finishedAt: null,
      fencing: { rejected: 0 },
      // Движок попытки: до приёма рана это первый кандидат цепочки, дальше его двигает
      // `setEngine` по мере отказов (issue #100).
      engine: engine ?? '',
      publication: null,
    };
    this.progress.set(runId, created);
    return created;
  }

  progressOf(runId: string): RunProgress | null {
    return this.progress.get(runId) ?? null;
  }

  /**
   * Движок текущей попытки приёма рана (issue #100). Клиент видит его в статусе, поэтому
   * смена движка не должна быть молчаливой: вызывающий обязан сопроводить её записью в
   * журнале (`engine_chain_advance`).
   */
  setEngine(runId: string, engine: string): void {
    const run = this.progress.get(runId);
    if (!run || run.engine === engine) return;
    run.engine = engine;
    run.updatedAt = new Date().toISOString();
  }

  /**
   * События рана. Нумерация обязана оставаться монотонной и непрерывной (от неё зависит
   * cursor-переигрывание), поэтому при переполнении новое событие вытесняет самое старое
   * не-терминальное. Терминальное событие не вытесняется никогда: иначе SSE-клиент не
   * увидит конца рана и будет poll'ить в пустоту.
   */
  append(runId: string, events: RunnerEvent[]): void {
    const run = this.progress.get(runId);
    if (!run) return;
    for (const event of events) {
      run.sequence = event.sequence;
      if (run.events.length >= this.limits.maxEventsPerRun) {
        if (isTerminalEvent(event)) {
          const victim = run.events.findIndex((stored) => !isTerminalEvent(stored));
          if (victim >= 0) run.events.splice(victim, 1);
          else {
            run.droppedEvents += 1;
            continue;
          }
        } else {
          run.droppedEvents += 1;
          continue;
        }
      }
      run.events.push(event);
    }
    run.updatedAt = events.length > 0 ? events[events.length - 1]!.timestamp : run.updatedAt;
  }

  complete(runId: string, patch: CompletedRunPatch, persist = true): void {
    const run = this.progress.get(runId);
    if (!run) return;
    run.state = patch.state;
    run.result = patch.result;
    run.artifacts = patch.artifacts;
    run.repo = patch.repo;
    run.logUrl = patch.logUrl;
    run.answer = patch.answer;
    run.publication = patch.publication ?? null;
    run.finishedAt = patch.finishedAt;
    run.updatedAt = patch.finishedAt;
    if (persist) this.write({ kind: 'completed', runId, patch });
  }

  markCancelRequested(runId: string, reason: 'cancel' | 'timeout'): void {
    const run = this.progress.get(runId);
    if (!run) return;
    run.cancelRequested = reason;
    run.updatedAt = run.events.length > 0 ? run.events[run.events.length - 1]!.timestamp : run.updatedAt;
  }

  /** Выбросить терминальные раны, которые пережили свой TTL. Возвращает число выброшенных. */
  sweep(now: Date = new Date()): number {
    const deadlineMs = now.getTime() - this.limits.terminalRunTtlMs;
    let dropped = 0;
    for (const [runId, run] of this.progress) {
      if (!isTerminalApiState(run.state) || run.finishedAt === null) continue;
      if (Date.parse(run.finishedAt) > deadlineMs) continue;
      this.drop(runId);
      dropped += 1;
    }
    return dropped;
  }

  /** Отказ по fencing: попытка подействовать не на то поколение рана. */
  bumpFencing(runId: string): void {
    const run = this.progress.get(runId);
    if (run) run.fencing.rejected += 1;
  }

  /** Сколько ранов ещё не терминальные: ими заполняется память процесса. */
  activeRuns(): number {
    let active = 0;
    for (const run of this.progress.values()) {
      if (!isTerminalApiState(run.state)) active += 1;
    }
    return active;
  }

  counts(): { runs: number; admissions: number; events: number } {
    let events = 0;
    for (const run of this.progress.values()) events += run.events.length;
    return { runs: this.progress.size, admissions: this.byAdmission.size, events };
  }

  private evictIfNeeded(): void {
    if (this.byAdmission.size <= this.limits.maxRuns) return;
    // Выбрасываем самые старые терминальные раны: они уже прочитаны клиентом, а память
    // процесса — единственный ресурс, который нельзя докупить диском.
    const terminal = this.listAll()
      .filter((record) => {
        const run = this.progress.get(record.runId);
        return run !== undefined && isTerminalApiState(run.state);
      })
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    const overflow = this.byAdmission.size - this.limits.maxRuns;
    for (const record of terminal.slice(0, overflow)) {
      this.drop(record.runId);
    }
  }

  private drop(runId: string): void {
    this.progress.delete(runId);
    const record = this.byRun.get(runId);
    if (!record) return;
    this.byRun.delete(runId);
    this.byAdmission.delete(admissionKey(record.principalId, record.idempotencyKey));
    const indexKey = taskKey(record.principalId, record.userTaskId);
    const attempts = (this.byPrincipalTask.get(indexKey) ?? []).filter((entry) => entry.runId !== runId);
    if (attempts.length === 0) this.byPrincipalTask.delete(indexKey);
    else this.byPrincipalTask.set(indexKey, attempts);
  }
}

function admissionKey(principalId: string, idempotencyKey: string): string {
  return `${principalId}\u0000${idempotencyKey}`;
}

function taskKey(principalId: string, userTaskId: string): string {
  return `${principalId}\u0000${userTaskId}`;
}

function isTerminalEvent(event: RunnerEvent): boolean {
  return (TERMINAL_EVENT_TYPES as readonly string[]).includes(event.type);
}
