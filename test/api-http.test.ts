import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SseCollector,
  alphaKey,
  authHeader,
  getArtifacts,
  getResult,
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
import { AgentApi } from '../src/api/service.js';
import { StatelessStore } from '../src/api/stateless-store.js';
import { KeyRegistry, keyRecordFor } from '../src/api/auth.js';
import { createAgentApiServer } from '../src/api/server.js';
import { createHarness, waitFor } from './helpers.js';
import { createHash } from 'node:crypto';

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
  it('mock-test authenticates and validates a normal request, returns pong, deduplicates, and never launches the external worker', async () => {
    const h = await startHttpHarness({ mockTestEnabled: true });
    const capabilities = await fetch(`${h.base}/v1/capabilities`, { headers: authHeader(alphaKey) });
    expect(capabilities.status).toBe(200);
    const declared = await capabilities.json() as { engines: string[]; engineSelection: { chain: string[] } };
    expect(declared.engines).toContain('mock-test');
    expect(declared.engineSelection.chain).not.toContain('mock-test');

    const noAuth = await postSubmit(h.base, 'ak_invalid', 'mock-no-auth', submitBody({ engine: { name: 'mock-test', adapterVersion: '1' } }));
    expect(noAuth.status).toBe(401);
    const noWriteScope = await postSubmit(h.base, readerKey, 'mock-reader', submitBody({ engine: { name: 'mock-test', adapterVersion: '1' } }));
    expect(noWriteScope.status).toBe(403);
    const malformed = await postSubmit(h.base, alphaKey, 'mock-malformed', { engine: { name: 'mock-test', adapterVersion: '1' }, envAllowlist: [], limits: { timeoutMs: -1 } });
    expect(malformed.status).toBe(400);

    const body = submitBody({ engine: { name: 'mock-test', adapterVersion: '1' }, userTaskId: 'task-mock-test-contract' });
    const accepted = await postSubmit(h.base, alphaKey, 'mock-valid-once', body);
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json() as { runId: string };
    expect(await waitForTerminal(h.base, alphaKey, receipt.runId)).toBe('succeeded');
    const status = await getStatus(h.base, alphaKey, receipt.runId);
    expect(await status.json()).toMatchObject({ state: 'succeeded', engine: 'mock-test', answer: 'pong' });
    const result = await getResult(h.base, alphaKey, receipt.runId);
    expect(await result.json()).toMatchObject({ outcome: 'succeeded', text: 'pong', persistence: 'not_required', cleanup: 'completed' });

    const duplicate = await postSubmit(h.base, alphaKey, 'mock-valid-once', body);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ runId: receipt.runId, deduplicated: true });
    expect(h.worker.launches).toHaveLength(0);
  });

  it('mock-test ignores the external worker default repository binding', async () => {
    const h = await startHttpHarness({ mockTestEnabled: true, mockOnly: true, defaultRepository: 'invalid default repo' });
    const body = submitBody({ engine: { name: 'mock-test', adapterVersion: '1' }, userTaskId: 'task-mock-with-invalid-default-repo' });
    const accepted = await postSubmit(h.base, alphaKey, 'mock-invalid-default-repo', body);
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json() as { runId: string };
    expect(await waitForTerminal(h.base, alphaKey, receipt.runId)).toBe('succeeded');
    expect(await (await getStatus(h.base, alphaKey, receipt.runId)).json()).toMatchObject({ engine: 'mock-test', answer: 'pong' });
  });

  it('runs in mock-only API mode without configuring or contacting any external worker', async () => {
    const h = await startHttpHarness({ mockTestEnabled: true, mockOnly: true });
    const body = submitBody({ engine: { name: 'mock-test', adapterVersion: '1' } });
    const accepted = await postSubmit(h.base, alphaKey, 'mock-only-run', body);
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json() as { runId: string };
    expect(await waitForTerminal(h.base, alphaKey, receipt.runId)).toBe('succeeded');
    expect(await (await getStatus(h.base, alphaKey, receipt.runId)).json()).toMatchObject({ answer: 'pong' });
    expect(await (await getResult(h.base, alphaKey, receipt.runId)).json()).toMatchObject({ text: 'pong' });
    const automatic = await postSubmit(h.base, alphaKey, 'mock-only-auto-select', submitBody());
    expect(automatic.status).toBe(403);
    expect(((await automatic.json()) as { error: { code: string } }).error.code).toBe('ENGINE_NOT_ALLOWED');
  });

  it('mock-test is opt-in, profile-scoped by engine authorization, and excluded from automatic selection', async () => {
    const h = await startHttpHarness({ mockTestEnabled: true, allowedEngines: ['azure-dynamic-ip-agent-run'] });
    const refused = await postSubmit(h.base, alphaKey, 'mock-not-authorized', submitBody({ engine: { name: 'mock-test', adapterVersion: '1' } }));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('ENGINE_NOT_ALLOWED');
    expect(h.worker.launches).toHaveLength(0);
  });

  it('rejects mock-test when the API was not enabled for sandbox use', async () => {
    const h = await startHttpHarness();
    const response = await postSubmit(h.base, alphaKey, 'mock-disabled', submitBody({ engine: { name: 'mock-test', adapterVersion: '1' } }));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('ENGINE_NOT_ALLOWED');
    expect(h.worker.launches).toHaveLength(0);
  });

  it('accepts an ingress pin over POST /v1/runs and passes a server-bound RunSpec to the worker', async () => {
    const h = await startHttpHarness();
    const pin = { contractVersion: 1, manifestRef: 'cp-input-manifest:task-http-ingress', manifestVersion: 'b'.repeat(64) };
    const response = await postSubmit(h.base, alphaKey, 'idem-http-ingress', submitBody({ userTaskId: 'task-http-ingress', ingressManifest: pin }));
    expect(response.status).toBe(202);
    const { runId } = await response.json() as { runId: string };
    const stored = (h.service as unknown as { store: { getByRun(id: string): { spec: Record<string, unknown> } | null } }).store.getByRun(runId);
    expect(stored?.spec.ingressManifest).toEqual({ ...pin, userTaskId: 'task-http-ingress', profileId: 'profile-a', runId, ownerGeneration: 1 });
  });

  it('POST /v1/runs reaches local Runner.start with the same server-bound ingress pin', async () => {
    const received: import('../src/contracts/run-spec.js').RunSpec[] = [];
    const key = 'ak_0123456789abcdef0123456789abcdef0123456789abcdef';
    const principal = { principalId: 'p-alpha', profileId: 'profile-a', scopes: ['runs:read', 'runs:write'] as Array<'runs:read' | 'runs:write'>, engines: ['fake'] };
    const registry = KeyRegistry.fromRecords([keyRecordFor(key, principal)]);
    let service!: AgentApi;
    const worker = {
      name: 'fake', baseUrl: null,
      async launch(spec: import('../src/contracts/run-spec.js').RunSpec) {
        received.push(spec);
        return { runId: spec.runId, operationId: spec.operationId, status: 'accepted' as const, statusUrl: `http://local/status/${spec.runId}`, resultUrl: `http://local/result/${spec.runId}` };
      },
      async status(runId: string) { return { runId, status: 'running' as const }; },
      async result(runId: string) { throw new Error(`not polled: ${runId}`); },
      async cancel(runId: string) { return { status: 'unknown_run' as const }; },
    };
    service = new AgentApi({ workers: [worker], store: new StatelessStore() });
    const server = createAgentApiServer(service, { keys: registry });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('node:net').AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': 'api-runner-ingress' },
        body: JSON.stringify({ engine: { name: 'fake', adapterVersion: '1' }, limits: { timeoutMs: 5000 }, envAllowlist: [], userTaskId: 'task-e2e-ingress', ingressManifest: { contractVersion: 1, manifestRef: 'cp-input-manifest:task-e2e-ingress', manifestVersion: 'c'.repeat(64) } }),
      });
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(202);
      const { runId } = await response.json() as { runId: string };
      await waitFor(() => received.length > 0, 2000, 'RunSpec to reach worker launch');
      expect(received[0]?.ingressManifest).toMatchObject({ manifestRef: 'cp-input-manifest:task-e2e-ingress', manifestVersion: 'c'.repeat(64), userTaskId: 'task-e2e-ingress', profileId: 'profile-a', runId, ownerGeneration: 1 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.dispose();
    }
  });

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
  it('mirrors live worker stdout/stderr before completion and does not append duplicate final logs after cursor reconnect', async () => {
    const h = await startHttpHarness({
      worker: { liveLogs: true, terminalStatus: 'running', stdout: 'first output second output', stderr: 'diagnostic output', delayedTerminalLogMs: 1500 },
      workerEngineName: 'eu-vm-agent-run',
      streamPollMs: 10,
    });
    h.worker.autoDeliver = false;
    const submit = await postSubmit(h.base, alphaKey, 'idem-live-worker-sse', submitBody({ engine: { name: 'eu-vm-agent-run', adapterVersion: '1' } }));
    const receipt = (await submit.json()) as { runId: string };
    await waitForAsync(async () => (await (await getStatus(h.base, alphaKey, receipt.runId)).json() as { state: string }).state === 'running');

    const firstController = new AbortController();
    const firstResponse = await fetch(`${h.base}/v1/runs/${receipt.runId}/events`, {
      headers: { ...authHeader(alphaKey), accept: 'text/event-stream' },
      signal: firstController.signal,
    });
    const firstCollector = new SseCollector(firstResponse.body!.getReader());
    await firstCollector.waitFor(frames => frames.some(frame => frame.event === 'snapshot'));
    h.worker.pushLog(receipt.runId, 'stdout', 'first output');
    h.worker.pushLog(receipt.runId, 'stderr', 'diagnostic output');
    await firstCollector.waitFor(frames => frames.filter(frame => frame.event === 'log').length === 2);
    expect((await (await getStatus(h.base, alphaKey, receipt.runId)).json() as { state: string }).state).toBe('running');

    const cursor = firstCollector.lastEventId();
    firstController.abort();
    await new Promise(resolve => setTimeout(resolve, 10));

    const resumed = await fetch(`${h.base}/v1/runs/${receipt.runId}/events`, {
      headers: { ...authHeader(alphaKey), accept: 'text/event-stream', 'last-event-id': String(cursor) },
    });
    const resumedCollector = new SseCollector(resumed.body!.getReader());
    await resumedCollector.waitFor(frames => frames.some(frame => frame.event === 'snapshot'));
    h.worker.finishLogs(receipt.runId, { stream: 'stdout', message: 'second output' });
    await resumedCollector.waitFor(frames => frames.some(frame => frame.event === 'log' && frame.data?.includes('second output')));

    await resumedCollector.waitFor(frames => frames.some(frame => frame.event === 'succeeded'));
    await resumedCollector.waitEnd();
    const logFrames = resumedCollector.all.filter(frame => frame.event === 'log');
    expect(logFrames.filter(frame => frame.data?.includes('second output'))).toHaveLength(1);
    expect(logFrames.filter(frame => frame.data?.includes('first output'))).toHaveLength(0);
    expect(logFrames.filter(frame => frame.data?.includes('diagnostic output'))).toHaveLength(0);
    expect(h.worker.logCursors).toContain(2);
    expect((await (await getStatus(h.base, alphaKey, receipt.runId)).json() as { state: string }).state).toBe('succeeded');
  }, 30000);

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
