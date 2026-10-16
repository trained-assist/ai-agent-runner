#!/usr/bin/env node
import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CONFIG = 'wrangler.production.jsonc';
const ACCOUNT_ID = 'd740a05e9442c1d0feacae2dfc673e93';
const WORKER = 'trained-assist-runner-api-production';
const PUBLIC_URL = `https://${WORKER}.skillset-apply.workers.dev`;
const PRINCIPAL_ID = 'cp-production-runner';
const TENANT_ID = 'trained-assist-production';
const PROFILE_ID = 'trained-assist-production';
const PROFILE_REPOSITORY = 'trained-assist/ai-agent-runner';
const API_CONTRACT_NAME = 'ai-agent-runner/serverless-agent-api';

export function productionRunnerPrincipalRecord(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (Buffer.byteLength(key) < 32 || key.length > 500) throw new Error('production_runner_api_key_invalid');
  return {
    keyHash: createHash('sha256').update(key).digest('hex'),
    principalId: PRINCIPAL_ID,
    tenantId: TENANT_ID,
    profileId: PROFILE_ID,
    repository: PROFILE_REPOSITORY,
    scopes: ['runs:read', 'runs:write'],
    engines: ['eu-vm-agent-run', 'azure-cloud'],
  };
}

export function hasExpectedProductionCapabilities(body, expectGha = Boolean(process.env.GHA_WORKER_TOKEN_PRODUCTION_AGENT_API?.trim())) {
  return body?.contract?.name === API_CONTRACT_NAME
    && body?.placement === 'cloudflare-worker'
    && Array.isArray(body?.executionRegions)
    && body.executionRegions.includes('eu-vm-agent-run')
    && Array.isArray(body?.fallbackExecutionRegions)
    && (expectGha
      ? body.fallbackExecutionRegions.includes('azure-cloud')
        && body?.routes?.gha?.available === true
        && body?.routes?.gha?.engine === 'azure-cloud'
      : !body.fallbackExecutionRegions.includes('azure-cloud')
        && body?.routes?.gha?.available === false
        && body?.routes?.gha?.engine === null);
}

function required(name, minimumLength = 1) {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimumLength) throw new Error(`production_runner_secret_invalid:${name}`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`production_runner_command_failed:${command}`);
  return result.stdout ?? '';
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function retryProbe(probe) {
  const delays = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000];
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try { if (await probe()) return true; } catch { /* wait for Worker secret propagation */ }
  }
  return false;
}

async function verifyFranceWorker(url, token) {
  let parsed;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error();
  } catch { throw new Error('france_worker_url_invalid'); }
  const { response, body } = await fetchJson(`${parsed.toString().replace(/\/+$/, '')}/readyz`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok || body?.status !== 'ready') throw new Error('france_worker_not_ready');
  return parsed.toString().replace(/\/+$/, '');
}

function putSecrets(entries) {
  const result = spawnSync('npx', ['wrangler', 'secret', 'bulk', '--config', CONFIG, '--name', WORKER], {
    input: JSON.stringify(Object.fromEntries(entries)), encoding: 'utf8', maxBuffer: 1024 * 1024,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CF_API_TOKEN },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  if (result.error || result.status !== 0) throw new Error('production_runner_secret_sync_failed');
}

async function verifyDeployment(sourceSha, apiKey, delegationSecret) {
  if (!await retryProbe(async () => {
    const { response, body } = await fetchJson(`${PUBLIC_URL}/healthz`);
    return response.ok && body?.service === 'ai-agent-runner-api'
      && body?.placement === 'cloudflare-worker' && body?.executionWorker === 'eu-vm-agent-run';
  })) throw new Error('production_runner_health_failed');

  if (!await retryProbe(async () => {
    const { response, body } = await fetchJson(`${PUBLIC_URL}/version`);
    return response.ok && body?.runtime === 'cloudflare-worker' && body?.buildSha === sourceSha;
  })) throw new Error('production_runner_build_sha_mismatch');

  if (!await retryProbe(async () => {
    const { response, body } = await fetchJson(`${PUBLIC_URL}/v1/capabilities`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    return response.ok && hasExpectedProductionCapabilities(body);
  })) throw new Error('production_runner_api_key_probe_failed');

  const runId = `run_${createHash('sha256').update('production-runner-delegation-probe').digest('hex')}_${'0'.repeat(24)}`;
  if (!await retryProbe(async () => {
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
  })) throw new Error('production_runner_delegation_probe_failed');
}

async function main() {
  const cfToken = required('CF_API_TOKEN', 20);
  const apiKey = required('RUNNER_API_KEY_AGENT_API', 32);
  const delegationSecret = required('RUNNER_PROFILE_DELEGATION_SECRET', 32);
  const encryptionKey = required('RUN_LAUNCH_ENCRYPTION_KEY', 32);
  const franceToken = required('EU_VM_WORKER_TOKEN', 24);
  const ladderToken = required('LLM_LADDER_TOKEN', 1);
  const ghaWorkerToken = process.env.GHA_WORKER_TOKEN_PRODUCTION_AGENT_API?.trim() ?? '';
  if (ghaWorkerToken && ghaWorkerToken.length < 24) throw new Error('production_runner_secret_invalid:GHA_WORKER_TOKEN_PRODUCTION_AGENT_API');
  const franceUrl = await verifyFranceWorker(required('EU_VM_WORKER_URL'), franceToken);
  const sourceSha = process.env.SOURCE_SHA?.trim() ?? '';
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('production_runner_source_sha_invalid');

  const config = JSON.parse(await readFile(CONFIG, 'utf8'));
  if (config.name !== WORKER || config.vars?.DEPLOYMENT_ENV !== 'production'
    || config.vars?.RUNNER_ENGINE !== 'eu-vm-agent-run' || config.vars?.MOCK_TEST_ENABLED !== 'false'
    || !config.vars?.ALLOWED_REPOSITORIES?.split(',').map((value) => value.trim()).includes(PROFILE_REPOSITORY)
    || !config.vars?.ALLOWED_ENVIRONMENT_NAMES?.split(',').map((value) => value.trim()).includes('LLM_LADDER_TOKEN')) {
    throw new Error('production_runner_config_mismatch');
  }
  const identity = run('npx', ['wrangler', 'whoami']);
  if (!identity.includes(ACCOUNT_ID)) throw new Error('production_runner_cloudflare_account_mismatch');

  const registry = JSON.stringify([productionRunnerPrincipalRecord(apiKey)]);
  if (process.argv.includes('--preflight-only')) {
    console.log(JSON.stringify({ ok: true, target: WORKER, sourceSha,
      franceWorkerReadiness: 'ready', ghaRoute: ghaWorkerToken ? 'configured' : 'unavailable_fail_closed',
      productionConfig: 'valid', secretInputs: 'present' }));
    return;
  }

  putSecrets([
    ['RUNNER_API_KEYS_PRODUCTION', registry],
    ['AGENT_API_PROFILE_DELEGATION_SECRET', delegationSecret],
    ['RUN_LAUNCH_ENCRYPTION_KEY', encryptionKey],
    ['VM_WORKER_URL', franceUrl],
    ['VM_WORKER_TOKEN', franceToken],
    ...(ghaWorkerToken ? [['GHA_WORKER_TOKEN', ghaWorkerToken]] : []),
    ['LLM_LADDER_TOKEN', ladderToken],
  ]);

  await verifyDeployment(sourceSha, apiKey, delegationSecret);
  console.log(JSON.stringify({ ok: true, worker: WORKER, sourceSha,
    principalId: PRINCIPAL_ID, profileId: PROFILE_ID, executionWorker: 'eu-vm-agent-run',
    franceWorkerReadiness: 'ready', ghaRoute: ghaWorkerToken ? 'ready' : 'unavailable_fail_closed',
    authenticatedCapabilities: 'passed', delegatedProfile: 'passed',
    taskCreated: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : '';
    console.error(/^[a-z0-9_:.\-]+$/.test(message) ? message : 'production_runner_deployment_verification_failed');
    process.exitCode = 1;
  });
}
