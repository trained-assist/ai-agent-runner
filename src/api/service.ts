import { join } from 'node:path';
import type { EngineAdapter } from '../adapters/engine/engine-adapter.js';
import { killProcessTree } from '../adapters/engine/process-tree.js';
import type { BlobStore } from '../storage/blob-store.js';
import type { RunExportStore } from '../storage/export.js';
import type { UploadSessionStore } from '../storage/upload-session.js';
import type { WorkspaceSnapshotStore } from '../storage/workspace-snapshot.js';
import type { RunResult } from '../contracts/result.js';
import { stripRepositoryToken, validateRunSpec, type InputSpec, type RunSpec } from '../contracts/run-spec.js';
import type { FaultRegistry } from '../faults/registry.js';
import type { CapabilityRegistry } from '../mcp/capabilities.js';
import type { BindingValueResolver } from '../mcp/scope.js';
import { claimOwnership, decideAdmission, isPlacementRefusalCode, type AdmissionRefusalCode, type PlacementContext } from '../release/admission.js';
import type { CohortPolicy } from '../release/cohort.js';
import type { DispatchOwnerStore } from '../release/dispatch-owner.js';
import type { ReleaseManifest } from '../release/manifest.js';
import { allowedEnginesForRegion, placementSummary, type PlacementPolicy } from '../release/placement.js';
import type { PromotionJournal, ReleaseStateController } from '../release/promotion.js';
import { retentionHealth, type RetentionHealth } from '../release/retention.js';
import { Runner, type CancelReceipt, type RecoveryReport, type RunnerHostInfo, type RunSnapshot } from '../runner/runner.js';
import type { LogSink } from '../runner/scoped-log.js';
import { isTerminalState } from '../runner/state-machine.js';
import type { Principal } from './auth.js';
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
import { ApiError, type ApiErrorCode } from './errors.js';
import { ApiStore, API_STORE_SCHEMA_VERSION, type AdmissionRecord } from './store.js';
import type { CleanRoomProvider } from '../isolation/contract.js';
import type { EngineConfigTemplate } from '../isolation/engine-config.js';

export type ApiLogger = (entry: Record<string, unknown>) => void;

/**
 * Промоушен-контур P29: закреплённый релиз/конфиг, флаг когорты, состояние отката,
 * durable-журнал переходов и (в fleet-развёртывании) общий реестр владельцев задач.
 * Отсутствие этого блока означает одиночную установку без когортного флага — как раньше.
 */
export interface PromotionRuntime {
  manifest: ReleaseManifest;
  cohort: CohortPolicy;
  state: ReleaseStateController;
  journal: PromotionJournal;
  owners?: DispatchOwnerStore;
  /** Политика размещения (P30): регион × провайдер × credentials × резидентность. */
  placement?: PlacementPolicy;
}

export interface ReleaseView {
  schemaVersion: 1;
  release: {
    releaseId: string;
    sourceCommit: string;
    configVersion: number;
    builtAt: string;
    workerId: string;
    region: string;
    environment: string;
    roles: { schedule: boolean; delivery: boolean };
    engines: string[];
    paidEngines: string[];
    paidProfilesAllowed: boolean;
  };
  bindings: Array<{ name: string; required: boolean; source: string; owner: string; rotatedAt?: string }>;
  cohort: { cohortId: string; mode: string; rolloutPercent: number; principals: number };
  rollback: {
    releaseId: string;
    servingReleaseId: string;
    previousReleaseId: string | null;
    rolledBack: boolean;
    reason: string | null;
    updatedAt: string;
    transitions: number;
  };
  retention: RetentionHealth;
  fleet: ReturnType<DispatchOwnerStore['view']> | null;
  journal: { entries: number; lastSeq: number; lastKind: string | null };
  /** Политика размещения (P30): что этот воркер вообще имеет право запускать. */
  placement: Record<string, unknown> | null;
}

export interface AgentApiOptions {
  rootDir: string;
  adapters: Record<string, EngineAdapter>;
  host?: RunnerHostInfo;
  clock?: () => Date;
  faults?: FaultRegistry;
  logSink?: LogSink;
  logger?: ApiLogger;
  heartbeatIntervalMs?: number;
  cancelGraceMs?: number;
  /** Профильное хранилище для следов задач (profiles/<id>/trace.jsonl) — см. RunnerOptions.blob. */
  blob?: BlobStore;
  /** Манифесты экспорта артефактов — см. RunnerOptions.exports (P07). */
  exports?: RunExportStore;
  /** Сессии прямой загрузки артефактов — см. RunnerOptions.uploads (P08). */
  uploads?: UploadSessionStore;
  /** Снимки workspace — см. RunnerOptions.snapshots (P09). */
  snapshots?: WorkspaceSnapshotStore;
  /** Реестр capability handler'ов (P13) — общий для MCP-вызовов рана и этого API. */
  capabilities?: CapabilityRegistry;
  /** Резолвер значений credential binding'ов (P13). */
  bindingResolver?: BindingValueResolver;
  /** Граница Agent clean room (issue #51): per-run Unix-идентичность вместо service UID. */
  isolation?: CleanRoomProvider;
  /** Хостовые шаблоны конфигурации движка для run-scoped HOME — см. RunnerOptions. */
  engineConfigTemplates?: EngineConfigTemplate | null;
  /**
   * Оставлять рабочие каталоги ранов после финализации (диагностика/отладка). По
   * умолчанию каталог снимается вместе с уборкой, и `cleanup: completed` означает
   * проверенное его отсутствие (issue #52).
   */
  retainWorkspaces?: boolean;
  /** Промоушен-контур P29: pinned release, когорта, откат, журнал, реестр владельцев. */
  promotion?: PromotionRuntime;
}

export interface ServiceRecoveryReport extends RecoveryReport {
  healed: number;
}

const defaultLogger: ApiLogger = (entry) => {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

export class AgentApi {
  readonly runner: Runner;
  readonly store: ApiStore;
  private readonly opts: AgentApiOptions;
  private readonly logger: ApiLogger;
  private readonly clock: () => Date;

  constructor(options: AgentApiOptions) {
    this.opts = options;
    this.store = new ApiStore(options.rootDir);
    this.store.init();
    this.logger = options.logger ?? defaultLogger;
    this.clock = options.clock ?? (() => new Date());
    const runnerOptions: ConstructorParameters<typeof Runner>[0] = {
      rootDir: options.rootDir,
      adapters: options.adapters,
    };
    if (options.host) runnerOptions.host = options.host;
    if (options.blob) runnerOptions.blob = options.blob;
    if (options.exports) runnerOptions.exports = options.exports;
    if (options.uploads) runnerOptions.uploads = options.uploads;
    if (options.snapshots) runnerOptions.snapshots = options.snapshots;
    if (options.clock) runnerOptions.clock = options.clock;
    if (options.faults) runnerOptions.faults = options.faults;
    if (options.logSink) runnerOptions.logSink = options.logSink;
    if (options.heartbeatIntervalMs !== undefined) runnerOptions.heartbeatIntervalMs = options.heartbeatIntervalMs;
    if (options.cancelGraceMs !== undefined) runnerOptions.cancelGraceMs = options.cancelGraceMs;
    if (options.capabilities) runnerOptions.capabilities = options.capabilities;
    if (options.bindingResolver) runnerOptions.bindingResolver = options.bindingResolver;
    if (options.isolation) runnerOptions.isolation = options.isolation;
    if (options.engineConfigTemplates) runnerOptions.engineConfigTemplates = options.engineConfigTemplates;
    if (options.retainWorkspaces !== undefined) runnerOptions.retainWorkspaces = options.retainWorkspaces;
    this.runner = new Runner(runnerOptions);
  }

  async recover(): Promise<ServiceRecoveryReport> {
    const report = await this.runner.recover();
    let healed = 0;
    for (const record of this.store.listAll()) {
      if (this.runner.getRun(record.runId)) continue;
      if (this.startAdmission(record)) healed += 1;
    }
    this.log({
      event: 'recovered',
      scanned: report.scanned,
      resumedQueued: report.resumedQueued,
      orphaned: report.orphaned,
      lost: report.lost,
      finalizingResumed: report.finalizingResumed,
      terminal: report.terminal,
      healed,
    });
    return { ...report, healed };
  }

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
      const current = this.store.currentAttempt(principal.principalId, existing.userTaskId) ?? existing;
      this.heal(current);
      this.log({
        event: 'submit',
        outcome: 'duplicate',
        principalId: principal.principalId,
        requestId: current.requestId,
        userTaskId: current.userTaskId,
        runId: current.runId,
        ownerGeneration: current.ownerGeneration,
      });
      return { requestId: current.requestId, userTaskId: current.userTaskId, runId: current.runId, deduplicated: true };
    }

    if (principal.engines && !principal.engines.includes(request.engine.name)) {
      throw new ApiError(
        'ENGINE_NOT_ALLOWED',
        `principal "${principal.principalId}" is not allowed to run engine "${request.engine.name}"`,
        { engines: [...principal.engines] },
      );
    }

    // Откат релиза и флаг когорты проверяются ДО любой записи: отказ не должен оставить
    // ни admission-записи, ни рана (иначе «откат» означал бы half-принятые задачи).
    const admission = this.decideAdmission(principal, request);

    let requestId: string;
    let userTaskId: string;
    let jobId: string;
    let ownerGeneration: number;
    if (request.userTaskId) {
      const prior = this.store.currentAttempt(principal.principalId, request.userTaskId);
      if (prior) {
        const priorRun = this.heal(prior);
        if (!priorRun) {
          throw new ApiError('INTERNAL', `previous attempt of task ${prior.userTaskId} could not be reconciled; refusing to risk a second copy`);
        }
        if (!isTerminalState(priorRun.state)) {
          throw new ApiError(
            'TASK_ATTEMPT_ACTIVE',
            `task ${prior.userTaskId} already has an active attempt in state "${priorRun.state}"; cancel it before starting the next attempt`,
            { runId: priorRun.runId, state: priorRun.state },
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
    // Реестр владельцев (fleet): решение о владении принимается один раз на задачу и
    // определяет ownerGeneration. Отказ = «не запускай вторую копию», а не «попробуй ещё раз».
    const ownership = this.claimOwnership(principal, userTaskId, spec.runId);
    if (ownership) ownerGeneration = ownership;
    if (ownership !== undefined) {
      spec.ownerGeneration = ownership;
      const revalidated = validateRunSpec(spec);
      if (!revalidated.ok) {
        throw new ApiError('INVALID_REQUEST', `assembled spec is invalid: ${revalidated.errors.join('; ')}`, { errors: revalidated.errors });
      }
    }
    const record: AdmissionRecord = {
      schemaVersion: API_STORE_SCHEMA_VERSION,
      requestId,
      userTaskId,
      principalId: principal.principalId,
      jobId,
      idempotencyKey,
      payloadHash,
      runId: spec.runId,
      operationId: spec.operationId,
      ownerGeneration,
      spec,
      createdAt: this.nowIso(),
    };
    this.store.put(record);
    if (!this.startAdmission(record)) {
      throw new ApiError('INTERNAL', 'accepted request could not be started', { requestId, runId: spec.runId });
    }
    this.log({
      event: 'submit',
      outcome: 'accepted',
      principalId: principal.principalId,
      requestId,
      userTaskId,
      runId: spec.runId,
      ownerGeneration,
      engine: spec.engine.name,
      ...(admission.admit
        ? {
            cohortId: admission.cohortId,
            cohortReason: admission.cohortReason,
            cohortBucket: admission.bucket,
            servingReleaseId: admission.servingReleaseId,
            ...(admission.placement
              ? {
                  placement: {
                    workerId: admission.placement.workerId,
                    region: admission.placement.region,
                    provider: admission.placement.provider,
                    policyId: admission.placement.policyId,
                  },
                }
              : {}),
          }
        : {}),
    });
    return { requestId, userTaskId, runId: spec.runId, deduplicated: false };
  }

  /**
   * Декларация развёрнутого релиза для control plane (P29): что закреплено, кто владелец,
   * когорта, откат, retention. Значений секретов здесь нет — только имена binding'ов.
   */
  release(): ReleaseView | null {
    const promotion = this.opts.promotion;
    if (!promotion) return null;
    const manifest = promotion.manifest;
    const state = promotion.state.snapshot();
    const journal = promotion.journal.list();
    const runs = this.runner
      .listRunIds()
      .map((runId) => this.runner.getRun(runId))
      .filter((snapshot): snapshot is RunSnapshot => snapshot !== null)
      .map((snapshot) => ({ runId: snapshot.runId, state: snapshot.state, updatedAt: snapshot.updatedAt }));
    const retention = retentionHealth({ policy: manifest.retention, runs, now: this.clock() });
    return {
      schemaVersion: 1,
      release: {
        releaseId: manifest.releaseId,
        sourceCommit: manifest.sourceCommit,
        configVersion: manifest.configVersion,
        builtAt: manifest.builtAt,
        workerId: manifest.host.workerId,
        region: manifest.host.region,
        environment: manifest.host.environment,
        roles: manifest.host.roles,
        engines: [...manifest.engines],
        paidEngines: [...manifest.paid.engines],
        paidProfilesAllowed: manifest.paid.allowed,
      },
      bindings: manifest.bindings.map((binding) => ({
        name: binding.name,
        required: binding.required,
        source: binding.source,
        owner: binding.owner,
        ...(binding.rotatedAt !== undefined ? { rotatedAt: binding.rotatedAt } : {}),
      })),
      cohort: {
        cohortId: promotion.cohort.cohortId,
        mode: promotion.cohort.mode,
        rolloutPercent: promotion.cohort.rolloutPercent,
        principals: promotion.cohort.principals.length,
      },
      rollback: {
        releaseId: state.releaseId,
        servingReleaseId: state.servingReleaseId,
        previousReleaseId: state.previousReleaseId,
        rolledBack: state.rolledBack,
        reason: state.reason,
        updatedAt: state.updatedAt,
        transitions: state.transitions,
      },
      retention,
      fleet: promotion.owners ? promotion.owners.view() : null,
      journal: {
        entries: journal.length,
        lastSeq: journal.length > 0 ? journal[journal.length - 1]!.seq : 0,
        lastKind: journal.length > 0 ? journal[journal.length - 1]!.kind : null,
      },
      placement: promotion.placement ? placementSummary(promotion.placement) : null,
    };
  }

  status(principal: Principal, runId: string): RunStatusView {
    const record = this.requireRun(principal, runId);
    const snapshot = this.runner.getRun(runId);
    if (!snapshot) {
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
      };
    }
    return {
      requestId: record.requestId,
      userTaskId: record.userTaskId,
      conversationId: record.spec.conversationId,
      runId,
      ownerGeneration: snapshot.ownerGeneration,
      state: snapshot.state,
      cancelRequested: snapshot.cancelRequested !== null,
      connectionLost: snapshot.connectionLost,
      observedAt: snapshot.updatedAt,
      sequence: snapshot.sequence,
      fencing: { rejected: snapshot.fencing.rejected },
    };
  }

  /**
   * Декларация возможностей развёрнутого Runner (см. ApiCapabilities): приёмник читает её
   * вместо догадок о resume/awaiting_user и о правилах новой попытки.
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
        download: true,
        shareLink: true,
        ingestEndpoint: 'absent',
        ingestNote: 'artifacts are registered out-of-band (slice D2: POST /v1/artifacts)',
        export: {
          enabled: this.opts.exports !== undefined,
          declaredOutputs: true,
          manifest: true,
          partialManifestDeclared: true,
          engineRerunOnRecommit: false,
          soleCopyRetainedUntilDurable: true,
        },
        upload: {
          enabled: this.opts.uploads !== undefined,
          scopedSessions: true,
          presignedUrl: true,
          multipartResume: true,
          abortCleanup: true,
          maxTotalBytes: this.opts.uploads?.maxTotalBytes ?? 512 * 1024 * 1024,
          ttlSeconds: this.opts.uploads?.ttlSeconds ?? 300,
        },
        snapshot: {
          enabled: this.opts.snapshots !== undefined,
          versioning: true,
          conflictDetection: true,
          conflictPolicies: ['reject', 'overwrite', 'merge'] as const,
          cleanRoomOnNewAttempt: true,
        },
      },
      mcp: {
        perRunStdioProxy: this.opts.capabilities !== undefined,
        scopedBindings: true,
        capabilityHandlersSharedWithMcp: this.opts.capabilities !== undefined,
        capabilityInvokeEndpoint: this.opts.capabilities !== undefined,
        remoteTransport: 'absent',
        osIsolation: this.isolationCapability(),
        osIsolationNote: this.isolationNote(),
      },
      isolation: this.isolationView(),
      cancel: { requestedReceipt: true, terminalConfirmation: true },
      /**
       * Промоушен (P29). Объявляется честно: без promotion-контура когорты и отката нет,
       * платные профили считаются выключенными только когда это объявлено манифестом.
       */
      promotion: this.opts.promotion
        ? {
            pinnedRelease: {
              releaseId: this.opts.promotion.manifest.releaseId,
              sourceCommit: this.opts.promotion.manifest.sourceCommit,
              configVersion: this.opts.promotion.manifest.configVersion,
            },
            cohortEnabled: this.opts.promotion.cohort.mode !== 'off',
            cohortId: this.opts.promotion.cohort.cohortId,
            rollbackAvailable: true,
            rolledBack: this.opts.promotion.state.paused,
            servingReleaseId: this.opts.promotion.state.snapshot().servingReleaseId,
            paidProfilesAllowed: this.opts.promotion.manifest.paid.allowed,
            sharedOwnerRegistry: this.opts.promotion.owners !== undefined,
            takeoverRequiresExplicitSignal: true,
            partitionIsNotFailover: true,
            retentionPolicy: this.opts.promotion.manifest.retention,
            releaseEndpoint: '/v1/release',
            placement: this.opts.promotion.placement
              ? {
                  policyId: this.opts.promotion.placement.policyId,
                  authority: this.opts.promotion.placement.authority,
                  workerRegion: this.opts.promotion.manifest.host.region,
                  allowedEngines: allowedEnginesForRegion(this.opts.promotion.placement, this.opts.promotion.manifest.host.region),
                  dataResidencyDecided: this.opts.promotion.placement.dataResidency.decided,
                  dataResidencyDecisionRef: this.opts.promotion.placement.dataResidency.decisionRef,
                  checkedBefore: 'paid_profile_and_cohort',
                  runnerRechecksEngineRegion: true,
                }
              : null,
          }
        : {
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
      engines: Object.keys(this.opts.adapters).sort(),
    };
  }

  private isolationCapability(): ApiCapabilities['isolation']['capability'] {
    return this.opts.isolation?.capability() ?? 'not_proven_service_uid_only';
  }

  private isolationNote(): string {
    const isolation = this.opts.isolation;
    if (!isolation) {
      return 'no clean room isolation provider is configured on this host: the engine runs under the service UID, which is not a proven OS isolation boundary (ARCHITECTURE §9, карточка P13)';
    }
    const capability = isolation.capability();
    if (capability === 'per_run_unix_identity_verified') {
      return `every run executes under its own leased unix identity (slots: ${isolation.policy.slots.join(', ')}), with run-scoped HOME/config/cache/tmp and a boundary probe before spawn; per-run MCP processes run under the same identity`;
    }
    return 'isolation provider is configured but its self-test failed: runs are refused instead of falling back to the service UID';
  }

  private isolationView(): ApiCapabilities['isolation'] {
    const isolation = this.opts.isolation;
    if (!isolation) {
      return { mode: 'none', slots: [], freeSlots: [], capability: 'not_proven_service_uid_only', launcher: null, failClosed: true };
    }
    return {
      mode: isolation.policy.mode,
      slots: [...isolation.policy.slots],
      freeSlots: isolation.freeSlots(),
      capability: isolation.capability(),
      launcher: isolation.launcher?.kind ?? null,
      failClosed: true,
    };
  }

  async cancel(principal: Principal, runId: string, rawBody: unknown = {}): Promise<CancelReceipt> {
    const record = this.requireRun(principal, runId);
    const bodyResult = validateCancelRequest(rawBody);
    if (!bodyResult.ok) {
      throw new ApiError('INVALID_REQUEST', `invalid cancel body: ${bodyResult.errors.join('; ')}`, { errors: bodyResult.errors });
    }
    const request = bodyResult.value;
    const snapshot = this.heal(record);
    if (!snapshot) throw new ApiError('INTERNAL', `run ${runId} could not be reconciled for cancel`);
    const ownerGeneration = request.ownerGeneration ?? snapshot.ownerGeneration;
    const receipt = await this.runner.cancel(runId, ownerGeneration);
    if (receipt.status === 'unknown_run') throw new ApiError('NOT_FOUND', `unknown run ${runId}`);
    this.log({
      event: 'cancel',
      principalId: principal.principalId,
      runId,
      status: receipt.status,
      ownerGeneration,
      state: receipt.state ?? snapshot.state,
    });
    return receipt;
  }

  result(principal: Principal, runId: string): RunResult {
    const record = this.requireRun(principal, runId);
    const snapshot = this.runner.getRun(runId);
    if (snapshot?.finalized && snapshot.result) return snapshot.result;
    const state = snapshot?.state ?? 'queued';
    throw new ApiError('RESULT_NOT_READY', `result is not available yet (state: ${state})`, {
      runId,
      requestId: record.requestId,
      state,
      connectionLost: snapshot?.connectionLost ?? false,
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
    const available = this.runner.events(runId, cursor);
    const events = available.slice(0, limit);
    const hasMore = available.length > events.length;
    const nextCursor = events.length > 0 ? events[events.length - 1]!.sequence : cursor;
    const snapshot = this.status(principal, runId);
    return {
      runId,
      events,
      cursor: nextCursor,
      hasMore,
      snapshot: {
        state: snapshot.state,
        connectionLost: snapshot.connectionLost,
        sequence: snapshot.sequence,
        ownerGeneration: snapshot.ownerGeneration,
      },
    };
  }

  dispose(options: { killProcesses?: boolean } = {}): void {
    const killProcesses = options.killProcesses ?? true;
    if (killProcesses) {
      for (const runId of this.runner.listRunIds()) {
        const snapshot = this.runner.getRun(runId);
        if (snapshot && !isTerminalState(snapshot.state)) {
          killProcessTree(snapshot.pgid, snapshot.pid, 'SIGKILL');
        }
      }
    }
    this.runner.dispose();
  }

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
      operationId: newApiId('op'),
      userTaskId: context.userTaskId,
      profileId: context.principal.profileId,
      conversationId: request.conversationId ?? newApiId('conv'),
      ownerGeneration: context.ownerGeneration,
      engine: request.engine,
      cwd: join(this.opts.rootDir, 'workspaces', runId),
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
    // Требование границы доходит до рана: без него запрос `per_run_unix_identity` на хосте
    // без провайдера не отличался бы от обычного и тихо ушёл бы под service UID, а
    // запрос `none` всё равно получил бы чистую среду.
    if (request.isolation !== undefined) spec.isolation = request.isolation;

    const validated = validateRunSpec(spec);
    if (!validated.ok) {
      throw new ApiError('INVALID_REQUEST', `assembled spec is invalid: ${validated.errors.join('; ')}`, { errors: validated.errors });
    }
    return validated.value;
  }

  /**
 * Приёмная политика промоушена. Без promotion-контура поведение прежнее: одиночная
 * установка принимает всё, что разрешено движком и scope. С контуром — отказ пишется и в
 * лог, и в durable-журнал: «почему задача не принята» должно читаться без request'а.
 */
  private decideAdmission(principal: Principal, request: SubmitRequest) {
    const promotion = this.opts.promotion;
    if (!promotion) {
      return {
        admit: true as const,
        cohortId: 'none',
        cohortReason: 'cohort_off' as const,
        bucket: 0,
        releaseId: '',
        servingReleaseId: '',
        placement: null,
      };
    }
    const placementContext: PlacementContext | undefined = promotion.placement
      ? { policy: promotion.placement, workerId: promotion.manifest.host.workerId, region: promotion.manifest.host.region }
      : undefined;
    const decision = decideAdmission(
      {
        manifest: promotion.manifest,
        cohort: promotion.cohort,
        state: promotion.state.snapshot(),
        ...(placementContext ? { placement: placementContext } : {}),
      },
      {
        principalId: principal.principalId,
        engineName: request.engine.name,
        placement: {
          engineName: request.engine.name,
          ...(request.engine.modelSettings?.model !== undefined ? { model: request.engine.modelSettings.model } : {}),
          ...(request.credentialBindings !== undefined
            ? { credentialBindings: request.credentialBindings.map((binding) => ({ ref: binding.ref, scope: binding.scope })) }
            : {}),
          ...(request.regionConstraints !== undefined ? { regionConstraints: request.regionConstraints } : {}),
        },
      },
    );
    if (decision.admit) {
      this.log({
        event: 'placement_admitted',
        principalId: principal.principalId,
        engine: request.engine.name,
        ...(decision.placement
          ? {
              placement: {
                workerId: decision.placement.workerId,
                region: decision.placement.region,
                provider: decision.placement.provider,
                policyId: decision.placement.policyId,
                reasons: decision.placement.reasons,
              },
            }
          : {}),
      });
      return decision;
    }
    // Отказ по размещению — отдельный вид журнала: «почему воркер не взял задачу» должно
    // читаться без request'а и отличаться от отказов по когорте/оплате (P30, AC-175).
    const kind = isPlacementRefusalCode(decision.code) ? 'placement_refused' : 'admission_refused';
    this.refuseAdmission(decision, principal.principalId, kind);
  }

  private refuseAdmission(
    refusal: { admit: false; code: AdmissionRefusalCode; reason: string; detail: Record<string, unknown> },
    principalId: string,
    kind: 'admission_refused' | 'placement_refused' = 'admission_refused',
  ): never {
    const promotion = this.opts.promotion;
    promotion?.journal.append({
      kind,
      reason: refusal.reason,
      cohortId: promotion?.cohort.cohortId,
      detail: { code: refusal.code, principalId, ...refusal.detail },
    });
    this.log({
      event: kind,
      principalId,
      code: refusal.code,
      reason: refusal.reason,
      ...refusal.detail,
    });
    throw new ApiError(refusal.code, refusal.reason, refusal.detail);
  }

  /**
   * Claim владения в общем реестре флота. Возвращает поколение, если владение выдано,
   * `undefined` — если реестр не настроен (одиночная установка).
   */
  private claimOwnership(principal: Principal, userTaskId: string, runId: string): number | undefined {
    const owners = this.opts.promotion?.owners;
    if (!owners) return undefined;
    const claim = claimOwnership(owners, principal.principalId, userTaskId, runId);
    if (claim.admit) {
      this.log({
        event: 'ownership_claimed',
        principalId: principal.principalId,
        userTaskId,
        runId,
        ownerWorkerId: owners.workerId,
        ownerGeneration: claim.ownerGeneration,
      });
      return claim.ownerGeneration;
    }
    this.refuseAdmission(claim, principal.principalId);
  }

  private requireRun(principal: Principal, runId: string): AdmissionRecord {
    const record = this.store.getByRun(runId);
    if (!record || record.principalId !== principal.principalId) {
      throw new ApiError('NOT_FOUND', `unknown run ${runId}`);
    }
    return record;
  }

  private heal(record: AdmissionRecord): RunSnapshot | null {
    const existing = this.runner.getRun(record.runId);
    if (existing) return existing;
    return this.startAdmission(record) ? this.runner.getRun(record.runId) : null;
  }

  private startAdmission(record: AdmissionRecord): boolean {
    try {
      this.runner.start(record.spec, record.operationId);
      return true;
    } catch (err) {
      this.log({
        event: 'admission_start_failed',
        runId: record.runId,
        requestId: record.requestId,
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      // токен передан в runner (там живёт только до clone) — в admission-записи он не остаётся
      stripRepositoryToken(record.spec);
    }
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private log(entry: Record<string, unknown>): void {
    this.logger({ ts: this.nowIso(), ...entry });
  }
}
