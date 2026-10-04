import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, redactRepositoryToken } from '../contracts/run-spec.js';

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

export function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line;
  return `${line.slice(0, maxLen)}...[truncated]`;
}

const SECRET_PATTERNS: RegExp[] = [
  /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9]{8,}\b/g,
  /\b(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s"']+/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bx-access-token:[^@\s"']+/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) => (typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out;
}
