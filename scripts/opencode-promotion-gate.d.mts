export type PromotionGateStep = { label: string; status: 'pass' | 'fail' | 'skip'; output: string };

export type PromotionGateArgs = {
  candidateTag: string;
  candidateSource: string;
  archiveSha256: string;
  workDir: string;
  archivePath?: string;
  binaryPath?: string;
  repoRoot?: string;
  suites: string[];
  live: boolean;
  skipE2e?: boolean;
};

export type CandidateIdentity = {
  version: string;
  raw: string;
  embeddedSourceCommit: string | null;
  binarySha256: string;
};

export const FORK_REPO: string;

export function parseGateArgs(argv: string[]): PromotionGateArgs;
export function sha256OfFile(path: string): string;
export function extractCandidateBinary(archivePath: string, workDir: string, expectedArchiveSha256: string): string;
export function readCandidateIdentity(binaryPath: string): CandidateIdentity;
export function runGateStep(options: { label: string; command: string; args: string[]; cwd: string; env: Record<string, string> }): PromotionGateStep;
