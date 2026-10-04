import { TERMINAL_EVENT_TYPES, type RunnerEvent } from '../contracts/events.js';
import type { RunResult } from '../contracts/result.js';
import type { RunSpec } from '../contracts/run-spec.js';
import type { LaunchArtifact, LaunchRepo } from '../adapters/external-worker-adapter.js';
import type { ApiRunState } from './contracts.js';

/**
 * In-memory состояние API (epic #74, шаг 1/6). Никакого диска: приёмные записи и прогресс
 * ранов живут в памяти процесса и теряются при рестарте. Это осознанный контракт — клиент
 * повторяет submit с новым `Idempotency-Key`, а не ждёт, что API вспомнит его задачу.
 */

export const STATELESS_STORE_SCHEMA_VERSION = 1 as const;

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

  constructor(limits: Partial<StatelessStoreLimits> = {}) {
    this.limits = { ...DEFAULT_STATELESS_LIMITS, ...limits };
  }

  put(record: AdmissionRecord): void {
    this.byAdmission.set(admissionKey(record.principalId, record.idempotencyKey), record);
    this.byRun.set(record.runId, record);
    const indexKey = taskKey(record.principalId, record.userTaskId);
    const attempts = this.byPrincipalTask.get(indexKey) ?? [];
    attempts.push(record);
    attempts.sort((left, right) => left.ownerGeneration - right.ownerGeneration);
    this.byPrincipalTask.set(indexKey, attempts);
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