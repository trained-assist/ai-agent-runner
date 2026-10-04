import { createHash } from 'node:crypto';
import type { LaunchArtifact, LaunchRepo, WorkerCancelResult } from '../adapters/external-worker-adapter.js';
import {
  admissionEvents,
  artifactUrl,
  branchUrl,
  mapLaunchResult,
  mergeUrl,
  workerTransportFailure,
  type ExternalWorker,
  type LaunchMapping,
  type LaunchReceipt,
  type WorkerRunStatus,
  ResultNotReadyError,
} from '../adapters/external-worker-adapter.js';
import type { RunResult } from '../contracts/result.js';
import { validateRunSpec, type InputSpec, type RunSpec } from '../contracts/run-spec.js';
import { DEFAULT_STATELESS_LIMITS, isTerminalApiState, STATELESS_STORE_SCHEMA_VERSION, StatelessStore, type AdmissionRecord } from './stateless-store.js';
import {
  API_CAPABILITIES_SCHEMA_VERSION,
  API_CONTRACT_VERSION,
  API_RUN_STATES,
  newApiId,
  submitPayloadHash,
  validateCancelRequest,
  validateIdempotencyKey,
  validateSubmitRequest,
  type ApiCapabilities,
  type EventsPage,
  type RunStatusView,
  type SubmitRequest,
  type SubmitResponse,
} from './contracts.js';
import { ApiError } from './errors.js';
import type { Principal } from './auth.js';

/**
 * Stateless-ядро API (epic #74). Принимает запрос, вызывает внешнего воркера по HTTP и держит
 * результат в памяти. Никакого диска, никакого spawn, никакого recovery: после рестарта клиент
 * повторяет submit с новым `Idempotency-Key`.
 */

export type ApiLogger = (entry: Record<string, unknown>) => void;

export type RunCancelStatus = 'stopped' | 'stop_pending' | 'already_terminal' | 'too_late' | 'rejected' | 'unknown_run';

export interface RunCancelReceipt {
  runId: string;
  status: RunCancelStatus;
  state?: string;
  reason?: string;
}

export interface RunArtifactLink {
  path: string;
  name: string;
  mime: string;
  sha256: string;
  size: number;
  /** Ссылка на файл в репозитории юзера — байты воркер коммитит сам, мы только адресуем. */
  url: string;
}

export interface RunArtifactsView {
  runId: string;
  conversationId: string;
  userTaskId: string;
  repo: LaunchRepo | null;
  /** Страница ветки рана: результат целиком, отсюда GitHub предлагает merge. */
  branchUrl: string | null;
  /** Куда мержить результат рана: сравнение с базой, если воркер её сообщил, иначе ветка. */
  mergeUrl: string | null;
  count: number;
  artifacts: RunArtifactLink[];
  logUrl: string | null;
  note: string;
}

export interface AgentApiOptions {
  /**
   * Внешние воркеры: единственный способ запустить агента. Запрос уходит воркеру, чьё имя
   * совпало с `engine.name`; неизвестный движок отклоняется до записи в память.
   */
  workers: ExternalWorker[];
  logger?: ApiLogger;
  clock?: () => Date;
  /** Запас сверх лимита рана на persist у воркера. По умолчанию минута. */
  resultGraceMs?: number;
  /** Значения окружения, которые API готов передать воркеру (пересекаются с envAllowlist). */
  env?: Record<string, string>;
  /** Сколько незавершённых ранов API держит до отказа в приёме новых. */
  maxActiveRuns?: number;
  /**
   * Репозиторий по умолчанию (`owner/name`), когда клиент его не объявил. Ставить его должен
   * API: воркер получает готовый `repository.fullName` и сам клонирует репозиторий.
   */
  defaultRepository?: string;
  store?: StatelessStore;
  /**
   * Журнал приёмных записей: дедупликация по `Idempotency-Key` переживает рестарт API.
   * Без него — только память процесса (контракт эпика #74, шаг 6).
   */
  admissionLogPath?: string;
}

/** Пауза между опросами статуса: растёт от базовой до потолка (экспоненциально). */
const POLL_BASE_DELAY_MS = 500;
const POLL_MAX_DELAY_MS = 10_000;
/** Запас сверх лимита рана на выгрузку лога и пуш ветки до уничтожения среды. */
const DEFAULT_RESULT_GRACE_MS = 60_000;

/**
 * Стабильный идентификатор операции: производный от попытки `(userTaskId, generation)`,
 * а не свежий на каждый submit. Воркер дедуплицирует по нему — поэтому он обязан
 * переживать рестарт API (контракт внешнего worker, п. 2).
 */
export function attemptOperationId(userTaskId: string, ownerGeneration: number): string {
  const digest = createHash('sha256').update(`${userTaskId}:${ownerGeneration}`).digest('hex');
  return `op_${digest.slice(0, 24)}`;
}

const defaultLogger: ApiLogger = (entry) => {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

export class AgentApi {
  readonly workers: readonly ExternalWorker[];
  readonly store: StatelessStore;
  private readonly opts: AgentApiOptions;
  private readonly logger: ApiLogger;
  private readonly clock: () => Date;
  /** Запас сверх лимита рана: воркер успел выгрузить лог и запушить ветку. */
  private readonly resultGraceMs: number;
  private disposed = false;
  private readonly maxActiveRuns: number;
  private readonly inFlight = new Set<string>();

  constructor(options: AgentApiOptions) {
    this.opts = options;
    if (options.workers.length === 0) {
      throw new Error('AgentApi requires at least one external worker: without it there is no way to launch an agent');
    }
    this.workers = options.workers;
    this.store = options.store ?? new StatelessStore({}, options.admissionLogPath ?? null);
    this.maxActiveRuns = options.maxActiveRuns ?? DEFAULT_STATELESS_LIMITS.maxActiveRuns;
    this.logger = options.logger ?? defaultLogger;
    this.clock = options.clock ?? (() => new Date());
    this.resultGraceMs = options.resultGraceMs ?? DEFAULT_RESULT_GRACE_MS;
  }

  /**
   * Идемпотентность без диска (epic #74, шаг 6): повторный submit с тем же ключом возвращает
   * тот же receipt. При рестарте память пуста — клиент обязан повторить submit с новым ключом.
   */
  submit(principal: Principal, rawIdempotencyKey: unknown, rawBody: unknown): SubmitResponse {
    const keyResult = validateIdempotencyKey(rawIdempotencyKey);
    if (!keyResult.ok) {
      throw new ApiError('MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required and must be a non-empty string of at most 200 characters');
    }
    const idempotencyKey = keyResult.value;

    const bodyResult = validateSubmitRequest(rawBody);
    if (!bodyResult.ok) {
      const repositoryErrors = bodyResult.errors.filter((entry) => entry.startsWith('request.repository.'));
      if (repositoryErrors.length > 0) {
        throw new ApiError('INVALID_REPOSITORY', `invalid repository: ${repositoryErrors.join('; ')}`, { errors: bodyResult.errors });
      }
      throw new ApiError('INVALID_REQUEST', `invalid submit body: ${bodyResult.errors.join('; ')}`, { errors: bodyResult.errors });
    }
    const request = bodyResult.value;
    const payloadHash = submitPayloadHash(request);

    const existing = this.store.getByAdmission(principal.principalId, idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ApiError(
          'IDEMPOTENCY_CONFLICT',
          `idempotency key was already used for requestId ${existing.requestId} with a different payload`,
          { requestId: existing.requestId, userTaskId: existing.userTaskId },
        );
      }
      this.log({
        event: 'submit',
        outcome: 'duplicate',
        principalId: principal.principalId,
        requestId: existing.requestId,
        userTaskId: existing.userTaskId,
        runId: existing.runId,
        ownerGeneration: existing.ownerGeneration,
      });
      return { requestId: existing.requestId, userTaskId: existing.userTaskId, runId: existing.runId, deduplicated: true };
    }

    if (!this.workerFor(request.engine.name)) {
      throw new ApiError(
        'ENGINE_NOT_ALLOWED',
        `this API does not run engine "${request.engine.name}"`,
        { engines: this.engineNames() },
      );
    }
    if (principal.engines && !principal.engines.includes(request.engine.name)) {
      throw new ApiError(
        'ENGINE_NOT_ALLOWED',
        `principal "${principal.principalId}" is not allowed to run engine "${request.engine.name}"`,
        { engines: [...principal.engines] },
      );
    }

    let requestId: string;
    let userTaskId: string;
    let jobId: string;
    let ownerGeneration: number;
    if (request.userTaskId) {
      const prior = this.store.currentAttempt(principal.principalId, request.userTaskId);
      if (prior) {
        const priorRun = this.store.progressOf(prior.runId);
        if (priorRun && !isTerminalApiState(priorRun.state)) {
          throw new ApiError(
            'TASK_ATTEMPT_ACTIVE',
            `task ${prior.userTaskId} already has an active attempt in state "${priorRun.state}"; cancel it before starting the next attempt`,
            { runId: prior.runId, state: priorRun.state },
          );
        }
        requestId = prior.requestId;
        jobId = prior.jobId;
        userTaskId = prior.userTaskId;
        ownerGeneration = prior.ownerGeneration + 1;
      } else {
        requestId = newApiId('req');
        jobId = newApiId('job');
        userTaskId = request.userTaskId;
        ownerGeneration = 1;
      }
    } else {
      requestId = newApiId('req');
      jobId = newApiId('job');
      userTaskId = newApiId('task');
      ownerGeneration = 1;
    }

    const spec = this.buildSpec(request, { principal, requestId, userTaskId, jobId, ownerGeneration });
    const record: AdmissionRecord = {
      schemaVersion: STATELESS_STORE_SCHEMA_VERSION,
      requestId,
      userTaskId,
      conversationId: spec.conversationId,
      principalId: principal.principalId,
      profileId: principal.profileId,
      jobId,
      idempotencyKey,
      payloadHash,
      runId: spec.runId,
      operationId: spec.operationId,
      ownerGeneration,
      spec,
      createdAt: this.nowIso(),
    };
    // Незавершённые раны — единственное, что растёт без границы: у процесса память, и
    // докупить её диском нельзя. Переполнение = отказ, а не тихое вытеснение живого рана.
    if (this.store.activeRuns() >= this.maxActiveRuns) {
      throw new ApiError('WORKER_DRAINING', `this API holds ${this.maxActiveRuns} unfinished runs; retry once one of them is terminal`, {
        maxActiveRuns: this.maxActiveRuns,
      });
    }
    this.store.put(record);
    // Ран уходит во внешнего воркера сразу: клиент получает receipt и опрашивает статус.
    void this.execute(record);
    this.log({
      event: 'submit',
      outcome: 'accepted',
      principalId: principal.principalId,
      requestId,
      userTaskId,
      runId: spec.runId,
      ownerGeneration,
      engine: spec.engine.name,
      worker: this.workerFor(spec.engine.name)?.baseUrl ?? null,
    });
    return { requestId, userTaskId, runId: spec.runId, deduplicated: false };
  }

  status(principal: Principal, runId: string): RunStatusView {
    const record = this.requireRun(principal, runId);
    const run = this.store.progressOf(runId);
    if (!run) {
      return {
        requestId: record.requestId,
        userTaskId: record.userTaskId,
        conversationId: record.spec.conversationId,
        runId,
        ownerGeneration: record.ownerGeneration,
        state: 'queued',
        cancelRequested: false,
        connectionLost: false,
        observedAt: record.createdAt,
        sequence: 0,
        fencing: { rejected: 0 },
        answer: null,
      };
    }
    return {
      requestId: record.requestId,
      userTaskId: record.userTaskId,
      conversationId: record.spec.conversationId,
      runId,
      ownerGeneration: record.ownerGeneration,
      state: run.state,
      cancelRequested: run.cancelRequested !== null,
      connectionLost: run.connectionLost,
      observedAt: run.updatedAt,
      sequence: run.sequence,
      fencing: { rejected: run.fencing.rejected },
      answer: run.answer,
    };
  }

  result(principal: Principal, runId: string): RunResult {
    const record = this.requireRun(principal, runId);
    const run = this.store.progressOf(runId);
    if (run?.result) return run.result;
    const state = run?.state ?? 'queued';
    throw new ApiError('RESULT_NOT_READY', `result is not available yet (state: ${state})`, {
      runId,
      requestId: record.requestId,
      state,
      connectionLost: run?.connectionLost ?? false,
    });
  }

  events(principal: Principal, runId: string, cursor = 0, limit = 500): EventsPage {
    this.requireRun(principal, runId);
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new ApiError('INVALID_REQUEST', 'cursor: expected non-negative integer');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new ApiError('INVALID_REQUEST', 'limit: expected integer in [1, 1000]');
    }
    const run = this.store.progressOf(runId);
    const available = run ? run.events.filter((event) => event.sequence > cursor) : [];
    const events = available.slice(0, limit);
    const hasMore = available.length > events.length;
    const nextCursor = events.length > 0 ? events[events.length - 1]!.sequence : cursor;
    const status = this.status(principal, runId);
    return {
      runId,
      events,
      cursor: nextCursor,
      hasMore,
      logUrl: run?.logUrl ?? null,
      droppedEvents: run?.droppedEvents ?? 0,
      snapshot: {
        state: status.state,
        connectionLost: status.connectionLost,
        sequence: status.sequence,
        ownerGeneration: status.ownerGeneration,
      },
    };
  }

  /**
   * Артефакты рана — ссылки на GitHub (epic #74, шаг 4). Байты API не хранит и не отдаёт:
   * воркер коммитит их в репозиторий юзера, мы возвращаем адрес файла в этом коммите.
   */
  artifacts(principal: Principal, runId: string): RunArtifactsView {
    const record = this.requireRun(principal, runId);
    const run = this.store.progressOf(runId);
    const repo = run?.repo ?? null;
    const artifacts: RunArtifactLink[] = (run?.artifacts ?? []).map((artifact: LaunchArtifact) => ({
      path: artifact.path,
      name: artifact.name,
      mime: artifact.mime,
      sha256: artifact.sha256,
      size: artifact.size,
      url: repo ? artifactUrl(repo, artifact.path) : artifact.path,
    }));
    return {
      runId,
      conversationId: record.spec.conversationId,
      userTaskId: record.userTaskId,
      repo,
      branchUrl: repo ? branchUrl(repo) : null,
      mergeUrl: repo ? mergeUrl(repo) : null,
      count: artifacts.length,
      artifacts,
      logUrl: run?.logUrl ?? null,
      note: 'the worker committed this run into its own branch of the user repository; the API stores no bytes and merges nothing',
    };
  }

  async cancel(principal: Principal, runId: string, rawBody: unknown = {}): Promise<RunCancelReceipt> {
    const record = this.requireRun(principal, runId);
    const bodyResult = validateCancelRequest(rawBody);
    if (!bodyResult.ok) {
      throw new ApiError('INVALID_REQUEST', `invalid cancel body: ${bodyResult.errors.join('; ')}`, { errors: bodyResult.errors });
    }
    const request = bodyResult.value;
    // Fencing: попытка отменить не то поколение рана — отказ, а не «остановлено».
    if (request.ownerGeneration !== undefined && request.ownerGeneration !== record.ownerGeneration) {
      this.store.bumpFencing(runId);
      throw new ApiError('STALE_OWNER_GENERATION', `cancel for ${runId} names ownerGeneration ${request.ownerGeneration}, the current one is ${record.ownerGeneration}`, {
        runId,
        ownerGeneration: record.ownerGeneration,
      });
    }
    const run = this.store.progressOf(runId);
    if (!run) throw new ApiError('INTERNAL', `run ${runId} has no in-memory progress`);
    if (isTerminalApiState(run.state)) {
      return { runId, status: 'already_terminal', state: run.state };
    }
    const worker = this.workerFor(record.spec.engine.name);
    if (!worker) {
      throw new ApiError('INTERNAL', `run ${runId} names engine "${record.spec.engine.name}", which is not configured on this API`);
    }
    this.store.markCancelRequested(runId, 'cancel');
    let receipt: WorkerCancelResult;
    try {
      receipt = await worker.cancel(runId);
    } catch (err) {
      this.log({ event: 'cancel_failed', runId, message: err instanceof Error ? err.message : String(err) });
      return { runId, status: 'rejected', reason: 'cancel request did not reach the worker' };
    }
    if (receipt.status === 'unknown_run') {
      // Ран есть в нашей памяти, но воркер его не видел — это отказ отмены, а не 404.
      return { runId, status: 'rejected', reason: 'the worker has not registered this run; the cancellation could not be delivered' };
    }
    if (receipt.status === 'rejected') {
      return { runId, status: 'rejected', reason: receipt.reason ?? 'the worker rejected the cancellation' };
    }
    // Ран мог финализироваться, пока отмена шла к воркеру.
    const current = this.store.progressOf(runId);
    if (current && isTerminalApiState(current.state)) {
      return { runId, status: 'already_terminal', state: current.state };
    }
    this.log({ event: 'cancel', principalId: principal.principalId, runId, status: receipt.status, ownerGeneration: record.ownerGeneration });
    return { runId, status: 'stop_pending', state: current?.state ?? run.state };
  }

  /**
   * Честная декларация возможностей (epic #74, шаг 7): изоляции на хосте API нет (её
   * обеспечивает воркер), движок один, байты артефактов и логов API не отдаёт.
   */
  capabilities(): ApiCapabilities {
    return {
      schemaVersion: API_CAPABILITIES_SCHEMA_VERSION,
      contract: { name: 'ai-agent-runner/serverless-agent-api', version: API_CONTRACT_VERSION },
      idempotency: {
        header: 'Idempotency-Key',
        repeatWithSameKey: 'same_receipt',
        newAttemptRequires: 'new_idempotency_key',
      },
      states: API_RUN_STATES,
      events: { cursor: true, replay: true, sse: true, lastEventId: true },
      disconnect: { connectionLostIsNotFailed: true, autoRerunOnDisconnect: false, outcomeUnknown: true },
      interaction: {
        awaitingUserInput: 'unsupported',
        engineResume: 'unsupported',
        continuation: {
          policy: 'new_run_same_user_task',
          userTaskIdStable: true,
          conversationIdStable: true,
          savedDataRefs: ['run_result', 'run_events', 'run_artifacts'],
        },
      },
      artifacts: {
        listPerRun: true,
        download: false,
        shareLink: false,
        ingestEndpoint: 'absent',
        ingestNote: 'artifacts are committed to the user repository by the external worker; the API stores no bytes',
        export: {
          enabled: false,
          declaredOutputs: false,
          manifest: false,
          partialManifestDeclared: false,
          engineRerunOnRecommit: false,
          soleCopyRetainedUntilDurable: false,
        },
        upload: {
          enabled: false,
          scopedSessions: false,
          presignedUrl: false,
          multipartResume: false,
          abortCleanup: false,
          maxTotalBytes: 0,
          ttlSeconds: 0,
        },
        snapshot: {
          enabled: false,
          versioning: false,
          conflictDetection: false,
          conflictPolicies: ['reject', 'overwrite', 'merge'],
          cleanRoomOnNewAttempt: false,
          materialize: {
            enabled: false,
            bytesInDurableStorage: false,
            verifyDigestOnWrite: false,
            ownerScoped: false,
            allOrNothing: false,
            refusalRetryableWhenStorageUnavailable: false,
            limits: { refs: 0, filesPerRef: 0, fileBytes: 0, totalBytes: 0 },
          },
        },
      },
      cancel: { requestedReceipt: true, terminalConfirmation: true },
      mcp: {
        perRunStdioProxy: false,
        scopedBindings: false,
        capabilityHandlersSharedWithMcp: false,
        capabilityInvokeEndpoint: false,
        remoteTransport: 'absent',
        osIsolation: 'not_proven_service_uid_only',
        osIsolationNote: 'the API host runs no agent process: OS isolation is the external worker responsibility, and the worker declares it per run',
      },
      isolation: {
        mode: 'none',
        slots: [],
        freeSlots: [],
        capability: 'not_proven_service_uid_only',
        launcher: null,
        failClosed: true,
      },
      promotion: {
        pinnedRelease: null,
        cohortEnabled: false,
        cohortId: 'none',
        rollbackAvailable: false,
        rolledBack: false,
        servingReleaseId: null,
        paidProfilesAllowed: null,
        sharedOwnerRegistry: false,
        takeoverRequiresExplicitSignal: true,
        partitionIsNotFailover: true,
        retentionPolicy: null,
        releaseEndpoint: 'absent',
        placement: null,
      },
      engines: this.engineNames(),
    };
  }

  health(): {
    status: 'ok';
    workers: Array<{ engine: string; baseUrl: string | null }>;
    runs: number;
    admissions: number;
    events: number;
  } {
    const counts = this.store.counts();
    return {
      status: 'ok',
      workers: this.workers.map((worker) => ({ engine: worker.name, baseUrl: worker.baseUrl })),
      ...counts,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.inFlight.clear();
  }

  /**
   * Ставит ран в работу и ведёт его поллером. Соединение не держится: воркер отвечает
   * квитанцией, дальше мы сами спрашиваем его о статусе и забираем результат.
   *
   * Поллер живёт в фоне и переживает запросы клиента: клиент опрашивает `status`/`events`
   * так же, как раньше, и видит прогресс без изменений со своей стороны.
   */
  /**
   * Перезапустить поллеры ранов, принятых воркером до рестарта API (§8.2 ревью).
   *
   * Без этого восстановленная из журнала приёмная запись навсегда оставалась `queued`:
   * результат не прочитать, а повтор клиента с новым ключом создавал бы второй ран —
   * ровно то окно, которое контракт (п. 2) обязан исключать. Это опрос существующего
   * запуска, а не повторный submit: новых запусков воркер не получает.
   */
  resumeDispatched(): number {
    let resumed = 0;
    for (const entry of this.store.dispatchedRuns()) {
      const record = this.store.getByRun(entry.runId);
      if (!record) continue;
      const progress = this.store.progressOf(entry.runId);
      if (progress && isTerminalApiState(progress.state)) continue;
      const worker = this.workerFor(record.spec.engine.name);
      if (!worker) continue;
      this.store.open(record.runId, record.createdAt);
      this.log({ event: 'poll_resumed', runId: record.runId, engine: record.spec.engine.name, operationId: record.spec.operationId });
      void this.pollUntilTerminal(record, worker, this.nowIso());
      resumed += 1;
    }
    return resumed;
  }

  private async execute(record: AdmissionRecord): Promise<void> {
    const run = this.store.open(record.runId, record.createdAt);
    const startedAt = this.nowIso();
    run.state = 'running';
    run.updatedAt = startedAt;
    // Журнал рана появляется до сетевого вызова: принятый ран виден сразу.
    this.store.append(record.runId, admissionEvents(record.spec, startedAt));
    const worker = this.workerFor(record.spec.engine.name);
    if (!worker) {
      this.finalize(record, workerTransportFailure(record.spec, new Error('worker is not configured'), { startedAt, finishedAt: this.nowIso() }));
      return;
    }
    this.inFlight.add(record.runId);
    try {
      const receipt = await worker.launch(record.spec);
      if (this.disposed || this.store.progressOf(record.runId) === null) return;
      this.log({
        event: 'worker_accepted',
        runId: record.runId,
        engine: record.spec.engine.name,
        worker: worker.baseUrl,
        operationId: receipt.operationId,
        statusUrl: receipt.statusUrl,
      });
      // Ран принят воркером. Помечаем ДО старта поллера: если процесс упадёт между
      // здесь и терминальным состоянием, новый процесс должен поллер перезапустить —
      // иначе результат потерян, а повтор клиента с новым ключом завёл бы второй ран.
      this.store.appendDispatched(record.runId, record.spec.engine.name, this.nowIso());
      void this.pollUntilTerminal(record, worker, startedAt);
    } catch (err) {
      if (this.disposed) return;
      this.log({ event: 'run_failed', runId: record.runId, message: err instanceof Error ? err.message : String(err) });
      this.finalize(record, workerTransportFailure(record.spec, err, { startedAt, finishedAt: this.nowIso() }, { workerBaseUrl: worker.baseUrl }));
    } finally {
      this.inFlight.delete(record.runId);
    }
  }

  /**
   * Опрос воркера до терминального статуса. Таймаут ожидания не означает, что ран не
   * состоялся: воркер мог принять задачу и даже завершить её, пока не было связи. Поэтому
   * по истечении бюджета ран переходит в `unknown`, а поллер продолжает reconcile —
   * спрашивать воркер о существующем запуске, не запуская заново.
   */
  private async pollUntilTerminal(record: AdmissionRecord, worker: ExternalWorker, startedAt: string): Promise<void> {
    const budgetMs = record.spec.limits.timeoutMs + this.resultGraceMs;
    const deadline = Date.now() + budgetMs;
    let attempt = 0;
    for (;;) {
      if (this.disposed || this.store.progressOf(record.runId) === null) return;
      let status: WorkerRunStatus;
      try {
        status = (await worker.status(record.runId)).status;
      } catch (err) {
        this.log({ event: 'worker_status_failed', runId: record.runId, message: err instanceof Error ? err.message : String(err) });
        status = 'unknown';
      }
      this.log({ event: 'worker_status', runId: record.runId, status, attempt });

      if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
        await this.collectResult(record, worker, startedAt);
        return;
      }
      if (status === 'unknown') {
        // Исход неизвестн, но ран мог состояться. Помечаем и продолжаем спрашивать:
        // следующий ответ воркера вернёт результат, и ран закроется нормально.
        this.markUnknown(record, 'worker_reported_unknown');
      }
      if (Date.now() >= deadline) {
        this.markUnknown(record, 'budget_exceeded');
        if (!this.inFlight.has(record.runId)) return;
        // Reconcile: воркер помнит operationId, поэтому мы можем спрашивать бесконечно,
        // не рискуя вторым запуском. Клиент видит unknown и решает сам.
        continue;
      }
      await this.pollBackoff(attempt);
      attempt += 1;
    }
  }

  /** Забрать финальный результат у воркера и закрыть ран. */
  private async collectResult(record: AdmissionRecord, worker: ExternalWorker, startedAt: string): Promise<void> {
    if (this.disposed || this.store.progressOf(record.runId) === null) return;
    try {
      const launch = await worker.result(record.runId);
      const mapping = mapLaunchResult(record.spec, launch, { startedAt, finishedAt: this.nowIso() }, { workerBaseUrl: worker.baseUrl });
      this.finalize(record, mapping);
      this.log({
        event: 'run_finished',
        runId: record.runId,
        outcome: mapping.result.outcome,
        exitReason: mapping.result.exitReason,
        exitCode: mapping.result.exitCode,
        artifacts: mapping.artifacts.length,
        logUrl: mapping.logUrl,
        repo: mapping.repo?.fullName ?? null,
      });
    } catch (err) {
      if (err instanceof ResultNotReadyError) {
        // Воркер сказал «терминальный», но результата нет: честный отказ, а не успех.
        this.log({ event: 'worker_result_missing', runId: record.runId });
        this.markUnknown(record, 'result_missing');
        return;
      }
      this.log({ event: 'run_failed', runId: record.runId, message: err instanceof Error ? err.message : String(err) });
      this.finalize(record, workerTransportFailure(record.spec, err, { startedAt, finishedAt: this.nowIso() }, { workerBaseUrl: worker.baseUrl }));
    }
  }

  /**
   * Перевод рана в `unknown`. Идемпотентно: повторный вызов не затирает уже терминальное
   * состояние и не плодит записей в журнале.
   */
  private markUnknown(record: AdmissionRecord, reason: string): void {
    const run = this.store.progressOf(record.runId);
    if (!run || isTerminalApiState(run.state) || run.state === 'unknown') return;
    run.state = 'unknown';
    run.updatedAt = this.nowIso();
    this.log({ event: 'run_outcome_unknown', runId: record.runId, reason, engine: record.spec.engine.name });
  }

  /** Экспоненциальная пауза опроса с потолком, чтобы не молотить воркер в пустую. */
  private async pollBackoff(attempt: number): Promise<void> {
    const delayMs = Math.min(POLL_MAX_DELAY_MS, POLL_BASE_DELAY_MS * 2 ** Math.min(attempt, 5));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  /** Воркер по имени движка. Имя движка — это адрес воркера, а не его внутренняя деталь. */
  private workerFor(engineName: string): ExternalWorker | undefined {
    return this.workers.find((worker) => worker.name === engineName);
  }

  private engineNames(): string[] {
    return [...this.workers.map((worker) => worker.name)].sort();
  }

  /** Единственное место, где ран становится терминальным. */
  private finalize(record: AdmissionRecord, mapping: LaunchMapping): void {
    this.store.append(record.runId, mapping.events);
    this.store.complete(record.runId, {
      state: mapping.result.outcome,
      result: mapping.result,
      artifacts: mapping.artifacts,
      repo: mapping.repo,
      logUrl: mapping.logUrl,
      answer: mapping.answer,
      finishedAt: mapping.result.finishedAt,
    });
  }

  /**
   * Идентификатор операции для внешнего worker, стабильный в пределах одной попытки.
   *
   * Воркер дедуплицирует запуски по `operationId` (контракт п. 2). Свежий id на каждый
   * submit делал дедупликацию бессмысленной: после рестарта API повтор с новым ключом
   * принёс бы воркеру новый `operationId`, и тот обязан был запустить второй агент
   * там, где первый ещё идёт. Ключ попытки — `(userTaskId, ownerGeneration)`: он
   * переживает рестарт и меняется ровно тогда, когда началась новая попытка.
   */
  private buildSpec(
    request: SubmitRequest,
    context: { principal: Principal; requestId: string; userTaskId: string; jobId: string; ownerGeneration: number },
  ): RunSpec {
    const runId = newApiId('run');
    const input: InputSpec = { ...(request.input ?? {}) };
    if (request.instructions !== undefined) {
      input.inlinePrompt = input.inlinePrompt
        ? `${input.inlinePrompt}\n\nAdditional instructions: ${request.instructions}`
        : request.instructions;
    }
    const spec: RunSpec = {
      contractVersion: 1,
      jobId: context.jobId,
      runId,
      operationId: attemptOperationId(context.userTaskId, context.ownerGeneration),
      userTaskId: context.userTaskId,
      profileId: context.principal.profileId,
      conversationId: request.conversationId ?? newApiId('conv'),
      ownerGeneration: context.ownerGeneration,
      engine: request.engine,
      // Каталог не создаётся: его материализует воркер на своей эфемерной машине.
      cwd: `/workspace/${runId}`,
      envAllowlist: request.envAllowlist,
      limits: request.limits,
    };
    if (Object.keys(input).length > 0) spec.input = input;
    if (request.deadline !== undefined) spec.deadline = request.deadline;
    if (request.regionConstraints !== undefined) spec.regionConstraints = request.regionConstraints;
    if (request.credentialBindings !== undefined) spec.credentialBindings = request.credentialBindings;
    if (request.budget !== undefined) spec.budget = request.budget;
    if (request.result !== undefined) spec.result = request.result;
    if (request.outputs !== undefined) spec.outputs = request.outputs;
    if (request.traceId !== undefined) spec.traceId = request.traceId;
    if (request.repository !== undefined) spec.repository = request.repository;
    else if (this.opts.defaultRepository !== undefined) spec.repository = { fullName: this.opts.defaultRepository };
    if (request.isolation !== undefined) spec.isolation = request.isolation;

    const validated = validateRunSpec(spec);
    if (!validated.ok) {
      throw new ApiError('INVALID_REQUEST', `assembled spec is invalid: ${validated.errors.join('; ')}`, { errors: validated.errors });
    }
    return validated.value;
  }

  private requireRun(principal: Principal, runId: string): AdmissionRecord {
    const record = this.store.getByRun(runId);
    if (!record || record.principalId !== principal.principalId) {
      throw new ApiError('NOT_FOUND', `unknown run ${runId}`);
    }
    return record;
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private log(entry: Record<string, unknown>): void {
    this.logger({ ts: this.nowIso(), ...entry });
  }
}

