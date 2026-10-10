import { readFile } from 'node:fs/promises';

const apiUrl = process.env.RUNNER_API_URL;
const apiKey = process.env.RUNNER_API_KEY_AGENT_API;
const runId = process.env.GITHUB_RUN_ID;
const repositoryToken = process.env.GITHUB_TOKEN;
const expectedPackageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

if (!apiUrl || !apiKey || !runId || !repositoryToken) throw new Error('sandbox3 canary environment is incomplete');

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

const capabilities = await request('/v1/capabilities');
if (!capabilities.executionRegions?.includes('eu-vm-agent-run')) {
  throw new Error('sandbox3 API does not advertise the EU VM worker');
}
console.log('authenticated capabilities: EU VM worker advertised');

const submitted = await request('/v1/runs', {
  method: 'POST',
  headers: { 'idempotency-key': `sandbox3-vm2-${runId}` },
  body: JSON.stringify({
    userTaskId: `sandbox3-vm2-${runId}`,
    engine: { name: 'eu-vm-agent-run', adapterVersion: '1' },
    input: { inlinePrompt: 'Read package.json and report its name and version as one JSON object. Do not edit any files.' },
    envAllowlist: ['LLM_LADDER_TOKEN'],
    limits: { timeoutMs: 120_000, maxOutputBytes: 100_000, maxLogBytes: 200_000 },
    repository: { fullName: 'trained-assist/ai-agent-runner', token: repositoryToken },
  }),
});
if (typeof submitted.runId !== 'string' || !submitted.runId.startsWith('run_')) {
  throw new Error('sandbox3 API returned no valid run receipt');
}
console.log(`run accepted: ${submitted.runId}`);

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
let status;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  status = await request(`/v1/runs/${encodeURIComponent(submitted.runId)}/status`);
  console.log(`run state: ${status.state}`);
  if (terminal.has(status.state)) break;
  await new Promise(resolve => setTimeout(resolve, 3_000));
}
if (!status || !terminal.has(status.state)) throw new Error('sandbox3 VM run did not reach a terminal state within 180 seconds');

const result = await request(`/v1/runs/${encodeURIComponent(submitted.runId)}/result`);
if (result.outcome !== 'succeeded' || !String(result.text ?? '').includes(expectedPackageVersion)) {
  throw new Error(`sandbox3 VM run failed acceptance: ${JSON.stringify({ outcome: result.outcome, exitCode: result.exitCode })}`);
}
console.log(`sandbox3 VM2 end-to-end canary succeeded; package version ${expectedPackageVersion} confirmed`);
