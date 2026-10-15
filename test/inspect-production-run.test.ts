import { describe, expect, it } from 'vitest';
import { inspectRun, summarizeSessionLog } from '../scripts/inspect-production-run.mjs';

describe('production run inspector', () => {
  it('summarizes the persisted Runner journal without retaining message contents', () => {
    const summary = summarizeSessionLog([
      JSON.stringify({ type: 'log', payload: { stream: 'stdout', message: 'private answer text' } }),
      JSON.stringify({ type: 'agent_exit_resolved', payload: { answerChars: 7, answerSource: 'engine_stdout', reason: 'answer captured' } }),
    ].join('\n'));

    expect(summary).toEqual({ jsonLines: 2, malformedLines: 0, eventCounts: { log: 1, agent_exit_resolved: 1 },
      agentExitResolved: { answerSource: 'engine_stdout', answerChars: 7, reason: 'answer captured' }, stdoutChars: 19 });
    expect(JSON.stringify(summary)).not.toContain('private answer text');
  });

  it('queries the exact run and records the durable journal classification', async () => {
    const runId = `run_${'a'.repeat(64)}_1234567890123456`;
    const calls: string[] = [];
    const fakeFetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/status')) return Response.json({ state: 'succeeded', answer: null });
      if (url.endsWith('/result')) return Response.json({ outcome: 'succeeded', exitReason: 'completed', logPath: 'gs://private/run.log' });
      if (url.endsWith('/events?cursor=0&limit=500')) return Response.json({ events: [{ type: 'agent_exit_resolved', payload: { answerChars: 0, answerSource: null, reason: 'no answer' } }] });
      if (url.endsWith('/artifacts')) return Response.json({ logUrl: 'https://storage.googleapis.com/example/runs/test/session.log' });
      if (url.startsWith('https://storage.googleapis.com/')) return new Response(JSON.stringify({ type: 'agent_exit_resolved', payload: { answerChars: 0 } }) + '\n');
      throw new Error(`unexpected_url:${url}`);
    };

    const result = await inspectRun({ runId, apiKey: 'x'.repeat(40), fetchImpl: fakeFetch as typeof fetch });
    expect(calls).toHaveLength(5);
    expect(result).toMatchObject({ state: 'succeeded', statusAnswerChars: 0,
      result: { outcome: 'succeeded', exitReason: 'completed', textChars: 0, logPathPresent: true },
      runnerAgentExitResolved: { answerChars: 0 }, savedLog: { fetched: true, httpStatus: 200,
        summary: { agentExitResolved: { answerChars: 0 } } } });
  });

  it('rejects arbitrary run IDs before making network requests', async () => {
    await expect(inspectRun({ runId: '../other-run', apiKey: 'x'.repeat(40) })).rejects.toThrow('invalid_run_id');
  });
});
