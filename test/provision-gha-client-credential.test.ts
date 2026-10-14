import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = new URL('../scripts/provision-gha-client-credential.mjs', import.meta.url);

function setup(gatewayInventory = '[]', gatewayUrl = 'https://opencode-gha-runner-gateway-sandbox.skillset-apply.workers.dev') {
  const directory = mkdtempSync(join(tmpdir(), 'gha-credential-provision-'));
  const bin = join(directory, 'bin');
  const gateway = join(directory, 'gateway');
  const runnerConfig = join(directory, 'wrangler.sandbox3.jsonc');
  const calls = join(directory, 'calls.log');
  mkdirSync(bin);
  mkdirSync(gateway);
  writeFileSync(runnerConfig, JSON.stringify({ account_id: 'a'.repeat(32), vars: { GHA_WORKER_URL: gatewayUrl } }));
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\nprintf 'npx %s token-present=%s\\n' "$*" "${'${CLOUDFLARE_API_TOKEN:+yes}'}" >> "$MOCK_CALLS"\ncase "$*" in\n  *"secret list"*"wrangler.toml"*) printf '%s\\n' "$MOCK_GATEWAY_SECRETS" ;;\n  *"secret list"*) printf '%s\\n' '[]' ;;\n  *) exit 2 ;;\nesac\n`);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf 'gh %s token-present=%s\\n' "$*" "${'${CLOUDFLARE_API_TOKEN:+yes}'}" >> "$MOCK_CALLS"\nprintf '%s\\n' "$MOCK_GITHUB_SECRETS"\n`);
  writeFileSync(join(bin, 'security'), `#!/bin/sh\nprintf 'security %s\\n' "$*" >> "$MOCK_CALLS"\nprintf '%s\\n' 'mock-keychain-token'\n`);
  chmodSync(join(bin, 'npx'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'security'), 0o755);
  return { directory, bin, gateway, runnerConfig, calls, gatewayInventory };
}

function invoke(fixture: ReturnType<typeof setup>, { client = 'sandbox3_agent_api', gatewayEnv = 'sandbox', githubEnv = 'sandbox', keychain = false } = {}) {
  const args = [
    script.pathname,
    '--client-id', client,
    '--gateway-dir', fixture.gateway,
    '--gateway-config', 'wrangler.toml',
    '--gateway-env', gatewayEnv,
    '--runner-config', fixture.runnerConfig,
    '--github-env', githubEnv,
    '--dry-run',
  ];
  if (keychain) args.push('--keychain-service', 'cloudflare.com', '--keychain-account', 'trained-assist-sandbox', '--keychain-label', 'Trained Assist Cloudflare Sandbox API Token');
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: '',
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

  it('dry-run inventories the base production gateway, production Runner, and production GitHub environment', () => {
    const fixture = setup('[]', 'https://opencode-gha-runner-gateway.skillset-apply.workers.dev');
    try {
      const result = invoke(fixture, { client: 'production_agent_api', gatewayEnv: 'production', githubEnv: 'production' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('client=production_agent_api');
      const calls = readFileSync(fixture.calls, 'utf8');
      expect(calls).toContain('secret list --config wrangler.toml');
      expect(calls.split('\n').filter((line) => line.startsWith('npx ')).every((line) => !line.includes('--env'))).toBe(true);
      expect(calls).toContain('gh secret list --repo trained-assist/ai-agent-runner --env production');
      expect(result.stdout).not.toMatch(/[a-f0-9]{64}/);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('rejects cross-environment gateway URLs before querying or changing secrets', () => {
    const fixture = setup('[]', 'https://opencode-gha-runner-gateway.skillset-apply.workers.dev');
    try {
      const result = invoke(fixture);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('gateway URL and environment must match');
      expect(existsSync(fixture.calls)).toBe(false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('retrieves the explicitly selected Keychain credential only for Wrangler child processes', () => {
    const fixture = setup();
    try {
      const result = invoke(fixture, { keychain: true });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('mock-keychain-token');
      expect(result.stderr).not.toContain('mock-keychain-token');
      const calls = readFileSync(fixture.calls, 'utf8');
      expect(calls).toContain('security find-generic-password -s cloudflare.com -a trained-assist-sandbox -l Trained Assist Cloudflare Sandbox API Token -w');
      expect(calls.split('\n').filter((line) => line.startsWith('npx ')).every((line) => line.includes('token-present=yes'))).toBe(true);
      expect(calls.split('\n').filter((line) => line.startsWith('gh ')).every((line) => line.includes('token-present='))).toBe(true);
      expect(calls.split('\n').filter((line) => line.startsWith('gh ')).every((line) => !line.includes('token-present=yes'))).toBe(true);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});
