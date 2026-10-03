import { cohortDecision, type CohortPolicy, type CohortReason } from './cohort.js';
import type { DispatchOwnerStore } from './dispatch-owner.js';
import { isPaidProfile, type ReleaseManifest } from './manifest.js';
import type { ReleaseState } from './promotion.js';

export type AdmissionRefusalCode =
  | 'PROMOTION_PAUSED'
  | 'PAID_PROFILE_DISABLED'
  | 'COHORT_NOT_ENABLED'
  | 'TASK_OWNED_BY_OTHER_WORKER'
  | 'WORKER_DRAINING';

export interface AdmissionSubject {
  principalId: string;
  engineName: string;
}

export interface AdmissionAcceptance {
  admit: true;
  cohortId: string;
  cohortReason: CohortReason;
  bucket: number;
  releaseId: string;
  servingReleaseId: string;
}

export interface AdmissionRefusal {
  admit: false;
  code: AdmissionRefusalCode;
  reason: string;
  detail: Record<string, unknown>;
}

export type AdmissionDecision = AdmissionAcceptance | AdmissionRefusal;

export interface AdmissionPolicy {
  manifest: ReleaseManifest;
  cohort: CohortPolicy;
  state: ReleaseState;
}

/**
 * Порядок проверок — часть контракта и попадает в логи:
 * 1) rollback: пока релиз откатан, новые задачи не принимаются вообще;
 * 2) paid-профили выключены по умолчанию — проверка до когорты, потому что она не зависит от флага;
 * 3) когорта: только её principal'ы идут на кандидатный релиз;
 * 4) владение задачей (claim) — отдельно, когда уже известен `runId`.
 */
export function decideAdmission(policy: AdmissionPolicy, subject: AdmissionSubject): AdmissionDecision {
  if (policy.state.rolledBack) {
    return {
      admit: false,
      code: 'PROMOTION_PAUSED',
      reason: `release ${policy.state.releaseId} is rolled back: ${policy.state.reason ?? 'no reason recorded'}`,
      detail: {
        releaseId: policy.state.releaseId,
        servingReleaseId: policy.state.servingReleaseId,
        previousReleaseId: policy.state.previousReleaseId,
        newAdmissions: 'refused',
        acceptedRuns: 'stay_with_current_owner',
      },
    };
  }

  if (!policy.manifest.paid.allowed && isPaidProfile(policy.manifest, subject.engineName)) {
    return {
      admit: false,
      code: 'PAID_PROFILE_DISABLED',
      reason: `engine "${subject.engineName}" is not declared as free by release ${policy.manifest.releaseId}; paid profiles are off unless the owner decision is recorded`,
      detail: {
        engine: subject.engineName,
        freeEngines: [...policy.manifest.engines],
        paidEngines: [...policy.manifest.paid.engines],
        paidProfilesAllowed: policy.manifest.paid.allowed,
      },
    };
  }

  const cohort = cohortDecision(policy.cohort, subject.principalId);
  if (!cohort.inCohort) {
    return {
      admit: false,
      code: 'COHORT_NOT_ENABLED',
      reason: `principal "${subject.principalId}" is not in cohort ${policy.cohort.cohortId} (${cohort.reason})`,
      detail: { cohortId: policy.cohort.cohortId, mode: policy.cohort.mode, bucket: cohort.bucket, reason: cohort.reason },
    };
  }

  return {
    admit: true,
    cohortId: cohort.cohortId,
    cohortReason: cohort.reason,
    bucket: cohort.bucket,
    releaseId: policy.manifest.releaseId,
    servingReleaseId: policy.state.servingReleaseId,
  };
}

/**
 * Запрос владения задачей перед её запуском. Отказ здесь означает «не запускай вторую
 * копию»: воркер, который не владеет задачей, обязан вернуть её владельцу, а не перехватить.
 */
export function claimOwnership(
  owners: DispatchOwnerStore,
  principalId: string,
  userTaskId: string,
  runId: string,
): { admit: true; ownerGeneration: number } | AdmissionRefusal {
  const claim = owners.claim(principalId, userTaskId, runId);
  switch (claim.outcome) {
    case 'granted':
      return { admit: true, ownerGeneration: claim.generation };
    case 'held_by_other':
      return {
        admit: false,
        code: 'TASK_OWNED_BY_OTHER_WORKER',
        reason: `task ${userTaskId} is owned by worker ${claim.ownerWorkerId} at generation ${claim.generation}; starting a second copy would double-dispatch it`,
        detail: { ownerWorkerId: claim.ownerWorkerId, ownerGeneration: claim.generation },
      };
    case 'draining':
      return {
        admit: false,
        code: 'WORKER_DRAINING',
        reason: `worker ${owners.workerId} is draining and does not accept new tasks`,
        detail: { workerId: owners.workerId },
      };
    case 'fenced':
      return {
        admit: false,
        code: 'TASK_OWNED_BY_OTHER_WORKER',
        reason: `worker ${owners.workerId} is fenced for task ${userTaskId} (owner ${claim.ownerWorkerId}, generation ${claim.generation})`,
        detail: { ownerWorkerId: claim.ownerWorkerId, ownerGeneration: claim.generation },
      };
    default:
      return {
        admit: false,
        code: 'TASK_OWNED_BY_OTHER_WORKER',
        reason: `task ${userTaskId} cannot be claimed by ${owners.workerId}: ${claim.outcome}`,
        detail: { outcome: claim.outcome },
      };
  }
}