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

  it('allows only the fixed production ingress configuration command and keeps its secret on stdin', async () => {
    const wrapper = await readFile(new URL('../scripts/ai-agent-vm-worker-gha-update', import.meta.url), 'utf8');
    const installer = await readFile(new URL('../scripts/ai-agent-vm-worker-configure-production-ingress', import.meta.url), 'utf8');
    expect(wrapper).toContain("[[ \"$command\" == 'configure-production-ingress' ]]");
    expect(wrapper).toContain('exec /usr/local/sbin/ai-agent-vm-worker-configure-production-ingress');
    expect(installer).toContain('read -r -t 15 ingress_secret');
    expect(installer).toContain('VM_WORKER_UPDATE_READINESS_FILE');
    expect(installer).toContain('chmod 0600 "$config_stage"');
    expect(installer).not.toContain('eval ');
    expect(installer).not.toContain('bash -c');
  });
});
