import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../runner/util.js';

export const PROMOTION_JOURNAL_SCHEMA_VERSION = 1 as const;
export const RELEASE_STATE_SCHEMA_VERSION = 1 as const;

/**
 * Виды записей журнала промоушена. Ровно те, которые I10 требует читать в логах:
 * release/config, cohort/rollback, fencing/drain/failover, retention health.
 */
export const PROMOTION_EVENT_KINDS = [
  'release_pinned',
  'cohort_configured',
  'promoted',
  'rollback',
  'rollback_resumed',
  'admission_refused',
  'drain',
  'failover',
  'fenced',
  'retention_reported',
] as const;

export type PromotionEventKind = (typeof PROMOTION_EVENT_KINDS)[number];

export interface PromotionEntry {
  schemaVersion: typeof PROMOTION_JOURNAL_SCHEMA_VERSION;
  seq: number;
  at: string;
  kind: PromotionEventKind;
  releaseId: string;
  servingReleaseId?: string;
  previousReleaseId?: string;
  cohortId?: string;
  workerId?: string;
  region?: string;
  ownerGeneration?: number;
  /** Причина перехода обязательна: по журналу должно быть видно, ПОЧЕМУ состояние сменилось. */
  reason: string;
  detail?: Record<string, unknown>;
}

export interface PromotionJournalOptions {
  /** JSONL-файл в data dir воркера; значения секретов сюда не пишутся. */
  path: string;
  releaseId: string;
  workerId?: string;
  region?: string;
  clock?: () => Date;
}

/**
 * Durable-журнал промоушена: одна строка JSON на переход, `seq` монотонный и продолжается
 * после рестарта процесса. Читается без внешних зависимостей — это и есть evidence
 * promotion/cohort/rollback/fencing, а не «есть console.log».
 */
export class PromotionJournal {
  readonly path: string;
  private readonly releaseId: string;
  private readonly workerId: string | undefined;
  private readonly region: string | undefined;
  private readonly clock: () => Date;
  private seq: number;

  constructor(options: PromotionJournalOptions) {
    this.path = options.path;
    this.releaseId = options.releaseId;
    this.workerId = options.workerId;
    this.region = options.region;
    this.clock = options.clock ?? (() => new Date());
    this.seq = countEntries(this.path);
  }

  append(entry: Omit<PromotionEntry, 'schemaVersion' | 'seq' | 'at' | 'releaseId'> & { at?: string }): PromotionEntry {
    this.seq += 1;
    const record: PromotionEntry = {
      schemaVersion: PROMOTION_JOURNAL_SCHEMA_VERSION,
      seq: this.seq,
      at: entry.at ?? this.clock().toISOString(),
      kind: entry.kind,
      releaseId: this.releaseId,
      reason: entry.reason,
      ...(entry.servingReleaseId !== undefined ? { servingReleaseId: entry.servingReleaseId } : {}),
      ...(entry.previousReleaseId !== undefined ? { previousReleaseId: entry.previousReleaseId } : {}),
      ...(entry.cohortId !== undefined ? { cohortId: entry.cohortId } : {}),
      ...(this.workerId !== undefined ? { workerId: this.workerId } : {}),
      ...(this.region !== undefined ? { region: this.region } : {}),
      ...(entry.ownerGeneration !== undefined ? { ownerGeneration: entry.ownerGeneration } : {}),
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    return record;
  }

  list(): PromotionEntry[] {
    return readJournal(this.path);
  }

  latest(): PromotionEntry | null {
    const entries = this.list();
    return entries.length > 0 ? entries[entries.length - 1]! : null;
  }

  byKind(kind: PromotionEventKind): PromotionEntry[] {
    return this.list().filter((entry) => entry.kind === kind);
  }
}

export function readJournal(path: string): PromotionEntry[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const entries: PromotionEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line) as PromotionEntry);
    } catch {
      // Повреждённая строка не должна ронять чтение журнала: она пропускается, seq остаётся монотонным.
    }
  }
  return entries;
}

function countEntries(path: string): number {
  return readJournal(path).reduce((max, entry) => (typeof entry.seq === 'number' && entry.seq > max ? entry.seq : max), 0);
}

/**
 * Состояние «кто обслуживает новые задачи». Rollback — это НЕ перезапуск задач: новые
 * приёмы когорты останавливаются, предыдущий релиз объявляется обслуживающим, а уже
 * принятые раны доигрывает их прежний владелец (AC-323/AC-324).
 */
export interface ReleaseState {
  schemaVersion: typeof RELEASE_STATE_SCHEMA_VERSION;
  /** Релиз, объявленный этим развёртыванием (кандидат). */
  releaseId: string;
  /** Релиз, который обязан обслуживать новые задачи прямо сейчас. */
  servingReleaseId: string;
  previousReleaseId: string | null;
  rolledBack: boolean;
  reason: string | null;
  updatedAt: string;
  transitions: number;
}

export interface ReleaseStateOptions {
  path: string;
  /** Релиз, объявленный этим развёртыванием (кандидат). */
  releaseId: string;
  previousReleaseId?: string | null;
  journal?: PromotionJournal;
  cohortId?: string;
  clock?: () => Date;
  readJson?: (path: string) => unknown;
}

/**
 * Контроллер состояния релиза. Файл состояния — вход деплоя: rollback готовится следующим
 * стартом, поэтому «откат проверен прогоном» = restart + чтение `GET /v1/release`.
 */
export class ReleaseStateController {
  readonly path: string;
  private readonly declaredReleaseId: string;
  private readonly journal: PromotionJournal | undefined;
  private readonly cohortId: string | undefined;
  private readonly clock: () => Date;
  private readonly readJson: (path: string) => unknown;
  private state: ReleaseState;

  constructor(options: ReleaseStateOptions) {
    this.path = options.path;
    this.declaredReleaseId = options.releaseId;
    this.journal = options.journal;
    this.cohortId = options.cohortId;
    this.clock = options.clock ?? (() => new Date());
    this.readJson = options.readJson ?? ((path: string) => JSON.parse(readFileSync(path, 'utf8')) as unknown);
    this.state = this.read(options.previousReleaseId ?? null);
  }

  get paused(): boolean {
    return this.state.rolledBack;
  }

  snapshot(): ReleaseState {
    return { ...this.state };
  }

  rollback(reason: string, actor: string, previousReleaseId?: string | null): ReleaseState {
    const serving = previousReleaseId ?? this.state.previousReleaseId;
    if (!serving || serving === this.state.releaseId) {
      throw new Error(`rollback of ${this.state.releaseId} needs the previous release id: there is nothing to fall back to`);
    }
    const previous = this.state.servingReleaseId;
    this.state = {
      ...this.state,
      servingReleaseId: serving,
      previousReleaseId: previous,
      rolledBack: true,
      reason,
      updatedAt: this.clock().toISOString(),
      transitions: this.state.transitions + 1,
    };
    this.persist();
    this.journal?.append({
      kind: 'rollback',
      reason,
      servingReleaseId: serving,
      previousReleaseId: previous,
      ...(this.cohortId !== undefined ? { cohortId: this.cohortId } : {}),
      detail: { actor, declaredReleaseId: this.state.releaseId, newAdmissions: 'refused_promotion_paused', acceptedRuns: 'stay_with_current_owner' },
    });
    return this.snapshot();
  }

  resume(reason: string, actor: string): ReleaseState {
    if (!this.state.rolledBack) return this.snapshot();
    const previous = this.state.servingReleaseId;
    this.state = {
      ...this.state,
      servingReleaseId: this.state.releaseId,
      previousReleaseId: previous,
      rolledBack: false,
      reason: null,
      updatedAt: this.clock().toISOString(),
      transitions: this.state.transitions + 1,
    };
    this.persist();
    this.journal?.append({
      kind: 'rollback_resumed',
      reason,
      servingReleaseId: this.state.servingReleaseId,
      previousReleaseId: previous,
      ...(this.cohortId !== undefined ? { cohortId: this.cohortId } : {}),
      detail: { actor, newAdmissions: 'accepted' },
    });
    return this.snapshot();
  }

  private read(previousReleaseId: string | null): ReleaseState {
    const now = this.clock().toISOString();
    let parsed: unknown;
    try {
      parsed = this.readJson(this.path);
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed !== 'object') {
      // Файла состояния нет — старт в штатном режиме: обслуживает объявленный релиз.
      return {
        schemaVersion: RELEASE_STATE_SCHEMA_VERSION,
        releaseId: this.declaredReleaseId,
        servingReleaseId: this.declaredReleaseId,
        previousReleaseId,
        rolledBack: false,
        reason: null,
        updatedAt: now,
        transitions: 0,
      };
    }
    const record = parsed as Partial<ReleaseState>;
    if (record.schemaVersion !== RELEASE_STATE_SCHEMA_VERSION || typeof record.releaseId !== 'string') {
      throw new Error(`${this.path}: unsupported release state (schemaVersion ${String(record.schemaVersion)})`);
    }
    if (record.releaseId !== this.declaredReleaseId) {
      // Состояние от другого релиза: принимать его молча нельзя — это и есть несовместимый mapping.
      throw new Error(
        `${this.path}: release state belongs to ${record.releaseId}, but this deployment declares ${this.declaredReleaseId}`,
      );
    }
    return {
      schemaVersion: RELEASE_STATE_SCHEMA_VERSION,
      releaseId: record.releaseId,
      servingReleaseId: typeof record.servingReleaseId === 'string' ? record.servingReleaseId : record.releaseId,
      previousReleaseId: typeof record.previousReleaseId === 'string' ? record.previousReleaseId : null,
      rolledBack: record.rolledBack === true,
      reason: typeof record.reason === 'string' ? record.reason : null,
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now,
      transitions: typeof record.transitions === 'number' ? record.transitions : 0,
    };
  }

  private persist(): void {
    writeFileAtomic(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}

/** Всё, что нужно, чтобы доказать «эксперимент не стал продом» без доступа к прод-хоста. */
export interface DeploymentDescriptor {
  environment: string;
  workerId: string;
  dataRoot: string;
  configDir: string;
  endpoint: { host: string; port: number };
  /** Только sha256 — значения ключей в описании нет. */
  keyHashes: string[];
  /** Префикс bucket'а/хранилища, если хранилище внешнее. */
  storagePrefix?: string;
  /** Владеет ли эта машина доставкой (бот/канал). Две машины — нельзя. */
  ownsDelivery: boolean;
}

export interface PromotionViolation {
  rule: string;
  detail: string;
}

export interface PromotionCheck {
  ok: boolean;
  violations: PromotionViolation[];
}

/**
 * Проверка границы промоушена. Один набор правил закрывает оба вопроса P29:
 * sandbox не пересекается с продом (AC-09) и релиз, объявленный для sandbox, нельзя
 * выдать за production без нового манифеста с продовыми привязками (AC-171).
 */
export function checkPromotionBoundary(source: DeploymentDescriptor, target: DeploymentDescriptor): PromotionCheck {
  const violations: PromotionViolation[] = [];

  if (source.environment === target.environment) {
    violations.push({
      rule: 'environment',
      detail: `source and target declare the same environment "${source.environment}": a distinct deployment needs its own environment label`,
    });
  }
  if (source.workerId === target.workerId) {
    violations.push({ rule: 'workerId', detail: `worker id "${source.workerId}" is used by both deployments` });
  }
  violations.push(...nestedPath('dataRoot', source.dataRoot, target.dataRoot));
  violations.push(...nestedPath('configDir', source.configDir, target.configDir));
  const sourceEndpoint = `${source.endpoint.host}:${source.endpoint.port}`;
  const targetEndpoint = `${target.endpoint.host}:${target.endpoint.port}`;
  if (sourceEndpoint === targetEndpoint) {
    violations.push({ rule: 'endpoint', detail: `both deployments listen on ${sourceEndpoint}` });
  }
  const sharedKeys = source.keyHashes.filter((hash) => target.keyHashes.includes(hash));
  if (sharedKeys.length > 0) {
    violations.push({
      rule: 'keys',
      detail: `${sharedKeys.length} key hash(es) are present in both key registries: rotating one would rotate the other`,
    });
  }
  if (source.storagePrefix !== undefined && target.storagePrefix !== undefined && source.storagePrefix === target.storagePrefix) {
    violations.push({ rule: 'storage', detail: `both deployments use storage prefix "${source.storagePrefix}"` });
  }
  if (source.ownsDelivery && target.ownsDelivery) {
    violations.push({
      rule: 'delivery',
      detail: 'both deployments claim delivery ownership: one bot/channel identity must not answer from two machines',
    });
  }
  return { ok: violations.length === 0, violations };
}

function nestedPath(rule: string, source: string, target: string): PromotionViolation[] {
  if (source === target) return [{ rule, detail: `${rule} "${source}" is shared by both deployments` }];
  if (source !== '' && target.startsWith(`${source}/`)) {
    return [{ rule, detail: `${rule} "${target}" is nested inside the other deployment's ${rule} "${source}"` }];
  }
  if (target !== '' && source.startsWith(`${target}/`)) {
    return [{ rule, detail: `${rule} "${source}" is nested inside the other deployment's ${rule} "${target}"` }];
  }
  return [];
}

/** Описание развёртывания собирается из манифеста релиза (значения секретов не нужны). */
export function descriptorFromManifest(
  manifest: {
    host: { workerId: string; environment: string; region: string; roles: { delivery: boolean }; roots: { dataDir: string; configDir: string }; endpoint: { host: string; port: number } };
  },
  keyHashes: string[],
  options: { ownsDelivery?: boolean; storagePrefix?: string } = {},
): DeploymentDescriptor {
  return {
    environment: manifest.host.environment,
    workerId: manifest.host.workerId,
    dataRoot: manifest.host.roots.dataDir,
    configDir: manifest.host.roots.configDir,
    endpoint: { host: manifest.host.endpoint.host, port: manifest.host.endpoint.port },
    keyHashes,
    ownsDelivery: options.ownsDelivery ?? manifest.host.roles.delivery,
    ...(options.storagePrefix !== undefined ? { storagePrefix: options.storagePrefix } : {}),
  };
}