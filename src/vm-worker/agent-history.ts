import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runner } from '../runner/runner.js';
import { redactSecrets } from '../redact.js';
import { writeFileAtomic } from '../runner/util.js';

export const AGENT_HISTORY_PATH = '__runner/agent-history.json';
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES_BYTES = 6 * 1024 * 1024;

export function agentHistory(runner: Runner, dataDir: string, runId: string): { bytes: Buffer; manifest: {
  path: string; name: string; mime: string; size: number; sha256: string;
} } {
  const snapshot = runner.getRun(runId);
  if (!snapshot?.result) throw new Error('agent history is not ready');
  const path = join(dataDir, 'runner', 'runs', runId, 'agent-history.json');
  let bytes: Buffer;
  if (existsSync(path)) bytes = readFileSync(path);
  else {
    const entries: Array<Record<string, unknown>> = [];
    let truncated = false;
    let used = 0;
    const events = runner.events(runId);
    for (const event of events) {
      let entry: Record<string, unknown> | null = null;
      if (event.type === 'assistant_message') entry = { sequence: event.sequence, at: event.timestamp,
        type: 'assistant_message', text: redactSecrets(event.payload.text) };
      else if (event.type === 'assistant_question') entry = { sequence: event.sequence, at: event.timestamp,
        type: 'assistant_question', questions: event.payload.questions.map((question) => ({
          ...question, header: redactSecrets(question.header), question: redactSecrets(question.question),
          options: question.options.map((option) => ({ label: redactSecrets(option.label), description: redactSecrets(option.description) })),
        })) };
      else if (event.type === 'log' && (event.payload.stream === 'stdout' || event.payload.stream === 'stderr')) {
        entry = { sequence: event.sequence, at: event.timestamp, type: 'log', stream: event.payload.stream,
          text: redactSecrets(event.payload.message) };
      }
      if (!entry) continue;
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (used + size + 1 > MAX_ENTRIES_BYTES) { truncated = true; break; }
      entries.push(entry);
      used += size + 1;
    }
    const result = snapshot.result;
    const fullAnswer = snapshot.checkpoint?.answer.text ?? null;
    truncated ||= fullAnswer !== null && fullAnswer.length > 64_000;
    const document = { schemaVersion: 1, runId, outcome: result.outcome, startedAt: result.startedAt,
      finishedAt: result.finishedAt, truncated, entries,
      answer: fullAnswer?.slice(0, 64_000) ?? null };
    bytes = Buffer.from(`${JSON.stringify(document)}\n`);
    if (bytes.length > MAX_HISTORY_BYTES) throw new Error('agent history exceeded its size limit');
    writeFileAtomic(path, bytes);
  }
  return { bytes, manifest: { path: AGENT_HISTORY_PATH, name: 'agent-history.json', mime: 'application/json',
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
}
