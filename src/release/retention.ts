import { isTerminalState, type RunState } from '../runner/state-machine.js';
import type { ReleaseRetentionPolicy } from './manifest.js';

export interface RetentionRunRef {
  runId: string;
  state: RunState;
  updatedAt: string;
}

export interface RetentionHealth {
  policy: ReleaseRetentionPolicy;
  evaluatedAt: string;
  total: number;
  active: number;
  terminal: number;
  /** Терминальные раны старше `mainEventsDays` — кандидаты на удаление основного потока логов. */
  expiredRuns: string[];
  /** Кандидаты на удаление verbose-потока (stdout/stderr рана). */
  verboseExpiredRuns: string[];
  /**
   * Нетерминальные раны retention не трогает никогда: живой процесс и незавершённый
   * экспорт — не «протухшие логи», а незаконченная работа.
   */
  protectedActiveRuns: string[];
  /** Удаление в этом срезе НЕ выполняется — список кандидатов и защищённых ранов. */
  removalPerformed: false;
  verdict: 'ok' | 'attention';
}

export interface RetentionHealthInput {
  policy: ReleaseRetentionPolicy;
  runs: RetentionRunRef[];
  now?: Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Retention health (I10, «logs retention … evidence»). Проверяется ускоренным clock'ом:
 * срок считается от `updatedAt` рана, поэтому недельный TTL проверяется минутой времени.
 * Физического удаления здесь нет — возвращается план (`expiredRuns`) и защищённые раны.
 */
export function retentionHealth(input: RetentionHealthInput): RetentionHealth {
  const now = input.now ?? new Date();
  const expiredRuns: string[] = [];
  const verboseExpiredRuns: string[] = [];
  const protectedActiveRuns: string[] = [];
  let active = 0;
  let terminal = 0;

  for (const run of input.runs) {
    const ageDays = ageInDays(now, run.updatedAt);
    if (!isTerminalState(run.state)) {
      active += 1;
      protectedActiveRuns.push(run.runId);
      continue;
    }
    terminal += 1;
    if (ageDays > input.policy.mainEventsDays) expiredRuns.push(run.runId);
    if (ageDays > input.policy.verboseLogsDays) verboseExpiredRuns.push(run.runId);
  }

  return {
    policy: input.policy,
    evaluatedAt: now.toISOString(),
    total: input.runs.length,
    active,
    terminal,
    expiredRuns: expiredRuns.sort(),
    verboseExpiredRuns: verboseExpiredRuns.sort(),
    protectedActiveRuns: protectedActiveRuns.sort(),
    removalPerformed: false,
    verdict: protectedActiveRuns.length === 0 ? 'ok' : 'attention',
  };
}

function ageInDays(now: Date, isoTimestamp: string): number {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - parsed) / MS_PER_DAY;
}