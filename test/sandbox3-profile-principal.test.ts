import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sandbox3ProfilePrincipalRecord, provisionSandbox3ProfilePrincipal } from '../scripts/sandbox3-profile-principal.mjs';

describe('sandbox3 live profile principal provisioning', () => {
  it('creates a minimally scoped hash-only record in the isolated tenant registry', () => {
    const apiKey = 'ak_' + 'a'.repeat(48);
    const record = sandbox3ProfilePrincipalRecord(apiKey);
    expect(record).toEqual({
      keyHash: createHash('sha256').update(apiKey).digest('hex'),
      principalId: 'sandbox3-agent-api-principal',
      tenantId: 'sandbox3-acceptance-a-20261008',
      profileId: 'integration-sandbox3-v1',
      repository: 'trained-assist/ai-agent-runner',
      scopes: ['runs:read', 'runs:write'],
      engines: ['eu-vm-agent-run'],
    });
    expect(JSON.stringify(record)).not.toContain(apiKey);
  });

  it('validates both credentials before making any Cloudflare calls', () => {
    expect(() => sandbox3ProfilePrincipalRecord('short')).toThrow('sandbox3_profile_api_key_invalid');
    expect(() => provisionSandbox3ProfilePrincipal({
      SANDBOX3_RUNNER_API_KEY: 'ak_' + 'a'.repeat(48),
      SANDBOX3_PROFILE_DELEGATION_SECRET: 'short',
      CF_API_TOKEN: 'synthetic-cloudflare-token-long-enough',
    })).toThrow('sandbox3_profile_delegation_secret_invalid');
  });
});
