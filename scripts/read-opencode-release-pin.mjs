import { readFile } from 'node:fs/promises';
import { PIN_FIELDS, readOpenCodePin } from './update-opencode-release-pin.mjs';

/**
 * Печатает пин сборки форка как экспорты для `eval` в shell-шаге workflow.
 *
 * Значения проходят проверку формы (тег, версия, полные sha), поэтому
 * подстановка в shell безопасна: в них нет пробелов, кавычек и знаков
 * подстановки.
 */
const pinPath = process.argv[2];
if (!pinPath) {
  throw new Error('Usage: read-opencode-release-pin.mjs <opencode-release-pin.json>');
}
const pin = readOpenCodePin(await readFile(pinPath, 'utf8'));
for (const field of PIN_FIELDS) {
  process.stdout.write(`export ${field}=${JSON.stringify(pin[field])}\n`);
}
