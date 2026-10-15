export function summarizeSessionLog(text: string): {
  jsonLines: number;
  malformedLines: number;
  eventCounts: Record<string, number>;
  agentExitResolved: { answerSource: string | null; answerChars: number | null; reason: string | null } | null;
  stdoutChars: number;
};
export function inspectRun(options: {
  runId: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>>;
