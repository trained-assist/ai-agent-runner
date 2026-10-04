import { describe, expect, it } from 'vitest';
import {
  alphaKey,
  authHeader,
  getResult,
  getStatus,
  postCancel,
  postSubmit,
  startHttpHarness,
  submitBody,
  waitForAsync,
  waitForTerminal,
} from './api-http-harness.js';
import { validateRunResult } from '../src/contracts/result.js';

/**
 * Объявленные выходы в stateless-модели (#54 → #74): клиент объявляет `outputs`, воркер
 * складывает их в репозиторий юзера, API возвращает ссылки. Пустой список выходов не должен
 * выглядеть как «сохранено».
 */

describe('объявленные выходы через внешнего воркера (#54/#74)', () => {
  it('outputs запроса уезжают в LaunchRequest и возвращаются ссылками на GitHub', async () => {
    const h = await startHttpHarness();
    const submit = await postSubmit(
      h.base,
      alphaKey,
      'idem-outputs',
      submitBody({ outputs: [{ path: 'report.md', name: 'report.md', mime: 'text/markdown' }] }),
    );
    const receipt = (await submit.json()) as { runId: string };
    await waitForTerminal(h.base, alphaKey, receipt.runId);

    const launch = h.worker.launches[0]!;
    expect(launch['outputs']).toEqual([{ path: 'report.md', name: 'report.md', mime: 'text/markdown' }]);

    const result = (await (await getResult(h.base, alphaKey, receipt.runId)).json()) as { outputRefs: string[]; persistence: string };
    expect(result.outputRefs).toEqual(['https://github.com/owner/name/blob/abc1234/report.md']);
    expect(result.persistence).toBe('persisted');
  });

  it('ответ без объявленных выходов не притворяется сохранённым: ссылок нет, persistence not_required', async () => {
    const h = await startHttpHarness({ worker: { artifacts: [] } });
    const submit = await postSubmit(h.base, alphaKey, 'idem-no-outputs', submitBody());
    const receipt = (await submit.json()) as { runId: string };
    await waitForTerminal(h.base, alphaKey, receipt.runId);

    const result = (await (await getResult(h.base, alphaKey, receipt.runId)).json()) as {
      outputRefs: string[];
      persistence: string;
      persistenceReason: string;
    };
    expect(result.outputRefs).toEqual([]);
    expect(result.persistence).toBe('not_required');
    expect(result.persistenceReason).toContain('no artifacts');
  });

  it('выход, о котором воркер не сообщил, не появляется в списке молча', async () => {
    const h = await startHttpHarness({
      worker: { artifacts: [{ path: 'report.md', name: 'report.md', mime: 'text/markdown', sha256: 'b'.repeat(64), size: 10 }] },
    });
    const submit = await postSubmit(
      h.base,
      alphaKey,
      'idem-partial-outputs',
      submitBody({ outputs: [{ path: 'report.md' }, { path: 'summary.md' }] }),
    );
    const receipt = (await submit.json()) as { runId: string };
    await waitForTerminal(h.base, alphaKey, receipt.runId);

    const page = (await (await fetch(`${h.base}/v1/runs/${receipt.runId}/artifacts`, { headers: authHeader(alphaKey) })).json()) as {
      count: number;
      artifacts: Array<{ path: string }>;
    };
    // `summary.md` воркер не коммитил — в ссылках его нет, и API не дорисовывает его сам.
    expect(page.count).toBe(1);
    expect(page.artifacts.map((entry) => entry.path)).toEqual(['report.md']);
    expect(page.artifacts.map((entry) => entry.path)).not.toContain('summary.md');
  });

  it('пока воркер не ответил, status = running, а результат не выдаётся', async () => {
    const h = await startHttpHarness({ worker: { delayMs: 300 } });
    const submit = await postSubmit(h.base, alphaKey, 'idem-inflight', submitBody());
    const receipt = (await submit.json()) as { runId: string };

    await waitForAsync(async () => {
      const view = (await (await getStatus(h.base, alphaKey, receipt.runId)).json()) as { state: string };
      return view.state === 'running';
    }, 8000, 'run to be running');

    const early = await getResult(h.base, alphaKey, receipt.runId);
    expect(early.status).toBe(409);

    await waitForTerminal(h.base, alphaKey, receipt.runId);
    const validated = (await (await getResult(h.base, alphaKey, receipt.runId)).json()) as unknown;
    expect(validateRunResult(validated).ok).toBe(true);
  }, 30000);

  it('отмена рана до ответа воркера финализирует его как cancelled', async () => {
    const h = await startHttpHarness({ worker: { delayMs: 300 } });
    const submit = await postSubmit(h.base, alphaKey, 'idem-cancel-inflight', submitBody());
    const receipt = (await submit.json()) as { runId: string };
    expect((await postCancel(h.base, alphaKey, receipt.runId, {})).status).toBe(202);
    expect(await waitForTerminal(h.base, alphaKey, receipt.runId)).toBe('cancelled');
  }, 30000);
});
