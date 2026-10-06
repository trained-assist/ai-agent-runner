export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export class SpecValidationError extends Error {
  readonly code = 'SPEC_VALIDATION_FAILED';
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`invalid input: ${errors.join('; ')}`);
    this.name = 'SpecValidationError';
    this.errors = errors;
  }
}

export class ConflictError extends Error {
  readonly code = 'OPERATION_CONFLICT';
  readonly operationId: string;

  constructor(operationId: string, detail: string) {
    super(`operation conflict for ${operationId}: ${detail}`);
    this.name = 'ConflictError';
    this.operationId = operationId;
  }
}

export class PreflightError extends Error {
  readonly code: string;
  readonly failureClass: 'preflight' | 'runtime';
  readonly retryable: boolean;

  constructor(code: string, message: string, opts?: { failureClass?: 'preflight' | 'runtime'; retryable?: boolean }) {
    super(message);
    this.name = 'PreflightError';
    this.code = code;
    this.failureClass = opts?.failureClass ?? 'preflight';
    this.retryable = opts?.retryable ?? false;
  }
}

export class EngineStartupError extends Error {
  readonly code = 'ENGINE_STARTUP_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'EngineStartupError';
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL_CHARS = /[\x00-\x1f]/;

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && SAFE_ID.test(value);
}

export function isEnvName(value: unknown): value is string {
  return typeof value === 'string' && ENV_NAME.test(value);
}

export function isUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ErrorCollector {
  private readonly items: string[] = [];

  push(message: string): void {
    this.items.push(message);
  }

  get errors(): string[] {
    return [...this.items];
  }

  get ok(): boolean {
    return this.items.length === 0;
  }

  finish<T>(value: T): ValidationResult<T> {
    return this.ok ? { ok: true, value } : { ok: false, errors: this.errors };
  }
}

export function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  collector: ErrorCollector,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      collector.push(`${path}: unknown field "${key}" (secrets must not be part of the contract)`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      collector.push(`${path}: missing required field "${key}"`);
    }
  }
}

export function checkString(value: unknown, path: string, collector: ErrorCollector, maxLen = 400): void {
  if (typeof value !== 'string' || value.length === 0) {
    collector.push(`${path}: expected non-empty string`);
    return;
  }
  if (value.length > maxLen) {
    collector.push(`${path}: longer than ${maxLen}`);
  }
  if (CONTROL_CHARS.test(value)) {
    collector.push(`${path}: control characters are not allowed`);
  }
}

export function checkText(value: unknown, path: string, collector: ErrorCollector, maxLen = 400): void {
  if (typeof value !== 'string' || value.length === 0) {
    collector.push(`${path}: expected non-empty string`);
    return;
  }
  if (value.length > maxLen) {
    collector.push(`${path}: longer than ${maxLen}`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    collector.push(`${path}: control characters are not allowed`);
  }
}

export function checkSafeId(value: unknown, path: string, collector: ErrorCollector): void {
  if (!isSafeId(value)) {
    collector.push(`${path}: expected id matching ${SAFE_ID.source}`);
  }
}

export function checkPositiveInt(value: unknown, path: string, collector: ErrorCollector): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    collector.push(`${path}: expected positive integer`);
  }
}

export function checkObject(value: unknown, path: string, collector: ErrorCollector): value is Record<string, unknown> {
  if (!isRecord(value)) {
    collector.push(`${path}: expected object`);
    return false;
  }
  return true;
}

export function checkArray(value: unknown, path: string, collector: ErrorCollector): value is unknown[] {
  if (!Array.isArray(value)) {
    collector.push(`${path}: expected array`);
    return false;
  }
  return true;
}
