export type WorkerReleaseIdentity = {
  releaseTag: string;
  workerVersion: string;
  workerSourceCommit: string;
  opencodeVersion: string;
  opencodeSourceCommit: string;
  opencodeBinarySha256: string;
};

export function parseWorkerReleaseIdentity(buildInfo: unknown, releaseTag: string): WorkerReleaseIdentity;
export function compareOpenCodeIdentity(
  actual: unknown,
  expected: Pick<WorkerReleaseIdentity, 'opencodeVersion' | 'opencodeSourceCommit' | 'opencodeBinarySha256'>,
): { status: 'match' } | { status: 'unknown'; reason: string } | { status: 'drift'; mismatches: string[] };
