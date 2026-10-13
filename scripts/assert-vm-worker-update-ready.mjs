import { readFile } from 'node:fs/promises';

export function isSafeToUpdate(report) {
  return report?.ready === true
    && report?.checks?.activeRuns === 0
    && report?.checks?.capacity?.activeReservations === 0;
}

if (process.env.VM_WORKER_UPDATE_READINESS_FILE) {
  const report = JSON.parse(await readFile(process.env.VM_WORKER_UPDATE_READINESS_FILE, 'utf8'));
  if (!isSafeToUpdate(report)) {
    process.stderr.write('Worker is not ready or has active runs/reservations; refusing update.\n');
    process.exitCode = 1;
  }
}
