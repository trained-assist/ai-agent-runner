export interface E2eChainProblem {
  ok: boolean;
  problems: string[];
}

export interface E2eCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface E2eStepResult {
  id: string;
  title: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  durationMs: number;
  checks: E2eCheck[];
  reproduction?: string;
  issueDraft?: { title: string; body: string };
}

export interface E2eStep {
  id: string;
  title: string;
  checks: E2eCheck[];
  startedAt: number;
  reproduction: string | null;
  issueDraft: { title: string; body: string } | null;
  check(name: string, ok: unknown, detail?: string): boolean;
  fail(name: string, detail: string): boolean;
  readonly status: 'PASS' | 'FAIL';
  finish(): E2eStepResult;
}

export interface E2eSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
}

export interface E2eEventLike {
  sequence: number;
  type: string;
}

export interface E2eSecretHit {
  file: string;
  secretIndex: number;
}

export declare class Step implements E2eStep {
  constructor(id: string, title: string);
  id: string;
  title: string;
  checks: E2eCheck[];
  startedAt: number;
  reproduction: string | null;
  issueDraft: { title: string; body: string } | null;
  check(name: string, ok: unknown, detail?: string): boolean;
  fail(name: string, detail: string): boolean;
  readonly status: 'PASS' | 'FAIL';
  finish(): E2eStepResult;
}

export declare function sha256Hex(buffer: Uint8Array | string): string;
export declare function isTerminalState(state: string): boolean;
export declare function sleep(ms: number): Promise<void>;
export declare function redact(text: string, secrets?: string[]): string;
export declare function validateEventChain(
  events: E2eEventLike[],
  options?: { requireTerminal?: boolean },
): E2eChainProblem;
export declare function listFilesRecursive(root: string): string[];
export declare function findSecretsInTree(root: string, secrets: string[]): E2eSecretHit[];
export declare function findSecretsInText(text: string, secrets: string[]): Array<{ secretIndex: number }>;
export declare function describePathMode(path: string): { exists: boolean; mode?: number; modeText?: string; error?: string };
export declare function summarize(steps: Array<{ status: string }>): E2eSummary;
export declare function buildIssueDraft(step: E2eStep): { title: string; body: string };
