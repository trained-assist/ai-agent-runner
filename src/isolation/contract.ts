/**
 * Контракт Agent clean room (issue #51): минимальная проверяемая OS-граница каждого Run.
 *
 * Граница — отдельная Unix-идентичность на ран (пул непривилегированных пользователей,
 * эксклюзивно арендуемый на время рана) + run-scoped HOME/config/cache/tmp + минимальный
 * env/credential binding + тот же режим для per-run MCP-процессов. Никакого нового
 * управляющего сервиса и никакой VM на ран: граница живёт на хосте Runner'а.
 *
 * Fail-closed: если границу невозможно поднять (нет привилегий, нет слотов, проба
 * границы не прошла), ран отказывает ДО спавна движка. Fallback к service UID запрещён.
 */

import type { ProcessLauncher } from './launcher.js';

export const RUN_ISOLATION_SCHEMA_VERSION = 1 as const;

/** Режимы, которые хост умеет исполнять. `none` — ран не требует границы. */
export type IsolationMode = 'per_run_unix_identity' | 'none';

/**
 * Что хост честно объявляет о своей границе:
 *  - `not_proven_service_uid_only` — провайдер не настроен, движок идёт под service UID;
 *  - `per_run_unix_identity_verified` — провайдер настроен и проба границы прошла;
 *  - `configured_but_refusing_runs` — провайдер настроен, но проба не прошла: раны
 *    отказывают, а не запускаются с более широкими правами.
 */
export type IsolationCapability = 'not_proven_service_uid_only' | 'per_run_unix_identity_verified' | 'configured_but_refusing_runs';

export interface IsolationPolicy {
  mode: IsolationMode;
  /** Имена Unix-пользователей пула слотов (например `ta-agent-1`). */
  slots: string[];
  /** Общие read-only каталоги с бинарями инструментов (движок, node, git). */
  toolPaths: string[];
  /** UID самого Runner'а: ему выдаётся ACL-доступ в каталог рана для persist/sweep. */
  runnerUid?: number;
  probeTimeoutMs?: number;
}

/** Арендованная на ран Unix-идентичность. */
export interface RunIdentity {
  slotId: string;
  username: string;
  uid: number;
  gid: number;
}

/** Каталоги чистой среды рана. Всё, что принадлежит рану, живёт внутри `root`. */
export interface CleanRoomPaths {
  root: string;
  cwd: string;
  home: string;
  config: string;
  cache: string;
  data: string;
  tmp: string;
  mcp: string;
}

export type BoundaryCheckOutcome = 'denied' | 'allowed' | 'error' | 'skipped';

export interface BoundaryCheck {
  name: string;
  expect: 'denied' | 'allowed';
  target: string;
  outcome: BoundaryCheckOutcome;
  detail: string;
}

export interface BoundaryProbeResult {
  ok: boolean;
  uid: number;
  gid: number;
  groups: number[];
  checks: BoundaryCheck[];
  failures: string[];
}

export type CleanRoomAcl = 'posix_0700' | 'posix_0700_acl';

export interface CleanRoom {
  runId: string;
  identity: RunIdentity;
  paths: CleanRoomPaths;
  /** Дополнительные переменные окружения движка: run-scoped HOME/config/cache/tmp. */
  env: Record<string, string>;
  probe: BoundaryProbeResult | null;
  acl: CleanRoomAcl;
}

export type CleanRoomLeaseStatus = 'active' | 'sweeping' | 'released' | 'blocked';

/**
 * Долговечная аренда идентичности. Живёт на диске, поэтому переживает рестарт воркера:
 * слот не переиспользуется, пока аренда не переведена в `released` проверенным sweep.
 */
export interface CleanRoomLease {
  schemaVersion: typeof RUN_ISOLATION_SCHEMA_VERSION;
  runId: string;
  userTaskId: string;
  profileId: string;
  identity: RunIdentity;
  paths: CleanRoomPaths;
  status: CleanRoomLeaseStatus;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  releasedAt: string | null;
}

export class CleanRoomError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'CleanRoomError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface SweepOptions {
  /**
   * Оставить workspace рана на диске (единственная копия не сохранена в хранилище).
   * Эфемерные каталоги (HOME/config/cache/tmp/MCP) при этом всё равно вычищаются,
   * а слот НЕ освобождается: переиспользование открыло бы прежние данные.
   */
  keepWorkspace?: boolean;
}

export interface CleanRoomProvider {
  readonly policy: IsolationPolicy;
  /**
   * Обещание провайдера по идентичности. `enforced` — переключение на хосте реально
   * происходит, и Runner сверяет uid процесса движка по /proc и отказывает при расхождении.
   * `simulated` — провайдер без привилегий (тесты/пробы в CI): переключения нет, сверка не
   * выполняется, и это объявляется в логе рана, а не проходит молча.
   */
  readonly identityEnforcement: 'enforced' | 'simulated';
  /** Лаунчер переключения идентичности для движка и per-run MCP-процессов. */
  readonly launcher: ProcessLauncher | null;
  /** Честная декларация хоста для `GET /v1/capabilities`. */
  capability(): IsolationCapability;
  /** Слоты, свободные прямо сейчас (нет активной/незавершённой аренды). */
  freeSlots(): string[];
  /** Поднять границу для рана. Отказ = ран не запускается. */
  acquire(runId: string, userTaskId: string, profileId: string, cwd: string): Promise<CleanRoom>;
  /** Удалить каталоги рана. Идемпотентно: повторный вызов не ошибка. */
  sweep(room: CleanRoom, reason: string, options?: SweepOptions): Promise<string[]>;
  /** Sweep + освобождение слота. Слот освобождается только после проверенного удаления. */
  release(room: CleanRoom, reason: string, options?: SweepOptions): Promise<void>;
  /** Восстановление после рестарта: повторить persist/sweep без запуска движка. */
  reconcile(lease: CleanRoomLease, options?: SweepOptions): Promise<void>;
  /** Долговечный список аренд (для recover() и диагностики). */
  leases(): CleanRoomLease[];
  /** Одна аренда по runId; null, если аренды нет или она повреждена. */
  lease(runId: string): CleanRoomLease | null;
  /** Проверка хоста: есть ли привилегии и работает ли переключение идентичности. */
  selfTest(): Promise<{ ok: boolean; detail: string }>;
}

export const ISOLATION_MODES: readonly IsolationMode[] = ['per_run_unix_identity', 'none'];

export function isIsolationMode(value: unknown): value is IsolationMode {
  return typeof value === 'string' && (ISOLATION_MODES as readonly string[]).includes(value);
}
