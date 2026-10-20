import { readFile, writeFile } from 'node:fs/promises';

/**
 * Обновление пина сборки форка.
 *
 * Пин — это пять значений, которые задают, какую именно сборку форка OpenCode
 * получит подписанный релиз воркера. Их нельзя расставлять по одному:
 * несовпадение версии и бинарного sha256 означает, что подписанный релиз
 * воркера соберётся с чужим бинарём, а проверка в самом CI это заметит
 * только на сборке. Поэтому переписываем набор целиком и отказываем, если
 * хоть одно значение отсутствует или не проходит проверку формы.
 *
 * Пин лежит в файле данных, а не в конфигурации workflow: токен GitHub
 * Actions не может изменить файл под `.github/workflows`, поэтому пин в
 * самом workflow обновлял только человек, и хук промоушена доставлял новую
 * сборку вручную. Файл данных CI обновляет сам.
 */

export const PIN_FIELDS = [
  'OPENCODE_RELEASE_TAG',
  'OPENCODE_VERSION',
  'OPENCODE_SOURCE_SHA',
  'OPENCODE_ARCHIVE_SHA256',
  'OPENCODE_BINARY_SHA256',
];

const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_TAG = /^mem-preview-\d{8}-[A-Za-z0-9.-]+$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/** Проверяет форму всех пяти значений пина. */
export function assertOpenCodePin(pin) {
  if (!RELEASE_TAG.test(pin?.OPENCODE_RELEASE_TAG ?? '')) throw new Error(`Invalid fork release tag: ${pin?.OPENCODE_RELEASE_TAG}`);
  if (typeof pin?.OPENCODE_VERSION !== 'string' || !VERSION.test(pin.OPENCODE_VERSION)) {
    throw new Error(`OpenCode version must be a plain version string: ${pin?.OPENCODE_VERSION}`);
  }
  if (!SOURCE_COMMIT.test(pin?.OPENCODE_SOURCE_SHA ?? '')) throw new Error('OpenCode source SHA must be a full 40-character Git SHA');
  if (!SHA256.test(pin?.OPENCODE_ARCHIVE_SHA256 ?? '')) throw new Error('OpenCode archive SHA-256 must be 64 lowercase hex characters');
  if (!SHA256.test(pin?.OPENCODE_BINARY_SHA256 ?? '')) throw new Error('OpenCode binary SHA-256 must be 64 lowercase hex characters');
  return pin;
}

/** Значения пина из файла данных. Отсутствующее поле — ошибка. */
export function readOpenCodePin(pinText) {
  let parsed;
  try {
    parsed = JSON.parse(pinText);
  } catch (error) {
    throw new Error(`OpenCode pin file is not valid JSON: ${error.message}`);
  }
  const pin = {};
  for (const field of PIN_FIELDS) {
    if (typeof parsed?.[field] !== 'string' || parsed[field].length === 0) {
      throw new Error(`OpenCode pin file is missing ${field}`);
    }
    pin[field] = parsed[field];
  }
  return assertOpenCodePin(pin);
}

/** Переписывает набор пина целиком; возвращает новое содержимое файла. */
export function writeOpenCodePin(pinText, pin) {
  assertOpenCodePin(pin);
  let parsed;
  try {
    parsed = JSON.parse(pinText);
  } catch (error) {
    throw new Error(`OpenCode pin file is not valid JSON: ${error.message}`);
  }
  const updated = { ...parsed };
  for (const field of PIN_FIELDS) updated[field] = pin[field];
  return `${JSON.stringify(updated, null, 2)}\n`;
}

/** Собирает пин из решения гейта (`promotion-decision.json`). */
export function pinFromDecision(decision) {
  if (decision?.outcome !== 'promote') {
    throw new Error(`Refusing to build a pin from a decision that is not a promotion: ${decision?.outcome}`);
  }
  const candidate = decision.candidate ?? {};
  return assertOpenCodePin({
    OPENCODE_RELEASE_TAG: candidate.tag,
    OPENCODE_VERSION: candidate.version,
    OPENCODE_SOURCE_SHA: candidate.sourceCommit,
    OPENCODE_ARCHIVE_SHA256: candidate.archiveSha256,
    OPENCODE_BINARY_SHA256: candidate.binarySha256,
  });
}

const invokedDirectly = process.argv[1]?.endsWith('update-opencode-release-pin.mjs');
if (invokedDirectly) {
  const [decisionPath, pinPath, outputPath] = process.argv.slice(2);
  if (!decisionPath || !pinPath) {
    throw new Error('Usage: update-opencode-release-pin.mjs <promotion-decision.json> <opencode-release-pin.json> [<output.json>]');
  }
  const decision = JSON.parse(await readFile(decisionPath, 'utf8'));
  const pin = pinFromDecision(decision);
  const currentText = await readFile(pinPath, 'utf8');
  const current = readOpenCodePin(currentText);
  const unchanged = PIN_FIELDS.every((field) => current[field] === pin[field]);
  if (unchanged) {
    process.stdout.write(`OpenCode pin is already ${pin.OPENCODE_RELEASE_TAG}; nothing to update\n`);
    process.exit(0);
  }
  const updated = writeOpenCodePin(currentText, pin);
  // Без выходного пути пин переписывается на месте: иначе скрипт только
  // печатал новый файл, пин в репозитории не менялся, а хук рапортовал об
  // успешном промоушене.
  await writeFile(outputPath ?? pinPath, updated);
  process.stdout.write(`Pinned OpenCode fork ${pin.OPENCODE_RELEASE_TAG} (${pin.OPENCODE_SOURCE_SHA}) in ${outputPath ?? pinPath}\n`);
}
