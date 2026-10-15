import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('France sandbox GitHub Actions forced command', () => {
  it('accepts one immutable release tag, reads the token from stdin, and only execs the installed updater', async () => {
    const script = await readFile(new URL('../scripts/ai-agent-vm-worker-gha-update', import.meta.url), 'utf8');
    expect(script).toContain('SSH_ORIGINAL_COMMAND');
    expect(script).toContain('^update\\ (vm-worker-v[0-9]+\\.[0-9]+\\.[0-9]+)$');
    expect(script).toContain('read -r -t 15 gh_token');
    expect(script).toContain('export GH_TOKEN="$gh_token"');
    expect(script).toContain('exec "$updater" "$release_tag"');
    expect(script).not.toContain('eval ');
    expect(script).not.toContain('bash -c');
  });
});
