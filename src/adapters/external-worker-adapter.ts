import { randomUUID, timingSafeEqual } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { RUNNER_EVENT_SCHEMA_VERSION, type RunnerEvent } from '../contracts/events.js';
import { RUN_RESULT_SCHEMA_VERSION, type ExitReason, type FailureClass, type RunFailure, type RunOutcome, type RunResult } from '../contracts/result.js';
import { validateRunResult } from '../contracts/result.js';
import type { OutputSpec, RunSpec } from '../contracts/run-spec.js';
import {
  ErrorCollector,
  PreflightError,
  checkArray,
  checkKeys,
  checkObject,
  checkString,
  isSafeId,
  isUtcTimestamp,
  type ValidationResult,
} from '../contracts/validate.js';
import { redactSecrets, truncateLine } from '../redact.js';
import { parseRemoteMcpServerPolicies, resolveRemoteMcpAttachment, type RemoteMcpAttachment, type RemoteMcpHostOptions } from './remote-mcp.js';

/**
 * Адаптер внешнего воркера (issue #73, epic #74 шаг 2). Единственный способ запустить агента:
 * HTTP-вызов `POST {worker}/v1/launch`. Никакого spawn, никакого диска — весь контекст рана
 * приходит в запросе, весь результат возвращается в ответе.
 *
 * Контракт — issue #73: `LaunchRequest` → `LaunchResult`. Воркер сам клонирует репозиторий
 * юзера, сам складывает артефакты в него и сам грузит лог сессии в Google Storage.
 */

export const EXTERNAL_WORKER_ENGINE = 'dynamic-ip-azure-agent-run';
export const EXTERNAL_WORKER_ADAPTER_VERSION = '1';

/** Сколько событий рана API пишет до сетевого вызова: `claimed` + `inputs_materialized`. */
export const ADMISSION_EVENT_COUNT = 2;

export const WORKER_STATUSES: readonly WorkerRunStatus[] = ['accepted', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'];

/**
 * Повторы отмены: маршрут отмены синхронный и быстрый, поэтому повторяем только на
 * сетевую ошибку. Гонки с запуском больше нет — квитанция приходит после регистрации рана.
 */
export const CANCEL_DELIVERY_RETRIES = 3;
export const CANCEL_DELIVERY_BACKOFF_MS = 40;

/**
 * Запас сверх `limits.timeoutMs` рана, прежде чем API признает ран потерянным: воркер
 * принял задачу, но результат не вернул. По умолчанию минута — на выгрузку лога и пуш.
 */
export const RESULT_WATCHDOG_GRACE_MS = 60_000;


/** Префикс веток ранов. Ветка рана — это его результат, а не мусор в ветке по умолчанию. */
export const DEFAULT_BRANCH_PREFIX = 'agent-run';

export const DEFAULT_LAUNCH_DEADLINE_MS = 10 * 60 * 1000;
export const DEFAULT_CANCEL_DEADLINE_MS = 30 * 1000;
export const MAX_LOG_EVENT_CHARS = 10_000;

export interface LaunchArtifact {
  path: string;
  name: string;
  mime: string;
  sha256: string;
  size: number;
}

export interface LaunchRepo {
  fullName: string;
  /** Ветка рана: воркер создал её, закоммитил в неё `outputs` и запушил. */
  branch: string;
  /** HEAD этой ветки на момент ответа. */
  commit: string;
  /** Ветка, от которой ответвлялся ран (если воркер её сообщил). */
  baseRef?: string;
}

/**
 * Имя ветки рана. Генерирует наше API, а не воркер: только API знает `runId`, поэтому имя
 * уникально, трассируемо до рана и не может столкнуться с ветками самого юзера. Ветка —
 * единица результата: всё, что ран сделал, лежит в ней и мержится одним действием.
 */
export function runBranchName(runId: string, prefix = DEFAULT_BRANCH_PREFIX): string {
  return `${prefix}/${runId}`;
}

export interface LaunchFailure {
  code: string;
  failureClass: FailureClass;
  safeSummary: string;
  retryable: boolean;
}

export type LaunchAnswerSource = 'engine_stdout' | 'agent_file' | null;

export interface LaunchRequest {
  mcp?: RemoteMcpAttachment['mcp'];
  mcpSecrets?: RemoteMcpAttachment['mcpSecrets'];
  runId: string;
  jobId: string;
  userTaskId: string;
  profileId: string;
  conversationId: string;
  operationId: string;
  ownerGeneration: number;
  engine: { name: string; adapterVersion: string; modelSettings?: { model?: string } };
  input: { inlinePrompt: string };
  cwd: string;
  envAllowlist: string[];
  env: Record<string, string>;
  limits: { timeoutMs: number; maxOutputBytes: number; maxLogBytes: number };
  repository: { fullName: string; branch: string };
  /**
   * Куда воркер вернёт `LaunchResult` для этого рана: `POST {resultUrl}` с общим секретом
   * в `Authorization`. Адрес приходит в запросе, поэтому воркеру не нужно знать, где мы.
   */
  resultUrl: string;
  isolation: { mode: string };
  outputs?: Array<{ path: string; name?: string; mime?: string }>;
}

/**
 * Квитанция запуска. `POST {worker}/v1/launch` отвечает ею сразу: воркер принял ран и ушёл
 * работать, соединение закрывается. Финальный результат читается отдельно — по `statusUrl`
 * и `resultUrl`, которые воркер сообщает в квитанции.
 *
 * Так воркер остаётся stateless (результат негде хранить), а наш API не держит HTTP-запрос
 * весь ран — что важно, если сам API уедет на Cloudflare Worker, где длинный запрос
 * невозможен.
 */
export interface LaunchReceipt {
  runId: string;
  operationId: string;
  status: 'accepted';
  statusUrl: string;
  resultUrl: string;
}

/** Статус рана у воркера. `unknown` — исход установить нельзя, это не `failed`. */
export type WorkerRunStatus = 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export interface WorkerStatusView {
  runId: string;
  status: WorkerRunStatus;
  updatedAt?: string;
}

/** Результат ещё не готов: воркер отвечает 409, а не пустым телом. */
export class ResultNotReadyError extends Error {
  readonly code = 'RESULT_NOT_READY';
  constructor(runId: string) {
    super(`result of run ${runId} is not ready yet`);
  }
}

export interface LaunchResult {
  runId: string;
  status: 'started' | 'failed';
  pid?: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  exitReason: ExitReason;
  stdout: string;
  stderr: string;
  answer?: string | null;
  answerSource?: LaunchAnswerSource;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
  artifacts: LaunchArtifact[];
  logUrl: string;
  repo: LaunchRepo;
  failure?: LaunchFailure;
}

export interface WorkerCancelResult {
  status: 'cancelled' | 'rejected' | 'unknown_run';
  reason?: string;
}

/** Порт, который использует stateless-ядро API. Реализация — `ExternalWorkerAdapter`. */
export interface ExternalWorker {
  readonly remoteMcpEnabled?: boolean;
  readonly name: string;
  readonly baseUrl: string | null;
  /** Квитанция запуска, а не финальный результат (асинхронный контракт, #73). */
  launch(spec: RunSpec): Promise<LaunchReceipt>;
  status(runId: string): Promise<WorkerStatusView>;
  result(runId: string): Promise<LaunchResult>;
  cancel(runId: string): Promise<WorkerCancelResult>;
}

/**
 * Гонка отмены с запуском. Контракт воркера синхронный (`launch` = весь ран), поэтому отмена
 * может прийти раньше, чем воркер зарегистрирует ран. `unknown_run` в такой ситуации означает
 * «ещё не вижу», а не «не существует», и API повторяет запрос, пока ран в полёте.
 */
export const CANCEL_UNKNOWN_RUN_RETRIES = 5;
export const CANCEL_UNKNOWN_RUN_BACKOFF_MS = 40;

/** Проверка текста, который в норме может быть пустым (stderr, stdout без вывода). */
function checkText(value: unknown, path: string, collector: ErrorCollector, maxLen: number): void {
  if (typeof value !== 'string') {
    collector.push(`${path}: expected string`);
    return;
  }
  if (value.length > maxLen) collector.push(`${path}: longer than ${maxLen}`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    collector.push(`${path}: control characters are not allowed`);
  }
}

function checkLogText(value: unknown, path: string, collector: ErrorCollector, maxLen: number): void {
  if (typeof value === 'string' && /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f]/.test(value)) {
    checkText(value, path, collector, maxLen);
    return;
  }
  const normalized = typeof value === 'string' ? stripVTControlCharacters(value) : value;
  checkText(normalized, path, collector, maxLen);
  if (typeof value === 'string' && value.length > maxLen && typeof normalized === 'string' && normalized.length <= maxLen) {
    collector.push(`${path}: longer than ${maxLen}`);
  }
}

export interface ExternalWorkerOptions {
  remoteMcp?: RemoteMcpHostOptions;
  baseUrl: string;
  /** Публичный адрес нашего API: воркер шлёт результат на callback resultUrl. */
  baseUrlForResult?: string;
  /**
   * Имя движка, которым этот воркер отвечает. По умолчанию — `dynamic-ip-azure-agent-run`
   * (Azure VM). Второй воркер (например, получатель раннеров на GitHub Actions) объявляет
   * своё: имя движка — это адрес воркера, а не его внутренняя деталь.
   */
  engineName?: string;
  token?: string;
  /**
   * Хостовый пул значений окружения. В `LaunchRequest.env` уходит только пересечение с
   * `envAllowlist` рана, поэтому секреты хоста в процесс агента не попадают (issue #73, п. 4).
   */
  env?: Record<string, string>;
  /** Таймаут ожидания ответа воркера на launch. По умолчанию 10 минут. */
  deadlineMs?: number;
  cancelDeadlineMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

const LAUNCH_RESULT_KEYS = [
  'runId',
  'status',
  'pid',
  'exitCode',
  'exitSignal',
  'exitReason',
  'stdout',
  'stderr',
  'answer',
  'answerSource',
  'durationMs',
  'timedOut',
  'outputTruncated',
  'artifacts',
  'logUrl',
  'repo',
  'failure',
] as const;

const LAUNCH_FAILURE_KEYS = ['code', 'failureClass', 'safeSummary', 'retryable'] as const;

const EXIT_REASONS: readonly ExitReason[] = [
  'completed',
  'nonzero_exit',
  'startup_failure',
  'timeout',
  'crash',
  'cancelled',
  'worker_crash',
  'preflight_refused',
];

const ANSWER_SOURCES: readonly LaunchAnswerSource[] = ['engine_stdout', 'agent_file', null];

export function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Ссылка на лог рана. В serverless-модели это НЕ путь в файловой системе: успешный ран —
 * ссылка GCS, которую вернул воркер; недоступный воркер — его собственный URL рана, где лог
 * лежал бы, если бы воркер успел его написать. `RunResult.logPath` обязан быть непустой
 * строкой, поэтому подставлять сюда пустоту нельзя.
 */
/** Строка вывода агента в виде, пригодном для события рана: без секретов и управляющих символов. */
export function logMessage(text: string): string {
  return truncateLine(redactSecrets(text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim(), MAX_LOG_EVENT_CHARS - 32);
}

/** Безопасное краткое описание отказа: секреты вырезаны, длина укладывается в контракт. */
export function safeSummary(message: string): string {
  // truncateLine дописывает маркер обрезки, поэтому режем заранее с запасом.
  return truncateLine(redactSecrets(message), 450);
}

export function runLogRef(launch: LaunchResult | null, workerBaseUrl: string | null, runId: string): string {
  if (launch?.logUrl) return launch.logUrl;
  const base = workerBaseUrl ?? 'worker://unconfigured';
  return `${trimTrailingSlash(base)}/v1/runs/${runId}`;
}

/** Ссылка на файл в репозитории юзера: воркер коммитит артефакты, мы только адресуем их. */
export function artifactUrl(repo: LaunchRepo, path: string): string {
  return `https://github.com/${repo.fullName}/blob/${repo.commit}/${path}`;
}

/** Страница ветки рана: отсюда видно весь результат и отсюда GitHub предлагает merge/PR. */
export function branchUrl(repo: LaunchRepo): string {
  return `https://github.com/${repo.fullName}/tree/${repo.branch}`;
}

/**
 * Ссылка на сравнение ветки рана с базой — то место, где результат рана мержится. Без
 * известной базы честнее отдать страницу ветки: GitHub сам предложит merge.
 */
export function mergeUrl(repo: LaunchRepo): string {
  return repo.baseRef
    ? `https://github.com/${repo.fullName}/compare/${repo.baseRef}...${repo.branch}`
    : branchUrl(repo);
}

/**
 * Сборка `LaunchRequest` из `RunSpec`. Значения окружения берутся из хостового пула
 * (`options.env`) и передаются только те, что разрешил клиент в `envAllowlist` — секреты
 * хоста в процесс агента не попадают (issue #73, требование 4).
 */
export function launchRequestFromSpec(
  spec: RunSpec,
  options: { env?: Record<string, string>; resultUrl: string; remoteMcpAttachment?: RemoteMcpAttachment } = { resultUrl: '' },
): LaunchRequest {
  if (spec.mcp?.servers.length && !options.remoteMcpAttachment) {
    throw new PreflightError('MCP_HOST_POLICY_MISSING', 'remote MCP requires trusted host resolution', { failureClass: 'preflight', retryable: false });
  }
  if (spec.input?.refs && spec.input.refs.length > 0) {
    throw new PreflightError('INPUT_REFS_UNSUPPORTED', 'input.refs require a durable workspace; the stateless API passes the prompt inline only', {
      failureClass: 'preflight',
      retryable: false,
    });
  }
  const prompt = spec.input?.inlinePrompt;
  if (!prompt) {
    throw new PreflightError('INLINE_PROMPT_REQUIRED', 'the external worker runs an agent from input.inlinePrompt and there is nothing else to run', {
      failureClass: 'preflight',
      retryable: false,
    });
  }
  const env: Record<string, string> = {};
  for (const name of spec.envAllowlist) {
    const value = options.env?.[name];
    if (value !== undefined) env[name] = value;
  }
  const outputs: LaunchRequest['outputs'] = (spec.outputs ?? []).map((output: OutputSpec) => ({
    path: output.path,
    ...(output.name !== undefined ? { name: output.name } : {}),
    ...(output.mime !== undefined ? { mime: output.mime } : {}),
  }));
  return {
    runId: spec.runId,
    jobId: spec.jobId,
    userTaskId: spec.userTaskId,
    profileId: spec.profileId,
    conversationId: spec.conversationId,
    operationId: spec.operationId,
    ownerGeneration: spec.ownerGeneration,
    engine: {
      name: spec.engine.name,
      adapterVersion: spec.engine.adapterVersion,
      ...(spec.engine.modelSettings?.model !== undefined ? { modelSettings: { model: spec.engine.modelSettings.model } } : {}),
    },
    input: { inlinePrompt: prompt },
    cwd: spec.cwd,
    envAllowlist: [...spec.envAllowlist],
    env,
    limits: {
      timeoutMs: spec.limits.timeoutMs,
      maxOutputBytes: spec.limits.maxOutputBytes ?? 0,
      maxLogBytes: spec.limits.maxLogBytes ?? 0,
    },
    repository: { fullName: spec.repository?.fullName ?? '', branch: runBranchName(spec.runId) },
    resultUrl: options.resultUrl,
    isolation: { mode: spec.isolation?.mode ?? 'none' },
    ...options.remoteMcpAttachment,
    ...(outputs.length > 0 ? { outputs } : {}),
  };
}

const RECEIPT_KEYS = ['runId', 'operationId', 'status', 'statusUrl', 'resultUrl'] as const;

export function validateLaunchReceipt(input: unknown, expectedRunId: string): ValidationResult<LaunchReceipt> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'receipt', collector)) return collector.finish(undefined as never);
  checkKeys(input, RECEIPT_KEYS, RECEIPT_KEYS, 'receipt', collector);
  if (input['runId'] !== expectedRunId) collector.push(`receipt.runId: expected echo of ${expectedRunId}`);
  if (!isSafeId(input['operationId'])) collector.push('receipt.operationId: expected id');
  if (input['status'] !== 'accepted') collector.push('receipt.status: expected accepted');
  checkString(input['statusUrl'], 'receipt.statusUrl', collector, 500);
  checkString(input['resultUrl'], 'receipt.resultUrl', collector, 500);
  return collector.finish(input as unknown as LaunchReceipt);
}

const STATUS_KEYS = ['runId', 'status', 'updatedAt'] as const;

export function validateWorkerStatus(input: unknown, expectedRunId: string): ValidationResult<WorkerStatusView> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'status', collector)) return collector.finish(undefined as never);
  checkKeys(input, STATUS_KEYS, ['runId', 'status'], 'status', collector);
  if (input['runId'] !== expectedRunId) collector.push(`status.runId: expected echo of ${expectedRunId}`);
  if (typeof input['status'] !== 'string' || !(WORKER_STATUSES as readonly string[]).includes(input['status'])) {
    collector.push(`status.status: expected one of ${WORKER_STATUSES.join(', ')}`);
  }
  if (input['updatedAt'] !== undefined && !isUtcTimestamp(input['updatedAt'])) {
    collector.push('status.updatedAt: expected UTC ISO timestamp');
  }
  return collector.finish(input as unknown as WorkerStatusView);
}

export function validateLaunchResult(input: unknown, expectedRunId: string): ValidationResult<LaunchResult> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'launch', collector)) return collector.finish(undefined as never);
  // `failure` появляется только на отказе воркера (issue #73) — остальное обяза��тельно.
  checkKeys(input, LAUNCH_RESULT_KEYS, LAUNCH_RESULT_KEYS.filter((key) => key !== 'failure'), 'launch', collector);

  if (input['runId'] !== expectedRunId) collector.push(`launch.runId: expected echo of ${expectedRunId}`);
  if (input['status'] !== 'started' && input['status'] !== 'failed') collector.push('launch.status: expected started | failed');
  if (input['pid'] !== undefined && input['pid'] !== null && (typeof input['pid'] !== 'number' || !Number.isInteger(input['pid']))) {
    collector.push('launch.pid: expected integer or null');
  }
  if (input['exitCode'] !== null && typeof input['exitCode'] !== 'number') collector.push('launch.exitCode: expected number or null');
  if (input['exitSignal'] !== null && typeof input['exitSignal'] !== 'string') collector.push('launch.exitSignal: expected string or null');
  if (typeof input['exitReason'] !== 'string' || !(EXIT_REASONS as readonly string[]).includes(input['exitReason'])) {
    collector.push(`launch.exitReason: expected one of ${EXIT_REASONS.join(', ')}`);
  }
  checkLogText(input['stdout'], 'launch.stdout', collector, 1_000_000);
  checkLogText(input['stderr'], 'launch.stderr', collector, 1_000_000);
  if (input['answer'] !== undefined && input['answer'] !== null) checkText(input['answer'], 'launch.answer', collector, 1_000_000);
  if (input['answerSource'] !== undefined && !(ANSWER_SOURCES as readonly LaunchAnswerSource[]).includes(input['answerSource'] as LaunchAnswerSource)) {
    collector.push('launch.answerSource: expected engine_stdout | agent_file | null');
  }
  if (typeof input['durationMs'] !== 'number' || !Number.isInteger(input['durationMs']) || input['durationMs'] < 0) {
    collector.push('launch.durationMs: expected non-negative integer');
  }
  if (typeof input['timedOut'] !== 'boolean') collector.push('launch.timedOut: expected boolean');
  if (typeof input['outputTruncated'] !== 'boolean') collector.push('launch.outputTruncated: expected boolean');

  // Артефакты, лог и репозиторий — обязательная часть контракта (issue #73): без них ран
  // нельзя ни показать клиенту, ни проверить, что воркер реально сложил выходы.
  if (!checkArray(input['artifacts'], 'launch.artifacts', collector)) {
    // уже сообщено
  } else {
    input['artifacts'].forEach((artifact, index) => {
      const path = `launch.artifacts[${index}]`;
      if (!checkObject(artifact, path, collector)) return;
      checkKeys(artifact, ['path', 'name', 'mime', 'sha256', 'size'], ['path', 'name', 'mime', 'sha256', 'size'], path, collector);
      checkString(artifact['path'], `${path}.path`, collector, 512);
      checkString(artifact['name'], `${path}.name`, collector, 200);
      checkString(artifact['mime'], `${path}.mime`, collector, 100);
      checkString(artifact['sha256'], `${path}.sha256`, collector, 64);
      if (typeof artifact['size'] !== 'number' || !Number.isInteger(artifact['size']) || (artifact['size'] as number) < 0) {
        collector.push(`${path}.size: expected non-negative integer`);
      }
    });
  }
  checkString(input['logUrl'], 'launch.logUrl', collector, 500);
  if (!checkObject(input['repo'], 'launch.repo', collector)) {
    // уже сообщено
  } else {
    checkKeys(input['repo'], ['fullName', 'branch', 'commit', 'baseRef'], ['fullName', 'branch', 'commit'], 'launch.repo', collector);
    checkString(input['repo']['fullName'], 'launch.repo.fullName', collector, 200);
    checkString(input['repo']['branch'], 'launch.repo.branch', collector, 200);
    checkString(input['repo']['commit'], 'launch.repo.commit', collector, 64);
    if (input['repo']['baseRef'] !== undefined) checkString(input['repo']['baseRef'], 'launch.repo.baseRef', collector, 200);
  }

  const failure = input['failure'];
  if (failure !== undefined) {
    if (!checkObject(failure, 'launch.failure', collector)) {
      // уже сообщено
    } else {
      checkKeys(failure, LAUNCH_FAILURE_KEYS, LAUNCH_FAILURE_KEYS, 'launch.failure', collector);
      checkString(failure['code'], 'launch.failure.code', collector, 100);
      checkString(failure['safeSummary'], 'launch.failure.safeSummary', collector, 500);
      if (typeof failure['retryable'] !== 'boolean') collector.push('launch.failure.retryable: expected boolean');
      if (failure['failureClass'] !== undefined && !(['preflight', 'engine', 'runtime', 'finalization'] as const).includes(failure['failureClass'] as FailureClass)) {
        collector.push('launch.failure.failureClass: expected preflight | engine | runtime | finalization');
      }
    }
  }

  return collector.finish(input as unknown as LaunchResult);
}

export interface LaunchMapping {
  result: RunResult;
  events: RunnerEvent[];
  artifacts: LaunchArtifact[];
  repo: LaunchRepo | null;
  logUrl: string | null;
  answer: string | null;
}

export interface LaunchMappingOptions {
  /** Базовый URL воркера: источник ссылки на лог, когда воркер её не вернул. */
  workerBaseUrl?: string | null;
}

/**
 * События приёма рана: их API пишет сразу, до сетевого вызова, — иначе журнал пуст всё время,
 * пока воркер думает, и клиент не отличает «ран принят» от «ран потерян».
 */
export function admissionEvents(spec: RunSpec, startedAt: string): RunnerEvent[] {
  const events: RunnerEvent[] = [];
  pushRunnerEvent(events, spec, 1, 'claimed', { operationId: spec.operationId }, startedAt);
  pushRunnerEvent(
    events,
    spec,
    2,
    'inputs_materialized',
    {
      status: 'nothing_to_materialize',
      declared: 0,
      requested: 0,
      files: 0,
      bytes: 0,
      entries: [],
      reason: 'stateless API passes the prompt inline; there is no durable workspace to materialize into',
    },
    startedAt,
  );
  return events;
}

function pushRunnerEvent(
  events: RunnerEvent[],
  spec: RunSpec,
  sequence: number,
  type: RunnerEvent['type'],
  payload: Record<string, unknown>,
  timestamp: string,
): void {
  events.push({
    schemaVersion: RUNNER_EVENT_SCHEMA_VERSION,
    eventId: `evt_${randomUUID()}`,
    runId: spec.runId,
    jobId: spec.jobId,
    userTaskId: spec.userTaskId,
    profileId: spec.profileId,
    ownerGeneration: spec.ownerGeneration,
    sequence,
    timestamp,
    type,
    payload,
  } as RunnerEvent);
}

/**
 * Маппинг `LaunchResult` → `RunResult` + `RunnerEvent` (epic #74, шаг 2). События синтезируются
 * из ответа воркера: у API нет ни процесса, ни файла событий, поэтому журнал рана — это то,
 * что воркер сообщил о себе, плюс ссылки на артефакты и лог. События приёма (`claimed`,
 * `inputs_materialized`) пишет `admissionEvents` до сетевого вызова — они в этот список не
 * входят, но продолжают нумерацию.
 */
export function mapLaunchResult(
  spec: RunSpec,
  launch: LaunchResult,
  times: { startedAt: string; finishedAt: string },
  options: LaunchMappingOptions = {},
): LaunchMapping {
  const outcome: RunOutcome = launch.exitReason === 'completed' ? 'succeeded' : launch.exitReason === 'cancelled' ? 'cancelled' : 'failed';
  const failure = launchFailureFor(spec, launch, outcome);
  const artifacts = launch.artifacts ?? [];
  const repo = launch.repo ?? null;
  const logUrl = launch.logUrl ?? null;
  const outputRefs = artifacts.map((artifact) => (repo ? artifactUrl(repo, artifact.path) : artifact.path));
  const persistence = artifacts.length > 0 ? 'persisted' : 'not_required';
  const result: RunResult = {
    schemaVersion: RUN_RESULT_SCHEMA_VERSION,
    runId: spec.runId,
    jobId: spec.jobId,
    userTaskId: spec.userTaskId,
    profileId: spec.profileId,
    ownerGeneration: spec.ownerGeneration,
    outcome,
    exitReason: launch.exitReason,
    exitCode: launch.exitCode,
    exitSignal: launch.exitSignal,
    exitObserved: launch.exitCode !== null || launch.exitSignal !== null,
    startedAt: times.startedAt,
    finishedAt: times.finishedAt,
    ...(failure ? { failure } : {}),
    usage: { status: 'unknown' },
    outputRefs,
    persistence,
    persistenceReason:
      persistence === 'persisted'
        ? `artifacts are committed to ${repo?.fullName ?? 'the user repository'} at ${repo?.commit ?? 'unknown'}; the API keeps no bytes`
        : 'the worker reported no artifacts',
    cleanup: 'completed',
    cleanupReason: 'the external worker owns the workspace and tears it down with its ephemeral host; there is nothing to clean on the API host',
    logPath: runLogRef(launch, options.workerBaseUrl ?? null, spec.runId),
  };
  const validated = validateRunResult(result);
  if (!validated.ok) {
    throw new PreflightError('LAUNCH_RESULT_INVALID', `mapped run result is invalid: ${validated.errors.join('; ')}`, {
      failureClass: 'runtime',
      retryable: true,
    });
  }
  return {
    result: validated.value,
    events: runnerEventsFromLaunch(spec, launch, times, artifacts, repo, logUrl),
    artifacts,
    repo,
    logUrl,
    answer: launch.answer ?? null,
  };
}

function launchFailureFor(spec: RunSpec, launch: LaunchResult, outcome: RunOutcome): RunFailure | null {
  if (outcome !== 'failed') return null;
  if (launch.failure) {
    return {
      code: launch.failure.code,
      failureClass: launch.failure.failureClass,
      // safeSummary приходит извне: тот же фильтр секретов, что и для своих сообщений.
      safeSummary: safeSummary(launch.failure.safeSummary),
      retryable: launch.failure.retryable,
    };
  }
  switch (launch.exitReason) {
    case 'nonzero_exit':
      return {
        code: 'AGENT_NONZERO_EXIT',
        failureClass: 'engine',
        safeSummary: `agent exited with code ${launch.exitCode ?? 'unknown'}`,
        retryable: false,
      };
    case 'timeout':
      return { code: 'AGENT_TIMEOUT', failureClass: 'engine', safeSummary: 'agent was killed by the worker timeout', retryable: true };
    case 'crash':
      return { code: 'AGENT_CRASH', failureClass: 'engine', safeSummary: `agent was killed by signal ${launch.exitSignal ?? 'unknown'}`, retryable: true };
    case 'startup_failure':
      return { code: 'AGENT_STARTUP_FAILED', failureClass: 'engine', safeSummary: 'agent process failed to start', retryable: true };
    case 'worker_crash':
      return { code: 'WORKER_CRASH', failureClass: 'runtime', safeSummary: 'the external worker crashed while running the agent', retryable: true };
    case 'preflight_refused':
      return { code: 'PREFLIGHT_REFUSED', failureClass: 'preflight', safeSummary: 'the worker refused the run before starting the agent', retryable: false };
    default:
      return { code: 'AGENT_FAILED', failureClass: 'engine', safeSummary: `agent run ended with exitReason ${launch.exitReason}`, retryable: true };
  }
}

function runnerEventsFromLaunch(
  spec: RunSpec,
  launch: LaunchResult,
  times: { startedAt: string; finishedAt: string },
  artifacts: LaunchArtifact[],
  repo: LaunchRepo | null,
  logUrl: string | null,
): RunnerEvent[] {
  // Два события приёма уже записаны до вызова воркера, поэтому нумерация продолжается с трёх.
  const events: RunnerEvent[] = [];
  let sequence = ADMISSION_EVENT_COUNT;
  const push = (type: RunnerEvent['type'], payload: Record<string, unknown>, timestamp: string): void => {
    sequence += 1;
    pushRunnerEvent(events, spec, sequence, type, payload, timestamp);
  };

  if (typeof launch.pid === 'number' && launch.pid > 0) push('started', { pid: launch.pid }, times.startedAt);

  for (const [stream, text] of [['stdout', launch.stdout], ['stderr', launch.stderr]] as const) {
    // Событие рана не имеет права содержать управляющие символы (в т.ч. перевод строки) —
    // иначе его отвергнет общий валидатор RunnerEvent. Запас по длине оставлен под маркер
    // обрезки, который truncateLine дописывает сам.
    const message = logMessage(text);
    if (message.length > 0) push('log', { stream, level: 'info', message }, times.startedAt);
  }
  if (logUrl) {
    push('log', { stream: 'runner', level: 'info', message: `session log: ${logUrl}` }, times.startedAt);
  }
  push('exit', { code: launch.exitCode, signal: launch.exitSignal }, times.finishedAt);
  push('finalizing', { reason: 'external worker returned the run result' }, times.finishedAt);
  // Полей ровно столько, сколько объявляет AgentExitResolvedEvent: fromManifest — счётчик
  // файлов, прочитанных из манифеста агента, reason — строка (в контракте он не nullable).
  const answered = typeof launch.answer === 'string' && launch.answer.length > 0;
  push(
    'agent_exit_resolved',
    {
      manifest: 'ok',
      declared: spec.outputs?.length ?? 0,
      fromManifest: launch.answerSource === 'agent_file' ? 1 : 0,
      answerSource: launch.answerSource ?? null,
      answerChars: launch.answer?.length ?? 0,
      planned: artifacts.length,
      reason: answered ? 'the worker reported the agent answer' : 'the worker reported no answer',
    },
    times.finishedAt,
  );
  artifacts.forEach((artifact) => {
    push(
      'artifact_exported',
      {
        artifactId: `art-${artifact.sha256.slice(0, 24)}`,
        sourcePath: artifact.path,
        size: artifact.size,
        sha256: artifact.sha256,
        mime: artifact.mime,
        version: 1,
      },
      times.finishedAt,
    );
  });

  const outcome: RunOutcome = launch.exitReason === 'completed' ? 'succeeded' : launch.exitReason === 'cancelled' ? 'cancelled' : 'failed';
  if (outcome === 'succeeded') {
    push('succeeded', { outcome, exitReason: launch.exitReason, exitCode: launch.exitCode }, times.finishedAt);
  } else if (outcome === 'cancelled') {
    push('cancelled', { outcome, exitReason: launch.exitReason, reason: 'cancelled by the API or the worker' }, times.finishedAt);
  } else {
    const failure = launchFailureFor(spec, launch, outcome);
    push(
      'failed',
      {
        outcome,
        exitReason: launch.exitReason,
        code: failure?.code ?? 'AGENT_FAILED',
        safeSummary: failure?.safeSummary ?? launch.exitReason,
      },
      times.finishedAt,
    );
  }
  return events;
}

/**
 * Отказ воркера на уровне транспорта: ран не получил `LaunchResult`, но обязан завершиться.
 * Функция не бросает — иначе ран навсегда остался бы в `running`, а клиент не узнал бы ничего.
 */
export function workerTransportFailure(
  spec: RunSpec,
  err: unknown,
  times: { startedAt: string; finishedAt: string },
  options: LaunchMappingOptions = {},
): LaunchMapping {
  const message = err instanceof Error ? err.message : String(err);
  // Отказ на границе воркера не всегда «воркер недоступен»: preflight-отказ (нет промпта,
  // refs без workspace) и таймаут launch несут собственный код, класс и retryable.
  const typed = err instanceof PreflightError ? err : null;
  const failure: RunFailure = {
    code: typed?.code ?? 'WORKER_UNREACHABLE',
    failureClass: typed?.failureClass ?? 'runtime',
    safeSummary: safeSummary(typed ? typed.message : message),
    retryable: typed?.retryable ?? true,
  };
  const preflightRefusal = typed?.failureClass === 'preflight';
  const result: RunResult = {
    schemaVersion: RUN_RESULT_SCHEMA_VERSION,
    runId: spec.runId,
    jobId: spec.jobId,
    userTaskId: spec.userTaskId,
    profileId: spec.profileId,
    ownerGeneration: spec.ownerGeneration,
    outcome: 'failed',
    exitReason: preflightRefusal ? 'preflight_refused' : 'worker_crash',
    exitCode: null,
    exitSignal: null,
    exitObserved: false,
    startedAt: times.startedAt,
    finishedAt: times.finishedAt,
    failure,
    usage: { status: 'unknown' },
    outputRefs: [],
    persistence: 'not_required',
    persistenceReason: 'the worker never returned a result, so there is nothing that could have been persisted',
    cleanup: 'completed',
    cleanupReason: 'the external worker owns the workspace; a failed launch leaves nothing to clean on the API host',
    logPath: runLogRef(null, options.workerBaseUrl ?? null, spec.runId),
  };
  const events: RunnerEvent[] = [];
  let sequence = ADMISSION_EVENT_COUNT;
  sequence += 1;
  pushRunnerEvent(
    events,
    spec,
    sequence,
    'failed',
    { outcome: 'failed', exitReason: result.exitReason, code: failure.code, safeSummary: failure.safeSummary },
    times.finishedAt,
  );
  return { result, events, artifacts: [], repo: null, logUrl: null, answer: null };
}

export class ExternalWorkerAdapter implements ExternalWorker {
  readonly remoteMcpEnabled: boolean;
  private readonly remoteMcp: RemoteMcpHostOptions | undefined;
  readonly name: string;
  readonly baseUrl: string | null;
  private readonly token: string | undefined;
  private readonly env: Record<string, string>;
  private readonly deadlineMs: number;
  private readonly cancelDeadlineMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly log: (entry: Record<string, unknown>) => void;
  private baseUrlForResult: string | undefined;

  constructor(options: ExternalWorkerOptions) {
    this.remoteMcp = options.remoteMcp ? {
      servers: parseRemoteMcpServerPolicies(JSON.stringify(options.remoteMcp.servers)),
      resolveBinding: options.remoteMcp.resolveBinding,
    } : undefined;
    this.remoteMcpEnabled = Object.keys(this.remoteMcp?.servers ?? {}).length > 0;
    this.name = options.engineName ?? EXTERNAL_WORKER_ENGINE;
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.env = options.env ?? {};
    this.deadlineMs = options.deadlineMs ?? DEFAULT_LAUNCH_DEADLINE_MS;
    this.cancelDeadlineMs = options.cancelDeadlineMs ?? DEFAULT_CANCEL_DEADLINE_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    this.baseUrlForResult = options.baseUrlForResult;
  }

  async launch(spec: RunSpec): Promise<LaunchReceipt> {
    const base = this.baseUrl;
    if (!base) {
      throw new PreflightError('WORKER_NOT_CONFIGURED', 'no external worker URL is configured for this engine', {
        failureClass: 'preflight',
        retryable: false,
      });
    }
    const bindingController = new AbortController();
    const remoteMcpAttachment = spec.mcp?.servers.length ? await withDeadline(
      resolveRemoteMcpAttachment(spec, this.remoteMcp, this.now(), bindingController.signal),
      Math.min(this.deadlineMs, spec.limits.timeoutMs),
      'trusted MCP binding resolution',
      () => bindingController.abort(),
    ).catch(error => {
      if (error instanceof PreflightError) throw error;
      throw new PreflightError('MCP_BINDING_UNAVAILABLE', 'trusted MCP binding resolution failed', { failureClass: 'preflight', retryable: false });
    }) : undefined;
    const request = launchRequestFromSpec(spec, { env: this.env, resultUrl: this.resultUrlFor(spec), remoteMcpAttachment });
    const redactAttachment = (value: string): string => Object.values(remoteMcpAttachment?.mcpSecrets ?? {}).reduce((safe, secret) => safe.split(secret).join('[REDACTED]'), value);
    const url = `${trimTrailingSlash(base)}/v1/launch`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    this.log({ event: 'worker_launch', runId: spec.runId, url, engine: spec.engine.name, timeoutMs: spec.limits.timeoutMs });

    // Запрос короткий: воркер отвечает квитанцией сразу и уходит работать. Держать соединение
    // весь ран не нужно — результат читается отдельно, поэтому таймаут здесь честно означает
    // «воркер не принял задачу», а не «ран идёт долго».
    const controller = new AbortController();
    let response: Response;
    try {
      response = await withDeadline(
        this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(request), signal: controller.signal }),
        this.deadlineMs,
        'worker launch',
        () => controller.abort(),
      );
    } catch (err) {
      // Обрываем запрос только по таймауту: abort после успешного ответа убил бы тело,
      // которое мы ещё не прочитали.
      if (controller.signal.aborted) controller.abort();
      this.log({ event: 'worker_launch_failed', runId: spec.runId, message: redactAttachment(err instanceof Error ? err.message : String(err)) });
      throw new PreflightError('WORKER_LAUNCH_UNREACHABLE', 'the external worker did not accept the run', {
        failureClass: 'runtime',
        // Ран не принят — никто его не выполняет, поэтому повтор не создаст второй.
        retryable: true,
      });
    }
    if (!response.ok) {
      const detail = truncateLine(redactSecrets(redactAttachment(await readBody(response))), 300);
      this.log({ event: 'worker_launch_http_error', runId: spec.runId, status: response.status, detail });
      throw new PreflightError('WORKER_HTTP_ERROR', `the external worker answered ${response.status} on launch`, {
        failureClass: 'runtime',
        retryable: true,
      });
    }
    const validated = validateLaunchReceipt(await readJson(response), spec.runId);
    if (!validated.ok) {
      this.log({ event: 'worker_launch_invalid', runId: spec.runId, errors: validated.errors });
      throw new PreflightError(
        'WORKER_PROTOCOL_INVALID',
        `the external worker answered launch outside the contract: ${validated.errors.join('; ')}`,
        { failureClass: 'runtime', retryable: true },
      );
    }
    this.log({ event: 'worker_launch_accepted', runId: spec.runId, engine: spec.engine.name, statusUrl: validated.value.statusUrl });
    return validated.value;
  }

  /**
   * Статус рана у воркера. Именно этот вызов даёт нашему API пережить собственный рестарт:
   * воркер помнит принятые `operationId`, и мы можем спросить «что с этим раном» в любой
   * момент, не запуская заново.
   */
  async status(runId: string): Promise<WorkerStatusView> {
    const base = this.baseUrl;
    if (!base) {
      throw new PreflightError('WORKER_NOT_CONFIGURED', 'no external worker URL is configured for this engine', {
        failureClass: 'preflight',
        retryable: false,
      });
    }
    const url = `${trimTrailingSlash(base)}/v1/runs/${runId}/status`;
    const response = await this.getJson(url, this.deadlineMs, 'worker status');
    const validated = validateWorkerStatus(await readJson(response), runId);
    if (!validated.ok) {
      throw new PreflightError(
        'WORKER_PROTOCOL_INVALID',
        `the external worker answered status outside the contract: ${validated.errors.join('; ')}`,
        { failureClass: 'runtime', retryable: true },
      );
    }
    return validated.value;
  }

  /** Финальный результат. Пока ран идёт, воркер отвечает 409 — мы поднимаем `ResultNotReadyError`. */
  async result(runId: string): Promise<LaunchResult> {
    const base = this.baseUrl;
    if (!base) {
      throw new PreflightError('WORKER_NOT_CONFIGURED', 'no external worker URL is configured for this engine', {
        failureClass: 'preflight',
        retryable: false,
      });
    }
    const url = `${trimTrailingSlash(base)}/v1/runs/${runId}/result`;
    let response: Response;
    try {
      response = await this.getJson(url, this.deadlineMs, 'worker result');
    } catch (err) {
      if (err instanceof PreflightError && err.code === 'WORKER_HTTP_ERROR') throw new ResultNotReadyError(runId);
      throw err;
    }
    // 409 — ожидаемый ответ «результата ещё нет», а не нарушение контракта.
    if (response.status === 409) throw new ResultNotReadyError(runId);
    const validated = validateLaunchResult(await readJson(response), runId);
    if (!validated.ok) {
      throw new PreflightError(
        'WORKER_PROTOCOL_INVALID',
        `the external worker answered result outside the contract: ${validated.errors.join('; ')}`,
        { failureClass: 'runtime', retryable: true },
      );
    }
    return validated.value;
  }



  /** Адрес, по которому воркер вернёт результат этого рана. */
  resultUrlFor(spec: RunSpec): string {
    const base = this.baseUrlForResult;
    if (!base) {
      throw new PreflightError('RESULT_URL_UNSET', 'the API does not know its own public URL, so it cannot tell the worker where to send the result', {
        failureClass: 'preflight',
        retryable: false,
      });
    }
    return `${trimTrailingSlash(base)}/v1/worker/launches/${spec.runId}/result`;
  }

  /**
   * Задать публичный адрес API после старта: порт сервера известен только тогда, а воркеру
   * он нужен в каждом запросе запуска.
   */
  setResultBaseUrl(baseUrl: string): void {
    this.baseUrlForResult = baseUrl;
  }

  /** Сверка предъявленного секрета: результат рана принимает только его воркер. */
  matchesToken(presented: string): boolean {
    if (!this.token || typeof presented !== 'string' || presented.length === 0) return false;
    // timingSafeEqual требует равной длины и бросает на неравной, поэтому длину сверяем
    // отдельно: токен не той длины — это «не наш», а не 500.
    const left = Buffer.from(presented);
    const right = Buffer.from(this.token);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  /** Короткий GET с Bearer-токеном; 409 на результате — ожидаемый ответ «ещё не готово». */
  private async getJson(url: string, deadlineMs: number, label: string): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    const controller = new AbortController();
    try {
      return await withDeadline(this.fetchImpl(url, { method: 'GET', headers, signal: controller.signal }), deadlineMs, label, () => controller.abort());
    } catch (err) {
      if (controller.signal.aborted) controller.abort();
      throw err;
    }
  }

  async cancel(runId: string): Promise<WorkerCancelResult> {
    const base = this.baseUrl;
    if (!base) return { status: 'unknown_run', reason: 'worker is not configured' };
    const url = `${trimTrailingSlash(base)}/v1/runs/${runId}/cancel`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    this.log({ event: 'worker_cancel', runId });

    let last = 'the worker did not answer the cancel request';
    for (let attempt = 0; attempt < CANCEL_DELIVERY_RETRIES; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, CANCEL_DELIVERY_BACKOFF_MS));
      let response: Response;
      try {
        response = await withDeadline(this.fetchImpl(url, { method: 'POST', headers, body: '{}' }), this.cancelDeadlineMs, 'worker cancel');
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (!response.ok) {
        this.log({ event: 'worker_cancel_http_error', runId, status: response.status });
        return { status: 'rejected', reason: `the worker answered ${response.status} on cancel` };
      }
      const raw = await readJson(response);
      const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const status = record['status'];
      if (status === 'cancelled') return { status: 'cancelled' };
      if (status === 'unknown_run') return { status: 'unknown_run' };
      return { status: 'rejected', reason: typeof record['reason'] === 'string' ? record['reason'] : 'the worker did not confirm the cancellation' };
    }
    this.log({ event: 'worker_cancel_failed', runId, reason: last });
    return { status: 'rejected', reason: `cancel request did not reach the worker: ${last}` };
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Тело ответа разбирается один раз; нечитаемый JSON — тоже нарушение контракта. */
async function readJson(response: Response): Promise<unknown> {
  const text = await readBody(response);
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function withDeadline<T>(promise: Promise<T>, deadlineMs: number, label: string, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out after ${deadlineMs}ms`));
        }, deadlineMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isSafeRunId(value: unknown): value is string {
  return isSafeId(value);
}

export function isUtcTimestampValue(value: unknown): value is string {
  return isUtcTimestamp(value);
}
