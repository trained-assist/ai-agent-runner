import { readFile } from 'node:fs/promises';

const apiUrl = process.env.RUNNER_API_URL;
const apiKey = process.env.RUNNER_API_KEY_AGENT_API;
const runId = process.env.GITHUB_RUN_ID;
const repositoryToken = process.env.GITHUB_TOKEN;
const routeMode = process.env.RUNNER_ROUTE_MODE ?? 'france';
const expectedPackageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

if (!apiUrl || !apiKey || !runId || !repositoryToken) throw new Error('sandbox3 canary environment is incomplete');
if (!['france', 'gha', 'auto'].includes(routeMode)) throw new Error('sandbox3 canary route mode is invalid');
if (routeMode === 'gha' && (process.env.GHA_WORKER_TOKEN?.trim().length ?? 0) < 24) {
  throw new Error('sandbox3 direct GHA canary requires its provisioned gateway credential');
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, apiUrl), {
    ...options,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

async function expectStatus(path, expectedStatus, options = {}) {
  const response = await fetch(new URL(path, apiUrl), {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== expectedStatus) {
    await response.body?.cancel();
    throw new Error(`${path} returned HTTP ${response.status}; expected ${expectedStatus}`);
  }
  await response.body?.cancel();
}

await expectStatus('/v1/capabilities', 401);
console.log('unauthenticated capabilities rejected');

const capabilities = await request('/v1/capabilities');
if (!capabilities.executionRegions?.includes('eu-vm-agent-run')) {
  throw new Error('sandbox3 API does not advertise the EU VM worker');
}
if (routeMode === 'gha' && capabilities.routes?.gha?.available !== true) {
  throw new Error('sandbox3 API does not advertise an available direct GHA route');
}
console.log(`authenticated capabilities: route=${routeMode}, GHA available=${capabilities.routes?.gha?.available === true}`);

const idempotencyKey = `sandbox3-vm2-${runId}`;
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const launchPayload = {
  userTaskId: idempotencyKey,
  traceId: `sandbox3-vm2-${runId}`,
  ...(routeMode === 'gha' ? { engine: { name: 'azure-cloud', adapterVersion: '1' } } :
    routeMode === 'france' ? { engine: { name: 'eu-vm-agent-run', adapterVersion: '1' } } : {}),
  routeMode,
  input: { inlinePrompt: 'Read package.json and report its name and version as one JSON object. Do not edit any files.' },
  envAllowlist: ['LLM_LADDER_TOKEN'],
  limits: { timeoutMs: 120_000, maxOutputBytes: 100_000, maxLogBytes: 200_000 },
  repository: { fullName: 'trained-assist/ai-agent-runner', token: repositoryToken },
};
const launchOptions = {
  method: 'POST',
  headers: { 'idempotency-key': idempotencyKey },
  body: JSON.stringify(launchPayload),
};
const submitted = await request('/v1/runs', launchOptions);
if (typeof submitted.runId !== 'string' || !submitted.runId.startsWith('run_')) {
  throw new Error('sandbox3 API returned no valid run receipt');
}
console.log(`run accepted: ${submitted.runId}; requested route=${routeMode}`);
console.log(`diagnostic trace id: sandbox3-vm2-${runId}`);

let status;
try {
  const repeated = await request('/v1/runs', launchOptions);
  if (repeated.runId !== submitted.runId) {
    throw new Error('repeated idempotent submission returned a different run receipt');
  }
  console.log('idempotent retry returned the original run receipt');

  await expectStatus('/v1/runs', 409, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ ...launchPayload, input: { inlinePrompt: 'Different payload under the same idempotency key.' } }),
  });
  console.log('conflicting idempotency-key reuse rejected');

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    status = await request(`/v1/runs/${encodeURIComponent(submitted.runId)}/status`);
    console.log(`run state: ${status.state}; engine=${status.engine ?? 'unreported'}; route=${status.routeMode ?? 'unreported'}`);
    if (terminal.has(status.state)) break;
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  if (!status || !terminal.has(status.state)) throw new Error('sandbox3 VM run did not reach a terminal state within 180 seconds');

  const result = await request(`/v1/runs/${encodeURIComponent(submitted.runId)}/result`);
  if (result.outcome !== 'succeeded' || !String(result.text ?? '').includes(expectedPackageVersion)) {
    throw new Error(`sandbox3 VM run failed acceptance: ${JSON.stringify({ outcome: result.outcome, exitCode: result.exitCode })}`);
  }
  const expectedEngine = routeMode === 'gha' ? 'azure-cloud' : routeMode === 'france' ? 'eu-vm-agent-run' : status.engine;
  if (status.engine !== expectedEngine || status.routeMode !== routeMode) {
    throw new Error(`sandbox3 route mismatch: requested ${routeMode}/${expectedEngine}, observed ${status.routeMode}/${status.engine}`);
  }
  console.log(`sandbox3 API end-to-end canary succeeded; route=${routeMode}/${expectedEngine}; package version ${expectedPackageVersion} confirmed`);
} finally {
  // Keep active or unknown runs for diagnosis. Remove state once terminal proof exists.
  if (!status || !terminal.has(status.state)) {
    try { status = await request(`/v1/runs/${encodeURIComponent(submitted.runId)}/status`); }
    catch { status = undefined; }
  }
  if (status && terminal.has(status.state)) {
    const cleanup = await request('/v1/sandbox/cleanup-task', {
      method: 'POST', body: JSON.stringify({ userTaskId: idempotencyKey }),
    });
    if (cleanup.status !== 'cleaned' || cleanup.deletedRuns < 1) {
      throw new Error('sandbox3 VM canary cleanup did not remove its terminal Runner state');
    }
    console.log('terminal sandbox3 VM canary Runner state cleaned');
  } else {
    console.error('sandbox3 VM canary is not confirmed terminal; Runner state is preserved for inspection');
  }
}
