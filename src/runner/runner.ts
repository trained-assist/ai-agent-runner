import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { EngineAdapter, EngineHandle } from '../adapters/engine/engine-adapter.js';
import { isProcessAlive, isProcessGroupAlive, killProcessGroup, killProcessTree, sleep, waitForProcessDeath } from '../adapters/engine/process-tree.js';
import {
  terminalPayloadForResult,
  validateRunnerEvent,
  type EventInput,
  type RunnerEvent,
  type RunnerEventType,
} from '../contracts/events.js';
import type { RunResult } from '../contracts/result.js';
import type { RunSpec } from '../contracts/run-spec.js';
import { stripRepositoryToken, validateRunSpec } from '../contracts/run-spec.js';
import { ConflictError, PreflightError, SpecValidationError } from '../contracts/validate.js';
import { FaultInjectedError, FaultRegistry, type FaultPoint } from '../faults/registry.js';
import { RunStore, type PersistedRunState } from './run-store.js';
import { cloneRepository, resolveCloneSource } from './repository.js';
import { ScopedEventLog, type LogSink } from './scoped-log.js';
import { canTransition, isTerminalState, type RunState } from './state-machine.js';
import type { BlobStore } from '../storage/blob-store.js';
import { RunExportStore, type PlannedOutput } from '../storage/export.js';
import type { UploadSessionStore } from '../storage/upload-session.js';
import type { WorkspaceSnapshotStore } from '../storage/workspace-snapshot.js';
import { artifactNameFor, mimeForName } from '../storage/export-manifest.js';
import type { RunExportManifest } from '../storage/export-manifest.js';
import { isRegularFile, resolveExistingInsideRoot } from '../storage/local-paths.js';
import { profileKey } from '../storage/keys.js';
import { redactSecrets, specHash, truncateLine } from './util.js';

export interface RunnerHostInfo {
  region?: string;
  environment?: string;
  release?: string;
  workerId?: string;
}

export interface RunnerOptions {
  rootDir: string;
  adapters: Record<string, EngineAdapter>;
  host?: RunnerHostInfo;
  clock?: () => Date;
  faults?: FaultRegistry;
  logSink?: LogSink;
  heartbeatIntervalMs?: number;
  cancelGraceMs?: number;
  /**
   * Профильное хранилище: при финализации ран дописывает в `profiles/<profileId>/trace.jsonl`
   * служебный след (runId, outcome, exitReason, код ошибки). След живёт в storage, а не в
   * workspace рана — между запусками доступен, тела на диск воркспейса не копятся
   * (эпик ai-agent-run-api#1, Ф2.3 / кейс E1; issue trained-assist/ai-agent-runner#23).
   */
  blob?: BlobStore;
  /** Выключить запись следов профиля, если хранилище передано по другой причине. */
  profileTrace?: boolean;
  /**
   * Манифесты экспорта артефактов. Экспорт объявленных выходов — отдельная стадия
   * финализации: она не запускает движок заново, переживает рестарт воркера и
   * повторный commit, а локальную копию удаляет только после подтверждённого
   * сохранения в object storage (P07 / AC-76).
   */
  exports?: RunExportStore;
  /**
   * Сессии прямой загрузки артефактов (P08). Позволяют клиенту загружать
   * артефакты напрямую в object storage через scoped upload sessions
   * и короткоживущие signed URLs.
   */
  uploads?: UploadSessionStore;
  /**
   * Снимки workspace (P09). Позволяют версионировать файлы воркспейса,
   * обнаруживать конфликты при параллельных записьх и создавать clean room
   * для следующей попытки.
   */
  snapshots?: WorkspaceSnapshotStore;
}

export interface StartReceipt {
  runId: string;
  jobId: string;
  operationId: string;
  state: RunState;
  deduplicated: boolean;
  receiptAt: string;
}

export type CancelStatus = 'stopped' | 'stop_pending' | 'already_terminal' | 'too_late' | 'rejected' | 'unknown_run';

export interface CancelReceipt {
  runId: string;
  status: CancelStatus;
  state?: RunState;
  reason?: string;
}

export interface SubmitEventResult {
  accepted: boolean;
  reason?: string;
  event?: RunnerEvent;
}

export interface RunSnapshot {
  runId: string;
  jobId: string;
  operationId: string;
  state: RunState;
  ownerGeneration: number;
  sequence: number;
  connectionLost: boolean;
  cancelRequested: 'cancel' | 'timeout' | null;
  orphanedPid: number | null;
  pid: number | null;
  pgid: number | null;
  exit: PersistedRunState['exit'];
  finalized: boolean;
  result: RunResult | null;
  /** Снимок манифеста экспорта на момент последнего чтения (null — экспорт не открывался). */
  export: RunExportSnapshot | null;
  fencing: { rejected: number };
  createdAt: string;
  updatedAt: string;
}

export interface RunExportSnapshot {
  version: number;
  attempts: number;
  status: RunExportManifest['status'];
  partial: boolean;
  planned: number;
  exported: number;
  failed: number;
  cleanup: RunExportManifest['cleanup']['decision'];
  retained: string[];
}

export interface RecoveryReport {
  scanned: number;
  resumedQueued: number;
  orphaned: number;
  lost: number;
  finalizingResumed: number;
  terminal: number;
  exportRetried: number;
}

interface InternalRun {
  state: PersistedRunState;
  events: RunnerEvent[];
  waiters: Array<(result: RunResult) => void>;
  handle: EngineHandle | null;
  timers: NodeJS.Timeout[];
  exitReceived: boolean;
  finalizePromise: Promise<RunResult> | null;
}

const DEFAULT_CANCEL_GRACE_MS = 1000;
const DEFAULT_MAX_LOG_LINE = 4096;

export class Runner {
  private readonly opts: RunnerOptions;
  private readonly store: RunStore;
  private readonly faults: FaultRegistry;
  private readonly eventLog: ScopedEventLog;
  private readonly clock: () => Date;
  private readonly runs = new Map<string, InternalRun>();
  private readonly cloneControllers = new Map<string, AbortController>();
  private disposed = false;
  /** Сериализует append в profiles/<id>/trace.jsonl — параллельные раны не теряют строки. */
  private profileTraceChain: Promise<void> = Promise.resolve();

  constructor(options: RunnerOptions) {
    this.opts = options;
    this.store = new RunStore(options.rootDir);
    this.store.init();
    this.faults = options.faults ?? new FaultRegistry();
    this.eventLog = new ScopedEventLog(options.logSink, this.faults);
    this.clock = options.clock ?? (() => new Date());
    for (const runId of this.store.listRunIds()) {
      const state = this.store.loadState(runId);
      if (!state) continue;
      this.runs.set(runId, {
        state,
        events: this.store.readEvents(runId),
        waiters: [],
        handle: null,
        timers: [],
        exitReceived: Boolean(state.exit?.observed),
        finalizePromise: null,
      });
    }
  }

  health(): { ready: boolean; droppedLogCount: number; activeRuns: number; runs: number } {
    let active = 0;
    for (const run of this.runs.values()) {
      if (!isTerminalState(run.state.state)) active += 1;
    }
    return { ready: !this.disposed, droppedLogCount: this.eventLog.droppedCount, activeRuns: active, runs: this.runs.size };
  }

  listRunIds(): string[] {
    return [...this.runs.keys()].sort();
  }

  getRun(runId: string): RunSnapshot | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    const st = run.state;
    return {
      runId: st.runId,
      jobId: st.jobId,
      operationId: st.operationId,
      state: st.state,
      ownerGeneration: st.ownerGeneration,
      sequence: st.sequence,
      connectionLost: st.connectionLost,
      cancelRequested: st.cancelRequested,
      orphanedPid: st.orphanedPid,
      pid: st.pid,
      pgid: st.pgid,
      exit: st.exit ? { ...st.exit } : null,
      finalized: st.finalized,
      result: st.result ? { ...st.result } : null,
      export: this.exportSnapshot(runId),
      fencing: { rejected: st.fencing.rejected },
      createdAt: st.createdAt,
      updatedAt: st.updatedAt,
    };
  }

  events(runId: string, afterSequence = 0): RunnerEvent[] {
    const run = this.runs.get(runId);
    if (!run) return [];
    return run.events.filter((event) => event.sequence > afterSequence);
  }

  /** Текущий манифест экспорта рана; null, если выходы не объявлялись или экспорт не открывался. */
  exportManifest(runId: string): RunExportManifest | null {
    if (!this.opts.exports) return null;
    return this.opts.exports.read(runId);
  }

  /**
   * Повторный commit экспорта без запуска движка: engine уже завершён, повторно
   * исполнять его нельзя (P07 — «повторный commit не запускает движок заново»).
   */
  async recommitExport(runId: string): Promise<RunExportManifest | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    return this.runExport(run.state, { force: true });
  }

  start(input: unknown, operationIdArg?: string): StartReceipt {
    const validated = validateRunSpec(input);
    if (!validated.ok) throw new SpecValidationError(validated.errors);
    const spec = validated.value;
    const operationId = operationIdArg ?? spec.operationId;
    if (operationId !== spec.operationId) {
      throw new SpecValidationError([`operationId mismatch: argument "${operationId}" vs spec "${spec.operationId}"`]);
    }
    const hash = specHash(spec);
    const now = this.nowIso();

    const existingOperation = this.store.getOperation(operationId);
    if (existingOperation) {
      if (existingOperation.specHash !== hash) {
        throw new ConflictError(operationId, 'the same operationId was already used with a different payload');
      }
      const run = this.runs.get(existingOperation.runId);
      if (!run) throw new ConflictError(operationId, 'durable receipt points to a missing run record');
      return {
        runId: run.state.runId,
        jobId: run.state.jobId,
        operationId,
        state: run.state.state,
        deduplicated: true,
        receiptAt: now,
      };
    }

    const existingRun = this.runs.get(spec.runId);
    if (existingRun) {
      if (specHash(existingRun.state.spec) !== hash) {
        throw new ConflictError(operationId, `runId "${spec.runId}" already exists with a different payload`);
      }
      this.store.setOperation(operationId, { runId: spec.runId, specHash: hash, createdAt: now });
      return {
        runId: spec.runId,
        jobId: existingRun.state.jobId,
        operationId,
        state: existingRun.state.state,
        deduplicated: true,
        receiptAt: now,
      };
    }

    const state: PersistedRunState = {
      schemaVersion: 1,
      runId: spec.runId,
      jobId: spec.jobId,
      operationId,
      userTaskId: spec.userTaskId,
      profileId: spec.profileId,
      ownerGeneration: spec.ownerGeneration,
      state: 'queued',
      sequence: 0,
      connectionLost: false,
      orphanedPid: null,
      pid: null,
      pgid: null,
      startedAt: null,
      cancelRequested: null,
      workerCrashed: false,
      exit: null,
      spec,
      finalized: false,
      result: null,
      fencing: { rejected: 0 },
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveState(state);
    this.store.setOperation(operationId, { runId: spec.runId, specHash: hash, createdAt: now });
    this.runs.set(spec.runId, {
      state,
      events: [],
      waiters: [],
      handle: null,
      timers: [],
      exitReceived: false,
      finalizePromise: null,
    });
    this.emit(state, 'claimed', { operationId });
    void this.execute(spec.runId).catch(() => undefined);

    return {
      runId: spec.runId,
      jobId: spec.jobId,
      operationId,
      state: 'queued',
      deduplicated: false,
      receiptAt: now,
    };
  }

  async cancel(runId: string, ownerGeneration: number): Promise<CancelReceipt> {
    const run = this.runs.get(runId);
    if (!run) return { runId, status: 'unknown_run' };
    const st = run.state;
    if (st.ownerGeneration !== ownerGeneration) {
      st.fencing.rejected += 1;
      this.store.saveState(st);
      return { runId, status: 'rejected', state: st.state, reason: 'stale_owner_generation' };
    }
    if (isTerminalState(st.state)) return { runId, status: 'already_terminal', state: st.state };
    if (st.state === 'finalizing') return { runId, status: 'too_late', state: st.state };

    if (!st.cancelRequested) {
      st.cancelRequested = 'cancel';
      this.store.saveState(st);
    }

    if (st.state === 'queued') {
      this.completeWithoutEngine(st, 'cancelled', 'cancelled');
      return { runId, status: 'stopped', state: st.state };
    }

    if (st.pid || st.pgid) {
      killProcessTree(st.pgid, st.pid, 'SIGTERM');
      const grace = this.opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
      const dead = await waitForProcessDeath(st.pgid, st.pid, grace);
      if (!dead) killProcessTree(st.pgid, st.pid, 'SIGKILL');
    }

    const stopped = await this.awaitStop(run);
    if (!stopped && !isTerminalState(st.state) && !run.exitReceived) {
      return { runId, status: 'stop_pending', state: st.state };
    }

    if (!isTerminalState(st.state) && !run.exitReceived) {
      st.exit = { code: null, signal: null, observed: false, at: this.nowIso() };
      this.store.saveState(st);
      this.emit(st, 'exit', { code: null, signal: null });
      if (st.state === 'running' && this.transition(st, 'finalizing')) {
        this.emit(st, 'finalizing', { reason: st.cancelRequested ?? 'cancel' });
        try {
          await this.finalize(runId);
        } catch {
          // finalization stays resumable via finalize()
        }
      }
    }

    return { runId, status: 'stopped', state: st.state };
  }

  submitEvent(runId: string, input: EventInput): SubmitEventResult {
    const run = this.runs.get(runId);
    if (!run) return { accepted: false, reason: 'unknown_run' };
    const st = run.state;
    if (st.ownerGeneration !== input.ownerGeneration) {
      st.fencing.rejected += 1;
      this.store.saveState(st);
      return { accepted: false, reason: 'stale_owner_generation' };
    }
    if (isTerminalState(st.state)) return { accepted: false, reason: 'already_terminal' };
    const candidate = {
      schemaVersion: 1,
      eventId: `${st.runId}:${st.sequence + 1}`,
      runId: st.runId,
      jobId: st.jobId,
      userTaskId: st.userTaskId,
      profileId: st.profileId,
      ownerGeneration: input.ownerGeneration,
      sequence: st.sequence + 1,
      timestamp: this.nowIso(),
      type: input.type,
      payload: input.payload,
    };
    const validated = validateRunnerEvent(candidate);
    if (!validated.ok) return { accepted: false, reason: 'invalid_event' };
    this.appendEvent(st, validated.value);
    return { accepted: true, event: validated.value };
  }

  async finalize(runId: string): Promise<RunResult> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    const st = run.state;
    if (st.finalized && st.result) return st.result;
    if (run.finalizePromise) return run.finalizePromise;
    const promise = this.doFinalize(st).finally(() => {
      run.finalizePromise = null;
    });
    run.finalizePromise = promise;
    return promise;
  }

  async waitFor(runId: string, timeoutMs = 30000): Promise<RunResult> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    if (run.state.finalized && run.state.result) return run.state.result;
    return new Promise<RunResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for run ${runId}`)), timeoutMs);
      run.waiters.push((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = { scanned: 0, resumedQueued: 0, orphaned: 0, lost: 0, finalizingResumed: 0, terminal: 0, exportRetried: 0 };
    await this.fireFault('recovery');
    for (const run of [...this.runs.values()]) {
      if (this.disposed) break;
      const st = run.state;
      report.scanned += 1;
      if (isTerminalState(st.state)) {
        report.terminal += 1;
        continue;
      }
      switch (st.state) {
        case 'queued':
          report.resumedQueued += 1;
          void this.execute(st.runId).catch(() => undefined);
          break;
        case 'starting':
          if (st.pid && isProcessAlive(st.pid)) {
            this.markOrphaned(run, report);
          } else {
            st.workerCrashed = true;
            this.store.saveState(st);
            this.completeWithoutEngine(st, 'failed', 'worker_crash', {
              code: 'WORKER_CRASH',
              failureClass: 'runtime',
              safeSummary: 'worker restarted before the engine process was confirmed; no hidden rerun',
              retryable: true,
            });
            report.lost += 1;
          }
          break;
        case 'running': {
          if (run.handle) break;
          if (st.pid && isProcessAlive(st.pid)) {
            this.markOrphaned(run, report);
            break;
          }
          if (!st.exit) {
            st.workerCrashed = true;
            st.exit = { code: null, signal: null, observed: false, at: this.nowIso() };
            this.store.saveState(st);
            this.emit(st, 'exit', { code: null, signal: null });
          } else if (!st.exit.observed) {
            st.workerCrashed = true;
            this.store.saveState(st);
          }
          const reason = st.workerCrashed ? 'worker_crash' : 'engine_exit';
          if (this.transition(st, 'finalizing')) {
            this.emit(st, 'finalizing', { reason });
            try {
              await this.finalize(st.runId);
            } catch {
              // stays resumable
            }
          }
          if (st.workerCrashed) report.lost += 1;
          else report.finalizingResumed += 1;
          if (this.exportManifest(st.runId)) report.exportRetried += 1;
          break;
        }
        case 'finalizing': {
          const before = this.exportManifest(st.runId)?.version ?? null;
          try {
            await this.finalize(st.runId);
            report.finalizingResumed += 1;
            const after = this.exportManifest(st.runId)?.version ?? null;
            if (before !== after) report.exportRetried += 1;
          } catch {
            // export fault persists; operator or next recover retries
          }
          break;
        }
      }
    }
    return report;
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.cloneControllers.values()) controller.abort();
    this.cloneControllers.clear();
    for (const run of this.runs.values()) {
      this.clearTimers(run);
      run.handle?.dispose();
      run.handle = null;
      run.finalizePromise = null;
    }
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private markOrphaned(run: InternalRun, report: RecoveryReport): void {
    const st = run.state;
    st.connectionLost = true;
    st.orphanedPid = st.pid;
    this.store.saveState(st);
    if (!isTerminalState(st.state)) {
      this.emit(st, 'connection_lost', {
        detectedAt: this.nowIso(),
        detail: 'engine process survived a worker restart; supervision is lost, no automatic rerun',
        engineAlive: true,
      });
    }
    report.orphaned += 1;
  }

  private transition(st: PersistedRunState, to: RunState): boolean {
    if (!canTransition(st.state, to)) return false;
    st.state = to;
    st.updatedAt = this.nowIso();
    this.store.saveState(st);
    return true;
  }

  private emit(st: PersistedRunState, type: RunnerEventType, payload: unknown): RunnerEvent {
    const candidate = {
      schemaVersion: 1,
      eventId: `${st.runId}:${st.sequence + 1}`,
      runId: st.runId,
      jobId: st.jobId,
      userTaskId: st.userTaskId,
      profileId: st.profileId,
      ownerGeneration: st.ownerGeneration,
      sequence: st.sequence + 1,
      timestamp: this.nowIso(),
      type,
      payload,
    };
    const validated = validateRunnerEvent(candidate);
    if (!validated.ok) throw new Error(`runner produced an invalid ${type} event: ${validated.errors.join('; ')}`);
    this.appendEvent(st, validated.value);
    return validated.value;
  }

  private appendEvent(st: PersistedRunState, event: RunnerEvent): void {
    const run = this.runs.get(st.runId);
    run?.events.push(event);
    st.sequence = event.sequence;
    st.updatedAt = this.nowIso();
    this.store.saveState(st);
    this.eventLog.append(this.store.logPath(st.runId), event);
  }

  private async fireFault(point: FaultPoint, runId?: string): Promise<void> {
    const spec = this.faults.take(point);
    if (!spec) return;
    if (spec.kind === 'throw') throw spec.error ?? new FaultInjectedError(point);
    if (spec.kind === 'custom' && spec.fn) await spec.fn({ point, runId });
  }

  private async execute(runId: string): Promise<void> {
    await Promise.resolve();
    const run = this.runs.get(runId);
    if (!run || this.disposed) return;
    const st = run.state;
    if (isTerminalState(st.state) || !this.transition(st, 'starting')) return;

    let handle: EngineHandle | null = null;
    let phase: 'preflight' | 'spawn' = 'preflight';
    try {
      await this.fireFault('preflight', runId);
      if (this.disposed) return;
      this.preflight(st);
      if (this.disposed) return;
      if (st.cancelRequested) {
        this.completeWithoutEngine(st, 'cancelled', 'cancelled');
        return;
      }
      await this.materialize(st);
      if (this.disposed) return;
      if (st.cancelRequested) {
        this.completeWithoutEngine(st, 'cancelled', 'cancelled');
        return;
      }
      const adapter = this.opts.adapters[st.spec.engine.name];
      if (!adapter) throw new PreflightError('ENGINE_UNSUPPORTED', `engine "${st.spec.engine.name}" is not registered on this worker`);
      phase = 'spawn';
      await this.fireFault('spawn', runId);
      if (this.disposed) return;
      if (st.cancelRequested) {
        this.completeWithoutEngine(st, 'cancelled', 'cancelled');
        return;
      }
      handle = await adapter.start({
        spec: st.spec,
        cwd: st.spec.cwd,
        env: this.buildEnv(st.spec),
        onLog: (stream, line) => this.onEngineLog(runId, stream, line),
        onExit: (code, signal) => {
          void this.onEngineExit(runId, code, signal);
        },
      });
      if (this.disposed) {
        handle.killTree('SIGKILL');
        handle.dispose();
        return;
      }
      if (!handle.pid) throw new Error('engine adapter did not return a live process id');
      st.pid = handle.pid;
      st.pgid = handle.pgid ?? handle.pid;
      st.startedAt = this.nowIso();
      if (!this.transition(st, 'running')) {
        handle.killTree('SIGKILL');
        return;
      }
      run.handle = handle;
      this.emit(st, 'started', { pid: handle.pid });
      this.armTimers(runId, st);
      if (st.cancelRequested) handle.killTree();
    } catch (err) {
      if (handle) {
        handle.killTree('SIGKILL');
        handle.dispose();
      }
      // воркер останавливается: run остаётся в starting, recover() разберёт его
      if (this.disposed) return;
      if (isTerminalState(st.state) || st.finalized) return;
      this.failStartPath(st, err, phase);
    }
  }

  private preflight(st: PersistedRunState): void {
    const spec = st.spec;
    if (spec.budget && !spec.budget.approved) {
      throw new PreflightError('BUDGET_UNAVAILABLE', spec.budget.reason ?? 'no approved budget for this run', { retryable: true });
    }
    for (const binding of spec.credentialBindings ?? []) {
      if (binding.status === 'missing') {
        throw new PreflightError('CREDENTIALS_UNAVAILABLE', `credential binding "${binding.ref}" is missing`);
      }
      if (binding.status === 'expired') {
        throw new PreflightError('CREDENTIALS_UNAVAILABLE', `credential binding "${binding.ref}" is expired`, { retryable: true });
      }
    }
    const allowed = spec.regionConstraints?.allowedRegions;
    if (allowed && allowed.length > 0) {
      const region = this.opts.host?.region;
      if (!region || !allowed.includes(region)) {
        throw new PreflightError('REGION_FORBIDDEN', `host region "${region ?? 'unknown'}" is outside allowed regions [${allowed.join(', ')}]`);
      }
    }
    if (!this.opts.adapters[spec.engine.name]) {
      throw new PreflightError('ENGINE_UNSUPPORTED', `engine "${spec.engine.name}" is not registered on this worker`);
    }
  }

  private async materialize(st: PersistedRunState): Promise<void> {
    try {
      mkdirSync(st.spec.cwd, { recursive: true });
    } catch (err) {
      throw new PreflightError('WORKSPACE_UNAVAILABLE', `cannot prepare workspace "${st.spec.cwd}": ${String((err as Error).message)}`, {
        retryable: true,
      });
    }
    try {
      // clone идёт в runner (child git), НЕ в движке: cwd движка = этот клон
      const source = resolveCloneSource(st.spec.repository);
      const controller = new AbortController();
      this.cloneControllers.set(st.runId, controller);
      if (this.disposed) controller.abort();
      await cloneRepository(source, st.spec.cwd, { signal: controller.signal });
    } finally {
      this.cloneControllers.delete(st.runId);
      // токен живёт только до попытки clone: в движок, env и журналы он не уходит
      stripRepositoryToken(st.spec);
    }
    this.emit(st, 'materialized', { inputs: st.spec.input?.refs?.length ?? 0 });
  }

  private buildEnv(spec: RunSpec): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of spec.envAllowlist) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return env;
  }

  private armTimers(runId: string, st: PersistedRunState): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (st.spec.limits.timeoutMs > 0) {
      const timer = setTimeout(() => this.onTimeout(runId), st.spec.limits.timeoutMs);
      timer.unref?.();
      run.timers.push(timer);
    }
    const heartbeatMs = this.opts.heartbeatIntervalMs ?? 0;
    if (heartbeatMs > 0) {
      const timer = setInterval(() => this.onHeartbeat(runId), heartbeatMs);
      timer.unref?.();
      run.timers.push(timer);
    }
  }

  private clearTimers(run: InternalRun): void {
    for (const timer of run.timers) clearTimeout(timer);
    run.timers = [];
  }

  private onTimeout(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || this.disposed) return;
    const st = run.state;
    if (isTerminalState(st.state) || st.finalized) return;
    if (!st.cancelRequested) {
      st.cancelRequested = 'timeout';
      this.store.saveState(st);
    }
    if (st.pid || st.pgid) {
      killProcessTree(st.pgid, st.pid, 'SIGTERM');
      const grace = this.opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
      void waitForProcessDeath(st.pgid, st.pid, grace).then((dead) => {
        if (!dead) killProcessTree(st.pgid, st.pid, 'SIGKILL');
      });
    }
  }

  private onHeartbeat(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || this.disposed) return;
    const st = run.state;
    if (isTerminalState(st.state)) return;
    const spec = this.faults.take('heartbeat');
    if (!spec) return;
    if (spec.kind === 'custom') {
      void spec.fn?.({ point: 'heartbeat', runId });
      return;
    }
    if (st.connectionLost) return;
    st.connectionLost = true;
    this.store.saveState(st);
    this.emit(st, 'connection_lost', {
      detectedAt: this.nowIso(),
      detail: spec.kind === 'throw' ? 'heartbeat delivery failed' : 'partition from control plane while engine is alive',
      engineAlive: isProcessAlive(st.pid),
    });
  }

  private onEngineLog(runId: string, stream: 'stdout' | 'stderr', rawLine: string): void {
    const run = this.runs.get(runId);
    if (!run || this.disposed) return;
    const st = run.state;
    if (isTerminalState(st.state)) return;
    const limit = st.spec.limits.maxOutputBytes ?? st.spec.limits.maxLogBytes ?? DEFAULT_MAX_LOG_LINE;
    const sanitized = redactSecrets(truncateLine(rawLine, limit)).replace(/[\x00-\x1f]/g, ' ');
    if (sanitized.length === 0) return;
    this.emit(st, 'log', { stream, level: 'info', message: sanitized });
  }

  private async onEngineExit(runId: string, code: number | null, signal: string | null): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.exitReceived || this.disposed) return;
    const st = run.state;
    if (isTerminalState(st.state)) return;
    run.exitReceived = true;
    this.clearTimers(run);
    st.exit = { code, signal, observed: true, at: this.nowIso() };
    this.store.saveState(st);
    this.emit(st, 'exit', { code, signal });
    if (this.disposed || isTerminalState(st.state)) return;
    if (!this.transition(st, 'finalizing')) return;
    this.emit(st, 'finalizing', { reason: st.cancelRequested ?? 'engine_exit' });
    try {
      await this.finalize(runId);
    } catch {
      // export fault keeps the run in finalizing; finalize() is the retry entry point
    }
  }

  private async awaitStop(run: InternalRun): Promise<boolean> {
    const grace = this.opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    const deadline = Date.now() + grace * 3 + 2000;
    while (Date.now() < deadline) {
      const st = run.state;
      if (isTerminalState(st.state)) return true;
      if (run.exitReceived) return true;
      if (!run.handle && st.pid && !isProcessAlive(st.pid) && !isProcessGroupAlive(st.pgid)) return true;
      await sleep(20);
    }
    const st = run.state;
    return isTerminalState(st.state) || run.exitReceived || (!isProcessAlive(st.pid) && !isProcessGroupAlive(st.pgid));
  }

  private completeWithoutEngine(
    st: PersistedRunState,
    outcome: 'cancelled' | 'failed',
    exitReason: 'cancelled' | 'preflight_refused' | 'worker_crash' | 'startup_failure',
    failure?: RunResult['failure'],
  ): void {
    const result: RunResult = {
      schemaVersion: 1,
      runId: st.runId,
      jobId: st.jobId,
      userTaskId: st.userTaskId,
      profileId: st.profileId,
      ownerGeneration: st.ownerGeneration,
      outcome,
      exitReason,
      exitCode: null,
      exitSignal: null,
      exitObserved: false,
      startedAt: st.startedAt ?? st.createdAt,
      finishedAt: this.nowIso(),
      usage: { status: 'unknown' },
      outputRefs: [],
      persistence: 'persisted',
      cleanup: 'completed',
      logPath: this.store.relLogPath(st.runId),
    };
    if (failure) result.failure = failure;
    stripRepositoryToken(st.spec);
    this.persistResult(st, result);
  }

  private failStartPath(st: PersistedRunState, err: unknown, phase: 'preflight' | 'spawn'): void {
    const message = err instanceof Error ? err.message : String(err);
    const safeSummary = truncateLine(redactSecrets(message), 500);
    const failure: RunResult['failure'] =
      phase === 'spawn'
        ? { code: 'ENGINE_STARTUP_FAILED', failureClass: 'engine', safeSummary, retryable: true }
        : err instanceof PreflightError
          ? { code: err.code, failureClass: err.failureClass, safeSummary, retryable: err.retryable }
          : { code: 'PREFLIGHT_FAILED', failureClass: 'preflight', safeSummary, retryable: true };
    const exitReason = phase === 'spawn' ? 'startup_failure' : 'preflight_refused';
    this.completeWithoutEngine(st, 'failed', exitReason, failure);
  }

  private async doFinalize(st: PersistedRunState): Promise<RunResult> {
    await this.fireFault('finalization', st.runId);
    if (st.pgid && !isProcessAlive(st.pid) && isProcessGroupAlive(st.pgid)) {
      killProcessGroup(st.pgid, 'SIGKILL');
      await waitForProcessDeath(st.pgid, null, 500);
    }
    const exportManifest = await this.runExport(st);
    const result = this.computeResult(st, exportManifest);
    await this.appendProfileTrace(st, result);
    this.persistResult(st, result);
    return result;
  }

  private exportSnapshot(runId: string): RunExportSnapshot | null {
    const manifest = this.exportManifest(runId);
    if (!manifest) return null;
    return {
      version: manifest.version,
      attempts: manifest.attempts,
      status: manifest.status,
      partial: manifest.partial,
      planned: manifest.totals.planned,
      exported: manifest.totals.exported,
      failed: manifest.totals.failed,
      cleanup: manifest.cleanup.decision,
      retained: [...manifest.cleanup.retained],
    };
  }

  /**
   * Стадия экспорта артефактов — отдельно от исполнения движка.
   *
   * Инварианты (P07 / AC-76):
   *  - движок здесь не запускается ни при краше, ни при рестарте, ни при повторном commit;
   *  - каждый выход сначала уезжает в object storage и проверяется чтением, и только потом
   *    его локальная копия может быть удалена;
   *  - сбой экспорта объявляется частичным манифестом, а не молчанием;
   *  - прогресс и решение по очистке видны клиенту (события + манифест).
   */
  private async runExport(st: PersistedRunState, options: { force?: boolean } = {}): Promise<RunExportManifest | null> {
    const exports = this.opts.exports;
    if (!exports) return null;
    const plan: PlannedOutput[] = (st.spec.outputs ?? []).map((output) => ({
      path: output.path,
      ...(output.name !== undefined ? { name: output.name } : {}),
      ...(output.mime !== undefined ? { mime: output.mime } : {}),
    }));
    if (plan.length === 0 && !options.force) return null;

    const previous = exports.read(st.runId);
    if (previous && previous.status === 'complete' && !options.force) return previous;

    const ctx = {
      runId: st.runId,
      userTaskId: st.userTaskId,
      profileId: st.profileId,
      ownerGeneration: st.ownerGeneration,
    };
    // начало попытки фиксируется на диске до загрузки байтов: рестарт видит in_progress
    const draft = exports.begin(ctx, plan);

    if (plan.length > 0) {
      await this.fireFault('export', st.runId);
      for (const [index, output] of plan.entries()) {
        await this.exportOne(ctx, output, index, st.spec.cwd);
      }
    }

    const committed = await exports.commit(ctx, { cwd: st.spec.cwd });
    this.emit(st, 'export_committed', {
      version: committed.version,
      status: committed.status,
      planned: committed.totals.planned,
      exported: committed.totals.exported,
      failed: committed.totals.failed,
      cleanup: committed.cleanup.decision,
      retained: committed.cleanup.retained.length,
    });
    return committed;
  }

  private async exportOne(
    ctx: { runId: string; userTaskId: string; profileId: string; ownerGeneration: number },
    output: PlannedOutput,
    index: number,
    cwd: string,
  ): Promise<void> {
    const exports = this.opts.exports;
    if (!exports) return;
    const st = this.runs.get(ctx.runId)?.state;
    const field = `spec.outputs[${index}].path`;
    try {
      // граница workspace: абсолютный путь, ".." и symlink наружу отвергаются
      const absolute = resolveExistingInsideRoot(cwd, output.path, field);
      if (!isRegularFile(absolute)) {
        const reason = 'declared output is not a regular file in the workspace';
        const progress = exports.recordMissing(ctx, output.path, reason);
        this.emitExportFailed(ctx, output.path, reason, progress.version);
        return;
      }
      const bytes = await readFile(absolute);
      const name = output.name ?? artifactNameFor(output.path);
      const manifest = await exports.artifacts.put({
        runId: ctx.runId,
        userTaskId: ctx.userTaskId,
        profileId: ctx.profileId,
        name,
        mime: output.mime ?? mimeForName(name),
        bytes,
      });
      const progress = exports.recordExported(ctx, output.path, manifest);
      if (st) {
        this.emit(st, 'artifact_exported', {
          artifactId: manifest.artifactId,
          sourcePath: output.path,
          size: manifest.size,
          sha256: manifest.sha256,
          mime: manifest.mime,
          version: progress.version,
        });
      }
    } catch (err) {
      const reason = truncateLine(redactSecrets(err instanceof Error ? err.message : String(err)), 300);
      const message = `${err instanceof Error && err.name ? err.name : 'Error'}: ${reason}`;
      const progress = exports.recordFailure(ctx, output.path, message);
      this.emitExportFailed(ctx, output.path, message, progress.version);
    }
  }

  private emitExportFailed(
    ctx: { runId: string },
    sourcePath: string,
    reason: string,
    version: number,
  ): void {
    const st = this.runs.get(ctx.runId)?.state;
    if (!st) return;
    this.emit(st, 'export_failed', { sourcePath, reason, version });
  }

  /**
   * След задачи в профильном хранилище (profiles/<profileId>/trace.jsonl).
   * Ошибка записи НЕ валит ран: это вспомогательная запись — деградация фиксируется
   * warn-событием `log` в журнале задачи, чтобы не молчала (issue #23, кейс E1).
   */
  private async appendProfileTrace(st: PersistedRunState, result: RunResult): Promise<void> {
    const blob = this.opts.blob;
    if (!blob || this.opts.profileTrace === false) return;
    let key: string;
    try {
      key = profileKey(st.profileId, 'trace.jsonl');
    } catch {
      // идентификатор профиля — не безопасный сегмент ключа: записи не будет
      return;
    }
    const line = JSON.stringify({
      at: this.nowIso(),
      runId: st.runId,
      userTaskId: st.userTaskId,
      profileId: st.profileId,
      outcome: result.outcome,
      exitReason: result.exitReason,
      failureCode: result.failure?.code ?? null,
    });
    let failure: unknown = null;
    const append = async (): Promise<void> => {
      let existing = '';
      try {
        existing = (await blob.get(key)).toString('utf8');
      } catch {
        // первого следа ещё нет
      }
      const prefix = existing === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
      await blob.put(key, `${prefix}${line}\n`);
    };
    const next = this.profileTraceChain.then(() => append()).then(
      () => undefined,
      (err: unknown) => {
        failure = err;
      },
    );
    this.profileTraceChain = next;
    await next;
    if (failure) {
      const message = truncateLine(redactSecrets(failure instanceof Error ? failure.message : String(failure)), 300);
      try {
        this.emit(st, 'log', { stream: 'runner', level: 'warn', message: `profile trace append failed: ${message}` });
      } catch {
        // не роняем финализацию из-за вспомогательной записи
      }
    }
  }

  private computeResult(st: PersistedRunState, exportManifest: RunExportManifest | null = null): RunResult {
    let exitReason: RunResult['exitReason'];
    let failure: RunResult['failure'] | undefined;

    if (st.workerCrashed) {
      exitReason = 'worker_crash';
      failure = {
        code: 'WORKER_CRASH',
        failureClass: 'runtime',
        safeSummary: 'worker restarted while the run was active; execution outcome recorded as lost without a hidden rerun',
        retryable: true,
      };
    } else if (st.cancelRequested === 'timeout') {
      exitReason = 'timeout';
      failure = { code: 'TIMEOUT', failureClass: 'runtime', safeSummary: 'engine exceeded the run timeout', retryable: true };
    } else if (st.cancelRequested === 'cancel') {
      exitReason = 'cancelled';
    } else if (st.exit && st.exit.observed && st.exit.signal) {
      exitReason = 'crash';
      failure = {
        code: 'ENGINE_CRASH',
        failureClass: 'engine',
        safeSummary: `engine process terminated by signal ${st.exit.signal}`,
        retryable: true,
      };
    } else if (st.exit && st.exit.observed && st.exit.code === 0) {
      exitReason = 'completed';
    } else if (st.exit && st.exit.observed) {
      exitReason = 'nonzero_exit';
      failure = {
        code: 'ENGINE_NONZERO_EXIT',
        failureClass: 'engine',
        safeSummary: `engine process exited with code ${String(st.exit.code)}`,
        retryable: false,
      };
    } else {
      exitReason = 'crash';
      failure = { code: 'UNKNOWN_EXIT', failureClass: 'runtime', safeSummary: 'engine exit was not observed', retryable: true };
    }

    const outcome: RunResult['outcome'] = exitReason === 'completed' ? 'succeeded' : exitReason === 'cancelled' ? 'cancelled' : 'failed';
    const groupGone = !isProcessAlive(st.pid) && !isProcessGroupAlive(st.pgid);
    const outputRefs = (exportManifest?.entries ?? [])
      .filter((entry) => entry.status === 'exported' && entry.artifactId !== null)
      .map((entry) => entry.artifactId as string);

    const result: RunResult = {
      schemaVersion: 1,
      runId: st.runId,
      jobId: st.jobId,
      userTaskId: st.userTaskId,
      profileId: st.profileId,
      ownerGeneration: st.ownerGeneration,
      outcome,
      exitReason,
      exitCode: st.exit?.code ?? null,
      exitSignal: st.exit?.signal ?? null,
      exitObserved: st.exit?.observed ?? false,
      startedAt: st.startedAt ?? st.createdAt,
      finishedAt: this.nowIso(),
      usage: { status: 'unknown' },
      outputRefs,
      persistence: 'persisted',
      cleanup: this.cleanupStatus(groupGone, exportManifest),
      logPath: this.store.relLogPath(st.runId),
    };
    if (failure) result.failure = failure;
    return result;
  }

  /**
   * `cleanup: completed` означает «локальных копий, за которые мы отвечаем, не осталось».
   * Если экспорт оставил единственную копию на диске, очистка не выдаёт себя за завершённую.
   */
  private cleanupStatus(groupGone: boolean, exportManifest: RunExportManifest | null): RunResult['cleanup'] {
    if (!groupGone) return 'pending';
    if (exportManifest && exportManifest.cleanup.decision === 'retained_sole_copy') return 'pending';
    return 'completed';
  }

  private persistResult(st: PersistedRunState, result: RunResult): void {
    if (st.finalized) return;
    st.result = result;
    this.store.saveResult(st.runId, result);
    st.finalized = true;
    if (!this.transition(st, result.outcome)) {
      throw new Error(`cannot move run ${st.runId} from ${st.state} to ${result.outcome}`);
    }
    this.emit(st, result.outcome, terminalPayloadForResult(result));
    const run = this.runs.get(st.runId);
    if (run) {
      this.clearTimers(run);
      const waiters = run.waiters.splice(0);
      for (const waiter of waiters) waiter(result);
    }
  }
}
