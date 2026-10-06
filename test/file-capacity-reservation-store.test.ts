import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCapacityReservationStore } from '../src/vm-worker/file-capacity-reservation-store.js';
import { CapacityAdmission, type CapacityReservation, type HostUsageSampler } from '../src/vm-worker/capacity-admission.js';

const roots: string[] = [];
async function fixture(): Promise<{ root: string; state: string; store: FileCapacityReservationStore }> {
  const root = await mkdtemp(join(tmpdir(), 'capacity-store-'));
  roots.push(root);
  const state = join(root, 'reservations.json');
  return { root, state, store: new FileCapacityReservationStore(state, { lockTimeoutMs: 5_000, lockPollMs: 2 }) };
}
function reservation(operationId: string): CapacityReservation {
  return { operationId, runId: `run-${operationId}`, requestFingerprint: `fp-${operationId}`, state: 'pending', receipt: null,
    acceptedAt: new Date().toISOString(), active: true, envelope: { cpuPercent: 4, memoryPercent: 5 } };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('FileCapacityReservationStore', () => {
  it('serializes concurrent transactions and durably commits private state', async () => {
    const { state, store } = await fixture();
    const second = new FileCapacityReservationStore(state, { lockTimeoutMs: 5_000, lockPollMs: 2 });
    await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? store : second).withTransaction(async (tx) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      tx.put(reservation(`op-${index}`));
    })));
    const stat = await lstat(state);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(state, 'utf8')).reservations).toHaveLength(12);
    const records = await store.withTransaction(async (tx) => tx.list());
    expect(records.map((record) => record.operationId).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `op-${i}`).sort());
    expect(await lstat(`${state}.lock`).catch(() => undefined)).toBeUndefined();
  });

  it('writes diagnostic owner metadata while holding the lock', async () => {
    const { state, store } = await fixture();
    await store.withTransaction(async () => {
      const owner = JSON.parse(await readFile(`${state}.lock/owner`, 'utf8'));
      expect(owner).toMatchObject({ version: 1, pid: process.pid, hostname: expect.any(String), token: expect.any(String), startedAt: expect.any(String) });
    });
  });

  it('rolls back callback errors and leaves the previous committed document intact', async () => {
    const { state, store } = await fixture();
    await store.withTransaction(async (tx) => { tx.put(reservation('kept')); });
    await expect(store.withTransaction(async (tx) => { tx.put(reservation('rolled-back')); throw new Error('abort'); })).rejects.toThrow('abort');
    const records = await store.withTransaction(async (tx) => tx.list());
    expect(records.map((record) => record.operationId)).toEqual(['kept']);
    expect(JSON.parse(await readFile(state, 'utf8')).reservations).toHaveLength(1);
  });

  it('fails closed on malformed or schema-invalid state', async () => {
    const { state, store } = await fixture();
    await writeFile(state, '{broken');
    await chmod(state, 0o600);
    await expect(store.withTransaction(async () => 'unsafe')).rejects.toThrow(/corrupt|unreadable/);
    await writeFile(state, JSON.stringify({ version: 9, reservations: [] }));
    await chmod(state, 0o600);
    await expect(store.withTransaction(async () => 'unsafe')).rejects.toThrow('schema is invalid');
  });

  it('refuses state files and parent directories with unsafe permissions', async () => {
    const { root, state, store } = await fixture();
    await writeFile(state, JSON.stringify({ version: 1, reservations: [] }));
    await chmod(state, 0o644);
    await expect(store.withTransaction(async () => 'unsafe')).rejects.toThrow('private regular file');
    await chmod(state, 0o600);
    await chmod(root, 0o755);
    await expect(store.withTransaction(async () => 'unsafe')).rejects.toThrow('private non-symlink directory');
  });

  it('never reclaims an ambiguous pre-existing lock', async () => {
    const { state } = await fixture();
    const store = new FileCapacityReservationStore(state, { lockTimeoutMs: 50, lockPollMs: 2 });
    const lockPath = `${state}.lock`;
    await mkdir(lockPath, { mode: 0o700 }); // Simulates a crash before owner metadata was durably written.
    await expect(store.withTransaction(async () => 'unsafe')).rejects.toThrow('busy or ambiguous');
    expect((await lstat(lockPath)).isDirectory()).toBe(true);
  });

  it('fails closed at the reservation ceiling without pruning idempotency tombstones', async () => {
    const { state, store } = await fixture();
    const records = Array.from({ length: 10_000 }, (_, i) => reservation(`retained-${i}`));
    await writeFile(state, JSON.stringify({ version: 1, reservations: records }), { mode: 0o600 });
    await expect(store.withTransaction(async (tx) => { tx.put(reservation('one-too-many')); })).rejects.toThrow(/limit reached.*idempotency/);
    const after = JSON.parse(await readFile(state, 'utf8')).reservations;
    expect(after).toHaveLength(10_000);
    expect(after[0].operationId).toBe('retained-0');
    expect(after.at(-1).operationId).toBe('retained-9999');
  });

  it('does not follow symlinked state files', async () => {
    const { root, state, store } = await fixture();
    const target = join(root, 'target.json');
    await writeFile(target, JSON.stringify({ version: 1, reservations: [] }));
    await chmod(target, 0o600);
    const { symlink } = await import('node:fs/promises');
    await symlink(target, state);
    await expect(store.withTransaction(async () => 'unsafe')).rejects.toThrow('private regular file');
  });

  it('replays a durable pending reservation after restart without starting a second process', async () => {
    const { state, store } = await fixture();
    await store.withTransaction(async (tx) => { tx.put(reservation('restart-op')); });

    const sampler: HostUsageSampler = {
      sample: async () => ({ cpuPercent: 10, memoryPercent: 20, sampledAt: new Date().toISOString() }),
    };
    const restartedAdmission = new CapacityAdmission({ sampler, store: new FileCapacityReservationStore(state) });
    let starts = 0;
    const result = await restartedAdmission.start({
      operationId: 'restart-op', runId: 'run-restart-op', engineName: 'opencode',
      requestFingerprint: 'fp-restart-op', envelope: { cpuPercent: 4, memoryPercent: 5 },
      start: async () => { starts++; return { receipt: {}, processTreeExited: Promise.resolve() }; },
    });

    expect(result).toMatchObject({ accepted: false, uncertain: true, code: 'WORKER_ADMISSION_UNCERTAIN' });
    expect(starts).toBe(0);
    const replayed = await store.withTransaction(async (tx) => tx.get('restart-op'));
    expect(replayed).toMatchObject({ state: 'pending', active: true });
  });
});
