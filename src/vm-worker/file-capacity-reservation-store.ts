import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { hostname } from 'node:os';
import type {
  CapacityReservation,
  CapacityReservationStore,
  CapacityReservationTransaction,
} from './capacity-admission.js';

interface StoreDocument {
  version: 1;
  reservations: CapacityReservation[];
}

// Retain every operationId forever for idempotency. At the ceiling, fail closed
// instead of silently pruning tombstones and risking a duplicate process start.
export const MAX_CAPACITY_RESERVATIONS = 10_000;
export const MAX_CAPACITY_STATE_BYTES = 8 * 1024 * 1024;

interface LockOwner { version: 1; token: string; pid: number; hostname: string; startedAt: string }

export interface FileCapacityReservationStoreOptions {
  /** How long to wait for an active transaction before failing closed. */
  lockTimeoutMs?: number;
  lockPollMs?: number;
}

/**
 * Durable, single-host store for VM worker reservations. The atomic mkdir lock
 * serializes cooperating processes. A lock left by a crash is deliberately never
 * reclaimed automatically: an operator must establish that its owner is dead.
 */
export class FileCapacityReservationStore implements CapacityReservationStore {
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;

  constructor(private readonly statePath: string, options: FileCapacityReservationStoreOptions = {}) {
    if (!statePath || basename(statePath) === '.' || basename(statePath) === '..') throw new Error('statePath must name a file');
    this.lockPath = `${statePath}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
    this.lockPollMs = options.lockPollMs ?? 25;
    if (!Number.isFinite(this.lockTimeoutMs) || this.lockTimeoutMs < 0) throw new Error('lockTimeoutMs must be non-negative');
    if (!Number.isFinite(this.lockPollMs) || this.lockPollMs < 1) throw new Error('lockPollMs must be positive');
  }

  async withTransaction<T>(fn: (tx: CapacityReservationTransaction) => Promise<T>): Promise<T> {
    const parent = dirname(this.statePath);
    await ensurePrivateParent(parent);
    const token = await this.acquireLock();
    let result!: T;
    let failure: unknown;
    try {
      const original = await readDocument(this.statePath);
      const records = new Map(original.reservations.map((item) => [item.operationId, clone(item)]));
      let changed = false;
      const tx: CapacityReservationTransaction = {
        get: (id) => { const value = records.get(id); return value === undefined ? undefined : clone(value); },
        list: () => [...records.values()].map(clone),
        put: (reservation) => {
          validateReservation(reservation);
          records.set(reservation.operationId, clone(reservation));
          changed = true;
        },
        release: (id) => {
          const current = records.get(id);
          if (current && current.active) {
            records.set(id, { ...current, active: false });
            changed = true;
          }
        },
      };
      result = await fn(tx);
      if (changed) await writeDocument(this.statePath, { version: 1, reservations: [...records.values()] });
    } catch (error) {
      failure = error;
    }
    try {
      await this.releaseLock(token);
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    if (failure !== undefined) throw failure;
    return result;
  }

  private async acquireLock(): Promise<string> {
    const deadline = Date.now() + this.lockTimeoutMs;
    const token = randomUUID();
    for (;;) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        await chmod(this.lockPath, 0o700);
        const ownerPath = join(this.lockPath, 'owner');
        const owner = await open(ownerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        try {
          const metadata: LockOwner = { version: 1, token, pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() };
          await owner.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
          await owner.sync();
        } finally { await owner.close(); }
        await syncDirectory(this.lockPath);
        await syncDirectory(dirname(this.lockPath));
        return token;
      } catch (error) {
        if (isCode(error, 'EEXIST')) {
          if (Date.now() >= deadline) throw new Error(`capacity reservation lock is busy or ambiguous: ${this.lockPath}`);
          await delay(Math.min(this.lockPollMs, Math.max(1, deadline - Date.now())));
          continue;
        }
        // If mkdir succeeded but owner setup failed, retain the lock as ambiguous.
        throw error;
      }
    }
  }

  private async releaseLock(token: string): Promise<void> {
    const ownerPath = join(this.lockPath, 'owner');
    const ownerStat = await lstat(ownerPath);
    if (!ownerStat.isFile() || (ownerStat.mode & 0o077) !== 0) throw new Error('capacity lock owner file is unsafe');
    let owner: unknown;
    try { owner = JSON.parse(await readFile(ownerPath, 'utf8')); } catch { throw new Error('capacity reservation lock owner metadata is missing or corrupt'); }
    if (!isRecord(owner) || owner.version !== 1 || owner.token !== token || owner.pid !== process.pid || owner.hostname !== hostname()) {
      throw new Error('capacity reservation lock ownership changed');
    }
    await unlink(ownerPath);
    await rmdir(this.lockPath);
    await syncDirectory(dirname(this.lockPath));
  }
}

async function ensurePrivateParent(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('capacity store directory must be a private non-symlink directory (mode 0700)');
}

async function readDocument(path: string): Promise<StoreDocument> {
  let stat;
  try { stat = await lstat(path); } catch (error) {
    if (isCode(error, 'ENOENT')) return { version: 1, reservations: [] };
    throw error;
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('capacity state must be a private regular file (mode 0600)');
  if (stat.size > MAX_CAPACITY_STATE_BYTES) throw new Error(`capacity state exceeds ${MAX_CAPACITY_STATE_BYTES} byte safety limit; refusing to mutate`);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('capacity state is corrupt or unreadable'); }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.reservations)) throw new Error('capacity state schema is invalid');
  if (parsed.reservations.length > MAX_CAPACITY_RESERVATIONS) throw new Error(`capacity state exceeds ${MAX_CAPACITY_RESERVATIONS} reservation safety limit; refusing to mutate`);
  const seen = new Set<string>();
  for (const item of parsed.reservations) {
    validateReservation(item);
    if (seen.has(item.operationId)) throw new Error('capacity state has duplicate operationId');
    seen.add(item.operationId);
  }
  return parsed as StoreDocument;
}

async function writeDocument(path: string, document: StoreDocument): Promise<void> {
  if (document.reservations.length > MAX_CAPACITY_RESERVATIONS) throw new Error(`capacity reservation limit reached (${MAX_CAPACITY_RESERVATIONS}); refusing to discard idempotency records`);
  for (const item of document.reservations) validateReservation(item);
  const serialized = JSON.stringify(document);
  if (serialized === undefined) throw new Error('capacity state cannot be serialized');
  if (Buffer.byteLength(serialized, 'utf8') + 1 > MAX_CAPACITY_STATE_BYTES) throw new Error(`capacity state byte limit reached (${MAX_CAPACITY_STATE_BYTES}); refusing to discard idempotency records`);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${serialized}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    // A uniquely named temp file is ours; it is safe to remove.
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

function validateReservation(value: unknown): asserts value is CapacityReservation {
  if (!isRecord(value) || typeof value.operationId !== 'string' || !value.operationId
    || typeof value.runId !== 'string' || !value.runId
    || typeof value.requestFingerprint !== 'string' || !value.requestFingerprint
    || !['pending', 'accepted', 'uncertain'].includes(String(value.state))
    || typeof value.acceptedAt !== 'string' || !Number.isFinite(Date.parse(value.acceptedAt))
    || typeof value.active !== 'boolean' || !isRecord(value.envelope)
    || !finitePositive(value.envelope.cpuPercent) || value.envelope.cpuPercent > 100
    || !finitePositive(value.envelope.memoryPercent) || value.envelope.memoryPercent > 100) {
    throw new Error('capacity reservation schema is invalid');
  }
  try {
    const json = JSON.stringify(value.receipt);
    if (json === undefined) throw new Error();
    JSON.parse(json);
  } catch { throw new Error('capacity receipt is not JSON serializable'); }
}

function finitePositive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function clone<T>(value: T): T { return structuredClone(value); }
function isCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
