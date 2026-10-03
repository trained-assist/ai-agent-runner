import { readFileSync } from 'node:fs';
import {
  ErrorCollector,
  checkArray,
  checkKeys,
  checkObject,
  checkPositiveInt,
  checkString,
  isEnvName,
  isUtcTimestamp,
  type ValidationResult,
} from '../contracts/validate.js';

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * Одна обязательная/опциональная привязка окружения. Только ИМЯ переменной, место хранения,
 * владелец и дата ротации — значения секретов в манифесте нет и быть не может: манифест
 * публикуется в репозитории и в evidence (SANDBOX.md, «Credentials и bindings»).
 */
export interface ReleaseBinding {
  name: string;
  required: boolean;
  /** Ссылка на место хранения значения: `env:/path/to/file.env`, `gcp-sm:SECRET_NAME`, … */
  source: string;
  owner: string;
  rotatedAt?: string;
}

/** Различия машин живут здесь, общий release — в `ReleaseManifest` (SANDBOX, уроки VM2). */
export interface ReleaseHostManifest {
  workerId: string;
  region: string;
  environment: string;
  roles: { schedule: boolean; delivery: boolean };
  roots: { dataDir: string; configDir: string };
  endpoint: { host: string; port: number };
  configVersion: number;
}

/**
 * Платные профили. `allowed` по умолчанию false: paid-профиль включается только явным
 * решением владельца, и тогда обязателен `approvedBy` (ссылка на решение). Пока
 * `allowed: false` — любой движок/модель из `engines` считается платным и отказом
 * от приёма задачи (AC-12, P29 «paid profiles default off»).
 */
export interface ReleasePaidPolicy {
  engines: string[];
  allowed: boolean;
  approvedBy?: string;
}

export interface ReleaseRetentionPolicy {
  /** Сколько дней хранятся события и результаты ранов (основной поток логов). */
  mainEventsDays: number;
  /** Сколько дней хранится verbose-поток (stdout/stderr рана). */
  verboseLogsDays: number;
}

export interface ReleaseManifest {
  schemaVersion: typeof RELEASE_MANIFEST_SCHEMA_VERSION;
  releaseId: string;
  /** Закреплённый source commit релиза (AC-04: версии закреплены). */
  sourceCommit: string;
  configVersion: number;
  builtAt: string;
  /** Разрешённые (бесплатные) движки; платные перечислены отдельно в `paid`. */
  engines: string[];
  paid: ReleasePaidPolicy;
  bindings: ReleaseBinding[];
  retention: ReleaseRetentionPolicy;
  host: ReleaseHostManifest;
}

export type ReleaseConfigErrorCode =
  | 'RELEASE_MANIFEST_MISSING'
  | 'RELEASE_MANIFEST_INVALID'
  | 'RELEASE_BINDING_MISSING'
  | 'RELEASE_PAID_REQUIRES_APPROVAL';

export class ReleaseConfigError extends Error {
  readonly code: ReleaseConfigErrorCode;
  readonly errors: string[];

  constructor(code: ReleaseConfigErrorCode, errors: string[]) {
    super(`${code}: ${errors.join('; ')}`);
    this.name = 'ReleaseConfigError';
    this.code = code;
    this.errors = errors;
  }
}

const HEX_COMMIT = /^[0-9a-f]{40}$/;
const MAX_ENGINE_NAME = 100;

const MANIFEST_KEYS = [
  'schemaVersion',
  'releaseId',
  'sourceCommit',
  'configVersion',
  'builtAt',
  'engines',
  'paid',
  'bindings',
  'retention',
  'host',
] as const;
const MANIFEST_REQUIRED = ['schemaVersion', 'releaseId', 'sourceCommit', 'configVersion', 'builtAt', 'engines', 'paid', 'host'] as const;
const HOST_KEYS = ['workerId', 'region', 'environment', 'roles', 'roots', 'endpoint', 'configVersion'] as const;
const HOST_REQUIRED = ['workerId', 'region', 'environment', 'roles', 'roots', 'endpoint'] as const;
const PAID_KEYS = ['engines', 'allowed', 'approvedBy'] as const;
const BINDING_KEYS = ['name', 'required', 'source', 'owner', 'rotatedAt'] as const;
const BINDING_REQUIRED = ['name', 'required', 'source', 'owner'] as const;
const RETENTION_KEYS = ['mainEventsDays', 'verboseLogsDays'] as const;

function validateStringList(value: unknown, path: string, collector: ErrorCollector, maxLen = MAX_ENGINE_NAME): string[] {
  if (!checkArray(value, path, collector)) return [];
  if (value.length > 64) collector.push(`${path}: at most 64 entries`);
  const seen = new Set<string>();
  const parsed: string[] = [];
  for (const entry of value) {
    checkString(entry, `${path}[]`, collector, maxLen);
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (seen.has(entry)) {
      collector.push(`${path}: duplicate entry "${entry}"`);
      continue;
    }
    seen.add(entry);
    parsed.push(entry);
  }
  return parsed;
}

function validateBindings(value: unknown, path: string, collector: ErrorCollector): ReleaseBinding[] {
  if (!checkArray(value, path, collector)) return [];
  if (value.length > 100) collector.push(`${path}: at most 100 bindings`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!checkObject(entry, entryPath, collector)) return { name: '', required: false, source: '', owner: '' };
    checkKeys(entry, BINDING_KEYS, BINDING_REQUIRED, entryPath, collector);
    const name = typeof entry['name'] === 'string' ? entry['name'] : '';
    if (!isEnvName(name)) collector.push(`${entryPath}.name: expected environment variable NAME`);
    if (seen.has(name)) collector.push(`${entryPath}.name: duplicate binding "${name}"`);
    seen.add(name);
    if (typeof entry['required'] !== 'boolean') collector.push(`${entryPath}.required: expected boolean`);
    if (entry['rotatedAt'] !== undefined && !isUtcTimestamp(entry['rotatedAt'])) {
      collector.push(`${entryPath}.rotatedAt: expected UTC ISO timestamp`);
    }
    const binding: ReleaseBinding = {
      name,
      required: entry['required'] === true,
      source: typeof entry['source'] === 'string' ? entry['source'] : '',
      owner: typeof entry['owner'] === 'string' ? entry['owner'] : '',
    };
    if (typeof entry['source'] === 'string') checkString(entry['source'], `${entryPath}.source`, collector, 300);
    if (typeof entry['owner'] === 'string') checkString(entry['owner'], `${entryPath}.owner`, collector, 100);
    if (typeof entry['rotatedAt'] === 'string') binding.rotatedAt = entry['rotatedAt'];
    return binding;
  });
}

function validatePaid(value: unknown, path: string, collector: ErrorCollector): ReleasePaidPolicy {
  const paid: ReleasePaidPolicy = { engines: [], allowed: false };
  if (!checkObject(value, path, collector)) return paid;
  checkKeys(value, PAID_KEYS, [], path, collector);
  paid.engines = validateStringList(value['engines'] ?? [], `${path}.engines`, collector);
  // paid по умолчанию выключен: отсутствие поля — это «off», а не «on».
  paid.allowed = value['allowed'] === true;
  if (paid.allowed) {
    if (typeof value['approvedBy'] !== 'string' || value['approvedBy'].length === 0) {
      collector.push(`${path}.approvedBy: paid profiles require an explicit owner decision reference`);
    } else {
      paid.approvedBy = value['approvedBy'];
    }
  }
  return paid;
}

function validateHost(value: unknown, path: string, collector: ErrorCollector): ReleaseHostManifest {
  const host: ReleaseHostManifest = {
    workerId: '',
    region: '',
    environment: '',
    roles: { schedule: false, delivery: false },
    roots: { dataDir: '', configDir: '' },
    endpoint: { host: '', port: 0 },
    configVersion: 0,
  };
  if (!checkObject(value, path, collector)) return host;
  checkKeys(value, HOST_KEYS, HOST_REQUIRED, path, collector);
  for (const key of ['workerId', 'region', 'environment'] as const) {
    if (typeof value[key] === 'string') {
      checkString(value[key], `${path}.${key}`, collector, 100);
      host[key] = value[key] as string;
    } else {
      collector.push(`${path}.${key}: expected non-empty string`);
    }
  }
  const roles = value['roles'];
  if (checkObject(roles, `${path}.roles`, collector)) {
    checkKeys(roles, ['schedule', 'delivery'], ['schedule', 'delivery'], `${path}.roles`, collector);
    if (typeof roles['schedule'] !== 'boolean') collector.push(`${path}.roles.schedule: expected boolean`);
    else host.roles.schedule = roles['schedule'];
    if (typeof roles['delivery'] !== 'boolean') collector.push(`${path}.roles.delivery: expected boolean`);
    else host.roles.delivery = roles['delivery'];
  }
  const roots = value['roots'];
  if (checkObject(roots, `${path}.roots`, collector)) {
    checkKeys(roots, ['dataDir', 'configDir'], ['dataDir', 'configDir'], `${path}.roots`, collector);
    for (const key of ['dataDir', 'configDir'] as const) {
      if (typeof roots[key] === 'string' && roots[key].startsWith('/')) host.roots[key] = roots[key] as string;
      else collector.push(`${path}.roots.${key}: expected absolute path`);
    }
  }
  const endpoint = value['endpoint'];
  if (checkObject(endpoint, `${path}.endpoint`, collector)) {
    checkKeys(endpoint, ['host', 'port'], ['host', 'port'], `${path}.endpoint`, collector);
    if (typeof endpoint['host'] === 'string') host.endpoint.host = endpoint['host'] as string;
    else collector.push(`${path}.endpoint.host: expected non-empty string`);
    if (typeof endpoint['port'] === 'number' && Number.isInteger(endpoint['port']) && (endpoint['port'] as number) > 0) {
      host.endpoint.port = endpoint['port'] as number;
    } else {
      collector.push(`${path}.endpoint.port: expected positive integer`);
    }
  }
  if (value['configVersion'] !== undefined) checkPositiveInt(value['configVersion'], `${path}.configVersion`, collector);
  if (typeof value['configVersion'] === 'number') host.configVersion = value['configVersion'];
  return host;
}

export function validateReleaseManifest(input: unknown): ValidationResult<ReleaseManifest> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'manifest', collector)) return collector.finish(undefined as never);
  checkKeys(input, MANIFEST_KEYS, MANIFEST_REQUIRED, 'manifest', collector);

  if (input['schemaVersion'] !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    collector.push(`manifest.schemaVersion: expected ${RELEASE_MANIFEST_SCHEMA_VERSION}`);
  }
  checkString(input['releaseId'], 'manifest.releaseId', collector, 100);
  if (typeof input['sourceCommit'] === 'string') {
    if (!HEX_COMMIT.test(input['sourceCommit'])) {
      collector.push('manifest.sourceCommit: expected a pinned 40-hex source commit');
    }
  } else {
    collector.push('manifest.sourceCommit: expected a pinned 40-hex source commit');
  }
  checkPositiveInt(input['configVersion'], 'manifest.configVersion', collector);
  if (!isUtcTimestamp(input['builtAt'])) collector.push('manifest.builtAt: expected UTC ISO timestamp');

  const engines = validateStringList(input['engines'], 'manifest.engines', collector);
  if (engines.length === 0) collector.push('manifest.engines: at least one free engine must be declared');
  const paid = validatePaid(input['paid'], 'manifest.paid', collector);
  const duplicatePaid = paid.engines.filter((engine) => engines.includes(engine));
  if (duplicatePaid.length > 0) {
    collector.push(`manifest.paid.engines: engine(s) ${duplicatePaid.join(', ')} are declared both free and paid`);
  }
  const bindings = validateBindings(input['bindings'] ?? [], 'manifest.bindings', collector);
  const retention: ReleaseRetentionPolicy = { mainEventsDays: 30, verboseLogsDays: 7 };
  if (input['retention'] !== undefined) {
    if (checkObject(input['retention'], 'manifest.retention', collector)) {
      checkKeys(input['retention'], RETENTION_KEYS, [...RETENTION_KEYS], 'manifest.retention', collector);
      if (typeof input['retention']['mainEventsDays'] === 'number') {
        retention.mainEventsDays = input['retention']['mainEventsDays'];
      }
      if (typeof input['retention']['verboseLogsDays'] === 'number') {
        retention.verboseLogsDays = input['retention']['verboseLogsDays'];
      }
    }
  }
  if (retention.verboseLogsDays > retention.mainEventsDays) {
    collector.push('manifest.retention: verboseLogsDays must not exceed mainEventsDays');
  }
  const host = validateHost(input['host'], 'manifest.host', collector);

  if (!collector.ok) return collector.finish(undefined as never);

  const manifest: ReleaseManifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseId: input['releaseId'] as string,
    sourceCommit: input['sourceCommit'] as string,
    configVersion: input['configVersion'] as number,
    builtAt: input['builtAt'] as string,
    engines,
    paid,
    bindings,
    retention,
    host,
  };
  return collector.finish(manifest);
}

/**
 * Сборка манифеста из env-хоста. Файл (`AGENT_API_RELEASE_MANIFEST`) — обычный путь:
 * values секретов там нет, только имена/источники, поэтому манифест можно публиковать.
 */
export function releaseManifestFromEnv(env: Record<string, string | undefined>, readJson: (path: string) => unknown = defaultReadJson): ReleaseManifest {
  const path = env['AGENT_API_RELEASE_MANIFEST']?.trim();
  if (!path) {
    throw new ReleaseConfigError('RELEASE_MANIFEST_MISSING', [
      'AGENT_API_RELEASE_MANIFEST is required: pinned release/config manifest (sourceCommit, configVersion, host manifest, bindings)',
    ]);
  }
  let parsed: unknown;
  try {
    parsed = readJson(path);
  } catch (err) {
    throw new ReleaseConfigError('RELEASE_MANIFEST_MISSING', [
      `${path}: cannot be read (${err instanceof Error ? err.message : String(err)})`,
    ]);
  }
  const result = validateReleaseManifest(parsed);
  if (!result.ok) throw new ReleaseConfigError('RELEASE_MANIFEST_INVALID', result.errors);
  const missing = missingRequiredBindings(result.value, env);
  if (missing.length > 0) {
    throw new ReleaseConfigError('RELEASE_BINDING_MISSING', missing);
  }
  return result.value;
}

/**
 * Обязательные binding'и проверяются по ИМЕНАМ переменных окружения: значение секрета
 * не читается и не логируется — проверяется только факт присутствия.
 */
export function missingRequiredBindings(manifest: ReleaseManifest, env: Record<string, string | undefined>): string[] {
  return manifest.bindings
    .filter((binding) => binding.required)
    .filter((binding) => {
      const value = env[binding.name];
      return value === undefined || value.trim() === '';
    })
    .map((binding) => `required binding "${binding.name}" (source: ${binding.source}) is not set`);
}

/** Платный ли это профиль по манифесту релиза. Free-only — дефолт. */
export function isPaidProfile(manifest: ReleaseManifest, engineName: string): boolean {
  if (manifest.paid.engines.includes(engineName)) return true;
  // Платный профиль не объявлен и не входит в бесплатный allowlist — считаем платным,
  // чтобы забытый движок не прошёл как бесплатный молча.
  return !manifest.engines.includes(engineName);
}

/** Идентичность релиза для логов/endpoint'а: без путей и секретов. */
export function releaseIdentity(manifest: ReleaseManifest): Record<string, unknown> {
  return {
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit,
    configVersion: manifest.configVersion,
    workerId: manifest.host.workerId,
    region: manifest.host.region,
    environment: manifest.host.environment,
    paidProfilesAllowed: manifest.paid.allowed,
  };
}

function defaultReadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}