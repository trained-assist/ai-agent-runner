import { describe, expect, it, onTestFinished } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { AgentApi } from '../src/api/service.js';
import { StatelessStore } from '../src/api/stateless-store.js';
import type { Principal } from '../src/api/auth.js';
import { adapterFor, startMockWorker, type MockWorkerOptions } from './external-worker-harness.js';
import { ExternalWorkerAdapter } from '../src/adapters/external-worker-adapter.js';

/**
 * Правила приёма stateless-ядра (epic #74): идемпотентность в памяти, границы движка,
 * владение ран и отсутствие recovery. Никакого `recover()` и никакого `ApiStore` здесь быть
 * не может — состояние процесса не переживает рестарт.
 */

const alpha: Principal = {
  principalId: 'p-alpha',
  profileId: 'profile-a',
  scopes: ['runs:read', 'runs:write'],
  engines: ['dynamic-ip-azure-agent-run'],
};

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: { name: 'dynamic-ip-azure-agent-run', adapterVersion: '1' },
    limits: { timeoutMs: 15000 },
    envAllowlist: [],
    input: { inlinePrompt: 'hello agent' },
    ...over,
  };
}

async function makeApi(options: MockWorkerOptions = {}, store = new StatelessStore()): Promise<AgentApi> {
  const worker = await startMockWorker(options);
  onTestFinished(() => worker.close());
  const api = new AgentApi({ workers: [adapterFor(worker)], store });
  onTestFinished(() => api.dispose());
  return api;
}

async function waitForState(api: AgentApi, principal: Principal, runId: string, state: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (api.status(principal, runId).state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} never reached ${state}: ${api.status(principal, runId).state}`);
}

describe('stateless AgentApi: приём запроса', () => {
  it('без Idempotency-Key — MISSING_IDEMPOTENCY_KEY', async () => {
    const api = await makeApi();
    let thrown: ApiError | null = null;
    try {
      api.submit(alpha, undefined, body());
    } catch (err) {
      thrown = err as ApiError;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown?.code).toBe('MISSING_IDEMPOTENCY_KEY');
    expect(thrown?.status).toBe(400);
  });

  it('кривое тело — INVALID_REQUEST, кривой repository — INVALID_REPOSITORY', async () => {
    const api = await makeApi();
    expect(() => api.submit(alpha, 'idem-bad-body', { engine: 'dynamic-ip-azure-agent-run' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    try {
      api.submit(alpha, 'idem-bad-repo', body({ repository: { fullName: 'owner' } }));
    } catch (err) {
      expect((err as ApiError).code).toBe('INVALID_REPOSITORY');
      expect((err as ApiError).status).toBe(400);
    }
  });

  it('повтор с тем же ключом и тем же payload = тот же receipt; с другим = IDEMPOTENCY_CONFLICT', async () => {
    const api = await makeApi();
    const first = api.submit(alpha, 'idem-dedup', body());
    const second = api.submit(alpha, 'idem-dedup', body());
    expect(second.deduplicated).toBe(true);
    expect(second.runId).toBe(first.runId);
    expect(second.requestId).toBe(first.requestId);

    try {
      api.submit(alpha, 'idem-dedup', body({ input: { inlinePrompt: 'другое' } }));
      expect.unreachable('a different payload under the same key must be refused');
    } catch (err) {
      expect((err as ApiError).code).toBe('IDEMPOTENCY_CONFLICT');
    }
    await waitForState(api, alpha, first.runId, 'succeeded');
  });

  it('движок не из allowlist принципала — ENGINE_NOT_ALLOWED', async () => {
    const api = await makeApi();
    try {
      api.submit(alpha, 'idem-engine', body({ engine: { name: 'opencode', adapterVersion: '1' } }));
      expect.unreachable('a foreign engine must be refused');
    } catch (err) {
      expect((err as ApiError).code).toBe('ENGINE_NOT_ALLOWED');
    }
  });

  it('API обслуживает только движок своего воркера, даже если принципал ограничений не имеет', async () => {
    const worker = await startMockWorker();
    onTestFinished(() => worker.close());
    const loose: Principal = { principalId: 'p-loose', profileId: 'profile-a', scopes: ['runs:read', 'runs:write'] };
    const api = new AgentApi({ workers: [adapterFor(worker)] });
    onTestFinished(() => api.dispose());
    try {
      api.submit(loose, 'idem-loose-engine', body({ engine: { name: 'opencode', adapterVersion: '1' } }));
      expect.unreachable('an engine the worker does not implement must be refused');
    } catch (err) {
      expect((err as ApiError).code).toBe('ENGINE_NOT_ALLOWED');
      expect((err as ApiError).details).toMatchObject({ engines: ['dynamic-ip-azure-agent-run'] });
    }
  });

  it('input.refs и ран без промпта — preflight-отказ с retryable=false, а не «воркер недоступен»', async () => {
    const api = await makeApi();
    const refs = api.submit(alpha, 'idem-refs', {
      engine: { name: 'dynamic-ip-azure-agent-run', adapterVersion: '1' },
      limits: { timeoutMs: 5000 },
      envAllowlist: [],
      input: { refs: [{ ref: 'snap-1', snapshotId: 'snapshot-1' }] },
    });
    await waitForState(api, alpha, refs.runId, 'failed');
    const result = api.result(alpha, refs.runId);
    expect(result.exitReason).toBe('preflight_refused');
    expect(result.failure).toMatchObject({ code: 'INPUT_REFS_UNSUPPORTED', failureClass: 'preflight', retryable: false });
  });

  it('память процесса: переполнение незавершённых ранов отказывает, а не вытесняет живой ран', async () => {
    const worker = await startMockWorker({ delayMs: 500 });
    onTestFinished(() => worker.close());
    const api = new AgentApi({ workers: [adapterFor(worker)], maxActiveRuns: 2 });
    onTestFinished(() => api.dispose());
    const runs = [1, 2].map((n) => api.submit(alpha, `idem-cap-${n}`, body()).runId);
    expect(() => api.submit(alpha, 'idem-cap-3', body())).toThrowError(
      expect.objectContaining({ code: 'WORKER_DRAINING', status: 503 }),
    );
    expect(api.status(alpha, runs[0]!).state).not.toBe('succeeded');
  });

  it('вторая попытка задачи, пока первая жива, — TASK_ATTEMPT_ACTIVE; после финализации проходит с ownerGeneration+1', async () => {
    const api = await makeApi({ delayMs: 200 });
    const first = api.submit(alpha, 'idem-attempt-1', body({ userTaskId: 'task-attempt' }));
    try {
      api.submit(alpha, 'idem-attempt-2', body({ userTaskId: 'task-attempt' }));
      expect.unreachable('a second attempt of a live task must be refused');
    } catch (err) {
      expect((err as ApiError).code).toBe('TASK_ATTEMPT_ACTIVE');
      expect((err as ApiError).status).toBe(409);
    }
    await waitForState(api, alpha, first.runId, 'succeeded');

    const second = api.submit(alpha, 'idem-attempt-3', body({ userTaskId: 'task-attempt' }));
    expect(second.runId).not.toBe(first.runId);
    expect(api.status(alpha, second.runId).ownerGeneration).toBe(2);
    await waitForState(api, alpha, second.runId, 'succeeded');
  });

  it('чужой ран — NOT_FOUND: владение проверяется по principal', async () => {
    const api = await makeApi();
    const receipt = api.submit(alpha, 'idem-owner', body());
    const stranger: Principal = { principalId: 'p-stranger', profileId: 'profile-b', scopes: ['runs:read'] };
    expect(() => api.status(stranger, receipt.runId)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => api.artifacts(stranger, receipt.runId)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

describe('stateless AgentApi: финализация', () => {
  it('result доступен только после терминального состояния, иначе RESULT_NOT_READY', async () => {
    const api = await makeApi({ delayMs: 200 });
    const receipt = api.submit(alpha, 'idem-not-ready', body());
    try {
      api.result(alpha, receipt.runId);
      expect.unreachable('result of a live run must not be readable');
    } catch (err) {
      expect((err as ApiError).code).toBe('RESULT_NOT_READY');
    }
    await waitForState(api, alpha, receipt.runId, 'succeeded');
    expect(api.result(alpha, receipt.runId).outcome).toBe('succeeded');
  });

  it('ответ воркера вне контракта не превращается в «успешный» ран', async () => {
    const api = await makeApi({ malformed: true });
    const receipt = api.submit(alpha, 'idem-malformed', body());
    await waitForState(api, alpha, receipt.runId, 'failed');
    const result = api.result(alpha, receipt.runId);
    expect(result.outcome).toBe('failed');
    expect(result.exitReason).toBe('worker_crash');
  });

  it('отмена живого рана доходит до воркера и даёт outcome cancelled', async () => {
    const api = await makeApi({ delayMs: 300 });
    const receipt = api.submit(alpha, 'idem-cancel', body());
    const cancel = await api.cancel(alpha, receipt.runId);
    expect(cancel.status).toBe('stop_pending');
    await waitForState(api, alpha, receipt.runId, 'cancelled');
    expect(api.result(alpha, receipt.runId).outcome).toBe('cancelled');
  });

  it('отмена терминального рана — already_terminal, а не попытка убить призрака', async () => {
    const api = await makeApi();
    const receipt = api.submit(alpha, 'idem-cancel-terminal', body());
    await waitForState(api, alpha, receipt.runId, 'succeeded');
    const cancel = await api.cancel(alpha, receipt.runId);
    expect(cancel.status).toBe('already_terminal');
  });

  it('отмена обгоняет регистрацию рана в воркере: запрос повторяется, а не «неизвестный ран»', async () => {
    const api = await makeApi({ delayMs: 400, registerAfterMs: 120 });
    const receipt = api.submit(alpha, 'idem-cancel-race', body());
    const cancel = await api.cancel(alpha, receipt.runId);
    expect(cancel.status).toBe('stop_pending');
    await waitForState(api, alpha, receipt.runId, 'cancelled');
  }, 20000);

  it('воркер так и не увидел ран: отказ отмены, а не 404 на собственном ране', async () => {
    const api = await makeApi({ delayMs: 2000, registerAfterMs: 60_000 });
    const receipt = api.submit(alpha, 'idem-cancel-unseen', body());
    const cancel = await api.cancel(alpha, receipt.runId);
    expect(cancel.status).toBe('rejected');
    expect(cancel.reason).toContain('has not registered this run');
  }, 20000);

  it('cancel с чужим ownerGeneration — STALE_OWNER_GENERATION, отказ попытки виден в fencing', async () => {
    const api = await makeApi({ delayMs: 300 });
    const receipt = api.submit(alpha, 'idem-fencing', body());
    await expect(api.cancel(alpha, receipt.runId, { ownerGeneration: 99 })).rejects.toMatchObject({
      code: 'STALE_OWNER_GENERATION',
    });
    // Отмена не дошла до воркера, поэтому ран доиграл штатно: fencing не «отменяет всё подряд».
    await waitForState(api, alpha, receipt.runId, 'succeeded');
    expect(api.status(alpha, receipt.runId).fencing.rejected).toBe(1);
  }, 20000);
});

describe('stateless AgentApi: capabilities отчитываются честно (#74, шаг 7)', () => {
  it('изоляции на хосте нет, движок один, байты API не отдаёт', async () => {
    const api = await makeApi();
    const caps = api.capabilities();
    expect(caps.isolation.mode).toBe('none');
    expect(caps.isolation.launcher).toBeNull();
    expect(caps.engines).toEqual(['dynamic-ip-azure-agent-run']);
    expect(caps.artifacts.export.enabled).toBe(false);
    expect(caps.artifacts.download).toBe(false);
    expect(caps.artifacts.shareLink).toBe(false);
    expect(caps.artifacts.upload.enabled).toBe(false);
    expect(caps.artifacts.snapshot.enabled).toBe(false);
    expect(caps.mcp.perRunStdioProxy).toBe(false);
    expect(caps.mcp.capabilityInvokeEndpoint).toBe(false);
    expect(caps.promotion.releaseEndpoint).toBe('absent');
    expect(JSON.stringify(caps)).not.toContain('fake');
  });

  it('при переполнении лимита событий терминальное событие рана вытесняет обычное, а не наоборот', async () => {
    const store = new StatelessStore({ maxEventsPerRun: 4 });
    const api = await makeApi({}, store);
    const receipt = api.submit(alpha, 'idem-event-cap', body());
    await waitForState(api, alpha, receipt.runId, 'succeeded');
    const progress = store.progressOf(receipt.runId)!;
    expect(progress.events.length).toBeLessThanOrEqual(4);
    expect(progress.events[progress.events.length - 1]!.type).toBe('succeeded');
    expect(progress.sequence).toBeGreaterThanOrEqual(progress.events[0]!.sequence);
    expect(store.progressOf(receipt.runId)!.droppedEvents).toBeGreaterThan(0);
  });

  it('реестр движков: запрос уходит воркеру по имени движка, capabilities перечисляет все', async () => {
    const azure = await startMockWorker();
    const actions = await startMockWorker();
    onTestFinished(() => azure.close());
    onTestFinished(() => actions.close());
    const service = new AgentApi({
      workers: [
        adapterFor(azure),
        new ExternalWorkerAdapter({ baseUrl: actions.baseUrl, engineName: 'github-actions-agent-run', deadlineMs: 2000 }),
      ],
    });
    onTestFinished(() => service.dispose());
    // Принципал без allowlist движков: проверяем сам реестр, а не ограничение принципала.
    const fleet: Principal = { principalId: 'p-fleet', profileId: 'profile-a', scopes: ['runs:read', 'runs:write'] };

    expect(service.capabilities().engines).toEqual(['dynamic-ip-azure-agent-run', 'github-actions-agent-run']);
    expect(service.health().workers.map((entry) => entry.engine)).toEqual(['dynamic-ip-azure-agent-run', 'github-actions-agent-run']);

    // Каждый движок обслуживает свой воркер: launch ушёл туда, куда просили.
    const first = service.submit(fleet, 'idem-fleet-azure', body());
    await waitForState(service, fleet, first.runId, 'succeeded');
    expect(azure.launches).toHaveLength(1);
    expect(actions.launches).toHaveLength(0);

    const second = service.submit(fleet, 'idem-fleet-actions', body({ engine: { name: 'github-actions-agent-run', adapterVersion: '1' } }));
    await waitForState(service, fleet, second.runId, 'succeeded');
    expect(actions.launches).toHaveLength(1);
    expect(azure.launches).toHaveLength(1);

    // Отмена уходит в воркер своего движка, а не в первый попавшийся.
    const third = service.submit(fleet, 'idem-fleet-cancel', body({ engine: { name: 'github-actions-agent-run', adapterVersion: '1' } }));
    await service.cancel(fleet, third.runId);
    expect(actions.cancels).toContain(third.runId);
    expect(azure.cancels).not.toContain(third.runId);

    // Движок, которого в реестре нет, отклоняется до записи — и перечисляет доступные.
    try {
      service.submit(fleet, 'idem-fleet-unknown', body({ engine: { name: 'opencode', adapterVersion: '1' } }));
      expect.unreachable('an unregistered engine must be refused');
    } catch (err) {
      expect((err as ApiError).code).toBe('ENGINE_NOT_ALLOWED');
      expect((err as ApiError).details).toMatchObject({ engines: ['dynamic-ip-azure-agent-run', 'github-actions-agent-run'] });
    }
  }, 30000);

  it('пустой реестр воркеров — отказ на старте, а не API без способа запустить агента', () => {
    expect(() => new AgentApi({ workers: [] })).toThrowError(/at least one external worker/);
  });

  it('у ядра нет recovery: состояние живёт в памяти и вычищается по TTL', async () => {
    const store = new StatelessStore({ terminalRunTtlMs: 0 });
    const api = await makeApi({}, store);
    expect((api as unknown as { recover?: unknown }).recover).toBeUndefined();
    const receipt = api.submit(alpha, 'idem-sweep', body());
    await waitForState(api, alpha, receipt.runId, 'succeeded');
    expect(store.counts().runs).toBe(1);
    store.sweep(new Date(Date.now() + 1000));
    expect(store.counts().runs).toBe(0);
    expect(() => api.status(alpha, receipt.runId)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
