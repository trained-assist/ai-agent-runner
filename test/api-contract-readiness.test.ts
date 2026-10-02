import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src/storage/artifact-store.js';
import { createLocalFsBlobStore } from '../src/storage/local-fs.js';
import {
  alphaKey,
  authHeader,
  betaKey,
  getStatus,
  noScopeKey,
  postSubmit,
  startHttpHarness,
  submitBody,
  waitForAsync as waitFor,
} from './api-http-harness.js';

// Контрактная готовность Runner под шаги 2 и 4 эпика M1
// (trained-assist/trained-agent-architecture#109, SERVERLESS-AGENT-API.md):
//   1) GET /v1/capabilities — декларация возможностей (resume/awaiting/continuation);
//   2) GET /v1/runs/{id}/artifacts — ссылки на артефакты рана для приёмника (шаг 4);
//   3) conversationId в status — приёмник проверяет «продолжение = тот же userTaskId и
//      conversationId, новый runId» (гейт #115), не полагаясь на свою память;
//   4) никаких credentials в capabilities/списке артефактов.

interface Capabilities {
  contract: { name: string; version: number };
  idempotency: { header: string; repeatWithSameKey: string; newAttemptRequires: string };
  states: string[];
  events: { cursor: boolean; replay: boolean; sse: boolean; lastEventId: boolean };
  disconnect: { connectionLostIsNotFailed: boolean; autoRerunOnDisconnect: boolean; outcomeUnknown: boolean };
  interaction: {
    awaitingUserInput: string;
    engineResume: string;
    continuation: { policy: string; userTaskIdStable: boolean; conversationIdStable: boolean; savedDataRefs: string[] };
  };
  artifacts: { listPerRun: boolean; download: boolean; shareLink: boolean; ingestEndpoint: string };
  cancel: { requestedReceipt: boolean; terminalConfirmation: boolean };
  engines: string[];
}

function artifactStore(rootDir: string): ArtifactStore {
  return new ArtifactStore({ rootDir, blob: createLocalFsBlobStore({ rootDir: join(rootDir, 'blobs') }) });
}

describe('GET /v1/capabilities: декларация, а не догадки (M1 шаги 2/4)', () => {
  it('требует ключ и объявляет resume/awaiting/continuation политику без секретов', async () => {
    const h = await startHttpHarness();

    const anonymous = await fetch(`${h.base}/v1/capabilities`);
    expect(anonymous.status).toBe(401);

    const response = await fetch(`${h.base}/v1/capabilities`, { headers: authHeader(alphaKey) });
    expect(response.status).toBe(200);
    const caps = (await response.json()) as Capabilities;

    expect(caps.contract.name).toBe('ai-agent-runner/serverless-agent-api');
    expect(caps.idempotency).toMatchObject({
      header: 'Idempotency-Key',
      repeatWithSameKey: 'same_receipt',
      newAttemptRequires: 'new_idempotency_key',
    });
    expect(caps.events).toMatchObject({ cursor: true, replay: true, sse: true, lastEventId: true });
    // Потеря связи = неизвестный исход, НЕ failed, без авто-rerun
    expect(caps.disconnect).toMatchObject({ connectionLostIsNotFailed: true, autoRerunOnDisconnect: false, outcomeUnknown: true });
    // Engine resume и awaiting_user не поддержаны — объявлено явно
    expect(caps.interaction.awaitingUserInput).toBe('unsupported');
    expect(caps.interaction.engineResume).toBe('unsupported');
    expect(caps.interaction.continuation).toMatchObject({
      policy: 'new_run_same_user_task',
      userTaskIdStable: true,
      conversationIdStable: true,
    });
    expect(caps.interaction.continuation.savedDataRefs).toEqual(['run_result', 'run_events', 'run_artifacts']);
    expect(caps.artifacts.listPerRun).toBe(true);
    expect(caps.engines.length).toBeGreaterThanOrEqual(1);
    expect(caps.states).toContain('running');

    const serialized = JSON.stringify(caps);
    expect(serialized).not.toContain(alphaKey);
    expect(serialized).not.toContain('keyHash');
  });
});

describe('GET /v1/runs/{id}/artifacts: ссылки на артефакты для приёмника (M1 шаг 4)', () => {
  it('отдаёт манифесты артефактов рана, изолирует по профилю, переживает restart', async () => {
    // ArtifactStore смотрит в тот же dataDir, что и AgentApi (манифесты лежат рядом
    // с state.json рана, как в проде — docs/API-SERVICE.md), поэтому dataDir задаём сами.
    const rootDir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-contract-'));
    const store = artifactStore(rootDir);
    const h = await startHttpHarness({ rootDir, artifacts: store });

    const submit = await postSubmit(h.base, alphaKey, 'artifacts-list-1', submitBody({ userTaskId: 'task-artifacts' }));
    expect(submit.status).toBe(202);
    const receipt = (await submit.json()) as { runId: string };
    await store.put({
      runId: receipt.runId,
      userTaskId: 'task-artifacts',
      profileId: 'profile-a',
      name: 'out.txt',
      mime: 'text/plain',
      bytes: 'artifact body',
      artifactId: 'art-list-1',
    });

    const response = await fetch(`${h.base}/v1/runs/${receipt.runId}/artifacts`, { headers: authHeader(alphaKey) });
    expect(response.status).toBe(200);
    const page = (await response.json()) as { runId: string; count: number; artifacts: Array<{ artifactId: string; name: string; size: number }> };
    expect(page.runId).toBe(receipt.runId);
    expect(page.count).toBe(1);
    expect(page.artifacts[0]).toMatchObject({ artifactId: 'art-list-1', name: 'out.txt', size: 'artifact body'.length });

    // Чужой principal (другой профиль) → 404, артефакт не протекает
    const foreign = await fetch(`${h.base}/v1/runs/${receipt.runId}/artifacts`, { headers: authHeader(betaKey) });
    expect(foreign.status).toBe(404);
    // Анонимно → 401
    const anonymous = await fetch(`${h.base}/v1/runs/${receipt.runId}/artifacts`);
    expect(anonymous.status).toBe(401);
    // Неизвестный run → 404
    const unknown = await fetch(`${h.base}/v1/runs/run_does_not_exist/artifacts`, { headers: authHeader(alphaKey) });
    expect(unknown.status).toBe(404);
    // Без scope runs:read → 403
    const noRead = await fetch(`${h.base}/v1/runs/${receipt.runId}/artifacts`, { headers: authHeader(noScopeKey) });
    expect(noRead.status).toBe(403);

    // Restart: манифесты переживают перезапуск процесса
    const report = await h.restart();
    expect(report.scanned).toBeGreaterThanOrEqual(1);
    const after = await fetch(`${h.base}/v1/runs/${receipt.runId}/artifacts`, { headers: authHeader(alphaKey) });
    expect(after.status).toBe(200);
    const afterPage = (await after.json()) as { count: number; artifacts: Array<{ artifactId: string }> };
    expect(afterPage.count).toBe(1);
    expect(afterPage.artifacts[0]!.artifactId).toBe('art-list-1');
  });
});

describe('conversationId в status + инвариант попытки (гейт #115)', () => {
  it('status отдаёт conversationId; потерянный ответ → тот же ран; новая попытка = новый runId, те же task/conversation, без скрытого rerun', async () => {
    const h = await startHttpHarness();
    const body = submitBody({ userTaskId: 'task-conv', conversationId: 'conv-7' });

    // Шаг 2 приёмки: потеряли HTTP-ответ после сохранения → повтор возвращает ту же задачу
    const first = await postSubmit(h.base, alphaKey, 'attempt-1', body);
    expect(first.status).toBe(202);
    const receipt1 = (await first.json()) as { runId: string; userTaskId: string; requestId: string };
    const lostResponse = await postSubmit(h.base, alphaKey, 'attempt-1', body);
    expect(lostResponse.status).toBe(200);
    expect((await lostResponse.json()) as { runId: string; deduplicated: boolean }).toMatchObject({
      runId: receipt1.runId,
      deduplicated: true,
    });

    await waitFor(async () => {
      const res = await getStatus(h.base, alphaKey, receipt1.runId);
      return ((await res.json()) as { state: string }).state === 'succeeded';
    }, 8000, 'first attempt to finish');

    const view1 = (await (await getStatus(h.base, alphaKey, receipt1.runId)).json()) as {
      conversationId: string;
      userTaskId: string;
      runId: string;
      ownerGeneration: number;
    };
    expect(view1.conversationId).toBe('conv-7');
    expect(view1.userTaskId).toBe('task-conv');
    expect(view1.ownerGeneration).toBe(1);

    // Новая попытка продолжения: явный новый Idempotency-Key → новый runId, тот же task/conversation,
    // поколение попытки увеличивается (никакого «тихого» повтора первой попытки).
    const second = await postSubmit(h.base, alphaKey, 'attempt-2', body);
    expect(second.status).toBe(202);
    const receipt2 = (await second.json()) as { runId: string; userTaskId: string; requestId: string };
    expect(receipt2.runId).not.toBe(receipt1.runId);
    expect(receipt2.userTaskId).toBe(receipt1.userTaskId);
    expect(receipt2.requestId).toBe(receipt1.requestId);

    const view2 = (await (await getStatus(h.base, alphaKey, receipt2.runId)).json()) as {
      conversationId: string;
      userTaskId: string;
      runId: string;
      ownerGeneration: number;
    };
    expect(view2.runId).toBe(receipt2.runId);
    expect(view2.userTaskId).toBe('task-conv');
    expect(view2.conversationId).toBe('conv-7');
    expect(view2.ownerGeneration).toBe(2);

    // Повтор старого ключа не создаёт третью попытку: задача отвечает своей текущей попыткой.
    const oldKey = await postSubmit(h.base, alphaKey, 'attempt-1', body);
    expect(oldKey.status).toBe(200);
    expect((await oldKey.json()) as { runId: string; deduplicated: boolean }).toMatchObject({
      runId: receipt2.runId,
      deduplicated: true,
    });

    // Никакого скрытого rerun: у первой попытки ровно один claimed, попыток ровно две
    const firstEvents = (await (await fetch(`${h.base}/v1/runs/${receipt1.runId}/events?cursor=0`, { headers: authHeader(alphaKey) })).json()) as {
      events: Array<{ type: string; userTaskId: string; ownerGeneration: number }>;
    };
    expect(firstEvents.events.filter((event) => event.type === 'claimed')).toHaveLength(1);
    for (const event of firstEvents.events) {
      expect(event.userTaskId).toBe('task-conv');
      expect(event.ownerGeneration).toBe(1);
    }
    const secondEvents = (await (await fetch(`${h.base}/v1/runs/${receipt2.runId}/events?cursor=0`, { headers: authHeader(alphaKey) })).json()) as {
      events: Array<{ type: string; userTaskId: string; ownerGeneration: number }>;
    };
    expect(secondEvents.events.filter((event) => event.type === 'claimed')).toHaveLength(1);
    expect(secondEvents.events.every((event) => event.ownerGeneration === 2)).toBe(true);
  });

  it('вторая попытка задачи, пока первая активна, отклоняется (TASK_ATTEMPT_ACTIVE)', async () => {
    const h = await startHttpHarness({ scenario: 'timeout' });
    const body = submitBody({ userTaskId: 'task-active', conversationId: 'conv-active', limits: { timeoutMs: 60000 } });

    const first = await postSubmit(h.base, alphaKey, 'active-1', body);
    expect(first.status).toBe(202);
    const receipt1 = (await first.json()) as { runId: string };
    await waitFor(async () => {
      const res = await getStatus(h.base, alphaKey, receipt1.runId);
      return ((await res.json()) as { state: string }).state === 'running';
    }, 8000, 'first attempt running');

    // Сигнал продолжения без завершения первой попытки не создаёт второй run
    const retry = await postSubmit(h.base, alphaKey, 'active-2', body);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: 'TASK_ATTEMPT_ACTIVE' } });

    await fetch(`${h.base}/v1/runs/${receipt1.runId}/cancel`, {
      method: 'POST',
      headers: { ...authHeader(alphaKey), 'content-type': 'application/json' },
      body: '{}',
    });
    await waitFor(async () => {
      const res = await getStatus(h.base, alphaKey, receipt1.runId);
      return ((await res.json()) as { state: string }).state === 'cancelled';
    }, 8000, 'first attempt cancelled');
  });
});
