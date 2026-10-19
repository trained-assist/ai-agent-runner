export type ForkReleaseIdentity = {
  tag: string;
  date: string;
  sourceCommit: string;
  archiveSha256: string;
  publishedAt: string;
};

export type PromotionDecision = {
  status: 'candidate' | 'up-to-date' | 'downgrade';
  candidate: ForkReleaseIdentity;
  active: { sourceCommit: string; tag: string | null };
  reason: string;
};

export const FORK_REPO: string;

export function publishedForkReleases(releases: unknown): unknown[];
export function forkReleaseIdentity(release: unknown): ForkReleaseIdentity;
export function selectPromotionCandidate(releases: unknown, active: { sourceCommit: string; tag?: string }): PromotionDecision;
