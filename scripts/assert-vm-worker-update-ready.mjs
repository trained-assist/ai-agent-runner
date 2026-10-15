import { readFile } from 'node:fs/promises';

export function isSafeToUpdate(report) {
  return hasKnownReadiness(report)
    && report.checks.activeRuns === 0
    && report.checks.capacity.activeReservations === 0;
}

function hasKnownReadiness(report) {
  return report?.ready === true
    && Number.isSafeInteger(report?.checks?.activeRuns)
    && report.checks.activeRuns >= 0
    && Number.isSafeInteger(report?.checks?.capacity?.activeReservations)
    && report.checks.capacity.activeReservations >= 0;
}

if (process.env.VM_WORKER_UPDATE_READINESS_FILE) {
  const report = JSON.parse(await readFile(process.env.VM_WORKER_UPDATE_READINESS_FILE, 'utf8'));
  if (!hasKnownReadiness(report)) {
    process.stderr.write('Worker readiness is unknown or unhealthy; refusing update.\n');
    process.exitCode = 1;
  } else if (!isSafeToUpdate(report)) {
    process.stderr.write('Worker is not ready or has active runs/reservations; refusing update.\n');
    process.exitCode = 75;
  }
}
