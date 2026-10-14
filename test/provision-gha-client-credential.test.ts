import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = new URL('../scripts/provision-gha-client-credential.mjs', import.meta.url);

function setup(gatewayInventory = '[]') {
  const directory = mkdtempSync(join(tmpdir(), 'gha-credential-provision-'));
  const bin = join(directory, 'bin');
  const gateway = join(directory, 'gateway');
  const runnerConfig = join(directory, 'wrangler.sandbox3.jsonc');
  const calls = join(directory, 'calls.log');
  mkdirSync(bin);
  mkdirSync(gateway);
  writeFileSync(runnerConfig, JSON.stringify({ vars: { GHA_WORKER_URL: 'https://opencode-gha-runner-gateway-sandbox.example.workers.dev' } }));
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\nprintf 'npx %s\\n' "$*" >> "$MOCK_CALLS"\ncase "$*" in\n  *"secret list"*"wrangler.toml"*) printf '%s\\n' "$MOCK_GATEWAY_SECRETS" ;;\n  *"secret list"*) printf '%s\\n' '[]' ;;\n  *) exit 2 ;;\nesac\n`);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf 'gh %s\\n' "$*" >> "$MOCK_CALLS"\nprintf '%s\\n' "$MOCK_GITHUB_SECRETS"\n`);
  chmodSync(join(bin, 'npx'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  return { directory, bin, gateway, runnerConfig, calls, gatewayInventory };
}

function invoke(fixture: ReturnType<typeof setup>) {
  return spawnSync(process.execPath, [
    script.pathname,
    '--client-id', 'sandbox3_agent_api',
    '--gateway-dir', fixture.gateway,
    '--gateway-config', 'wrangler.toml',
    '--gateway-env', 'sandbox',
    '--runner-config', fixture.runnerConfig,
    '--github-env', 'sandbox',
    '--dry-run',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env['PATH'] ?? ''}`,
      MOCK_CALLS: fixture.calls,
      MOCK_GATEWAY_SECRETS: fixture.gatewayInventory,
      MOCK_GITHUB_SECRETS: 'NAME UPDATED',
    },
  });
}

describe('GHA client credential provisioning', () => {
  it('dry-run inventories all three sandbox destinations without writing secrets', () => {
    const fixture = setup();
    try {
      const result = invoke(fixture);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Dry run: all three target secret names are available');
      const calls = readFileSync(fixture.calls, 'utf8');
      expect(calls.match(/npx .*secret list/g)).toHaveLength(2);
      expect(calls).toContain('gh secret list');
      expect(calls).not.toContain('secret put');
      expect(calls).not.toContain('secret set');
      expect(result.stdout).not.toMatch(/[a-f0-9]{64}/);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing gateway client key', () => {
    const fixture = setup('[{"name":"WORKER_CLIENT_TOKEN_SANDBOX3_AGENT_API"}]');
    try {
      const result = invoke(fixture);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('refusing to overwrite existing credentials');
      const calls = readFileSync(fixture.calls, 'utf8');
      expect(calls).not.toContain('secret put');
      expect(calls).not.toContain('secret set');
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});
