import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, waitFor } from './helpers.js';
import { logMessages } from './isolation-helpers.js';

/**
 * Уборка проверяется, а не предполагается (issue #52; найдено на песочной VM2).
 *
 * Workspace рана может оказаться недоступен Runner'у: каталоги принадлежат слоту, и ACL,
 * выданный прежней версией хоста, мог не дойти до поддерева. Раньше `rmSync` бросал
 * EACCES прямо из `recover()`, и воркер не стартовал вообще — нечитаемая уборка одного
 * прошлого рана делала недоступным чтение всех остальных: healthz не отвечал, control
 * plane видел Runner как недоступный. Теперь это «уборка не завершена» с причиной:
 * слот остаётся заблокированным, сервис поднимается и читает тот же Run.
 */
describe('уборка workspace, который Runner не может удалить', () => {
  it('восстановление не падает: уборка pending с причиной, тот же Run читается', async () => {
    const h = createHarness({ artifactExport: true });
    // Сбой уборки оставляет рана в финализации с записанным намерением уборки — ровно то
    // состояние, из которого восстановление после рестарта дожимает уборку заново.
    h.faults.inject('cleanup', { kind: 'throw', once: true });
    const { receipt, spec } = h.start({ outputs: [{ path: 'ran.txt' }] });
    await waitFor(() => h.runner.getRun(receipt.runId)?.state === 'finalizing');

    // Каталог, который не удалить даже владельцу: mode 000 недоступен и непривилегированному
    // владельцу, поэтому rmSync упадёт EACCES — как каталог слота без выданного ACL.
    const locked = join(spec.cwd, 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'data.bin'), 'x');
    chmodSync(locked, 0o000);
    chmodSync(spec.cwd, 0o500);

    try {
      const reopened = h.reopenWithoutDispose();
      // Раньше здесь бросалось EACCES и старт воркера падал целиком.
      const report = await reopened.recover();
      expect(report.scanned).toBeGreaterThan(0);

      // Тот же Run читается после рестарта: результат, выходы и состояние уборки на месте.
      const snapshot = reopened.getRun(receipt.runId);
      expect(snapshot?.runId).toBe(receipt.runId);
      expect(snapshot?.result?.cleanup).toBe('pending');
      expect(snapshot?.result?.cleanupReason ?? '').toMatch(/could not be removed/);

      // Причина видна в логе рана, а не теряется в исключении старта.
      const messages = logMessages(h.rootDir, receipt.runId);
      expect(messages.some((line) => line.startsWith('clean_room.sweep_failed'))).toBe(true);
      // Ничего не удалено «наполовину успешно»: непроходимый каталог остался на месте.
      expect(existsSync(locked)).toBe(true);
    } finally {
      chmodSync(locked, 0o700);
      chmodSync(spec.cwd, 0o700);
    }
  });
});
