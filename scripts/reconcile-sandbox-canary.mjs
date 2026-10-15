#!/usr/bin/env node

const urls = Object.freeze({
  sandbox3: 'https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev',
  telegram: 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev',
});
const target = process.env.CANARY_TARGET;
const taskId = process.env.CANARY_TASK_ID;
const runId = process.env.CANARY_RUN_ID;
const apiKey = process.env.RUNNER_API_KEY_AGENT_API;
const cleanupTerminal = process.env.CLEANUP_TERMINAL === 'true';
const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
if (!Object.hasOwn(urls, target ?? '') || !safeId.test(taskId ?? '') || !/^run_[A-Za-z0-9_]{20,127}$/.test(runId ?? '') || !apiKey) {
  throw new Error('sandbox canary reconciliation inputs are invalid');
}

async function request(path, init = {}) {
  const response = await fetch(`${urls[target]}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}, code=${body?.error?.code ?? 'unknown'}`);
  return body;
}

const status = await request(`/v1/runs/${encodeURIComponent(runId)}/status`);
if (status.runId !== runId || status.userTaskId !== taskId) throw new Error('run does not belong to the requested canary task');
console.log(JSON.stringify({ target, taskId, runId, state: status.state, engine: status.engine,
  routeMode: status.routeMode, workerStartPhase: status.workerStartPhase,
  statusFreshness: status.statusFreshness, workerProgressFreshness: status.workerProgressFreshness }));

const events = await request(`/v1/runs/${encodeURIComponent(runId)}/events?limit=500`);
console.log(JSON.stringify({ eventTypes: (events.events ?? []).slice(-12).map((event) => event.type ?? 'unknown') }));

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
if (!terminal.has(status.state)) {
  console.log('Canary state is not terminal; preserved without cleanup.');
  process.exit(0);
}

const result = await request(`/v1/runs/${encodeURIComponent(runId)}/result`);
console.log(JSON.stringify({ outcome: result.outcome, exitReason: result.exitReason,
  failureCode: result.failure?.code ?? null }));
if (cleanupTerminal) {
  const cleaned = await request('/v1/sandbox/cleanup-task', {
    method: 'POST', body: JSON.stringify({ userTaskId: taskId }),
  });
  if (cleaned.status !== 'cleaned' || cleaned.deletedRuns < 1) throw new Error('terminal canary cleanup did not delete its run');
  console.log(`Terminal canary state cleaned: taskId=${taskId} runId=${runId} deletedRuns=${cleaned.deletedRuns}`);
}
