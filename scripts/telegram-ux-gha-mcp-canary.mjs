#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

const base = 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev';
const apiKey = process.env.RUNNER_API_KEY_AGENT_API;
const repositoryToken = process.env.GITHUB_TOKEN;
if (!apiKey || !repositoryToken || !process.env.GITHUB_RUN_ID) throw new Error('sandbox canary credentials are unavailable');

const taskId = `gha-mcp-${process.env.GITHUB_RUN_ID}-${randomUUID().slice(0, 8)}`;
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}, code=${body?.error?.code ?? 'unknown'}`);
  return body;
}

let ghaAvailable = false;
for (let attempt = 0; attempt < 25; attempt += 1) {
  const capabilities = await request('/v1/capabilities');
  if (capabilities.routes?.gha?.available === true) { ghaAvailable = true; break; }
  if (attempt < 24) await new Promise((resolve) => setTimeout(resolve, 5_000));
}
if (!ghaAvailable) throw new Error('GHA route is unavailable on the Telegram UX sandbox API after propagation');

const priorTaskId = process.env.PRIOR_CANARY_TASK_ID;
const priorRunId = process.env.PRIOR_CANARY_RUN_ID;
if (priorTaskId || priorRunId) {
  if (!priorTaskId || !priorRunId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(priorTaskId)
    || !/^run_[A-Za-z0-9_]{20,127}$/.test(priorRunId)) throw new Error('invalid prior canary identity');
  const previous = await request(`/v1/runs/${encodeURIComponent(priorRunId)}/status`);
  if (previous.userTaskId !== priorTaskId || previous.runId !== priorRunId) throw new Error('prior canary identity mismatch');
  if (terminal.has(previous.state)) {
    const cleanup = await request('/v1/sandbox/cleanup-task', {
      method: 'POST', body: JSON.stringify({ userTaskId: priorTaskId }),
    });
    if (cleanup.status !== 'cleaned' || cleanup.deletedRuns < 1) throw new Error('terminal prior canary cleanup failed');
    console.log(`Prior terminal MCP canary cleaned: state=${previous.state} taskId=${priorTaskId} runId=${priorRunId}`);
  } else {
    console.log(`Prior MCP canary remains ${previous.state}; state preserved: taskId=${priorTaskId} runId=${priorRunId}`);
  }
}

const payload = {
  userTaskId: taskId,
  routeMode: 'gha',
  engine: { name: 'azure-cloud', adapterVersion: '1' },
  input: { inlinePrompt: 'Use the available MCP tool named trained-assist-registry-test_registry_fixture_read with empty arguments. Return its result as JSON with marker, taskId, and runId. Do not use bash, curl, webfetch, or repository source to look up the marker. If that MCP tool is unavailable, say so immediately; do not guess values or edit files.' },
  envAllowlist: ['LLM_LADDER_TOKEN'],
  limits: { timeoutMs: 300_000, maxOutputBytes: 100_000, maxLogBytes: 200_000 },
  repository: { fullName: 'trained-assist/ai-agent-runner', token: repositoryToken },
  mcp: { servers: [{
    serverId: 'trained-assist-registry-test',
    transport: 'remote',
    url: 'https://trained-assist-mcp-host-test-160.skillset-apply.workers.dev/mcp',
    bindingRef: 'registry-mcp-test-160-read',
    allowedTools: ['registry.fixture_read'],
    policyVersion: 'registry-fixture-policy-v1',
    catalogueVersion: 'registry-fixture-catalogue-v1',
  }] },
};

const receipt = await request('/v1/runs', {
  method: 'POST', headers: { 'idempotency-key': taskId }, body: JSON.stringify(payload),
});
if (typeof receipt.runId !== 'string' || !receipt.runId.startsWith('run_')) throw new Error('missing API run receipt');
console.log(`MCP canary accepted: taskId=${taskId} runId=${receipt.runId}`);

let status;
try {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    status = await request(`/v1/runs/${encodeURIComponent(receipt.runId)}/status`);
    console.log(`MCP canary state=${status.state} engine=${status.engine} route=${status.routeMode}`);
    if (terminal.has(status.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  if (!status || !terminal.has(status.state)) throw new Error('MCP canary has no terminal proof');
  if (status.engine !== 'azure-cloud' || status.routeMode !== 'gha') throw new Error('MCP canary did not use GHA');
  const result = await request(`/v1/runs/${encodeURIComponent(receipt.runId)}/result`);
  const answer = String(result.text ?? '');
  if (status.state !== 'succeeded' || result.outcome !== 'succeeded') {
    throw new Error(`MCP canary failed: state=${status.state}, outcome=${result.outcome}, code=${result.failure?.code ?? 'none'}`);
  }
  if (!answer.includes('registry-fixture-marker-160-v1') || !answer.includes(taskId) || !answer.includes(receipt.runId)) {
    throw new Error('MCP fixture invocation is unproven: result lacks the fixture marker and this run’s IDs');
  }
  console.log(`MCP fixture call verified: marker=registry-fixture-marker-160-v1 taskId=${taskId} runId=${receipt.runId}`);
} finally {
  if (!status || !terminal.has(status.state)) {
    try { status = await request(`/v1/runs/${encodeURIComponent(receipt.runId)}/status`); }
    catch { status = undefined; }
  }
  if (status && terminal.has(status.state)) {
    const cleanup = await request('/v1/sandbox/cleanup-task', {
      method: 'POST', body: JSON.stringify({ userTaskId: taskId }),
    });
    if (cleanup.status !== 'cleaned' || cleanup.deletedRuns < 1) throw new Error('terminal MCP canary cleanup failed');
    console.log('Terminal MCP canary state cleaned');
  } else {
    console.error('MCP canary state remains nonterminal or unknown; preserved for diagnosis');
  }
}
