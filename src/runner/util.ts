import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from '../contracts/run-spec.js';

export function specHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
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
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) => (typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out;
}
