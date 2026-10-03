import {
  ErrorCollector,
  checkKeys,
  checkObject,
  checkPositiveInt,
  checkString,
  isSafeId,
  isUtcTimestamp,
  type ValidationResult,
} from './validate.js';
import type { RunResult } from './result.js';

export const RUNNER_EVENT_SCHEMA_VERSION = 1 as const;

export const RUNNER_EVENT_TYPES = [
  'claimed',
  'materialized',
  'started',
  'log',
  'exit',
  'finalizing',
  'artifact_exported',
  'export_committed',
  'export_failed',
  'succeeded',
  'failed',
  'cancelled',
  'connection_lost',
  'isolation_prepared',
  'agent_exit_resolved',
  'agent_answer_saved',
  'checkpoint_written',
] as const;

export type RunnerEventType = (typeof RUNNER_EVENT_TYPES)[number];

export const TERMINAL_EVENT_TYPES: readonly RunnerEventType[] = ['succeeded', 'failed', 'cancelled'];

interface EventEnvelope {
  schemaVersion: typeof RUNNER_EVENT_SCHEMA_VERSION;
  eventId: string;
  runId: string;
  jobId: string;
  userTaskId: string;
  profileId: string;
  ownerGeneration: number;
  sequence: number;
  timestamp: string;
}

export interface ClaimedEvent extends EventEnvelope {
  type: 'claimed';
  payload: { operationId: string };
}

export interface MaterializedEvent extends EventEnvelope {
  type: 'materialized';
  payload: { inputs: number };
}

export interface StartedEvent extends EventEnvelope {
  type: 'started';
  payload: { pid: number };
}

export interface LogEvent extends EventEnvelope {
  type: 'log';
  payload: { stream: 'stdout' | 'stderr' | 'runner'; level: 'info' | 'warn' | 'error'; message: string };
}

export interface ExitEvent extends EventEnvelope {
  type: 'exit';
  payload: { code: number | null; signal: string | null };
}

export interface FinalizingEvent extends EventEnvelope {
  type: 'finalizing';
  payload: { reason: string };
}

export interface ArtifactExportedEvent extends EventEnvelope {
  type: 'artifact_exported';
  payload: {
    artifactId: string;
    sourcePath: string;
    size: number;
    sha256: string;
    mime: string;
    version: number;
  };
}

export interface ExportCommittedEvent extends EventEnvelope {
  type: 'export_committed';
  payload: {
    version: number;
    status: 'complete' | 'partial' | 'failed';
    planned: number;
    exported: number;
    failed: number;
    cleanup: 'nothing_to_prune' | 'pruned' | 'retained_sole_copy';
    retained: number;
  };
}

export interface ExportFailedEvent extends EventEnvelope {
  type: 'export_failed';
  payload: { sourcePath: string; reason: string; version: number };
}

export interface SucceededEvent extends EventEnvelope {
  type: 'succeeded';
  payload: { outcome: 'succeeded'; exitReason: string; exitCode: number | null };
}

export interface FailedEvent extends EventEnvelope {
  type: 'failed';
  payload: { outcome: 'failed'; exitReason: string; code: string; safeSummary: string };
}

export interface CancelledEvent extends EventEnvelope {
  type: 'cancelled';
  payload: { outcome: 'cancelled'; exitReason: string; reason: string };
}

export interface IsolationPreparedEvent extends EventEnvelope {
  type: 'isolation_prepared';
  payload: {
    slotId: string;
    username: string;
    uid: number;
    gid: number;
    acl: 'posix_0700' | 'posix_0700_acl';
    probe: { checks: number; failures: number };
  };
}

/**
 * Выход рана определён (issue #52, шаг 2): что считается результатом — объявленные
 * выходы, манифест агента, текст ответа. Содержимое ответа в событие не попадает:
 * в журнале рана живут источник и размер, а не персональные данные и секреты.
 */
export interface AgentExitResolvedEvent extends EventEnvelope {
  type: 'agent_exit_resolved';
  payload: {
    manifest: 'absent' | 'ok' | 'invalid';
    declared: number;
    fromManifest: number;
    answerSource: 'agent_file' | 'engine_stdout' | null;
    answerChars: number;
    planned: number;
    reason: string;
  };
}

/**
 * Текст ответа агента сохранён в долговечном хранилище отдельным артефактом.
 * Содержимое в событие не попадает: только источник, размер и id артефакта.
 */
export interface AgentAnswerSavedEvent extends EventEnvelope {
  type: 'agent_answer_saved';
  payload: {
    artifactId: string;
    source: 'agent_file' | 'engine_stdout';
    chars: number;
    size: number;
  };
}

/** Обязательный checkpoint lifecycle записан на диск: фаза, сохранение, уборка. */
export interface CheckpointWrittenEvent extends EventEnvelope {
  type: 'checkpoint_written';
  payload: {
    phase: 'engine_terminal' | 'persisted' | 'cleanup_pending' | 'complete';
    persistence: 'not_required' | 'pending' | 'persisted' | 'failed';
    cleanup: 'pending' | 'sweeping' | 'completed' | 'blocked';
    outputRefs: number;
    reason: string;
  };
}

export interface ConnectionLostEvent extends EventEnvelope {
  type: 'connection_lost';
  payload: { detectedAt: string; detail: string; engineAlive: boolean };
}

export type RunnerEvent =
  | ClaimedEvent
  | MaterializedEvent
  | StartedEvent
  | LogEvent
  | ExitEvent
  | FinalizingEvent
  | ArtifactExportedEvent
  | ExportCommittedEvent
  | ExportFailedEvent
  | SucceededEvent
  | FailedEvent
  | CancelledEvent
  | ConnectionLostEvent
  | AgentExitResolvedEvent
  | AgentAnswerSavedEvent
  | CheckpointWrittenEvent;

export interface EventInput {
  type: RunnerEventType;
  ownerGeneration: number;
  payload: unknown;
}

export function isTerminalEventType(type: RunnerEventType): boolean {
  return TERMINAL_EVENT_TYPES.includes(type);
}

const ENVELOPE_KEYS = [
  'schemaVersion',
  'eventId',
  'runId',
  'jobId',
  'userTaskId',
  'profileId',
  'ownerGeneration',
  'sequence',
  'timestamp',
  'type',
  'payload',
] as const;

const PAYLOAD_KEYS: Record<RunnerEventType, readonly string[]> = {
  claimed: ['operationId'],
  materialized: ['inputs'],
  started: ['pid'],
  log: ['stream', 'level', 'message'],
  exit: ['code', 'signal'],
  finalizing: ['reason'],
  artifact_exported: ['artifactId', 'sourcePath', 'size', 'sha256', 'mime', 'version'],
  export_committed: ['version', 'status', 'planned', 'exported', 'failed', 'cleanup', 'retained'],
  export_failed: ['sourcePath', 'reason', 'version'],
  succeeded: ['outcome', 'exitReason', 'exitCode'],
  failed: ['outcome', 'exitReason', 'code', 'safeSummary'],
  cancelled: ['outcome', 'exitReason', 'reason'],
  connection_lost: ['detectedAt', 'detail', 'engineAlive'],
  isolation_prepared: ['slotId', 'username', 'uid', 'gid', 'acl', 'probe'],
  agent_exit_resolved: ['manifest', 'declared', 'fromManifest', 'answerSource', 'answerChars', 'planned', 'reason'],
  agent_answer_saved: ['artifactId', 'source', 'chars', 'size'],
  checkpoint_written: ['phase', 'persistence', 'cleanup', 'outputRefs', 'reason'],
};

function validatePayload(type: RunnerEventType, value: unknown, path: string, collector: ErrorCollector): void {
  if (!checkObject(value, path, collector)) return;
  const allowed = PAYLOAD_KEYS[type];
  checkKeys(value, allowed, allowed, path, collector);

  switch (type) {
    case 'claimed':
      checkString(value['operationId'], `${path}.operationId`, collector, 200);
      break;
    case 'materialized':
      if (typeof value['inputs'] !== 'number' || !Number.isInteger(value['inputs']) || value['inputs'] < 0) {
        collector.push(`${path}.inputs: expected non-negative integer`);
      }
      break;
    case 'started':
      if (typeof value['pid'] !== 'number' || !Number.isInteger(value['pid']) || value['pid'] <= 0) {
        collector.push(`${path}.pid: expected positive integer`);
      }
      break;
    case 'log':
      if (value['stream'] !== 'stdout' && value['stream'] !== 'stderr' && value['stream'] !== 'runner') {
        collector.push(`${path}.stream: expected stdout | stderr | runner`);
      }
      if (value['level'] !== 'info' && value['level'] !== 'warn' && value['level'] !== 'error') {
        collector.push(`${path}.level: expected info | warn | error`);
      }
      checkString(value['message'], `${path}.message`, collector, 10_000);
      break;
    case 'exit':
      if (value['code'] !== null && typeof value['code'] !== 'number') collector.push(`${path}.code: expected number or null`);
      if (value['signal'] !== null && typeof value['signal'] !== 'string') collector.push(`${path}.signal: expected string or null`);
      break;
    case 'finalizing':
      checkString(value['reason'], `${path}.reason`, collector, 200);
      break;
    case 'artifact_exported': {
      checkString(value['artifactId'], `${path}.artifactId`, collector, 200);
      checkString(value['sourcePath'], `${path}.sourcePath`, collector, 512);
      if (typeof value['size'] !== 'number' || !Number.isInteger(value['size']) || value['size'] < 0) {
        collector.push(`${path}.size: expected non-negative integer`);
      }
      checkString(value['sha256'], `${path}.sha256`, collector, 64);
      checkString(value['mime'], `${path}.mime`, collector, 100);
      checkPositiveInt(value['version'], `${path}.version`, collector);
      break;
    }
    case 'export_committed': {
      checkPositiveInt(value['version'], `${path}.version`, collector);
      if (value['status'] !== 'complete' && value['status'] !== 'partial' && value['status'] !== 'failed') {
        collector.push(`${path}.status: expected complete | partial | failed`);
      }
      for (const key of ['planned', 'exported', 'failed', 'retained'] as const) {
        if (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || value[key] < 0) {
          collector.push(`${path}.${key}: expected non-negative integer`);
        }
      }
      if (value['cleanup'] !== 'nothing_to_prune' && value['cleanup'] !== 'pruned' && value['cleanup'] !== 'retained_sole_copy') {
        collector.push(`${path}.cleanup: expected nothing_to_prune | pruned | retained_sole_copy`);
      }
      break;
    }
    case 'export_failed':
      checkString(value['sourcePath'], `${path}.sourcePath`, collector, 512);
      checkString(value['reason'], `${path}.reason`, collector, 300);
      checkPositiveInt(value['version'], `${path}.version`, collector);
      break;
    case 'succeeded':
      if (value['outcome'] !== 'succeeded') collector.push(`${path}.outcome: expected "succeeded"`);
      checkString(value['exitReason'], `${path}.exitReason`, collector, 100);
      if (value['exitCode'] !== null && typeof value['exitCode'] !== 'number') collector.push(`${path}.exitCode: expected number or null`);
      break;
    case 'failed':
      if (value['outcome'] !== 'failed') collector.push(`${path}.outcome: expected "failed"`);
      checkString(value['exitReason'], `${path}.exitReason`, collector, 100);
      checkString(value['code'], `${path}.code`, collector, 100);
      checkString(value['safeSummary'], `${path}.safeSummary`, collector, 500);
      break;
    case 'cancelled':
      if (value['outcome'] !== 'cancelled') collector.push(`${path}.outcome: expected "cancelled"`);
      checkString(value['exitReason'], `${path}.exitReason`, collector, 100);
      checkString(value['reason'], `${path}.reason`, collector, 100);
      break;
    case 'isolation_prepared': {
      checkString(value['slotId'], `${path}.slotId`, collector, 100);
      checkString(value['username'], `${path}.username`, collector, 100);
      for (const key of ['uid', 'gid'] as const) {
        if (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || (value[key] as number) <= 0) {
          collector.push(`${path}.${key}: expected positive integer`);
        }
      }
      if (value['acl'] !== 'posix_0700' && value['acl'] !== 'posix_0700_acl') {
        collector.push(`${path}.acl: expected posix_0700 | posix_0700_acl`);
      }
      const probe = value['probe'];
      if (!checkObject(probe, `${path}.probe`, collector)) break;
      checkKeys(probe, ['checks', 'failures'], ['checks', 'failures'], `${path}.probe`, collector);
      for (const key of ['checks', 'failures'] as const) {
        if (typeof probe[key] !== 'number' || !Number.isInteger(probe[key]) || (probe[key] as number) < 0) {
          collector.push(`${path}.probe.${key}: expected non-negative integer`);
        }
      }
      break;
    }
    case 'connection_lost':
      if (!isUtcTimestamp(value['detectedAt'])) collector.push(`${path}.detectedAt: expected UTC ISO timestamp`);
      checkString(value['detail'], `${path}.detail`, collector, 500);
      if (typeof value['engineAlive'] !== 'boolean') collector.push(`${path}.engineAlive: expected boolean`);
      break;
  }
}

export function validateRunnerEvent(input: unknown): ValidationResult<RunnerEvent> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'event', collector)) return collector.finish(undefined as never);
  checkKeys(input, ENVELOPE_KEYS, ENVELOPE_KEYS, 'event', collector);

  if (input['schemaVersion'] !== RUNNER_EVENT_SCHEMA_VERSION) collector.push('event.schemaVersion: expected 1');
  if (!isSafeId(input['eventId'])) collector.push('event.eventId: expected id');
  if (!isSafeId(input['runId'])) collector.push('event.runId: expected id');
  if (!isSafeId(input['jobId'])) collector.push('event.jobId: expected id');
  checkString(input['userTaskId'], 'event.userTaskId', collector, 200);
  checkString(input['profileId'], 'event.profileId', collector, 200);
  if (typeof input['ownerGeneration'] !== 'number' || !Number.isInteger(input['ownerGeneration']) || input['ownerGeneration'] < 0) {
    collector.push('event.ownerGeneration: expected non-negative integer');
  }
  if (typeof input['sequence'] !== 'number' || !Number.isInteger(input['sequence']) || input['sequence'] < 0) {
    collector.push('event.sequence: expected non-negative integer');
  }
  if (!isUtcTimestamp(input['timestamp'])) collector.push('event.timestamp: expected UTC ISO timestamp');

  const type = input['type'];
  if (typeof type !== 'string' || !(RUNNER_EVENT_TYPES as readonly string[]).includes(type)) {
    collector.push(`event.type: expected one of ${RUNNER_EVENT_TYPES.join(', ')}`);
  } else {
    validatePayload(type as RunnerEventType, input['payload'], 'event.payload', collector);
  }

  return collector.finish(input as unknown as RunnerEvent);
}

export function terminalPayloadForResult(result: RunResult):
  | SucceededEvent['payload']
  | FailedEvent['payload']
  | CancelledEvent['payload'] {
  if (result.outcome === 'succeeded') {
    return { outcome: 'succeeded', exitReason: result.exitReason, exitCode: result.exitCode };
  }
  if (result.outcome === 'failed') {
    return {
      outcome: 'failed',
      exitReason: result.exitReason,
      code: result.failure?.code ?? 'UNKNOWN',
      safeSummary: result.failure?.safeSummary ?? result.exitReason,
    };
  }
  return { outcome: 'cancelled', exitReason: result.exitReason, reason: result.exitReason };
}
