import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DispatchOwnerStore } from '../src/release/dispatch-owner.js';
import { validateReleaseManifest, type ReleaseManifest } from '../src/release/manifest.js';
import { PromotionJournal, ReleaseStateController } from '../src/release/promotion.js';
import type { PromotionRuntime } from '../src/api/service.js';
import {
  alphaKey,
  authHeader,
  betaKey,
  getStatus,
  noScopeKey,
  postSubmit,
  readerKey,
  startHttpHarness,
  submitBody,
  waitForAsync as waitFor,
  type HttpHarness,
} from './api-http-harness.js';

const COMMIT = 'b'.repeat(40);
/** Каталог стенда удаляет сам harness; extraDir — наш, его чистим после теста. */
const extraDirs: string[] = [];

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function extraDir(prefix: string): string {
  const dir = tempDir(prefix);
  extraDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (extraDirs.length > 0) {
    const dir = extraDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Промоушен-контур для HTTP-стенда. Манифест собирается на каждый воркер: workerId, порт и
 * корни различаются, релиз и paid-политика общие. Значений секретов в манифесте нет.
 */
function promotionFor(options: {
  rootDir: string;
  workerId: string;
  port: number;
  cohort?: { mode: 'off' | 'allowlist' | 'percentage'; principals?: string[]; rolloutPercent?: number };
  ownerStorePath?: string;
  releaseId?: string;
  statePath?: string;
  previousReleaseId?: string | null;
}): () => PromotionRuntime {
  const releaseId = options.releaseId ?? 'r2';
  const cohortId = options.cohort?.mode === 'off' ? 'off' : 'c-p29';
  const statePath = options.statePath ?? join(options.rootDir, 'release-state.json');
  return () => {
    const manifestResult = validateReleaseManifest({
      schemaVersion: 1,
      releaseId,
      sourceCommit: COMMIT,
      configVersion: 3,
      builtAt: '2026-10-03T08:00:00.000Z',
      engines: ['fake'],
      paid: { engines: ['opencode'], allowed: false },
      bindings: [{ name: 'AGENT_API_KEY_REGISTRY', required: true, source: 'env:/etc/agent-runner-fleet/p29/worker.env', owner: 'operator' }],
      retention: { mainEventsDays: 30, verboseLogsDays: 7 },
      host: {
        workerId: options.workerId,
        region: 'sandbox-eu',
        environment: 'sandbox',
        roles: { schedule: false, delivery: false },
        roots: { dataDir: options.rootDir, configDir: join(options.rootDir, 'config') },
        endpoint: { host: '127.0.0.1', port: options.port },
        configVersion: 3,
      },
    });
    if (!manifestResult.ok) throw new Error(`bad test manifest: ${manifestResult.errors.join('; ')}`);
    const manifest: ReleaseManifest = manifestResult.value;
    const journal = new PromotionJournal({
      path: join(options.rootDir, 'promotion.jsonl'),
      releaseId,
      workerId: options.workerId,
      region: 'sandbox-eu',
    });
    const state = new ReleaseStateController({
      path: statePath,
      releaseId,
      previousReleaseId: options.previousReleaseId === undefined ? 'r1' : options.previousReleaseId,
      journal,
      cohortId,
    });
    const runtime: PromotionRuntime = {
      manifest,
      cohort:
        options.cohort === undefined || options.cohort.mode === 'off'
          ? { cohortId: 'off', mode: 'off', principals: [], rolloutPercent: 0 }
          : {
              cohortId,
              mode: options.cohort.mode,
              principals: options.cohort.principals ?? [],
              rolloutPercent: options.cohort.rolloutPercent ?? 0,
            },
      state,
      journal,
    };
    if (options.ownerStorePath) {
      runtime.owners = new DispatchOwnerStore({ path: options.ownerStorePath, workerId: options.workerId });
    }
    return runtime;
  };
}

interface ReleaseViewJson {
  schemaVersion: number;
  release: {
    releaseId: string;
    sourceCommit: string;
    configVersion: number;
    workerId: string;
    region: string;
    environment: string;
    paidProfilesAllowed: boolean;
    engines: string[];
    paidEngines: string[];
  };
  bindings: Array<{ name: string; required: boolean; source: string; owner: string }>;
  cohort: { cohortId: string; mode: string; rolloutPercent: number; principals: number };
  rollback: {
    releaseId: string;
    servingReleaseId: string;
    previousReleaseId: string | null;
    rolledBack: boolean;
    transitions: number;
  };
  retention: { policy: { mainEventsDays: number; verboseLogsDays: number }; removalPerformed: boolean };
  fleet: { workerId: string; draining: boolean; owned: number; drainingTasks: number; owners: Array<{ workerId: string; tasks: number }> } | null;
  journal: { entries: number; lastSeq: number; lastKind: string | null };
}

async function releaseView(harness: HttpHarness, key = alphaKey): Promise<ReleaseViewJson> {
  const response = await fetch(`${harness.base}/v1/release`, { headers: authHeader(key) });
  expect(response.status).toBe(200);
  return (await response.json()) as ReleaseViewJson;
}

describe('GET /v1/release: закреплённый релиз наружу (AC-170)', () => {
  it('требует ключ и область, отдаёт релиз/когорту/откат/retention без значений секретов', async () => {
    const rootDir = tempDir('ai-agent-runner-p29-release-');
    const h = await startHttpHarness({ rootDir, promotion: promotionFor({ rootDir, workerId: 'sb-a', port: 8788, cohort: { mode: 'allowlist', principals: ['p-alpha'] } }) });

    expect((await fetch(`${h.base}/v1/release`)).status).toBe(401);
    expect((await fetch(`${h.base}/v1/release`, { headers: authHeader(noScopeKey) })).status).toBe(403);

    const view = await releaseView(h);
    expect(view).toMatchObject({
      schemaVersion: 1,
      release: { releaseId: 'r2', sourceCommit: COMMIT, configVersion: 3, workerId: 'sb-a', region: 'sandbox-eu', environment: 'sandbox', paidProfilesAllowed: false, engines: ['fake'], paidEngines: ['opencode'] },
      cohort: { cohortId: 'c-p29', mode: 'allowlist', principals: 1, rolloutPercent: 0 },
      rollback: { releaseId: 'r2', servingReleaseId: 'r2', rolledBack: false },
      retention: { policy: { mainEventsDays: 30, verboseLogsDays: 7 }, removalPerformed: false },
      fleet: null,
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toMatch(new RegExp(alphaKey));
    expect(serialized).not.toMatch(new RegExp(betaKey));
    expect(serialized).not.toMatch(new RegExp(readerKey));
    // В bindings — только имена и источники, значений нет.
    expect(view.bindings).toEqual([{ name: 'AGENT_API_KEY_REGISTRY', required: true, source: 'env:/etc/agent-runner-fleet/p29/worker.env', owner: 'operator' }]);

    const caps = (await (await fetch(`${h.base}/v1/capabilities`, { headers: authHeader(alphaKey) })).json()) as {
      promotion: Record<string, unknown>;
    };
    expect(caps.promotion).toMatchObject({
      pinnedRelease: { releaseId: 'r2', sourceCommit: COMMIT, configVersion: 3 },
      cohortEnabled: true,
      cohortId: 'c-p29',
      rollbackAvailable: true,
      rolledBack: false,
      paidProfilesAllowed: false,
      sharedOwnerRegistry: false,
      partitionIsNotFailover: true,
      releaseEndpoint: '/v1/release',
    });
  });

  it('установка без promotion-контура объявляет отсутствие когорты, а не «всё включено»', async () => {
    const h = await startHttpHarness();
    expect((await fetch(`${h.base}/v1/release`, { headers: authHeader(alphaKey) })).status).toBe(404);
    const caps = (await (await fetch(`${h.base}/v1/capabilities`, { headers: authHeader(alphaKey) })).json()) as { promotion: Record<string, unknown> };
    expect(caps.promotion).toMatchObject({ cohortEnabled: false, rollbackAvailable: false, pinnedRelease: null, paidProfilesAllowed: null });
  });
});

describe('приём по флагу когорты и paid-профилям (AC-170, AC-12)', () => {
  it('принципал вне когорты получает 403 и не оставляет ни записи, ни рана', async () => {
    const rootDir = tempDir('ai-agent-runner-p29-cohort-');
    const h = await startHttpHarness({ rootDir, promotion: promotionFor({ rootDir, workerId: 'sb-a', port: 8788, cohort: { mode: 'allowlist', principals: ['p-beta'] } }) });

    const refused = await postSubmit(h.base, alphaKey, 'idem-outside', submitBody());
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe('COHORT_NOT_ENABLED');
    expect(body.error.details).toMatchObject({ cohortId: 'c-p29', mode: 'allowlist', reason: 'outside_allowlist' });

    expect(h.service.store.listAll()).toHaveLength(0);
    expect(h.service.runner.listRunIds()).toEqual([]);
    const refusals = h.logs.filter((entry) => entry['event'] === 'admission_refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ code: 'COHORT_NOT_ENABLED', principalId: 'p-alpha' });

    // Принципал из когорты проходит — флаг реально переключает приём.
    const accepted = await postSubmit(h.base, betaKey, 'idem-inside', submitBody());
    expect(accepted.status).toBe(202);
    await waitFor(async () => ((await getStatus(h.base, betaKey, ((await accepted.json()) as { runId: string }).runId)).status === 200));
  });

  it('платный движок отключён по умолчанию: 403 до запуска, даже если принципалу он разрешён', async () => {
    const rootDir = tempDir('ai-agent-runner-p29-paid-');
    // p-beta в стенде без allowlist движков: отказ приходит именно от политики релиза,
    // а не от per-principal ограничения (оно проверяется отдельно, ENGINE_NOT_ALLOWED).
    const h = await startHttpHarness({ rootDir, promotion: promotionFor({ rootDir, workerId: 'sb-a', port: 8788, cohort: { mode: 'allowlist', principals: ['p-beta'] } }) });

    const paid = await postSubmit(
      h.base,
      betaKey,
      'idem-paid',
      submitBody({ engine: { name: 'opencode', adapterVersion: '1' }, limits: { timeoutMs: 5000 } }),
    );
    expect(paid.status).toBe(403);
    const body = (await paid.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(body.error.code).toBe('PAID_PROFILE_DISABLED');
    expect(body.error.details).toMatchObject({ engine: 'opencode', freeEngines: ['fake'], paidEngines: ['opencode'], paidProfilesAllowed: false });
    expect(h.service.store.listAll()).toHaveLength(0);
    expect(h.service.runner.listRunIds()).toEqual([]);
  });

  it('выключенная когорта не принимает никого, и это видно в capabilities', async () => {
    const rootDir = tempDir('ai-agent-runner-p29-cohort-off-');
    const h = await startHttpHarness({ rootDir, promotion: promotionFor({ rootDir, workerId: 'sb-a', port: 8788 }) });
    const refused = await postSubmit(h.base, alphaKey, 'idem-off', submitBody());
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('COHORT_NOT_ENABLED');
    const caps = (await (await fetch(`${h.base}/v1/capabilities`, { headers: authHeader(alphaKey) })).json()) as { promotion: Record<string, unknown> };
    expect(caps.promotion).toMatchObject({ cohortEnabled: false, cohortId: 'off' });
  });
});

describe('откат релиза прогоном (AC-324, AC-323)', () => {
  it('после отката новые задачи не принимаются, принятая рана доигрывает прежний владелец, replay цел', async () => {
    const rootDir = tempDir('ai-agent-runner-p29-rollback-');
    const statePath = join(extraDir('ai-agent-runner-p29-state-'), 'release-state.json');
    const factory = promotionFor({ rootDir, workerId: 'sb-a', port: 8788, cohort: { mode: 'allowlist', principals: ['p-alpha'] }, statePath, previousReleaseId: 'r1' });
    const h = await startHttpHarness({ rootDir, promotion: factory });

    // До отката приём идёт.
    const accepted = await postSubmit(h.base, alphaKey, 'idem-before-rollback', submitBody({ userTaskId: 'task-rollback' }));
    expect(accepted.status).toBe(202);
    const receipt = (await accepted.json()) as { runId: string; userTaskId: string };
    await waitFor(async () => {
      const status = (await (await getStatus(h.base, alphaKey, receipt.runId)).json()) as { state: string };
      return status.state === 'succeeded';
    });

    // Откат — действие развёртывания: состояние пишется на диск, сервис перезапускается.
    const controller = new ReleaseStateController({ path: statePath, releaseId: 'r2', previousReleaseId: 'r1' });
    controller.rollback('sandbox cohort error rate above the gate', 'operator-p29');
    await h.restart();

    const view = await releaseView(h);
    expect(view.rollback).toMatchObject({ releaseId: 'r2', servingReleaseId: 'r1', previousReleaseId: 'r2', rolledBack: true, transitions: 1 });

    const refused = await postSubmit(h.base, alphaKey, 'idem-after-rollback', submitBody({ userTaskId: 'task-after-rollback' }));
    expect(refused.status).toBe(503);
    const refusedBody = (await refused.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(refusedBody.error.code).toBe('PROMOTION_PAUSED');
    expect(refusedBody.error.details).toMatchObject({ servingReleaseId: 'r1', newAdmissions: 'refused', acceptedRuns: 'stay_with_current_owner' });
    expect(h.service.store.listAll()).toHaveLength(1);

    // Принятая до отката задача: результат и события читаются, реплей не разошёлся с receipt.
    const result = (await (await fetch(`${h.base}/v1/runs/${receipt.runId}/result`, { headers: authHeader(alphaKey) })).json()) as { outcome: string };
    expect(result.outcome).toBe('succeeded');
    const events = (await (await fetch(`${h.base}/v1/runs/${receipt.runId}/events`, { headers: authHeader(alphaKey) })).json()) as {
      events: Array<{ sequence: number; type: string; userTaskId: string }>;
      snapshot: { state: string };
    };
    expect(events.events.map((event) => event.sequence)).toEqual(events.events.map((_, index) => index + 1));
    expect(events.events.filter((event) => event.type === 'claimed')).toHaveLength(1);
    expect(events.events.every((event) => event.userTaskId === 'task-rollback')).toBe(true);
    expect(events.snapshot.state).toBe('succeeded');

    // Идемпотентный повтор ранее принятого запроса не сломался от отката.
    const replay = await postSubmit(h.base, alphaKey, 'idem-before-rollback', submitBody({ userTaskId: 'task-rollback' }));
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { runId: string }).runId).toBe(receipt.runId);

    // Возврат: приём возобновляется тем же релизом.
    controller.resume('gate green in sandbox', 'operator-p29');
    await h.restart();
    expect((await releaseView(h)).rollback).toMatchObject({ servingReleaseId: 'r2', rolledBack: false, transitions: 2 });
    expect((await postSubmit(h.base, alphaKey, 'idem-after-resume', submitBody({ userTaskId: 'task-after-resume' }))).status).toBe(202);
  });
});

describe('два воркера на одной VM: один владелец, никакого двойного запуска (AC-322, AC-323)', () => {
  it('второй воркер получает 409, перехват только по сигналу, после перехвата прежний fenced', async () => {
    const fleetDir = extraDir('ai-agent-runner-p29-fleet-');
    const ownerStorePath = join(fleetDir, 'owners.json');
    const rootA = tempDir('ai-agent-runner-p29-worker-a-');
    const rootB = tempDir('ai-agent-runner-p29-worker-b-');

    const a = await startHttpHarness({
      rootDir: rootA,
      promotion: promotionFor({ rootDir: rootA, workerId: 'sb-a', port: 8788, cohort: { mode: 'allowlist', principals: ['p-alpha'] }, ownerStorePath }),
    });
    const b = await startHttpHarness({
      rootDir: rootB,
      promotion: promotionFor({ rootDir: rootB, workerId: 'sb-b', port: 8789, cohort: { mode: 'allowlist', principals: ['p-alpha'] }, ownerStorePath }),
    });

    const sharedTask = 'task-shared';
    const first = await postSubmit(a.base, alphaKey, 'idem-a-1', submitBody({ userTaskId: sharedTask }));
    expect(first.status).toBe(202);
    const receiptA = (await first.json()) as { runId: string; userTaskId: string };
    expect(receiptA.userTaskId).toBe(sharedTask);
    const statusA = (await (await getStatus(a.base, alphaKey, receiptA.runId)).json()) as { ownerGeneration: number; state: string };
    expect(statusA.ownerGeneration).toBe(1);

    // Второй воркер на ту же задачу: 409, у него не остаётся ни admission-записи, ни рана.
    const doubleDispatch = await postSubmit(b.base, alphaKey, 'idem-b-1', submitBody({ userTaskId: sharedTask }));
    expect(doubleDispatch.status).toBe(409);
    expect(((await doubleDispatch.json()) as { error: { code: string; details: Record<string, unknown> } }).error.details).toMatchObject({ ownerWorkerId: 'sb-a', ownerGeneration: 1 });
    expect(b.service.store.listAll()).toHaveLength(0);
    expect(b.service.runner.listRunIds()).toEqual([]);

    // Молчание сети ≠ failover: без явного сигнала перехвата нет.
    const storeB = new DispatchOwnerStore({ path: ownerStorePath, workerId: 'sb-b' });
    expect(storeB.takeover('p-alpha', sharedTask, 'run-b-preview')).toMatchObject({ outcome: 'partition_is_not_failover' });
    expect((await postSubmit(b.base, alphaKey, 'idem-b-2', submitBody({ userTaskId: sharedTask }))).status).toBe(409);

    // Прежний владелец отдаёт задачу (drain перед переключением) — это и есть сигнал.
    const storeA = new DispatchOwnerStore({ path: ownerStorePath, workerId: 'sb-a' });
    storeA.release('p-alpha', sharedTask, 'drain sb-a for the cohort switch');
    await a.restart();
    const takeover = await postSubmit(b.base, alphaKey, 'idem-b-3', submitBody({ userTaskId: sharedTask }));
    expect(takeover.status).toBe(202);
    const receiptB = (await takeover.json()) as { runId: string };
    expect(receiptB.runId).not.toBe(receiptA.runId);

    const statusB = (await (await getStatus(b.base, alphaKey, receiptB.runId)).json()) as { ownerGeneration: number; userTaskId: string; conversationId: string };
    expect(statusB).toMatchObject({ userTaskId: sharedTask, ownerGeneration: 2 });

    // Прежний владелец fenced: его поздняя попытка по этой задаче отклоняется, второй ран не запускается.
    const fenced = await postSubmit(a.base, alphaKey, 'idem-a-2', submitBody({ userTaskId: sharedTask }));
    expect(fenced.status).toBe(409);
    expect(((await fenced.json()) as { error: { code: string } }).error.code).toBe('TASK_OWNED_BY_OTHER_WORKER');
    expect(a.service.runner.listRunIds()).not.toContain(receiptB.runId);

    // Ровно одна активная попытка на задачу: у нового владельца один ран, его события без дублей.
    await waitFor(async () => {
      const status = (await (await getStatus(b.base, alphaKey, receiptB.runId)).json()) as { state: string };
      return status.state === 'succeeded';
    });
    const eventsB = (await (await fetch(`${b.base}/v1/runs/${receiptB.runId}/events`, { headers: authHeader(alphaKey) })).json()) as {
      events: Array<{ sequence: number; type: string; ownerGeneration: number }>;
    };
    expect(eventsB.events.map((event) => event.sequence)).toEqual(eventsB.events.map((_, index) => index + 1));
    expect(eventsB.events.filter((event) => event.type === 'claimed')).toHaveLength(1);
    expect(eventsB.events.every((event) => event.ownerGeneration === 2)).toBe(true);

    const viewB = await releaseView(b);
    expect(viewB.fleet).toMatchObject({ workerId: 'sb-b', owned: 1, draining: false });
    // В реестре задача принадлежит sb-b, а прежний владелец записан как источник перехода.
    expect(viewB.fleet?.owners.map((owner) => owner.workerId)).toEqual(['sb-b']);
    expect(storeB.get('p-alpha', sharedTask)).toMatchObject({ ownerWorkerId: 'sb-b', previousOwnerWorkerId: 'sb-a', ownerGeneration: 2 });
  });

  it('drain воркера: новые задачи не берутся, свои доигрываются прежним владельцем', async () => {
    const fleetDir = extraDir('ai-agent-runner-p29-drain-');
    const ownerStorePath = join(fleetDir, 'owners.json');
    const rootA = tempDir('ai-agent-runner-p29-drain-a-');
    const rootB = tempDir('ai-agent-runner-p29-drain-b-');
    const a = await startHttpHarness({
      rootDir: rootA,
      promotion: promotionFor({ rootDir: rootA, workerId: 'sb-a', port: 8788, cohort: { mode: 'allowlist', principals: ['p-alpha'] }, ownerStorePath }),
    });
    const b = await startHttpHarness({
      rootDir: rootB,
      promotion: promotionFor({ rootDir: rootB, workerId: 'sb-b', port: 8789, cohort: { mode: 'allowlist', principals: ['p-alpha'] }, ownerStorePath }),
    });

    const storeA = new DispatchOwnerStore({ path: ownerStorePath, workerId: 'sb-a' });
    storeA.drain('cohort switch: sb-a leaves admission');
    await a.restart();

    const refused = await postSubmit(a.base, alphaKey, 'idem-drain-a', submitBody({ userTaskId: 'task-drained' }));
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('WORKER_DRAINING');
    expect(a.service.runner.listRunIds()).toEqual([]);

    // Когорта ушла на другой воркер: задача принимается там же без двойного приёма.
    const onB = await postSubmit(b.base, alphaKey, 'idem-drain-b', submitBody({ userTaskId: 'task-drained' }));
    expect(onB.status).toBe(202);
    expect((await releaseView(a)).fleet).toMatchObject({ workerId: 'sb-a', draining: true, owned: 0 });
  });
});

describe('состояние релиза и владельца переживает перезапуск процесса', () => {
  it('журнал и состояние читаются с диска новым процессом, seq продолжается', async () => {
    const rootDir = tempDir('ai-agent-runner-p29-restart-');
    const statePath = join(extraDir('ai-agent-runner-p29-restart-state-'), 'release-state.json');
    const h = await startHttpHarness({
      rootDir,
      promotion: promotionFor({ rootDir, workerId: 'sb-a', port: 8788, cohort: { mode: 'percentage', rolloutPercent: 100 }, statePath }),
    });

    expect((await postSubmit(h.base, alphaKey, 'idem-restart', submitBody())).status).toBe(202);
    await h.restart();

    const view = await releaseView(h);
    expect(view.cohort).toMatchObject({ mode: 'percentage', rolloutPercent: 100 });
    expect(view.journal).toMatchObject({ entries: 0, lastSeq: 0 });
    // Повторный приём после рестарта работает и не создаёт второй ран.
    expect((await postSubmit(h.base, alphaKey, 'idem-restart', submitBody())).status).toBe(200);

    const journalPath = join(rootDir, 'promotion.jsonl');
    const journal = new PromotionJournal({ path: journalPath, releaseId: 'r2', workerId: 'sb-a' });
    journal.append({ kind: 'promoted', reason: 'after restart' });
    const entries = new PromotionJournal({ path: journalPath, releaseId: 'r2' }).append({ kind: 'cohort_configured', reason: 'second process' });
    expect(entries.seq).toBe(2);
    writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, releaseId: 'r-other', servingReleaseId: 'r-other', previousReleaseId: null, rolledBack: false, reason: null, updatedAt: '2026-10-03T00:00:00.000Z', transitions: 0 }));
    await expect(h.restart()).rejects.toThrow(/release state belongs to r-other/);
  });
});