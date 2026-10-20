export type WorkerReleasePlan = {
  needed: boolean;
  latestTag: string | null;
  reason: string;
};

export function planWorkerRelease(input: {
  mainPin: unknown;
  latestTag?: string | null;
  latestPin?: unknown | null;
}): WorkerReleasePlan;
