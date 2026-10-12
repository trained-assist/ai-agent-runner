import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const installerPath = new URL('../scripts/install-vm-worker.sh', import.meta.url);

describe('VM worker installer data directories', () => {
  it('creates the private capacity state directory for the worker service user', async () => {
    const installer = await readFile(installerPath, 'utf8');
    expect(installer).toContain('install -d -o ai-agent -g ai-agent -m 0700 /var/lib/ai-agent-runner/capacity');
  });

  it('installs Chromium shared libraries on France workers, including Ubuntu t64 packages', async () => {
    const installer = await readFile(installerPath, 'utf8');
    const runtime = await readFile(new URL('../scripts/install-playwright-runtime.sh', import.meta.url), 'utf8');
    expect(installer).toContain('if [[ "${region}" == "france" ]]');
    expect(installer).toContain('"${script_dir}/install-playwright-runtime.sh"');
    expect(runtime).toContain('"libatk1.0-0|libatk1.0-0t64"');
    expect(runtime).toContain('"libatk-bridge2.0-0|libatk-bridge2.0-0t64"');
    expect(runtime).toContain("grep -F 'libatk-1.0.so.0'");
    expect(runtime).toContain('apt-get install -y --no-install-recommends');
    expect(runtime).toContain('apt-cache policy "${candidate}"');
    expect(runtime).toContain('END { print version }');
    expect(runtime).not.toContain('{ print $2; exit }');
    expect(runtime).toContain('"${candidate_version}" != "(none)"');
  });
});
