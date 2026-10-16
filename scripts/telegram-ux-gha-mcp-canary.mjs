#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

const base = 'https://trained-assist-runner-api-telegram-ux-v1-sandbox.skillset-apply.workers.dev';
const apiKey = process.env.RUNNER_API_KEY_AGENT_API;
const repositoryToken = process.env.GITHUB_TOKEN;
if (!apiKey || !repositoryToken || !process.env.GITHUB_RUN_ID) throw new Error('sandbox canary credentials are unavailable');

const taskId = `gha-mcp-${process.env.GITHUB_RUN_ID}-${randomUUID().slice(0, 8)}`;
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const evidence = {
  schemaVersion: 1,
  runnerSourceSha: process.env.GITHUB_SHA ?? null,
  workflowRunId: process.env.GITHUB_RUN_ID,
  taskId,
  runId: null,
  routeMode: 'gha',
  engine: 'azure-cloud',
  stages: [],
};
const evidencePath = new URL('../gha-mcp-canary-evidence.json', import.meta.url);
async function saveEvidence() {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}
async function stage(name, status, detail = {}) {
  evidence.stages.push({ name, status, at: new Date().toISOString(), ...detail });
  await saveEvidence();
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
async function read(path) {
  const delays = [500, 1_000, 2_000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json().catch(() => null);
      const transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      if (transient && attempt < delays.length) {
        await response.body?.cancel();
        await sleep(delays[attempt]);
        continue;
      }
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}, code=${body?.error?.code ?? 'unknown'}`);
      return body;
    } catch (error) {
      if (attempt >= delays.length || (error instanceof Error && error.message.startsWith(`${path}: HTTP `))) throw error;
      await sleep(delays[attempt]);
    }
  }
}
function assertIdentity(value, label, runId) {
  if (value?.runId !== runId || value?.userTaskId !== taskId) throw new Error(`${label} task/run identity mismatch`);
}

let ghaAvailable = false;
let receipt;
let status;
let result;
try {
  try {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const capabilities = await read('/v1/capabilities');
      if (capabilities.routes?.gha?.available === true) { ghaAvailable = true; break; }
      if (attempt < 24) await sleep(5_000);
    }
    if (!ghaAvailable) throw new Error('GHA route is unavailable on the Telegram UX sandbox API after propagation');
    await stage('admission_ready', 'verified');
  } catch (error) {
    await stage('admission_ready', 'failed', { reason: error instanceof Error ? error.message : 'unknown error' });
    throw error;
  }

const priorTaskId = process.env.PRIOR_CANARY_TASK_ID;
const priorRunId = process.env.PRIOR_CANARY_RUN_ID;
if (priorTaskId || priorRunId) {
  if (!priorTaskId || !priorRunId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(priorTaskId)
    || !/^run_[A-Za-z0-9_]{20,127}$/.test(priorRunId)) throw new Error('invalid prior canary identity');
  const previous = await read(`/v1/runs/${encodeURIComponent(priorRunId)}/status`);
  if (previous.userTaskId !== priorTaskId || previous.runId !== priorRunId) throw new Error('prior canary identity mismatch');
  if (terminal.has(previous.state)) {
    const previousResult = await read(`/v1/runs/${encodeURIComponent(priorRunId)}/result`);
    if (previousResult.runId !== priorRunId || previousResult.userTaskId !== priorTaskId) throw new Error('prior canary result identity mismatch');
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

  try {
    receipt = await request('/v1/runs', {
      method: 'POST', headers: { 'idempotency-key': taskId }, body: JSON.stringify(payload),
    });
    if (typeof receipt.runId !== 'string' || !receipt.runId.startsWith('run_')) throw new Error('missing API run receipt');
    evidence.runId = receipt.runId;
    await stage('admission', 'verified');
    console.log(`MCP canary accepted: taskId=${taskId} runId=${receipt.runId}`);

  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    status = await read(`/v1/runs/${encodeURIComponent(receipt.runId)}/status`);
    assertIdentity(status, 'status', receipt.runId);
    console.log(`MCP canary state=${status.state} engine=${status.engine} route=${status.routeMode}`);
    if (status.state === 'running' && status.engine === 'azure-cloud' && status.routeMode === 'gha'
      && !evidence.stages.some((item) => item.name === 'gha_claim')) await stage('gha_claim', 'verified');
    if (terminal.has(status.state)) break;
    await sleep(3_000);
  }
  if (!status || !terminal.has(status.state)) throw new Error('MCP canary has no terminal proof');
  if (status.engine !== 'azure-cloud' || status.routeMode !== 'gha') throw new Error('MCP canary did not use GHA');
  await stage('gha_report', 'verified', { state: status.state });
  result = await read(`/v1/runs/${encodeURIComponent(receipt.runId)}/result`);
  assertIdentity(result, 'result', receipt.runId);
  const answer = String(result.text ?? '');
  if (status.state !== 'succeeded' || result.outcome !== 'succeeded') {
    throw new Error(`MCP canary failed: state=${status.state}, outcome=${result.outcome}, code=${result.failure?.code ?? 'none'}`);
  }
  if (result.failure || JSON.stringify(result).includes('ARTIFACTS_PUSH_FAILED')) {
    throw new Error(`MCP canary result has a contradictory finalization failure: ${result.failure?.code ?? 'ARTIFACTS_PUSH_FAILED'}`);
  }
  if (!answer.includes('registry-fixture-marker-160-v1') || !answer.includes(taskId) || !answer.includes(receipt.runId)) {
    throw new Error('MCP fixture invocation is unproven: result lacks the fixture marker and this run’s IDs');
  }
  await stage('mcp_connection', 'verified', { evidence: 'signed fixture result returned' });
  await stage('tools_list', 'verified', { evidence: 'the fixture-backed run selected the only tool in its pinned allowlist' });
  await stage('tools_call', 'verified', { marker: 'registry-fixture-marker-160-v1', taskId, runId: receipt.runId });
  await stage('api_result', 'verified', { state: status.state, outcome: result.outcome });
  console.log(`MCP fixture call verified: marker=registry-fixture-marker-160-v1 taskId=${taskId} runId=${receipt.runId}`);
  } finally {
    if (receipt?.runId && (!status || !terminal.has(status.state))) {
      try { status = await read(`/v1/runs/${encodeURIComponent(receipt.runId)}/status`); assertIdentity(status, 'status', receipt.runId); }
    catch { status = undefined; }
    }
    if (receipt?.runId && status && terminal.has(status.state)) {
      try {
        result ??= await read(`/v1/runs/${encodeURIComponent(receipt.runId)}/result`);
        assertIdentity(result, 'result', receipt.runId);
        const cleanup = await request('/v1/sandbox/cleanup-task', {
          method: 'POST', body: JSON.stringify({ userTaskId: taskId }),
        });
        if (cleanup.status !== 'cleaned' || cleanup.deletedRuns < 1) throw new Error('terminal MCP canary cleanup failed');
        await stage('cleanup', 'verified', { deletedRuns: cleanup.deletedRuns });
        console.log('Terminal MCP canary state cleaned');
      } catch (error) {
        await stage('cleanup', 'failed', { reason: error instanceof Error ? error.message : 'unknown error' });
        throw error;
      }
    } else {
      await stage('cleanup', 'preserved', { reason: 'terminal status or matching result identity is not proven' });
      console.error('MCP canary state remains nonterminal or unknown; preserved for diagnosis');
    }
  }
} catch (error) {
  evidence.outcome = 'failed';
  evidence.error = error instanceof Error ? error.message : 'unknown error';
  throw error;
} finally {
  evidence.outcome ??= 'succeeded';
  await saveEvidence();
}
