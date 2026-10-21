// Provisions the sandbox Runner API principal that may attach the pinned
// disposable-user MCP catalog to a run.
//
// The principal lives in its own registry (`RUNNER_API_KEYS_ADDITIONAL`), so the
// base registry, the sandbox3 registry, the developer registry and the
// credential registry of the lane are left untouched. The script never prints
// the key: it writes it to a 0600 file and prints the path.
//
// The key is a sandbox credential. It authorises runs against the sandbox
// Runner API only, and the profile it opens is the pinned sandbox user
// catalog, whose identities are disposable and revoked with the run.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MEM_GPT_WORKER = 'trained-assist-runner-api-telegram-ux-v1-sandbox';
export const MEM_GPT_PRINCIPAL_ID = 'mem-gpt-sandbox-e2e';
export const MEM_GPT_PROFILE_ID = 'integration-telegram-ux-v1';
export const MEM_GPT_BINDING = 'mem-gpt-user-sandbox';
export const MEM_GPT_REPOSITORY = 'trained-assist/ai-agent-runner';

/** The hash-only registry record. The key itself never enters the registry. */
export function memGptRunnerPrincipalRecord(apiKey) {
  const normalized = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (normalized.length < 32 || normalized.length > 500) throw new Error('mem_gpt_runner_api_key_invalid');
  return {
    keyHash: createHash('sha256').update(normalized).digest('hex'),
    principalId: MEM_GPT_PRINCIPAL_ID,
    profileId: MEM_GPT_PROFILE_ID,
    repository: MEM_GPT_REPOSITORY,
    scopes: ['runs:read', 'runs:write'],
    engines: ['eu-vm-agent-run', 'azure-cloud'],
    mcpBindings: [MEM_GPT_BINDING],
  };
}

async function call(token, method, path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  if (!response.ok || parsed?.success === false) {
    const message = parsed?.errors?.map((error) => error.message).join('; ') || String(response.status);
    throw new Error(`cloudflare ${method} ${path} failed: ${message}`);
  }
  return parsed?.result;
}

/**
 * Publishes the principal into the lane's additional registry and deploys the
 * version that carries it. The registry is write-only: an existing value that
 * the caller cannot supply is refused instead of overwritten.
 */
export async function provisionMemGptRunnerPrincipal(env = process.env) {
  const token = env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN;
  if (!token || token.length < 20) throw new Error('mem_gpt_cloudflare_token_missing');
  const account = env.CF_ACCOUNT_ID || 'd740a05e9442c1d0feacae2dfc673e93';
  const worker = env.RUNNER_API_WORKER || MEM_GPT_WORKER;
  const keyFile = env.RUNNER_API_KEY_FILE || join(homedir(), '.epic253-secrets', 'runner-api-mem-gpt-key');
  const apiKey = env.MEM_GPT_RUNNER_API_KEY?.trim() || randomBytes(32).toString('base64url');
  const record = memGptRunnerPrincipalRecord(apiKey);

  const base = `/accounts/${account}/workers/scripts/${worker}`;
  const settings = await call(token, 'GET', `${base}/settings`);
  const secrets = (settings?.bindings ?? []).filter((binding) => binding.type === 'secret_text').map((binding) => binding.name);
  if (secrets.includes('RUNNER_API_KEYS_ADDITIONAL') && !env.RUNNER_API_KEYS_ADDITIONAL_CURRENT) {
    throw new Error('mem_gpt_additional_registry_exists');
  }
  let existing = [];
  if (env.RUNNER_API_KEYS_ADDITIONAL_CURRENT) {
    try { existing = JSON.parse(env.RUNNER_API_KEYS_ADDITIONAL_CURRENT); } catch { throw new Error('mem_gpt_additional_registry_invalid'); }
  }
  if (!Array.isArray(existing)) throw new Error('mem_gpt_additional_registry_invalid');
  const merged = [...existing.filter((entry) => entry?.principalId !== MEM_GPT_PRINCIPAL_ID), record];

  await call(token, 'PUT', `${base}/secrets`, { name: 'RUNNER_API_KEYS_ADDITIONAL', text: JSON.stringify(merged), type: 'secret_text' });
  const versions = await call(token, 'GET', `${base}/versions?per_page=1`);
  const versionId = versions?.items?.[0]?.id;
  if (!versionId) throw new Error('mem_gpt_version_not_published');
  await call(token, 'POST', `${base}/deployments`, { versions: [{ version_id: versionId, percentage: 100 }] });

  writeFileSync(keyFile, `${apiKey}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return {
    worker, principalId: MEM_GPT_PRINCIPAL_ID, profileId: MEM_GPT_PROFILE_ID, mcpBindings: [MEM_GPT_BINDING],
    keyRegistry: 'RUNNER_API_KEYS_ADDITIONAL', versionId, keyFile,
  };
}

if (process.argv[1]?.endsWith('/provision-mem-gpt-runner-principal.mjs')) {
  provisionMemGptRunnerPrincipal().then((result) => {
    console.log(JSON.stringify({ ...result, credentialsProvisioned: true }));
  }).catch((error) => {
    console.error(error instanceof Error && /^mem_gpt_[a-z0-9_]+$/.test(error.message) ? error.message : 'mem_gpt_runner_principal_provision_failed');
    process.exitCode = 1;
  });
}
