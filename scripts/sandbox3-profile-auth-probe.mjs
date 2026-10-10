import { createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const URL = 'https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev/v1/capabilities';
const PRINCIPAL_ID = 'sandbox3-agent-api-principal';
const TENANT_ID = 'sandbox3-acceptance-a-20261008';
const PROFILE_ID = 'integration-sandbox3-v1';
const OUTPUT = process.env.GITHUB_WORKSPACE
  ? `${process.env.GITHUB_WORKSPACE}/sandbox3-profile-auth-evidence.json` : null;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`sandbox3_${name.toLowerCase()}_missing`);
  return value;
}

const evidence = {
  schemaVersion: 1,
  worker: 'trained-assist-runner-api-sandbox3',
  principalId: PRINCIPAL_ID,
  tenantId: TENANT_ID,
  profileId: PROFILE_ID,
  method: 'GET',
  route: '/v1/capabilities',
  runCreated: false,
  workerOrModelCalled: false,
  bareApiKeyStatus: null,
  status: null,
  result: 'failed',
};

try {
  const apiKey = required('SANDBOX3_RUNNER_API_KEY');
  const delegationSecret = required('SANDBOX3_PROFILE_DELEGATION_SECRET');
  if (Buffer.byteLength(apiKey) < 32 || apiKey.length > 500 || Buffer.byteLength(delegationSecret) < 32) {
    throw new Error('sandbox3_profile_credentials_invalid');
  }
  const bareResponse = await fetch(URL, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${apiKey}`, 'cache-control': 'no-store' },
  });
  evidence.bareApiKeyStatus = bareResponse.status;
  if (bareResponse.status !== 200) throw new Error('sandbox3_profile_api_key_refused');
  const expiresAt = String(Date.now() + 60_000);
  const message = `${PRINCIPAL_ID}\0${TENANT_ID}\0${PROFILE_ID}\0${expiresAt}`;
  const signature = createHmac('sha256', delegationSecret).update(message).digest('hex');
  const response = await fetch(URL, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: `Bearer ${apiKey}`,
      'x-agent-profile-id': PROFILE_ID,
      'x-agent-profile-tenant': TENANT_ID,
      'x-agent-profile-exp': expiresAt,
      'x-agent-profile-sig': signature,
      'cache-control': 'no-store',
    },
  });
  evidence.status = response.status;
  const body = await response.json().catch(() => ({}));
  if (response.status !== 200 || body?.contract?.name !== 'ai-agent-runner/serverless-agent-api'
    || body?.placement !== 'cloudflare-worker' || !Array.isArray(body?.executionRegions)
    || !body.executionRegions.includes('eu-vm-agent-run')) {
    throw new Error(response.status === 403 ? 'sandbox3_profile_delegation_refused'
      : response.status === 401 ? 'sandbox3_profile_api_key_refused' : 'sandbox3_profile_contract_mismatch');
  }
  evidence.result = 'passed';
} catch (error) {
  evidence.failureCode = error instanceof Error && /^sandbox3_[a-z0-9_]+$/.test(error.message)
    ? error.message : 'sandbox3_profile_auth_probe_failed';
} finally {
  if (OUTPUT) await writeFile(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

console.log(JSON.stringify(evidence));
if (evidence.result !== 'passed') process.exitCode = 1;
