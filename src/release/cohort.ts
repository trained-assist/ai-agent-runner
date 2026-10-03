import { createHash } from 'node:crypto';
import { ErrorCollector, checkKeys, checkObject, checkPositiveInt, checkString, type ValidationResult } from '../contracts/validate.js';

export const COHORT_MODES = ['off', 'allowlist', 'percentage'] as const;

export type CohortMode = (typeof COHORT_MODES)[number];

export interface CohortPolicy {
  cohortId: string;
  /** `off` — никого; `allowlist` — только principals; `percentage` — детерминированная доля. */
  mode: CohortMode;
  principals: string[];
  /** 1..100, применяется только в режиме `percentage`. */
  rolloutPercent: number;
}

export type CohortReason = 'cohort_off' | 'allowlisted' | 'rollout_bucket' | 'outside_allowlist' | 'outside_rollout';

export interface CohortDecision {
  inCohort: boolean;
  cohortId: string;
  reason: CohortReason;
  /** Детерминированный бакет 0..9999 — пишется в лог, чтобы состав когорты был воспроизводим. */
  bucket: number;
}

const POLICY_KEYS = ['cohortId', 'mode', 'principals', 'rolloutPercent'] as const;
const POLICY_REQUIRED = ['cohortId', 'mode'] as const;

export function validateCohortPolicy(input: unknown): ValidationResult<CohortPolicy> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'cohort', collector)) return collector.finish(undefined as never);
  checkKeys(input, POLICY_KEYS, POLICY_REQUIRED, 'cohort', collector);
  checkString(input['cohortId'], 'cohort.cohortId', collector, 100);

  const mode = input['mode'];
  if (typeof mode !== 'string' || !(COHORT_MODES as readonly string[]).includes(mode)) {
    collector.push(`cohort.mode: expected one of ${COHORT_MODES.join(', ')}`);
    return collector.finish(undefined as never);
  }
  const principals: string[] = [];
  if (input['principals'] !== undefined) {
    if (Array.isArray(input['principals'])) {
      if (input['principals'].length > 500) collector.push('cohort.principals: at most 500 entries');
      for (const entry of input['principals']) {
        checkString(entry, 'cohort.principals[]', collector, 200);
        if (typeof entry === 'string' && entry.length > 0 && !principals.includes(entry)) principals.push(entry);
      }
    } else {
      collector.push('cohort.principals: expected array');
    }
  }
  let rolloutPercent = 0;
  if (input['rolloutPercent'] !== undefined) {
    const percent = input['rolloutPercent'];
    if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 0 || percent > 100) {
      collector.push('cohort.rolloutPercent: expected integer in [0, 100]');
    } else {
      rolloutPercent = percent;
    }
  }
  if (mode === 'percentage' && rolloutPercent <= 0) {
    collector.push('cohort.rolloutPercent: percentage mode needs a rollout of at least 1');
  }
  if (mode === 'allowlist' && principals.length === 0) {
    collector.push('cohort.principals: allowlist mode needs at least one principal');
  }
  if (!collector.ok) return collector.finish(undefined as never);

  return collector.finish({ cohortId: input['cohortId'] as string, mode: mode as CohortMode, principals, rolloutPercent });
}

/**
 * Детерминированный бакет принципала в когорте: одинаковый вход → одинаковое решение
 * на любом воркере и после любого рестарта (иначе «когорта» means nothing в логах).
 */
export function cohortBucket(cohortId: string, principalId: string): number {
  const digest = createHash('sha256').update(`${cohortId}:${principalId}`, 'utf8').digest();
  const value = digest.readUInt32BE(0);
  return value % 10_000;
}

export function cohortDecision(policy: CohortPolicy, principalId: string): CohortDecision {
  const bucket = cohortBucket(policy.cohortId, principalId);
  switch (policy.mode) {
    case 'off':
      return { inCohort: false, cohortId: policy.cohortId, reason: 'cohort_off', bucket };
    case 'allowlist':
      return policy.principals.includes(principalId)
        ? { inCohort: true, cohortId: policy.cohortId, reason: 'allowlisted', bucket }
        : { inCohort: false, cohortId: policy.cohortId, reason: 'outside_allowlist', bucket };
    case 'percentage':
    default:
      return bucket < policy.rolloutPercent * 100
        ? { inCohort: true, cohortId: policy.cohortId, reason: 'rollout_bucket', bucket }
        : { inCohort: false, cohortId: policy.cohortId, reason: 'outside_rollout', bucket };
  }
}

/** Флаг, который меняется при выкатке: когорта выключена, когорта в процентах, allowlist. */
export function cohortFromEnv(env: Record<string, string | undefined>): CohortPolicy {
  const cohortId = env['AGENT_API_COHORT_ID']?.trim() || 'off';
  const raw = env['AGENT_API_COHORT_MODE']?.trim() || 'off';
  if (raw === 'off' && cohortId === 'off') {
    return { cohortId: 'off', mode: 'off', principals: [], rolloutPercent: 0 };
  }
  const mode = raw as CohortMode;
  if (mode !== 'off' && !(COHORT_MODES as readonly string[]).includes(mode)) {
    throw new Error(`AGENT_API_COHORT_MODE: expected one of ${COHORT_MODES.join(', ')}, got "${raw}"`);
  }
  const percentRaw = env['AGENT_API_COHORT_ROLLOUT_PERCENT']?.trim();
  const result = validateCohortPolicy({
    cohortId,
    mode,
    principals: (env['AGENT_API_COHORT_PRINCIPALS'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    rolloutPercent: percentRaw === undefined || percentRaw === '' ? undefined : Number(percentRaw),
  });
  if (!result.ok) throw new Error(`cohort configuration is invalid: ${result.errors.join('; ')}`);
  return result.value;
}