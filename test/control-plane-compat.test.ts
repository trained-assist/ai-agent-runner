import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import {
  alphaKey,
  authHeader,
  getStatus,
  postSubmit,
  startHttpHarness,
  submitBody,
  waitForAsync as waitFor,
} from './api-http-harness.js';

// Совместимость с РЕАЛЬНЫМ control plane (trained-assist-control-plane):
// P04 «приём задачи и durable receipt» (смержен, 070f2e3) и P05/P06 «поток событий
// с курсором, replay без rerun, восстановление» (PR #7). CP пока не вызывает Runner API
// (его движок — workflow-инстанс), поэтому здесь проверяется не «они нас дёргают», а
// «семантика C01/C02/C03 + P06/AC-69 выполняется на стороне Runner» — то, что проверит
// их адаптер, когда подключит нас как движок.
//
// Словарь соответствия (CP → Runner), зафиксированный в docs/M1-STEP7-SCENARIO.md:
//   C01 receipt {requestId,userTaskId,acceptedAt,durable}  → наш receipt {requestId,userTaskId,runId,deduplicated}
//   C02 events ?taskId&after&limit, nextCursor/hasMore     → наш /v1/runs/{id}/events?cursor&limit, cursor/hasMore
//   C02 envelope … occurredAt …                          → наше поле timestamp (адаптер)
//   C03 cancel_requested → cancelled после подтверждения  → наш stop_pending(202) → stopped(200) + cancelRequested
//   P06 connection-lost: попытка unknown, finished_at=NULL → наш connectionLost=true, state не меняется, result=RESULT_NOT_READY
//   AC-69 resume: новый runId, тот же userTaskId, поколение+1 → наша семантика продолжения (capabilities)

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-compat-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('совместимость с control plane (C01/C02/C03, P06, AC-69)', () => {
  it('сквозной флоу CP: приём → статус → события по курсору → cancel → connection_lost → resume', async () => {
    const h = await startHttpHarness({ scenario: 'timeout' });
    const taskId = 'ut-cp-compat-1';
    const conversationId = 'conv-cp-compat-1';
    const body = submitBody({ userTaskId: taskId, conversationId, limits: { timeoutMs: 60_000 } });

    // ---- C01: приём и durable receipt
    const first = await postSubmit(h.base, alphaKey, 'cp-req-1', body);
    expect(first.status).toBe(202);
    const receipt = (await first.json()) as { requestId: string; userTaskId: string; runId: string; deduplicated: boolean };
    expect(receipt.deduplicated).toBe(false);
    // квитанция ≠ запуск: ран уже принят, движок ещё может стартовать
    const earlyStatus = await getStatus(h.base, alphaKey, receipt.runId);
    const earlyState = (await earlyStatus.json()) as { state: string };
    expect(['queued', 'starting', 'running']).toContain(earlyState.state);

    // повтор того же requestId с тем же payload → прежняя квитанция, без второго запуска
    const repeat = await postSubmit(h.base, alphaKey, 'cp-req-1', body);
    expect(repeat.status).toBe(200);
    expect((await repeat.json()) as { runId: string; deduplicated: boolean }).toMatchObject({ runId: receipt.runId, deduplicated: true });

    // другой payload с тем же ключом → 409 conflict (до запуска)
    const conflict = await postSubmit(h.base, alphaKey, 'cp-req-1', submitBody({ userTaskId: taskId, conversationId, limits: { timeoutMs: 60_000 }, input: { inlinePrompt: 'другой payload' } }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });

    await waitFor(async () => {
      const res = await getStatus(h.base, alphaKey, receipt.runId);
      return ((await res.json()) as { state: string }).state === 'running';
    }, 8000, 'run running');

    // ---- C02: события по курсору, replay после reconnect без rerun
    const page1 = (await (await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=0&limit=2`, { headers: authHeader(alphaKey) })).json()) as {
      events: Array<{ sequence: number; type: string }>;
      cursor: number;
      hasMore: boolean;
    };
    expect(page1.events.length).toBeGreaterThan(0);
    expect(page1.hasMore).toBe(true);
    // «переподключение»: новый запрос с последним курсором — недостающие события, без повторов
    const page2 = (await (await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=${page1.cursor}&limit=100`, { headers: authHeader(alphaKey) })).json()) as {
      events: Array<{ sequence: number; type: string }>;
      cursor: number;
      hasMore: boolean;
    };
    const sequences = [...page1.events, ...page2.events].map((event) => event.sequence);
    expect(new Set(sequences).size).toBe(sequences.length); // без дублей на стыке курсоров
    const full = (await (await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=0&limit=1000`, { headers: authHeader(alphaKey) })).json()) as { events: Array<{ type: string }> };
    expect(full.events.filter((event) => event.type === 'claimed')).toHaveLength(1); // никакого rerun

    // ---- status только чтение: не создаёт событий и не запускает попыток
    const before = full.events.length;
    await getStatus(h.base, alphaKey, receipt.runId);
    await getStatus(h.base, alphaKey, receipt.runId);
    const after = (await (await fetch(`${h.base}/v1/runs/${receipt.runId}/events?cursor=0&limit=1000`, { headers: authHeader(alphaKey) })).json()) as { events: Array<{ type: string }> };
    expect(after.events.length).toBe(before);

    // ---- C03: cancel requested ≠ stopped
    const preCancel = (await (await getStatus(h.base, alphaKey, receipt.runId)).json()) as { state: string; cancelRequested: boolean };
    expect(preCancel.state).toBe('running');
    expect(preCancel.cancelRequested).toBe(false);
    const cancelPending = await fetch(`${h.base}/v1/runs/${receipt.runId}/cancel`, {
      method: 'POST',
      headers: { ...authHeader(alphaKey), 'content-type': 'application/json' },
      body: '{}',
    });
    // 202 stop_pending (движок ещё жив) или 200 stopped (умер в грации) — оба валидны;
    // инвариант C03: сначала cancel_requested, терминал — только после подтверждения остановки
    expect([200, 202]).toContain(cancelPending.status);
    const pendingView = (await (await getStatus(h.base, alphaKey, receipt.runId)).json()) as { cancelRequested: boolean; state: string };
    expect(pendingView.cancelRequested).toBe(true); // запрошено — независимо от того, умер ли движок уже

    await waitFor(async () => {
      const res = await getStatus(h.base, alphaKey, receipt.runId);
      return ((await res.json()) as { state: string }).state === 'cancelled';
    }, 8000, 'run cancelled');
    const stoppedView = (await (await getStatus(h.base, alphaKey, receipt.runId)).json()) as { state: string; cancelRequested: boolean };
    expect(stoppedView.state).toBe('cancelled'); // подтверждённая остановка

    // ---- P06: потеря связи ≠ failed, без авто-rerun (отдельный in-flight ран)
    const inFlight = await postSubmit(h.base, alphaKey, 'cp-req-3', body);
    expect(inFlight.status).toBe(202);
    const inFlightReceipt = (await inFlight.json()) as { runId: string };
    await waitFor(async () => {
      const res = await getStatus(h.base, alphaKey, inFlightReceipt.runId);
      return ((await res.json()) as { state: string }).state === 'running';
    }, 8000, 'in-flight run running');

    const report = await h.restart({ killProcesses: false });
    expect(report.orphaned).toBe(1);
    const lostView = (await (await getStatus(h.base, alphaKey, inFlightReceipt.runId)).json()) as { state: string; connectionLost: boolean };
    expect(lostView.state).toBe('running'); // исход неизвестен, это НЕ failed
    expect(lostView.connectionLost).toBe(true);
    const lostResult = await fetch(`${h.base}/v1/runs/${inFlightReceipt.runId}/result`, { headers: authHeader(alphaKey) });
    expect(lostResult.status).toBe(409);
    expect(await lostResult.json()).toMatchObject({ error: { code: 'RESULT_NOT_READY' } });
    const lostEvents = (await (await fetch(`${h.base}/v1/runs/${inFlightReceipt.runId}/events?cursor=0&limit=1000`, { headers: authHeader(alphaKey) })).json()) as { events: Array<{ type: string }> };
    expect(lostEvents.events.filter((event) => event.type === 'claimed')).toHaveLength(1); // авто-rerun нет

    // AC-69: прежний экземпляр останавливают перед новым (у нас — cancel осиротевшей попытки)
    await fetch(`${h.base}/v1/runs/${inFlightReceipt.runId}/cancel`, {
      method: 'POST',
      headers: { ...authHeader(alphaKey), 'content-type': 'application/json' },
      body: '{}',
    });
    await waitFor(async () => {
      const res = await getStatus(h.base, alphaKey, inFlightReceipt.runId);
      return ((await res.json()) as { state: string }).state === 'cancelled';
    }, 8000, 'orphaned run cancelled');

    // ---- AC-69 resume: новая попытка = новый runId, тот же userTaskId, поколение+1
    const resumed = await postSubmit(h.base, alphaKey, 'cp-req-4', body);
    expect(resumed.status).toBe(202);
    const resumedReceipt = (await resumed.json()) as { runId: string; userTaskId: string };
    expect(resumedReceipt.runId).not.toBe(inFlightReceipt.runId);
    expect(resumedReceipt.userTaskId).toBe(taskId);
    const resumedView = (await (await getStatus(h.base, alphaKey, resumedReceipt.runId)).json()) as { ownerGeneration: number; conversationId: string };
    expect(resumedView.ownerGeneration).toBeGreaterThan(1);
    expect(resumedView.conversationId).toBe(conversationId);

    // ---- декларация, которую прочитает адаптер CP
    const caps = (await (await fetch(`${h.base}/v1/capabilities`, { headers: authHeader(alphaKey) })).json()) as {
      interaction: { engineResume: string; continuation: { policy: string } };
      disconnect: { autoRerunOnDisconnect: boolean };
    };
    expect(caps.interaction.engineResume).toBe('unsupported');
    expect(caps.interaction.continuation.policy).toBe('new_run_same_user_task');
    expect(caps.disconnect.autoRerunOnDisconnect).toBe(false);
  }, 120000);
});
