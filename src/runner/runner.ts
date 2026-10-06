import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import { InputMaterializer, type MaterializeReceipt } from '../storage/input-materializer.js';
import { materializeIngressManifest, type IngressArtifactResolver } from '../storage/ingress-artifact.js';
import { artifactNameFor, mimeForName } from '../storage/export-manifest.js';
import type { RunExportManifest } from '../storage/export-manifest.js';
import { isRegularFile, resolveExistingInsideRoot } from '../storage/local-paths.js';
import { profileKey } from '../storage/keys.js';
import { redactSecrets, specHash, truncateLine, writeFileAtomic } from './util.js';
import {
  AGENT_MANIFEST_PATH,
  mergeOutputPlan,
  readAgentAnswer,
  readAgentFinalManifest,
  type AgentFinalManifest,
} from './agent-manifest.js';
import { ANSWER_MAX_CHARS, type CheckpointPersistence, type RunCheckpoint } from './checkpoint.js';
import { CleanRoomError, type CleanRoom, type CleanRoomLease, type CleanRoomProvider, type RunIdentity } from '../isolation/contract.js';
import { materializeEngineConfig, type EngineConfigTemplate } from '../isolation/engine-config.js';
import type { CapabilityRegistry } from '../mcp/capabilities.js';
import { bridgeSocketPath, newBridgeToken } from '../mcp/bridge.js';
import { McpRunSession, McpStartupError, type EngineMcpConfig, type McpLogFields, type McpLogLevel } from '../mcp/session.js';
import { McpRunScope, McpScopeError, type BindingValueResolver } from '../mcp/scope.js';


export interface RunnerHostInfo {
  region?: string;
  environment?: string;
  release?: string;
  workerId?: string;
  /**
   * Движки, разрешённые в регионе этого воркера политикой размещения (P30). Повторная
   * проверка на стороне Runner'а: admission решает по политике, но запускает движок именно
   * Runner, и он обязан отказать сам, а не доверять вызывающему.
   */
  allowedEngines?: string[];
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
   * Оставлять каталоги ранов после финализации (диагностика/отладка). По умолчанию
   * каталоги снимаются вместе с идентичностью рана, а `cleanup: completed` означает
   * проверенное отсутствие этих каталогов (issue #52). С этим флагом уборка честно
   * остаётся `pending`: каталоги на месте.
   */
  retainWorkspaces?: boolean;
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
  /**
   * Материализация входов из снимков workspace (issue #52, шаг 1). Байты берутся из
   * долговечного хранилища по указателю снимка и кладутся в workspace нового рана с
   * проверкой владельца (profileId рана) и дайджеста при записи. Отказ любого ref'а
   * останавливает материализацию целиком: в workspace не остаётся ни одного байта входа,
   * а ран получает отказ с причиной и признаком повторяемости.
   */
  inputs?: InputMaterializer;
  /** Private task-scoped Control Plane resolver. Credentials belong to deployment config only. */
  ingressResolver?: IngressArtifactResolver;
  /**
   * Реестр capability handler'ов хоста (P13). Один и тот же реестр обслуживает вызовы MCP
   * ран'а и внутренний API control plane — бизнес-логика домена не дублируется в транспортах.
   */
  capabilities?: CapabilityRegistry;
  /**
   * Граница Agent clean room (issue #51): per-run Unix-идентичность, run-scoped HOME/config/
   * cache/tmp и минимальный env/credential binding. Без провайдера движок идёт под
   * service UID — это честно объявляется в capabilities, но не является доказанной границей.
   * Отказ границы (нет привилегий, нет слотов, проба не прошла) валит старт ДО спавна:
   * fallback к service UID запрещён.
   */
  isolation?: CleanRoomProvider;
  /**
   * Хостовые шаблоны конфигурации движка (`AGENT_API_ENGINE_CONFIG_DIR`): один файл на
   * движок, копия кладётся в run-scoped XDG_CONFIG_HOME. Нужно потому, что своя HOME
   * рана убирает у движка конфиг пользователя сервиса, а без provider/model он уходит
   * на платный профиль по умолчанию. Секретов в шаблонах нет и быть не может.
   */
  engineConfigTemplates?: EngineConfigTemplate | null;
  /**
   * Резолвер значений credential binding'ов (P13). В песочнице — фикстура, в бою —
   * Credential Broker / Secret Manager. Значение binding'а не попадает в spec/state/events.
   */
  bindingResolver?: BindingValueResolver;
  /** Команда broker'а MCP для движка; по умолчанию — per-run прокси из репозитория. */
  mcpBrokerCommand?: { command: string; args: string[] };
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
  /** Живые per-run MCP-процессы (P13): null, если сессия MCP не поднималась или погашена. */
  mcp: { serverPids: Array<{ serverId: string; pid: number }> } | null;
  /** Граница рана (issue #51): null, если граница не настроена или не поднималась. */
  isolation: {
    slotId: string;
    username: string;
    uid: number;
    gid: number;
    root: string;
    status: CleanRoomLease['status'];
  } | null;
  /** Обязательный checkpoint lifecycle (issue #52): null, если ещё не записан. */
  checkpoint: RunCheckpoint | null;
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
  /** Per-run MCP-процессы, погашенные после рестарта воркера (P13). */
  orphanedMcp: number;
  /** Аренды чистых сред, дочищенные после рестарта воркера (issue #51). */
  cleanRoomsReconciled: number;
  /** Checkpoint'ы, достроенные после рестарта для терминальных ранов (issue #52). */
  checkpointsRebuilt: number;
  /** Уборки, доведённые до конца при восстановлении: persist/sweep без движка (issue #52). */
  cleanupsResumed: number;
  /**
   * Уборки, которые восстановление не смогло довести (отказ хранилища, занятый каталог).
   * Ран остаётся с записанным намерением уборки и будет дожат следующим recover(); сам
   * факт отказа считается, чтобы «уборка не завершена» не выглядела как «уборки не было».
   */
  cleanupResumesFailed: number;
}

interface InternalRun {
  state: PersistedRunState;
  events: RunnerEvent[];
  waiters: Array<(result: RunResult) => void>;
  handle: EngineHandle | null;
  timers: NodeJS.Timeout[];
  exitReceived: boolean;
  finalizePromise: Promise<RunResult> | null;
  /** Per-run сессия MCP (P13): bridge + stdio-серверы; гасится вместе с раном. */
  mcp: McpRunSession | null;
  mcpCleanup: Promise<void> | null;
  /** Путь к per-run конфигу MCP для движка (секретов не содержит). */
  mcpConfigPath: string | null;
  /** Чистая среда рана (issue #51): идентичность, каталоги, статус аренды. */
  room: CleanRoom | null;
  /**
   * Хвост stdout движка (issue #52): если агент не оставил `answerFile`, текстом ответа
   * считается то, что движок напечатало последним. Накопитель ограничен, в журнал рана
   * содержимое не попадает — только источник и размер.
   */
  answerTail: string[];
}

/**
 * Проверенный результат уборки среды рана (issue #52, шаг 4/5). `completed` означает, что
 * каталоги рана и его сокет сняты, а идентичность освобождена — не то, что процессы умерли.
 */
export interface CleanupOutcome {
  status: 'completed' | 'pending' | 'failed';
  reason: string;
  removed: string[];
}

/** Итог определения выхода рана: план экспорта и текст ответа. */
interface ExitResolution {
  plan: PlannedOutput[];
  answer: { present: boolean; source: 'agent_file' | 'engine_stdout' | null; chars: number; text: string };
}

/** Потолок накопителя ответа: хвост, а не архив вывода движка. */
const ANSWER_TAIL_MAX_LINES = 200;
const ANSWER_TAIL_MAX_LINE = 2000;

/** Receipt входа без материализации: ран объявляет ноль, а не молчит о ref'ах без снимка. */
function emptyInputReceipt(st: PersistedRunState, declared: number) {
  return {
    status: 'nothing_to_materialize' as const,
    declared,
    requested: 0,
    files: 0,
    bytes: 0,
    entries: [],
    reason: null,
  };
}

/** Receipt входа в форму события: пути и размеры остаются, содержимое и имена файлов — нет. */
function inputReceiptPayload(receipt: MaterializeReceipt) {
  return {
    status: receipt.status,
    declared: receipt.declared,
    requested: receipt.requested,
    files: receipt.files,
    bytes: receipt.bytes,
    entries: receipt.entries.map((entry) => ({
      ref: entry.ref,
      snapshotId: entry.snapshotId,
      status: entry.status,
      code: entry.code,
      files: entry.files,
      bytes: entry.bytes,
      reason: entry.reason === null ? null : truncateLine(redactSecrets(entry.reason), 500),
    })),
    reason: receipt.reason === null ? null : truncateLine(redactSecrets(receipt.reason), 500),
  };
}


const DEFAULT_CANCEL_GRACE_MS = 1000;
const DEFAULT_MAX_LOG_LINE = 4096;
/** Каталог и переменная окружения per-run конфигу MCP (P13). */
const MCP_CONFIG_DIR = '.runner';
const MCP_CONFIG_ENV = 'RUNNER_MCP_CONFIG';

/** Плоские поля MCP-события в текст лога рана: `mcp.<event> key=value ...`. */
/** UID процесса по /proc/<pid>/status; null, если прочитать нельзя (процесс умер или нет прав). */
function readProcUid(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const line = status.split('\n').find((entry) => entry.startsWith('Uid:'));
    if (!line) return null;
    const uid = Number(line.slice('Uid:'.length).trim().split(/\s+/)[0]);
    return Number.isInteger(uid) ? uid : null;
  } catch {
    return null;
  }
}

/** Окно, в течение которого процесс движка обязан сменить идентичность на слот. */
const IDENTITY_SETTLE_TIMEOUT_MS = 3000;
const IDENTITY_SETTLE_POLL_MS = 25;

/** Сколько ждём смерти осиротевшего процесса движка при дочистке после рестарта воркера. */
const ORPHAN_TERM_TIMEOUT_MS = 5000;

type IdentitySettle =
  | { kind: 'matched'; uid: number; waitedMs: number }
  | { kind: 'mismatch'; uid: number; waitedMs: number }
  | { kind: 'gone'; uid: null; waitedMs: number };

/**
 * Ожидание смены идентичности процесса движка.
 *
 * Между `spawn` и `setuid` есть окно, в котором `/proc/<pid>/status` ещё показывает UID
 * родителя: переключатель (setpriv/runuser) сначала стартует сам, и только потом снимает
 * права. Одноразовое чтение давало ложный `identity_mismatch` на живом и правильном ране.
 * Поэтому сверка идёт с ограниченным ожиданием: UID совпал, процесс ушёл (успеет
 * отработать его собственный обработчик выхода) либо окно истекло — тогда расхождение
 * настоящее, и ран отказывает.
 */
async function settleEngineIdentity(room: CleanRoom, pid: number): Promise<IdentitySettle> {
  const deadline = Date.now() + IDENTITY_SETTLE_TIMEOUT_MS;
  let waitedMs = 0;
  let uid = readProcUid(pid);
  while (uid !== null && uid !== room.identity.uid && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, IDENTITY_SETTLE_POLL_MS));
    waitedMs += IDENTITY_SETTLE_POLL_MS;
    uid = readProcUid(pid);
  }
  if (uid === null) return { kind: 'gone', uid: null, waitedMs };
  return { kind: uid === room.identity.uid ? 'matched' : 'mismatch', uid, waitedMs };
}

function formatMcpFields(fields: McpLogFields): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value === null ? '-' : String(value)}`)
    .join(' ');
}

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
      const events = this.store.readEvents(runId);
      // state.json мог отстать от журнала (kill -9 между append и saveState): счётчик
      // обязан опираться на журнал, иначе следующее событие получило бы уже занятую
      // версию и в replay появилась бы дубликат.
      const lastSequence = events.length > 0 ? events[events.length - 1]!.sequence : 0;
      if (lastSequence > state.sequence) {
        state.sequence = lastSequence;
        this.store.saveState(state);
      }
      this.runs.set(runId, {
        state,
        events,
        waiters: [],
        handle: null,
        timers: [],
        exitReceived: Boolean(state.exit?.observed),
        finalizePromise: null,
        mcp: null,
        mcpCleanup: null,
        mcpConfigPath: null,
        room: null,
        answerTail: [],
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
      mcp:
        st.mcp && st.mcp.serverPids.length > 0
          ? { serverPids: st.mcp.serverPids.map((entry) => ({ serverId: entry.serverId, pid: entry.pid })) }
          : null,
      checkpoint: this.store.readCheckpoint(st.runId),
      isolation: st.cleanRoom
        ? {
            slotId: st.cleanRoom.identity.slotId,
            username: st.cleanRoom.identity.username,
            uid: st.cleanRoom.identity.uid,
            gid: st.cleanRoom.identity.gid,
            root: st.cleanRoom.paths.root,
            status: st.cleanRoom.status,
          }
        : null,
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
      mcp: null,
      cleanRoom: null,
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
      mcp: null,
      mcpCleanup: null,
      mcpConfigPath: null,
      room: null,
      answerTail: [],
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
    await this.stopMcpSession(run, 'cancel');

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
    if (st.finalized && st.result && !['pending', 'failed'].includes(st.result.persistence)) return st.result;
    if (run.finalizePromise) return run.finalizePromise;
    const promise = this.doFinalize(st).finally(() => {
      run.finalizePromise = null;
      const exportManifest = this.exportManifest(runId);
      if (st.finalized && st.result?.persistence === 'pending' && (exportManifest?.attempts ?? 0) < 8) {
        const delayMs = Math.min(60_000, 2_000 * 2 ** Math.min(exportManifest?.attempts ?? 0, 5));
        const timer = setTimeout(() => { void this.finalize(runId).catch(() => undefined); }, delayMs);
        run.timers.push(timer);
      } else if (st.finalized && st.result?.persistence === 'pending' && (exportManifest?.attempts ?? 0) >= 8) {
        const attention: RunResult = { ...st.result, persistence: 'failed',
          persistenceReason: 'bounded persistence retries exhausted; source copies were retained for operator replay',
          cleanup: 'pending', cleanupReason: 'cleanup is blocked until remote custody is verified' };
        this.updateTerminalResult(st, attention);
        this.writeCheckpoint(st, attention, exportManifest, null, null, 'cleanup_pending', {
          status: 'blocked', reason: 'persistence retries exhausted; source copies retained', intentAt: this.nowIso(), finishedAt: null,
        }, { silent: true });
      }
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
    const report: RecoveryReport = { scanned: 0, resumedQueued: 0, orphaned: 0, lost: 0, finalizingResumed: 0, terminal: 0, exportRetried: 0, orphanedMcp: 0, cleanRoomsReconciled: 0, checkpointsRebuilt: 0, cleanupsResumed: 0, cleanupResumesFailed: 0 };
    await this.fireFault('recovery');
    for (const run of [...this.runs.values()]) {
      if (this.disposed) break;
      const st = run.state;
      report.scanned += 1;
      if (isTerminalState(st.state)) {
        report.terminal += 1;
        // Checkpoint обязан существовать для терминального рана: восстановление читает
        // его, чтобы повторить persist/sweep без запуска движка.
        if (this.ensureCheckpoint(run)) report.checkpointsRebuilt += 1;
        if (await this.reconcileCleanRoom(run)) report.cleanRoomsReconciled += 1;
        // Движок уже отработал: незавершённые persist/sweep дожимаются здесь, без rerun.
        //
        // Отказ одного рана не имеет права уронить восстановление целиком: иначе один
        // застрявший каталог не дал бы API подняться и обслуживать остальные раны. Ран
        // остаётся в состоянии «уборка не доведена» и будет дожат следующим recover().
        try {
          if (await this.resumeCleanup(run)) report.cleanupsResumed += 1;
        } catch (error) {
          report.cleanupResumesFailed += 1;
          const detail = error instanceof Error ? error.message : String(error);
          try {
            this.emit(st, 'log', {
              stream: 'runner',
              level: 'error',
              message: `lifecycle.resume_failed runId=${st.runId} detail=${truncateLine(redactSecrets(detail), 300)}`,
            });
            } catch {
            // даже падение самой записи в журнал не имеет права уронить восстановление
          }
        }
        continue;
      }
      switch (st.state) {
        case 'queued':
          report.resumedQueued += 1;
          void this.execute(st.runId).catch(() => undefined);
          break;
        case 'starting':
          report.orphanedMcp += await this.reapOrphanedMcp(run);
          if (st.pid && isProcessAlive(st.pid)) {
            await this.markOrphaned(run, report);
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
          report.orphanedMcp += await this.reapOrphanedMcp(run);
          if (run.handle) break;
          if (st.pid && isProcessAlive(st.pid)) {
            await this.markOrphaned(run, report);
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
      // dispose() синхронный: MCP-процессы рана гасим без ожидания, финализация их не требует
      void run.mcp?.dispose('runner_dispose');
      run.mcp = null;
      run.mcpConfigPath = null;
    }
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  /**
   * Рестарт воркера не гасит per-run процессы MCP сам (они в собственной группе), поэтому
   * recover() дочищает их по pid из state.json. Молча оставлять их работать нельзя: они
   * держат локальный сокет моста и учётные данные в окружении.
   */
  private async reapOrphanedMcp(run: InternalRun): Promise<number> {
    const st = run.state;
    const pids = st.mcp?.serverPids ?? [];
    if (pids.length === 0) return 0;
    let reaped = 0;
    for (const entry of pids) {
      if (!isProcessAlive(entry.pid)) continue;
      killProcessTree(entry.pid, entry.pid, 'SIGTERM');
      const dead = await waitForProcessDeath(entry.pid, entry.pid, 300);
      if (!dead) killProcessTree(entry.pid, entry.pid, 'SIGKILL');
      reaped += 1;
    }
    st.mcp = null;
    this.store.saveState(st);
    if (!isTerminalState(st.state)) {
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'warn',
        message: `mcp.orphan_reaped servers=${pids.length} reaped=${reaped} reason=worker_restart`,
      });
    }
    return reaped;
  }

  /**
 * Ран, чей процесс движка пережил рестарт воркера.
 *
 * Без аренды идентичности поведение прежнее: ран помечается осиротевшим, наблюдение
 * теряется, повторного запуска нет, клиент может отменить ран.
 *
 * С арендой идентичности граница обязана быть ограничена во времени, а после рестарта ни
 * таймер рана, ни наблюдатель выхода уже не работают: переживший воркер процесс ждал бы
 * завершения вечно, удерживая слот и каталоги рана — то есть одна авария воркера навсегда
 * отнимала бы слот из пула. Поэтому процесс гасится, ран дочищается (persist + sweep) и
 * слот возвращается в пул. Повторного запуска движка при этом нет: результат
 * финализируется по факту смерти процесса, а не переигрыванием рана.
 */
private async markOrphaned(run: InternalRun, report: RecoveryReport): Promise<void> {
    const st = run.state;
    st.connectionLost = true;
    st.orphanedPid = st.pid;
    this.store.saveState(st);
    report.orphaned += 1;
    const holdsIdentity = run.room !== null || st.cleanRoom !== null;
    if (!holdsIdentity) {
      if (!isTerminalState(st.state)) {
        this.emit(st, 'connection_lost', {
          detectedAt: this.nowIso(),
          detail: 'engine process survived a worker restart; supervision is lost, no automatic rerun',
          engineAlive: true,
        });
      }
      return;
    }
    const pid = st.pid;
    const pgid = st.pgid;
    const slotId = st.cleanRoom?.identity?.slotId ?? run.room?.identity.slotId ?? null;
    killProcessTree(pgid, pid, 'SIGKILL');
    const gone = await waitForProcessDeath(pgid, pid, ORPHAN_TERM_TIMEOUT_MS);
    this.emit(st, 'log', {
      stream: 'runner',
      level: 'warn',
      message: `clean_room.orphan_terminated runId=${st.runId} pid=${String(pid)} slot=${String(slotId)} gone=${String(gone)} reason=engine_survived_worker_restart`,
    });
    st.workerCrashed = true;
    // `running` не переходит сразу в терминальное состояние: сначала finalizing, как и при
    // штатном выходе движка, иначе ран остался бы навсегда в running без наблюдателя.
    if (this.transition(st, 'finalizing')) {
      this.emit(st, 'finalizing', { reason: 'worker_crash' });
    }
    this.completeWithoutEngine(st, 'failed', 'worker_crash', {
      code: 'WORKER_CRASH',
      failureClass: 'runtime',
      safeSummary: 'the engine process survived a worker restart under a leased run identity and was terminated during recovery; the run was not re-executed',
      retryable: true,
    });
    if (await this.reconcileCleanRoom(run)) report.cleanRoomsReconciled += 1;
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
    // Журнал событий ДО state.json: иначе kill -9 между двумя записями оставлял бы
    // state.sequence впереди журнала, и после рестарта в replay навсегда оставалась бы
    // дыра в нумерации (счётчик продолжил бы с версии из state, а события той версии
    // в файле уже нет). Порядок «сначала журнал, потом state» даёт обратное окно —
    // state может отстать, но не перегнать журнал; счётчик на старте сверяется с журналом.
    this.eventLog.append(this.store.logPath(st.runId), event);
    st.sequence = event.sequence;
    st.updatedAt = this.nowIso();
    this.store.saveState(st);
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
    let phase: 'preflight' | 'isolation' | 'mcp' | 'spawn' = 'preflight';
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
      // P51: граница поднимается ДО MCP и движка. Отказ здесь валит старт рана, а
      // не «тихо» запускает движок под service UID.
      if (this.opts.isolation || st.spec.isolation?.mode === 'per_run_unix_identity') {
        phase = 'isolation';
        await this.fireFault('isolation', runId);
        if (this.disposed) return;
        await this.prepareCleanRoom(run, st);
        if (this.disposed) return;
        if (st.cancelRequested) {
          await this.releaseCleanRoom(run, 'cancelled');
          this.completeWithoutEngine(st, 'cancelled', 'cancelled');
          return;
        }
      }
      const adapter = this.opts.adapters[st.spec.engine.name];
      if (!adapter) throw new PreflightError('ENGINE_UNSUPPORTED', `engine "${st.spec.engine.name}" is not registered on this worker`);
      // P13: MCP-серверы рана поднимаются ДО движка — к моменту старта engine client
      // должен иметь готовый локальный proxy. Отказ здесь валит старт, а не «тихий» ран.
      if ((st.spec.mcp?.servers.length ?? 0) > 0) {
        phase = 'mcp';
        await this.fireFault('mcp', runId);
        if (this.disposed) return;
        await this.startMcpSession(run, st);
        if (this.disposed) {
          await this.stopMcpSession(run, 'worker_disposed');
          return;
        }
        if (st.cancelRequested) {
          await this.stopMcpSession(run, 'cancelled');
          this.completeWithoutEngine(st, 'cancelled', 'cancelled');
          return;
        }
      }
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
        env: this.buildEngineEnv(run, st.spec),
        ...(run.room
          ? {
              identity: run.room.identity,
              ...(this.opts.isolation?.launcher ? { launcher: this.opts.isolation.launcher } : {}),
            }
          : {}),
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
      if (run.room) await this.assertEngineIdentity(run, st, handle.pid);
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
    // Ран, запросивший границу, на хосте без провайдера отказывается: запуск под
    // service UID был бы расширением прав относительно запроса.
    if (spec.isolation?.mode === 'per_run_unix_identity' && !this.opts.isolation) {
      throw new PreflightError(
        'ISOLATION_UNAVAILABLE',
        'run requests per_run_unix_identity but this host has no clean room isolation provider configured',
      );
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
    const allowedEngines = this.opts.host?.allowedEngines;
    if (allowedEngines && !allowedEngines.includes(spec.engine.name)) {
      throw new PreflightError(
        'REGION_FORBIDDEN',
        `engine "${spec.engine.name}" is not allowed in host region "${this.opts.host?.region ?? 'unknown'}" by the placement policy`,
      );
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
    await this.materializeInputs(st);
    this.emit(st, 'materialized', { inputs: (st.spec.input?.refs?.length ?? 0) + (st.spec.ingressManifest ? 1 : 0) });
  }

  /**
   * Входы рана из снимков предыдущих ранов (issue #52, шаг 1). Проверки идут ДО движка:
   * подтверждённого входа, чужого снимка или битых байт рану быть нельзя.
   *
   * Отказ не роняет воркер: `refused`/`unavailable` превращаются в отказ старта с кодом и
   * признаком повторяемости, а причина идёт и в журнал рана, и в событие входов. Без
   * настроенного materializer'а (нет хранилища снимков) refs со снимком отказаны честно,
   * а не пропущены молча.
   */
  private async materializeInputs(st: PersistedRunState): Promise<void> {
    const refs = st.spec.input?.refs ?? [];
    const materializer = this.opts.inputs;
    const ingress = st.spec.ingressManifest;
    if (ingress) {
      if (refs.length > 0) throw new PreflightError('INGRESS_INPUT_INVALID', 'ingress manifests cannot be combined with workspace snapshots');
      if (!this.opts.ingressResolver) {
        const reason = 'run requests a task-scoped ingress manifest, but this worker has no Control Plane resolver configured';
        this.emit(st, 'inputs_materialized', { status: 'refused', declared: 1, requested: 1, files: 0, bytes: 0, entries: [], reason });
        throw new PreflightError('INGRESS_INPUT_INVALID', reason, { retryable: false });
      }
      try {
        const receipt = await materializeIngressManifest(this.opts.ingressResolver, ingress, {
          runId: st.runId,
          userTaskId: st.userTaskId,
          profileId: st.profileId,
          ownerGeneration: st.ownerGeneration,
          cwd: st.spec.cwd,
        });
        this.emit(st, 'inputs_materialized', {
          status: 'materialized', declared: receipt.artifactCount, requested: receipt.artifactCount,
          files: receipt.files, bytes: receipt.bytes,
          entries: receipt.artifacts.map((artifact) => ({ ref: artifact.ref, status: 'materialized' as const, code: null, files: 1, bytes: artifact.bytes, reason: null })), reason: null,
        });
        this.emit(st, 'log', {
          stream: 'runner', level: 'info',
          message: `inputs.ingress_materialized runId=${st.runId} artifacts=${receipt.artifactCount} files=${receipt.files} bytes=${receipt.bytes}`,
        });
        return;
      } catch (error) {
        const code = error instanceof PreflightError ? error.code : 'INGRESS_INPUT_UNAVAILABLE';
        const retryable = error instanceof PreflightError ? error.retryable : true;
        const reason = error instanceof Error ? error.message : 'Control Plane ingress materialization failed';
        const status = retryable ? 'unavailable' : 'refused';
        this.emit(st, 'inputs_materialized', { status, declared: 1, requested: 1, files: 0, bytes: 0, entries: [], reason });
        this.emit(st, 'log', {
          stream: 'runner', level: 'error',
          message: `inputs.ingress_${status} runId=${st.runId} code=${code} retryable=${retryable} reason=${truncateLine(redactSecrets(reason), 300)}`,
        });
        throw error instanceof PreflightError ? error : new PreflightError(code, reason, { retryable });
      }
    }
    const unresolved = refs.filter((ref) => ref.snapshotId === undefined);
    if (unresolved.length > 0) {
      const reason = `run ${st.runId} requests input refs that this worker cannot resolve: [${unresolved.map((ref) => ref.ref).join(', ')}]`;
      this.emit(st, 'inputs_materialized', {
        status: 'refused',
        declared: refs.length,
        requested: refs.length,
        files: 0,
        bytes: 0,
        entries: unresolved.map((ref) => ({
          ref: ref.ref,
          status: 'refused',
          code: 'MATERIALIZE_REF_INVALID',
          files: 0,
          bytes: 0,
          reason,
        })),
        reason,
      });
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'error',
        message: `inputs.materialize_refused runId=${st.runId} status=refused retryable=false reason=${truncateLine(redactSecrets(reason), 300)}`,
      });
      throw new PreflightError('MATERIALIZE_REF_INVALID', reason, { retryable: false });
    }
    if (refs.length === 0) {
      if (materializer) {
        this.emit(st, 'inputs_materialized', emptyInputReceipt(st, refs.length));
      }
      return;
    }
    if (!materializer) {
      const wanted = refs.filter((ref) => ref.snapshotId !== undefined);
      const reason = `run ${st.runId} requests snapshot inputs [${wanted.map((ref) => ref.snapshotId).join(', ')}], but this worker has no snapshot materializer configured`;
      this.emit(st, 'inputs_materialized', {
        status: 'refused',
        declared: refs.length,
        requested: wanted.length,
        files: 0,
        bytes: 0,
        entries: wanted.map((ref) => ({
          ref: ref.ref,
          snapshotId: ref.snapshotId as string,
          status: 'refused',
          code: 'MATERIALIZE_REF_INVALID',
          files: 0,
          bytes: 0,
          reason,
        })),
        reason,
      });
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'error',
        message: `inputs.materialize_refused runId=${st.runId} status=refused retryable=false reason=${truncateLine(redactSecrets(reason), 300)}`,
      });
      throw new PreflightError('MATERIALIZE_REF_INVALID', reason, { retryable: false });
    }

    const receipt = await materializer.materialize(refs, {
      runId: st.runId,
      profileId: st.profileId,
      cwd: st.spec.cwd,
    });
    this.emit(st, 'inputs_materialized', inputReceiptPayload(receipt));
    if (receipt.status === 'materialized' || receipt.status === 'nothing_to_materialize') {
      if (receipt.status === 'materialized') {
        this.emit(st, 'log', {
          stream: 'runner',
          level: 'info',
          message: `inputs.materialized runId=${st.runId} refs=${receipt.requested} files=${receipt.files} bytes=${receipt.bytes}`,
        });
      }
      return;
    }
    const code = receipt.entries.find((entry) => entry.code !== null)?.code ?? 'MATERIALIZE_REF_INVALID';
    const retryable = InputMaterializer.isRetryable(code);
    const reason = receipt.reason ?? `snapshot inputs of run ${st.runId} were not materialized`;
    this.emit(st, 'log', {
      stream: 'runner',
      level: 'error',
      message: `inputs.materialize_${receipt.status} runId=${st.runId} code=${code} retryable=${retryable} reason=${truncateLine(redactSecrets(reason), 300)}`,
    });
    throw new PreflightError(code, reason, { retryable });
  }

  /**
   * Подъём границы рана (issue #51): аренда слота, run-scoped каталоги с правами 0700,
   * ACL для Runner'а и проба границы под идентичностью рана. Fail-closed: любой отказ
   * поднимается как CleanRoomError и валит старт до спавна движка.
   */
  private async prepareCleanRoom(run: InternalRun, st: PersistedRunState): Promise<void> {
    const provider = this.opts.isolation;
    if (!provider) return;
    const room = await provider.acquire(st.runId, st.userTaskId, st.profileId, st.spec.cwd);
    run.room = room;
    st.cleanRoom = {
      identity: room.identity,
      paths: room.paths,
      status: 'active',
    };
    this.store.saveState(st);
    this.emit(st, 'isolation_prepared', {
      slotId: room.identity.slotId,
      username: room.identity.username,
      uid: room.identity.uid,
      gid: room.identity.gid,
      acl: room.acl,
      probe: {
        checks: room.probe?.checks.length ?? 0,
        failures: room.probe?.failures.length ?? 0,
      },
    });
    this.seedEngineConfig(run, st);
  }

  /**
   * Конфиг движка в run-scoped HOME. Своя HOME рана убрала бы у движка конфиг пользователя
   * сервиса, и OpenCode без provider/model ушёл бы на платный профиль по умолчанию,
   * поэтому хостовый шаблон копируется сюда ДО старта движка. Отказ (шаблон объявлен, но
   * нечитаем/некуда положить) валит старт рана, а не оставляет движок без модели.
   * В лог идут путь и sha256 копии — содержимое конфига в логи не попадает.
   */
  private seedEngineConfig(run: InternalRun, st: PersistedRunState): void {
    const room = run.room;
    if (!room) return;
    const seeded = materializeEngineConfig(this.opts.engineConfigTemplates ?? null, room, st.spec.engine.name);
    // Шаблона на хосте нет — поведение прежнее (движок читает свой конфиг сам), и это не
    // событие рана: в лог попадает только фактически положенная копия.
    if (!seeded) return;
    this.emit(st, 'log', {
      stream: 'runner',
      level: 'info',
      message: `engine_config.seeded engine=${seeded.engine} path=${seeded.path} bytes=${seeded.bytes} sha256=${seeded.sha256} slot=${room.identity.slotId}`,
    });
  }

  /**
   * Сверка, что процесс движка реально исполняется под идентичностью рана. Хост читает
   * /proc/<pid>/status: если UID не совпал со слотом, процесс убивается, а ран отказывает —
   * запускать движок с более широкими правами, чем у рана, нельзя.
   *
   * Провайдер без привилегий (`simulated`) переключения не делает: сверка тогда не
   * выполняется, и это видно в логе рана, а не проходит как «проверено».
   */
  private async assertEngineIdentity(run: InternalRun, st: PersistedRunState, pid: number): Promise<void> {
    const room = run.room;
    if (!room) return;
    if (this.opts.isolation?.identityEnforcement === 'simulated') {
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'warn',
        message: `engine.identity_not_enforced pid=${pid} slot=${room.identity.slotId} reason=provider_simulated`,
      });
      return;
    }
    const settled = await settleEngineIdentity(room, pid);
    if (settled.kind === 'gone') {
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'warn',
        message: `engine.identity_unknown pid=${pid} slot=${room.identity.slotId} waitedMs=${settled.waitedMs}`,
      });
      return;
    }
    if (settled.kind === 'mismatch') {
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'error',
        message: `engine.identity_mismatch pid=${pid} uid=${settled.uid} expected=${room.identity.slotId}:${room.identity.uid} waitedMs=${settled.waitedMs}`,
      });
      throw new CleanRoomError('ISOLATION_IDENTITY_MISMATCH', `engine process ${pid} runs as uid ${settled.uid}, expected slot ${room.identity.slotId} (uid ${room.identity.uid})`);
    }
    this.emit(st, 'log', {
      stream: 'runner',
      level: 'info',
      message: `engine.identity_verified pid=${pid} uid=${settled.uid} slot=${room.identity.slotId} waitedMs=${settled.waitedMs}`,
    });
  }

  /**
   * Дочистка чистой среды терминального рана после рестарта воркера (issue #51).
   *
   * Движок здесь не запускается: повторяется только persist/sweep. Если экспорт оставил
   * единственную копию выхода, workspace не трогаем, а слот остаётся `blocked` — иначе
   * переиспользование открыло бы прежние данные рана.
   */
  private async reconcileCleanRoom(run: InternalRun): Promise<boolean> {
    const provider = this.opts.isolation;
    if (!provider) return false;
    const st = run.state;
    if (!st.cleanRoom) return false;
    const lease = provider.lease(st.runId);
    if (!lease || lease.status === 'released') return false;
    const manifest = this.exportManifest(st.runId);
    const retained = this.soleCopiesOnDisk(st, manifest).length > 0;
    try {
      await provider.reconcile(lease, retained ? { keepWorkspace: true } : {});
    } catch (error) {
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'error',
        message: `clean_room.reconcile_failed runId=${st.runId} detail=${truncateLine(redactSecrets(error instanceof Error ? error.message : String(error)), 300)}`,
      });
      return false;
    }
    const after = provider.lease(st.runId);
    st.cleanRoom.status = after?.status ?? st.cleanRoom.status;
    this.store.saveState(st);
    this.emit(st, 'log', {
      stream: 'runner',
      level: 'info',
      message: `clean_room.reconciled runId=${st.runId} status=${st.cleanRoom.status} reason=${after?.reason ?? 'verified_sweep'}`,
    });
    return true;
  }

  /**
   * Освобождение границы: sweep каталогов рана + снятие аренды слота. Слот освобождается
   * только после проверенного удаления — иначе аренда остаётся `blocked` и слот не
   * переиспользуется.
   */
  private async releaseCleanRoom(run: InternalRun, reason: string, options: { keepWorkspace?: boolean } = {}): Promise<void> {
    const room = run.room;
    if (!room) return;
    run.room = null;
    const st = run.state;
    if (st.cleanRoom) {
      st.cleanRoom.status = 'sweeping';
      this.store.saveState(st);
    }
    const provider = this.opts.isolation;
    if (!provider) return;
    try {
      await provider.release(room, reason, options);
    } catch (error) {
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'error',
        message: `clean_room.release_failed reason=${reason} detail=${truncateLine(redactSecrets(error instanceof Error ? error.message : String(error)), 300)}`,
      });
    }
    if (st.cleanRoom) {
      const lease = provider.lease(st.runId);
      st.cleanRoom.status = lease?.status ?? 'released';
      this.store.saveState(st);
    }
  }

  private buildEnv(spec: RunSpec): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of spec.envAllowlist) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return env;
  }

  /**
   * Окружение движка: allowlist рана + путь к per-run конфигу MCP (P13). Значений credential
   * binding'ов в конфиге нет; run token локального моста там есть — это координата
   * per-run процесса, а не изоляционная граница (см. docs/MCP-LIFECYCLE.md).
   */
  private buildEngineEnv(run: InternalRun, spec: RunSpec): Record<string, string> {
    const env = this.buildEnv(spec);
    const room = run.room;
    if (room) {
      // run-scoped HOME/config/cache/tmp: движок не видит и не пишет пользовательский
      // конфиг и кэш ни своего профиля, ни соседнего рана, ни Runner'а.
      for (const [name, value] of Object.entries(room.env)) env[name] = value;
    }
    const config = run.mcpConfigPath;
    if (config) env[MCP_CONFIG_ENV] = config;
    return env;
  }

  private mcpLog(runId: string): (level: McpLogLevel, event: string, fields: McpLogFields) => void {
    return (level, event, fields) => {
      const run = this.runs.get(runId);
      if (!run || this.disposed) return;
      const st = run.state;
      if (isTerminalState(st.state)) return;
      const message = redactSecrets(`${event} ${formatMcpFields(fields)}`.trim());
      this.emit(st, 'log', { stream: 'runner', level, message: truncateLine(message, 2000) });
    };
  }

  /**
   * Старт MCP-сессии рана. Fail-closed: неизвестный binding, недоступное значение или
   * отказ сервера (spawn/handshake/readiness) валят старт рана, причина — в логе рана.
   */
  private async startMcpSession(run: InternalRun, st: PersistedRunState): Promise<void> {
    const log = this.mcpLog(st.runId);
    let scope: McpRunScope;
    try {
      scope = McpRunScope.fromSpec(st.spec, this.opts.bindingResolver);
    } catch (err) {
      if (err instanceof McpScopeError) {
        log('error', 'mcp.binding_denied', {
          serverId: err.serverId,
          bindingRef: err.bindingRef,
          reason: err.code,
          detail: err.message,
        });
      }
      throw err;
    }

    for (const scoped of scope.servers) {
      if (!scoped.binding) continue;
      // Значение binding'а проверяется до спавна: сервер, которому хост не может выдать
      // учётные данные, не поднимается вовсе.
      try {
        await scope.bindingValue(scoped);
      } catch (err) {
        const code = err instanceof McpScopeError ? err.code : 'MCP_BINDING_VALUE_UNAVAILABLE';
        log('error', 'mcp.binding_unavailable', {
          serverId: scoped.serverId,
          bindingRef: scoped.binding.ref,
          bindingScope: scoped.binding.scope,
          reason: code,
          detail: err instanceof Error ? err.message : String(err),
        });
        throw new McpStartupError(scoped.serverId, 'binding_unavailable', err instanceof Error ? err.message : String(err));
      }
    }

    const session = await McpRunSession.start({
      spec: st.spec,
      scope,
      log,
      ...(this.opts.capabilities ? { registry: this.opts.capabilities } : {}),
      bridgeToken: newBridgeToken(),
      // Сокет моста живёт внутри чистой среды рана: к нему подключаются и движок, и
      // per-run MCP-серверы — все под идентичностью рана, поэтому каталог обязан быть
      // их собственным (0700, владелец — слот). bridgeDir — родитель каталога `mcp/`,
      // поэтому это корень среды, а не paths.mcp: иначе получилось бы mcp/mcp/.
      bridgeDir: run.room ? run.room.paths.root : join(this.opts.rootDir, 'mcp'),
      ...(this.opts.mcpBrokerCommand ? { brokerCommand: this.opts.mcpBrokerCommand } : {}),
      ...(this.opts.isolation?.launcher ? { launcher: this.opts.isolation.launcher } : {}),
      ...(run.room ? { identity: run.room.identity, runEnv: run.room.env } : {}),
    });
    run.mcp = session;
    st.mcp = { serverPids: session.servers.map((server) => ({ serverId: server.serverId, pid: server.pid ?? -1 })).filter((entry) => entry.pid > 0) };
    this.store.saveState(st);
    run.mcpConfigPath = this.writeMcpConfig(st.spec.cwd, session.engineConfig(), log, run.room);
  }

  /** Конфиг для движка пишется в workspace рана с правами 0600 и без значений binding'ов. */
  private writeMcpConfig(
    cwd: string,
    config: EngineMcpConfig,
    log: (level: McpLogLevel, event: string, fields: McpLogFields) => void,
    room: CleanRoom | null,
  ): string {
    const path = join(cwd, MCP_CONFIG_DIR, 'mcp.json');
    mkdirSync(join(cwd, MCP_CONFIG_DIR), { recursive: true, mode: 0o700 });
    writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
    try {
      chmodSync(path, 0o600);
    } catch {
      // право 0600 усиливаем chmod'ом ниже; ошибка не должна валить старт рана
    }
    // Движок читает конфиг под идентичностью рана: владелец обязан быть слотом, иначе
    // он не сможет прочитать собственный конфиг (0600, владелец — Runner).
    if (room) {
      try {
        chownSync(path, room.identity.uid, room.identity.gid);
      } catch {
        // chown без привилегий не должен ронять старт: права 0600 уже выставлены
      }
    }
    log('info', 'mcp.engine_config', {
      configPath: path,
      servers: config.serverIds.length,
      bindingValues: false,
      isolation: room ? `per_run_unix_identity uid=${room.identity.uid}` : 'bridge_token_visible_to_engine_not_os_isolation',
    });
    return path;
  }

  /**
   * Гашение MCP-процессов рана. Идемпотентно и безопасно для повторного вызова: один и тот
   * же прогон cleanup (engine exit, cancel, timeout, dispose, recover) гасит сессию один раз.
   */
  private async stopMcpSession(run: InternalRun, reason: string): Promise<void> {
    const session = run.mcp;
    if (!session) return;
    run.mcp = null;
    run.mcpConfigPath = null;
    const st = run.state;
    if (st.mcp) {
      st.mcp = null;
      this.store.saveState(st);
    }
    if (run.mcpCleanup) {
      await run.mcpCleanup;
      return;
    }
    const cleanup = session.dispose(reason).finally(() => {
      run.mcpCleanup = null;
    });
    run.mcpCleanup = cleanup;
    await cleanup;
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
    void this.stopMcpSession(run, 'timeout');
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
    if (stream === 'stdout') this.rememberAnswerLine(run, sanitized);
    this.emit(st, 'log', { stream, level: 'info', message: sanitized });
  }

  /**
   * Хвост stdout движка — запасной источник текста ответа (issue #52, шаг 2). Накопитель
   * ограничен и живёт только в памяти воркера: после выхода движка хвост либо становится
   * ответом, либо теряется вместе с процессом.
   */
  private rememberAnswerLine(run: InternalRun, line: string): void {
    const tail = run.answerTail;
    tail.push(line.length > ANSWER_TAIL_MAX_LINE ? line.slice(0, ANSWER_TAIL_MAX_LINE) : line);
    while (tail.length > ANSWER_TAIL_MAX_LINES) tail.shift();
  }

  private async onEngineExit(runId: string, code: number | null, signal: string | null): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.exitReceived || this.disposed) return;
    const st = run.state;
    if (isTerminalState(st.state)) return;
    run.exitReceived = true;
    this.clearTimers(run);
    // P13: MCP-процессы рана живут дольше движка только до его выхода; дальше — cleanup.
    // Причина берётся из состояния рана: отмена/таймаут двигателя гасят MCP с той же причиной.
    await this.stopMcpSession(run, st.cancelRequested ?? 'engine_exit');
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
      // Движок не запускался: сохранять нечего, но уборка обязана быть объяснена —
      // статус без причины читался бы как «мы не знаем, что произошло».
      persistence: 'not_required',
      persistenceReason: 'the engine never started: there is nothing to persist',
      cleanup: 'completed',
      cleanupReason: 'no clean room was acquired and no run directory is left behind',
      logPath: this.store.relLogPath(st.runId),
    };
    if (failure) result.failure = failure;
    stripRepositoryToken(st.spec);
    this.persistResult(st, result);
    // Граница снимается и на стартовом отказе: иначе слот занят до следующего recover().
    const run = this.runs.get(st.runId);
    if (run?.room) void this.releaseCleanRoom(run, `start_refused_${exitReason}`);
    // Checkpoint обязателен и на стартовом отказе: без него восстановление не отличит
    // «движок не запускался» от «ран не дожил до записи факта».
    // Молча: терминальное событие рана обязано остаться последним в потоке клиента.
    this.writeCheckpoint(
      st,
      result,
      null,
      null,
      null,
      'cleanup_pending',
      { status: 'pending', reason: null, intentAt: this.nowIso(), finishedAt: null },
      { silent: true },
    );
  }

  private failStartPath(st: PersistedRunState, err: unknown, phase: 'preflight' | 'isolation' | 'mcp' | 'spawn'): void {
    const message = err instanceof Error ? err.message : String(err);
    const safeSummary = truncateLine(redactSecrets(message), 500);
    const failure: RunResult['failure'] =
      phase === 'isolation'
        ? {
            code: err instanceof CleanRoomError ? err.code : 'ISOLATION_UNAVAILABLE',
            failureClass: 'runtime',
            safeSummary,
            retryable: err instanceof CleanRoomError ? err.retryable : true,
          }
        : phase === 'mcp'
          ? {
              code: err instanceof McpStartupError ? err.code : err instanceof McpScopeError ? err.code : 'MCP_STARTUP_FAILED',
              failureClass: 'runtime',
              safeSummary,
              retryable: true,
            }
          : phase === 'spawn'
            ? { code: 'ENGINE_STARTUP_FAILED', failureClass: 'engine', safeSummary, retryable: true }
            : err instanceof PreflightError
              ? { code: err.code, failureClass: err.failureClass, safeSummary, retryable: err.retryable }
              : { code: 'PREFLIGHT_FAILED', failureClass: 'preflight', safeSummary, retryable: true };
    const exitReason = phase === 'spawn' || phase === 'mcp' ? 'startup_failure' : 'preflight_refused';
    this.completeWithoutEngine(st, 'failed', exitReason, failure);
  }

  private async doFinalize(st: PersistedRunState): Promise<RunResult> {
    await this.fireFault('finalization', st.runId);
    if (st.pgid && !isProcessAlive(st.pid) && isProcessGroupAlive(st.pgid)) {
      killProcessGroup(st.pgid, 'SIGKILL');
      await waitForProcessDeath(st.pgid, null, 500);
    }
    // Выход определяется здесь: объявленные выходы плюс явный манифест агента, а текст
    // ответа сохраняется отдельным выходом до того, как начнётся экспорт (issue #52).
    const run = this.runs.get(st.runId);
    const exit = run ? this.resolveExit(run, st) : null;
    // Fast result boundary: persist the engine outcome and answer before any declared
    // output upload. The checkpoint + result are durable on the Runner host; the clean
    // room remains leased until recover() verifies remote custody and completes cleanup.
    const existingExport = this.exportManifest(st.runId);
    const captured: RunResult = {
      ...this.computeResult(st, existingExport),
      ...((exit?.answer.present ?? false) ? { text: exit!.answer.text } : {}),
      ...(exit && exit.plan.length > 0 && existingExport === null ? {
        persistence: 'pending' as const,
        persistenceReason: 'engine result captured; artifact persistence is pending',
      } : {}),
      cleanup: 'pending',
      cleanupReason: 'cleanup is blocked until remote custody is verified',
    };
    this.writeCheckpoint(st, captured, existingExport, exit, null, 'engine_terminal', {
      status: 'pending', reason: 'engine result captured; artifact persistence is pending', intentAt: this.nowIso(), finishedAt: null,
    });
    this.persistResult(st, captured);
    // The captured answer is already durable in result.json + checkpoint. Its small
    // object-store copy can be retried without delaying delivery of that result.
    const answerArtifactId = await this.saveAnswerArtifact(st, exit?.answer ?? { present: false, source: null, chars: 0, text: '' });
    const exportManifest = await this.runExport(st, exit ? { plan: exit.plan } : {});
    const soleCopies = this.soleCopiesOnDisk(st, exportManifest);
    // Намерение уборки фиксируется на диске ДО самой уборки: сбой в момент sweep не
    // должен оставить каталоги рана без записанного намерения их вычистить.
    this.writeCheckpoint(
      st,
      this.computeResult(st, exportManifest),
      exportManifest,
      exit,
      answerArtifactId,
      'cleanup_pending',
      { status: 'pending', reason: null, intentAt: this.nowIso(), finishedAt: null },
    );

    // Уборка идёт ДО терминального события (issue #52, шаг 5): когда клиент читает
    // результат, уборка уже проверена, а статус cleanup — это факт, а не обещание.
    // Единственная копия выхода остаётся на диске: слот не отдаём, переиспользование
    // открыло бы прежние данные рана.
    const cleanup = await this.sweepRunEnvironment(run, soleCopies.length > 0 ? 'sole_copy_retained' : `finalized_${st.exit ? 'engine_exit' : 'startup_failure'}`, {
      keepWorkspace: soleCopies.length > 0,
    });

    const result: RunResult = {
      ...this.computeResult(st, exportManifest, cleanup),
      ...((exit?.answer.present ?? false) ? { text: exit!.answer.text } : {}),
    };
    await this.appendProfileTrace(st, result);
    // The engine result may already have been delivered while persistence ran.
    // Refresh the durable result without emitting a second terminal event.
    if (st.finalized) this.updateTerminalResult(st, result);
    else this.persistResult(st, result);
    // Финальный checkpoint несёт проверенный факт уборки: аренда снята или слот остался
    // занят с причиной. Именно его читает восстановление, не перезапуская движок.
    if (run) this.finishCheckpointAfterCleanup(run, st, result, exportManifest, exit, answerArtifactId, cleanup, { silent: true });
    return result;
  }

  /**
   * Локальные копии выходов, которые остались ЕДИНСТВЕННОЙ копией и действительно
   * лежат на диске (issue #52, шаг 4).
   *
   * Манифест помечает `retained` и пропавший файл: тот-то вышел не сохранённым, но
   * копии-то нет. Держать ради него весь рабочий каталог — значит держать впустую и
   * вечно, поэтому решение об уборке принимается по факту наличия файла, а не по
   * флагу манифеста.
   */
  private soleCopiesOnDisk(st: PersistedRunState, exportManifest: RunExportManifest | null): string[] {
    if (!exportManifest || exportManifest.cleanup.decision !== 'retained_sole_copy') return [];
    return exportManifest.cleanup.retained.filter((relative) => existsSync(join(st.spec.cwd, relative)));
  }

  /**
   * Уборка среды рана (issue #52, шаг 4): workspace, HOME/config/cache/tmp, конфиг и сокет
   * MCP, идентичность слота. Возвращает ПРОВЕРЕННЫЙ результат: `completed` только если
   * после удаления на диске не осталось ни каталогов рана, ни его сокета.
   *
   * С границей уборку делает провайдер (слот освобождается только после проверки), без
   * границы хост убирает рабочий каталог и сокет сам — иначе каталоги ранов копились бы
   * вечно, а ран объявлял бы уборку выполненной по отсутствию процессов.
   *
   * Граница, поднятая ПРЕЖДУМ воркером, переживает рестарт: в этом процессе `run.room`
   * уже пуст, но аренда и каталоги лежат на диске. Уборка обязана довести их до конца и
   * здесь — иначе слот остался бы занятым навсегда, а `cleanup: completed` — неправдой
   * (дефект, найденный пробой на песочной VM2).
   */
  private async sweepRunEnvironment(
    run: InternalRun | undefined,
    reason: string,
    options: { keepWorkspace?: boolean } = {},
  ): Promise<CleanupOutcome> {
    if (!run) {
      return { status: 'pending', reason: 'run is not tracked in this worker process', removed: [] };
    }
    const st = run.state;
    const removed: string[] = [];
    const keep = options.keepWorkspace === true || this.opts.retainWorkspaces === true;
    // Намерение уборки к этому моменту уже записано на диск вызывающим кодом, поэтому
    // сбой здесь — честный «сбой во время sweep»: восстановление найдёт намерение и
    // доведёт уборку до конца, не перезапуская движок.
    await this.fireFault('cleanup', st.runId);
    const provider = this.opts.isolation ?? null;
    const room = run.room;
    const lease = provider?.lease(st.runId) ?? null;
    if (room || (provider && lease && lease.status !== 'released' && st.cleanRoom)) {
      if (room) {
        await this.releaseCleanRoom(run, reason, { ...(keep ? { keepWorkspace: true } : {}) });
      } else {
        // Аренда с прошлого воркера: тот же проверенный sweep+release, только по аренде.
        if (st.cleanRoom) {
          st.cleanRoom.status = 'sweeping';
          this.store.saveState(st);
        }
        try {
          await provider?.reconcile(lease as CleanRoomLease, keep ? { keepWorkspace: true } : {});
        } catch (error) {
          this.emit(st, 'log', {
            stream: 'runner',
            level: 'error',
            message: `clean_room.reconcile_failed runId=${st.runId} reason=${reason} detail=${truncateLine(redactSecrets(error instanceof Error ? error.message : String(error)), 300)}`,
          });
        }
        const after = provider?.lease(st.runId) ?? null;
        if (st.cleanRoom) {
          st.cleanRoom.status = after?.status ?? 'released';
          this.store.saveState(st);
        }
        this.emit(st, 'log', {
          stream: 'runner',
          level: 'info',
          message: `clean_room.reconciled_sweep runId=${st.runId} reason=${reason} lease=${after?.status ?? 'absent'}`,
        });
      }
      const current = provider?.lease(st.runId) ?? null;
      const socket = this.runSocketPath(st.runId, null);
      if (socket && !existsSync(socket)) removed.push(socket);
      const missing = st.cleanRoom === null ? [] : [st.cleanRoom.paths.root, st.cleanRoom.paths.cwd];
      const leftovers = missing.filter((target) => existsSync(target));
      const released = current === null || current.status === 'released';
      if (released && leftovers.length === 0) {
        return { status: 'completed', reason: 'clean room lease released and every run directory is gone', removed };
      }
      const blocked = {
        status: 'pending' as const,
        reason:
          current?.reason ??
          `cleanup is not verified: ${leftovers.length > 0 ? `left ${leftovers.join(', ')}` : 'lease is not released'}`,
        removed,
      };
      // Причина невыполненной уборки видна в логе рана ДО терминального события.
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'warn',
        message: `clean_room.cleanup_blocked runId=${st.runId} status=${current?.status ?? 'unknown'} reason=${truncateLine(blocked.reason, 300)}`,
      });
      return blocked;
    }

    // Без чистой среды: убираем рабочий каталог и сокет MCP рана, если выходы не остались
    // единственной копией.
    if (!keep) {
      if (existsSync(st.spec.cwd)) {
        // Удаление ПРОВЕРЯЕТСЯ, а не предполагается. Каталог может быть недоступен Runner'у
        // (права слота, потерянный ACL после смены хоста), и раньше такая ошибка
        // поднималась из восстановления и роняла старт воркера целиком: нечитаемая уборка
        // одного прошлого рана делала недоступным и чтение всех остальных. Теперь это
        // «уборка не завершена» с причиной — слот остаётся заблокированным, сервис жив.
        try {
          rmSync(st.spec.cwd, { recursive: true, force: true });
          removed.push(st.spec.cwd);
        } catch (error) {
          const detail = truncateLine(redactSecrets(error instanceof Error ? error.message : String(error)), 200);
          this.emit(st, 'log', {
            stream: 'runner',
            level: 'error',
            message: `clean_room.sweep_failed runId=${st.runId} path=${st.spec.cwd} detail=${detail}`,
          });
          return { status: 'pending', reason: `workspace ${st.spec.cwd} could not be removed: ${detail}`, removed };
        }
      }
      const socket = this.runSocketPath(st.runId, null);
      if (socket && existsSync(socket)) {
        rmSync(socket, { force: true });
        removed.push(socket);
      }
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'info',
        message: `clean_room.swept runId=${st.runId} reason=${reason} removed=${removed.length} room=none`,
      });
    }
    if (existsSync(st.spec.cwd)) {
      const pending = {
        status: 'pending' as const,
        reason: keep
          ? this.opts.retainWorkspaces === true
            ? 'run workspace is retained on purpose: this worker runs with retainWorkspaces'
            : 'run workspace retained as the only copy of its output'
          : `workspace ${st.spec.cwd} is still present`,
        removed,
      };
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'warn',
        message: `clean_room.cleanup_blocked runId=${st.runId} status=pending reason=${truncateLine(pending.reason, 300)}`,
      });
      return pending;
    }
    return { status: 'completed', reason: 'run workspace and its MCP socket are gone', removed };
  }

  /** Путь сокета MCP рана: в чистой среде или в каталоге dataDir, если границы нет. */
  private runSocketPath(runId: string, room: CleanRoom | null): string | null {
    const root = room ? room.paths.root : join(this.opts.rootDir, 'mcp');
    return bridgeSocketPath(root, runId, { scoped: room !== null });
  }

  /**
   * Закрытие checkpoint после уборки: статус аренды — единственный проверяемый факт
   * «каталоги рана вычищены». Отсутствие процессной группы таким фактом не является.
   */
  private finishCheckpointAfterCleanup(
    run: InternalRun,
    st: PersistedRunState,
    result: RunResult,
    exportManifest: RunExportManifest | null,
    exit: ExitResolution | null,
    answerArtifactId: string | null,
    outcome: CleanupOutcome,
    options: { silent?: boolean } = {},
  ): void {
    const lease = this.opts.isolation?.lease(st.runId) ?? null;
    const status = lease?.status ?? 'released';
    const completed = outcome.status === 'completed' && status === 'released';
    this.writeCheckpoint(
      st,
      result,
      exportManifest,
      exit,
      answerArtifactId,
      completed ? 'complete' : 'cleanup_pending',
      {
        status: completed ? 'completed' : outcome.status === 'failed' ? 'blocked' : 'blocked',
        reason: completed ? outcome.reason : (lease?.reason ?? outcome.reason),
        intentAt: null,
        finishedAt: completed ? this.nowIso() : null,
      },
      options,
    );
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
  private async runExport(
    st: PersistedRunState,
    options: { force?: boolean; plan?: PlannedOutput[] } = {},
  ): Promise<RunExportManifest | null> {
    const exports = this.opts.exports;
    if (!exports) return null;
    const plan: PlannedOutput[] =
      options.plan ??
      (st.spec.outputs ?? []).map((output) => ({
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

  /**
   * Определение выхода рана (issue #52, шаг 2).
   *
   * Источников ровно два: объявленные клиентом `spec.outputs` и явный финальный
   * манифест агента. Сканирование HOME/секретов «вслепую» запрещено: ран не должен
   * попадать в чужие данные, а хранилище — наполняться тем, что никто не объявлял.
   *
   * Текст ответа сохраняется отдельным выходом `.runner/answer.txt`: он проходит тот же
   * путь экспорта (upload → read-back → prune), что и остальные выходы, и поэтому
   * переживает sweep чистой среды. Содержимое в журнал рана не попадает.
   */
  private resolveExit(run: InternalRun, st: PersistedRunState): ExitResolution {
    const declared = st.spec.outputs ?? [];
    const read = readAgentFinalManifest(st.spec.cwd);
    const manifest = read.status === 'ok' ? read.manifest : null;
    if (read.status === 'invalid') {
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'warn',
        message: `agent.final_manifest_invalid path=${AGENT_MANIFEST_PATH} reason=${truncateLine(read.reason, 300)}`,
      });
    }
    const { plan, merged } = mergeOutputPlan(declared, manifest?.outputs ?? []);
    if (merged.length > 0) {
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'info',
        message: `agent.final_manifest_merged paths=${merged.join(',')} reason=declared outputs win on conflict`,
      });
    }

    const answer = readAgentAnswer(st.spec.cwd, manifest);
    let answerText = answer.source === 'agent_file' ? answer.text : '';
    let answerSource: 'agent_file' | 'engine_stdout' | null = answer.source;
    if (answerText.length === 0 && run.answerTail.length > 0) {
      answerText = run.answerTail.join('\n');
      answerSource = 'engine_stdout';
    }
    if (answerText.length > ANSWER_MAX_CHARS) {
      answerText = answerText.slice(0, ANSWER_MAX_CHARS);
    }

    this.emit(st, 'agent_exit_resolved', {
      manifest: read.status,
      declared: declared.length,
      fromManifest: manifest?.outputs.length ?? 0,
      answerSource,
      answerChars: answerText.length,
      planned: plan.length,
      reason:
        read.status === 'invalid'
          ? `final manifest rejected: ${read.reason}`
          : read.status === 'ok'
            ? read.reason
            : 'the agent declared no final manifest',
    });
    return { plan, answer: { present: answerText.length > 0, source: answerSource, chars: answerText.length, text: answerText } };
  }

  /**
   * Текст ответа агента — отдельный долговечный артефакт `answer.txt` (issue #52, шаг 2).
   *
   * Он не входит в план экспорта: план — это контракт клиента (объявленные выходы) плюс
   * манифест агента, а ответ пишет хост. Отдельный артефакт читается через тот же
   * `GET /v1/runs/{id}/artifacts`, не требует файла в workspace и не зависит от того,
   * откроется ли экспорт объявленных выходов.
   */
  private async saveAnswerArtifact(
    st: PersistedRunState,
    answer: { present: boolean; source: 'agent_file' | 'engine_stdout' | null; chars: number; text: string },
  ): Promise<string | null> {
    if (!answer.present || !this.opts.exports) return null;
    const text = answer.text;
    if (text.length === 0) return null;
    try {
      const manifest = await this.opts.exports.artifacts.put({
        runId: st.runId,
        userTaskId: st.userTaskId,
        profileId: st.profileId,
        name: 'answer.txt',
        mime: 'text/plain',
        bytes: text.slice(0, ANSWER_MAX_CHARS),
      });
      this.emit(st, 'agent_answer_saved', {
        artifactId: manifest.artifactId,
        source: answer.source,
        chars: text.length,
        size: manifest.size,
      });
      return manifest.artifactId;
    } catch (error) {
      // Ответ не сохранился — ран не падает: причина в журнале, а выходы объявлены отдельно.
      this.emit(st, 'log', {
        stream: 'runner',
        level: 'warn',
        message: `agent.answer_save_failed detail=${truncateLine(redactSecrets(error instanceof Error ? error.message : String(error)), 200)}`,
      });
      return null;
    }
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
      // Повторный экспорт (persist после рестарта) не имеет права переписать уже
      // подтверждённый артефакт: локальная копия к этому моменту снята как
      // подтверждённая, и «файла нет» здесь означало бы не сохранённые байты.
      const carried = exports.read(ctx.runId)?.entries.find((entry) => entry.sourcePath === output.path);
      if (carried?.status === 'exported' && carried.artifactId !== null) {
        if (st) {
          this.emit(st, 'log', {
            stream: 'runner',
            level: 'info',
            message: `export.already_verified runId=${ctx.runId} path=${output.path} artifactId=${carried.artifactId}`,
          });
        }
        return;
      }
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

  private computeResult(
    st: PersistedRunState,
    exportManifest: RunExportManifest | null = null,
    cleanup: CleanupOutcome | null = null,
  ): RunResult {
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
    const outputRefs = (exportManifest?.entries ?? [])
      .filter((entry) => entry.status === 'exported' && entry.artifactId !== null)
      .map((entry) => entry.artifactId as string);
    const persistence = this.persistenceStatus(exportManifest);
    const cleanupStatus = this.cleanupStatus(this.soleCopiesOnDisk(st, exportManifest), cleanup);

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
      persistence: persistence.status,
      persistenceReason: persistence.reason,
      cleanup: cleanupStatus.status,
      cleanupReason: cleanupStatus.reason,
      logPath: this.store.relLogPath(st.runId),
    };
    if (failure) result.failure = failure;
    return result;
  }

  /**
   * Статус сохранения (issue #52, шаг 3) выводится из манифеста экспорта, а не
   * предполагается: `persisted` означает, что каждый байт подтверждён чтением из
   * долговечного хранилища, `failed` — что не сохранён ни один выход.
   */
  private persistenceStatus(exportManifest: RunExportManifest | null): {
    status: RunResult['persistence'];
    reason: string;
  } {
    if (exportManifest === null) {
      return { status: 'not_required', reason: 'no output was declared by the client or the agent manifest' };
    }
    if (exportManifest.status === 'complete') {
      return {
        status: 'persisted',
        reason: `${exportManifest.totals.exported}/${exportManifest.totals.planned} output(s) verified by read-back from durable storage`,
      };
    }
    if (exportManifest.status === 'failed') {
      return {
        status: 'failed',
        reason: `${exportManifest.totals.failed}/${exportManifest.totals.planned} output(s) are not in durable storage; local copies were kept`,
      };
    }
    return {
      status: 'pending',
      reason: `${exportManifest.totals.exported}/${exportManifest.totals.planned} output(s) verified; retained as sole copy: ${exportManifest.cleanup.retained.join(', ') || 'none'}`,
    };
  }

  /**
   * Статус уборки (issue #52, шаг 5) — только проверенный контракт: каталоги рана и его
   * сокет сняты, а идентичность освобождена. Отсутствие процессной группы таким
   * контрактом не является, поэтому оно больше не влияет на статус.
   *
   * Пока на диске лежит локальная копия несохранённого выхода, уборка не может быть
   * объявлена выполненной даже при снятых каталогах: этот файл — единственная копия.
   */
  private cleanupStatus(soleCopies: readonly string[], outcome: CleanupOutcome | null): { status: RunResult['cleanup']; reason: string } {
    if (outcome === null) {
      return { status: 'pending', reason: 'cleanup has not been attempted yet' };
    }
    if (soleCopies.length > 0) {
      return {
        status: 'pending',
        reason: `${soleCopies.length} output(s) are still on local disk as the only copy: ${soleCopies.join(', ')}`,
      };
    }
    return { status: outcome.status, reason: outcome.reason };
  }

  /**
   * Обязательный checkpoint рана (issue #52). Пишется ДО уборки чистой среды: намерение
   * уборки обязано пережить сбой в момент sweep, иначе восстановление не узнает, что
   * каталоги рана ещё надо вычистить. Содержимое ответа агента в checkpoint не входит —
   * только источник и размер.
   */
  private writeCheckpoint(
    st: PersistedRunState,
    result: RunResult,
    exportManifest: RunExportManifest | null,
    exit: ExitResolution | null,
    answerArtifactId: string | null,
    phase: 'engine_terminal' | 'persisted' | 'cleanup_pending' | 'complete',
    cleanup: { status: 'pending' | 'sweeping' | 'completed' | 'blocked'; reason: string | null; intentAt: string | null; finishedAt: string | null },
    options: { silent?: boolean } = {},
  ): RunCheckpoint {
    const at = this.nowIso();
    const previous = this.store.readCheckpoint(st.runId);
    const answerText = exit?.answer.present ? exit.answer.text : '';
    const cappedAnswer = answerText.length > ANSWER_MAX_CHARS ? answerText.slice(0, ANSWER_MAX_CHARS) : answerText;
    const persistence: CheckpointPersistence =
      exportManifest === null
        ? 'not_required'
        : exportManifest.status === 'complete'
          ? 'persisted'
          : exportManifest.status === 'failed'
            ? 'failed'
            : 'pending';
    const checkpoint: RunCheckpoint = {
      schemaVersion: 1,
      runId: st.runId,
      jobId: st.jobId,
      userTaskId: st.userTaskId,
      profileId: st.profileId,
      ownerGeneration: st.ownerGeneration,
      phase,
      updatedAt: at,
      engine: {
        state: st.state,
        exitObserved: st.exit?.observed ?? false,
        exitCode: st.exit?.code ?? null,
        exitSignal: st.exit?.signal ?? null,
        exitReason: result.exitReason,
        startedAt: st.startedAt ?? st.createdAt,
        finishedAt: result.finishedAt,
      },
      answer: {
        present: exit?.answer.present ?? false,
        source: exit?.answer.source ?? null,
        chars: exit?.answer.chars ?? 0,
        text: cappedAnswer,
        artifactId: answerArtifactId,
        reason:
          exit === null
            ? 'engine never started: no answer to capture'
            : exit.answer.present
              ? `answer captured from ${exit.answer.source}`
              : 'the agent produced no answer text',
      },
      outputs: {
        declared: st.spec.outputs?.length ?? 0,
        fromAgentManifest: previous?.outputs.fromAgentManifest ?? 0,
        planned: exportManifest?.totals.planned ?? exit?.plan.length ?? 0,
        exported: exportManifest?.totals.exported ?? 0,
        failed: exportManifest?.totals.failed ?? 0,
        retained: [...(exportManifest?.cleanup.retained ?? [])],
        outputRefs: [...result.outputRefs],
        exportStatus: exportManifest?.status ?? null,
        exportVersion: exportManifest?.version ?? null,
      },
      persistence,
      cleanup: { ...cleanup },
    };
    const saved = this.store.saveCheckpoint(checkpoint);
    // Финальный checkpoint пишется молча: терминальное событие рана обязано остаться
    // последним в потоке клиента, а факт уборки живёт в checkpoint.json.
    if (!options.silent) {
      this.emit(st, 'checkpoint_written', {
        phase,
        persistence,
        cleanup: cleanup.status,
        outputRefs: saved.outputs.outputRefs.length,
        reason: cleanup.reason ?? `checkpoint phase=${phase}`,
      });
    }
    return saved;
  }

  /**
   * Восстановление checkpoint после рестарта: если ран терминален, а checkpoint не
   * дожил до записи (сбой между persist и checkpoint), он достраивается из долговечного
   * состояния. Движок при этом не запускается — только запись факта.
   */
  private ensureCheckpoint(run: InternalRun): RunCheckpoint | null {
    const st = run.state;
    const existing = this.store.readCheckpoint(st.runId);
    if (existing) return null;
    const result = st.result;
    if (!result) return null;
    const manifest = this.exportManifest(st.runId);
    const lease = this.opts.isolation?.lease(st.runId) ?? null;
    // Ран без чистой среды: уборкой считается отсутствие аренды — нечего освобождать.
    const cleanupStatus = lease === null ? 'completed' : lease.status === 'released' ? 'completed' : 'pending';
    // Байты не подтверждены чтением — уборка не может быть завершённой: единственная
    // копия остаётся на диске, и checkpoint обязан это показать, а не выдать за успех.
    const persistence: CheckpointPersistence =
      manifest === null ? 'not_required' : manifest.status === 'complete' ? 'persisted' : manifest.status === 'failed' ? 'failed' : 'pending';
    const phase: 'complete' | 'cleanup_pending' = cleanupStatus === 'completed' && persistence !== 'failed' ? 'complete' : 'cleanup_pending';
    return this.writeCheckpoint(
      st,
      result,
      manifest,
      null,
      null,
      phase,
      {
        status: cleanupStatus,
        reason: lease?.reason ?? (phase === 'complete' ? 'lease released after a verified sweep' : 'checkpoint rebuilt after a worker restart'),
        intentAt: null,
        finishedAt: phase === 'complete' ? result.finishedAt : null,
      },
    );
  }

  /**
   * Доведение lifecycle до конца после рестарта воркера (issue #52, шаг 4).
   *
   * Движок не запускается: повторяются только persist (повторный commit экспорта, если
   * байты не подтверждены) и sweep. Намерение уборки лежит в checkpoint, поэтому
   * восстановление знает, что именно осталось сделать, и делает это ровно один раз.
   */
  private async resumeCleanup(run: InternalRun): Promise<boolean> {
    const st = run.state;
    const checkpoint = this.store.readCheckpoint(st.runId);
    if (!checkpoint || checkpoint.cleanup.status === 'completed') return false;
    const result = st.result;
    if (!result) return false;

    let exportManifest = this.exportManifest(st.runId);
    // Persist: выходы, которые не подтверждены чтением, пробуем сохранить ещё раз.
    if (this.opts.exports && (checkpoint.persistence === 'pending' || checkpoint.persistence === 'failed')) {
      try {
        exportManifest = await this.runExport(st, { force: true });
      } catch (error) {
        this.emit(st, 'log', {
          stream: 'runner',
          level: 'error',
          message: `export.retry_failed runId=${st.runId} detail=${truncateLine(redactSecrets(error instanceof Error ? error.message : String(error)), 300)}`,
        });
      }
    }
    const soleCopies = this.soleCopiesOnDisk(st, exportManifest);
    if (exportManifest !== null) {
      // Терминальное событие рана уже опубликовано: обновляется только сохранённый
      // результат, повторного терминального события не будет.
      this.updateTerminalResult(st, this.computeResult(st, exportManifest, null));
    }

    // Sweep: то же, что делает финализация, с тем же правилом про единственную копию.
    const fresh = this.runs.get(st.runId) ?? run;
    const cleanup = await this.sweepRunEnvironment(fresh, 'recovered_cleanup', { keepWorkspace: soleCopies.length > 0 });
    const next = this.updateTerminalResult(st, this.computeResult(st, exportManifest, cleanup));
    // Фаза выводится из обоих фактов, а не только из уборки: `complete` при
    // persistence=failed — ложь на диске (и RunStore такой checkpoint не примет).
    const complete = cleanup.status === 'completed' && next.persistence !== 'failed';
    this.writeCheckpoint(
      st,
      next,
      exportManifest,
      null,
      null,
      complete ? 'complete' : 'cleanup_pending',
      {
        status: cleanup.status === 'completed' ? 'completed' : 'blocked',
        reason: cleanup.reason,
        intentAt: checkpoint.cleanup.intentAt ?? checkpoint.updatedAt,
        finishedAt: complete ? this.nowIso() : null,
      },
      { silent: true },
    );
    this.emit(st, 'log', {
      stream: 'runner',
      level: 'info',
      message: `lifecycle.resumed runId=${st.runId} persistence=${next.persistence} cleanup=${cleanup.status} reason=${truncateLine(cleanup.reason, 200)}`,
    });
    return true;
  }

  /**
   * Обновление результата УЖЕ терминального рана (восстановление после сбоя). Событие
   * терминала не публикуется повторно: клиент видел его один раз, а на диске результат
   * обязан отражать доведённое состояние сохранения и уборки.
   */
  private updateTerminalResult(st: PersistedRunState, result: RunResult): RunResult {
    st.result = result;
    this.store.saveResult(st.runId, result);
    return result;
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
