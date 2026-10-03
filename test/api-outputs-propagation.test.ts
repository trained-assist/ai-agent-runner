import { describe, expect, it } from 'vitest';
import { alphaKey, alphaPrincipal, authHeader, getStatus, postSubmit, startHttpHarness, submitBody, waitForAsync } from './api-http-harness.js';

/**
 * #54: объявленные выходы доходят до рана и переживают его через API.
 *
 * Регрессия была не в схеме запроса (её `outputs` принимал), а в сборке RunSpec:
 * `buildSpec()` терял поле, план экспорта выходил пустым, `outputRefs` в результате
 * всегда был `[]`. Проверка идёт по всей цепочке HTTP → RunSpec → экспорт → артефакт,
 * потому что каждый кусок по отдельности уже умел работать и вместе не работал.
 */
describe('объявленные выходы через API (#54)', () => {
  it('outputs запроса попадают в RunSpec, экспортируются и читаются по HTTP', async () => {
    const harness = await startHttpHarness({ artifactExport: true });

    const response = await postSubmit(harness.base, alphaKey, 'idem-outputs-e2e', submitBody({ outputs: [{ path: 'ran.txt' }] }));
    expect(response.status).toBe(202);
    const accepted = (await response.json()) as { runId: string };
    const runId = accepted.runId;

    await waitForAsync(async () => (await getStatus(harness.base, alphaKey, runId)).status === 200, 8000, 'run status to be readable');
    await waitForAsync(async () => {
      const status = (await (await getStatus(harness.base, alphaKey, runId)).json()) as { state: string };
      return status.state === 'succeeded';
    }, 8000, 'run to succeed');

    // 1. поле дошло до RunSpec: без него план экспорта пуст и сохранять нечего
    const snapshot = harness.service.runner.getRun(runId);
    expect(snapshot?.result?.outcome).toBe('succeeded');
    expect(snapshot?.export?.planned).toBe(1);
    expect(snapshot?.export?.exported).toBe(1);
    expect(snapshot?.export?.cleanup).not.toBe('nothing_to_prune');

    // 2. результат рана объявляет ссылку на сохранённый выход
    const resultResponse = await fetch(`${harness.base}/v1/runs/${runId}/result`, { headers: authHeader(alphaKey) });
    expect(resultResponse.status).toBe(200);
    const result = (await resultResponse.json()) as { outputRefs: string[]; persistence: string };
    expect(result.outputRefs).toHaveLength(1);

    // 3. артефакт виден в списке и его байты читаются обратно из хранилища
    const listResponse = await fetch(`${harness.base}/v1/runs/${runId}/artifacts`, { headers: authHeader(alphaKey) });
    expect(listResponse.status).toBe(200);
    const listing = (await listResponse.json()) as {
      count: number;
      artifacts: Array<{ artifactId: string; name: string; sha256: string }>;
      export: { status: string; exported: number };
    };
    expect(listing.count).toBe(1);
    expect(listing.artifacts[0]?.artifactId).toBe(result.outputRefs[0]);
    expect(listing.artifacts[0]?.name).toBe('ran.txt');
    expect(listing.export.status).toBe('complete');
    expect(listing.export.exported).toBe(1);

    const artifactId = result.outputRefs[0] as string;
    const bytes = await harness.artifacts?.read(runId, artifactId);
    expect(bytes?.bytes.toString('utf8')).toBe('ok');
    expect(bytes?.manifest.profileId).toBe(alphaPrincipal.profileId);
  });

  it('ответ без объявленных выходов не притворяется сохранённым: план пуст, ссылок нет', async () => {
    const harness = await startHttpHarness({ artifactExport: true });
    const response = await postSubmit(harness.base, alphaKey, 'idem-no-outputs', submitBody());
    expect(response.status).toBe(202);
    const runId = ((await response.json()) as { runId: string }).runId;
    await waitForAsync(async () => {
      const status = (await (await getStatus(harness.base, alphaKey, runId)).json()) as { state: string };
      return status.state === 'succeeded';
    }, 8000, 'run to succeed');

    const result = (await (await fetch(`${harness.base}/v1/runs/${runId}/result`, { headers: authHeader(alphaKey) })).json()) as {
      outputRefs: string[];
    };
    // Объявления не было — выдумывать ссылку нельзя, но и ран обязан завершиться успешно.
    expect(result.outputRefs).toEqual([]);
    expect(harness.service.runner.getRun(runId)?.export).toBeNull();
  });

  it('объявленный, но отсутствующий выход объявляется в манифесте, а не теряется молча', async () => {
    const harness = await startHttpHarness({ artifactExport: true });
    const response = await postSubmit(harness.base, alphaKey, 'idem-missing-output', submitBody({ outputs: [{ path: 'not-written.txt' }] }));
    expect(response.status).toBe(202);
    const runId = ((await response.json()) as { runId: string }).runId;
    await waitForAsync(async () => {
      const status = (await (await getStatus(harness.base, alphaKey, runId)).json()) as { state: string };
      return status.state === 'succeeded';
    }, 8000, 'run to succeed');

    const listing = (await (await fetch(`${harness.base}/v1/runs/${runId}/artifacts`, { headers: authHeader(alphaKey) })).json()) as {
      count: number;
      export: { status: string; planned: number; failed: number };
    };
    expect(listing.count).toBe(0);
    expect(listing.export.planned).toBe(1);
    expect(listing.export.failed).toBe(1);
    expect(listing.export.status).toBe('failed');
  });
});