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

/**
 * Редакция по значению: точные строки секретов, которые хост отдал рану.
 *
 * Редакция по шаблону (`redactSecrets`) узнаёт только известные формы токенов.
 * Значение, которое хост выдал агенту, знает только хост — поэтому всё, что покидает
 * хост, редактируется по самому значению, а не по его форме.
 *
 * Заменяются обе формы строки: сама и её JSON-экранированная. Экранированная форма нужна
 * для транскрипта сессии: там секрет лежит внутри JSON-строки, и прямая замена исходной
 * строки его бы не нашла. Обе формы не вносят в текст кавычек и обратных слэшей, поэтому
 * JSON после замены остаётся валидным.
 */
export function redactSecretValues(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    for (const form of secretForms(secret)) {
      if (out.includes(form)) out = out.split(form).join('[redacted]');
    }
  }
  return out;
}

function secretForms(secret: string): string[] {
  const escaped = JSON.stringify(secret).slice(1, -1);
  return escaped === secret ? [secret] : [secret, escaped];
}

/**
 * Редакция по значению в байтах: для файлов, которые публикуются как есть.
 *
 * Текстовый разбор здесь не годится: файл профиля может быть бинарным, и перекодировка
 * испортила бы его. Поэтому замена идёт по байтам, а маркер — та же строка `[redacted]`.
 * Если ни один секрет не найден, возвращается тот же массив: копия не делается зря.
 */
export function redactSecretBytes(bytes: Uint8Array, secrets: readonly string[]): Uint8Array {
  let out = bytes;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    for (const form of secretForms(secret)) {
      const needle = new TextEncoder().encode(form);
      if (needle.length === 0) continue;
      const replaced = replaceAll(out, needle, new TextEncoder().encode('[redacted]'));
      if (replaced !== out) out = replaced;
    }
  }
  return out;
}

function replaceAll(haystack: Uint8Array, needle: Uint8Array, replacement: Uint8Array): Uint8Array {
  const first = indexOf(haystack, needle, 0);
  if (first === -1) return haystack;
  const parts: Uint8Array[] = [];
  let cursor = 0;
  let at = first;
  while (at !== -1) {
    parts.push(haystack.subarray(cursor, at), replacement);
    cursor = at + needle.length;
    at = indexOf(haystack, needle, cursor);
  }
  parts.push(haystack.subarray(cursor));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = Math.max(0, from); i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}