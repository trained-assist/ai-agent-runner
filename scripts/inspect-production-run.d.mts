export function summarizeSessionLog(text: string): {
  jsonLines: number;
  malformedLines: number;
  eventCounts: Record<string, number>;
  agentExitResolved: { answerSource: string | null; answerChars: number | null; reason: string | null } | null;
  stdoutChars: number;
};
export function summarizeSseLogs(text: string): {
  stdoutEvents: number;
  stderrEvents: number;
  stdoutChars: number;
  stderrChars: number;
  endFrame: boolean;
};
export function redactLogSecrets(text: string): string;
export function inspectRun(options: {
  runId: string;
  apiKey: string;
  vmUrl?: string | null;
  vmToken?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>>;
