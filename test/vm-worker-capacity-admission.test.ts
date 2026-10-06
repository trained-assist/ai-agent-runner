import { describe, expect, it } from 'vitest';
import {
  CapacityAdmission,
  type CapacityReservation,
  type CapacityReservationStore,
  type CapacityReservationTransaction,
  type HostUsageSample,
  type HostUsageSampler,
} from '../src/vm-worker/capacity-admission.js';

class MemoryStore implements CapacityReservationStore {
  readonly records = new Map<string, CapacityReservation>();
  private tail: Promise<void> = Promise.resolve();
  async withTransaction<T>(fn: (tx: CapacityReservationTransaction) => Promise<T>): Promise<T> {
    let unlock!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try {
      return await fn({
        get: (id) => this.records.get(id),
        list: () => [...this.records.values()],
        put: (record) => { this.records.set(record.operationId, record); },
        release: (id) => {
          const record = this.records.get(id);
          if (record) this.records.set(id, { ...record, active: false });
        },
      });
    } finally { unlock(); }
  }
}

class FixedSampler implements HostUsageSampler {
  calls = 0;
  constructor(public value: HostUsageSample | Error) {}
  async sample(): Promise<HostUsageSample> {
    this.calls++;
    if (this.value instanceof Error) throw this.value;
    return this.value;
  }
}

const now = Date.parse('2026-10-05T12:00:00.000Z');
const sample = (cpuPercent = 12, memoryPercent = 25, sampledAt = new Date(now).toISOString()): HostUsageSample => ({ cpuPercent, memoryPercent, sampledAt });
const request = (operationId: string, runId: string, start: () => Promise<{ receipt: unknown; processTreeExited: Promise<unknown> }>, overrides: Record<string, unknown> = {}) => ({
  operationId, runId, engineName: 'opencode', requestFingerprint: `fingerprint-${runId}`,
  envelope: { cpuPercent: 5, memoryPercent: 5 }, start, ...overrides,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe('VM worker capacity admission', () => {
  it('serializes concurrent operations and deduplicates operationId to one start/receipt', async () => {
    const store = new MemoryStore();
    const sampler = new FixedSampler(sample());
    const admission = new CapacityAdmission({ sampler, store, now: () => now });
    const exited = deferred<void>();
    const allowRegistration = deferred<void>();
    let starts = 0;
    const start = async () => { starts++; await allowRegistration.promise; return { receipt: { runId: 'run-1' }, processTreeExited: exited.promise }; };
    const firstPromise = admission.start(request('op-1', 'run-1', start));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const duplicatePending = await admission.start(request('op-1', 'run-1', start));
    expect(duplicatePending).toMatchObject({ accepted: false, uncertain: true });
    allowRegistration.resolve();
    const first = await firstPromise;
    expect(starts).toBe(1);
    expect(sampler.calls).toBe(1);
    expect(first).toMatchObject({ accepted: true, duplicate: false, receipt: { runId: 'run-1' } });
    const duplicate = await admission.start(request('op-1', 'run-1', start));
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true, receipt: { runId: 'run-1' } });
    expect(store.records.get('op-1')?.active).toBe(true);
    exited.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.records.get('op-1')?.active).toBe(false);
    const afterTerminal = await admission.start(request('op-1', 'run-1', start));
    expect(afterTerminal).toMatchObject({ accepted: true, duplicate: true });
    expect(starts).toBe(1);
  });

  it.each([
    [60, 20], [20, 60], [80, 10], [10, 80],
  ])('refuses CPU/RAM at or above threshold before registration (%s%% CPU, %s%% RAM)', async (cpu, ram) => {
    const store = new MemoryStore();
    const admission = new CapacityAdmission({ sampler: new FixedSampler(sample(cpu, ram)), store, now: () => now });
    let starts = 0;
    const result = await admission.start(request('op-overloaded', 'run-overloaded', async () => { starts++; return { receipt: {}, processTreeExited: Promise.resolve() }; }, { envelope: { cpuPercent: 1, memoryPercent: 1 } }));
    expect(result).toMatchObject({ accepted: false, httpStatus: 503, code: 'WORKER_CAPACITY', cpuPercent: cpu, memoryPercent: ram });
    expect(starts).toBe(0);
    expect(store.records.size).toBe(0);
  });

  it.each([
    { label: 'CPU reaches the cutoff', cpu: 54.9, memory: 10, cpuEnvelope: 5.1, memoryEnvelope: 1, accepted: false },
    { label: 'CPU stays just below the cutoff', cpu: 54.8, memory: 10, cpuEnvelope: 5.1, memoryEnvelope: 1, accepted: true },
    { label: 'RAM reaches the cutoff', cpu: 10, memory: 54.9, cpuEnvelope: 1, memoryEnvelope: 5.1, accepted: false },
    { label: 'RAM stays just below the cutoff', cpu: 10, memory: 54.8, cpuEnvelope: 1, memoryEnvelope: 5.1, accepted: true },
  ])('applies the 60% cutoff to projected host usage: $label', async ({ cpu, memory, cpuEnvelope, memoryEnvelope, accepted }) => {
    const store = new MemoryStore();
    const admission = new CapacityAdmission({ sampler: new FixedSampler(sample(cpu, memory)), store, now: () => now });
    let starts = 0;
    const result = await admission.start(request('boundary', `boundary-${cpu}-${memory}`, async () => {
      starts++;
      return { receipt: {}, processTreeExited: Promise.resolve() };
    }, { envelope: { cpuPercent: cpuEnvelope, memoryPercent: memoryEnvelope } }));
    expect(result.accepted).toBe(accepted);
    expect(starts).toBe(accepted ? 1 : 0);
    if (!accepted) expect(result).toMatchObject({ code: 'WORKER_CAPACITY', httpStatus: 503 });
  });

  it('snapshots the validated resource envelope before asynchronous sampling', async () => {
    const store = new MemoryStore();
    const sampleReady = deferred<HostUsageSample>();
    const sampler: HostUsageSampler = { sample: () => sampleReady.promise };
    const admission = new CapacityAdmission({ sampler, store, now: () => now });
    const envelope = { cpuPercent: 5.2, memoryPercent: 1 };
    let starts = 0;
    const pending = admission.start(request('mutable-envelope', 'run-mutable-envelope', async () => {
      starts++;
      return { receipt: {}, processTreeExited: Promise.resolve() };
    }, { envelope }));

    // The validated 5.2% reservation would take CPU from 54.9% above the 60% cap.
    // Mutating the caller-owned object while sample() is pending must not lower it.
    envelope.cpuPercent = 1;
    sampleReady.resolve(sample(54.9, 10));
    const result = await pending;

    expect(result).toMatchObject({ accepted: false, code: 'WORKER_CAPACITY' });
    expect(starts).toBe(0);
    expect(store.records.size).toBe(0);
  });

  it('fails closed on stale or unavailable whole-host metrics', async () => {
    const store = new MemoryStore();
    const stale = new CapacityAdmission({ sampler: new FixedSampler(sample(3, 4, new Date(now - 6_000).toISOString())), store, now: () => now });
    const unavailable = new CapacityAdmission({ sampler: new FixedSampler(new Error('procfs unavailable')), store, now: () => now });
    const start = async () => ({ receipt: {}, processTreeExited: Promise.resolve() });
    expect(await stale.start(request('stale', 'r1', start))).toMatchObject({ accepted: false, httpStatus: 503, code: 'WORKER_CAPACITY_UNKNOWN' });
    expect(await unavailable.start(request('unavailable', 'r2', start))).toMatchObject({ accepted: false, httpStatus: 503, code: 'WORKER_CAPACITY_UNKNOWN' });
    expect(store.records.size).toBe(0);
  });

  it('fails closed if the reservation store is unavailable before registration', async () => {
    const unavailableStore: CapacityReservationStore = {
      withTransaction: async () => { throw new Error('durable store unavailable'); },
    };
    const admission = new CapacityAdmission({ sampler: new FixedSampler(sample()), store: unavailableStore, now: () => now });
    let starts = 0;
    const result = await admission.start({
      ...request('store-down', 'r-store-down', async () => { starts++; return { receipt: {}, processTreeExited: Promise.resolve() }; }),
    });
    expect(result).toMatchObject({ accepted: false, httpStatus: 503, code: 'WORKER_ADMISSION_UNAVAILABLE' });
    expect(starts).toBe(0);
  });

  it('rejects non-OpenCode engines before sampling or registration', async () => {
    const store = new MemoryStore();
    const sampler = new FixedSampler(sample());
    const admission = new CapacityAdmission({ sampler, store, now: () => now });
    await expect(admission.start(request('claude', 'r3', async () => ({ receipt: {}, processTreeExited: Promise.resolve() }), { engineName: 'claude' })))
      .rejects.toThrow('permits only the opencode engine');
    expect(sampler.calls).toBe(0);
    expect(store.records.size).toBe(0);
  });

  it('keeps a durable uncertain tombstone after a start-side-effect error; retry cannot spawn twice', async () => {
    const store = new MemoryStore();
    const admission = new CapacityAdmission({ sampler: new FixedSampler(sample()), store, now: () => now });
    let starts = 0;
    const input = request('op-fail', 'r4', async (): Promise<{ receipt: object; processTreeExited: Promise<void> }> => { starts++; throw new Error('spawn may have happened'); });
    expect(await admission.start(input)).toMatchObject({ accepted: false, uncertain: true, code: 'WORKER_ADMISSION_UNCERTAIN' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.records.get('op-fail')).toMatchObject({ state: 'uncertain', active: true });
    const retry = await admission.start(request('op-fail', 'r4', async () => { starts++; return { receipt: { runId: 'r4' }, processTreeExited: Promise.resolve() }; }));
    expect(retry).toMatchObject({ accepted: false, uncertain: true });
    expect(starts).toBe(1);
  });

  it('treats a pending reservation recovered after process restart as uncertain without relaunch', async () => {
    const store = new MemoryStore();
    const record: CapacityReservation = {
      operationId: 'crashed-op', runId: 'r-crashed', requestFingerprint: 'fingerprint-r-crashed',
      state: 'pending', receipt: null, acceptedAt: new Date(now).toISOString(), active: true,
      envelope: { cpuPercent: 5, memoryPercent: 5 },
    };
    await store.withTransaction(async (tx) => { tx.put(record); });
    const admission = new CapacityAdmission({ sampler: new FixedSampler(sample()), store, now: () => now });
    let starts = 0;
    const result = await admission.start(request('crashed-op', 'r-crashed', async () => { starts++; return { receipt: {}, processTreeExited: Promise.resolve() }; }));
    expect(result).toMatchObject({ accepted: false, uncertain: true, code: 'WORKER_ADMISSION_UNCERTAIN' });
    expect(starts).toBe(0);
  });

  it('rejects reuse of an operationId with a different fingerprint/runId', async () => {
    const store = new MemoryStore();
    const admission = new CapacityAdmission({ sampler: new FixedSampler(sample()), store, now: () => now });
    const start = async () => ({ receipt: { runId: 'r5' }, processTreeExited: deferred<void>().promise });
    await admission.start(request('same-op', 'r5', start));
    await expect(admission.start(request('same-op', 'different-run', start))).rejects.toThrow('operationId is already bound');
  });

  it('counts active reservations against the explicit host capacity envelope', async () => {
    const store = new MemoryStore();
    const admission = new CapacityAdmission({ sampler: new FixedSampler(sample(40, 40)), store, now: () => now });
    const exited = deferred<void>();
    expect(await admission.start(request('first', 'r6', async () => ({ receipt: {}, processTreeExited: exited.promise }), { envelope: { cpuPercent: 12, memoryPercent: 12 } })))
      .toMatchObject({ accepted: true });
    let starts = 0;
    const refused = await admission.start(request('second', 'r7', async () => { starts++; return { receipt: {}, processTreeExited: Promise.resolve() }; }, { envelope: { cpuPercent: 9, memoryPercent: 1 } }));
    expect(refused).toMatchObject({ accepted: false, code: 'WORKER_CAPACITY', cpuPercent: 40 });
    expect(starts).toBe(0);
    exited.resolve();
  });

  it('retains capacity when process-tree exit monitoring rejects', async () => {
    const store = new MemoryStore();
    const admission = new CapacityAdmission({ sampler: new FixedSampler(sample(50, 20)), store, now: () => now });
    const monitor = deferred<void>();
    expect(await admission.start(request('monitor-fails', 'r-monitor', async () => ({ receipt: {}, processTreeExited: monitor.promise }), {
      envelope: { cpuPercent: 5, memoryPercent: 5 },
    }))).toMatchObject({ accepted: true });
    monitor.promise.catch(() => undefined);
    monitor.reject(new Error('process monitor failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.records.get('monitor-fails')?.active).toBe(true);

    let starts = 0;
    const next = await admission.start(request('after-monitor-fails', 'r-next', async () => {
      starts++;
      return { receipt: {}, processTreeExited: Promise.resolve() };
    }, { envelope: { cpuPercent: 6, memoryPercent: 1 } }));
    expect(next).toMatchObject({ accepted: false, code: 'WORKER_CAPACITY' });
    expect(starts).toBe(0);
  });
});
