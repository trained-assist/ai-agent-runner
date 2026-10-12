import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hasExpectedProductionCapabilities, productionRunnerPrincipalRecord } from '../tools/deploy-cloudflare-production.mjs';

describe('production Runner provisioning contract', () => {
  it('derives a single scoped production principal from the API key without storing its value', () => {
    const apiKey = 'production-api-key-value-with-at-least-32-characters';
    const record = productionRunnerPrincipalRecord(apiKey);

    expect(record).toEqual({
      keyHash: createHash('sha256').update(apiKey).digest('hex'),
      principalId: 'cp-production-runner',
      tenantId: 'trained-assist-production',
      profileId: 'trained-assist-production',
      repository: 'trained-assist/ai-agent-runner',
      scopes: ['runs:read', 'runs:write'],
      engines: ['eu-vm-agent-run'],
    });
    expect(JSON.stringify(record)).not.toContain(apiKey);
  });

  it('rejects an absent or undersized production API key', () => {
    expect(() => productionRunnerPrincipalRecord('')).toThrow('production_runner_api_key_invalid');
    expect(() => productionRunnerPrincipalRecord('too-short')).toThrow('production_runner_api_key_invalid');
  });

  it('requires the serverless API contract and France execution capability', () => {
    expect(hasExpectedProductionCapabilities({
      contract: { name: 'ai-agent-runner/serverless-agent-api' },
      placement: 'cloudflare-worker', executionRegions: ['eu-vm-agent-run'],
    })).toBe(true);
    expect(hasExpectedProductionCapabilities({
      contract: { name: 'ai-agent-runner/serverless-agent-api' },
      placement: 'cloudflare-worker', executionRegions: ['mock-test'],
    })).toBe(false);
    expect(hasExpectedProductionCapabilities({
      contract: { name: 'other' }, placement: 'cloudflare-worker', executionRegions: ['eu-vm-agent-run'],
    })).toBe(false);
  });
});
