import { describe, expect, it } from 'vitest';
import {
  alphaKey,
  authHeader,
  getStatus,
  postCancel,
  postSubmit,
  startHttpHarness,
  submitBody,
  waitForAsync as waitFor,
  waitForTerminal,
} from './api-http-harness.js';

// Совместимость с control plane (trained-assist-control-plane) в stateless-модели (#74):
// словарь соответствия (CP → Runner) сохранён, исчезли только те словари, у которых больше
// нет носителя — recovery и connection_lost как состояние долгоживущего раннера.
//
//   C01 receipt {requestId,userTaskId,acceptedAt,durable}  → наш receipt {requestId,userTaskId,runId,deduplicated}
//   C02 events ?taskId&after&limit, nextCursor/hasMore     → наш /v1/runs/{id}/events?cursor&limit, cursor/hasMore
//   C02 envelope … occurredAt …                          → наше поле timestamp (адаптер)
//   C03 cancel_requested → cancelled после подтверждения  → наш stop_pending(202) → терминальный cancelled
//   P06 outcome unknown при потере воркера                 → WORKER_UNREACHABLE, outcome=failed, retryable
//   AC-69 resume: новый runId, тот же userTaskId, поколение+1 → наша семантика продолжения (capabilities)

describe('совместимость с control plane в stateless-модели (C01/C02/C03, P06, AC-69)', () => {
  it('сквозной флоу CP: приём → статус → события по курсору → cancel → продолжение', async () => {
    const h = await startHttpHarness({ worker: { delayMs: 300 } });
    const taskId = 'ut-cp-compat-1';
    const conversationId = 'conv-cp-compat-1';
    const body = submitBody({ userTaskId: taskId, conversationId, limits: { timeoutMs: 60_000 } });

    // ---- C01: приём и receipt
    const first = await postSubmit(h.base, alphaKey, 'cp-req-1', body);
    expect(first.status).toBe(202);
    const receipt = (await first.json()) as { requestId: string; userTaskId: string; runId: string; deduplicated: boolean };
    expect(receipt.deduplicated).toBe(false);
    expect(receipt.userTaskId).toBe(taskId);

    // Повтор того же ключа — тот же receipt, а не вторая копия задачи.
    const repeat = await postSubmit(h.base, alphaKey, 'cp-req-1', body);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ runId: receipt.runId, deduplicated: true });

    await waitFor(async () => {
      const view = (await (await getStatus(h.base, alphaKey, receipt.runId)).json()) as { state: string };
      return view.state === 'running';
    }, 8000, 'run to be running');

    // ---- C02: события по курсору. Пока воркер думает, журнал уже содержит приём рана.
    const page1 = (await (await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=0&limit=2`, { headers: authHeader(alphaKey) })).json()) as {
      events: Array<{ sequence: number; timestamp: string; type: string }>;
      cursor: number;
      hasMore: boolean;
    };
    expect(page1.events.map((event) => event.type)).toEqual(['claimed', 'inputs_materialized']);
    expect(page1.cursor).toBe(2);
    expect(page1.events.every((event) => typeof event.timestamp === 'string')).toBe(true);

    // ---- C03: отмена доходит до воркера и подтверждается терминальным состоянием
    const cancel = await postCancel(h.base, alphaKey, receipt.runId, {});
    expect([200, 202]).toContain(cancel.status);
    expect(await waitForTerminal(h.base, alphaKey, receipt.runId)).toBe('cancelled');

    // Продолжение страницы с курсора: события не теряются и не дублируются.
    const page2 = (await (await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=${page1.cursor}`, { headers: authHeader(alphaKey) })).json()) as {
      events: Array<{ sequence: number; type: string }>;
      hasMore: boolean;
    };
    expect(page2.events[0]!.sequence).toBe(3);
    expect(page2.events.every((event) => event.sequence > page1.cursor)).toBe(true);
    expect(page2.events[page2.events.length - 1]!.type).toBe('cancelled');

    // ---- AC-69: продолжение = новый runId, тот же userTaskId/conversationId, поколение+1
    const continuation = await postSubmit(h.base, alphaKey, 'cp-req-2', body);
    expect(continuation.status).toBe(202);
    const next = (await continuation.json()) as { runId: string; requestId: string };
    expect(next.runId).not.toBe(receipt.runId);
    expect(next.requestId).toBe(receipt.requestId);
    const nextStatus = (await (await getStatus(h.base, alphaKey, next.runId)).json()) as {
      userTaskId: string;
      conversationId: string;
      ownerGeneration: number;
    };
    expect(nextStatus.userTaskId).toBe(taskId);
    expect(nextStatus.conversationId).toBe(conversationId);
    expect(nextStatus.ownerGeneration).toBe(2);
  }, 30000);

  it('P06: отказ воркера даёт известный исход с retryable, а не «неизвестный» молча', async () => {
    const h = await startHttpHarness({ worker: { httpStatus: 500 } });
    const submit = await postSubmit(h.base, alphaKey, 'cp-req-worker-down', submitBody());
    const receipt = (await submit.json()) as { runId: string };
    expect(await waitForTerminal(h.base, alphaKey, receipt.runId)).toBe('failed');

    const result = (await (await fetch(`${h.base}/v1/runs/${receipt.runId}/result`, { headers: authHeader(alphaKey) })).json()) as {
      outcome: string;
      failure: { code: string; retryable: boolean };
    };
    expect(result.outcome).toBe('failed');
    expect(result.failure).toMatchObject({ code: 'WORKER_HTTP_ERROR', failureClass: 'runtime', retryable: true });
  }, 30000);
});
