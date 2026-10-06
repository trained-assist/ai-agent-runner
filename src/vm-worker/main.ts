import { chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OpenCodeAdapter } from '../adapters/engine/opencode-adapter.js';
import { ArtifactStore } from '../storage/artifact-store.js';
import { createBlobStore } from '../storage/create-blob-store.js';
import { RunExportStore } from '../storage/export.js';
import { CapacityAdmission, LinuxHostUsageSampler } from './capacity-admission.js';
import { FileCapacityReservationStore } from './file-capacity-reservation-store.js';
import { createVmWorkerServer } from './http-server.js';
import { Runner } from '../runner/runner.js';
import { readVmWorkerBindingsInventory } from './bindings-inventory.js';
import { readVmWorkerBuildInfo } from './build-info.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function list(name: string): string[] {
  return (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

function positivePercent(name: string): number {
  const raw = required(name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 60) throw new Error(`${name} must be >0 and <60`);
  return value;
}

async function main(): Promise<void> {
  if (process.platform !== 'linux') throw new Error('the VM worker requires Linux host capacity metrics');
  const dataDir = resolve(process.env['VM_WORKER_DATA_DIR']?.trim() || '/var/lib/ai-agent-runner');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);

  const engineName = required('VM_WORKER_ENGINE');
  const workerId = process.env['VM_WORKER_ID']?.trim() || `${engineName}-${process.env['HOSTNAME'] ?? 'host'}`;
  const bindingsInventory = readVmWorkerBindingsInventory(required('VM_WORKER_BINDINGS_INVENTORY'));
  const expectedRegion = engineName === 'rf-vm-agent-run' ? 'ru' : 'eu';
  if (bindingsInventory.workerId !== workerId || bindingsInventory.region !== expectedRegion) {
    throw new Error('worker bindings inventory identity does not match VM_WORKER_ID/VM_WORKER_ENGINE');
  }
  const binary = process.env['OPENCODE_BIN']?.trim() || undefined;
  const engine = new OpenCodeAdapter(binary ? { binary } : {});
  const token = required('VM_WORKER_TOKEN');
  const allowedRepositories = list('VM_WORKER_ALLOWED_REPOSITORIES');
  const allowedEnvironmentNames = list('VM_WORKER_ALLOWED_ENV');
  const allowedCallbackOrigins = list('VM_WORKER_ALLOWED_CALLBACK_ORIGINS');
  if (!allowedRepositories.length) throw new Error('VM_WORKER_ALLOWED_REPOSITORIES must allow at least one owner/repository');
  if (!allowedEnvironmentNames.length) throw new Error('VM_WORKER_ALLOWED_ENV must name explicitly approved engine variables');
  if (!allowedCallbackOrigins.length) throw new Error('VM_WORKER_ALLOWED_CALLBACK_ORIGINS must contain the central API origin');
  if (!engine.isAvailable()) throw new Error('OpenCode binary is unavailable; install it or set OPENCODE_BIN');

  const storageBackend = required('STORAGE_BACKEND');
  if (storageBackend !== 'gcs') throw new Error('production VM worker requires STORAGE_BACKEND=gcs');
  const storage = createBlobStore({ backend: 'gcs', env: process.env });
  const artifacts = new ArtifactStore({ rootDir: join(dataDir, 'storage'), blob: storage });
  const exports = new RunExportStore({ rootDir: join(dataDir, 'storage'), artifacts, pruneLocalCopies: true });

  const runner = new Runner({
    rootDir: join(dataDir, 'runner'),
    adapters: { opencode: engine },
    host: { workerId, region: engineName === 'rf-vm-agent-run' ? 'ru' : 'eu', environment: 'production', allowedEngines: ['opencode'] },
    exports,
    resumeQueuedRuns: false,
  });
  const recovery = await runner.recover();
  process.stdout.write(`${JSON.stringify({ event: 'vm_worker_runner_recovered', workerId, ...recovery })}\n`);

  const reservationStore = new FileCapacityReservationStore(join(dataDir, 'capacity', 'reservations.json'));
  const sampler = new LinuxHostUsageSampler();
  const capacity = new CapacityAdmission({ sampler, store: reservationStore, thresholdPercent: 60 });
  const server = createVmWorkerServer({
    runner,
    capacity,
    capacityStore: reservationStore,
    sampler,
    engineName,
    baseUrl: required('VM_WORKER_PUBLIC_URL'),
    token,
    dataDir,
    allowedRepositories,
    allowedEnvironmentNames,
    allowedCallbackOrigins,
    envelope: { cpuPercent: positivePercent('VM_WORKER_CPU_RESERVATION_PCT'), memoryPercent: positivePercent('VM_WORKER_MEMORY_RESERVATION_PCT') },
    buildInfo: readVmWorkerBuildInfo(),
    bindingsInventory,
    engineAvailable: () => engine.isAvailable(),
  });
  const resumedReservations = await server.resumeCapacityMonitors();
  const host = process.env['VM_WORKER_BIND']?.trim() || '127.0.0.1';
  const port = Number(process.env['VM_WORKER_PORT']?.trim() || '8788');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('VM_WORKER_PORT must be a valid TCP port');

  server.listen(port, host, () => {
    process.stdout.write(`${JSON.stringify({ event: 'vm_worker_listening', workerId, engineName, host, port, resumedReservations, health: '/healthz', readiness: '/readyz' })}\n`);
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    server.close(() => { runner.dispose(); process.exit(0); });
    const timeout = setTimeout(() => { runner.dispose(); process.exit(1); }, 10_000);
    timeout.unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ event: 'vm_worker_start_failed', message })}\n`);
  process.exit(1);
});
