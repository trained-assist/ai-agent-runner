import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobStore } from '../src/storage/blob-store.js';
import { createBlobStore } from '../src/storage/create-blob-store.js';
import { isNotFound } from '../src/storage/errors.js';
import { isTerminalState } from '../src/runner/state-machine.js';
import { createHarness, sleep, waitFor } from './helpers.js';

function localBlob(): { blob: BlobStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'profile-trace-'));
  return { blob: createBlobStore({ backend: 'local-fs', localRoot: join(root, 'blobs') }), root };
}

async function readTrace(blob: BlobStore, profileId: string): Promise<Record<string, unknown>[]> {
  let raw = '';
  try {
    raw = (await blob.get(`profiles/${profileId}/trace.jsonl`)).toString('utf8');
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function runToTerminal(harness: ReturnType<typeof createHarness>, over: Parameters<typeof harness.makeSpec>[0] = {}) {
  const { receipt } = harness.start(over);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snap = harness.runner.getRun(receipt.runId);
    if (snap && isTerminalState(snap.state)) return receipt.runId;
    await sleep(20);
  }
  throw new Error(`run ${receipt.runId} did not become terminal`);
}

describe('profile trace (issue #23, эпик ai-agent-run-api#1 Ф2.3 / кейс E1)', () => {
  it('дописывает по одной строке на каждый законченный ран, в порядке завершения', async () => {
    const { blob } = localBlob();
    const harness = createHarness({ blob });
    const runIds: string[] = [];
    for (let i = 0; i < 5; i += 1) runIds.push(await runToTerminal(harness));

    const lines = await readTrace(blob, 'profile-a');
    expect(lines).toHaveLength(5);
    expect(lines.map((line) => line.runId)).toEqual(runIds);
    for (const line of lines) {
      expect(line.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(line.profileId).toBe('profile-a');
      expect(line.outcome).toBe('succeeded');
      expect(line.exitReason).toBe('completed');
      expect(line.failureCode).toBeNull();
      expect(typeof line.userTaskId).toBe('string');
    }
  });

  it('у неуспешного рана в следе outcome=failed и код ошибки', async () => {
    const { blob } = localBlob();
    const harness = createHarness({ blob, scenario: 'nonzero-exit' });
    const runId = await runToTerminal(harness);
    const lines = await readTrace(blob, 'profile-a');
    expect(lines).toHaveLength(1);
    const [line] = lines;
    if (!line) throw new Error('trace line missing');
    expect(line.runId).toBe(runId);
    expect(line.outcome).toBe('failed');
    expect(line.exitReason).toBe('nonzero_exit');
    expect(typeof line.failureCode).toBe('string');
  });

  it('след переживает рестарт раннера и дописывается дальше', async () => {
    const { blob } = localBlob();
    const harness = createHarness({ blob });
    const first = await runToTerminal(harness);
    harness.reopen();
    const second = await runToTerminal(harness);

    const lines = await readTrace(blob, 'profile-a');
    expect(lines.map((line) => line.runId)).toEqual([first, second]);
  });

  it('без blob: следов нет, сами раны не страдают', async () => {
    const harness = createHarness();
    const runId = await runToTerminal(harness);
    expect(harness.runner.getRun(runId)?.state).toBe('succeeded');
  });

  // Приёмка M1.3 (arch-репо #109): финализация после restart пишет след ровно один раз.
  it('сбой финализации + recover: ровно одна строка следа и один succeeded-триггер (M1.3)', async () => {
    const { blob } = localBlob();
    const harness = createHarness({ blob });
    harness.faults.inject('finalization', { kind: 'throw', once: true });
    const { receipt } = harness.start();

    await waitFor(
      () => {
        const snap = harness.runner.getRun(receipt.runId);
        return snap?.state === 'finalizing' && snap.finalized === false;
      },
      5000,
      'run to be stuck in finalizing',
    );
    // fault сработал ДО appendProfileTrace — след ещё не записан
    expect(await readTrace(blob, 'profile-a')).toHaveLength(0);

    harness.reopen();
    const report = await harness.runner.recover();
    expect(report.finalizingResumed).toBe(1);

    const result = await harness.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('succeeded');

    const lines = await readTrace(blob, 'profile-a');
    expect(lines.filter((line) => line.runId === receipt.runId)).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: 'succeeded', exitReason: 'completed' });

    const succeeded = harness.runner.events(receipt.runId).filter((event) => event.type === 'succeeded');
    expect(succeeded).toHaveLength(1);
    expect(harness.runner.getRun(receipt.runId)?.state).toBe('succeeded');
  });

  it('сбой записи следа не валит ран и виден warn-событием в журнале', async () => {
    const broken: BlobStore = {
      backend: 'local-fs',
      put: async () => {
        throw new Error('storage down');
      },
      get: async () => {
        throw new Error('storage down');
      },
      head: async () => {
        throw new Error('storage down');
      },
    };
    const harness = createHarness({ blob: broken });
    const runId = await runToTerminal(harness);
    const snap = harness.runner.getRun(runId);
    expect(snap?.state).toBe('succeeded');

    const events = harness.runner.events(runId, 0);
    const warn = events.find((event) => event.type === 'log' && event.payload.level === 'warn');
    expect(warn).toBeDefined();
    expect((warn as { payload: { message: string } }).payload.message).toContain('profile trace append failed');
  });
});
