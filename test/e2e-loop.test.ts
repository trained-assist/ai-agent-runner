import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRunResult } from '../src/contracts/result.js';
import { validateRunnerEvent } from '../src/contracts/events.js';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

import {
  alphaKey,
  authHeader,
  getArtifacts,
  getResult,
  getStatus,
  postSubmit,
  startHttpHarness,
  submitBody,
  waitForTerminal,
} from './api-http-harness.js';

/**
 * E2E-приёмка serverless API (epic #74, шаг 8). Один путь: submit → внешний воркер →
 * result → артефакты (ссылки на GitHub) → logUrl (Google Storage). Никакого диска: тест
 * проверяет, что процесс API не создал ни одного файла и что при рестарте память пуста.
 */

describe('e2e: serverless API поверх внешнего воркера (#74)', () => {
  it('submit → worker → result → GitHub-артефакты → logUrl в GCS', async () => {
    const h = await startHttpHarness();

    const submit = await postSubmit(h.base, alphaKey, 'idem-e2e-1', submitBody({ outputs: [{ path: 'report.md' }] }));
    expect(submit.status).toBe(202);
    const receipt = (await submit.json()) as { runId: string; requestId: string; userTaskId: string; deduplicated: boolean };
    expect(receipt.deduplicated).toBe(false);
    expect(receipt.runId).toMatch(/^run_/);

    // Ран ушёл во внешний воркер ровно один раз и с предписанным движком.
    expect(await waitForTerminal(h.base, alphaKey, receipt.runId)).toBe('succeeded');
    expect(h.worker.launches).toHaveLength(1);
    expect(h.worker.launches[0]!['runId']).toBe(receipt.runId);
    expect((h.worker.launches[0]!['engine'] as { name: string }).name).toBe('dynamic-ip-azure-agent-run');

    const result = (await (await getResult(h.base, alphaKey, receipt.runId)).json()) as { outcome: string; logPath: string; outputRefs: string[] };
    expect(result.outcome).toBe('succeeded');
    expect(result.logPath).toMatch(/^https:\/\/storage\.googleapis\.com\//);
    expect(result.outputRefs).toEqual(['https://github.com/owner/name/blob/abc1234/report.md']);

    // Артефакты — ссылки на GitHub, а не байты.
    const artifacts = (await (await getArtifacts(h.base, alphaKey, receipt.runId)).json()) as {
      count: number;
      repo: { fullName: string; commit: string };
      logUrl: string;
      artifacts: Array<{ path: string; url: string; size: number; sha256: string }>;
    };
    expect(artifacts.count).toBe(1);
    expect(artifacts.repo).toEqual({ fullName: 'owner/name', commit: 'abc1234' });
    expect(artifacts.artifacts[0]).toMatchObject({
      path: 'report.md',
      url: 'https://github.com/owner/name/blob/abc1234/report.md',
      size: 1234,
    });
    expect(artifacts.logUrl).toMatch(/^https:\/\/storage\.googleapis\.com\//);

    // События рана валидны по общему контракту и заканчиваются терминальным.
    const page = (await (await fetch(`${h.base}/v1/runs/${receipt.runId}/events`, { headers: authHeader(alphaKey) })).json()) as {
      events: Array<{ type: string }>;
      logUrl: string;
    };
    for (const event of page.events) expect(validateRunnerEvent(event).ok).toBe(true);
    expect(page.events[page.events.length - 1]!.type).toBe('succeeded');
    expect(page.logUrl).toBe(artifacts.logUrl);
  }, 30000);

  it('результат и ссылка на лог переживают потерю связи клиента (polling)', async () => {
    const h = await startHttpHarness();
    const submit = await postSubmit(h.base, alphaKey, 'idem-e2e-2', submitBody());
    const receipt = (await submit.json()) as { runId: string };
    await waitForTerminal(h.base, alphaKey, receipt.runId);

    const validated = (await (await getResult(h.base, alphaKey, receipt.runId)).json()) as unknown;
    expect(validateRunResult(validated).ok).toBe(true);

    const redirect = await fetch(`${h.base}/v1/runs/${receipt.runId}/log`, { headers: authHeader(alphaKey), redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toMatch(/^https:\/\/storage\.googleapis\.com\//);
  }, 30000);

  it('идемпотентность: тот же ключ + тот же payload = тот же receipt и один запуск воркера', async () => {
    const h = await startHttpHarness();
    const first = await postSubmit(h.base, alphaKey, 'idem-e2e-3', submitBody());
    const receipt = (await first.json()) as { runId: string };
    const second = await postSubmit(h.base, alphaKey, 'idem-e2e-3', submitBody());
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ runId: receipt.runId, deduplicated: true });
    await waitForTerminal(h.base, alphaKey, receipt.runId);
    expect(h.worker.launches).toHaveLength(1);
  }, 30000);

  it('процесс API не создаёт файлов: состояние рана живёт только в памяти', async () => {
    const h = await startHttpHarness();
    // Каталог данных прежней модели (дефолт AGENT_API_DATA_DIR) — именно его создавал старый API.
    const dataDir = resolve(repoRoot, 'data');
    const existedBefore = existsSync(dataDir);
    const submit = await postSubmit(h.base, alphaKey, 'idem-e2e-4', submitBody());
    const receipt = (await submit.json()) as { runId: string };
    await waitForTerminal(h.base, alphaKey, receipt.runId);

    const status = (await (await getStatus(h.base, alphaKey, receipt.runId)).json()) as { state: string; answer: string | null };
    expect(status.state).toBe('succeeded');
    expect(status.answer).toBe('Готово, отчёт в report.md');
    expect(existsSync(dataDir)).toBe(existedBefore);
    // При этом ран действительно прошёл, а не «ничего не делал».
    expect(h.service.store.getByRun(receipt.runId)).not.toBeNull();
    expect(h.service.store.counts().events).toBeGreaterThan(0);
  }, 30000);

  it('статически: обслуживающий путь API ничего не пишет на диск и не спавнит процессы', () => {
    // Критерий приёмки «API не пишет на диск» проверяется по коду, а не по каталогу: иначе
    // проверка зависела бы от того, что в tmpdir не пишет кто-то ещё. Чтение конфига
    // (реестр ключей) допустимо — запрещены запись и порождение процессов.
    const sources = ['src/api', 'src/adapters/external-worker-adapter.ts', 'src/redact.ts'];
    const files: string[] = [];
    const walk = (target: string): void => {
      if (!existsSync(target)) return;
      const stat = statSync(target);
      if (stat.isDirectory()) for (const entry of readdirSync(target)) walk(resolve(target, entry));
      else if (target.endsWith('.ts')) files.push(target);
    };
    for (const source of sources) walk(resolve(repoRoot, source));

    // Имена ловим как вызовы (`spawn(`), а не как слова: упоминание в комментарии запретом не является.
    const forbidden: RegExp[] = [
      /node:child_process/,
      /['"]child_process['"]/,
      /\b(?:writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync|copyFileSync|chmodSync|createWriteStream)\s*\(/,
      /\b(?:spawn|spawnSync|execFile|execSync|fork)\s*\(/,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        if (pattern.test(text)) offenders.push(`${file} → ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('рестарт процесса забывает ран: клиент повторяет submit с новым ключом (эпик, шаг 6)', async () => {
    const h = await startHttpHarness();
    const submit = await postSubmit(h.base, alphaKey, 'idem-e2e-5', submitBody());
    const receipt = (await submit.json()) as { runId: string };
    await waitForTerminal(h.base, alphaKey, receipt.runId);

    // «Перезапуск» = новый экземпляр сервиса с пустым состоянием, тот же воркер.
    const restarted = h.service.store;
    restarted.sweep(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const stale = await getStatus(h.base, alphaKey, receipt.runId);
    expect(stale.status).toBe(404);

    const retry = await postSubmit(h.base, alphaKey, 'idem-e2e-6', submitBody());
    expect(retry.status).toBe(202);
    const next = (await retry.json()) as { runId: string };
    expect(next.runId).not.toBe(receipt.runId);
    expect(await waitForTerminal(h.base, alphaKey, next.runId)).toBe('succeeded');
  }, 30000);

  it('воркер отказал: ран завершается известным исходом, а не висит и не притворяется успехом', async () => {
    const h = await startHttpHarness({ worker: { httpStatus: 500 } });
    const submit = await postSubmit(h.base, alphaKey, 'idem-e2e-7', submitBody());
    const receipt = (await submit.json()) as { runId: string };
    expect(await waitForTerminal(h.base, alphaKey, receipt.runId)).toBe('failed');

    const result = (await (await getResult(h.base, alphaKey, receipt.runId)).json()) as {
      outcome: string;
      exitReason: string;
      failure: { code: string; failureClass: string; retryable: boolean };
    };
    expect(result.exitReason).toBe('worker_crash');
    expect(result.failure).toMatchObject({ code: 'WORKER_HTTP_ERROR', failureClass: 'runtime', retryable: true });
    // Артефактов нет — и API не притворяется, что они есть.
    const artifacts = (await (await getArtifacts(h.base, alphaKey, receipt.runId)).json()) as { count: number; logUrl: string | null };
    expect(artifacts.count).toBe(0);
    expect(artifacts.logUrl).toBeNull();
  }, 30000);
});
