import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isProcessAlive, isProcessGroupAlive } from '../src/adapters/engine/process-tree.js';
import type { EngineAdapter, EngineHandle } from '../src/adapters/engine/engine-adapter.js';
import type { PersistedRunState } from '../src/runner/run-store.js';
import { createHarness, waitFor } from './helpers.js';

describe('worker restart recovery', () => {
  it('resumes an already-budgeted safe retry after restart without consuming the retry twice', async () => {
    const h = createHarness();
    h.faults.inject('preflight', { kind: 'custom', once: true, fn: () => new Promise<void>(() => {}) });
    const { receipt } = h.start({ limits: { timeoutMs: 5_000, maxOutputBytes: 100_000, maxLogBytes: 100_000 } });
    await waitFor(() => h.runner.getRun(receipt.runId)?.startPhase === 'preflight', 2_000, 'preflight start phase');

    // Emulate a VM stopping after the retry decision was persisted, but before
    // the next attempt got as far as preflight. attempt #2 is already reserved.
    const statePath = join(h.rootDir, 'runs', receipt.runId, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as PersistedRunState;
    state.state = 'queued';
    state.startPhase = 'queued';
    state.startAttempts = 2;
    state.cancelRequested = 'timeout';
    state.pid = null;
    state.pgid = null;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    const recovered = h.reopen();
    const report = await recovered.recover();
    expect(report.resumedQueued).toBe(1);
    const result = await recovered.waitFor(receipt.runId, 2_000);
    expect(result.outcome).toBe('succeeded');
    expect(recovered.getRun(receipt.runId)?.startAttempts).toBe(2);
    expect(h.fake.startCalls).toBe(1);
  });

  it('does not resume a queued run whose durable state contains user cancellation', async () => {
    const h = createHarness();
    h.faults.inject('preflight', { kind: 'custom', fn: () => new Promise<void>(() => {}) });
    const { receipt } = h.start({ limits: { timeoutMs: 5_000, maxOutputBytes: 100_000, maxLogBytes: 100_000 } });
    await waitFor(() => h.runner.getRun(receipt.runId)?.startPhase === 'preflight', 2_000, 'preflight start phase');

    const statePath = join(h.rootDir, 'runs', receipt.runId, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as PersistedRunState;
    state.state = 'queued';
    state.startPhase = 'queued';
    state.cancelRequested = 'cancel';
    state.pid = null;
    state.pgid = null;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    const recovered = h.reopen();
    await recovered.recover();
    const result = await recovered.waitFor(receipt.runId, 2_000);
    expect(result.outcome).toBe('cancelled');
    expect(h.fake.startCalls).toBe(0);
  });

  it('retries proven pre-spawn worker crashes twice, then stops at the configured attempt limit', async () => {
    const h = createHarness();
    h.faults.inject('preflight', { kind: 'custom', count: 3, fn: () => new Promise<void>(() => {}) });
    const { receipt } = h.start();

    for (const expectedAttempt of [1, 2, 3]) {
      await waitFor(() => h.runner.getRun(receipt.runId)?.startAttempts === expectedAttempt
        && h.runner.getRun(receipt.runId)?.startPhase === 'preflight', 2_000, `preflight attempt ${expectedAttempt}`);
      h.reopen();
      await h.runner.recover();
    }

    await waitFor(() => h.runner.getRun(receipt.runId)?.state === 'failed', 1_000, 'retry budget exhaustion');
    const snapshot = h.runner.getRun(receipt.runId)!;
    expect(snapshot.startAttempts).toBe(3); // initial start + two retries
    expect(snapshot.result?.engineStart).toBe('not_started');
    expect(snapshot.result?.failure).toMatchObject({ code: 'WORKER_CRASH_BEFORE_ENGINE_START', retryable: false });
    expect(h.fake.startCalls).toBe(0);
  });

  it('does not automatically retry after the durable spawn boundary is crossed', async () => {
    const engine: EngineAdapter = { name: 'fake', async start() { return new Promise<EngineHandle>(() => {}); } };
    const h = createHarness({ adapters: { fake: engine } });
    const { receipt } = h.start();
    await waitFor(() => h.runner.getRun(receipt.runId)?.startPhase === 'spawn', 2_000, 'spawn phase');

    h.reopen();
    await h.runner.recover();
    const snapshot = h.runner.getRun(receipt.runId)!;
    expect(snapshot.state).toBe('failed');
    expect(snapshot.startAttempts).toBe(1);
    expect(snapshot.result?.engineStart).toBe('unknown');
    expect(snapshot.result?.failure?.code).toBe('WORKER_CRASH_DURING_ENGINE_START');
    expect(h.fake.startCalls).toBe(0);
  });

  it('orphaned engine: record survives, connection_lost is recorded, no hidden rerun', async () => {
    const h = createHarness({ scenario: 'timeout' });
    const spec = h.makeSpec();
    const receipt = h.runner.start(spec);
    await waitFor(() => h.runner.getRun(receipt.runId)?.state === 'running', 5000, 'run to be running');
    const pidBefore = h.runner.getRun(receipt.runId)?.pid ?? null;
    expect(isProcessAlive(pidBefore)).toBe(true);

    h.reopen();
    const report = await h.runner.recover();
    expect(report.orphaned).toBe(1);
    expect(report.lost).toBe(0);

    const snap = h.runner.getRun(receipt.runId);
    expect(snap?.state).toBe('running');
    expect(snap?.connectionLost).toBe(true);
    expect(snap?.orphanedPid).toBe(pidBefore);
    expect(snap?.finalized).toBe(false);
    const types = h.runner.events(receipt.runId).map((event) => event.type);
    expect(types).toContain('connection_lost');
    expect(types).not.toContain('failed');
    expect(h.fake.startCalls).toBe(1);

    const cancel = await h.runner.cancel(receipt.runId, spec.ownerGeneration);
    expect(cancel.status).toBe('stopped');
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('cancelled');
    expect(result.exitObserved).toBe(false);
    expect(isProcessAlive(pidBefore)).toBe(false);
    expect(isProcessGroupAlive(snap?.pgid ?? null)).toBe(false);
  });

  it('engine dead after worker crash: execution is recorded as lost, never rerun', async () => {
    const h = createHarness({ scenario: 'timeout' });
    const spec = h.makeSpec();
    const receipt = h.runner.start(spec);
    await waitFor(() => h.runner.getRun(receipt.runId)?.state === 'running', 5000, 'run to be running');
    const pid = h.runner.getRun(receipt.runId)?.pid ?? null;

    h.reopen();
    process.kill(pid as number, 'SIGKILL');
    await waitFor(() => !isProcessAlive(pid), 3000, 'engine to die');

    const report = await h.runner.recover();
    expect(report.lost).toBe(1);

    const snap = h.runner.getRun(receipt.runId);
    expect(snap?.state).toBe('failed');
    expect(snap?.result).toMatchObject({ outcome: 'failed', exitReason: 'worker_crash', exitObserved: false });
    expect(snap?.result?.failure).toMatchObject({ code: 'WORKER_CRASH', retryable: true });
    expect(h.fake.startCalls).toBe(1);
    expect(h.runner.listRunIds()).toHaveLength(1);

    const result = await h.runner.waitFor(receipt.runId);
    expect(result.exitReason).toBe('worker_crash');
    const stored = JSON.parse(readFileSync(join(h.rootDir, 'runs', receipt.runId, 'result.json'), 'utf8')) as { exitReason: string };
    expect(stored.exitReason).toBe('worker_crash');
  });

  it('crash during finalization: recover resumes finalize without restarting the engine', async () => {
    const h = createHarness({ scenario: 'success' });
    h.faults.inject('finalization', { kind: 'throw', once: true });
    const { receipt } = h.start();
    await waitFor(
      () => h.runner.getRun(receipt.runId)?.state === 'finalizing' && h.runner.getRun(receipt.runId)?.finalized === false,
      5000,
      'run to be stuck in finalizing',
    );
    const snapBefore = h.runner.getRun(receipt.runId);
    expect(snapBefore?.exit).toMatchObject({ code: 0, observed: true });

    h.reopen();
    const report = await h.runner.recover();
    expect(report.finalizingResumed).toBe(1);
    expect(report.lost).toBe(0);

    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('succeeded');
    expect(result.exitReason).toBe('completed');
    expect(h.fake.startCalls).toBe(1);

    const again = await h.runner.finalize(receipt.runId);
    expect(again).toBe(result);
    const succeededEvents = h.runner.events(receipt.runId).filter((event) => event.type === 'succeeded');
    expect(succeededEvents).toHaveLength(1);
    expect(h.runner.getRun(receipt.runId)?.state).toBe('succeeded');
  });

  it('queued receipt survives a worker crash and is resumed exactly once', async () => {
    const h = createHarness({ scenario: 'success' });
    const spec = h.makeSpec();
    const receipt = h.runner.start(spec);
    expect(receipt.state).toBe('queued');

    h.runner.dispose();
    expect(h.runner.getRun(receipt.runId)?.state).toBe('queued');

    const runner = h.reopen();
    expect(runner.getRun(receipt.runId)?.state).toBe('queued');
    expect(h.fake.startCalls).toBe(0);

    const duplicate = runner.start(spec, spec.operationId);
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.runId).toBe(receipt.runId);
    expect(h.fake.startCalls).toBe(0);

    const report = await runner.recover();
    expect(report.resumedQueued).toBe(1);
    const result = await runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('succeeded');
    expect(h.fake.startCalls).toBe(1);
    expect(runner.listRunIds()).toHaveLength(1);
  });
});
