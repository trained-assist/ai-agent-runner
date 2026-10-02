import { ErrorCollector, checkArray, checkKeys, checkObject, checkString, isSafeId, isUtcTimestamp, type ValidationResult } from '../contracts/validate.js';
import { StorageError } from './errors.js';
import { isSha256 } from './manifest.js';

export const RUN_EXPORT_SCHEMA_VERSION = 1 as const;

/**
 * `in_progress` — версия переписывается по мере продвижения экспорта; версии
 * `complete | partial | failed` неизменяемы (immutable version из карточки P07).
 */
export type RunExportStatus = 'in_progress' | 'complete' | 'partial' | 'failed';

export type ExportEntryStatus = 'exported' | 'missing' | 'failed';

/** Решение по очистке воркспейса: что удалено, что намеренно оставлено как единственная копия. */
export type CleanupDecisionKind = 'nothing_to_prune' | 'pruned' | 'retained_sole_copy';

export interface ExportEntry {
  /** Путь относительно workspace ранда, как он был объявлен в spec.outputs. */
  sourcePath: string;
  name: string;
  mime: string;
  size: number;
  sha256: string | null;
  artifactId: string | null;
  status: ExportEntryStatus;
  reason: string | null;
  /** Локальная копия не удалена: она осталась единственной копией этих байтов. */
  localCopyRetained: boolean;
}

export interface CleanupDecision {
  decision: CleanupDecisionKind;
  reason: string;
  /** sourcePath'ы, чья локальная копия намеренно сохранена. */
  retained: string[];
}

export interface ExportTotals {
  planned: number;
  exported: number;
  failed: number;
  bytes: number;
}

export interface RunExportManifest {
  schemaVersion: typeof RUN_EXPORT_SCHEMA_VERSION;
  runId: string;
  userTaskId: string;
  profileId: string;
  ownerGeneration: number;
  version: number;
  attempts: number;
  status: RunExportStatus;
  /** Явное объявление неполного экспорта: клиент читает это, а не догадывается по count. */
  partial: boolean;
  createdByRun: string;
  entries: ExportEntry[];
  totals: ExportTotals;
  cleanup: CleanupDecision;
  startedAt: string;
  updatedAt: string;
  committedAt: string | null;
}

export interface ExportContext {
  runId: string;
  userTaskId: string;
  profileId: string;
  ownerGeneration: number;
}

const MANIFEST_KEYS = [
  'schemaVersion',
  'runId',
  'userTaskId',
  'profileId',
  'ownerGeneration',
  'version',
  'attempts',
  'status',
  'partial',
  'createdByRun',
  'entries',
  'totals',
  'cleanup',
  'startedAt',
  'updatedAt',
  'committedAt',
] as const;

const ENTRY_KEYS = ['sourcePath', 'name', 'mime', 'size', 'sha256', 'artifactId', 'status', 'reason', 'localCopyRetained'] as const;

const CLEANUP_KEYS = ['decision', 'reason', 'retained'] as const;

const TOTALS_KEYS = ['planned', 'exported', 'failed', 'bytes'] as const;

const STATUSES: readonly RunExportStatus[] = ['in_progress', 'complete', 'partial', 'failed'];

const CLEANUP_DECISIONS: readonly CleanupDecisionKind[] = ['nothing_to_prune', 'pruned', 'retained_sole_copy'];

function isNullableString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function validateEntry(value: unknown, path: string, collector: ErrorCollector): void {
  if (!checkObject(value, path, collector)) return;
  checkKeys(value, ENTRY_KEYS, ENTRY_KEYS, path, collector);
  checkString(value['sourcePath'], `${path}.sourcePath`, collector, 512);
  checkString(value['name'], `${path}.name`, collector, 200);
  checkString(value['mime'], `${path}.mime`, collector, 100);
  const size = value['size'];
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) collector.push(`${path}.size: expected non-negative integer`);
  if (!isNullableString(value['sha256']) || (value['sha256'] !== null && !isSha256(value['sha256']))) {
    collector.push(`${path}.sha256: expected null or 64 lowercase hex chars`);
  }
  if (!isNullableString(value['artifactId']) || (value['artifactId'] !== null && !isSafeId(value['artifactId']))) {
    collector.push(`${path}.artifactId: expected null or an artifact id`);
  }
  const status = value['status'];
  if (status !== 'exported' && status !== 'missing' && status !== 'failed') {
    collector.push(`${path}.status: expected exported | missing | failed`);
  }
  if (!isNullableString(value['reason'])) collector.push(`${path}.reason: expected a string or null`);
  if (typeof value['localCopyRetained'] !== 'boolean') collector.push(`${path}.localCopyRetained: expected boolean`);
  // согласованность: экспортированная запись обязана иметь артефакт и размер
  if (status === 'exported') {
    if (value['artifactId'] === null || value['artifactId'] === undefined) collector.push(`${path}.artifactId: required for an exported entry`);
    if (value['sha256'] === null || value['sha256'] === undefined) collector.push(`${path}.sha256: required for an exported entry`);
  }
}

function validateCleanup(value: unknown, path: string, collector: ErrorCollector): void {
  if (!checkObject(value, path, collector)) return;
  checkKeys(value, CLEANUP_KEYS, CLEANUP_KEYS, path, collector);
  if (!(CLEANUP_DECISIONS as readonly string[]).includes(value['decision'] as string)) {
    collector.push(`${path}.decision: expected one of ${CLEANUP_DECISIONS.join(', ')}`);
  }
  checkString(value['reason'], `${path}.reason`, collector, 300);
  if (!checkArray(value['retained'], `${path}.retained`, collector)) return;
  value['retained'].forEach((entry, i) => checkString(entry, `${path}.retained[${i}]`, collector, 512));
}

function validateTotals(value: unknown, path: string, collector: ErrorCollector): void {
  if (!checkObject(value, path, collector)) return;
  checkKeys(value, TOTALS_KEYS, TOTALS_KEYS, path, collector);
  for (const key of TOTALS_KEYS) {
    const entry = value[key];
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) collector.push(`${path}.${key}: expected non-negative integer`);
  }
}

export function validateRunExportManifest(input: unknown): ValidationResult<RunExportManifest> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'runExport', collector)) return collector.finish(undefined as never);
  checkKeys(input, MANIFEST_KEYS, MANIFEST_KEYS, 'runExport', collector);

  if (input['schemaVersion'] !== RUN_EXPORT_SCHEMA_VERSION) collector.push('runExport.schemaVersion: expected 1');
  if (!isSafeId(input['runId'])) collector.push('runExport.runId: expected id');
  if (!isSafeId(input['createdByRun'])) collector.push('runExport.createdByRun: expected the run id that created this manifest');
  checkString(input['userTaskId'], 'runExport.userTaskId', collector, 200);
  checkString(input['profileId'], 'runExport.profileId', collector, 200);
  for (const key of ['version', 'attempts'] as const) {
    const entry = input[key];
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 1) collector.push(`runExport.${key}: expected positive integer`);
  }
  const generation = input['ownerGeneration'];
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) {
    collector.push('runExport.ownerGeneration: expected non-negative integer');
  }
  if (!(STATUSES as readonly string[]).includes(input['status'] as string)) {
    collector.push(`runExport.status: expected one of ${STATUSES.join(', ')}`);
  }
  if (typeof input['partial'] !== 'boolean') collector.push('runExport.partial: expected boolean');
  if (!isUtcTimestamp(input['startedAt'])) collector.push('runExport.startedAt: expected UTC ISO timestamp');
  if (!isUtcTimestamp(input['updatedAt'])) collector.push('runExport.updatedAt: expected UTC ISO timestamp');
  if (input['committedAt'] !== null && !isUtcTimestamp(input['committedAt'])) {
    collector.push('runExport.committedAt: expected a UTC ISO timestamp or null');
  }

  if (checkArray(input['entries'], 'runExport.entries', collector)) {
    if (input['entries'].length > 1000) collector.push('runExport.entries: too many entries');
    input['entries'].forEach((entry, i) => validateEntry(entry, `runExport.entries[${i}]`, collector));
  }
  validateTotals(input['totals'], 'runExport.totals', collector);
  validateCleanup(input['cleanup'], 'runExport.cleanup', collector);

  // статус и partial обязаны быть согласованы: partial manifest объявляется явно
  if (input['status'] === 'complete' && input['partial'] === true) {
    collector.push('runExport.partial: a complete export cannot be partial');
  }
  if (input['status'] === 'partial' && input['partial'] === false) {
    collector.push('runExport.partial: a partial export must declare partial=true');
  }
  if (input['status'] === 'in_progress' && input['committedAt'] !== null) {
    collector.push('runExport.committedAt: only a committed export carries a commit timestamp');
  }

  return collector.finish(input as unknown as RunExportManifest);
}

export function parseRunExportManifest(raw: string, source: string): RunExportManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StorageError('ARTIFACT_EXPORT_INVALID', `run export manifest is not valid JSON: ${source}`);
  }
  const validated = validateRunExportManifest(parsed);
  if (!validated.ok) {
    throw new StorageError('ARTIFACT_EXPORT_INVALID', `run export manifest is invalid in ${source}: ${validated.errors.join('; ')}`);
  }
  return validated.value;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  wasm: 'application/wasm',
};

export const DEFAULT_ARTIFACT_MIME = 'application/octet-stream';

/** Имя артефакта = последний сегмент объявленного пути (без директорий — их не выносим наружу). */
export function artifactNameFor(sourcePath: string): string {
  const segments = sourcePath.split('/');
  return segments[segments.length - 1] ?? sourcePath;
}

export function mimeForName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return DEFAULT_ARTIFACT_MIME;
  const extension = name.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? DEFAULT_ARTIFACT_MIME;
}