import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProcessAlive, sleep } from '../src/adapters/engine/process-tree.js';
import { FakeEngine } from '../src/adapters/engine/fake-engine.js';
import { submitPayloadHash, validateSubmitRequest } from '../src/api/contracts.js';
import {
  alphaPrincipal,
  alphaKey,
  startHttpHarness,
  submitBody,
  postSubmit,
  getStatus,
  authHeader,
  waitForAsync as waitFor,
} from './api-http-harness.js';
import { AgentApi } from '../src/api/service.js';
import { ApiStore, type AdmissionRecord } from '../src/api/store.js';
import { makeRunSpec } from './helpers.js';

describe('accepted requests survive an api restart (P06)', () => {
  it('keeps the receipt, replays events and never runs a second engine after restart', async () => {
    const h = await startHttpHarness({ scenario: 'success' });

    const first = await postSubmit(h.base, alphaKey, 'idem-survive', submitBody({ userTaskId: 'task-survive' }));
    expect(first.status).toBe(202);
    const receipt = (await first.json()) as { requestId: string; userTaskId: string; runId: string };

    await waitFor(async () => {
      const response = await getStatus(h.base, alphaKey, receipt.runId);
      return ((await response.json()) as { state: string }).state === 'succeeded';
    }, 8000, 'run to finish before restart');

    const before = await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=0`, { headers: authHeader(alphaKey) });
    const beforePage = (await before.json()) as { events: Array<{ type: string; sequence: number }> };

    const report = await h.restart();
    expect(report.terminal).toBe(1);
    expect(report.healed).toBe(0);

    const duplicate = await postSubmit(h.base, alphaKey, 'idem-survive', submitBody({ userTaskId: 'task-survive' }));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ...receipt, deduplicated: true });
    expect(h.fake.startCalls).toBe(1);

    const status = await getStatus(h.base, alphaKey, receipt.runId);
    expect(((await status.json()) as { state: string }).state).toBe('succeeded');

    const after = await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=0`, { headers: authHeader(alphaKey) });
    const afterPage = (await after.json()) as { events: Array<{ type: string; sequence: number }> };
    expect(afterPage.events.map((event) => `${event.sequence}:${event.type}`)).toEqual(beforePage.events.map((event) => `${event.sequence}:${event.type}`));

    const result = await fetch(`${h.base}/v1/runs/${receipt.runId}/result`, { headers: authHeader(alphaKey) });
    expect(result.status).toBe(200);
    expect(((await result.json()) as { outcome: string }).outcome).toBe('succeeded');

    const recoveredLogs = h.logs.filter((entry) => entry['event'] === 'recovered');
    expect(recoveredLogs.length).toBeGreaterThanOrEqual(2);
    const logsText = JSON.stringify(h.logs);
    expect(logsText).not.toContain(alphaKey);
  });

  it('heals an admission written before the crash without letting status start an agent', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-api-heal-'));
    const fake = new FakeEngine('success');
    const logs: Record<string, unknown>[] = [];
    try {
      const body = submitBody({ userTaskId: 'task-crash-window' });
      const validated = validateSubmitRequest(body);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;

      const runId = `run_crash_${Date.now()}`;
      const spec = makeRunSpec({
        runId,
        userTaskId: 'task-crash-window',
        profileId: alphaPrincipal.profileId,
        cwd: join(rootDir, 'workspaces', runId),
        limits: { timeoutMs: 5000 },
        input: { inlinePrompt: 'hello agent' },
        engine: { name: 'fake', adapterVersion: '1' },
        envAllowlist: [],
      });
      const record: AdmissionRecord = {
        schemaVersion: 1,
        requestId: 'req_crash_window',
        userTaskId: 'task-crash-window',
        principalId: alphaPrincipal.principalId,
        jobId: 'job_crash_window',
        idempotencyKey: 'idem-crash-window',
        payloadHash: submitPayloadHash(validated.value),
        runId,
        operationId: spec.operationId,
        ownerGeneration: 1,
        spec,
        createdAt: new Date().toISOString(),
      };
      const store = new ApiStore(rootDir);
      store.init();
      store.put(record);

      const api = new AgentApi({
        rootDir,
        adapters: { fake },
        host: { region: 'sandbox-eu', environment: 'sandbox' },
        logger: (entry) => logs.push(entry),
        cancelGraceMs: 500,
      });
      try {
        const early = api.status(alphaPrincipal, runId);
        expect(early.state).toBe('queued');
        expect(early.requestId).toBe('req_crash_window');
        expect(fake.startCalls).toBe(0);

        const report = await api.recover();
        expect(report.healed).toBe(1);

        await waitFor(() => api.status(alphaPrincipal, runId).state === 'succeeded', 8000, 'healed run to finish');
        expect(fake.startCalls).toBe(1);

        const receipt = api.submit(alphaPrincipal, 'idem-crash-window', body);
        expect(receipt).toMatchObject({ requestId: 'req_crash_window', userTaskId: 'task-crash-window', runId, deduplicated: true });
        expect(fake.startCalls).toBe(1);
        expect(api.runner.listRunIds()).toHaveLength(1);
      } finally {
        api.dispose();
      }
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('reports an orphaned engine as connection_lost, not failed, and starts no second copy', async () => {
    const h = await startHttpHarness({ scenario: 'timeout' });

    const submit = await postSubmit(h.base, alphaKey, 'idem-orphan', submitBody({ userTaskId: 'task-orphan', limits: { timeoutMs: 60000 } }));
    const receipt = (await submit.json()) as { requestId: string; userTaskId: string; runId: string };

    await waitFor(async () => {
      const response = await getStatus(h.base, alphaKey, receipt.runId);
      return ((await response.json()) as { state: string }).state === 'running';
    }, 8000, 'run to be running');

    const pid = h.service.runner.getRun(receipt.runId)?.pid ?? null;
    expect(pid).not.toBeNull();

    const report = await h.restart({ killProcesses: false });
    expect(report.orphaned).toBe(1);
    expect(report.lost).toBe(0);
    expect(report.healed).toBe(0);

    const status = await getStatus(h.base, alphaKey, receipt.runId);
    const statusBody = (await status.json()) as { state: string; connectionLost: boolean; ownerGeneration: number };
    expect(statusBody.state).toBe('running');
    expect(statusBody.connectionLost).toBe(true);
    expect(statusBody.state).not.toBe('failed');

    const events = await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=0`, { headers: authHeader(alphaKey) });
    const page = (await events.json()) as { events: Array<{ type: string }> };
    expect(page.events.some((event) => event.type === 'connection_lost')).toBe(true);

    const result = await fetch(`${h.base}/v1/runs/${receipt.runId}/result`, { headers: authHeader(alphaKey) });
    expect(result.status).toBe(409);
    const notReady = (await result.json()) as { error: { code: string; details: { connectionLost: boolean } } };
    expect(notReady.error.code).toBe('RESULT_NOT_READY');
    expect(notReady.error.details.connectionLost).toBe(true);

    const duplicate = await postSubmit(h.base, alphaKey, 'idem-orphan', submitBody({ userTaskId: 'task-orphan', limits: { timeoutMs: 60000 } }));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ...receipt, deduplicated: true });
    expect(h.fake.startCalls).toBe(1);

    const cancel = await fetch(`${h.base}/v1/runs/${receipt.runId}/cancel`, {
      method: 'POST',
      headers: { ...authHeader(alphaKey), 'content-type': 'application/json' },
      body: '{}',
    });
    expect([200, 202]).toContain(cancel.status);

    await waitFor(async () => {
      const response = await getStatus(h.base, alphaKey, receipt.runId);
      return ((await response.json()) as { state: string }).state === 'cancelled';
    }, 8000, 'orphaned run to reach cancelled');

    await waitFor(async () => pid !== null && !isProcessAlive(pid), 8000, 'orphaned engine to die');
    expect(h.fake.startCalls).toBe(1);
  });

  it('surfaces a worker crash as failed without a hidden rerun', async () => {
    const h = await startHttpHarness({ scenario: 'timeout' });

    const submit = await postSubmit(h.base, alphaKey, 'idem-worker-crash', submitBody({ userTaskId: 'task-worker-crash', limits: { timeoutMs: 60000 } }));
    const receipt = (await submit.json()) as { requestId: string; userTaskId: string; runId: string };

    await waitFor(async () => {
      const response = await getStatus(h.base, alphaKey, receipt.runId);
      return ((await response.json()) as { state: string }).state === 'running';
    }, 8000, 'run to be running');

    const report = await h.restart({ killProcesses: true });
    expect(report.lost).toBe(1);
    expect(report.healed).toBe(0);

    const status = await getStatus(h.base, alphaKey, receipt.runId);
    const statusBody = (await status.json()) as { state: string };
    expect(statusBody.state).toBe('failed');

    const result = await fetch(`${h.base}/v1/runs/${receipt.runId}/result`, { headers: authHeader(alphaKey) });
    expect(result.status).toBe(200);
    const resultBody = (await result.json()) as { outcome: string; failure?: { code: string } };
    expect(resultBody.outcome).toBe('failed');
    expect(resultBody.failure?.code).toBe('WORKER_CRASH');

    const duplicate = await postSubmit(h.base, alphaKey, 'idem-worker-crash', submitBody({ userTaskId: 'task-worker-crash', limits: { timeoutMs: 60000 } }));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ...receipt, deduplicated: true });
    expect(h.fake.startCalls).toBe(1);
    await sleep(100);
    expect(h.fake.startCalls).toBe(1);
  });

  it('kill -9 между записью события и state.json не оставляет дыру в нумерации replay', async () => {
    const h = await startHttpHarness({ scenario: 'timeout' });
    const submit = await postSubmit(h.base, alphaKey, 'idem-seq-window', submitBody({ userTaskId: 'task-seq-window', limits: { timeoutMs: 60000 } }));
    const receipt = (await submit.json()) as { runId: string };
    await waitFor(async () => {
      const response = await getStatus(h.base, alphaKey, receipt.runId);
      return ((await response.json()) as { state: string }).state === 'running';
    }, 8000, 'run to be running');

    // Окно аварии: событие уже в журнале, а state.json с его счётчиком — ещё нет.
    // Воспроизводится ровно это состояние, иначе дыра появляется только по таймингу.
    const statePath = join(h.rootDir, 'runs', receipt.runId, 'state.json');
    const eventsPath = join(h.rootDir, 'runs', receipt.runId, 'events.jsonl');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { sequence: number };
    const logged = readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { sequence: number });
    const lastSequence = logged[logged.length - 1]!.sequence;
    expect(persisted.sequence).toBe(lastSequence);
    writeFileSync(statePath, `${JSON.stringify({ ...persisted, sequence: lastSequence - 1 })}\n`);

    await h.restart({ killProcesses: true });
    const after = await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=0`, { headers: authHeader(alphaKey) });
    const page = (await after.json()) as { events: Array<{ type: string; sequence: number }> };
    expect(page.events.map((event) => event.sequence)).toEqual(page.events.map((_event, index) => index + 1));
    expect(new Set(page.events.map((event) => event.sequence)).size).toBe(page.events.length);
  });
});
