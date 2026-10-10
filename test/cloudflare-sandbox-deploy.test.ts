import { describe, expect, it } from 'vitest';
import { hasExpectedApiCapabilities } from '../tools/deploy-cloudflare-telegram-ux-sandbox.mjs';

describe('Telegram UX Runner deploy acceptance', () => {
  it('accepts the actual serverless Runner API contract and EU engine', () => {
    expect(hasExpectedApiCapabilities({
      contract: { name: 'ai-agent-runner/serverless-agent-api', version: 1 },
      executionRegions: ['eu-vm-agent-run'],
    })).toBe(true);
  });

  it('rejects a mismatched API contract or missing execution engine', () => {
    expect(hasExpectedApiCapabilities({
      contract: { name: 'trained-assist-runner/serverless-agent-api' },
      executionRegions: ['eu-vm-agent-run'],
    })).toBe(false);
    expect(hasExpectedApiCapabilities({
      contract: { name: 'ai-agent-runner/serverless-agent-api' },
      executionRegions: ['mock-test'],
    })).toBe(false);
  });
});
