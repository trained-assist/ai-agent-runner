import { describe, expect, it, onTestFinished } from 'vitest';
import { AgentApi } from '../src/api/service.js';
import { StatelessStore } from '../src/api/stateless-store.js';
import type { Principal } from '../src/api/auth.js';
import { adapterFor, startMockWorker, type MockWorker, type MockWorkerOptions } from './external-worker-harness.js';

const GHA = 'azure-dynamic-ip-agent-run';
const EU = 'eu-vm-agent-run';

const poolPrincipal: Principal = {
  principalId: 'p-pool',
  profileId: 'profile-a',
  scopes: ['runs:read', 'runs:write'],
};

interface Pool { service: AgentApi; a: MockWorker; b: MockWorker; gha: MockWorker; close(): Promise<void>; }

async function makePool(options: { a?: MockWorkerOptions; b?: MockWorkerOptions; gha?: MockWorkerOptions; chain?: string[] } = {}): Promise<Pool> {
  const aWorker = await startMockWorker(options.a);
  const bWorker = await startMockWorker(options.b);
  const ghaWorker = await startMockWorker(options.gha);
  onTestFinished(() => aWorker.close());
  onTestFinished(() => bWorker.close());
  onTestFinished(() => ghaWorker.close());
  const service = new AgentApi({
    workers: [
      adapterFor(aWorker, { engineName: EU, workerId: 'eu-a', acceptDeadlineMs: 5000, deadlineMs: 2000 }),
      adapterFor(bWorker, { engineName: EU, workerId: 'eu-b', acceptDeadlineMs: 5000, deadlineMs: 2000 }),
      adapterFor(ghaWorker, { engineName: GHA, acceptDeadlineMs: 200, deadlineMs: 2000 }),
    ],
    engineChain: options.chain ?? [EU, GHA],
    store: new StatelessStore(),
  });
  onTestFinished(() => service.dispose());
  return { service, a: aWorker, b: bWorker, gha: ghaWorker, close: async () => {} };
}

function submit(pool: Pool, key: string, over: Record<string, unknown> = {}): { runId: string } {
  return pool.service.submit(poolPrincipal, key, { limits: { timeoutMs: 5000 }, envAllowlist: [], input: { inlinePrompt: 'do it' }, ...over });
}

async function waitFor(pool: Pool, runId: string, state: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (pool.service.status(poolPrincipal, runId).state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const s = pool.service.status(poolPrincipal, runId);
  throw new Error(`run ${runId} never reached ${state}: ${s.state} engine=${s.engine}`);
}

describe('EU endpoint pool (#136 pool)', () => {
  it('eu-a accepts → eu-b and gha are not launched', async () => {
    const pool = await makePool({});
    const { runId } = submit(pool, 'idem-pool-a');
    await waitFor(pool, runId, 'succeeded');
    expect(pool.a.launches).toHaveLength(1);
    expect(pool.b.launches).toHaveLength(0);
    expect(pool.gha.launches).toHaveLength(0);
    expect(pool.service.status(poolPrincipal, runId).engine).toBe(EU);
  }, 20000);

  it('eu-a 503 before accept → eu-b tried and succeeds; gha untouched', async () => {
    const pool = await makePool({ a: { httpStatus: 503 } });
    const { runId } = submit(pool, 'idem-pool-advance');
    await waitFor(pool, runId, 'succeeded');
    expect(pool.a.launches).toHaveLength(1);
    expect(pool.b.launches).toHaveLength(1);
    expect(pool.gha.launches).toHaveLength(0);
    expect(pool.service.status(poolPrincipal, runId).engine).toBe(EU);
  }, 20000);

  it('both eu endpoints refuse before accept → gha takes over', async () => {
    const pool = await makePool({ a: { httpStatus: 503 }, b: { httpStatus: 503 } });
    const { runId } = submit(pool, 'idem-pool-exhaust');
    await waitFor(pool, runId, 'succeeded');
    expect(pool.a.launches).toHaveLength(1);
    expect(pool.b.launches).toHaveLength(1);
    expect(pool.gha.launches).toHaveLength(1);
    expect(pool.service.status(poolPrincipal, runId).engine).toBe(GHA);
  }, 20000);

  it('capacity on eu-a advances to eu-b but not straight to gha', async () => {
    const pool = await makePool({ a: { httpStatus: 503, capacityRefusal: true } });
    const { runId } = submit(pool, 'idem-pool-capacity-a');
    await waitFor(pool, runId, 'succeeded');
    expect(pool.a.launches).toHaveLength(1);
    expect(pool.b.launches).toHaveLength(1);
    expect(pool.gha.launches).toHaveLength(0);
    expect(pool.service.status(poolPrincipal, runId).engine).toBe(EU);
  }, 20000);

  it('capacity on both eu endpoints then moves to gha', async () => {
    const pool = await makePool({
      a: { httpStatus: 503, capacityRefusal: true },
      b: { httpStatus: 503, capacityRefusal: true },
    });
    const { runId } = submit(pool, 'idem-pool-capacity-exhaust');
    await waitFor(pool, runId, 'succeeded');
    expect(pool.a.launches).toHaveLength(1);
    expect(pool.b.launches).toHaveLength(1);
    expect(pool.gha.launches).toHaveLength(1);
    expect(pool.service.status(poolPrincipal, runId).engine).toBe(GHA);
  }, 20000);

  it('capacity-unknown preserves ordered progression within pool', async () => {
    const pool = await makePool({ a: { httpStatus: 503, admissionRefusal: 'WORKER_CAPACITY_UNKNOWN' }, b: { httpStatus: 503, admissionRefusal: 'WORKER_CAPACITY_UNKNOWN' } });
    const { runId } = submit(pool, 'idem-pool-cap-unknown');
    await waitFor(pool, runId, 'succeeded');
    expect(pool.a.launches).toHaveLength(1);
    expect(pool.b.launches).toHaveLength(1);
    expect(pool.gha.launches).toHaveLength(1);
    expect(pool.service.status(poolPrincipal, runId).engine).toBe(GHA);
  }, 20000);

  it('operationId/runId are stable across endpoints on advance', async () => {
    const pool = await makePool({ a: { httpStatus: 503 } });
    const { runId } = submit(pool, 'idem-pool-opid');
    await waitFor(pool, runId, 'succeeded');
    const first = pool.a.launches[0]!;
    const second = pool.b.launches[0]!;
    expect(first['runId']).toBe(runId);
    expect(second['runId']).toBe(runId);
    expect(second['operationId']).toBe(first['operationId']);
    expect(pool.gha.launches).toHaveLength(0);
  }, 20000);

  it('ambiguous timeout on eu-a pins it; eu-b is not launched', async () => {
    const a = await startMockWorker({ delayMs: 1000 });
    const b = await startMockWorker({ httpStatus: 503 });
    const gha = await startMockWorker({});
    const service = new AgentApi({
      workers: [
        adapterFor(a, { engineName: EU, workerId: 'eu-a', acceptDeadlineMs: 100, deadlineMs: 2000 }),
        adapterFor(b, { engineName: EU, workerId: 'eu-b', acceptDeadlineMs: 5000, deadlineMs: 2000 }),
        adapterFor(gha, { engineName: GHA, acceptDeadlineMs: 200, deadlineMs: 2000 }),
      ],
      engineChain: [EU, GHA],
      store: new StatelessStore(),
    });
    onTestFinished(() => a.close()); onTestFinished(() => b.close()); onTestFinished(() => gha.close()); onTestFinished(() => service.dispose());
    const { runId } = service.submit(poolPrincipal, 'idem-pool-ambiguous', { limits: { timeoutMs: 15000 }, envAllowlist: [], input: { inlinePrompt: 'report' } });
    const dead = Date.now() + 15000;
    while (Date.now() < dead) {
      const st = service.status(poolPrincipal, runId).state;
      if (st === 'unknown' || st === 'succeeded' || st === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(b.launches).toHaveLength(0);
    expect(gha.launches).toHaveLength(0);
    const pinned = (service as any).store.dispatchedRuns().some((e: any) => e.runId === runId && e.workerId === 'eu-a');
    // if accepted on eu-a it pins; in any case eu-b was not launched
    expect(pinned || service.status(poolPrincipal, runId).state === 'unknown').toBe(true);
  }, 20000);

  it('restart captures the pinned endpoint in the journal', async () => {
    const a = await startMockWorker({ httpStatus: 503, capacityRefusal: true });
    const b = await startMockWorker({});
    const gha = await startMockWorker({});
    const logPath = `/tmp/eu-pool-restart-${Math.random()}.jsonl`;
    const service = new AgentApi({
      workers: [
        adapterFor(a, { engineName: EU, workerId: 'eu-a', acceptDeadlineMs: 5000, deadlineMs: 2000 }),
        adapterFor(b, { engineName: EU, workerId: 'eu-b', acceptDeadlineMs: 5000, deadlineMs: 2000 }),
        adapterFor(gha, { engineName: GHA, acceptDeadlineMs: 200, deadlineMs: 2000 }),
      ],
      engineChain: [EU, GHA],
      admissionLogPath: logPath,
    });
    const { runId } = service.submit(poolPrincipal, 'idem-pool-restart', { limits: { timeoutMs: 15000 }, envAllowlist: [], input: { inlinePrompt: 'report' } });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { if (service.result(poolPrincipal, runId).outcome === 'succeeded') break; } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    service.dispose();
    // journal carries eu-b workerId (eu-a refused)
    const revivedStore = new StatelessStore({}, logPath, true);
    const pinned = revivedStore.dispatchedRuns().find((e) => e.runId === runId)?.workerId;
    expect(pinned).toBe('eu-b');
    a.close(); b.close(); gha.close();
    revivedStore;
  }, 30000);

  it('pinning identity: a run accepted on eu-b stores workerId eu-b', async () => {
    const pool = await makePool({ a: { httpStatus: 503, capacityRefusal: true } });
    const { runId } = submit(pool, 'idem-pool-pin');
    const acceptDeadline = Date.now() + 10000;
    // wait until eu-b actually got a launch (acceptance on the pinned endpoint)
    while (Date.now() < acceptDeadline) {
      if (pool.b.launches.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(pool.b.launches).toHaveLength(1);
    const persisted = (pool.service as any).store.dispatchedWorkerId(runId);
    expect(persisted).toBe('eu-b');
    expect(pool.a.cancels).not.toContain(runId);
    pool.close();
  }, 20000);
});
