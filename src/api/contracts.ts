import { createHash, randomUUID } from 'node:crypto';
import type { RunnerEvent } from '../contracts/events.js';
import type { RunResult } from '../contracts/result.js';
import {
  canonicalJson,
  redactRepositoryToken,
  validateRunSpec,
  type BudgetSpec,
  type CredentialBinding,
  type EngineSpec,
  type InputSpec,
  type OutputSpec,
  type RegionConstraints,
  type RepositorySpec,
  type ResultPolicy,
  type RunLimits,
  type RunSpec,
} from '../contracts/run-spec.js';
import { ErrorCollector, checkKeys, checkObject, checkString, type ValidationResult } from '../contracts/validate.js';

export const API_RUN_STATES = ['queued', 'starting', 'running', 'awaiting_user', 'finalizing', 'succeeded', 'failed', 'cancelled'] as const;

export type ApiRunState = (typeof API_RUN_STATES)[number];

export interface SubmitRequest {
  userTaskId?: string;
  conversationId?: string;
  engine: EngineSpec;
  input?: InputSpec;
  envAllowlist: string[];
  limits: RunLimits;
  deadline?: string;
  regionConstraints?: RegionConstraints;
  credentialBindings?: CredentialBinding[];
  budget?: BudgetSpec;
  result?: ResultPolicy;
  outputs?: OutputSpec[];
  traceId?: string;
  instructions?: string;
  repository?: RepositorySpec;
}

export interface Receipt {
  requestId: string;
  userTaskId: string;
  runId: string;
}

export interface SubmitResponse extends Receipt {
  deduplicated: boolean;
}

export interface RunStatusView {
  requestId: string;
  userTaskId: string;
  conversationId: string;
  runId: string;
  ownerGeneration: number;
  state: ApiRunState;
  cancelRequested: boolean;
  connectionLost: boolean;
  observedAt: string;
  sequence: number;
  fencing: { rejected: number };
}

export interface EventsPage {
  runId: string;
  events: RunnerEvent[];
  cursor: number;
  hasMore: boolean;
  snapshot: {
    state: ApiRunState;
    connectionLost: boolean;
    sequence: number;
    ownerGeneration: number;
  };
}

export interface CancelRequest {
  ownerGeneration?: number;
  reason?: string;
}

/**
 * Декларация поддержки контракта (SERVERLESS-AGENT-API.md §«Логический API», §«Потеря связи,
 * повторный запуск и сохранение данных»). Нужна приёмнику, чтобы НЕ угадывать возможности Runner:
 * resume движка и awaiting_user у нас не поддержаны, продолжение — новая попытка с тем же
 * userTaskId/conversationId, потеря связи не равна failed и не запускает rerun.
 */
export interface ApiCapabilities {
  schemaVersion: 1;
  contract: { name: 'ai-agent-runner/serverless-agent-api'; version: number };
  idempotency: {
    header: 'Idempotency-Key';
    repeatWithSameKey: 'same_receipt';
    newAttemptRequires: 'new_idempotency_key';
  };
  states: readonly ApiRunState[];
  events: { cursor: true; replay: true; sse: true; lastEventId: true };
  disconnect: { connectionLostIsNotFailed: true; autoRerunOnDisconnect: false; outcomeUnknown: true };
  interaction: {
    awaitingUserInput: 'unsupported';
    engineResume: 'unsupported';
    continuation: {
      policy: 'new_run_same_user_task';
      userTaskIdStable: true;
      conversationIdStable: true;
      savedDataRefs: readonly ('run_result' | 'run_events' | 'run_artifacts')[];
    };
  };
  artifacts: {
    listPerRun: true;
    download: true;
    shareLink: true;
    ingestEndpoint: 'absent';
    ingestNote: 'artifacts are registered out-of-band (slice D2: POST /v1/artifacts)';
    /** Экспорт объявленных выходов рана в object storage с закоммиченным манифестом. */
    export: {
      enabled: boolean;
      declaredOutputs: boolean;
      manifest: boolean;
      partialManifestDeclared: boolean;
      engineRerunOnRecommit: false;
      soleCopyRetainedUntilDurable: true;
    };
    /** Прямая загрузка артефактов через скопированные сессии и presigned URL. */
    upload: {
      enabled: boolean;
      scopedSessions: true;
      presignedUrl: boolean;
      multipartResume: true;
      abortCleanup: true;
      maxTotalBytes: number;
      ttlSeconds: number;
    };
  };
  cancel: { requestedReceipt: true; terminalConfirmation: true };
  engines: string[];
}

export const API_CAPABILITIES_SCHEMA_VERSION = 1 as const;
export const API_CONTRACT_VERSION = 1 as const;

const SUBMIT_KEYS = [
  'userTaskId',
  'conversationId',
  'engine',
  'input',
  'envAllowlist',
  'limits',
  'deadline',
  'regionConstraints',
  'credentialBindings',
  'budget',
  'result',
  'outputs',
  'traceId',
  'instructions',
  'repository',
] as const;

const SUBMIT_REQUIRED = ['engine', 'limits'] as const;

const CANCEL_KEYS = ['ownerGeneration', 'reason'] as const;

export function newApiId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function submitPayloadHash(request: SubmitRequest): string {
  // hash считается без repository.token: идентичность payload не зависит от токена
  return createHash('sha256').update(canonicalJson(redactRepositoryToken(request))).digest('hex');
}

export function validateSubmitRequest(input: unknown): ValidationResult<SubmitRequest> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'request', collector)) return collector.finish(undefined as never);
  checkKeys(input, SUBMIT_KEYS, SUBMIT_REQUIRED, 'request', collector);
  if (input['userTaskId'] !== undefined) checkString(input['userTaskId'], 'request.userTaskId', collector, 200);
  if (input['conversationId'] !== undefined) checkString(input['conversationId'], 'request.conversationId', collector, 200);
  if (input['instructions'] !== undefined) checkString(input['instructions'], 'request.instructions', collector, 10_000);
  if (!collector.ok) return collector.finish(undefined as never);

  const specLike: Record<string, unknown> = {
    contractVersion: 1,
    jobId: 'job.pending',
    runId: 'run.pending',
    operationId: 'op.pending',
    userTaskId: typeof input['userTaskId'] === 'string' ? input['userTaskId'] : 'task.generated',
    profileId: 'profile.generated',
    conversationId: typeof input['conversationId'] === 'string' ? input['conversationId'] : 'conv.generated',
    ownerGeneration: 1,
    engine: input['engine'],
    cwd: '/pending',
    envAllowlist: input['envAllowlist'] ?? [],
    limits: input['limits'],
  };
  for (const key of ['input', 'deadline', 'regionConstraints', 'credentialBindings', 'budget', 'result', 'outputs', 'traceId', 'repository'] as const) {
    if (input[key] !== undefined) specLike[key] = input[key];
  }

  const specResult = validateRunSpec(specLike);
  if (!specResult.ok) {
    const errors = specResult.errors.map((message) => (message.startsWith('spec.') ? `request.${message.slice('spec.'.length)}` : message));
    return { ok: false, errors };
  }

  const spec: RunSpec = specResult.value;
  const request: SubmitRequest = {
    engine: spec.engine,
    envAllowlist: spec.envAllowlist,
    limits: spec.limits,
  };
  if (spec.input !== undefined) request.input = spec.input;
  if (spec.deadline !== undefined) request.deadline = spec.deadline;
  if (spec.regionConstraints !== undefined) request.regionConstraints = spec.regionConstraints;
  if (spec.credentialBindings !== undefined) request.credentialBindings = spec.credentialBindings;
  if (spec.budget !== undefined) request.budget = spec.budget;
  if (spec.result !== undefined) request.result = spec.result;
  if (spec.outputs !== undefined) request.outputs = spec.outputs;
  if (spec.traceId !== undefined) request.traceId = spec.traceId;
  if (spec.repository !== undefined) request.repository = spec.repository;
  if (typeof input['userTaskId'] === 'string') request.userTaskId = input['userTaskId'];
  if (typeof input['conversationId'] === 'string') request.conversationId = input['conversationId'];
  if (typeof input['instructions'] === 'string') request.instructions = input['instructions'];

  return collector.finish(request);
}

export function validateCancelRequest(input: unknown): ValidationResult<CancelRequest> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'request', collector)) return collector.finish(undefined as never);
  checkKeys(input, CANCEL_KEYS, [], 'request', collector);
  const request: CancelRequest = {};
  if (input['ownerGeneration'] !== undefined) {
    const generation = input['ownerGeneration'];
    if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) {
      collector.push('request.ownerGeneration: expected non-negative integer');
    } else {
      request.ownerGeneration = generation;
    }
  }
  if (input['reason'] !== undefined) {
    checkString(input['reason'], 'request.reason', collector, 200);
    if (typeof input['reason'] === 'string') request.reason = input['reason'];
  }
  return collector.finish(request);
}

export function validateIdempotencyKey(value: unknown): ValidationResult<string> {
  const collector = new ErrorCollector();
  checkString(value, 'Idempotency-Key', collector, 200);
  return collector.finish(typeof value === 'string' ? value : '');
}
