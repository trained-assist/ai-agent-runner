import { readFile } from 'node:fs/promises';

export interface HostUsageSample {
  cpuPercent: number;
  memoryPercent: number;
  sampledAt: string;
}

export interface HostUsageSampler {
  sample(): Promise<HostUsageSample>;
}

export interface CapacityReservation {
  operationId: string;
  runId: string;
  requestFingerprint: string;
  state: 'pending' | 'accepted' | 'uncertain';
  receipt: unknown;
  acceptedAt: string;
  active: boolean;
  envelope: CapacityEnvelope;
}

/** Conservative percentage points reserved from the host's total CPU/RAM capacity. */
export interface CapacityEnvelope { cpuPercent: number; memoryPercent: number }

/** The implementation must provide a host-wide, cross-process serializable transaction. */
export interface CapacityReservationTransaction {
  get(operationId: string): CapacityReservation | undefined;
  list(): CapacityReservation[];
  put(reservation: CapacityReservation): void;
  release(operationId: string): void;
}

export interface CapacityReservationStore {
  withTransaction<T>(fn: (tx: CapacityReservationTransaction) => Promise<T>): Promise<T>;
}

export interface CapacityAdmissionOptions {
  sampler: HostUsageSampler;
  store: CapacityReservationStore;
  thresholdPercent?: number;
  maxSampleAgeMs?: number;
  now?: () => number;
}

export interface AcceptedReservation<T> {
  accepted: true;
  duplicate: boolean;
  receipt: T;
  sample?: HostUsageSample;
}

export interface UncertainReservation {
  accepted: false;
  uncertain: true;
  code: 'WORKER_ADMISSION_UNCERTAIN';
  operationId: string;
  runId: string;
}

export interface CapacityRefusal {
  accepted: false;
  httpStatus: 503;
  code: 'WORKER_CAPACITY' | 'WORKER_CAPACITY_UNKNOWN' | 'WORKER_ADMISSION_UNAVAILABLE';
  cpuPercent?: number;
  memoryPercent?: number;
  sampledAt?: string;
}

export type AdmissionResult<T> = AcceptedReservation<T> | CapacityRefusal | UncertainReservation;

export interface StartReservation<T> {
  receipt: T;
  /** Resolves only after the entire engine process tree has exited. */
  processTreeExited: Promise<unknown>;
}

/**
 * Capacity admission primitive for VM worker implementations. Store transaction must
 * serialize all worker processes on the host and durably commit reservations.
 */
export class CapacityAdmission {
  private readonly sampler: HostUsageSampler;
  private readonly store: CapacityReservationStore;
  private readonly threshold: number;
  private readonly maxSampleAgeMs: number;
  private readonly now: () => number;

  constructor(options: CapacityAdmissionOptions) {
    this.sampler = options.sampler;
    this.store = options.store;
    this.threshold = options.thresholdPercent ?? 60;
    this.maxSampleAgeMs = options.maxSampleAgeMs ?? 5_000;
    this.now = options.now ?? Date.now;
    if (!(this.threshold > 0 && this.threshold <= 100)) throw new Error('thresholdPercent must be in (0, 100]');
  }

  async start<T>(input: {
    operationId: string;
    runId: string;
    engineName: string;
    requestFingerprint: string;
    envelope: CapacityEnvelope;
    start: () => Promise<StartReservation<T>>;
  }): Promise<AdmissionResult<T>> {
    if (input.engineName !== 'opencode') throw new Error('VM worker policy permits only the opencode engine');
    if (!input.operationId || !input.runId || !input.requestFingerprint) throw new Error('operationId, runId, and requestFingerprint are required');
    if (!validEnvelope(input.envelope)) throw new Error('a valid per-run CPU and memory envelope is required');
    // Callers may retain and mutate their input object while sampling awaits. Keep
    // admission math and the durable reservation bound to the envelope validated here.
    const envelope = Object.freeze({ ...input.envelope });
    let admission: { kind: 'existing'; record: CapacityReservation } | { kind: 'refused'; result: CapacityRefusal } | { kind: 'reserved'; sample: HostUsageSample };
    try {
      admission = await this.store.withTransaction(async (tx) => {
        const previous = tx.get(input.operationId);
        if (previous) {
          if (previous.requestFingerprint !== input.requestFingerprint || previous.runId !== input.runId) {
            throw new OperationIdConflictError('operationId is already bound to a different run request');
          }
          return { kind: 'existing', record: previous };
        }

        let sample: HostUsageSample;
        try {
          sample = await this.sampler.sample();
        } catch {
          return { kind: 'refused', result: { accepted: false, httpStatus: 503, code: 'WORKER_CAPACITY_UNKNOWN' } };
        }
        const age = this.now() - Date.parse(sample.sampledAt);
        const valid = Number.isFinite(sample.cpuPercent) && Number.isFinite(sample.memoryPercent)
          && sample.cpuPercent >= 0 && sample.cpuPercent <= 100
          && sample.memoryPercent >= 0 && sample.memoryPercent <= 100
          && Number.isFinite(age) && age >= 0 && age <= this.maxSampleAgeMs;
        if (!valid) {
          return { kind: 'refused', result: { accepted: false, httpStatus: 503, code: 'WORKER_CAPACITY_UNKNOWN' } };
        }
        if (sample.cpuPercent >= this.threshold || sample.memoryPercent >= this.threshold) {
          return { kind: 'refused', result: {
            accepted: false, httpStatus: 503, code: 'WORKER_CAPACITY',
            ...(Number.isFinite(sample.cpuPercent) ? { cpuPercent: sample.cpuPercent } : {}),
            ...(Number.isFinite(sample.memoryPercent) ? { memoryPercent: sample.memoryPercent } : {}),
            ...(Number.isFinite(Date.parse(sample.sampledAt)) ? { sampledAt: sample.sampledAt } : {}),
          } };
        }
        const active = [...this.activeReservations(tx)];
        const projectedCpu = sample.cpuPercent + active.reduce((sum, item) => sum + item.envelope.cpuPercent, envelope.cpuPercent);
        const projectedMemory = sample.memoryPercent + active.reduce((sum, item) => sum + item.envelope.memoryPercent, envelope.memoryPercent);
        if (projectedCpu >= this.threshold || projectedMemory >= this.threshold) {
          return { kind: 'refused', result: {
            accepted: false, httpStatus: 503, code: 'WORKER_CAPACITY',
            cpuPercent: sample.cpuPercent, memoryPercent: sample.memoryPercent, sampledAt: sample.sampledAt,
          } };
        }
        // Commit a durable pending tombstone before any start-side effect. A crash or
        // exception after this point is uncertain and must be reconciled, never retried.
        tx.put({
          operationId: input.operationId, runId: input.runId,
          requestFingerprint: input.requestFingerprint, state: 'pending', receipt: null,
          acceptedAt: new Date(this.now()).toISOString(), active: true, envelope,
        });
        return { kind: 'reserved', sample };
      });
    } catch (error) {
      if (error instanceof OperationIdConflictError) throw error;
      // This transaction finishes before invoking start(), so failure here proves that
      // this invocation did not create a process. Generic store errors are fail-closed.
      return { accepted: false, httpStatus: 503, code: 'WORKER_ADMISSION_UNAVAILABLE' };
    }

    if (admission.kind === 'refused') return admission.result;
    if (admission.kind === 'existing') {
      const previous = admission.record;
      if (previous.state !== 'accepted') return { accepted: false, uncertain: true, code: 'WORKER_ADMISSION_UNCERTAIN', operationId: input.operationId, runId: input.runId };
      return { accepted: true, duplicate: true, receipt: previous.receipt as T };
    }

    let started: StartReservation<T>;
    try {
      started = await input.start();
    } catch {
      // Keep the durable pending reservation. The callback may have spawned before failing.
      void this.store.withTransaction(async (tx) => {
        const current = tx.get(input.operationId);
        if (current) tx.put({ ...current, state: 'uncertain' });
      }).catch(() => undefined);
      return { accepted: false, uncertain: true, code: 'WORKER_ADMISSION_UNCERTAIN', operationId: input.operationId, runId: input.runId };
    }

    try {
      await this.store.withTransaction(async (tx) => {
        const current = tx.get(input.operationId);
        if (!current || current.requestFingerprint !== input.requestFingerprint) throw new Error('pending admission record disappeared or changed');
        tx.put({ ...current, state: 'accepted', receipt: started.receipt });
      });
    } catch {
      void this.store.withTransaction(async (tx) => {
        const current = tx.get(input.operationId);
        if (current) tx.put({ ...current, state: 'uncertain' });
      }).catch(() => undefined);
      // A rejected liveness monitor does not prove the process tree has exited.
      // Keep the reservation active until an external reconciler confirms it.
      // A failed durable release must remain fail-closed, but the detached monitor
      // callback must not become an unhandled rejection in the worker process.
      void started.processTreeExited.then(() => this.release(input.operationId), () => undefined).catch(() => undefined);
      return { accepted: false, uncertain: true, code: 'WORKER_ADMISSION_UNCERTAIN', operationId: input.operationId, runId: input.runId };
    }
    // Release only on confirmed exit. A rejected monitor is ambiguous and must
    // retain capacity rather than silently allowing another worker run.
    void started.processTreeExited.then(() => this.release(input.operationId), () => undefined).catch(() => undefined);
    return { accepted: true, duplicate: false, receipt: started.receipt, sample: admission.sample };
  }

  private activeReservations(tx: CapacityReservationTransaction): CapacityReservation[] {
    return tx.list().filter((record) => record.active);
  }

  private async release(operationId: string): Promise<void> {
    await this.store.withTransaction(async (tx) => { tx.release(operationId); });
  }
}

export class OperationIdConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'OperationIdConflictError'; }
}

function validEnvelope(envelope: CapacityEnvelope): boolean {
  return Number.isFinite(envelope.cpuPercent) && envelope.cpuPercent > 0 && envelope.cpuPercent <= 100
    && Number.isFinite(envelope.memoryPercent) && envelope.memoryPercent > 0 && envelope.memoryPercent <= 100;
}

/** Whole-host Linux sampler; memory includes unrelated host services by design. */
export class LinuxHostUsageSampler implements HostUsageSampler {
  constructor(private readonly sampleIntervalMs = 100) {
    if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 1) throw new Error('sampleIntervalMs must be positive');
  }

  async sample(): Promise<HostUsageSample> {
    const first = parseCpu(await readFile('/proc/stat', 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, this.sampleIntervalMs));
    const [secondText, memText] = await Promise.all([readFile('/proc/stat', 'utf8'), readFile('/proc/meminfo', 'utf8')]);
    const second = parseCpu(secondText);
    const totalDelta = second.total - first.total;
    const idleDelta = second.idle - first.idle;
    if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) throw new Error('invalid /proc/stat CPU sample');
    const mem = new Map([...memText.matchAll(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/gm)].map((m) => [m[1]!, Number(m[2])]));
    const totalKb = mem.get('MemTotal');
    const availableKb = mem.get('MemAvailable');
    if (!totalKb || availableKb === undefined || availableKb < 0 || availableKb > totalKb) throw new Error('invalid /proc/meminfo');
    return {
      cpuPercent: ((totalDelta - idleDelta) / totalDelta) * 100,
      memoryPercent: ((totalKb - availableKb) / totalKb) * 100,
      sampledAt: new Date().toISOString(),
    };
  }
}

function parseCpu(text: string): { total: number; idle: number } {
  const line = text.split('\n').find((item) => item.startsWith('cpu '));
  if (!line) throw new Error('missing aggregate CPU counters');
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('invalid aggregate CPU counters');
  return { total: values.reduce((sum, value) => sum + value, 0), idle: values[3]! + (values[4] ?? 0) };
}
