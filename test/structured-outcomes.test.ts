import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRunResult } from '../src/contracts/result.js';
import { createHarness } from './helpers.js';

async function expectStructuredRefusal(
  h: ReturnType<typeof createHarness>,
  over: Parameters<typeof h.makeSpec>[0],
  expected: { code: string; retryable: boolean },
) {
  const { receipt } = h.start({
    ...over,
  });
  const result = await h.runner.waitFor(receipt.runId);
  expect(result.outcome).toBe('failed');
  expect(result.exitReason).toBe('preflight_refused');
  expect(result.failure).toMatchObject({ code: expected.code, failureClass: 'preflight', retryable: expected.retryable });
  expect(result.exitObserved).toBe(false);
  expect(result.usage).toEqual({ status: 'unknown' });
  expect(h.fake.startCalls).toBe(0);
  expect(h.runner.events(receipt.runId).map((event) => event.type)).toEqual(['claimed', 'failed']);
  const stored = JSON.parse(readFileSync(join(h.rootDir, 'runs', receipt.runId, 'result.json'), 'utf8')) as unknown;
  expect(validateRunResult(stored).ok).toBe(true);
}

describe('structured outcomes for admission refusals (§9)', () => {
  it('missing budget gives BUDGET_UNAVAILABLE without starting the engine', async () => {
    const h = createHarness({ scenario: 'success' });
    await expectStructuredRefusal(h, { budget: { correlationRef: 'budget-1', approved: false, reason: 'no budget for this profile' } }, {
      code: 'BUDGET_UNAVAILABLE',
      retryable: true,
    });
  });

  it('refuses OpenCode when a numeric enforcement policy is declared but not enforceable', async () => {
    const h = createHarness({ scenario: 'success' });
    await expectStructuredRefusal(h, {
      engine: { name: 'opencode', adapterVersion: '1' },
      budget: {
        correlationRef: 'budget-1',
        approved: true,
        enforcement: { provider: 'openai', policyId: 'sandbox-v1', maxInputTokens: 12000, maxOutputTokens: 2000, maxTotalTokens: 20000 },
      },
    }, { code: 'BUDGET_UNAVAILABLE', retryable: true });
  });

  it('missing credentials give CREDENTIALS_UNAVAILABLE', async () => {
    const h = createHarness({ scenario: 'success' });
    await expectStructuredRefusal(h, { credentialBindings: [{ ref: 'cred-1', scope: 'llm:call', status: 'missing' }] }, {
      code: 'CREDENTIALS_UNAVAILABLE',
      retryable: false,
    });
  });

  it('expired credentials are also refused', async () => {
    const h = createHarness({ scenario: 'success' });
    await expectStructuredRefusal(h, { credentialBindings: [{ ref: 'cred-1', scope: 'llm:call', status: 'expired' }] }, {
      code: 'CREDENTIALS_UNAVAILABLE',
      retryable: true,
    });
  });

  it('forbidden region gives REGION_FORBIDDEN', async () => {
    const h = createHarness({ scenario: 'success', host: { region: 'sandbox-eu' } });
    await expectStructuredRefusal(h, { regionConstraints: { allowedRegions: ['ru-zone'] } }, {
      code: 'REGION_FORBIDDEN',
      retryable: false,
    });
  });

  it('unknown host region is refused when the spec restricts regions', async () => {
    const h = createHarness({ scenario: 'success', host: {} });
    await expectStructuredRefusal(h, { regionConstraints: { allowedRegions: ['sandbox-eu'] } }, {
      code: 'REGION_FORBIDDEN',
      retryable: false,
    });
  });

  it('an unregistered engine is refused before spawn', async () => {
    const h = createHarness({ adapters: {} });
    await expectStructuredRefusal(h, {}, { code: 'ENGINE_UNSUPPORTED', retryable: false });
  });
});
