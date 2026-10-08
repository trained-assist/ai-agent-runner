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
  type McpSpec,
  type OutputSpec,
  type RegionConstraints,
  type RepositorySpec,
  type ResultPolicy,
  type RunLimits,
  type RunSpec,
} from '../contracts/run-spec.js';
import { ErrorCollector, checkKeys, checkObject, checkString, checkText, type ValidationResult } from '../contracts/validate.js';

/**
 * Способность границы изоляции. Объявлена здесь, а не импортом из `src/isolation/`: stateless-ядро
 * API не зависит от модуля изоляции (её обеспечивает внешний воркер), но продолжает объявлять
 * честное значение в capabilities.
 */
type IsolationCapability = 'not_proven_service_uid_only' | 'per_run_unix_identity_verified' | 'configured_but_refusing_runs';

export const API_RUN_STATES = [
  'queued',
  'starting',
  'running',
  'awaiting_user',
  'finalizing',
  'succeeded',
  'failed',
  'cancelled',
  /**
   * Исход рана установить нельзя: воркер принял задачу, но результат не вернул и статус
   * неизвестен. Это не `failed` — задача не потеряна, авто-rerun не происходит, следующий
   * шаг — reconcile существующего запуска у воркера.
   */
  'unknown',
] as const;

export type ApiRunState = (typeof API_RUN_STATES)[number];

export interface SubmitRequest {
  userTaskId?: string;
  conversationId?: string;
  /**
   * Движок рана. Не объявлен — исполнителя выбирает приоритетная цепочка движков (issue #100);
   * объявлен — цепочка не применяется, ран идёт ровно на этот движок.
   */
  engine?: EngineSpec;
  input?: InputSpec;
  ingressManifest?: { contractVersion: 1; manifestRef: string; manifestVersion: string };
  envAllowlist: string[];
  limits: RunLimits;
  deadline?: string;
  regionConstraints?: RegionConstraints;
  credentialBindings?: CredentialBinding[];
  mcp?: McpSpec;
  budget?: BudgetSpec;
  result?: ResultPolicy;
  outputs?: OutputSpec[];
  traceId?: string;
  instructions?: string;
  repository?: RepositorySpec;
  /** Требование границы рана (issue #51): per_run_unix_identity | none. */
  isolation?: { mode: 'per_run_unix_identity' | 'none' };
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
  /**
   * Движок, который отработал ран (issue #100). Пока никто не принял ран — тот, на котором
   * идёт попытка: цепочка движков двигает его по мере отказов. После приёма он не меняется.
   */
  engine: string;
  cancelRequested: boolean;
  connectionLost: boolean;
  observedAt: string;
  sequence: number;
  fencing: { rejected: number };
  /** Текст ответа агента, если воркер его извлёк. */
  answer: string | null;
  publication?: { status: string; committedRevision: string | null; conflictId: string | null; publicationId: string | null; reason: string | null } | null;
}

export interface EventsPage {
  runId: string;
  events: RunnerEvent[];
  cursor: number;
  hasMore: boolean;
  /** Ссылка на лог сессии в Google Storage (epic #74, шаг 5). */
  logUrl: string | null;
  /** Сколько событий рана отброшено по лимиту памяти процесса — молча терять их нельзя. */
  droppedEvents: number;
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
  profileWorkspaceProvisioning: {
    enabled: boolean;
    method: 'POST';
    path: '/v1/profiles/workspace';
    scope: 'profiles:provision';
    requiresSignedProfileCapability: true;
    launchesAgent: false;
  };
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
    listPerRun: boolean;
    download: boolean;
    shareLink: boolean;
    ingestEndpoint: 'absent';
    ingestNote: string;
    /** Экспорт объявленных выходов рана в object storage с закоммиченным манифестом. */
    export: {
      enabled: boolean;
      declaredOutputs: boolean;
      manifest: boolean;
      partialManifestDeclared: boolean;
      engineRerunOnRecommit: false;
      soleCopyRetainedUntilDurable: boolean;
    };
    /** Прямая загрузка артефактов через скопированные сессии и presigned URL. */
    upload: {
      enabled: boolean;
      scopedSessions: boolean;
      presignedUrl: boolean;
      multipartResume: boolean;
      abortCleanup: boolean;
      maxTotalBytes: number;
      ttlSeconds: number;
    };
    snapshot: {
      enabled: boolean;
      versioning: boolean;
      conflictDetection: boolean;
      conflictPolicies: readonly ('reject' | 'overwrite' | 'merge')[];
      cleanRoomOnNewAttempt: boolean;
      /**
       * Снимок как указатель на байты в хранилище (issue #52, шаг 1). Объявляется честно:
       * без materializer'а запрос входа со снимком отказывается, а не материализуется
       * «как-нибудь».
       */
      materialize: {
        enabled: boolean;
        bytesInDurableStorage: boolean;
        verifyDigestOnWrite: boolean;
        ownerScoped: boolean;
        allOrNothing: boolean;
        refusalRetryableWhenStorageUnavailable: boolean;
        limits: { refs: number; filesPerRef: number; fileBytes: number; totalBytes: number };
      };
    };
  };
  cancel: { requestedReceipt: true; terminalConfirmation: true };
  /**
   * MCP (P13). Значения объявлены честно: per-run stdio proxy — да, remote transport у
   * раннего агента — нет, а «UID сервиса» НЕ является доказанной OS-изоляцией.
   */
  mcp: {
    perRunStdioProxy: boolean;
    scopedBindings: boolean;
    capabilityHandlersSharedWithMcp: boolean;
    capabilityInvokeEndpoint: boolean;
    remoteTransport: 'absent' | 'worker_remote';
    osIsolation: IsolationCapability;
    osIsolationNote: string;
  };
  /**
   * Граница Agent clean room (issue #51). Объявляется честно: без настроенного провайдера
   * движок идёт под service UID, и это НЕ доказанная OS-граница.
   */
  isolation: {
    mode: 'none' | 'per_run_unix_identity';
    slots: string[];
    freeSlots: string[];
    capability: IsolationCapability;
    launcher: 'setpriv' | 'runuser' | null;
    failClosed: boolean;
  };
  /**
   * Промоушен (P29, этап I10): закреплённый релиз, флаг когорты, возможность отката,
   * политика платных профилей и общий реестр владения. Значения объявлены честно: без
   * promotion-контура приёмник видит `cohortEnabled: false`, а не догадку о когорте.
   */
  promotion: {
    pinnedRelease: { releaseId: string; sourceCommit: string; configVersion: number } | null;
    cohortEnabled: boolean;
    cohortId: string;
    rollbackAvailable: boolean;
    rolledBack: boolean;
    servingReleaseId: string | null;
    /** null = манифест не подключён, политика платных профилей не объявлена. */
    paidProfilesAllowed: boolean | null;
    sharedOwnerRegistry: boolean;
    takeoverRequiresExplicitSignal: true;
    partitionIsNotFailover: true;
    retentionPolicy: { mainEventsDays: number; verboseLogsDays: number } | null;
    releaseEndpoint: string;
    /**
     * Размещение (P30): регион × провайдер × credentials × резидентность. null = политика
     * не подключена, региональных ограничений у воркера нет.
     */
    placement: {
      policyId: string;
      authority: 'sandbox_probe' | 'owner_decision';
      workerRegion: string;
      allowedEngines: string[];
      dataResidencyDecided: boolean;
      dataResidencyDecisionRef: string | null;
      checkedBefore: 'paid_profile_and_cohort';
      runnerRechecksEngineRegion: true;
    } | null;
  };
  engines: string[];
  /**
   * Как выбирается исполнитель рана (issue #100). Объявлено честно: цепочка проб, переход
   * только при отсутствии квитанции и никакого второго запуска после приёма.
   */
  engineSelection: {
    /** Приоритетная цепочка в порядке проб; пустая — цепочка не объявлена. */
    chain: string[];
    /** Заявка без `engine` идёт по цепочке; с `engine` — ровно на названный движок. */
    engineOptional: true;
    /** Повтор на следующем движке — только если квитанции не было. */
    retryOnlyWhenUnaccepted: true;
    /** После квитанции второй запуск невозможен: ран уже идёт, дальше только reconcile. */
    relaunchAfterReceipt: false;
  };
}

export const API_CAPABILITIES_SCHEMA_VERSION = 1 as const;
export const API_CONTRACT_VERSION = 1 as const;

const SUBMIT_KEYS = [
  'userTaskId',
  'conversationId',
  'engine',
  'input',
  'ingressManifest',
  'envAllowlist',
  'limits',
  'deadline',
  'regionConstraints',
  'credentialBindings',
  'mcp',
  'budget',
  'result',
  'outputs',
  'traceId',
  'instructions',
  'repository',
  'isolation',
] as const;

const SUBMIT_REQUIRED = ['limits'] as const;

const CANCEL_KEYS = ['ownerGeneration', 'reason'] as const;

/** Имя движка-заглушки на время валидации заявки без `engine`; клиенту не возвращается. */
const ENGINE_PENDING_PLACEHOLDER = 'engine.pending';

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
  if (input['instructions'] !== undefined) checkText(input['instructions'], 'request.instructions', collector, 10_000);
  if (input['ingressManifest'] !== undefined && checkObject(input['ingressManifest'], 'request.ingressManifest', collector)) {
    const pin = input['ingressManifest'];
    checkKeys(pin, ['contractVersion', 'manifestRef', 'manifestVersion'], ['contractVersion', 'manifestRef', 'manifestVersion'], 'request.ingressManifest', collector);
    if (pin['contractVersion'] !== 1) collector.push('request.ingressManifest.contractVersion: expected 1');
    checkString(pin['manifestRef'], 'request.ingressManifest.manifestRef', collector, 500);
    if (typeof pin['manifestVersion'] !== 'string' || !/^[0-9a-f]{64}$/.test(pin['manifestVersion'])) collector.push('request.ingressManifest.manifestVersion: expected lowercase sha256');
  }
  if (input['isolation'] !== undefined) {
    const isolation = input['isolation'];
    if (checkObject(isolation, 'request.isolation', collector)) {
      checkKeys(isolation, ['mode'], ['mode'], 'request.isolation', collector);
      if (isolation['mode'] !== 'per_run_unix_identity' && isolation['mode'] !== 'none') {
        collector.push('request.isolation.mode: expected per_run_unix_identity | none');
      }
    }
  }
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
    // Движок в заявке необязателен (цепочка выбирает), но `RunSpec` его требует — на время
    // валидации подставляем заглушку и в ответ её не возвращаем.
    engine: input['engine'] ?? { name: ENGINE_PENDING_PLACEHOLDER, adapterVersion: '1' },
    cwd: '/pending',
    envAllowlist: input['envAllowlist'] ?? [],
    limits: input['limits'],
  };
  for (const key of ['input', 'deadline', 'regionConstraints', 'credentialBindings', 'mcp', 'budget', 'result', 'outputs', 'traceId', 'repository', 'isolation'] as const) {
    if (input[key] !== undefined) specLike[key] = input[key];
  }
  if (input['ingressManifest'] !== undefined) {
    specLike['ingressManifest'] = {
      ...input['ingressManifest'] as Record<string, unknown>,
      userTaskId: specLike['userTaskId'],
      profileId: specLike['profileId'],
      runId: specLike['runId'],
      ownerGeneration: specLike['ownerGeneration'],
    };
  }
  if (input['ingressManifest'] !== undefined && specLike['input'] !== undefined) {
    const inputSpec = specLike['input'] as InputSpec;
    if (inputSpec.refs?.length) collector.push('request.input.refs: cannot be combined with request.ingressManifest');
  }
  if (!collector.ok) return collector.finish(undefined as never);

  const specResult = validateRunSpec(specLike);
  if (!specResult.ok) {
    const errors = specResult.errors.map((message) => (message.startsWith('spec.') ? `request.${message.slice('spec.'.length)}` : message));
    return { ok: false, errors };
  }

  const spec: RunSpec = specResult.value;
  const request: SubmitRequest = {
    envAllowlist: spec.envAllowlist,
    limits: spec.limits,
  };
  if (input['ingressManifest'] !== undefined) request.ingressManifest = input['ingressManifest'] as SubmitRequest['ingressManifest'];
  if (input['engine'] !== undefined) request.engine = spec.engine;
  if (spec.input !== undefined) request.input = spec.input;
  if (spec.deadline !== undefined) request.deadline = spec.deadline;
  if (spec.regionConstraints !== undefined) request.regionConstraints = spec.regionConstraints;
  if (spec.credentialBindings !== undefined) request.credentialBindings = spec.credentialBindings;
  if (spec.mcp !== undefined) request.mcp = spec.mcp;
  if (spec.budget !== undefined) request.budget = spec.budget;
  if (spec.result !== undefined) request.result = spec.result;
  if (spec.outputs !== undefined) request.outputs = spec.outputs;
  if (spec.traceId !== undefined) request.traceId = spec.traceId;
  if (spec.repository !== undefined) request.repository = spec.repository;
  if (typeof input['userTaskId'] === 'string') request.userTaskId = input['userTaskId'];
  if (typeof input['conversationId'] === 'string') request.conversationId = input['conversationId'];
  if (typeof input['instructions'] === 'string') request.instructions = input['instructions'];
  if (spec.isolation !== undefined) request.isolation = spec.isolation;

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
