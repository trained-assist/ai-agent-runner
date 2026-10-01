import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  alphaKey,
  authHeader,
  getStatus,
  postCancel,
  postSubmit,
  readerKey,
  startHttpHarness,
  submitBody,
  SseCollector,
} from './api-http-harness.js';
import { sleep } from '../src/adapters/engine/process-tree.js';

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

describe('http auth, scopes and structured refusals', () => {
  it('refuses unauthenticated, wrong-scope and malformed requests with structured errors and no key material', async () => {
    const h = await startHttpHarness();

    const health = await fetch(`${h.base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });

    const noAuth = await fetch(`${h.base}/v1/runs/run_x/status`);
    expect(noAuth.status).toBe(401);
    const noAuthBody = (await noAuth.json()) as { error: { code: string } };
    expect(noAuthBody.error.code).toBe('UNAUTHENTICATED');

    const badKey = await fetch(`${h.base}/v1/runs/run_x/status`, { headers: authHeader('ak_totally_wrong_key') });
    expect(badKey.status).toBe(401);

    const wrongScheme = await fetch(`${h.base}/v1/runs/run_x/status`, { headers: { authorization: `Basic ${alphaKey}` } });
    expect(wrongScheme.status).toBe(401);

    const readerSubmit = await postSubmit(h.base, readerKey, 'idem-reader', submitBody());
    expect(readerSubmit.status).toBe(403);
    expect(((await readerSubmit.json()) as { error: { code: string } }).error.code).toBe('SCOPE_DENIED');

    const noIdem = await postSubmit(h.base, alphaKey, null, submitBody());
    expect(noIdem.status).toBe(400);
    expect(((await noIdem.json()) as { error: { code: string } }).error.code).toBe('MISSING_IDEMPOTENCY_KEY');

    const badJson = await postSubmit(h.base, alphaKey, 'idem-bad-json', '{ not json');
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');

    const unknownRun = await getStatus(h.base, alphaKey, 'run_does_not_exist');
    expect(unknownRun.status).toBe(404);
    expect(((await unknownRun.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    const badRoute = await fetch(`${h.base}/v2/runs`, { headers: authHeader(alphaKey) });
    expect(badRoute.status).toBe(404);
    expect(((await badRoute.json()) as { error: { code: string } }).error.code).toBe('ROUTE_NOT_FOUND');

    const wrongMethod = await fetch(`${h.base}/v1/runs/run_x/status`, { method: 'POST', headers: authHeader(alphaKey) });
    expect(wrongMethod.status).toBe(405);

    expect(h.fake.startCalls).toBe(0);

    const logsText = JSON.stringify(h.logs);
    const filesText = walkFiles(h.rootDir)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    for (const text of [logsText, filesText]) {
      expect(text).not.toContain(alphaKey);
      expect(text).not.toContain(readerKey);
    }
    expect(logsText).not.toContain('authorization');
    const requestLogs = h.logs.filter((entry) => entry['event'] === 'request');
    expect(requestLogs.length).toBeGreaterThan(0);
    expect(requestLogs.every((entry) => typeof entry['status'] === 'number')).toBe(true);
  });
});

describe('http submit, status, result, events and cancel', () => {
  it('admits a job, dedups by idempotency key and exposes status/result/events', async () => {
    const h = await startHttpHarness();

    const first = await postSubmit(h.base, alphaKey, 'idem-http-1', submitBody({ userTaskId: 'task-http-1' }));
    expect(first.status).toBe(202);
    const receipt = (await first.json()) as { requestId: string; userTaskId: string; runId: string; deduplicated: boolean };
    expect(receipt.deduplicated).toBe(false);
    expect(receipt.userTaskId).toBe('task-http-1');

    const second = await postSubmit(h.base, alphaKey, 'idem-http-1', submitBody({ userTaskId: 'task-http-1' }));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ...receipt, deduplicated: true });

    const conflict = await postSubmit(h.base, alphaKey, 'idem-http-1', submitBody({ userTaskId: 'task-http-1', limits: { timeoutMs: 9999 } }));
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_CONFLICT');

    await waitFor(async () => {
      const response = await getStatus(h.base, alphaKey, receipt.runId);
      const body = (await response.json()) as { state: string };
      return body.state === 'succeeded';
    }, 8000, 'run to succeed over http');

    const status = await getStatus(h.base, alphaKey, receipt.runId);
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as Record<string, unknown>;
    expect(statusBody).toMatchObject({
      requestId: receipt.requestId,
      userTaskId: 'task-http-1',
      runId: receipt.runId,
      state: 'succeeded',
      connectionLost: false,
      cancelRequested: false,
      ownerGeneration: 1,
    });

    const result = await fetch(`${h.base}/v1/runs/${receipt.runId}/result`, { headers: authHeader(alphaKey) });
    expect(result.status).toBe(200);
    expect(((await result.json()) as { outcome: string }).outcome).toBe('succeeded');

    const events = await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=0`, { headers: authHeader(alphaKey) });
    expect(events.status).toBe(200);
    const page = (await events.json()) as { events: Array<{ type: string; sequence: number }>; cursor: number; hasMore: boolean };
    expect(page.events[0]?.type).toBe('claimed');
    expect(page.events.at(-1)?.type).toBe('succeeded');

    const limited = await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=0&limit=2`, { headers: authHeader(alphaKey) });
    const limitedPage = (await limited.json()) as { events: unknown[]; hasMore: boolean; cursor: number };
    expect(limitedPage.events).toHaveLength(2);
    expect(limitedPage.hasMore).toBe(true);

    const badCursor = await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=abc`, { headers: authHeader(alphaKey) });
    expect(badCursor.status).toBe(400);
    expect(((await badCursor.json()) as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');

    expect(h.fake.startCalls).toBe(1);
  });

  it('keeps cancel semantics distinct: stale generation rejected, cancel not pretended as stopped', async () => {
    const h = await startHttpHarness({ scenario: 'cancel-with-children' });
    const submit = await postSubmit(h.base, alphaKey, 'idem-http-cancel', submitBody());
    const receipt = (await submit.json()) as { runId: string };

    await waitFor(async () => {
      const response = await getStatus(h.base, alphaKey, receipt.runId);
      return ((await response.json()) as { state: string }).state === 'running';
    }, 8000, 'run to be running');

    const resultEarly = await fetch(`${h.base}/v1/runs/${receipt.runId}/result`, { headers: authHeader(alphaKey) });
    expect(resultEarly.status).toBe(409);
    const notReady = (await resultEarly.json()) as { error: { code: string; details: { state: string } } };
    expect(notReady.error.code).toBe('RESULT_NOT_READY');
    expect(notReady.error.details.state).toBe('running');

    const stale = await postCancel(h.base, alphaKey, receipt.runId, { ownerGeneration: 77 });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as { error: { code: string } };
    expect(staleBody.error.code).toBe('STALE_OWNER_GENERATION');
    const afterStale = await getStatus(h.base, alphaKey, receipt.runId);
    expect(((await afterStale.json()) as { state: string }).state).toBe('running');

    const cancel = await postCancel(h.base, alphaKey, receipt.runId, {});
    expect([200, 202]).toContain(cancel.status);
    const cancelBody = (await cancel.json()) as { status: string; state?: string };
    expect(['stopped', 'stop_pending']).toContain(cancelBody.status);
    if (cancelBody.status === 'stop_pending') {
      const pendingStatus = await getStatus(h.base, alphaKey, receipt.runId);
      expect(['queued', 'starting', 'running', 'finalizing']).toContain(((await pendingStatus.json()) as { state: string }).state);
    }

    await waitFor(async () => {
      const response = await getStatus(h.base, alphaKey, receipt.runId);
      return ((await response.json()) as { state: string }).state === 'cancelled';
    }, 8000, 'run to be cancelled');

    const repeat = await postCancel(h.base, alphaKey, receipt.runId, {});
    expect(repeat.status).toBe(200);
    expect(((await repeat.json()) as { status: string }).status).toBe('already_terminal');

    const result = await fetch(`${h.base}/v1/runs/${receipt.runId}/result`, { headers: authHeader(alphaKey) });
    expect(result.status).toBe(200);
    expect(((await result.json()) as { outcome: string }).outcome).toBe('cancelled');
    expect(h.fake.startCalls).toBe(1);
  });

  it('rejects an oversized body without starting a run', async () => {
    const h = await startHttpHarness({ scenario: 'success', maxBodyBytes: 2048 });
    const oversized = await postSubmit(h.base, alphaKey, 'idem-oversized', submitBody({ instructions: 'x'.repeat(4096) }));
    expect(oversized.status).toBe(413);
    expect(((await oversized.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(h.fake.startCalls).toBe(0);
  });
});

describe('http sse replay', () => {
  it('streams events, survives an aborted connection, replays by cursor and ends at the terminal event', async () => {
    const h = await startHttpHarness({ scenario: 'cancel-with-children', streamPollMs: 20 });
    const submit = await postSubmit(h.base, alphaKey, 'idem-sse', submitBody());
    const receipt = (await submit.json()) as { runId: string };

    const controller = new AbortController();
    const firstResponse = await fetch(`${h.base}/v1/runs/${receipt.runId}/events`, {
      headers: { ...authHeader(alphaKey), accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get('content-type')).toContain('text/event-stream');
    const firstReader = firstResponse.body!.getReader();
    const firstCollector = new SseCollector(firstReader);
    const firstFrames = await firstCollector.waitFor((frames) => frames.some((frame) => frame.event === 'started'), 8000);
    const snapshot = firstFrames.find((frame) => frame.event === 'snapshot');
    expect(snapshot).toBeDefined();
    expect(JSON.parse(snapshot!.data!).state).toBe('running');
    const resumeFrom = firstCollector.lastEventId();
    expect(resumeFrom).toBeGreaterThan(0);

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondResponse = await fetch(`${h.base}/v1/runs/${receipt.runId}/events`, {
      headers: { ...authHeader(alphaKey), accept: 'text/event-stream', 'last-event-id': String(resumeFrom) },
    });
    expect(secondResponse.status).toBe(200);
    const secondCollector = new SseCollector(secondResponse.body!.getReader());
    await secondCollector.waitFor((frames) => frames.some((frame) => frame.event === 'snapshot'), 8000);

    const cancel = await postCancel(h.base, alphaKey, receipt.runId, {});
    expect([200, 202]).toContain(cancel.status);

    await secondCollector.waitFor((frames) => frames.some((frame) => frame.event === 'cancelled'), 8000);
    await secondCollector.waitEnd(8000);

    const eventIds = secondCollector.all.filter((frame) => frame.id).map((frame) => Number(frame.id));
    const uniqueIds = new Set(eventIds);
    expect(uniqueIds.size).toBe(eventIds.length);

    const replayedAfterCursor = secondCollector.all.filter((frame) => frame.id && Number(frame.id) <= resumeFrom);
    expect(replayedAfterCursor).toHaveLength(0);

    const status = await getStatus(h.base, alphaKey, receipt.runId);
    expect(((await status.json()) as { state: string }).state).toBe('cancelled');
    expect(h.fake.startCalls).toBe(1);
  });

  it('ends an sse stream immediately when the run is already terminal', async () => {
    const h = await startHttpHarness({ scenario: 'success' });
    const submit = await postSubmit(h.base, alphaKey, 'idem-sse-done', submitBody());
    const receipt = (await submit.json()) as { runId: string };

    await waitFor(async () => {
      const response = await getStatus(h.base, alphaKey, receipt.runId);
      return ((await response.json()) as { state: string }).state === 'succeeded';
    }, 8000, 'run to finish');

    const response = await fetch(`${h.base}/v1/runs/${receipt.runId}/events`, {
      headers: { ...authHeader(alphaKey), accept: 'text/event-stream' },
    });
    const collector = new SseCollector(response.body!.getReader());
    await collector.waitFor((frames) => frames.some((frame) => frame.event === 'snapshot'), 8000);
    await collector.waitEnd(8000);
    const snapshot = collector.all.find((frame) => frame.event === 'snapshot');
    expect(JSON.parse(snapshot!.data!).state).toBe('succeeded');
  });
});
