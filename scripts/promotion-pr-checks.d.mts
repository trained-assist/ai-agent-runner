export type PrCheckVerdict = {
  state: 'green' | 'failed' | 'pending' | 'none' | 'merged';
  failed: string[];
  pending: string[];
  reason: string;
};

export function classifyPrChecks(statusCheckRollup: unknown, pullRequestState?: string | null): PrCheckVerdict;
