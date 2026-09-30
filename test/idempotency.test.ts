import { describe, expect, it } from 'vitest';
import { ConflictError } from '../src/contracts/validate.js';
import { createHarness, waitFor } from './helpers.js';

describe('duplicate start idempotency by operationId', () => {
  it('returns one run for a repeated start with the same payload', async () => {
    const h = createHarness({ scenario: 'success' });
    const spec = h.makeSpec();
    const first = h.runner.start(spec);
    expect(first.deduplicated).toBe(false);

    const second = h.runner.start(spec, spec.operationId);
    expect(second.deduplicated).toBe(true);
    expect(second.runId).toBe(first.runId);

    const result = await h.runner.waitFor(first.runId);
    expect(result.outcome).toBe('succeeded');

    const third = h.runner.start(spec, spec.operationId);
    expect(third.deduplicated).toBe(true);
    expect(third.runId).toBe(first.runId);
    expect(third.state).toBe('succeeded');
    expect(h.fake.startCalls).toBe(1);
    expect(h.runner.listRunIds()).toHaveLength(1);
  });

  it('rejects the same operationId with a different payload', async () => {
    const h = createHarness({ scenario: 'success' });
    const spec = h.makeSpec();
    h.runner.start(spec);
    const changed = { ...spec, limits: { timeoutMs: 9999 } };
    expect(() => h.runner.start(changed, spec.operationId)).toThrow(ConflictError);
    expect(h.runner.listRunIds()).toHaveLength(1);
  });

  it('duplicate start after a worker crash still returns the single run without a second engine', async () => {
    const h = createHarness({ scenario: 'timeout' });
    const spec = h.makeSpec();
    const receipt = h.runner.start(spec);
    await waitFor(() => h.runner.getRun(receipt.runId)?.state === 'running', 5000, 'run to be running');

    h.reopen();
    const again = h.runner.start(spec, spec.operationId);
    expect(again.deduplicated).toBe(true);
    expect(again.runId).toBe(receipt.runId);
    expect(h.fake.startCalls).toBe(1);
    expect(h.runner.listRunIds()).toHaveLength(1);

    const cancel = await h.runner.cancel(receipt.runId, spec.ownerGeneration);
    expect(cancel.status).toBe('stopped');
    await h.runner.waitFor(receipt.runId);
  });

  it('rejects an operationId that differs from the spec', () => {
    const h = createHarness({ scenario: 'success' });
    const spec = h.makeSpec();
    expect(() => h.runner.start(spec, 'op-somewhere-else')).toThrow(/operationId mismatch/);
  });
});
