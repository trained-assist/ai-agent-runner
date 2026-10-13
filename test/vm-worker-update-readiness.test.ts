import { describe, expect, it } from 'vitest';
import { isSafeToUpdate } from '../scripts/assert-vm-worker-update-ready.mjs';

describe('VM worker update preflight schema', () => {
  it('accepts the live /readyz shape only when ready with no active work', () => {
    expect(isSafeToUpdate({ ready: true, checks: { activeRuns: 0, capacity: { activeReservations: 0 } } })).toBe(true);
    expect(isSafeToUpdate({ ready: true, checks: { activeRuns: 1, capacity: { activeReservations: 0 } } })).toBe(false);
    expect(isSafeToUpdate({ ready: true, checks: { activeRuns: 0, capacity: { activeReservations: 1 } } })).toBe(false);
    expect(isSafeToUpdate({ ready: true, checks: { capacity: { activeReservations: 0 } } })).toBe(false);
    expect(isSafeToUpdate({ ready: false, checks: { activeRuns: 0, capacity: { activeReservations: 0 } } })).toBe(false);
  });
});
