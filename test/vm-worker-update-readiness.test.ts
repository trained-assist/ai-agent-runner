import { describe, expect, it } from 'vitest';
import { isSafeToUpdate } from '../scripts/assert-vm-worker-update-ready.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('VM worker update preflight schema', () => {
  it('accepts the live /readyz shape only when ready with no active work', () => {
    expect(isSafeToUpdate({ ready: true, checks: { activeRuns: 0, capacity: { activeReservations: 0 } } })).toBe(true);
    expect(isSafeToUpdate({ ready: true, checks: { activeRuns: 1, capacity: { activeReservations: 0 } } })).toBe(false);
    expect(isSafeToUpdate({ ready: true, checks: { activeRuns: 0, capacity: { activeReservations: 1 } } })).toBe(false);
    expect(isSafeToUpdate({ ready: true, checks: { capacity: { activeReservations: 0 } } })).toBe(false);
    expect(isSafeToUpdate({ ready: false, checks: { activeRuns: 0, capacity: { activeReservations: 0 } } })).toBe(false);
  });

  it('uses exit 75 only for a ready worker with active work so cloud deploy can retry safely', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'worker-readiness-'));
    try {
      const reportPath = join(dir, 'ready.json');
      await writeFile(reportPath, JSON.stringify({ ready: true, checks: { activeRuns: 1, capacity: { activeReservations: 0 } } }));
      const busy = spawnSync(process.execPath, ['scripts/assert-vm-worker-update-ready.mjs'], {
        cwd: process.cwd(), env: { ...process.env, VM_WORKER_UPDATE_READINESS_FILE: reportPath },
      });
      expect(busy.status).toBe(75);
      await writeFile(reportPath, JSON.stringify({ ready: true, checks: { capacity: { activeReservations: 0 } } }));
      const unknown = spawnSync(process.execPath, ['scripts/assert-vm-worker-update-ready.mjs'], {
        cwd: process.cwd(), env: { ...process.env, VM_WORKER_UPDATE_READINESS_FILE: reportPath },
      });
      expect(unknown.status).toBe(1);
      await writeFile(reportPath, JSON.stringify({ ready: false, checks: { activeRuns: 0, capacity: { activeReservations: 0 } } }));
      const unhealthy = spawnSync(process.execPath, ['scripts/assert-vm-worker-update-ready.mjs'], {
        cwd: process.cwd(), env: { ...process.env, VM_WORKER_UPDATE_READINESS_FILE: reportPath },
      });
      expect(unhealthy.status).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
