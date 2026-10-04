/**
 * Санитизация текста, который уходит в логи и в тела ошибок. Живёт отдельно от `src/runner/`,
 * потому что пользуются и API, и адаптер внешнего воркера: stateless-ядру не нужен ранний
 * модуль, чтобы спрятать секрет в сообщении об ошибке.
 */

export function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line;
  return `${line.slice(0, maxLen)}...[truncated]`;
}

const SECRET_PATTERNS: RegExp[] = [
  /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bak_[0-9a-z]{16,}\b/gi,
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