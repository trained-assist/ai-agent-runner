import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const updaterPath = new URL('../scripts/deploy-vm-worker-release.sh', import.meta.url);
const operationsPath = new URL('../docs/VM-WORKER-OPERATIONS.md', import.meta.url);
const releaseWorkflowPath = new URL('../.github/workflows/vm-worker-release.yml', import.meta.url);
const ghaUpdatePath = new URL('../scripts/ai-agent-vm-worker-gha-update', import.meta.url);

describe('VM worker release updater safety contract', () => {
  it('installs the binding inventory of the worker it is deployed to, not a fixed region', async () => {
    const updater = await readFile(updaterPath, 'utf8');
    const workflow = await readFile(releaseWorkflowPath, 'utf8');
    // One signed release serves the France sandbox: the updater picks the
    // inventory by the host's own VM_WORKER_ID, so a host can never receive
    // another worker's inventory.
    expect(workflow).toContain('cp deploy/vm-worker/inventory/france.json "$STAGE/deploy/vm-worker/inventory/"');
    expect(workflow).not.toContain('inventory/russia.json');
    expect(updater).toContain('inventory_source="$(node "$(dirname -- "${updater_path}")/select-vm-worker-inventory.mjs" "${inventory_dir}" "${worker_id}")"');
    expect(updater).not.toContain('inventory_source="${release_dir}/deploy/vm-worker/inventory/france.json"');
    expect(updater).toContain("sed -n 's/^VM_WORKER_ID=//p' \"$config_file\"");
    expect(updater).toContain("sed -n 's/^VM_WORKER_BINDINGS_INVENTORY=//p' \"$config_file\"");
    expect(updater).toContain('install -o root -g root -m 0644 "$inventory_source" "$inventory_target"');
    expect(updater).toContain('scripts/select-vm-worker-inventory.mjs');
  });

  it('deploys the signed release to the France sandbox only', async () => {
    const workflow = await readFile(releaseWorkflowPath, 'utf8');
    expect(workflow).toContain('Deploy signed release to France sandbox');
    expect(workflow).toContain('deploy/vm-worker/france-deploy-known-hosts');
    // The Russia sandbox deployment path is removed: no job, no secrets, no host.
    expect(workflow).not.toContain('Deploy signed release to Russia sandbox');
    expect(workflow).not.toContain('russia-deploy-known-hosts');
    expect(workflow).not.toContain('root@45.94.209.122');
    expect(workflow).not.toContain('RUSSIA_VM_RELEASE_DEPLOY_KEY');
    expect(workflow).not.toContain('RUSSIA_VM_RELEASE_READ_TOKEN');
    expect(workflow).not.toContain('environment: russia-sandbox');
  });
  it('resolves its colocated readiness helper independently of the caller cwd', async () => {
    const updater = await readFile(updaterPath, 'utf8');
    const scriptDir = updater.indexOf('script_dir=');
    const readiness = updater.indexOf('"${script_dir}/assert-vm-worker-update-ready.mjs"');
    expect(scriptDir).toBeGreaterThanOrEqual(0);
    expect(scriptDir).toBeLessThan(updater.indexOf('VM_WORKER_UPDATE_READINESS_FILE='));
    expect(readiness).toBeGreaterThanOrEqual(0);
    expect(updater).toContain('${BASH_SOURCE[0]}');
    expect(updater).toContain('assert-vm-worker-update-ready.mjs" "$(dirname -- "${updater_path}")/assert-vm-worker-update-ready.mjs');
  });

  it('validates the endpoint before switching releases and requires readyz', async () => {
    const updater = await readFile(updaterPath, 'utf8');
    const workflow = await readFile(releaseWorkflowPath, 'utf8');
    const validateEndpoint = updater.indexOf('VM_WORKER_PUBLIC_URL must be an http(s) origin');
    const switchRelease = updater.indexOf('mv -Tf "${root}/.current.$$" "${root}/current"');
    expect(validateEndpoint).toBeGreaterThanOrEqual(0);
    expect(validateEndpoint).toBeLessThan(switchRelease);
    expect(updater).toContain('"${public_url%/}/healthz" -o /dev/null');
    expect(updater).toContain('"${public_url%/}/version" -o "${tmp}/version.json"');
    expect(updater).toContain('"${public_url%/}/readyz" -o "${tmp}/ready.json"');
    expect(updater).toContain('"${public_url%/}/readyz" -o "${tmp}/current-ready.json"');
    expect(updater).toContain('assert-vm-worker-update-ready.mjs');
    expect(updater).toContain('readiness_status=$?');
    expect(updater).toContain('if [[ "${readiness_status}" -eq 75 ]]');
    expect(workflow).toContain('scripts/assert-vm-worker-update-ready.mjs');
    expect(workflow).toContain('if [[ "$status" -ne 75 ]]; then');
  });

  it('verifies the bundled OpenCode version and binary hash before switching, then reports both identities', async () => {
    const updater = await readFile(updaterPath, 'utf8');
    const verifyBinary = updater.indexOf('Bundled OpenCode version or SHA-256 does not match');
    const switchRelease = updater.indexOf('mv -Tf "${root}/.current.$$" "${root}/current"');
    expect(verifyBinary).toBeGreaterThanOrEqual(0);
    expect(verifyBinary).toBeLessThan(switchRelease);
    expect(updater).toContain('sha256sum "${opencode_file}"');
    expect(updater).toContain('"${opencode_file}" --version');
    expect(updater).toContain('b?.opencode?.binarySha256!==process.argv[5]');
    expect(updater).toContain('VM_WORKER_OPENCODE_PATH:-/usr/local/bin/opencode');
  });

  it('installs the forced-command deploy helper and makes a verified same-release deployment a no-op', async () => {
    const updater = await readFile(updaterPath, 'utf8');
    const bootstrap = await readFile(new URL('../scripts/install-vm-worker.sh', import.meta.url), 'utf8');
    const workflow = await readFile(releaseWorkflowPath, 'utf8');
    const noOp = updater.indexOf('VM worker already at version=');
    const restart = updater.indexOf('systemctl restart ai-agent-vm-worker');
    expect(updater).toContain('scripts/ai-agent-vm-worker-gha-update');
    expect(updater).toContain('if [[ "${old_target}" == "${release_dir}"');
    expect(noOp).toBeGreaterThanOrEqual(0);
    expect(noOp).toBeLessThan(restart);
    expect(bootstrap).toContain('install -o root -g root -m 0755 "${script_dir}/ai-agent-vm-worker-gha-update"');
    expect(workflow).toContain('Deploy signed release to France sandbox');
    expect(workflow).toContain('active runs drain');
    expect(workflow).toContain('StrictHostKeyChecking=yes');
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
