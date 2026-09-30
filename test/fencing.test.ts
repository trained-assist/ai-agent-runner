import { describe, expect, it } from 'vitest';
import { createHarness, waitFor } from './helpers.js';

describe('ownerGeneration fencing', () => {
  it('late events from an old ownerGeneration are rejected without touching state', async () => {
    const h = createHarness({ scenario: 'timeout' });
    const spec = h.makeSpec();
    const receipt = h.runner.start(spec);
    await waitFor(() => h.runner.getRun(receipt.runId)?.state === 'running', 5000, 'run to be running');

    const snapBefore = h.runner.getRun(receipt.runId);
    const eventsBefore = h.runner.events(receipt.runId).length;

    const late = h.runner.submitEvent(receipt.runId, {
      type: 'log',
      ownerGeneration: spec.ownerGeneration - 1,
      payload: { stream: 'runner', level: 'warn', message: 'late event from a previous owner' },
    });
    expect(late.accepted).toBe(false);
    expect(late.reason).toBe('stale_owner_generation');

    const snapAfter = h.runner.getRun(receipt.runId);
    expect(snapAfter?.state).toBe('running');
    expect(snapAfter?.sequence).toBe(snapBefore?.sequence);
    expect(snapAfter?.fencing.rejected).toBe(1);
    expect(h.runner.events(receipt.runId)).toHaveLength(eventsBefore);

    const staleCancel = await h.runner.cancel(receipt.runId, spec.ownerGeneration - 1);
    expect(staleCancel.status).toBe('rejected');
    expect(staleCancel.reason).toBe('stale_owner_generation');
    expect(h.runner.getRun(receipt.runId)?.state).toBe('running');
    expect(h.runner.getRun(receipt.runId)?.fencing.rejected).toBe(2);

    const accepted = h.runner.submitEvent(receipt.runId, {
      type: 'log',
      ownerGeneration: spec.ownerGeneration,
      payload: { stream: 'runner', level: 'info', message: 'current owner event' },
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.event?.sequence).toBe((snapBefore?.sequence ?? 0) + 1);

    const stop = await h.runner.cancel(receipt.runId, spec.ownerGeneration);
    expect(stop.status).toBe('stopped');
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('cancelled');
  });

  it('events after a terminal state are rejected for any generation', async () => {
    const h = createHarness({ scenario: 'success' });
    const spec = h.makeSpec();
    const receipt = h.runner.start(spec);
    await h.runner.waitFor(receipt.runId);

    const after = h.runner.submitEvent(receipt.runId, {
      type: 'log',
      ownerGeneration: spec.ownerGeneration,
      payload: { stream: 'runner', level: 'info', message: 'too late' },
    });
    expect(after.accepted).toBe(false);
    expect(after.reason).toBe('already_terminal');
  });

  it('unknown runs are rejected explicitly', () => {
    const h = createHarness({ scenario: 'success' });
    const res = h.runner.submitEvent('run-does-not-exist', {
      type: 'claimed',
      ownerGeneration: 1,
      payload: { operationId: 'op' },
    });
    expect(res).toEqual({ accepted: false, reason: 'unknown_run' });
  });
});
