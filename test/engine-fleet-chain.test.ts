import { describe, expect, it, onTestFinished } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import { AgentApi } from '../src/api/service.js';
import { StatelessStore } from '../src/api/stateless-store.js';
import { ExternalWorkerAdapter } from '../src/adapters/external-worker-adapter.js';
import type { Principal } from '../src/api/auth.js';
import { adapterFor, startMockWorker, type MockWorker, type MockWorkerOptions } from './external-worker-harness.js';
import { createAgentApiServer } from '../src/api/server.js';
import { betaKey, testKeyRegistry } from './api-http-harness.js';

/**
 * Приоритетная цепочка движков (issue #100): France → Russia → GHA. Приём рана у каждого
 * движка ограничен бюджетом, переход к следующему возможен только когда квитанции не было, а
 * `operationId` при переходе не меняется — иначе дедупликация воркера вернёт второй запуск.
 */

const GHA = 'azure-cloud';
const EU = 'eu-vm-agent-run';
const RF = 'rf-vm-agent-run';

const fleetPrincipal: Principal = {
  principalId: 'p-fleet',
  profileId: 'profile-a',
  scopes: ['runs:read', 'runs:write'],
};

interface Fleet {
  service: AgentApi;
  gha: MockWorker;
  eu: MockWorker;
  rf: MockWorker;
  close(): Promise<void>;
}

/**
 * Цепочка из трёх движков. У GHA бюджет приёма маленький (200 мс), как у GitHub Actions —
 * настоящий воркер обязан ответить квитанцией за 30 с, иначе ран уходит на нашу VM.
 */
async function makeFleet(options: { gha?: MockWorkerOptions; eu?: MockWorkerOptions; rf?: MockWorkerOptions; chain?: string[] } = {}): Promise<Fleet> {
  const gha = await startMockWorker(options.gha);
  const eu = await startMockWorker(options.eu);
  const rf = await startMockWorker(options.rf);
  onTestFinished(() => gha.close());
  onTestFinished(() => eu.close());
  onTestFinished(() => rf.close());
  const service = new AgentApi({
    workers: [
      adapterFor(gha, { engineName: GHA, acceptDeadlineMs: 200, deadlineMs: 2000 }),
      adapterFor(eu, { engineName: EU, acceptDeadlineMs: 5000, deadlineMs: 2000 }),
      adapterFor(rf, { engineName: RF, acceptDeadlineMs: 5000, deadlineMs: 2000 }),
    ],
    engineChain: options.chain ?? [EU, RF, GHA],
    store: new StatelessStore(),
  });
  onTestFinished(() => service.dispose());
  return {
    service,
    gha,
    eu,
    rf,
    close: async () => {
      await gha.close();
      await eu.close();
      await rf.close();
    },
  };
}

function submit(fleet: Fleet, idempotencyKey: string, over: Record<string, unknown> = {}): { runId: string } {
  return fleet.service.submit(
    fleetPrincipal,
    idempotencyKey,
    {
      limits: { timeoutMs: 15000 },
      envAllowlist: [],
      input: { inlinePrompt: 'сделай отчёт' },
      ...over,
    },
  );
}

async function waitFor(fleet: Fleet, runId: string, state: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fleet.service.status(fleetPrincipal, runId).state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} never reached ${state}: ${fleet.service.status(fleetPrincipal, runId).state}`);
}

describe('приоритетная цепочка движков (#100)', () => {
  it('GHA не принял ран — ран ушёл на EU VM, клиент видит фактический движок', async () => {
    // 503 на launch: воркер отказал и ран не регистрировал, поэтому reconcile отвечает
    // «не знаю» — доказательство того, что запуск не состоялся и второй ран не дубль.
    const fleet = await makeFleet({ gha: { httpStatus: 503 }, chain: [GHA, EU, RF] });
    const { runId } = submit(fleet, 'idem-fleet-advance');
    await waitFor(fleet, runId, 'succeeded');

    const status = fleet.service.status(fleetPrincipal, runId);
    expect(status.engine).toBe(EU);
    expect(fleet.gha.launches).toHaveLength(1);
    expect(fleet.eu.launches).toHaveLength(1);
    expect(fleet.rf.launches).toHaveLength(0);
    expect(fleet.service.result(fleetPrincipal, runId).outcome).toBe('succeeded');
  }, 20000);

  it('без переопределения используется обычный порядок France → Russia → GHA', async () => {
    const fleet = await makeFleet({ eu: { httpStatus: 503 } });
    const { runId } = submit(fleet, 'idem-fleet-default-order');
    await waitFor(fleet, runId, 'succeeded');

    expect(fleet.eu.launches).toHaveLength(1);
    expect(fleet.rf.launches).toHaveLength(1);
    expect(fleet.gha.launches).toHaveLength(0);
    expect(fleet.service.status(fleetPrincipal, runId).engine).toBe(RF);
  }, 20000);

  it('France capacity cutoff skips the Russian VM and sends the next run directly to GHA', async () => {
    const fleet = await makeFleet({
      eu: { httpStatus: 503, capacityRefusal: true, statusHttpStatus: 503 },
      chain: [EU, RF, GHA],
    });
    const { runId } = submit(fleet, 'idem-capacity-france-cutover');
    await waitFor(fleet, runId, 'succeeded');

    expect(fleet.eu.launches).toHaveLength(1);
    expect(fleet.rf.launches).toHaveLength(0);
    expect(fleet.gha.launches).toHaveLength(1);
    expect(fleet.service.status(fleetPrincipal, runId).engine).toBe(GHA);
  }, 20000);

  it('Russia capacity cutoff sends the next run directly to GHA', async () => {
    const fleet = await makeFleet({
      eu: { httpStatus: 503, admissionRefusal: 'WORKER_CAPACITY_UNKNOWN' },
      rf: { httpStatus: 503, capacityRefusal: true, statusHttpStatus: 503 },
      chain: [EU, RF, GHA],
    });
    const { runId } = submit(fleet, 'idem-capacity-russia-cutover');
    await waitFor(fleet, runId, 'succeeded');

    expect(fleet.eu.launches).toHaveLength(1);
    expect(fleet.rf.launches).toHaveLength(1);
    expect(fleet.gha.launches).toHaveLength(1);
    expect(fleet.service.status(fleetPrincipal, runId).engine).toBe(GHA);
  }, 20000);

  it.each(['WORKER_CAPACITY_UNKNOWN', 'WORKER_ADMISSION_UNAVAILABLE'] as const)(
    '%s preserves France → Russia → GHA order because saturation is unproven', async (code) => {
      const fleet = await makeFleet({
        eu: { httpStatus: 503, admissionRefusal: code },
        rf: { httpStatus: 503, admissionRefusal: code },
        chain: [EU, RF, GHA],
      });
      const { runId } = submit(fleet, `idem-${code.toLowerCase()}`);
      await waitFor(fleet, runId, 'succeeded');

      expect(fleet.eu.launches).toHaveLength(1);
      expect(fleet.rf.launches).toHaveLength(1);
      expect(fleet.gha.launches).toHaveLength(1);
      expect(fleet.service.status(fleetPrincipal, runId).engine).toBe(GHA);
    },
  );

  it('GHA принял ран, но квитанция потерялась — бюджет истёк, а перехода нет: дубля нет', async () => {
    // Воркер регистрирует ран до задержки ответа, поэтому reconcile его находит: ран уже
    // идёт на GHA, и второй запуск на EU был бы дублем.
    const fleet = await makeFleet({ gha: { delayMs: 1000 }, chain: [GHA, EU, RF] });
    const { runId } = submit(fleet, 'idem-fleet-reconcile');
    await waitFor(fleet, runId, 'succeeded');

    expect(fleet.eu.launches).toHaveLength(0);
    expect(fleet.rf.launches).toHaveLength(0);
    expect(fleet.service.status(fleetPrincipal, runId).engine).toBe(GHA);
  }, 20000);

  it('GHA недоступен для reconcile — ран остаётся unknown, второго запуска нет', async () => {
    // Доказать, что запуск не состоялся, нельзя: контракт (п. 4) запрещает второй запуск
    // без доказательства. Клиент видит unknown и решает сам.
    const fleet = await makeFleet({ gha: { httpStatus: 503, statusHttpStatus: 503 }, chain: [GHA, EU, RF] });
    const { runId } = submit(fleet, 'idem-fleet-unreachable');
    await waitFor(fleet, runId, 'unknown');

    expect(fleet.eu.launches).toHaveLength(0);
    expect(fleet.rf.launches).toHaveLength(0);
    expect(fleet.service.status(fleetPrincipal, runId).engine).toBe(GHA);
  }, 20000);

  it('operationId и runId при переходе не меняются: дедупликация воркера вернёт тот же ран', async () => {
    const fleet = await makeFleet({ gha: { httpStatus: 503 }, chain: [GHA, EU, RF] });
    const { runId } = submit(fleet, 'idem-fleet-operation-id');
    await waitFor(fleet, runId, 'succeeded');

    // Оба движка видят один и тот же ран и одну и ту же операцию: если первый всё-таки
    // принял ран после таймаута, его дедупликация вернёт тот же runId, а не второй запуск.
    const first = fleet.gha.launches[0]!;
    const second = fleet.eu.launches[0]!;
    expect(first['runId']).toBe(runId);
    expect(second['runId']).toBe(runId);
    expect(second['operationId']).toBe(first['operationId']);
  }, 20000);

  it('GHA принял квитанцию — перехода нет, даже когда результат идёт долго', async () => {
    const fleet = await makeFleet({ gha: { resultDelayMs: 400 }, eu: { httpStatus: 503 }, rf: { httpStatus: 503 }, chain: [GHA, EU, RF] });
    const { runId } = submit(fleet, 'idem-fleet-accepted');
    await waitFor(fleet, runId, 'succeeded');

    expect(fleet.eu.launches).toHaveLength(0);
    expect(fleet.rf.launches).toHaveLength(0);
    expect(fleet.service.status(fleetPrincipal, runId).engine).toBe(GHA);
  }, 20000);

  it('первый движок принял ран, но результат потерян — unknown + reconcile, второго запуска нет', async () => {
    const fleet = await makeFleet({ gha: { autoDeliver: false, terminalStatus: 'unknown' }, chain: [GHA, EU] });
    const { runId } = submit(fleet, 'idem-fleet-unknown');
    await waitFor(fleet, runId, 'unknown');

    // Квитанция была: цепочка окончена, дальше только опрос принявшего движка.
    expect(fleet.eu.launches).toHaveLength(0);
    expect(fleet.service.status(fleetPrincipal, runId).state).toBe('unknown');
    expect(fleet.service.status(fleetPrincipal, runId).engine).toBe(GHA);
  }, 20000);

  it('все три движка не приняли — ран закрывается отказом с перечислением попыток, а не молчанием', async () => {
    const fleet = await makeFleet({ gha: { httpStatus: 503 }, eu: { httpStatus: 503 }, rf: { httpStatus: 503 } });
    const { runId } = submit(fleet, 'idem-fleet-exhausted');
    await waitFor(fleet, runId, 'failed');

    const result = fleet.service.result(fleetPrincipal, runId);
    expect(result.outcome).toBe('failed');
    expect(result.failure?.code).toBe('ENGINE_FLEET_EXHAUSTED');
    expect(result.failure?.safeSummary).toContain(GHA);
    expect(result.failure?.safeSummary).toContain(EU);
    expect(result.failure?.safeSummary).toContain(RF);
    // Цепочка двигалась по обычному порядку: France, затем Russia, затем GHA.
    expect(fleet.gha.launches).toHaveLength(1);
    expect(fleet.eu.launches).toHaveLength(1);
    expect(fleet.rf.launches).toHaveLength(1);
  }, 20000);

  it('клиент назвал engine.name — работает только он, цепочка не подменяет исполнителя', async () => {
    const fleet = await makeFleet({ gha: { httpStatus: 503 }, eu: { httpStatus: 503 }, rf: { httpStatus: 503 } });
    const { runId } = submit(fleet, 'idem-fleet-pinned', { engine: { name: GHA, adapterVersion: '1' } });
    await waitFor(fleet, runId, 'failed');

    expect(fleet.eu.launches).toHaveLength(0);
    expect(fleet.rf.launches).toHaveLength(0);
    // Закреплённый движок сообщает собственный код отказа, а не «цепочка исчерпана».
    expect(fleet.service.result(fleetPrincipal, runId).failure?.code).toBe('WORKER_HTTP_ERROR');
    expect(fleet.service.status(fleetPrincipal, runId).engine).toBe(GHA);
  }, 20000);

  it('заявка без engine и без объявленной цепочки — честный отказ, а не ран в пустоту', async () => {
    const worker = await startMockWorker();
    onTestFinished(() => worker.close());
    const service = new AgentApi({ workers: [adapterFor(worker, { engineName: GHA })] });
    onTestFinished(() => service.dispose());

    let thrown: ApiError | null = null;
    try {
      service.submit(fleetPrincipal, 'idem-fleet-no-chain', { limits: { timeoutMs: 1000 }, envAllowlist: [] });
    } catch (err) {
      thrown = err as ApiError;
    }
    expect(thrown?.code).toBe('ENGINE_REQUIRED');
    expect(thrown?.status).toBe(400);
  });

  it('цепочка сужается до движков, разрешённых принципалу', async () => {
    const restricted: Principal = { ...fleetPrincipal, engines: [RF] };
    const fleet = await makeFleet({ gha: { httpStatus: 503 }, eu: { httpStatus: 503 }, rf: { httpStatus: 503 } });
    const { runId } = fleet.service.submit(
      restricted,
      'idem-fleet-principal',
      { limits: { timeoutMs: 1000 }, envAllowlist: [], input: { inlinePrompt: 'привет' } },
    );
    await waitFor(fleet, runId, 'failed');

    expect(fleet.gha.launches).toHaveLength(0);
    expect(fleet.eu.launches).toHaveLength(0);
    expect(fleet.rf.launches).toHaveLength(1);
  }, 20000);

  it('отмена уходит движку, который принял ран, а не тому, кто был первым в цепочке', async () => {
    // Первый движок отказывает и не регистрирует ран — цепочка переходит на второй.
    // Статус второго — `running`: отмена приходит в полёте.
    const fleet = await makeFleet({ gha: { httpStatus: 503 }, eu: { terminalStatus: 'running' }, chain: [GHA, EU, RF] });
    const { runId } = submit(fleet, 'idem-fleet-cancel');
    // Ждём, пока цепочка не перешла на EU: до этого ран никем не принят, и отмена ушла бы
    // в ещё не начавший движок.
    const deadline = Date.now() + 10_000;
    while (fleet.service.status(fleetPrincipal, runId).engine !== EU) {
      if (Date.now() > deadline) throw new Error('the chain never advanced to the second engine');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const receipt = await fleet.service.cancel(fleetPrincipal, runId);
    expect(receipt.status).toBe('stop_pending');
    await waitFor(fleet, runId, 'cancelled');

    expect(fleet.gha.cancels).not.toContain(runId);
    expect(fleet.eu.cancels).toContain(runId);
  }, 20000);

  it('цепочка без воркера — отказ на старте, а не падение рана на середине цепочки', () => {
    const worker = new ExternalWorkerAdapter({ baseUrl: 'https://gha.example', engineName: GHA });
    expect(() => new AgentApi({ workers: [worker], engineChain: [GHA, EU] })).toThrowError(/without a worker/);
  });

  it('клиент видит фактический движок в HTTP-статусе, а не только в памяти сервиса', async () => {
    const gha = await startMockWorker({ httpStatus: 503 });
    const eu = await startMockWorker();
    onTestFinished(() => gha.close());
    onTestFinished(() => eu.close());
    const service = new AgentApi({
      workers: [
        adapterFor(gha, { engineName: GHA, acceptDeadlineMs: 200, deadlineMs: 2000 }),
        adapterFor(eu, { engineName: EU, acceptDeadlineMs: 5000, deadlineMs: 2000 }),
      ],
      engineChain: [GHA, EU],
      store: new StatelessStore(),
    });
    onTestFinished(() => service.dispose());
    const server = createAgentApiServer(service, { keys: testKeyRegistry() });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const response = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${betaKey}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-fleet-http',
      },
      body: JSON.stringify({ limits: { timeoutMs: 15000 }, envAllowlist: [], input: { inlinePrompt: 'привет' } }),
    });
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };

    const deadline = Date.now() + 10_000;
    let engine = '';
    while (Date.now() < deadline) {
      const status = (await (
        await fetch(`${base}/v1/runs/${runId}/status`, { headers: { authorization: `Bearer ${betaKey}` } })
      ).json()) as { engine: string; state: string };
      engine = status.engine;
      if (status.state === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(engine).toBe(EU);
  }, 20000);
});
