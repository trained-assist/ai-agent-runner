#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key === '--dry-run') { args.set(key, 'true'); continue; }
  if (!key?.startsWith('--') || !process.argv[i + 1]) throw new Error('Expected --name value arguments');
  args.set(key, process.argv[++i]);
}

const clientId = args.get('--client-id') ?? 'sandbox3_agent_api';
const clientSecretName = `WORKER_CLIENT_TOKEN_${clientId.toUpperCase()}`;
const runnerSecretName = 'GHA_WORKER_TOKEN';
const githubSecretName = `GHA_WORKER_TOKEN_${clientId.toUpperCase()}`;
const githubRepo = args.get('--github-repo') ?? 'trained-assist/ai-agent-runner';
const githubEnv = args.get('--github-env') ?? 'sandbox';
const gatewayEnv = args.get('--gateway-env') ?? 'sandbox';
const gatewayDir = resolve(args.get('--gateway-dir') ?? process.env.GHA_GATEWAY_REPO_DIR ?? '../opencode-gha-runner-mem-preview');
const gatewayConfig = args.get('--gateway-config') ?? 'wrangler.toml';
const runnerConfig = args.get('--runner-config') ?? 'wrangler.sandbox3.jsonc';
const dryRun = args.has('--dry-run');

if (!/^[a-z][a-z0-9_]{2,47}$/.test(clientId)) throw new Error('client id must be 3–48 lowercase letters, digits or underscores');
if (!/^[a-z][a-z0-9-]{1,30}$/.test(githubEnv) || !/^[a-z][a-z0-9-]{1,30}$/.test(gatewayEnv)) throw new Error('invalid environment name');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo)) throw new Error('invalid GitHub repository');

const runnerConfigPath = resolve(root, runnerConfig);
const configText = readFileSync(runnerConfigPath, 'utf8');
const urlMatch = configText.match(/(?:["']?GHA_WORKER_URL["']?)\s*[:=]\s*["']([^"']+)["']/);
const gatewayUrlValue = args.get('--gateway-url') ?? urlMatch?.[1];
if (!gatewayUrlValue) throw new Error(`GHA_WORKER_URL is missing from ${runnerConfig}`);
const gatewayUrl = new URL(gatewayUrlValue);
const gatewayIsSandbox = gatewayUrl.hostname === 'opencode-gha-runner-gateway-sandbox.skillset-apply.workers.dev';
const gatewayIsProduction = gatewayUrl.hostname === 'opencode-gha-runner-gateway.skillset-apply.workers.dev';
if (gatewayUrl.protocol !== 'https:' || gatewayUrl.username || gatewayUrl.password || gatewayUrl.pathname !== '/' || gatewayUrl.search || gatewayUrl.hash
  || !(gatewayIsSandbox || gatewayIsProduction)
  || (gatewayIsSandbox && gatewayEnv !== 'sandbox') || (gatewayIsProduction && gatewayEnv !== 'production')) {
  throw new Error('gateway URL and environment must match the approved production or sandbox GHA gateway');
}

function run(command, commandArgs, { cwd, input } = {}) {
  try {
    return execFileSync(command, commandArgs, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const stderr = String(error?.stderr ?? '');
    if (stderr.includes('CLOUDFLARE_API_TOKEN')) throw new Error('Cloudflare CLI is not authenticated; set CLOUDFLARE_API_TOKEN and retry');
    if (command === 'gh' && /not logged|authentication|auth login/i.test(stderr)) throw new Error('GitHub CLI is not authenticated; run gh auth login and retry');
    throw new Error(`${command} ${commandArgs.slice(0, 3).join(' ')} failed; output suppressed`);
  }
}

function wrangler(cwd, config, env, action, secretName, input) {
  const commandArgs = ['--no-install', 'wrangler', 'secret', action, secretName, '--config', config];
  if (env && env !== 'production') commandArgs.push('--env', env);
  return run('npx', commandArgs, { cwd, input });
}

function wranglerSecretNames(cwd, config, env) {
  const commandArgs = ['--no-install', 'wrangler', 'secret', 'list', '--config', config];
  if (env && env !== 'production') commandArgs.push('--env', env);
  const parsed = JSON.parse(run('npx', commandArgs, { cwd }));
  if (!Array.isArray(parsed)) throw new Error('Wrangler returned an unexpected secret inventory');
  return new Set(parsed.map((item) => item?.name).filter((name) => typeof name === 'string'));
}

function githubSecretNames() {
  const output = run('gh', ['secret', 'list', '--repo', githubRepo, '--env', githubEnv]);
  return new Set(output.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
}

function deleteWranglerSecret(cwd, config, env, secretName) {
  const commandArgs = ['--no-install', 'wrangler', 'secret', 'delete', secretName, '--config', config];
  if (env && env !== 'production') commandArgs.push('--env', env);
  try { execFileSync('npx', commandArgs, { cwd, input: 'y\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); return true; }
  catch { return false; }
}

async function verifyGatewayToken(token) {
  const probeId = `provisioning-auth-${clientId}`;
  const response = await fetch(`${gatewayUrl.origin}/v1/runs/${probeId}/status`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) return false;
  const body = await response.json().catch(() => null);
  return body?.runId === probeId && body?.status === 'unknown';
}

const before = {
  gateway: wranglerSecretNames(gatewayDir, gatewayConfig, gatewayEnv),
  runner: wranglerSecretNames(root, runnerConfig, undefined),
  github: githubSecretNames(),
};
const occupied = [
  before.gateway.has(clientSecretName) && `gateway:${clientSecretName}`,
  before.runner.has(runnerSecretName) && `runner:${runnerSecretName}`,
  before.github.has(githubSecretName) && `github:${githubSecretName}`,
].filter(Boolean);
if (occupied.length) throw new Error(`refusing to overwrite existing credentials (${occupied.join(', ')}); use rotation workflow`);

console.log(`Provision target: client=${clientId}, gateway=${gatewayUrl.origin} (${gatewayEnv}), runner=${runnerConfig}, GitHub=${githubRepo}/${githubEnv}`);
if (dryRun) { console.log('Dry run: all three target secret names are available; no credentials changed.'); process.exit(0); }

const tokenBytes = randomBytes(32);
const token = tokenBytes.toString('hex');
const created = [];
try {
  wrangler(gatewayDir, gatewayConfig, gatewayEnv, 'put', clientSecretName, token);
  created.push({ kind: 'gateway', name: clientSecretName });
  wrangler(root, runnerConfig, undefined, 'put', runnerSecretName, token);
  created.push({ kind: 'runner', name: runnerSecretName });
  run('gh', ['secret', 'set', githubSecretName, '--repo', githubRepo, '--env', githubEnv], { cwd: root, input: token });
  created.push({ kind: 'github', name: githubSecretName });
  if (!await verifyGatewayToken(token)) throw new Error('gateway authentication probe failed');
  console.log('Provisioned and verified all three credential copies; token value was never displayed.');
} catch (error) {
  const failedCleanup = [];
  for (const item of created.reverse()) {
    if (item.kind === 'gateway' && !deleteWranglerSecret(gatewayDir, gatewayConfig, gatewayEnv, item.name)) failedCleanup.push(`gateway:${item.name}`);
    if (item.kind === 'runner' && !deleteWranglerSecret(root, runnerConfig, undefined, item.name)) failedCleanup.push(`runner:${item.name}`);
    if (item.kind === 'github') {
      try { run('gh', ['secret', 'delete', item.name, '--repo', githubRepo, '--env', githubEnv], { cwd: root }); }
      catch { failedCleanup.push(`github:${item.name}`); }
    }
  }
  const suffix = failedCleanup.length ? ` Manual cleanup required for: ${failedCleanup.join(', ')}.` : ' Successfully created entries were removed.';
  throw new Error(`${error instanceof Error ? error.message : 'Provisioning failed'}.${suffix}`);
} finally {
  tokenBytes.fill(0);
}
