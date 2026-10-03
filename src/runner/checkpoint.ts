import {
  ErrorCollector,
  checkArray,
  checkKeys,
  checkObject,
  checkString,
  isRecord,
  isUtcTimestamp,
  type ValidationResult,
} from '../contracts/validate.js';
import type { RunState } from './state-machine.js';

/**
 * Обязательный checkpoint рана (issue #52, шаг 2 и 4).
 *
 * Единственный долговечный ответ на вопрос «что уже сделано с ран��м и что осталось»:
 * движок завершён, выход определён, байты подтверждены чтением, намерение уборки записано.
 * Он лежит рядом с `state.json`, а не в workspace — поэтому переживает sweep чистой среды
 * и читается после него. Восстановление после сбоя смотрит в checkpoint и повторяет
 * persist/sweep, не перезапуская движок.
 *
 * Checkpoint НЕ заменяет result.json: результат — контракт для клиента, checkpoint —
 * журнал прогресса lifecycle с причиной каждого решения.
 */
export const RUN_CHECKPOINT_SCHEMA_VERSION = 1 as const;

/** Потолок текста ответа в checkpoint: тот же, что и у сохраняемого артефакта. */
export const ANSWER_MAX_CHARS = 100_000;

export type CheckpointPhase = 'engine_terminal' | 'persisted' | 'cleanup_pending' | 'complete';
export type CheckpointPersistence = 'not_required' | 'pending' | 'persisted' | 'failed';
export type CheckpointCleanupStatus = 'pending' | 'sweeping' | 'completed' | 'blocked';
export type CheckpointAnswerSource = 'agent_file' | 'engine_stdout' | null;

export interface RunCheckpoint {
  schemaVersion: typeof RUN_CHECKPOINT_SCHEMA_VERSION;
  runId: string;
  jobId: string;
  userTaskId: string;
  profileId: string;
  ownerGeneration: number;
  phase: CheckpointPhase;
  updatedAt: string;
  engine: {
    state: RunState;
    exitObserved: boolean;
    exitCode: number | null;
    exitSignal: string | null;
    exitReason: string;
    startedAt: string;
    finishedAt: string;
  };
  answer: {
    present: boolean;
    source: CheckpointAnswerSource;
    chars: number;
    /** Текст ответа агента: единственная долговечная копия, не зависящая от хранилища. */
    text: string;
    artifactId: string | null;
    reason: string;
  };
  outputs: {
    declared: number;
    fromAgentManifest: number;
    planned: number;
    exported: number;
    failed: number;
    retained: string[];
    outputRefs: string[];
    exportStatus: string | null;
    exportVersion: number | null;
  };
  persistence: CheckpointPersistence;
  cleanup: {
    status: CheckpointCleanupStatus;
    reason: string | null;
    intentAt: string | null;
    finishedAt: string | null;
  };
}

const CHECKPOINT_KEYS = [
  'schemaVersion',
  'runId',
  'jobId',
  'userTaskId',
  'profileId',
  'ownerGeneration',
  'phase',
  'updatedAt',
  'engine',
  'answer',
  'outputs',
  'persistence',
  'cleanup',
] as const;

const ENGINE_KEYS = ['state', 'exitObserved', 'exitCode', 'exitSignal', 'exitReason', 'startedAt', 'finishedAt'] as const;
const ANSWER_KEYS = ['present', 'source', 'chars', 'text', 'artifactId', 'reason'] as const;
const OUTPUT_KEYS = [
  'declared',
  'fromAgentManifest',
  'planned',
  'exported',
  'failed',
  'retained',
  'outputRefs',
  'exportStatus',
  'exportVersion',
] as const;
const CLEANUP_KEYS = ['status', 'reason', 'intentAt', 'finishedAt'] as const;

const PHASES: readonly CheckpointPhase[] = ['engine_terminal', 'persisted', 'cleanup_pending', 'complete'];
const PERSISTENCE: readonly CheckpointPersistence[] = ['not_required', 'pending', 'persisted', 'failed'];
const CLEANUP_STATUSES: readonly CheckpointCleanupStatus[] = ['pending', 'sweeping', 'completed', 'blocked'];
const RUN_STATES: readonly RunState[] = ['queued', 'starting', 'running', 'finalizing', 'succeeded', 'failed', 'cancelled'];

function nullableInt(value: unknown, path: string, collector: ErrorCollector): void {
  if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
    collector.push(`${path}: expected a non-negative integer or null`);
  }
}

function nullableTimestamp(value: unknown, path: string, collector: ErrorCollector): void {
  if (value !== null && !isUtcTimestamp(value)) collector.push(`${path}: expected a UTC ISO timestamp or null`);
}

function nullableString(value: unknown, path: string, collector: ErrorCollector, max: number): void {
  if (value !== null && (typeof value !== 'string' || value.length > max)) {
    collector.push(`${path}: expected a string of at most ${max} chars or null`);
  }
}

export function validateRunCheckpoint(input: unknown): ValidationResult<RunCheckpoint> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'checkpoint', collector)) return collector.finish(undefined as never);
  checkKeys(input, CHECKPOINT_KEYS, CHECKPOINT_KEYS, 'checkpoint', collector);
  if (input['schemaVersion'] !== RUN_CHECKPOINT_SCHEMA_VERSION) collector.push('checkpoint.schemaVersion: expected 1');
  checkString(input['runId'], 'checkpoint.runId', collector, 200);
  checkString(input['jobId'], 'checkpoint.jobId', collector, 200);
  checkString(input['userTaskId'], 'checkpoint.userTaskId', collector, 200);
  checkString(input['profileId'], 'checkpoint.profileId', collector, 200);
  if (typeof input['ownerGeneration'] !== 'number' || !Number.isInteger(input['ownerGeneration']) || input['ownerGeneration'] < 0) {
    collector.push('checkpoint.ownerGeneration: expected non-negative integer');
  }
  if (!(PHASES as readonly string[]).includes(input['phase'] as string)) {
    collector.push(`checkpoint.phase: expected one of ${PHASES.join(' | ')}`);
  }
  if (!isUtcTimestamp(input['updatedAt'])) collector.push('checkpoint.updatedAt: expected UTC ISO timestamp');

  if (checkObject(input['engine'], 'checkpoint.engine', collector)) {
    checkKeys(input['engine'], ENGINE_KEYS, ENGINE_KEYS, 'checkpoint.engine', collector);
    if (!(RUN_STATES as readonly string[]).includes(input['engine']['state'] as string)) {
      collector.push('checkpoint.engine.state: expected a known run state');
    }
    if (typeof input['engine']['exitObserved'] !== 'boolean') collector.push('checkpoint.engine.exitObserved: expected boolean');
    nullableInt(input['engine']['exitCode'], 'checkpoint.engine.exitCode', collector);
    nullableString(input['engine']['exitSignal'], 'checkpoint.engine.exitSignal', collector, 40);
    checkString(input['engine']['exitReason'], 'checkpoint.engine.exitReason', collector, 40);
    if (!isUtcTimestamp(input['engine']['startedAt'])) collector.push('checkpoint.engine.startedAt: expected UTC ISO timestamp');
    if (!isUtcTimestamp(input['engine']['finishedAt'])) collector.push('checkpoint.engine.finishedAt: expected UTC ISO timestamp');
  }

  if (checkObject(input['answer'], 'checkpoint.answer', collector)) {
    checkKeys(input['answer'], ANSWER_KEYS, ANSWER_KEYS, 'checkpoint.answer', collector);
    if (typeof input['answer']['present'] !== 'boolean') collector.push('checkpoint.answer.present: expected boolean');
    const source = input['answer']['source'];
    if (source !== null && source !== 'agent_file' && source !== 'engine_stdout') {
      collector.push('checkpoint.answer.source: expected agent_file | engine_stdout | null');
    }
    nullableInt(input['answer']['chars'], 'checkpoint.answer.chars', collector);
    const text = input['answer']['text'];
    if (typeof text !== 'string' || text.length > ANSWER_MAX_CHARS) {
      collector.push(`checkpoint.answer.text: expected a string of at most ${ANSWER_MAX_CHARS} chars`);
    }
    nullableString(input['answer']['artifactId'], 'checkpoint.answer.artifactId', collector, 200);
    checkString(input['answer']['reason'], 'checkpoint.answer.reason', collector, 300);
  }

  if (checkObject(input['outputs'], 'checkpoint.outputs', collector)) {
    checkKeys(input['outputs'], OUTPUT_KEYS, OUTPUT_KEYS, 'checkpoint.outputs', collector);
    for (const key of ['declared', 'fromAgentManifest', 'planned', 'exported', 'failed'] as const) {
      const value = input['outputs'][key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        collector.push(`checkpoint.outputs.${key}: expected non-negative integer`);
      }
    }
    for (const key of ['retained', 'outputRefs'] as const) {
      if (checkArray(input['outputs'][key], `checkpoint.outputs.${key}`, collector)) {
        input['outputs'][key].forEach((entry, i) => checkString(entry, `checkpoint.outputs.${key}[${i}]`, collector, 512));
      }
    }
    nullableString(input['outputs']['exportStatus'], 'checkpoint.outputs.exportStatus', collector, 40);
    nullableInt(input['outputs']['exportVersion'], 'checkpoint.outputs.exportVersion', collector);
  }

  if (!(PERSISTENCE as readonly string[]).includes(input['persistence'] as string)) {
    collector.push(`checkpoint.persistence: expected one of ${PERSISTENCE.join(' | ')}`);
  }

  if (checkObject(input['cleanup'], 'checkpoint.cleanup', collector)) {
    checkKeys(input['cleanup'], CLEANUP_KEYS, CLEANUP_KEYS, 'checkpoint.cleanup', collector);
    if (!(CLEANUP_STATUSES as readonly string[]).includes(input['cleanup']['status'] as string)) {
      collector.push(`checkpoint.cleanup.status: expected one of ${CLEANUP_STATUSES.join(' | ')}`);
    }
    nullableString(input['cleanup']['reason'], 'checkpoint.cleanup.reason', collector, 500);
    nullableTimestamp(input['cleanup']['intentAt'], 'checkpoint.cleanup.intentAt', collector);
    nullableTimestamp(input['cleanup']['finishedAt'], 'checkpoint.cleanup.finishedAt', collector);
  }

  // согласованность: `complete` означает и сохранение, и проверенную уборку
  const cleanupStatus = isRecord(input['cleanup']) ? input['cleanup']['status'] : undefined;
  if (input['phase'] === 'complete') {
    if (cleanupStatus !== 'completed') {
      collector.push('checkpoint.phase: a complete checkpoint must declare cleanup.status=completed');
    }
    if (input['persistence'] === 'failed') {
      collector.push('checkpoint.phase: a complete checkpoint cannot carry persistence=failed');
    }
  }
  if (input['phase'] === 'persisted' && cleanupStatus === 'completed') {
    collector.push('checkpoint.phase: cleanup completed means phase=complete');
  }

  return collector.finish(input as unknown as RunCheckpoint);
}