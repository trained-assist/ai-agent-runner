import { readFile } from 'node:fs/promises';
import { PIN_FIELDS, readOpenCodePin } from './update-opencode-release-pin.mjs';

/**
 * Решение: нужен ли воркеру новый релиз под пин, который уже лежит в main.
 *
 * Цикл промоушена замыкается не пином в git, а установленной сборкой: хост
 * смотрит на последний подписанный релиз `vm-worker-v*`, а не на ветку main.
 * Поэтому «пин в main свежее, чем то, что в последнем релизе» — это
 * отставший релиз, который хук режет и катит сам. Без этой связи промоушен
 * обрывался на PR: пин доехал до main, а прод продолжал обслуживать старую
 * сборку до ближайшего ручного релиза.
 *
 * Решение принимается только по двум файлам пина (main и тег последнего
 * релиза): сравниваются ровно пять закреплённых полей, поэтому отставший
 * релиз ловится и когда его собрали с другим бинарём, и когда упала деплой
 * часть прошлого цикла.
 */

export function planWorkerRelease({ mainPin, latestTag = null, latestPin = null } = {}) {
  const main = readOpenCodePin(JSON.stringify(mainPin));
  if (!latestTag) {
    return { needed: true, latestTag: null, reason: 'No worker release exists yet; the pinned fork build needs a first signed release' };
  }
  if (!latestPin) {
    return { needed: true, latestTag, reason: `Release ${latestTag} does not carry a readable worker release pin; the pinned fork build needs a new release` };
  }
  const released = readOpenCodePin(JSON.stringify(latestPin));
  const drifted = PIN_FIELDS.filter((field) => main[field] !== released[field]);
  if (drifted.length > 0) {
    return {
      needed: true,
      latestTag,
      reason: `Release ${latestTag} bundles ${released.OPENCODE_RELEASE_TAG}, while main pins ${main.OPENCODE_RELEASE_TAG}; fields differ: ${drifted.join(', ')}`,
    };
  }
  return { needed: false, latestTag, reason: `Release ${latestTag} already bundles the fork build pinned on main (${main.OPENCODE_RELEASE_TAG})` };
}

const invokedDirectly = process.argv[1]?.endsWith('vm-worker-release-plan.mjs');
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const read = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const mainPinPath = read('--main-pin');
  if (!mainPinPath) {
    throw new Error('Usage: vm-worker-release-plan.mjs --main-pin <opencode-release-pin.json> [--latest-tag <tag>] [--latest-pin <opencode-release-pin.json>]');
  }
  const latestPinPath = read('--latest-pin');
  const latestTag = read('--latest-tag') || null;
  const plan = planWorkerRelease({
    mainPin: JSON.parse(await readFile(mainPinPath, 'utf8')),
    latestTag,
    latestPin: latestPinPath ? JSON.parse(await readFile(latestPinPath, 'utf8')) : null,
  });
  const lines = [`needed=${plan.needed}`, `latest_tag=${plan.latestTag ?? ''}`];
  const text = `${lines.join('\n')}\n`;
  if (process.env.GITHUB_OUTPUT) await (await import('node:fs/promises')).appendFile(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
  process.stdout.write(`${plan.needed ? 'release needed' : 'release up to date'}: ${plan.reason}\n`);
}
