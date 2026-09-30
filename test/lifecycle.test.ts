import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRunResult } from '../src/contracts/result.js';
import { createHarness, isProcessAlive, waitFor } from './helpers.js';

function readLogLines(rootDir: string, runId: string): Array<Record<string, unknown>> {
  const path = join(rootDir, 'runs', runId, 'events.jsonl');
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('runner lifecycle', () => {
  it('success: full state path, scoped JSONL log, structured result', async () => {
    const h = createHarness({ scenario: 'success' });
    process.env['AIR_TEST_ALLOWED'] = 'yes';
    process.env['AIR_TEST_FORBIDDEN'] = 'no';
    const { receipt, spec } = h.start({ envAllowlist: ['AIR_TEST_ALLOWED'] });
    expect(receipt.deduplicated).toBe(false);

    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('succeeded');
    expect(result.exitReason).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.exitObserved).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.usage).toEqual({ status: 'unknown' });
    expect(result.logPath).toBe(`runs/${receipt.runId}/events.jsonl`);

    const snap = h.runner.getRun(receipt.runId);
    expect(snap?.state).toBe('succeeded');
    expect(snap?.finalized).toBe(true);
    expect(snap?.result).toEqual(result);

    const events = h.runner.events(receipt.runId);
    expect(events.map((event) => event.type)).toEqual([
      'claimed',
      'materialized',
      'started',
      'log',
      'log',
      'exit',
      'finalizing',
      'succeeded',
    ]);

    const lines = readLogLines(h.rootDir, receipt.runId);
    expect(lines).toHaveLength(events.length);
    lines.forEach((line, index) => {
      expect(line['schemaVersion']).toBe(1);
      expect(line['runId']).toBe(receipt.runId);
      expect(line['jobId']).toBe(spec.jobId);
      expect(line['userTaskId']).toBe(spec.userTaskId);
      expect(line['profileId']).toBe(spec.profileId);
      expect(line['ownerGeneration']).toBe(1);
      expect(line['sequence']).toBe(index + 1);
      expect(String(line['timestamp'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    const envLine = lines.find((line) => line['type'] === 'log' && String((line['payload'] as Record<string, unknown>)['message']).startsWith('envkeys:'));
    expect(envLine).toBeDefined();
    const envKeys = String((envLine?.['payload'] as Record<string, unknown>)['message']);
    expect(envKeys).toContain('AIR_TEST_ALLOWED');
    expect(envKeys).not.toContain('AIR_TEST_FORBIDDEN');
    expect(envKeys).not.toContain('PATH');
    delete process.env['AIR_TEST_FORBIDDEN'];

    expect(existsSync(join(spec.cwd, 'ran.txt'))).toBe(true);

    const stored = JSON.parse(readFileSync(join(h.rootDir, 'runs', receipt.runId, 'result.json'), 'utf8')) as unknown;
    expect(validateRunResult(stored).ok).toBe(true);
  });

  it('two runs keep separate workspaces and separate log files', async () => {
    const h = createHarness({ scenario: 'success' });
    const first = h.start();
    const second = h.start();
    await h.runner.waitFor(first.receipt.runId);
    await h.runner.waitFor(second.receipt.runId);

    expect(first.spec.cwd).not.toBe(second.spec.cwd);
    expect(existsSync(join(first.spec.cwd, 'ran.txt'))).toBe(true);
    expect(existsSync(join(second.spec.cwd, 'ran.txt'))).toBe(true);
    expect(existsSync(join(h.rootDir, 'runs', first.receipt.runId, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(h.rootDir, 'runs', second.receipt.runId, 'events.jsonl'))).toBe(true);

    const firstLog = readFileSync(join(h.rootDir, 'runs', first.receipt.runId, 'events.jsonl'), 'utf8');
    expect(firstLog).not.toContain(second.receipt.runId);
  });

  it('nonzero exit becomes a structured failed outcome', async () => {
    const h = createHarness({ scenario: 'nonzero-exit' });
    const { receipt } = h.start();
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('failed');
    expect(result.exitReason).toBe('nonzero_exit');
    expect(result.exitCode).toBe(3);
    expect(result.failure).toMatchObject({ code: 'ENGINE_NONZERO_EXIT', failureClass: 'engine', retryable: false });
    expect(h.runner.getRun(receipt.runId)?.state).toBe('failed');
  });

  it('startup failure never reaches started and is typed', async () => {
    const h = createHarness({ scenario: 'startup-failure' });
    const { receipt } = h.start();
    const result = await h.runner.waitFor(receipt.runId);
    expect(h.fake.startCalls).toBe(1);
    expect(result.outcome).toBe('failed');
    expect(result.exitReason).toBe('startup_failure');
    expect(result.failure).toMatchObject({ code: 'ENGINE_STARTUP_FAILED', failureClass: 'engine', retryable: true });
    expect(result.exitObserved).toBe(false);
    expect(h.runner.getRun(receipt.runId)?.pid).toBeNull();
    const types = h.runner.events(receipt.runId).map((event) => event.type);
    expect(types).toEqual(['claimed', 'materialized', 'failed']);
    expect(types).not.toContain('started');
    expect(types).not.toContain('exit');
  });

  it('timeout kills the engine tree and records TIMEOUT', async () => {
    const h = createHarness({ scenario: 'timeout' });
    const { receipt } = h.start({ limits: { timeoutMs: 400 } });
    const startedAt = Date.now();
    const result = await h.runner.waitFor(receipt.runId);
    expect(Date.now() - startedAt).toBeLessThan(6000);
    expect(result.outcome).toBe('failed');
    expect(result.exitReason).toBe('timeout');
    expect(result.failure).toMatchObject({ code: 'TIMEOUT', retryable: true });
    const snap = h.runner.getRun(receipt.runId);
    expect(snap?.state).toBe('failed');
    const { isProcessGroupAlive } = await import('../src/adapters/engine/process-tree.js');
    expect(isProcessGroupAlive(snap?.pgid ?? null)).toBe(false);
  });

  it('crash is distinguished from nonzero exit', async () => {
    const h = createHarness({ scenario: 'crash' });
    const { receipt } = h.start();
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('failed');
    expect(result.exitReason).toBe('crash');
    expect(result.exitSignal).toBe('SIGKILL');
    expect(result.failure?.code).toBe('ENGINE_CRASH');
  });

  it('cancel stops the engine and its children; repeated cancel is safe', async () => {
    const h = createHarness({ scenario: 'cancel-with-children' });
    const { receipt } = h.start();
    await waitFor(() => h.runner.getRun(receipt.runId)?.state === 'running', 5000, 'run to be running');
    await waitFor(
      () => h.runner.events(receipt.runId).some((event) => event.type === 'log' && String((event.payload as { message: string }).message).startsWith('grandchild:')),
      5000,
      'grandchild log line',
    );
    const grandchildLine = h.runner
      .events(receipt.runId)
      .find((event) => event.type === 'log' && String((event.payload as { message: string }).message).startsWith('grandchild:'));
    const grandchildPid = Number(String((grandchildLine?.payload as { message: string }).message).split(':')[1]);
    const snapBefore = h.runner.getRun(receipt.runId);
    expect(isProcessAlive(grandchildPid)).toBe(true);

    const first = await h.runner.cancel(receipt.runId, 1);
    expect(first.status).toBe('stopped');
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('cancelled');
    expect(result.exitReason).toBe('cancelled');
    const second = await h.runner.cancel(receipt.runId, 1);
    expect(second.status).toBe('already_terminal');
    expect(h.runner.getRun(receipt.runId)?.state).toBe('cancelled');
    expect(isProcessAlive(grandchildPid)).toBe(false);
    const { isProcessGroupAlive } = await import('../src/adapters/engine/process-tree.js');
    expect(isProcessGroupAlive(snapBefore?.pgid ?? null)).toBe(false);
    expect(result.cleanup).toBe('completed');
  });
});
