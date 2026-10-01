import { describe, expect, it, onTestFinished } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine, type FakeScenario } from '../src/adapters/engine/fake-engine.js';
import type { Principal } from '../src/api/auth.js';
import { ApiError } from '../src/api/errors.js';
import { AgentApi } from '../src/api/service.js';
import { FaultRegistry } from '../src/faults/registry.js';
import { isTerminalState } from '../src/runner/state-machine.js';
import { waitFor } from './helpers.js';

const alpha: Principal = { principalId: 'p-alpha', profileId: 'profile-a', scopes: ['runs:read', 'runs:write'], engines: ['fake'] };
const beta: Principal = { principalId: 'p-beta', profileId: 'profile-b', scopes: ['runs:read', 'runs:write'] };

interface ApiHarness {
  api: AgentApi;
  fake: FakeEngine;
  faults: FaultRegistry;
  logs: Record<string, unknown>[];
}

function createApi(scenario: FakeScenario = 'success', opts: { heartbeatIntervalMs?: number } = {}): ApiHarness {
  const rootDir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-api-svc-'));
  const fake = new FakeEngine(scenario);
  const faults = new FaultRegistry();
  const logs: Record<string, unknown>[] = [];
  const api = new AgentApi({
    rootDir,
    adapters: { fake },
    host: { region: 'sandbox-eu', environment: 'sandbox' },
    faults,
    cancelGraceMs: 500,
    logger: (entry) => logs.push(entry),
    ...(opts.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: opts.heartbeatIntervalMs } : {}),
  });
  onTestFinished(async () => {
    for (const runId of api.runner.listRunIds()) {
      const snapshot = api.runner.getRun(runId);
      if (snapshot && !isTerminalState(snapshot.state)) {
        try {
          await api.runner.cancel(runId, snapshot.ownerGeneration);
        } catch {
          // final cleanup kills the tree below
        }
      }
    }
    api.dispose();
    rmSync(rootDir, { recursive: true, force: true });
  });
  return { api, fake, faults, logs };
}

function submitBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: { name: 'fake', adapterVersion: '1' },
    limits: { timeoutMs: 15000 },
    input: { inlinePrompt: 'hello agent' },
    ...over,
  };
}

function expectApiError(fn: () => unknown, code: string): ApiError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.code).toBe(code);
    return apiError;
  }
  throw new Error(`expected ApiError ${code}, nothing was thrown`);
}

async function expectApiErrorAsync(fn: () => Promise<unknown>, code: string): Promise<ApiError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.code).toBe(code);
    return apiError;
  }
  throw new Error(`expected ApiError ${code}, nothing was thrown`);
}

describe('submit admission and durable receipt', () => {
  it('accepts a typed job, runs it and exposes status, result and events', async () => {
    const h = createApi();
    await h.api.recover();
    expect(h.logs.some((entry) => entry['event'] === 'recovered')).toBe(true);

    const receipt = h.api.submit(alpha, 'idem-1', submitBody());
    expect(receipt.deduplicated).toBe(false);
    expect(receipt.requestId).toMatch(/^req_/);
    expect(receipt.runId).toMatch(/^run_/);

    await waitFor(() => h.api.status(alpha, receipt.runId).state === 'succeeded', 8000, 'run to succeed');
    const status = h.api.status(alpha, receipt.runId);
    expect(status).toMatchObject({ requestId: receipt.requestId, userTaskId: receipt.userTaskId, runId: receipt.runId, state: 'succeeded', connectionLost: false, cancelRequested: false });
    expect(status.ownerGeneration).toBe(1);

    const result = h.api.result(alpha, receipt.runId);
    expect(result.outcome).toBe('succeeded');
    expect(result.userTaskId).toBe(receipt.userTaskId);

    const page = h.api.events(alpha, receipt.runId, 0);
    const types = page.events.map((event) => event.type);
    expect(types[0]).toBe('claimed');
    expect(types.at(-1)).toBe('succeeded');
    expect(page.snapshot.state).toBe('succeeded');
    expect(page.cursor).toBe(page.events.at(-1)!.sequence);

    expect(h.logs.some((entry) => entry['event'] === 'submit' && entry['outcome'] === 'accepted' && entry['requestId'] === receipt.requestId)).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain('idem-1');
  });

  it('returns the same receipt for a duplicate submit and never starts a second run', async () => {
    const h = createApi();
    const first = h.api.submit(alpha, 'idem-dup', submitBody({ userTaskId: 'task-dup' }));
    const second = h.api.submit(alpha, 'idem-dup', submitBody({ userTaskId: 'task-dup' }));
    expect(second).toMatchObject({ requestId: first.requestId, userTaskId: first.userTaskId, runId: first.runId, deduplicated: true });

    await waitFor(() => h.api.status(alpha, first.runId).state === 'succeeded', 8000, 'first run');
    const third = h.api.submit(alpha, 'idem-dup', submitBody({ userTaskId: 'task-dup' }));
    expect(third).toMatchObject({ runId: first.runId, deduplicated: true });
    expect(h.fake.startCalls).toBe(1);
    expect(h.api.runner.listRunIds()).toHaveLength(1);
  });

  it('rejects the same idempotency key with a different payload as conflict', () => {
    const h = createApi();
    h.api.submit(alpha, 'idem-x', submitBody());
    const err = expectApiError(() => h.api.submit(alpha, 'idem-x', submitBody({ limits: { timeoutMs: 9999 } })), 'IDEMPOTENCY_CONFLICT');
    expect(err.status).toBe(409);
    expect(err.details).toMatchObject({ requestId: expect.stringMatching(/^req_/) });
    expect(h.api.runner.listRunIds()).toHaveLength(1);
  });

  it('rejects a missing idempotency key and an invalid body before any run', () => {
    const h = createApi();
    expectApiError(() => h.api.submit(alpha, undefined, submitBody()), 'MISSING_IDEMPOTENCY_KEY');
    expectApiError(() => h.api.submit(alpha, '', submitBody()), 'MISSING_IDEMPOTENCY_KEY');

    const invalid = expectApiError(() => h.api.submit(alpha, 'idem-bad', { engine: { name: 'fake' } }), 'INVALID_REQUEST');
    expect(Array.isArray(invalid.details?.['errors'])).toBe(true);
    expect(h.fake.startCalls).toBe(0);
    expect(h.api.runner.listRunIds()).toHaveLength(0);
  });

  it('denies a disallowed engine before the run and keeps principals isolated', async () => {
    const h = createApi();
    expectApiError(() => h.api.submit(alpha, 'idem-engine', submitBody({ engine: { name: 'opencode', adapterVersion: '1' } })), 'ENGINE_NOT_ALLOWED');
    expect(h.fake.startCalls).toBe(0);

    const alphaReceipt = h.api.submit(alpha, 'idem-shared-key', submitBody());
    const betaReceipt = h.api.submit(beta, 'idem-shared-key', submitBody());
    expect(betaReceipt.requestId).not.toBe(alphaReceipt.requestId);
    expect(betaReceipt.runId).not.toBe(alphaReceipt.runId);
    expect(h.api.runner.listRunIds()).toHaveLength(2);

    expectApiError(() => h.api.status(beta, alphaReceipt.runId), 'NOT_FOUND');
    expectApiError(() => h.api.result(beta, alphaReceipt.runId), 'NOT_FOUND');
    expectApiError(() => h.api.events(beta, alphaReceipt.runId, 0), 'NOT_FOUND');
    await expectApiErrorAsync(() => h.api.cancel(beta, alphaReceipt.runId, {}), 'NOT_FOUND');
    expectApiError(() => h.api.status(alpha, 'run_unknown'), 'NOT_FOUND');

    await waitFor(() => h.api.status(alpha, alphaReceipt.runId).state === 'succeeded', 8000, 'alpha run');
    await waitFor(() => h.api.status(beta, betaReceipt.runId).state === 'succeeded', 8000, 'beta run');
  });
});

describe('task attempts, cancel and fencing', () => {
  it('blocks a second live attempt for the same task and starts a new runId after terminal', async () => {
    const h = createApi('cancel-with-children');
    const first = h.api.submit(alpha, 'idem-attempt-1', submitBody({ userTaskId: 'task-attempts' }));
    await waitFor(() => h.api.status(alpha, first.runId).state === 'running', 8000, 'first attempt running');

    expectApiError(() => h.api.submit(alpha, 'idem-attempt-2', submitBody({ userTaskId: 'task-attempts' })), 'TASK_ATTEMPT_ACTIVE');
    expect(h.fake.startCalls).toBe(1);

    const cancel = await h.api.cancel(alpha, first.runId, {});
    expect(cancel.status).toBe('stopped');
    await waitFor(() => h.api.status(alpha, first.runId).state === 'cancelled', 8000, 'first attempt cancelled');

    const second = h.api.submit(alpha, 'idem-attempt-3', submitBody({ userTaskId: 'task-attempts' }));
    expect(second.deduplicated).toBe(false);
    expect(second.requestId).toBe(first.requestId);
    expect(second.userTaskId).toBe(first.userTaskId);
    expect(second.runId).not.toBe(first.runId);
    expect(h.api.status(alpha, second.runId).ownerGeneration).toBe(2);

    await waitFor(() => h.api.status(alpha, second.runId).state === 'running', 8000, 'second attempt running');
    const repeat = h.api.submit(alpha, 'idem-attempt-3', submitBody({ userTaskId: 'task-attempts' }));
    expect(repeat).toMatchObject({ runId: second.runId, deduplicated: true });
    expect(h.fake.startCalls).toBe(2);

    const stop = await h.api.cancel(alpha, second.runId, {});
    expect(stop.status).toBe('stopped');
    await waitFor(() => h.api.status(alpha, second.runId).state === 'cancelled', 8000, 'second attempt cancelled');
    const repeatAfterStop = h.api.submit(alpha, 'idem-attempt-3', submitBody({ userTaskId: 'task-attempts' }));
    expect(repeatAfterStop.runId).toBe(second.runId);
    expect(h.fake.startCalls).toBe(2);
  });

  it('cancels a queued run without ever spawning the engine', async () => {
    const h = createApi();
    const receipt = h.api.submit(alpha, 'idem-queued', submitBody());
    const cancel = await h.api.cancel(alpha, receipt.runId, {});
    expect(cancel.status).toBe('stopped');
    await waitFor(() => h.api.status(alpha, receipt.runId).state === 'cancelled', 8000, 'queued cancel');
    expect(h.fake.startCalls).toBe(0);

    const again = await h.api.cancel(alpha, receipt.runId, {});
    expect(again.status).toBe('already_terminal');
    expect(h.api.result(alpha, receipt.runId).outcome).toBe('cancelled');
  });

  it('rejects stale ownerGeneration signals without changing the run status', async () => {
    const h = createApi('cancel-with-children');
    const receipt = h.api.submit(alpha, 'idem-fence', submitBody());
    await waitFor(() => h.api.status(alpha, receipt.runId).state === 'running', 8000, 'running');

    const before = h.api.status(alpha, receipt.runId);
    const lateEvent = h.api.runner.submitEvent(receipt.runId, {
      type: 'log',
      ownerGeneration: before.ownerGeneration + 5,
      payload: { stream: 'runner', level: 'info', message: 'late writer' },
    });
    expect(lateEvent).toEqual({ accepted: false, reason: 'stale_owner_generation' });

    const staleCancel = await h.api.cancel(alpha, receipt.runId, { ownerGeneration: before.ownerGeneration + 5 });
    expect(staleCancel.status).toBe('rejected');

    const after = h.api.status(alpha, receipt.runId);
    expect(after.state).toBe('running');
    expect(after.sequence).toBe(before.sequence);
    expect(after.fencing.rejected).toBe(2);

    const stop = await h.api.cancel(alpha, receipt.runId, { ownerGeneration: before.ownerGeneration });
    expect(stop.status).toBe('stopped');
    await waitFor(() => h.api.status(alpha, receipt.runId).state === 'cancelled', 8000, 'cancelled after fencing');
    const finalStatus = h.api.status(alpha, receipt.runId);
    expect(finalStatus.fencing.rejected).toBe(2);
  });
});

describe('structured outcomes and observation states', () => {
  it('surfaces budget and credential denials as structured failures', async () => {
    const h = createApi();
    const budgetReceipt = h.api.submit(alpha, 'idem-budget', submitBody({ budget: { correlationRef: 'b-1', approved: false, reason: 'quota exceeded' } }));
    const credentialsReceipt = h.api.submit(alpha, 'idem-creds', submitBody({ credentialBindings: [{ ref: 'openai-key', scope: 'llm', status: 'missing' }] }));

    await waitFor(
      () => h.api.status(alpha, budgetReceipt.runId).state === 'failed' && h.api.status(alpha, credentialsReceipt.runId).state === 'failed',
      8000,
      'both denials',
    );
    expect(h.api.result(alpha, budgetReceipt.runId).failure).toMatchObject({ code: 'BUDGET_UNAVAILABLE', failureClass: 'preflight' });
    expect(h.api.result(alpha, credentialsReceipt.runId).failure).toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE', failureClass: 'preflight' });
    expect(h.api.status(alpha, budgetReceipt.runId).state).toBe('failed');
  });

  it('keeps connection_lost separate from failed and withholds the result', async () => {
    const h = createApi('timeout', { heartbeatIntervalMs: 40 });
    h.faults.inject('heartbeat', { kind: 'connection_lost', once: true });
    const receipt = h.api.submit(alpha, 'idem-lost', submitBody({ limits: { timeoutMs: 30000 } }));

    await waitFor(() => h.api.status(alpha, receipt.runId).connectionLost, 8000, 'connection_lost');
    const status = h.api.status(alpha, receipt.runId);
    expect(status.state).toBe('running');
    expect(status.state).not.toBe('failed');
    expect(status.connectionLost).toBe(true);

    const page = h.api.events(alpha, receipt.runId, 0);
    expect(page.events.some((event) => event.type === 'connection_lost')).toBe(true);

    const notReady = await expectApiErrorAsync(async () => h.api.result(alpha, receipt.runId), 'RESULT_NOT_READY');
    expect(notReady.status).toBe(409);
    expect(notReady.details).toMatchObject({ state: 'running', connectionLost: true });

    const stop = await h.api.cancel(alpha, receipt.runId, {});
    expect(stop.status).toBe('stopped');
    await waitFor(() => h.api.status(alpha, receipt.runId).state === 'cancelled', 8000, 'cancel after connection_lost');
    expect(h.api.result(alpha, receipt.runId).outcome).toBe('cancelled');
  });

  it('replays events by cursor without gaps or duplicates', async () => {
    const h = createApi();
    const receipt = h.api.submit(alpha, 'idem-events', submitBody());
    await waitFor(() => h.api.status(alpha, receipt.runId).state === 'succeeded', 8000, 'run');

    const full = h.api.events(alpha, receipt.runId, 0);
    expect(full.events.length).toBeGreaterThan(3);
    expect(full.hasMore).toBe(false);

    const collected: number[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = h.api.events(alpha, receipt.runId, cursor, 2);
      pages += 1;
      for (const event of page.events) collected.push(event.sequence);
      cursor = page.cursor;
      if (!page.hasMore) break;
      expect(pages).toBeLessThan(50);
    }
    expect(collected).toEqual(full.events.map((event) => event.sequence));
    expect(new Set(collected).size).toBe(collected.length);

    const tail = h.api.events(alpha, receipt.runId, full.cursor);
    expect(tail.events).toHaveLength(0);
    expect(tail.cursor).toBe(full.cursor);

    expectApiError(() => h.api.events(alpha, receipt.runId, -1), 'INVALID_REQUEST');
    expectApiError(() => h.api.events(alpha, receipt.runId, 0, 0), 'INVALID_REQUEST');
  });
});
