import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const installerPath = new URL('../scripts/install-vm-worker.sh', import.meta.url);

describe('VM worker installer data directories', () => {
  it('creates the private capacity state directory for the worker service user', async () => {
    const installer = await readFile(installerPath, 'utf8');
    expect(installer).toContain('install -d -o ai-agent -g ai-agent -m 0700 /var/lib/ai-agent-runner/capacity');
  });
});
