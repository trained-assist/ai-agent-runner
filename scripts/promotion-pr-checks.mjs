import { readFile } from 'node:fs/promises';

/**
 * Состояние проверок PR, по которому хук решает, можно ли сливать промоушен.
 *
 * Хук ждёт зелёного CI перед merge, и решение об этом не должно жить в
 * регулярном выражении внутри shell-шага: там легко ошибиться в разборе
 * списка проверок (у PR их несколько, и одна зелёная ещё не делает PR
 * зелёным). Поэтому разбор списка проверок живёт здесь, а workflow только
 * спрашивает ответ.
 *
 * Состояния:
 *   `green`   — все проверки прошли: можно сливать;
 *   `failed`  — есть проваленная, отменённая или требующая действия проверка:
 *               PR остаётся открытым, промоушен останавливается;
 *   `pending` — проверки ещё идут;
 *   `none`    — проверок пока нет: CI ещё не стартовал.
 */

const FAILURE = /FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE|STALE/i;
const SUCCESS = /SUCCESS/i;

export function classifyPrChecks(statusCheckRollup, pullRequestState = null) {
  const entries = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  if (pullRequestState === 'MERGED') {
    return { state: 'merged', failed: [], pending: [], reason: 'Pull request is already merged' };
  }
  if (entries.length === 0) {
    return { state: 'none', failed: [], pending: [], reason: 'No checks reported yet' };
  }
  const conclusions = entries.map((entry) => String(entry?.conclusion ?? entry?.status ?? 'PENDING'));
  const failed = conclusions.filter((conclusion) => FAILURE.test(conclusion));
  const pending = conclusions.filter((conclusion) => !SUCCESS.test(conclusion) && !FAILURE.test(conclusion));
  if (failed.length > 0) {
    return { state: 'failed', failed, pending, reason: `Failed checks: ${failed.join(', ')}` };
  }
  if (pending.length === 0) {
    return { state: 'green', failed, pending, reason: `${conclusions.length} check(s) succeeded` };
  }
  return { state: 'pending', failed, pending, reason: `Waiting for: ${pending.join(', ')}` };
}

const invokedDirectly = process.argv[1]?.endsWith('promotion-pr-checks.mjs');
if (invokedDirectly) {
  const path = process.argv[2];
  const text = path
    ? await readFile(path, 'utf8')
    : await new Promise((resolve, reject) => {
        let buffer = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
          buffer += chunk;
        });
        process.stdin.on('end', () => resolve(buffer));
        process.stdin.on('error', reject);
      });
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Pull request checks are not valid JSON: ${error.message}`);
  }
  const verdict = classifyPrChecks(payload?.statusCheckRollup, payload?.state ?? null);
  process.stdout.write(`${verdict.state}\n`);
  process.stderr.write(`${verdict.reason}\n`);
}
