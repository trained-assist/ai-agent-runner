import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const WORKER = 'trained-assist-runner-api-sandbox3';
const CONFIG = 'wrangler.sandbox3.jsonc';
const PRINCIPAL_ID = 'sandbox3-agent-api-principal';
const TENANT_ID = 'sandbox3-acceptance-a-20261008';
const PROFILE_ID = 'integration-sandbox3-v1';

export function sandbox3ProfilePrincipalRecord(apiKey) {
  if (typeof apiKey !== 'string' || Buffer.byteLength(apiKey) < 32 || apiKey.length > 500) {
    throw new Error('sandbox3_profile_api_key_invalid');
  }
  return {
    keyHash: createHash('sha256').update(apiKey).digest('hex'),
    principalId: PRINCIPAL_ID,
    tenantId: TENANT_ID,
    profileId: PROFILE_ID,
    repository: 'trained-assist/ai-agent-runner',
    scopes: ['runs:read', 'runs:write'],
    engines: ['eu-vm-agent-run'],
  };
}

function provisionSecret(name, value) {
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', name, '--name', WORKER, '--config', CONFIG], {
    input: value,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CF_API_TOKEN },
  });
  if (result.error || result.status !== 0) throw new Error(`sandbox3_secret_provision_failed:${name}`);
}

export function provisionSandbox3ProfilePrincipal(env = process.env) {
  const apiKey = env.SANDBOX3_RUNNER_API_KEY;
  const delegationSecret = env.SANDBOX3_PROFILE_DELEGATION_SECRET;
  if (typeof delegationSecret !== 'string' || Buffer.byteLength(delegationSecret) < 32) {
    throw new Error('sandbox3_profile_delegation_secret_invalid');
  }
  if (typeof env.CF_API_TOKEN !== 'string' || env.CF_API_TOKEN.length < 20) {
    throw new Error('sandbox3_cloudflare_token_missing');
  }
  const records = JSON.stringify([sandbox3ProfilePrincipalRecord(apiKey)]);
  provisionSecret('RUNNER_API_KEYS_SANDBOX3', records);
  provisionSecret('AGENT_API_PROFILE_DELEGATION_SECRET', delegationSecret);
  return { worker: WORKER, principalId: PRINCIPAL_ID, tenantId: TENANT_ID, profileId: PROFILE_ID, keyRegistry: 'RUNNER_API_KEYS_SANDBOX3' };
}

if (process.argv[1]?.endsWith('/sandbox3-profile-principal.mjs')) {
  try {
    const result = provisionSandbox3ProfilePrincipal();
    console.log(JSON.stringify({ ...result, credentialsProvisioned: true }));
  } catch (error) {
    console.error(error instanceof Error && /^sandbox3_[a-z0-9:_-]+$/.test(error.message)
      ? error.message : 'sandbox3_profile_principal_provision_failed');
    process.exitCode = 1;
  }
}
