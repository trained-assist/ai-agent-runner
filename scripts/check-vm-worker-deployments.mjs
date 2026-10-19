import { compareOpenCodeIdentity } from './opencode-release-identity.mjs';

const expectedCommit = process.env.VM_WORKER_MAIN_SHA;
if (!/^[0-9a-f]{40}$/.test(expectedCommit ?? '')) throw new Error('VM_WORKER_MAIN_SHA must be the full main commit SHA');
const expectedRelease = {
  tag: process.env.VM_WORKER_RELEASE_TAG,
  version: process.env.VM_WORKER_RELEASE_VERSION,
  sourceCommit: process.env.VM_WORKER_RELEASE_SOURCE_COMMIT,
  opencodeVersion: process.env.VM_WORKER_OPENCODE_VERSION,
  opencodeSourceCommit: process.env.VM_WORKER_OPENCODE_SOURCE_COMMIT,
  opencodeBinarySha256: process.env.VM_WORKER_OPENCODE_BINARY_SHA256,
};
if (!/^vm-worker-v\d+\.\d+\.\d+$/.test(expectedRelease.tag ?? '')
  || !/^\d+\.\d+\.\d+$/.test(expectedRelease.version ?? '')
  || !/^[0-9a-f]{40}$/.test(expectedRelease.sourceCommit ?? '')
  || !expectedRelease.opencodeVersion
  || !/^[0-9a-f]{40}$/.test(expectedRelease.opencodeSourceCommit ?? '')
  || !/^[0-9a-f]{64}$/.test(expectedRelease.opencodeBinarySha256 ?? '')) {
  throw new Error('Expected verified worker release and OpenCode identity are required');
}
let warnings = 0;
const warn = (label, message) => {
  warnings += 1;
  process.stdout.write(`::warning title=${label}::${message}\n`);
};

for (const [region, prefix] of [['France', 'EU']]) {
  const baseUrl = process.env[`${prefix}_VM_WORKER_URL`]?.trim();
  const token = process.env[`${prefix}_VM_WORKER_TOKEN`];
  if (!baseUrl || !token) {
    warn(`${region} worker not configured`, `Set ${prefix}_VM_WORKER_URL and ${prefix}_VM_WORKER_TOKEN in GitHub Actions secrets to enable deployment checks.`);
    continue;
  }
  let origin;
  try {
    origin = new URL(baseUrl);
    if (origin.protocol !== 'https:') throw new Error('HTTPS is required');
  } catch {
    warn(`${region} worker URL invalid`, 'The configured worker URL must be a valid HTTPS origin.');
    continue;
  }
  const base = origin.toString().replace(/\/$/, '');
  try {
    const headers = { authorization: `Bearer ${token}` };
    const [versionResponse, readyResponse] = await Promise.all([
      fetch(`${base}/version`, { headers, signal: AbortSignal.timeout(10_000) }),
      fetch(`${base}/readyz`, { headers, signal: AbortSignal.timeout(10_000) }),
    ]);
    if (!versionResponse.ok) throw new Error(`/version HTTP ${versionResponse.status}`);
    const version = await versionResponse.json();
    const ready = await readyResponse.json().catch(() => ({}));
    const deployedCommit = version?.build?.sourceCommit;
    const deployedBuild = version?.build;
    if (deployedBuild?.version !== expectedRelease.version || deployedCommit !== expectedRelease.sourceCommit) {
      warn(`${region} worker release drift`, `deployed=${deployedBuild?.version ?? 'unknown'}@${deployedCommit ?? 'unknown'}; latest=${expectedRelease.tag} (${expectedRelease.version}@${expectedRelease.sourceCommit})`);
    } else {
      process.stdout.write(`${region}: worker release ${expectedRelease.tag} (${expectedRelease.sourceCommit}).\n`);
    }
    const opencode = compareOpenCodeIdentity(deployedBuild?.opencode, expectedRelease);
    if (opencode.status === 'unknown') {
      warn(`${region} OpenCode identity unknown`, opencode.reason);
    } else if (opencode.status === 'drift') {
      warn(`${region} OpenCode release drift`, `deployed=${deployedBuild.opencode.version}@${deployedBuild.opencode.sourceCommit} sha256=${deployedBuild.opencode.binarySha256}; latest=${expectedRelease.tag} ${expectedRelease.opencodeVersion}@${expectedRelease.opencodeSourceCommit} sha256=${expectedRelease.opencodeBinarySha256}; mismatches=${opencode.mismatches.join(',')}`);
    } else {
      process.stdout.write(`${region}: OpenCode ${expectedRelease.opencodeVersion} (${expectedRelease.opencodeSourceCommit}, ${expectedRelease.opencodeBinarySha256}) matches ${expectedRelease.tag}.\n`);
    }
    if (!/^[0-9a-f]{40}$/.test(deployedCommit ?? '')) {
      warn(`${region} worker build unknown`, 'The worker does not report a verified source commit.');
    } else if (deployedCommit !== expectedCommit) {
      warn(`${region} worker is behind main`, `deployed=${deployedCommit}; main=${expectedCommit}; version=${version?.build?.version ?? 'unknown'}`);
    } else {
      process.stdout.write(`${region}: deployed main ${deployedCommit} (${version?.build?.version ?? 'unknown'}).\n`);
    }
    if (version?.bindings?.ready === false) warn(`${region} required bindings missing`, `Missing required variable names: ${(version.bindings.missingRequired ?? []).join(', ') || 'unknown'}`);
    const ingressBindingNames = ['RUNNER_CONTROL_PLANE_URL', 'RUNNER_CONTROL_PLANE_PRINCIPAL', 'RUNNER_CONTROL_PLANE_PRINCIPAL_SECRET', 'RUNNER_CONTROL_PLANE_PRODUCTION_URL', 'RUNNER_CONTROL_PLANE_PRODUCTION_PRINCIPAL', 'RUNNER_CONTROL_PLANE_PRODUCTION_PRINCIPAL_SECRET'];
    const inventory = Array.isArray(version?.bindings?.inventory) ? version.bindings.inventory : [];
    const ingressBindings = ingressBindingNames.map((name) => {
      const binding = inventory.find((entry) => entry?.name === name);
      return `${name}=${typeof binding?.configured === 'boolean' ? binding.configured : 'unknown'}`;
    });
    process.stdout.write(`${region}: ingress resolver binding presence ${ingressBindings.join(', ')}.\n`);
    for (const message of version?.bindings?.warnings ?? []) warn(`${region} binding inventory`, message);
    if (!readyResponse.ok) warn(`${region} worker not ready`, `readyz HTTP ${readyResponse.status}; checks=${JSON.stringify(ready.checks ?? {})}`);
    else process.stdout.write(`${region}: readiness is ready.\n`);
  } catch (error) {
    const safe = error instanceof Error ? error.message.replaceAll(token, '[redacted]') : 'request failed';
    warn(`${region} worker check failed`, safe.slice(0, 400));
  }
}
if (warnings === 0) process.stdout.write('The configured VM worker deployment check passed.\n');
process.exitCode = warnings > 0 ? 1 : 0;
