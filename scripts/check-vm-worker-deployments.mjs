const expectedCommit = process.env.VM_WORKER_MAIN_SHA;
if (!/^[0-9a-f]{40}$/.test(expectedCommit ?? '')) throw new Error('VM_WORKER_MAIN_SHA must be the full main commit SHA');
let warnings = 0;
const warn = (label, message) => {
  warnings += 1;
  process.stdout.write(`::warning title=${label}::${message}\n`);
};

for (const [region, prefix] of [['France', 'EU'], ['Russia', 'RU']]) {
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
    if (!/^[0-9a-f]{40}$/.test(deployedCommit ?? '')) {
      warn(`${region} worker build unknown`, 'The worker does not report a verified source commit.');
    } else if (deployedCommit !== expectedCommit) {
      warn(`${region} worker is behind main`, `deployed=${deployedCommit}; main=${expectedCommit}; version=${version?.build?.version ?? 'unknown'}`);
    } else {
      process.stdout.write(`${region}: deployed main ${deployedCommit} (${version?.build?.version ?? 'unknown'}).\n`);
    }
    if (version?.bindings?.ready === false) warn(`${region} required bindings missing`, `Missing required variable names: ${(version.bindings.missingRequired ?? []).join(', ') || 'unknown'}`);
    for (const message of version?.bindings?.warnings ?? []) warn(`${region} binding inventory`, message);
    if (!readyResponse.ok) warn(`${region} worker not ready`, `readyz HTTP ${readyResponse.status}; checks=${JSON.stringify(ready.checks ?? {})}`);
    else process.stdout.write(`${region}: readiness is ready.\n`);
  } catch (error) {
    const safe = error instanceof Error ? error.message.replaceAll(token, '[redacted]') : 'request failed';
    warn(`${region} worker check failed`, safe.slice(0, 400));
  }
}
if (warnings === 0) process.stdout.write('Both configured VM worker deployment checks passed.\n');
process.exitCode = warnings > 0 ? 1 : 0;
