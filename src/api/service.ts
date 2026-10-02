import { join } from 'node:path';
import type { EngineAdapter } from '../adapters/engine/engine-adapter.js';
import { killProcessTree } from '../adapters/engine/process-tree.js';
import type { BlobStore } from '../storage/blob-store.js';
import type { RunExportStore } from '../storage/export.js';
import type { UploadSessionStore } from '../storage/upload-session.js';
import type { RunResult } from '../contracts/result.js';
import { stripRepositoryToken, validateRunSpec, type InputSpec, type RunSpec } from '../contracts/run-spec.js';
import type { FaultRegistry } from '../faults/registry.js';
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
import { ApiError } from './errors.js';
import { ApiStore, API_STORE_SCHEMA_VERSION, type AdmissionRecord } from './store.js';

export type ApiLogger = (entry: Record<string, unknown>) => void;

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
    if (options.clock) runnerOptions.clock = options.clock;
    if (options.faults) runnerOptions.faults = options.faults;
    if (options.logSink) runnerOptions.logSink = options.logSink;
    if (options.heartbeatIntervalMs !== undefined) runnerOptions.heartbeatIntervalMs = options.heartbeatIntervalMs;
    if (options.cancelGraceMs !== undefined) runnerOptions.cancelGraceMs = options.cancelGraceMs;
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
    });
    return { requestId, userTaskId, runId: spec.runId, deduplicated: false };
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
      },
      cancel: { requestedReceipt: true, terminalConfirmation: true },
      engines: Object.keys(this.opts.adapters).sort(),
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
    if (request.traceId !== undefined) spec.traceId = request.traceId;
    if (request.repository !== undefined) spec.repository = request.repository;

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
