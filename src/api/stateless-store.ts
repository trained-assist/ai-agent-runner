import { appendFileSync, readFileSync, renameSync } from 'node:fs';
import { TERMINAL_EVENT_TYPES, type RunnerEvent } from '../contracts/events.js';
import type { RunResult } from '../contracts/result.js';
import type { RunSpec } from '../contracts/run-spec.js';
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
  | { kind: 'dispatched'; runId: string; engine: string; at: string }
  | { kind: 'operator_resolution'; runId: string; resolution: OperatorResolution };

/** Operator attestation stops reconcile without fabricating a Runner result. */
export interface OperatorResolution {
  kind: 'process_confirmed_absent';
  actorPrincipalId: string;
  evidence: string;
  resolvedAt: string;
}

export interface AdmissionRecord {
  schemaVersion: typeof STATELESS_STORE_SCHEMA_VERSION;
  requestId: string;
  userTaskId: string;
  conversationId: string;
  principalId: string;
  profileId: string;
  jobId: string;
  idempotencyKey: string;
  payloadHash: string;
  runId: string;
  operationId: string;
  ownerGeneration: number;
  spec: RunSpec;
  createdAt: string;
}

export interface RunProgress {
  state: ApiRunState;
  sequence: number;
  events: RunnerEvent[];
  /** Сколько событий отброшено по лимиту памяти процесса. */
  droppedEvents: number;
  cancelRequested: 'cancel' | 'timeout' | null;
  operatorResolution: OperatorResolution | null;
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
  /** Раны, отправленные воркеру: нужны, чтобы поллеры пережили рестарт API. */
  private readonly dispatched = new Map<string, { runId: string; engine: string; at: string }>();

  constructor(limits: Partial<StatelessStoreLimits> = {}, persistPath: string | null = null) {
    this.limits = { ...DEFAULT_STATELESS_LIMITS, ...limits };
    this.persistPath = persistPath;
    if (persistPath) this.replay(persistPath);
  }

  /**
   * Дописать приёмную запись в долговечный журнал. Одна строка = одна запись, поэтому
   * запись переживает падение процесса целиком (строка либо есть, либо нет).
   */
  appendAdmission(record: AdmissionRecord): void {
    this.write({ kind: 'admission', record });
  }

  /** Ран принят воркером: помечаем, чтобы поллер пережил рестарт API. */
  appendDispatched(runId: string, engine: string, at: string): void {
    this.write({ kind: 'dispatched', runId, engine, at });
    this.dispatched.set(runId, { runId, engine, at });
  }

  /** Раны, отправленные воркеру. */
  dispatchedRuns(): Array<{ runId: string; engine: string; at: string }> {
    return [...this.dispatched.values()];
  }

  private write(line: JournalLine): void {
    if (!this.persistPath) return;
    try {
      appendFileSync(this.persistPath, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (err) {
      // Журнал не должен ронять приём задачи: при недоступном журнале дедупликация
      // сохраняется в памяти процесса, а факт отказа виден в логе.
      const what = line.kind === 'admission' ? line.record.requestId : line.runId;
      console.warn(`[stateless-store] persist failed for ${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private writeRequired(line: JournalLine): void {
    if (!this.persistPath) return;
    appendFileSync(this.persistPath, `${JSON.stringify(line)}\n`, 'utf8');
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
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as JournalLine;
        if (entry.kind === 'operator_resolution') {
          const record = this.byRun.get(entry.runId);
          if (!record || !isOperatorResolution(entry.resolution) || entry.resolution.actorPrincipalId !== record.principalId) continue;
          const run = this.open(entry.runId, record.createdAt);
          run.operatorResolution = entry.resolution;
          run.state = 'unknown';
          run.updatedAt = entry.resolution.resolvedAt;
          continue;
        }
        if (entry.kind === 'dispatched') {
          if (typeof entry.runId === 'string' && entry.runId.length > 0) {
            this.dispatched.set(entry.runId, { runId: entry.runId, engine: String(entry.engine ?? ''), at: String(entry.at ?? '') });
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
    const resumed = [...this.dispatched.keys()].filter((runId) => !this.progress.get(runId)?.operatorResolution).length;
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
    this.index(record);
    this.appendAdmission(record);
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

  open(runId: string, startedAt: string): RunProgress {
    const existing = this.progress.get(runId);
    if (existing) return existing;
    const created: RunProgress = {
      state: 'queued',
      sequence: 0,
      events: [],
      droppedEvents: 0,
      cancelRequested: null,
      operatorResolution: null,
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
    };
    this.progress.set(runId, created);
    return created;
  }

  progressOf(runId: string): RunProgress | null {
    return this.progress.get(runId) ?? null;
  }

  hasDurableJournal(): boolean {
    return this.persistPath !== null;
  }

  resolveUnknown(runId: string, resolution: OperatorResolution): OperatorResolution {
    const run = this.progress.get(runId);
    if (!run) throw new Error('operator resolution requires an open run');
    if (run.operatorResolution) return run.operatorResolution;
    if (run.state !== 'unknown') throw new Error('only unknown runs can be operator-resolved');
    // This is a tombstone, not a Runner result: persist before stopping future polling.
    // Unlike best-effort admission journaling, failure here must leave reconciliation active.
    this.writeRequired({ kind: 'operator_resolution', runId, resolution });
    run.operatorResolution = resolution;
    run.updatedAt = resolution.resolvedAt;
    return resolution;
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

  complete(
    runId: string,
    patch: {
      state: ApiRunState;
      result: RunResult;
      artifacts: LaunchArtifact[];
      repo: LaunchRepo | null;
      logUrl: string | null;
      answer: string | null;
      finishedAt: string;
    },
  ): void {
    const run = this.progress.get(runId);
    if (!run) return;
    run.state = patch.state;
    run.result = patch.result;
    run.artifacts = patch.artifacts;
    run.repo = patch.repo;
    run.logUrl = patch.logUrl;
    run.answer = patch.answer;
    run.finishedAt = patch.finishedAt;
    run.updatedAt = patch.finishedAt;
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
      if (!isTerminalApiState(run.state) && !run.operatorResolution) active += 1;
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

function isOperatorResolution(value: unknown): value is OperatorResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const resolution = value as Record<string, unknown>;
  return resolution.kind === 'process_confirmed_absent'
    && typeof resolution.actorPrincipalId === 'string'
    && resolution.actorPrincipalId.length > 0
    && typeof resolution.evidence === 'string'
    && resolution.evidence.trim().length >= 8
    && resolution.evidence.length <= 500
    && typeof resolution.resolvedAt === 'string'
    && Number.isFinite(Date.parse(resolution.resolvedAt));
}

function isTerminalEvent(event: RunnerEvent): boolean {
  return (TERMINAL_EVENT_TYPES as readonly string[]).includes(event.type);
}
