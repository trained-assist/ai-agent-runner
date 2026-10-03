import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DispatchOwnerStore } from '../src/release/dispatch-owner.js';
import { validateReleaseManifest, type ReleaseManifest } from '../src/release/manifest.js';
import { validatePlacementPolicy, type PlacementPolicy } from '../src/release/placement.js';
import { PromotionJournal, ReleaseStateController } from '../src/release/promotion.js';
import type { PromotionRuntime } from '../src/api/service.js';
import { createHarness } from './helpers.js';
import {
  alphaKey,
  authHeader,
  betaKey,
  getStatus,
  postSubmit,
  startHttpHarness,
  submitBody,
  waitForAsync as waitFor,
  type HttpHarness,
} from './api-http-harness.js';

const COMMIT = 'c'.repeat(40);
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

const PLACEMENT: PlacementPolicy = {
  schemaVersion: 1,
  policyId: 'p30-api-test',
  authority: 'sandbox_probe',
  decisionRef: 'https://github.com/trained-assist/trained-agent-architecture/issues/69 (симуляция P30, не утверждённая политика RU/EU)',
  engines: {
    fake: { allowedRegions: ['sandbox-ru', 'sandbox-eu'], explicitProfileRef: 'sandbox-free-profile' },
    opencode: {
      allowedRegions: ['sandbox-ru', 'sandbox-eu'],
      explicitProfileRef: 'sandbox-free-profile',
      providers: {
        'free-ladder': { allowedRegions: ['sandbox-ru', 'sandbox-eu'] },
        zen: { allowedRegions: ['sandbox-eu'] },
      },
    },
    claude: { allowedRegions: ['sandbox-eu'], explicitProfileRef: null },
    codex: { allowedRegions: ['sandbox-eu'], explicitProfileRef: null },
  },
  credentialScopes: {
    'llm:call': { regions: ['sandbox-eu'] },
    'sandbox:fixture': { regions: ['sandbox-ru', 'sandbox-eu'] },
  },
  dataResidency: { decided: false, decisionRef: null, regions: [] },
};

function placementFor(rootDir: string, workerId: string, region: string): PlacementPolicy {
  const result = validatePlacementPolicy({ ...PLACEMENT, policyId: `p30-api-test-${workerId}` });
  if (!result.ok) throw new Error(`bad placement policy: ${result.errors.join('; ')}`);
  return result.value;
}

/**
 * Промоушен-контур двух воркеров одной VM: разные workerId/region/корни, общий релиз и общий
 * реестр владения (P29), плюс политика размещения (P30).
 */
function promotionFor(options: { rootDir: string; workerId: string; region: string; ownerStorePath?: string }): () => PromotionRuntime {
  const releaseId = 'r2';
  const statePath = join(options.rootDir, 'release-state.json');
  return () => {
    const manifestResult = validateReleaseManifest({
      schemaVersion: 1,
      releaseId,
      sourceCommit: COMMIT,
      configVersion: 3,
      builtAt: '2026-10-03T08:00:00.000Z',
      engines: ['fake'],
      paid: { engines: ['opencode', 'claude', 'codex'], allowed: false },
      bindings: [{ name: 'AGENT_API_KEY_REGISTRY', required: true, source: 'env:/etc/agent-runner-fleet/p30/worker.env', owner: 'operator' }],
      retention: { mainEventsDays: 30, verboseLogsDays: 7 },
      host: {
        workerId: options.workerId,
        region: options.region,
        environment: 'sandbox',
        roles: { schedule: false, delivery: false },
        roots: { dataDir: options.rootDir, configDir: join(options.rootDir, 'config') },
        endpoint: { host: '127.0.0.1', port: 8788 },
        configVersion: 3,
      },
    });
    if (!manifestResult.ok) throw new Error(`bad test manifest: ${manifestResult.errors.join('; ')}`);
    const manifest: ReleaseManifest = manifestResult.value;
    const journal = new PromotionJournal({ path: join(options.rootDir, 'promotion.jsonl'), releaseId, workerId: options.workerId, region: options.region });
    const state = new ReleaseStateController({ path: statePath, releaseId, previousReleaseId: 'r1', journal, cohortId: 'c-p30' });
    const runtime: PromotionRuntime = {
      manifest,
      cohort: { cohortId: 'c-p30', mode: 'allowlist', principals: ['p-alpha', 'p-beta'], rolloutPercent: 0 },
      state,
      journal,
      placement: placementFor(options.rootDir, options.workerId, options.region),
    };
    if (options.ownerStorePath) {
      runtime.owners = new DispatchOwnerStore({ path: options.ownerStorePath, workerId: options.workerId });
    }
    return runtime;
  };
}

async function startWorker(options: { rootDir: string; workerId: string; region: string; ownerStorePath?: string; scenario?: 'success' | 'timeout' }): Promise<HttpHarness> {
  return startHttpHarness({
    rootDir: options.rootDir,
    hostRegion: options.region,
    scenario: options.scenario ?? 'success',
    promotion: promotionFor(options),
  });
}

function refusalCode(response: Response): Promise<string> {
  return response.json().then((body) => (body as { error: { code: string } }).error.code);
}

describe('два воркера на одной VM: регион/провайдер/credentials на приёме (AC-174)', () => {
  it('Claude и Codex не в RU; в EU — только с явным профилем; отказ до записи рана', async () => {
    const rootA = tempDir('ai-agent-runner-p30-ru-');
    const rootB = tempDir('ai-agent-runner-p30-eu-');
    const a = await startWorker({ rootDir: rootA, workerId: 'sb-ru', region: 'sandbox-ru' });
    const b = await startWorker({ rootDir: rootB, workerId: 'sb-eu', region: 'sandbox-eu' });

    // p-beta в стенде без per-principal списка движков: отказ приходит от политики размещения,
    // а не от ENGINE_NOT_ALLOWED (per-principal ограничение проверяется отдельно).
    const claudeOnRu = await postSubmit(a.base, betaKey, 'idem-claude-ru', submitBody({ engine: { name: 'claude', adapterVersion: '1' } }));
    expect(claudeOnRu.status).toBe(403);
    expect(await refusalCode(claudeOnRu)).toBe('REGION_ENGINE_FORBIDDEN');
    const codexOnRu = await postSubmit(a.base, betaKey, 'idem-codex-ru', submitBody({ engine: { name: 'codex', adapterVersion: '1' } }));
    expect(codexOnRu.status).toBe(403);
    expect(await refusalCode(codexOnRu)).toBe('REGION_ENGINE_FORBIDDEN');

    const claudeOnEu = await postSubmit(b.base, betaKey, 'idem-claude-eu', submitBody({ engine: { name: 'claude', adapterVersion: '1' } }));
    expect(claudeOnEu.status).toBe(403);
    expect(await refusalCode(claudeOnEu)).toBe('REGION_EXPLICIT_PROFILE_REQUIRED');

    // Отказ по размещению не оставляет ни admission-записи, ни рана.
    expect(a.service.store.listAll()).toEqual([]);
    expect(a.service.runner.listRunIds()).toEqual([]);
    expect(b.service.store.listAll()).toEqual([]);
    expect(b.service.runner.listRunIds()).toEqual([]);
    const refusals = [...a.logs, ...b.logs].filter((entry) => entry['event'] === 'placement_refused');
    expect(refusals).toHaveLength(3);
    expect(refusals.every((entry) => typeof entry['reason'] === 'string' && (entry['reason'] as string).length > 0)).toBe(true);
  });

  it('OpenCode: провайдер решает по региону; разрешённый провайдер упирается в paid-флаг, а не в регион', async () => {
    const rootA = tempDir('ai-agent-runner-p30-ru-');
    const rootB = tempDir('ai-agent-runner-p30-eu-');
    const a = await startWorker({ rootDir: rootA, workerId: 'sb-ru', region: 'sandbox-ru' });
    const b = await startWorker({ rootDir: rootB, workerId: 'sb-eu', region: 'sandbox-eu' });

    const zenOnRu = await postSubmit(
      a.base,
      betaKey,
      'idem-zen-ru',
      submitBody({ engine: { name: 'opencode', adapterVersion: '1', modelSettings: { model: 'zen/grok' } } }),
    );
    expect(zenOnRu.status).toBe(403);
    expect(await refusalCode(zenOnRu)).toBe('PROVIDER_REGION_FORBIDDEN');

    // В EU тот же провайдер разрешён политикой: дальше отказ по платному флагу — это и есть
    // доказательство, что региональный гейт пройден, а не замаскирован оплатой.
    const zenOnEu = await postSubmit(
      b.base,
      betaKey,
      'idem-zen-eu',
      submitBody({ engine: { name: 'opencode', adapterVersion: '1', modelSettings: { model: 'zen/grok' } } }),
    );
    expect(zenOnEu.status).toBe(403);
    expect(await refusalCode(zenOnEu)).toBe('PAID_PROFILE_DISABLED');

    const ladderOnRu = await postSubmit(
      a.base,
      betaKey,
      'idem-ladder-ru',
      submitBody({ engine: { name: 'opencode', adapterVersion: '1', modelSettings: { model: 'free-ladder/grok' } } }),
    );
    expect(ladderOnRu.status).toBe(403);
    expect(await refusalCode(ladderOnRu)).toBe('PAID_PROFILE_DISABLED');
  });

  it('credential scope и резидентность отказывают до запуска; разрешённый ран проходит', async () => {
    const rootA = tempDir('ai-agent-runner-p30-ru-');
    const rootB = tempDir('ai-agent-runner-p30-eu-');
    const a = await startWorker({ rootDir: rootA, workerId: 'sb-ru', region: 'sandbox-ru' });
    const b = await startWorker({ rootDir: rootB, workerId: 'sb-eu', region: 'sandbox-eu' });

    const llmOnRu = await postSubmit(
      a.base,
      alphaKey,
      'idem-llm-ru',
      submitBody({ credentialBindings: [{ ref: 'sb-llm', scope: 'llm:call', status: 'active' }] }),
    );
    expect(llmOnRu.status).toBe(403);
    expect(await refusalCode(llmOnRu)).toBe('CREDENTIAL_REGION_FORBIDDEN');

    const residency = await postSubmit(
      b.base,
      alphaKey,
      'idem-residency',
      submitBody({ regionConstraints: { dataResidency: 'sandbox-ru' } }),
    );
    expect(residency.status).toBe(409);
    expect(await refusalCode(residency)).toBe('DATA_RESIDENCY_UNDECIDED');

    const accepted = await postSubmit(
      b.base,
      alphaKey,
      'idem-ok-eu',
      submitBody({ credentialBindings: [{ ref: 'sb-llm', scope: 'llm:call', status: 'active' }] }),
    );
    expect(accepted.status).toBe(202);
    const receipt = (await accepted.json()) as { runId: string };
    await waitFor(async () => {
      const status = (await (await getStatus(b.base, alphaKey, receipt.runId)).json()) as { state: string };
      return status.state === 'succeeded';
    });
    const admitted = b.logs.filter((entry) => entry['event'] === 'placement_admitted');
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ principalId: 'p-alpha', engine: 'fake', placement: { workerId: 'sb-eu', region: 'sandbox-eu', provider: null, policyId: 'p30-api-test-sb-eu' } });
  });

  it('Runner повторно проверяет регион движка, не доверяя вызывающему', async () => {
    // Спека собрана в обход admission (как это сделал бы другой, доверчивый вызывающий):
    // движок, который регион не разрешает, обязан быть отклонён самим Runner'ом.
    const h = createHarness({ scenario: 'success', host: { region: 'sandbox-ru', environment: 'sandbox', allowedEngines: ['fake', 'opencode'] } });
    const { receipt } = h.start({ engine: { name: 'claude', adapterVersion: '1' } });
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('failed');
    expect(result.exitReason).toBe('preflight_refused');
    expect(result.failure).toMatchObject({ code: 'REGION_FORBIDDEN', failureClass: 'preflight' });
    expect(h.fake.startCalls).toBe(0);
  });
});

describe('два воркера на одной VM: failover без двойного исполнения (AC-173)', () => {
  it('partition ≠ failover; явный сигнал; прежний владелец fenced; результат один', async () => {
    const fleetDir = extraDir('ai-agent-runner-p30-fleet-');
    const ownerStorePath = join(fleetDir, 'owners.json');
    const rootA = tempDir('ai-agent-runner-p30-worker-a-');
    const rootB = tempDir('ai-agent-runner-p30-worker-b-');

    const a = await startWorker({ rootDir: rootA, workerId: 'sb-ru', region: 'sandbox-ru', ownerStorePath, scenario: 'timeout' });
    const b = await startWorker({ rootDir: rootB, workerId: 'sb-eu', region: 'sandbox-eu', ownerStorePath });

    const sharedTask = 'task-failover';
    const first = await postSubmit(a.base, alphaKey, 'idem-a-1', submitBody({ userTaskId: sharedTask }));
    expect(first.status).toBe(202);
    const receiptA = (await first.json()) as { runId: string };
    await waitFor(async () => {
      const status = (await (await getStatus(a.base, alphaKey, receiptA.runId)).json()) as { state: string };
      return status.state === 'running';
    });

    // Второй воркер не берёт задачу первого: никакого двойного диспетчера.
    const doubleDispatch = await postSubmit(b.base, alphaKey, 'idem-b-1', submitBody({ userTaskId: sharedTask }));
    expect(doubleDispatch.status).toBe(409);
    expect(await refusalCode(doubleDispatch)).toBe('TASK_OWNED_BY_OTHER_WORKER');

    // Молчание сети не failover: перехват без явного сигнала отклоняется.
    // Реестр для чтения — от control plane, перехват выполняется от имени принимающего воркера.
    const owners = new DispatchOwnerStore({ path: ownerStorePath, workerId: 'probe-control-plane' });
    const fleetEvents: Array<{ event: string; ownerGeneration: number; reason: string; previousOwnerWorkerId?: string }> = [];
    const eu = new DispatchOwnerStore({ path: ownerStorePath, workerId: 'sb-eu', onEvent: (event) => fleetEvents.push(event) });
    const noSignal = owners.takeover('p-alpha', sharedTask, 'run-preview');
    expect(noSignal.outcome).toBe('partition_is_not_failover');

    // Управляемый сбой: процесс воркера A умирает с живым раном (dispose без финализации).
    await a.restart();
    const crashed = (await (await fetch(`${a.base}/v1/runs/${receiptA.runId}/result`, { headers: authHeader(alphaKey) })).json()) as {
      outcome: string;
      failure: { code: string; retryable: boolean; safeSummary: string };
    };
    expect(crashed.outcome).toBe('failed');
    expect(crashed.failure.code).toBe('WORKER_CRASH');
    expect(crashed.failure.retryable).toBe(true);
    // Прежний владелец не доиграл и не перезапустил ран: событий после падения нет.
    const eventsAfterCrash = (await (await fetch(`${a.base}/v1/runs/${receiptA.runId}/events`, { headers: authHeader(alphaKey) })).json()) as {
      events: Array<{ type: string; sequence: number }>;
    };
    expect(eventsAfterCrash.events.filter((event) => event.type === 'started')).toHaveLength(1);

    // До перехода записи прежнего владельца исключены: его ран терминально провален,
    // реестр всё ещё держит его как владельца, и новый воркер не видит его записей.
    const priorRecord = owners.get('p-alpha', sharedTask);
    expect(priorRecord?.ownerWorkerId).toBe('sb-ru');
    expect((await fetch(`${b.base}/v1/runs/${receiptA.runId}/status`, { headers: authHeader(alphaKey) })).status).toBe(404);

    // Явный сигнал: оператор объявляет прежнего владельца мёртвым.
    const takeover = eu.takeover('p-alpha', sharedTask, null, { source: 'operator', reason: 'worker sb-ru process killed; owner declared dead' });
    expect(takeover.outcome).toBe('granted');
    if (takeover.outcome === 'granted') expect(takeover.generation).toBe(2);

    const second = await postSubmit(b.base, alphaKey, 'idem-b-2', submitBody({ userTaskId: sharedTask }));
    expect(second.status).toBe(202);
    const receiptB = (await second.json()) as { runId: string };
    expect(receiptB.runId).not.toBe(receiptA.runId);
    const statusB = (await (await getStatus(b.base, alphaKey, receiptB.runId)).json()) as { state: string; ownerGeneration: number; userTaskId: string };
    expect(statusB).toMatchObject({ userTaskId: sharedTask, ownerGeneration: 2 });
    await waitFor(async () => {
      const status = (await (await getStatus(b.base, alphaKey, receiptB.runId)).json()) as { state: string };
      return status.state === 'succeeded';
    });

    // Прежний владелец fenced: его поздняя попытка не создаёт третий ран.
    const late = await postSubmit(a.base, alphaKey, 'idem-a-2', submitBody({ userTaskId: sharedTask }));
    expect(late.status).toBe(409);
    expect(await refusalCode(late)).toBe('TASK_OWNED_BY_OTHER_WORKER');
    expect(a.service.runner.listRunIds()).toEqual([receiptA.runId]);

    // Ровно один результат на задачу: успешен только ран нового владельца.
    const resultB = (await (await fetch(`${b.base}/v1/runs/${receiptB.runId}/result`, { headers: authHeader(alphaKey) })).json()) as { outcome: string };
    expect(resultB.outcome).toBe('succeeded');
    const eventsB = (await (await fetch(`${b.base}/v1/runs/${receiptB.runId}/events`, { headers: authHeader(alphaKey) })).json()) as {
      events: Array<{ type: string; sequence: number }>;
    };
    expect(eventsB.events.filter((event) => event.type === 'claimed')).toHaveLength(1);
    expect(eventsB.events.map((event) => event.sequence)).toEqual(eventsB.events.map((_, index) => index + 1));

    const registry = owners.get('p-alpha', sharedTask);
    expect(registry).toMatchObject({ ownerWorkerId: 'sb-eu', previousOwnerWorkerId: 'sb-ru', ownerGeneration: 2, state: 'owned' });

    // Переходы флота с причиной: failover помечен источником сигнала, прежний владелец fenced.
    const failoverEvent = fleetEvents.find((entry) => entry.event === 'failover_granted');
    expect(failoverEvent).toMatchObject({ ownerGeneration: 2, previousOwnerWorkerId: 'sb-ru' });
    expect(failoverEvent?.reason).toMatch(/operator: worker sb-ru process killed/);
    const fencedEvent = fleetEvents.find((entry) => entry.event === 'fenced');
    expect(fencedEvent).toMatchObject({ ownerGeneration: 1 });
    expect(fencedEvent?.reason).toMatch(/previous owner sb-ru is fenced at generation 1/);
  });
});
