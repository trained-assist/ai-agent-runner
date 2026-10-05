import { describe, expect, it, onTestFinished } from 'vitest';
import { AgentApi } from '../src/api/service.js';
import { StatelessStore } from '../src/api/stateless-store.js';
import type { Principal } from '../src/api/auth.js';
import { PreflightError } from '../src/contracts/validate.js';
import type { LaunchResult, LaunchReceipt, WorkerCancelResult, WorkerRunStatus } from '../src/adapters/external-worker-adapter.js';
import type { ExternalWorker } from '../src/adapters/external-worker-adapter.js';
import { adapterFor, startMockWorker } from './external-worker-harness.js';

/**
 * Контракт внешнего worker, п. 4 (issue #92): таймаут ожидания квитанции не означает, что
 * ран не запущен. Отказ на launch обязан пройти порядок `unknown` → один запрос `status`
 * по уже отправленному `runId` → только потом терминальный отказ. Иначе клиент получает
 * `failed` с `retryable` и повторяет запрос, заводя второй ран там, где первый ещё идёт.
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

async function waitForState(api: AgentApi, runId: string, state: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (api.status(alpha, runId).state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} never reached ${state}: ${api.status(alpha, runId).state}`);
}

function makeApi(worker: ExternalWorker, logs: Record<string, unknown>[]): AgentApi {
  const api = new AgentApi({ workers: [worker], store: new StatelessStore(), logger: (entry) => logs.push(entry) });
  onTestFinished(() => api.dispose());
  return api;
}

describe('launch без ответа: unknown + reconcile, а не failed (#92)', () => {
  it('ответ на launch потерян, но ран принят: ран доходит до терминала, а не в failed', async () => {
    // Воркер регистрирует ран сразу, а отвечает только через 3 с: адаптер обрывает запрос
    // по таймауту, и квитанция теряется — ровно тот случай, где ран уже живёт у воркера.
    const worker = await startMockWorker({ delayMs: 3000 });
    onTestFinished(() => worker.close());
    const logs: Record<string, unknown>[] = [];
    const api = makeApi(adapterFor(worker, { deadlineMs: 150 }), logs);

    const receipt = api.submit(alpha, 'idem-reconcile-lost-answer', body());
    await waitForState(api, receipt.runId, 'succeeded');

    // Ран не стал failed: результат забран штатно, как будто квитанция пришла вовремя.
    expect(api.result(alpha, receipt.runId).outcome).toBe('succeeded');
    // Второго launch не было: reconcile — это опрос существующего запуска, а не повтор.
    expect(worker.launches).toHaveLength(1);
    // Отказ виден в логе: ни молча, ни «ран не принят».
    expect(logs.some((entry) => entry['event'] === 'worker_launch_undetermined')).toBe(true);
    expect(logs.some((entry) => entry['event'] === 'run_outcome_unknown' && entry['reason'] === 'worker_unreachable')).toBe(true);
    expect(logs.some((entry) => entry['event'] === 'worker_launch_reconciled' && entry['status'] === 'succeeded')).toBe(true);
  }, 20000);

  it('воркер не видит запуск: терминальный failed с честным кодом и итогом reconcile', async () => {
    // Ран зарегистрирован, но воркер его ещё «не видит» (registerAfterMs), поэтому на
    // единственный запрос status он отвечает unknown — запуска нет.
    const worker = await startMockWorker({ delayMs: 3000, registerAfterMs: 60_000 });
    onTestFinished(() => worker.close());
    const logs: Record<string, unknown>[] = [];
    const api = makeApi(adapterFor(worker, { deadlineMs: 150 }), logs);

    const receipt = api.submit(alpha, 'idem-reconcile-absent', body());
    await waitForState(api, receipt.runId, 'failed');

    const result = api.result(alpha, receipt.runId);
    expect(result.outcome).toBe('failed');
    expect(result.exitReason).toBe('worker_crash');
    // Код — исходный код отказа: он называет причину, а не выдуманный «ран не состоялся».
    expect(result.failure).toMatchObject({ code: 'WORKER_LAUNCH_UNREACHABLE', failureClass: 'runtime', retryable: true });
    expect(result.failure?.safeSummary).toContain('has no record of run');
    // Итог reconcile виден в логе.
    expect(logs.some((entry) => entry['event'] === 'worker_launch_reconciled' && entry['status'] === 'unknown')).toBe(true);
    expect(logs.some((entry) => entry['event'] === 'worker_run_absent')).toBe(true);
  }, 20000);

  it('отказ остаётся в журнале рана: событие unknown до терминального, номера не переиспользуются', async () => {
    const worker = await startMockWorker({ delayMs: 3000, registerAfterMs: 60_000 });
    onTestFinished(() => worker.close());
    const store = new StatelessStore();
    const api = new AgentApi({ workers: [adapterFor(worker, { deadlineMs: 150 })], store });
    onTestFinished(() => api.dispose());

    const receipt = api.submit(alpha, 'idem-reconcile-events', body());
    await waitForState(api, receipt.runId, 'failed');

    const progress = store.progressOf(receipt.runId)!;
    const unknownIndex = progress.events.findIndex((event) => event.type === 'log' && event.payload['level'] === 'warn');
    const failedIndex = progress.events.findIndex((event) => event.type === 'failed');
    expect(unknownIndex).toBeGreaterThanOrEqual(0);
    expect(failedIndex).toBeGreaterThan(unknownIndex);
    // Причина в событии: клиент читает журнал рана, а не только лог API.
    expect(String(progress.events[unknownIndex]!.payload['message'])).toContain('outcome unknown (worker_unreachable)');
    // Нумерация монотонна: события финализации не переиспользуют номера отметки unknown.
    const sequences = progress.events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);
    // Клиент видит потерю связи в статусе рана.
    expect(api.status(alpha, receipt.runId).connectionLost).toBe(true);
  }, 20000);

  it('воркер видит ран как running: поллер подхватывает его и доводит до терминала', async () => {
    // Без HTTP: фейковый воркер теряет ответ на launch, а на опрос отвечает running → succeeded.
    const runId = 'run-reconcile-running';
    const statuses: WorkerRunStatus[] = ['running', 'succeeded'];
    const worker: ExternalWorker = {
      name: 'dynamic-ip-azure-agent-run',
      baseUrl: 'http://worker.test',
      async launch(): Promise<LaunchReceipt> {
        throw new PreflightError('WORKER_LAUNCH_UNREACHABLE', 'the external worker did not answer the launch request', {
          failureClass: 'runtime',
          retryable: true,
          outcomeUnknown: true,
        });
      },
      async status(): Promise<{ runId: string; status: WorkerRunStatus }> {
        return { runId, status: statuses.shift() ?? 'succeeded' };
      },
      async result(): Promise<LaunchResult> {
        return {
          runId,
          status: 'started',
          pid: 4242,
          exitCode: 0,
          exitSignal: null,
          exitReason: 'completed',
          stdout: 'done',
          stderr: '',
          answer: 'готово',
          answerSource: 'engine_stdout',
          durationMs: 10,
          timedOut: false,
          outputTruncated: false,
          artifacts: [],
          logUrl: 'https://storage.googleapis.com/agent-logs/runs/session.log',
          repo: { fullName: 'owner/name', branch: `agent-run/${runId}`, commit: 'abc1234' },
        };
      },
      async cancel(): Promise<WorkerCancelResult> {
        return { status: 'unknown_run' };
      },
    };
    const logs: Record<string, unknown>[] = [];
    const api = makeApi(worker, logs);

    const receipt = api.submit(alpha, 'idem-reconcile-running', body());
    await waitForState(api, receipt.runId, 'succeeded');

    expect(api.result(alpha, receipt.runId).outcome).toBe('succeeded');
    expect(logs.some((entry) => entry['event'] === 'worker_launch_reconciled' && entry['status'] === 'running')).toBe(true);
    // Ран помечен как отправленный: после рестарта API поллер его перезапустит.
    expect(api.store.dispatchedRuns().map((entry) => entry.runId)).toContain(receipt.runId);
  }, 20000);

  it('запрос не дошёл до воркера (preflight): терминальный failed без reconcile', async () => {
    // Отказ известен: запрос отклонён до отправки. Спрашивать воркер нечего — запуска нет.
    const api = makeApi(adapterFor(await startMockWorker()), []);
    const receipt = api.submit(alpha, 'idem-reconcile-preflight', {
      engine: { name: 'dynamic-ip-azure-agent-run', adapterVersion: '1' },
      limits: { timeoutMs: 5000 },
      envAllowlist: [],
      input: { refs: [{ ref: 'snap-1', snapshotId: 'snapshot-1' }] },
    });
    await waitForState(api, receipt.runId, 'failed');
    const result = api.result(alpha, receipt.runId);
    expect(result.failure).toMatchObject({ code: 'INPUT_REFS_UNSUPPORTED', failureClass: 'preflight', retryable: false });
  }, 20000);
});
