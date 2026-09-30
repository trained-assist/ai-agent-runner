import { ErrorCollector, checkKeys, checkObject, checkString, isSafeId, isUtcTimestamp, type ValidationResult } from './validate.js';

export const RUN_RESULT_SCHEMA_VERSION = 1 as const;

export type RunOutcome = 'succeeded' | 'failed' | 'cancelled';

export type ExitReason =
  | 'completed'
  | 'nonzero_exit'
  | 'startup_failure'
  | 'timeout'
  | 'crash'
  | 'cancelled'
  | 'worker_crash'
  | 'preflight_refused';

export type FailureClass = 'preflight' | 'engine' | 'runtime' | 'finalization';

export interface RunFailure {
  code: string;
  failureClass: FailureClass;
  safeSummary: string;
  retryable: boolean;
}

export type UsageReport = { status: 'unknown' } | { status: 'known'; usd: number };

export interface RunResult {
  schemaVersion: typeof RUN_RESULT_SCHEMA_VERSION;
  runId: string;
  jobId: string;
  userTaskId: string;
  profileId: string;
  ownerGeneration: number;
  outcome: RunOutcome;
  exitReason: ExitReason;
  exitCode: number | null;
  exitSignal: string | null;
  exitObserved: boolean;
  startedAt: string;
  finishedAt: string;
  failure?: RunFailure;
  usage: UsageReport;
  outputRefs: string[];
  persistence: 'pending' | 'persisted' | 'failed';
  cleanup: 'pending' | 'completed' | 'failed';
  logPath: string;
}

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

const FAILURE_CLASSES: readonly FailureClass[] = ['preflight', 'engine', 'runtime', 'finalization'];

const RESULT_KEYS = [
  'schemaVersion',
  'runId',
  'jobId',
  'userTaskId',
  'profileId',
  'ownerGeneration',
  'outcome',
  'exitReason',
  'exitCode',
  'exitSignal',
  'exitObserved',
  'startedAt',
  'finishedAt',
  'failure',
  'usage',
  'outputRefs',
  'persistence',
  'cleanup',
  'logPath',
] as const;

const OUTCOME_EXIT_REASONS: Record<RunOutcome, readonly ExitReason[]> = {
  succeeded: ['completed'],
  failed: ['nonzero_exit', 'startup_failure', 'timeout', 'crash', 'worker_crash', 'preflight_refused'],
  cancelled: ['cancelled'],
};

export function validateRunResult(input: unknown): ValidationResult<RunResult> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'result', collector)) return collector.finish(undefined as never);
  checkKeys(input, RESULT_KEYS, RESULT_KEYS, 'result', collector);

  if (input['schemaVersion'] !== RUN_RESULT_SCHEMA_VERSION) collector.push('result.schemaVersion: expected 1');
  if (!isSafeId(input['runId'])) collector.push('result.runId: expected id');
  if (!isSafeId(input['jobId'])) collector.push('result.jobId: expected id');
  checkString(input['userTaskId'], 'result.userTaskId', collector, 200);
  checkString(input['profileId'], 'result.profileId', collector, 200);
  if (typeof input['ownerGeneration'] !== 'number' || !Number.isInteger(input['ownerGeneration']) || input['ownerGeneration'] < 0) {
    collector.push('result.ownerGeneration: expected non-negative integer');
  }

  const outcome = input['outcome'];
  if (outcome !== 'succeeded' && outcome !== 'failed' && outcome !== 'cancelled') {
    collector.push('result.outcome: expected succeeded | failed | cancelled');
  }

  const exitReason = input['exitReason'];
  if (typeof exitReason !== 'string' || !(EXIT_REASONS as readonly string[]).includes(exitReason)) {
    collector.push(`result.exitReason: expected one of ${EXIT_REASONS.join(', ')}`);
  } else if (outcome && (OUTCOME_EXIT_REASONS as Record<string, readonly string[]>)[outcome as RunOutcome]) {
    if (!(OUTCOME_EXIT_REASONS as Record<string, readonly string[]>)[outcome as RunOutcome]!.includes(exitReason)) {
      collector.push(`result.exitReason: "${exitReason}" is not valid for outcome "${outcome}"`);
    }
  }

  if (input['exitCode'] !== null && typeof input['exitCode'] !== 'number') collector.push('result.exitCode: expected number or null');
  if (input['exitSignal'] !== null && typeof input['exitSignal'] !== 'string') collector.push('result.exitSignal: expected string or null');
  if (typeof input['exitObserved'] !== 'boolean') collector.push('result.exitObserved: expected boolean');
  if (!isUtcTimestamp(input['startedAt'])) collector.push('result.startedAt: expected UTC ISO timestamp');
  if (!isUtcTimestamp(input['finishedAt'])) collector.push('result.finishedAt: expected UTC ISO timestamp');

  const failure = input['failure'];
  if (outcome === 'failed' && failure === undefined) collector.push('result.failure: required for failed outcome');
  if (outcome !== 'failed' && failure !== undefined) collector.push('result.failure: only allowed for failed outcome');
  if (failure !== undefined) {
    if (!checkObject(failure, 'result.failure', collector)) {
      // already reported
    } else {
      checkKeys(failure, ['code', 'failureClass', 'safeSummary', 'retryable'], ['code', 'failureClass', 'safeSummary', 'retryable'], 'result.failure', collector);
      checkString(failure['code'], 'result.failure.code', collector, 100);
      checkString(failure['safeSummary'], 'result.failure.safeSummary', collector, 500);
      if (typeof failure['retryable'] !== 'boolean') collector.push('result.failure.retryable: expected boolean');
      if (failure['failureClass'] !== undefined && !(FAILURE_CLASSES as readonly string[]).includes(failure['failureClass'] as string)) {
        collector.push(`result.failure.failureClass: expected one of ${FAILURE_CLASSES.join(', ')}`);
      }
    }
  }

  const usage = input['usage'];
  if (!checkObject(usage, 'result.usage', collector)) {
    // already reported
  } else if (usage['status'] !== 'unknown' && usage['status'] !== 'known') {
    collector.push('result.usage.status: expected unknown | known');
  } else if (usage['status'] === 'known' && (typeof usage['usd'] !== 'number' || Number.isNaN(usage['usd']))) {
    collector.push('result.usage.usd: required for known status');
  }

  if (!Array.isArray(input['outputRefs'])) collector.push('result.outputRefs: expected array');
  else input['outputRefs'].forEach((ref, i) => checkString(ref, `result.outputRefs[${i}]`, collector, 500));

  if (input['persistence'] !== 'pending' && input['persistence'] !== 'persisted' && input['persistence'] !== 'failed') {
    collector.push('result.persistence: expected pending | persisted | failed');
  }
  if (input['cleanup'] !== 'pending' && input['cleanup'] !== 'completed' && input['cleanup'] !== 'failed') {
    collector.push('result.cleanup: expected pending | completed | failed');
  }
  checkString(input['logPath'], 'result.logPath', collector, 500);

  return collector.finish(input as unknown as RunResult);
}
