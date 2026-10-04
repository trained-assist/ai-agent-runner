import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, redactRepositoryToken } from '../contracts/run-spec.js';
import { redactSecrets, truncateLine } from '../redact.js';

let atomicCounter = 0;

export function specHash(value: unknown): string {
  // хэш считается без repository.token: ротация токена и рестарт (state без секрета)
  // не меняют идентичность payload для дедупликации
  return createHash('sha256').update(canonicalJson(redactRepositoryToken(value))).digest('hex');
}

/**
 * Запись «всё или ничего»: временный файл рядом и rename. Принимает байты, а не только
 * текст, — материализация входа переносит артефакты побайтно (issue #52).
 *
 * Имя временного файла уникально на запись (pid + счётчик). Фиксированное `<path>.tmp`
 * означало гонку, когда файл пишут два процесса: первый забирает временный файл rename'ом,
 * второй получает ENOENT и роняет старт воркера — а он стартовал из-за чужого рана.
 */
export function writeFileAtomic(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicCounter += 1;
  const tmp = `${path}.${process.pid}.${atomicCounter}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export { redactSecrets, truncateLine };
