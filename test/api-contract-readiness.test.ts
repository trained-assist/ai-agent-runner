import { describe, expect, it } from 'vitest';
import {
  alphaKey,
  authHeader,
  betaKey,
  getArtifacts,
  postSubmit,
  startHttpHarness,
  submitBody,
  waitForTerminal,
} from './api-http-harness.js';

/**
 * Контрактная готовность stateless API (epic #74): capabilities, артефакты-ссылки на GitHub и
 * инвариант «продолжение = тот же userTaskId/conversationId, новый runId».
 */

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
  artifacts: { listPerRun: boolean; download: boolean; shareLink: boolean; ingestEndpoint: string; export: { enabled: boolean } };
  isolation: { mode: string; launcher: string | null };
  cancel: { requestedReceipt: boolean; terminalConfirmation: boolean };
  engines: string[];
}

describe('GET /v1/capabilities: декларация, а не догадки (#74)', () => {
  it('требует ключ и объявляет политику продолжения, честную изоляцию и один движок', async () => {
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
    expect(caps.disconnect.outcomeUnknown).toBe(true);
    expect(caps.disconnect.autoRerunOnDisconnect).toBe(false);
    expect(caps.interaction.awaitingUserInput).toBe('unsupported');
    expect(caps.interaction.engineResume).toBe('unsupported');
    expect(caps.interaction.continuation.policy).toBe('new_run_same_user_task');
    expect(caps.interaction.continuation.savedDataRefs).toEqual(['run_result', 'run_events', 'run_artifacts']);

    // Никакой изоляции на хосте API и никакого экспорта байтов.
    expect(caps.isolation.mode).toBe('none');
    expect(caps.isolation.launcher).toBeNull();
    expect(caps.artifacts.export.enabled).toBe(false);
    expect(caps.artifacts.download).toBe(false);
    expect(caps.artifacts.shareLink).toBe(false);
    expect(caps.artifacts.ingestEndpoint).toBe('absent');
    expect(caps.artifacts.listPerRun).toBe(true);
    expect(caps.engines).toEqual(['dynamic-ip-azure-agent-run']);
    expect(caps.cancel).toEqual({ requestedReceipt: true, terminalConfirmation: true });

    // Никаких credentials в декларации.
    expect(JSON.stringify(caps)).not.toMatch(/token|secret|password/i);
  });
});

describe('GET /v1/runs/{id}/artifacts: ссылки на GitHub, а не байты (#74, шаг 4)', () => {
  it('отдаёт адрес файла в коммите юзеровского репозитория и ссылку на лог в GCS', async () => {
    const h = await startHttpHarness();
    const submit = await postSubmit(h.base, alphaKey, 'idem-artifacts', submitBody({ outputs: [{ path: 'report.md' }] }));
    const receipt = (await submit.json()) as { runId: string };
    await waitForTerminal(h.base, alphaKey, receipt.runId);

    const view = (await (await getArtifacts(h.base, alphaKey, receipt.runId)).json()) as {
      runId: string;
      repo: { fullName: string; commit: string };
      count: number;
      logUrl: string;
      artifacts: Array<{ path: string; name: string; mime: string; size: number; sha256: string; url: string }>;
      note: string;
    };
    expect(view.runId).toBe(receipt.runId);
    expect(view.repo).toEqual({ fullName: 'owner/name', commit: 'abc1234' });
    expect(view.count).toBe(1);
    expect(view.artifacts[0]).toMatchObject({
      path: 'report.md',
      name: 'report.md',
      mime: 'text/markdown',
      size: 1234,
      url: 'https://github.com/owner/name/blob/abc1234/report.md',
    });
    expect(view.artifacts[0]!.sha256).toHaveLength(64);
    expect(view.logUrl).toMatch(/^https:\/\/storage\.googleapis\.com\//);
    expect(view.note).toContain('the API stores no bytes');
    // В ответе нет ни байт, ни base64 — только ссылки и метаданные.
    expect(Object.keys(view.artifacts[0]!).sort()).toEqual(['mime', 'name', 'path', 'sha256', 'size', 'url']);
  });

  it('чужой ран — NOT_FOUND: артефакты отдаются только владельцу', async () => {
    const h = await startHttpHarness();
    const submit = await postSubmit(h.base, alphaKey, 'idem-artifacts-owner', submitBody());
    const receipt = (await submit.json()) as { runId: string };
    await waitForTerminal(h.base, alphaKey, receipt.runId);
    const foreign = await getArtifacts(h.base, betaKey, receipt.runId);
    expect(foreign.status).toBe(404);
  });
});

describe('conversationId в status + инвариант попытки (гейт #115)', () => {
  it('status отдаёт conversationId; новая попытка = новый runId, те же task/conversation, без скрытого rerun', async () => {
    const h = await startHttpHarness();
    const submit = await postSubmit(h.base, alphaKey, 'idem-attempt-1', submitBody({ userTaskId: 'task-gate', conversationId: 'conv-gate' }));
    const first = (await submit.json()) as { runId: string; requestId: string };
    await waitForTerminal(h.base, alphaKey, first.runId);

    const firstStatus = (await (await fetch(`${h.base}/v1/runs/${first.runId}/status`, { headers: authHeader(alphaKey) })).json()) as {
      conversationId: string;
      userTaskId: string;
      requestId: string;
    };
    expect(firstStatus.conversationId).toBe('conv-gate');
    expect(firstStatus.userTaskId).toBe('task-gate');
    expect(firstStatus.requestId).toBe(first.requestId);

    // Новый Idempotency-Key = новая попытка, а не перезапуск прошлого рана.
    const retry = await postSubmit(h.base, alphaKey, 'idem-attempt-2', submitBody({ userTaskId: 'task-gate', conversationId: 'conv-gate' }));
    const second = (await retry.json()) as { runId: string; requestId: string };
    expect(second.runId).not.toBe(first.runId);
    expect(second.requestId).toBe(first.requestId);
    await waitForTerminal(h.base, alphaKey, second.runId);

    const secondStatus = (await (await fetch(`${h.base}/v1/runs/${second.runId}/status`, { headers: authHeader(alphaKey) })).json()) as {
      conversationId: string;
      userTaskId: string;
      ownerGeneration: number;
    };
    expect(secondStatus.conversationId).toBe('conv-gate');
    expect(secondStatus.userTaskId).toBe('task-gate');
    expect(secondStatus.ownerGeneration).toBe(2);
  });

  it('вторая попытка задачи, пока первая активна, отклоняется (TASK_ATTEMPT_ACTIVE)', async () => {
    const h = await startHttpHarness({ worker: { delayMs: 400 } });
    const first = await postSubmit(h.base, alphaKey, 'idem-active-1', submitBody({ userTaskId: 'task-active' }));
    expect(first.status).toBe(202);
    const conflict = await postSubmit(h.base, alphaKey, 'idem-active-2', submitBody({ userTaskId: 'task-active' }));
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe('TASK_ATTEMPT_ACTIVE');
  });
});
