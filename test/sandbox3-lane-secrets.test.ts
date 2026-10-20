import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SANDBOX3_CONFIG,
  SANDBOX3_WORKER,
  provisionSandbox3LaneSecrets,
  sandbox3LaneSecret,
} from '../scripts/sandbox3-lane-secrets.mjs';

describe('sandbox3 lane secret provisioning', () => {
  it('targets the sandbox3 Worker and its own config', () => {
    expect(SANDBOX3_WORKER).toBe('trained-assist-runner-api-sandbox3');
    expect(SANDBOX3_CONFIG).toBe('wrangler.sandbox3.jsonc');
  });

  it('reads a secret from the given environment and trims it', () => {
    expect(sandbox3LaneSecret({ LLM_LADDER_TOKEN: '  token-value\n' }, 'LLM_LADDER_TOKEN')).toBe('token-value');
  });

  it('rejects a missing or too short secret before any Cloudflare call', () => {
    expect(() => sandbox3LaneSecret({}, 'LLM_LADDER_TOKEN')).toThrow('sandbox3_lane_secret_invalid:LLM_LADDER_TOKEN');
    expect(() => sandbox3LaneSecret({ LLM_LADDER_TOKEN: '   ' }, 'LLM_LADDER_TOKEN')).toThrow('sandbox3_lane_secret_invalid:LLM_LADDER_TOKEN');
    expect(() => sandbox3LaneSecret({ CF_API_TOKEN: 'short' }, 'CF_API_TOKEN', 20)).toThrow('sandbox3_lane_secret_invalid:CF_API_TOKEN');
  });

  it('requires the Cloudflare token and the ladder token before writing anything', () => {
    expect(() => provisionSandbox3LaneSecrets({})).toThrow('sandbox3_lane_secret_invalid:CF_API_TOKEN');
    expect(() => provisionSandbox3LaneSecrets({
      CF_API_TOKEN: 'synthetic-cloudflare-token-long-enough',
    })).toThrow('sandbox3_lane_secret_invalid:LLM_LADDER_TOKEN');
  });

  it('writes only the ladder token and leaves the lane registries untouched', () => {
    const written: Array<[string, string]> = [];
    const result = provisionSandbox3LaneSecrets({
      CF_API_TOKEN: 'synthetic-cloudflare-token-long-enough',
      LLM_LADDER_TOKEN: 'synthetic-ladder-token',
      RUNNER_API_KEYS: 'synthetic-registry',
      RUNNER_API_KEYS_SANDBOX3: 'synthetic-lane-registry',
      RUNNER_API_KEYS_CREDENTIALS: 'synthetic-intake-registry',
      RUNNER_API_KEYS_DEVELOPER: 'synthetic-developer-registry',
      AGENT_API_PROFILE_DELEGATION_SECRET: 'synthetic-delegation-secret',
    }, (name, value) => written.push([name, value]));

    expect(result).toEqual({ worker: SANDBOX3_WORKER, secrets: ['LLM_LADDER_TOKEN'] });
    expect(written).toEqual([['LLM_LADDER_TOKEN', 'synthetic-ladder-token']]);
    expect(written.map(([name]) => name)).not.toContain('RUNNER_API_KEYS');
    expect(written.map(([name]) => name)).not.toContain('RUNNER_API_KEYS_SANDBOX3');
    expect(written.map(([name]) => name)).not.toContain('RUNNER_API_KEYS_CREDENTIALS');
    expect(written.map(([name]) => name)).not.toContain('RUNNER_API_KEYS_DEVELOPER');
    expect(written.map(([name]) => name)).not.toContain('AGENT_API_PROFILE_DELEGATION_SECRET');
  });

  it('never prints a secret value', () => {
    const source = readFileSync(new URL('../scripts/sandbox3-lane-secrets.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/console\.log\([^)]*ladderToken/);
    expect(source).not.toMatch(/console\.log\([^)]*cfToken/);
    expect(source).not.toMatch(/console\.log\([^)]*value/);
  });
});
