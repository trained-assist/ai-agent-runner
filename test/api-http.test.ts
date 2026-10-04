import { describe, expect, it } from 'vitest';
import {
  SseCollector,
  alphaKey,
  authHeader,
  getArtifacts,
  getStatus,
  noScopeKey,
  postCancel,
  postSubmit,
  readerKey,
  startHttpHarness,
  submitBody,
  waitForAsync,
  waitForTerminal,
} from './api-http-harness.js';

describe('http auth, scopes and structured refusals', () => {
  it('отказывает без ключа, без scope и на кривых запросах — структурированно и без ключевого материала', async () => {
    const h = await startHttpHarness();

    const health = await fetch(`${h.base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      workers: [{ engine: 'azure-dynamic-ip-agent-run' }],
    });

    const noAuth = await fetch(`${h.base}/v1/runs/run_x/status`);
    expect(noAuth.status).toBe(401);
    expect(((await noAuth.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');

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

    expect(h.worker.launches).toHaveLength(0);

    // Ключи принципалов не попадают ни в логи процесса, ни в ответы.
    const logsText = JSON.stringify(h.logs);
    expect(logsText).not.toContain(alphaKey);
    expect(logsText).not.toContain(readerKey);
    expect(logsText).not.toContain(noScopeKey);
    expect(logsText).not.toContain('authorization');
    const requestLogs = h.logs.filter((entry) => entry['event'] === 'request');
    expect(requestLogs.length).toBeGreaterThan(0);
    expect(requestLogs.every((entry) => typeof entry['status'] === 'number')).toBe(true);
  });

  it('дисковые маршруты прошлой модели больше не существуют (#74)', async () => {
    const h = await startHttpHarness();
    for (const path of ['/v1/runs/run_x/export', '/v1/runs/run_x/upload', '/v1/runs/run_x/snapshot', '/v1/release', '/v1/capabilities/invoke']) {
      const response = await fetch(`${h.base}${path}`, { headers: authHeader(alphaKey) });
      expect([404, 405], `${path} должен быть недоступен`).toContain(response.status);
      if (response.status === 404) {
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe('ROUTE_NOT_FOUND');
      }
    }
  });
});

describe('http submit, status, result, artifacts, events and cancel', () => {
  it('принимает задачу, дедуплицирует по ключу и отдаёт status/result/artifacts/events', async () => {
    const h = await startHttpHarness();

    const first = await postSubmit(h.base, alphaKey, 'idem-http-1', submitBody({ userTaskId: 'task-http-1' }));
    expect(first.status).toBe(202);
    const receipt = (await first.json()) as { runId: string; requestId: string; userTaskId: string; conversationId?: string };

    const duplicate = await postSubmit(h.base, alphaKey, 'idem-http-1', submitBody({ userTaskId: 'task-http-1' }));
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()) as Record<string, unknown>).toMatchObject({ runId: receipt.runId, deduplicated: true });
    expect(h.worker.launches).toHaveLength(1);

    await waitForTerminal(h.base, alphaKey, receipt.runId);

    const status = (await (await getStatus(h.base, alphaKey, receipt.runId)).json()) as {
      state: string;
      conversationId: string;
      userTaskId: string;
      sequence: number;
    };
    expect(status.state).toBe('succeeded');
    expect(status.userTaskId).toBe('task-http-1');
    expect(status.conversationId).toMatch(/^conv_/);
    expect(status.sequence).toBeGreaterThan(0);

    const artifacts = (await (await getArtifacts(h.base, alphaKey, receipt.runId)).json()) as { count: number };
    expect(artifacts.count).toBe(1);

    const page = (await (await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=0&limit=3`, { headers: authHeader(alphaKey) })).json()) as {
      events: unknown[];
      cursor: number;
      hasMore: boolean;
    };
    expect(page.events).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBe(3);

    const rest = (await (await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=3`, { headers: authHeader(alphaKey) })).json()) as {
      events: Array<{ sequence: number }>;
    };
    expect(rest.events[0]!.sequence).toBe(4);
  });

  it('незавершённый ран: result не выдаётся, отмена доходит до воркера', async () => {
    const h = await startHttpHarness({ worker: { delayMs: 400 } });
    const submit = await postSubmit(h.base, alphaKey, 'idem-http-cancel', submitBody());
    const receipt = (await submit.json()) as { runId: string };

    const early = await fetch(`${h.base}/v1/runs/${receipt.runId}/result`, { headers: authHeader(alphaKey) });
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: { code: string } }).error.code).toBe('RESULT_NOT_READY');

    const cancel = await postCancel(h.base, alphaKey, receipt.runId, {});
    expect(cancel.status).toBe(202);
    expect(h.worker.cancels).toContain(receipt.runId);

    await waitForTerminal(h.base, alphaKey, receipt.runId);
    expect((await (await getStatus(h.base, alphaKey, receipt.runId)).json()) as { state: string }).toMatchObject({ state: 'cancelled' });

    // Повторная отмена терминального рана — «уже терминальный», а не 409-фантом.
    const again = await postCancel(h.base, alphaKey, receipt.runId, {});
    expect(again.status).toBe(200);
    expect((await again.json()) as Record<string, unknown>).toMatchObject({ status: 'already_terminal' });
  });

  it('отклоняет слишком большое тело, не доходя до воркера', async () => {
    const h = await startHttpHarness({ maxBodyBytes: 2048 });
    const oversized = await postSubmit(h.base, alphaKey, 'idem-oversized', submitBody({ instructions: 'x'.repeat(4096) }));
    expect(oversized.status).toBe(413);
    expect(((await oversized.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(h.worker.launches).toHaveLength(0);
  });
});

describe('http sse replay', () => {
  it('стримит события, переживает оборванную связь, переигрывает по курсору и закрывается на терминальном событии', async () => {
    const h = await startHttpHarness({ worker: { delayMs: 300 }, streamPollMs: 10 });
    const submit = await postSubmit(h.base, alphaKey, 'idem-sse', submitBody());
    const receipt = (await submit.json()) as { runId: string };

    await waitForAsync(async () => {
      const response = await getStatus(h.base, alphaKey, receipt.runId);
      return ((await response.json()) as { state: string }).state === 'running';
    }, 8000, 'run to be running before the first stream');

    const controller = new AbortController();
    const firstResponse = await fetch(`${h.base}/v1/runs/${receipt.runId}/events`, {
      headers: { ...authHeader(alphaKey), accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get('content-type')).toContain('text/event-stream');
    const firstCollector = new SseCollector(firstResponse.body!.getReader());
    const firstFrames = await firstCollector.waitFor((frames) => frames.some((frame) => frame.event === 'snapshot'), 8000);
    const snapshot = firstFrames.find((frame) => frame.event === 'snapshot');
    expect(JSON.parse(snapshot!.data!).state).toBe('running');
    const resumeFrom = firstCollector.lastEventId();

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondResponse = await fetch(`${h.base}/v1/runs/${receipt.runId}/events`, {
      headers: { ...authHeader(alphaKey), accept: 'text/event-stream', 'last-event-id': String(resumeFrom) },
    });
    const secondCollector = new SseCollector(secondResponse.body!.getReader());
    await secondCollector.waitFor(
      (frames) => frames.some((frame) => frame.event === 'succeeded' || frame.event === 'failed' || frame.event === 'cancelled'),
      8000,
    );
    await secondCollector.waitEnd(8000);

    const eventIds = secondCollector.all.filter((frame) => frame.id).map((frame) => Number(frame.id));
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(secondCollector.all.filter((frame) => frame.id && Number(frame.id) <= resumeFrom)).toHaveLength(0);
  }, 30000);

  it('немедленно закрывает sse-поток на уже терминальном ране', async () => {
    const h = await startHttpHarness();
    const submit = await postSubmit(h.base, alphaKey, 'idem-sse-done', submitBody());
    const receipt = (await submit.json()) as { runId: string };
    await waitForTerminal(h.base, alphaKey, receipt.runId);

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
