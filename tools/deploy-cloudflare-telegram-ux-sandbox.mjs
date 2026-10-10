#!/usr/bin/env node
import { createHash, createHmac, createPrivateKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CONFIG = 'wrangler.telegram-ux-v1.jsonc';
const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const WORKER = 'trained-assist-runner-api-telegram-ux-v1-sandbox';
const PUBLIC_URL = `https://${WORKER}.skillset-apply.workers.dev`;
const PRINCIPAL_ID = 'integration-telegram-ux-v1';
const PROFILE_ID = 'integration-telegram-ux-v1';
const TENANT_ID = 'telegram-ux-sandbox-20261009';
const PROFILE_REPOSITORY = 'vovalikessmoothy-png/cp-telegram-ux-runner-sandbox';
const MCP_CATALOGUE_VERSION = 'registry-fixture-catalogue-v1';
const API_CONTRACT_NAME = 'ai-agent-runner/serverless-agent-api';

export function hasExpectedApiCapabilities(body) {
  return body?.contract?.name === API_CONTRACT_NAME
    && Array.isArray(body?.executionRegions)
    && body.executionRegions.includes('eu-vm-agent-run');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`runner_sandbox_command_failed:${command}`);
  return result.stdout ?? '';
}

function required(name, minimumLength = 1) {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimumLength) throw new Error(`runner_sandbox_secret_invalid:${name}`);
  return value;
}

function validateConfig(config) {
  if (config.name !== WORKER || config.workers_dev !== true
    || config.vars?.RUNNER_API_PUBLIC_URL !== PUBLIC_URL
    || config.vars?.RUNNER_ENGINE !== 'eu-vm-agent-run'
    || config.vars?.MOCK_TEST_ENABLED !== 'true'
    || !config.vars?.ALLOWED_REPOSITORIES?.split(',').map((value) => value.trim()).includes(PROFILE_REPOSITORY)) {
    throw new Error('runner_sandbox_config_mismatch');
  }
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function retryProbe(probe) {
  // Updated Worker secret bindings can take several minutes to reach every
  // edge. Keep the probe inside the deploy job's 15-minute budget.
  const delays = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 60_000, 60_000];
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try { if (await probe()) return true; } catch { /* retry transient edge/secret propagation failures */ }
  }
  return false;
}

async function verifyFranceWorker(url, token) {
  const { response, body } = await fetchJson(`${url.replace(/\/+$/, '')}/readyz`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok || !body || typeof body !== 'object' || body.status !== 'ready') {
    throw new Error('france_worker_not_ready');
  }
}

function putSecrets(entries) {
  const result = spawnSync('npx', ['wrangler', 'secret', 'bulk', '--config', CONFIG, '--name', WORKER], {
    input: JSON.stringify(Object.fromEntries(entries)), encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('runner_sandbox_secret_bulk_sync_failed');
}

async function verifyDeployment(sourceSha, apiKey, delegationSecret) {
  if (!await retryProbe(async () => {
    const { response, body } = await fetchJson(`${PUBLIC_URL}/healthz`);
    return response.ok && body?.service === 'ai-agent-runner-api'
      && body?.placement === 'cloudflare-worker' && body?.executionWorker === 'eu-vm-agent-run';
  })) throw new Error('runner_sandbox_health_failed');
  if (!await retryProbe(async () => {
    const { response, body } = await fetchJson(`${PUBLIC_URL}/version`);
    return response.ok && body?.runtime === 'cloudflare-worker' && body?.buildSha === sourceSha;
  })) throw new Error('runner_sandbox_build_sha_mismatch');
  if (!await retryProbe(async () => {
    const { response, body } = await fetchJson(`${PUBLIC_URL}/v1/capabilities`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    return response.ok && hasExpectedApiCapabilities(body);
  })) throw new Error('runner_sandbox_api_key_probe_failed');

  const taskId = 'telegram-ux-delegation-health-probe';
  const digest = createHash('sha256').update(`${PRINCIPAL_ID}\0${PROFILE_ID}\0${taskId}`).digest('hex');
  const runId = `run_${digest}_${'0'.repeat(24)}`;
  if (!await retryProbe(async () => {
    // Each retry needs a fresh capability. A signature created before the
    // retry window expires while Cloudflare propagates the updated secret.
    const expiresAt = String(Date.now() + 60_000);
    const message = `${PRINCIPAL_ID}\0${TENANT_ID}\0${PROFILE_ID}\0${expiresAt}`;
    const signature = createHmac('sha256', delegationSecret).update(message).digest('hex');
    const status = await fetchJson(`${PUBLIC_URL}/v1/runs/${runId}/status`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        'x-agent-profile-id': PROFILE_ID,
        'x-agent-profile-tenant': TENANT_ID,
        'x-agent-profile-exp': expiresAt,
        'x-agent-profile-sig': signature,
      },
    });
    return status.response.status === 404 && status.body?.error?.code === 'NOT_FOUND';
  })) throw new Error('runner_sandbox_delegation_probe_failed');
}

async function main() {
  const [apiKey, delegationSecret, encryptionKey, franceUrl, franceToken, ladderToken, mcpAuthToken, mcpRunnerPrivateJwk] = [
    required('RUNNER_API_KEY_AGENT_API', 32), required('AGENT_API_PROFILE_DELEGATION_SECRET', 32),
    required('RUN_LAUNCH_ENCRYPTION_KEY', 32), required('EU_VM_WORKER_URL', 1),
    required('EU_VM_WORKER_TOKEN', 24), required('LLM_LADDER_TOKEN', 1),
    required('MCP_TEST_AUTH_TOKEN', 32), required('MCP_TEST_RUNNER_PRIVATE_JWK', 1),
  ];
  const repositoryReadToken = process.env.TELEGRAM_UX_REPOSITORY_READ_TOKEN?.trim();
  let mcpPrivateKey;
  try { mcpPrivateKey = createPrivateKey({ key: JSON.parse(mcpRunnerPrivateJwk), format: 'jwk' }); }
  catch { throw new Error('runner_sandbox_mcp_private_jwk_invalid'); }
  if (mcpPrivateKey.asymmetricKeyType !== 'ed25519') throw new Error('runner_sandbox_mcp_private_jwk_invalid');
  const mcpLeaseExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  mcpLeaseExpiry.setUTCHours(23, 59, 59, 0);
  const mcpExpiresAt = mcpLeaseExpiry.toISOString();
  // Non-secret fingerprint lets operators confirm the GitHub sandbox secret is
  // paired with the separately stored Worker credential without exposing it.
  console.log(JSON.stringify({ apiKeyFingerprint: createHash('sha256').update(apiKey).digest('hex').slice(0, 16) }));
  let workerUrl;
  try {
    workerUrl = new URL(franceUrl);
    if (workerUrl.protocol !== 'https:' || workerUrl.username || workerUrl.password || workerUrl.hash) throw new Error();
  } catch { throw new Error('france_worker_url_invalid'); }
  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  validateConfig(config);

  const sourceSha = run('git', ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('runner_sandbox_source_sha_invalid');
  const identity = run('npx', ['wrangler', 'whoami']);
  if (!identity.includes(ACCOUNT_ID) || !identity.toLowerCase().includes('typeformowner@gmail.com')) {
    throw new Error('runner_sandbox_cloudflare_account_mismatch');
  }
  await verifyFranceWorker(franceUrl, franceToken);

  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const registry = JSON.stringify([{
    keyHash, principalId: PRINCIPAL_ID, profileId: PROFILE_ID, tenantId: TENANT_ID,
    repository: PROFILE_REPOSITORY,
    scopes: ['runs:read', 'runs:write'], engines: ['eu-vm-agent-run'],
    mcpBindings: ['registry-mcp-test-160-read'],
  }]);

  run('npx', ['wrangler', 'deploy', '--config', CONFIG, '--var', `BUILD_SHA:${sourceSha}`,
    '--var', `MCP_TEST_CATALOGUE_VERSION:${MCP_CATALOGUE_VERSION}`,
    '--var', `MCP_TEST_EXPIRES_AT:${mcpExpiresAt}`], { stdio: 'inherit' });
  putSecrets([
    ['RUNNER_API_KEYS', registry],
    ['AGENT_API_PROFILE_DELEGATION_SECRET', delegationSecret],
    ['RUN_LAUNCH_ENCRYPTION_KEY', encryptionKey],
    ['VM_WORKER_URL', workerUrl.toString().replace(/\/+$/, '')],
    ['VM_WORKER_TOKEN', franceToken],
    ['LLM_LADDER_TOKEN', ladderToken],
    ['MCP_TEST_AUTH_TOKEN', mcpAuthToken],
    ['MCP_TEST_RUNNER_PRIVATE_JWK', mcpRunnerPrivateJwk],
    ...(repositoryReadToken ? [['TELEGRAM_UX_REPOSITORY_READ_TOKEN', repositoryReadToken]] : []),
  ]);

  await verifyDeployment(sourceSha, apiKey, delegationSecret);
  console.log(JSON.stringify({ ok: true, worker: WORKER, sourceSha,
    placement: 'cloudflare-worker', executionWorker: 'eu-vm-agent-run',
    profileId: PROFILE_ID, delegatedIdentityVerified: true, franceWorkerReadiness: 'ready' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : '';
    console.error(/^[a-z0-9_:.-]+$/.test(message) ? message : 'runner_sandbox_deploy_failed');
    process.exitCode = 1;
  });
}
