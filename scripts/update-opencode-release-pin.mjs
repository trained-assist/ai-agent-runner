import { readFile, writeFile } from 'node:fs/promises';

/**
 * Обновление пина сборки форка в `vm-worker-release.yml`.
 *
 * Пин — это пять значений в блоке `env` шага «Download and verify pinned
 * OpenCode fork». Их нельзя расставлять по одному: несовпадение версии и
 * бинарного sha256 означает, что подписанный релиз воркера соберётся с чужим
 * бинарём, а проверка в самом workflow это заметит только на CI. Поэтому
 * переписываем блок целиком и отказываем, если хоть одно значение не найдено
 * ровно один раз.
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

/** Значения пина из текста workflow. Отсутствующее или продублированное поле — ошибка. */
export function readOpenCodePin(workflowText) {
  const pin = {};
  for (const field of PIN_FIELDS) {
    const matches = [...workflowText.matchAll(new RegExp(`^\\s*${field}:\\s*(\\S+)\\s*$`, 'gm'))];
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one ${field} line in the worker release workflow, found ${matches.length}`);
    }
    pin[field] = matches[0][1];
  }
  return pin;
}

export function assertOpenCodePin(pin) {
  if (!RELEASE_TAG.test(pin.OPENCODE_RELEASE_TAG ?? '')) throw new Error(`Invalid fork release tag: ${pin.OPENCODE_RELEASE_TAG}`);
  if (typeof pin.OPENCODE_VERSION !== 'string' || pin.OPENCODE_VERSION.length === 0) throw new Error('OpenCode version is required');
  if (!SOURCE_COMMIT.test(pin.OPENCODE_SOURCE_SHA ?? '')) throw new Error('OpenCode source SHA must be a full 40-character Git SHA');
  if (!SHA256.test(pin.OPENCODE_ARCHIVE_SHA256 ?? '')) throw new Error('OpenCode archive SHA-256 must be 64 lowercase hex characters');
  if (!SHA256.test(pin.OPENCODE_BINARY_SHA256 ?? '')) throw new Error('OpenCode binary SHA-256 must be 64 lowercase hex characters');
  return pin;
}

/** Переписывает блок пина целиком; возвращает новый текст workflow. */
export function writeOpenCodePin(workflowText, pin) {
  assertOpenCodePin(pin);
  let updated = workflowText;
  for (const field of PIN_FIELDS) {
    const pattern = new RegExp(`^(\\s*)${field}:\\s*\\S+\\s*$`, 'gm');
    const matches = [...updated.matchAll(pattern)];
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one ${field} line to rewrite, found ${matches.length}`);
    }
    updated = updated.replace(pattern, `$1${field}: ${pin[field]}`);
  }
  return updated;
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
  const [decisionPath, workflowPath, outputPath] = process.argv.slice(2);
  if (!decisionPath || !workflowPath) {
    throw new Error('Usage: update-opencode-release-pin.mjs <promotion-decision.json> <vm-worker-release.yml> [<output.yml>]');
  }
  const decision = JSON.parse(await readFile(decisionPath, 'utf8'));
  const pin = pinFromDecision(decision);
  const current = readOpenCodePin(await readFile(workflowPath, 'utf8'));
  const unchanged = PIN_FIELDS.every((field) => current[field] === pin[field]);
  if (unchanged) {
    process.stdout.write(`OpenCode pin is already ${pin.OPENCODE_RELEASE_TAG}; nothing to update\n`);
    process.exit(0);
  }
  const updated = writeOpenCodePin(await readFile(workflowPath, 'utf8'), pin);
  if (outputPath) await writeFile(outputPath, updated);
  else process.stdout.write(updated);
  process.stdout.write(`Pinned OpenCode fork ${pin.OPENCODE_RELEASE_TAG} (${pin.OPENCODE_SOURCE_SHA}) in ${workflowPath}\n`);
}
