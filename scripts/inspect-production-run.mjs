const RUNNER_API = 'https://trained-assist-runner-api-production.skillset-apply.workers.dev';
const SAFE_RUN_ID = /^run_[A-Za-z0-9_-]{20,160}$/;

export function summarizeSessionLog(text) {
  const summary = { jsonLines: 0, malformedLines: 0, eventCounts: {}, agentExitResolved: null, stdoutChars: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { summary.malformedLines += 1; continue; }
    summary.jsonLines += 1;
    const type = typeof event.type === 'string' ? event.type : 'unknown';
    summary.eventCounts[type] = (summary.eventCounts[type] ?? 0) + 1;
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (type === 'agent_exit_resolved') {
      summary.agentExitResolved = {
        answerSource: typeof payload.answerSource === 'string' ? payload.answerSource : null,
        answerChars: Number.isSafeInteger(payload.answerChars) ? payload.answerChars : null,
        reason: typeof payload.reason === 'string' ? payload.reason : null,
      };
    }
    if (type === 'log' && payload.stream === 'stdout' && typeof payload.message === 'string') {
      summary.stdoutChars += payload.message.length;
    }
  }
  return summary;
}

export async function inspectRun({ runId, apiKey, fetchImpl = fetch }) {
  if (!SAFE_RUN_ID.test(runId ?? '')) throw new Error('invalid_run_id');
  if (typeof apiKey !== 'string' || apiKey.length < 32) throw new Error('production_runner_api_key_missing');
  const base = `${RUNNER_API}/v1/runs/${encodeURIComponent(runId)}`;
  const headers = { authorization: `Bearer ${apiKey}` };
  const get = async (suffix) => {
    const response = await fetchImpl(`${base}/${suffix}`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`runner_inspection_http_${response.status}`);
    return response.json();
  };
  const [status, result, events, artifacts] = await Promise.all([
    get('status'), get('result'), get('events?cursor=0&limit=500'), get('artifacts'),
  ]);

  let savedLog = { fetched: false, httpStatus: null, bytes: null, summary: null, protocol: null, hostname: null };
  const logUrl = artifacts.logUrl;
  if (typeof logUrl === 'string') {
    const parsed = new URL(logUrl);
    const googleStorageHost = parsed.hostname === 'storage.googleapis.com'
      || parsed.hostname.endsWith('.storage.googleapis.com')
      || parsed.hostname === 'storage.cloud.google.com'
      || parsed.hostname.endsWith('.storage.cloud.google.com');
    savedLog = { ...savedLog, protocol: parsed.protocol, hostname: parsed.hostname };
    if (parsed.protocol === 'https:' && googleStorageHost) {
      const response = await fetchImpl(parsed, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
      if (response.ok) {
        const text = await response.text();
        savedLog = { ...savedLog, fetched: true, httpStatus: response.status, bytes: Buffer.byteLength(text), summary: summarizeSessionLog(text) };
      } else {
        savedLog = { ...savedLog, fetched: false, httpStatus: response.status };
      }
    }
  }

  const runnerResolution = (events.events ?? []).filter(event => event.type === 'agent_exit_resolved').at(-1);
  return {
    runId,
    state: status.state ?? null,
    statusAnswerChars: typeof status.answer === 'string' ? status.answer.trim().length : 0,
    result: {
      outcome: result.outcome ?? null,
      exitReason: result.exitReason ?? null,
      textChars: typeof result.text === 'string' ? result.text.trim().length : 0,
      logPathPresent: typeof result.logPath === 'string' && result.logPath.length > 0,
    },
    runnerAgentExitResolved: runnerResolution ? {
      answerSource: runnerResolution.payload?.answerSource ?? null,
      answerChars: runnerResolution.payload?.answerChars ?? null,
      reason: runnerResolution.payload?.reason ?? null,
    } : null,
    savedLog,
    output: 'content_redacted; only byte and character counts are reported',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await inspectRun({ runId: process.env.RUN_ID?.trim(), apiKey: process.env.RUNNER_API_KEY?.trim() });
  console.log(JSON.stringify(result));
}
