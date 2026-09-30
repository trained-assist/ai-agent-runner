import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, waitFor } from './helpers.js';

describe('fault injection registry (§9 / P03)', () => {
  it('spawn fault reproduces a startup failure without launching the engine', async () => {
    const h = createHarness({ scenario: 'success' });
    h.faults.inject('spawn', { kind: 'throw', once: true });
    const { receipt } = h.start();
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('failed');
    expect(result.exitReason).toBe('startup_failure');
    expect(result.failure?.code).toBe('ENGINE_STARTUP_FAILED');
    expect(h.fake.startCalls).toBe(0);
    expect(h.runner.events(receipt.runId).map((event) => event.type)).toEqual(['claimed', 'materialized', 'failed']);
  });

  it('preflight fault gives a structured refusal before the engine exists', async () => {
    const h = createHarness({ scenario: 'success' });
    h.faults.inject('preflight', { kind: 'throw', once: true, error: new Error('secret backend unavailable') });
    const { receipt } = h.start();
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('failed');
    expect(result.failure).toMatchObject({ code: 'PREFLIGHT_FAILED', failureClass: 'preflight', retryable: true });
    expect(result.failure?.safeSummary).toContain('secret backend unavailable');
    expect(h.fake.startCalls).toBe(0);
  });

  it('heartbeat partition emits connection_lost without a new run while the engine stays alive', async () => {
    const h = createHarness({ scenario: 'timeout', heartbeatIntervalMs: 30 });
    h.faults.inject('heartbeat', { kind: 'connection_lost', once: true });
    const { receipt } = h.start();
    await waitFor(() => h.runner.getRun(receipt.runId)?.connectionLost === true, 5000, 'connection_lost flag');

    const snap = h.runner.getRun(receipt.runId);
    expect(snap?.state).toBe('running');
    expect(snap?.finalized).toBe(false);
    expect(h.fake.startCalls).toBe(1);
    expect(h.runner.listRunIds()).toHaveLength(1);

    const lost = h.runner.events(receipt.runId).find((event) => event.type === 'connection_lost');
    expect(lost).toBeDefined();
    expect((lost?.payload as { engineAlive: boolean }).engineAlive).toBe(true);

    const cancel = await h.runner.cancel(receipt.runId, 1);
    expect(cancel.status).toBe('stopped');
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('cancelled');
  });

  it('log sink outage is bounded, counted and never blocks the run', async () => {
    let failures = 3;
    let sinkCalls = 0;
    const h = createHarness({
      scenario: 'success',
      logSink: (path, line) => {
        sinkCalls += 1;
        if (failures > 0) {
          failures -= 1;
          throw new Error('log sink down');
        }
        appendFileSync(path, line, 'utf8');
      },
    });
    const { receipt } = h.start();
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('succeeded');
    expect(h.runner.health().droppedLogCount).toBe(3);
    expect(sinkCalls).toBeGreaterThan(3);
    const logPath = join(h.rootDir, 'runs', receipt.runId, 'events.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(h.runner.events(receipt.runId).length);
  });

  it('export failure keeps the outcome and the retry is idempotent', async () => {
    const h = createHarness({ scenario: 'success' });
    h.faults.inject('finalization', { kind: 'throw', once: true });
    const { receipt } = h.start();
    await waitFor(
      () => h.runner.getRun(receipt.runId)?.state === 'finalizing' && h.runner.getRun(receipt.runId)?.finalized === false,
      5000,
      'finalizing after a failed export',
    );

    const stuck = h.runner.getRun(receipt.runId);
    expect(stuck?.exit).toMatchObject({ code: 0, observed: true });
    expect(stuck?.result).toBeNull();

    const result = await h.runner.finalize(receipt.runId);
    expect(result.outcome).toBe('succeeded');

    const again = await h.runner.finalize(receipt.runId);
    expect(again).toBe(result);
    expect(h.runner.getRun(receipt.runId)?.state).toBe('succeeded');
    expect(h.runner.events(receipt.runId).filter((event) => event.type === 'succeeded')).toHaveLength(1);
    expect(existsSync(join(h.rootDir, 'runs', receipt.runId, 'result.json'))).toBe(true);
    expect(h.fake.startCalls).toBe(1);
  });

  it('recovery fault surfaces without mutating run records', async () => {
    const h = createHarness({ scenario: 'timeout' });
    const { receipt } = h.start();
    await waitFor(() => h.runner.getRun(receipt.runId)?.state === 'running', 5000, 'run to be running');

    h.faults.inject('recovery', { kind: 'throw', once: true });
    await expect(h.runner.recover()).rejects.toThrow(/fault injected/);
    const snap = h.runner.getRun(receipt.runId);
    expect(snap?.state).toBe('running');
    expect(snap?.finalized).toBe(false);

    h.reopen();
    const report = await h.runner.recover();
    expect(report.orphaned).toBe(1);
    const cancel = await h.runner.cancel(receipt.runId, 1);
    expect(cancel.status).toBe('stopped');
    await h.runner.waitFor(receipt.runId);
  });
});
