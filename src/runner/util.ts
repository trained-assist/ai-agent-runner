import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, redactRepositoryToken } from '../contracts/run-spec.js';

export function specHash(value: unknown): string {
  // хэш считается без repository.token: ротация токена и рестарт (state без секрета)
  // не меняют идентичность payload для дедупликации
  return createHash('sha256').update(canonicalJson(redactRepositoryToken(value))).digest('hex');
}

export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
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
