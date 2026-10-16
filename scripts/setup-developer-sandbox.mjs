#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const API_ORIGIN = 'https://trained-assist-runner-api-sandbox3.skillset-apply.workers.dev';
export const KEY_PATH = join(homedir(), '.config/opencode/secrets/serverless-agent-api-key');
const WORKER = 'trained-assist-runner-api-sandbox3';
const CONFIG = 'wrangler.sandbox3.jsonc';

export async function waitForBuildSha(expectedSha, {
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delays = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000],
} = {}) {
  if (!/^[0-9a-f]{40}$/.test(expectedSha || '')) throw new Error('expected_build_sha_required');
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try {
      const response = await fetchImpl(`${API_ORIGIN}/version`, { signal: AbortSignal.timeout(10_000) });
      const build = response.ok ? await response.json() : null;
      if (build?.buildSha === expectedSha) return build;
    } catch { /* Cloudflare propagation can briefly serve the previous Worker revision. */ }
  }
  throw new Error('sandbox_build_sha_mismatch');
}

export function developerRecord(key) {
  if (typeof key !== 'string' || !/^sra_sb_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('developer_key_invalid');
  return {
    keyHash: createHash('sha256').update(key).digest('hex'),
    principalId: 'local-opencode-developer',
    tenantId: 'local-opencode-sandbox3',
    profileId: 'local-opencode-developer',
    repository: 'trained-assist/ai-agent-runner',
    scopes: ['runs:read', 'runs:write'],
    engines: ['eu-vm-agent-run'],
    developerApi: true,
  };
}

export function readKey(path = KEY_PATH) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('developer_key_file_symlink_forbidden');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('developer_key_file_permissions_invalid');
    const key = readFileSync(fd, 'utf8');
    developerRecord(key);
    return key;
  } finally { closeSync(fd); }
}

function activeKey() {
  const fromCi = process.env.SANDBOX3_DEVELOPER_API_KEY;
  if (fromCi !== undefined) {
    developerRecord(fromCi);
    return fromCi;
  }
  return readKey();
}

export function initializeKey(path = KEY_PATH) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) throw new Error('developer_key_directory_permissions_invalid');
  const exists = existsSync(path);
  if (exists && lstatSync(path).isSymbolicLink()) throw new Error('developer_key_file_symlink_forbidden');
  const fd = openSync(path, exists ? constants.O_RDWR | constants.O_NOFOLLOW
    : constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('developer_key_file_permissions_invalid');
    if (stat.size > 0) {
      developerRecord(readFileSync(fd, 'utf8'));
      return { created: false, path };
    }
    const key = `sra_sb_${randomBytes(32).toString('base64url')}`;
    writeSync(fd, key);
    fsyncSync(fd);
    return { created: true, path };
  } finally { closeSync(fd); }
}

async function apiStatus(path = KEY_PATH) {
  const key = path === KEY_PATH ? activeKey() : readKey(path);
  const response = await fetch(`${API_ORIGIN}/v1/developer/capabilities`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  let body = null;
  try { body = await response.json(); } catch { /* status remains authoritative */ }
  return { httpStatus: response.status, ...(response.ok ? {
    managedAvailable: body?.managedAvailable === true,
    managedModel: body?.managedModel ?? null,
    isolation: body?.isolation ?? null,
  } : { errorCode: body?.error?.code ?? 'UNKNOWN' }) };
}

async function provision(expectedSha) {
  if (!/^[0-9a-f]{40}$/.test(expectedSha || '')) throw new Error('expected_build_sha_required');
  const token = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
  if (!token) throw new Error('cloudflare_sandbox_token_missing');
  await waitForBuildSha(expectedSha);
  const record = developerRecord(activeKey());
  for (const [name, value] of [
    ['RUNNER_API_KEYS_DEVELOPER', JSON.stringify([record])],
    ['RUNNER_DEVELOPER_API_ENABLED', 'true'],
  ]) {
    const result = spawnSync('npx', ['--no-install', 'wrangler', 'secret', 'put', name,
      '--name', WORKER, '--config', CONFIG], {
      input: value, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
    });
    if (result.error || result.status !== 0) throw new Error(`cloudflare_secret_put_failed:${name}`);
  }
  return apiStatus();
}

async function main() {
  const command = process.argv[2];
  if (command === 'init') return initializeKey();
  if (command === 'status') return apiStatus();
  if (command === 'provision') return provision(process.argv[3]);
  throw new Error('usage: setup-developer-sandbox.mjs init|status|provision <deployed-build-sha>');
}

if (process.argv[1]?.endsWith('/setup-developer-sandbox.mjs')) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error instanceof Error ? error.message : 'developer_sandbox_setup_failed');
    process.exitCode = 1;
  });
}
