import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { onTestFinished, describe, expect, it } from 'vitest';
import type { Principal } from '../src/api/auth.js';
import { AgentApi } from '../src/api/service.js';
import { validateRunnerEvent } from '../src/contracts/events.js';
import { adapterFor, startMockWorker } from './external-worker-harness.js';
import { createHarness, waitFor } from './helpers.js';

/**
 * I10: traceId из RunSpec доходит до конверта RunnerEvent, JSONL-журнала и записей ApiLogger,
 * а отсутствие traceId не ломает ни журнал, ни лог процесса.
 */

const alpha: Principal = {
  principalId: 'p-alpha',
  profileId: 'profile-a',
  scopes: ['runs:read', 'runs:write'],
  engines: ['azure-dynamic-ip-agent-run'],
};

function submitBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: { name: 'azure-dynamic-ip-agent-run', adapterVersion: '1' },
    limits: { timeoutMs: 15000 },
    envAllowlist: [],
    input: { inlinePrompt: 'hello agent' },
    ...over,
  };
}

function journalEntries(rootDir: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(join(rootDir, 'runs', runId, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('traceId в конверте RunnerEvent', () => {
  it('каждое событие рана несёт traceId из RunSpec', async () => {
    const h = createHarness({ scenario: 'success' });
    const { receipt } = h.start({ traceId: 'trace-runner-1' });
    await h.runner.waitFor(receipt.runId);

    const events = h.runner.events(receipt.runId);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.traceId).toBe('trace-runner-1');
      expect(validateRunnerEvent(event).ok).toBe(true);
    }
  });

  it('без traceId в RunSpec события несут null и остаются валидными', async () => {
    const h = createHarness({ scenario: 'success' });
    const { receipt } = h.start();
    await h.runner.waitFor(receipt.runId);

    const events = h.runner.events(receipt.runId);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.traceId).toBeNull();
      expect(validateRunnerEvent(event).ok).toBe(true);
    }
  });

  it('события, принятые через submitEvent, тоже несут traceId рана', async () => {
    const h = createHarness({ scenario: 'timeout' });
    const { receipt, spec } = h.start({ traceId: 'trace-runner-2' });
    await waitFor(() => h.runner.getRun(receipt.runId)?.state === 'running', 5000, 'run to be running');

    const accepted = h.runner.submitEvent(receipt.runId, {
      type: 'log',
      ownerGeneration: spec.ownerGeneration,
      payload: { stream: 'runner', level: 'info', message: 'external event' },
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.event?.traceId).toBe('trace-runner-2');

    await h.runner.cancel(receipt.runId, spec.ownerGeneration);
    await h.runner.waitFor(receipt.runId);
  });
});

describe('traceId в JSONL ScopedEventLog', () => {
  it('строки журнала рана содержат traceId события', async () => {
    const h = createHarness({ scenario: 'success' });
    const { receipt } = h.start({ traceId: 'trace-journal-1' });
    await h.runner.waitFor(receipt.runId);

    const entries = journalEntries(h.rootDir, receipt.runId);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry['traceId']).toBe('trace-journal-1');
      expect(validateRunnerEvent(entry).ok).toBe(true);
    }
  });

  it('без traceId в RunSpec в журнале уходит null', async () => {
    const h = createHarness({ scenario: 'success' });
    const { receipt } = h.start();
    await h.runner.waitFor(receipt.runId);

    const entries = journalEntries(h.rootDir, receipt.runId);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry['traceId']).toBeNull();
  });
});

describe('traceId в записях ApiLogger', () => {
  async function makeApi(logs: Array<Record<string, unknown>>): Promise<AgentApi> {
    const worker = await startMockWorker();
    onTestFinished(() => worker.close());
    const api = new AgentApi({ workers: [adapterFor(worker)], logger: (entry) => logs.push(entry) });
    onTestFinished(() => api.dispose());
    return api;
  }

  it('приём и run-записи несут traceId запроса', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const api = await makeApi(logs);

    const receipt = api.submit(alpha, 'idem-trace-1', submitBody({ traceId: 'trace-api-1' }));
    await waitFor(() => api.status(alpha, receipt.runId).state === 'succeeded', 8000, 'run to finish');

    const accepted = logs.find((entry) => entry['event'] === 'submit' && entry['outcome'] === 'accepted');
    expect(accepted?.['runId']).toBe(receipt.runId);
    expect(accepted?.['traceId']).toBe('trace-api-1');

    const workerAccepted = logs.find((entry) => entry['event'] === 'worker_accepted');
    expect(workerAccepted?.['runId']).toBe(receipt.runId);
    expect(workerAccepted?.['traceId']).toBe('trace-api-1');
  });

  it('дубликат submit несёт traceId уже принятого рана', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const api = await makeApi(logs);

    const first = api.submit(alpha, 'idem-trace-2', submitBody({ traceId: 'trace-api-2' }));
    await waitFor(() => api.status(alpha, first.runId).state === 'succeeded', 8000, 'run to finish');
    const duplicate = api.submit(alpha, 'idem-trace-2', submitBody({ traceId: 'trace-api-2' }));
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.runId).toBe(first.runId);

    const entry = logs.find((log) => log['event'] === 'submit' && log['outcome'] === 'duplicate');
    expect(entry?.['runId']).toBe(first.runId);
    expect(entry?.['traceId']).toBe('trace-api-2');
  });

  it('записи рана без traceId ключа traceId не содержат', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const api = await makeApi(logs);

    const receipt = api.submit(alpha, 'idem-trace-3', submitBody());
    await waitFor(() => api.status(alpha, receipt.runId).state === 'succeeded', 8000, 'run to finish');

    const runEntries = logs.filter((entry) => entry['runId'] === receipt.runId);
    expect(runEntries.length).toBeGreaterThan(0);
    for (const entry of runEntries) expect(entry).not.toHaveProperty('traceId');
  });
});
