export type WorkerReadinessReport = {
  ready?: boolean;
  checks?: {
    activeRuns?: number;
    capacity?: { activeReservations?: number };
  };
};

export function isSafeToUpdate(report: WorkerReadinessReport | null | undefined): boolean;
