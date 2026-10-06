import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const updaterPath = new URL('../scripts/deploy-vm-worker-release.sh', import.meta.url);
const operationsPath = new URL('../docs/VM-WORKER-OPERATIONS.md', import.meta.url);

describe('VM worker release updater safety contract', () => {
  it('validates the endpoint before switching releases and requires readyz', async () => {
    const updater = await readFile(updaterPath, 'utf8');
    const validateEndpoint = updater.indexOf('VM_WORKER_PUBLIC_URL must be an http(s) origin');
    const switchRelease = updater.indexOf('mv -Tf "${root}/.current.$$" "${root}/current"');
    expect(validateEndpoint).toBeGreaterThanOrEqual(0);
    expect(validateEndpoint).toBeLessThan(switchRelease);
    expect(updater).toContain('"${public_url%/}/healthz" -o /dev/null');
    expect(updater).toContain('"${public_url%/}/version" -o "${tmp}/version.json"');
    expect(updater).toContain('"${public_url%/}/readyz" -o /dev/null');
  });

  it('rolls back both restart and health failures and documents readiness', async () => {
    const updater = await readFile(updaterPath, 'utf8');
    const operations = await readFile(operationsPath, 'utf8');
    expect(updater).toContain('if ! systemctl restart ai-agent-vm-worker; then\n  rollback');
    expect(updater).toContain('if [[ "${healthy}" != true ]]; then\n  rollback');
    expect(operations).toContain('A restart, liveness, readiness,');
    expect(operations).toContain('`/readyz` is healthy');
  });
});
