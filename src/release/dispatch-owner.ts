import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DISPATCH_OWNER_STORE_SCHEMA_VERSION = 1 as const;

export type OwnershipState = 'owned' | 'draining' | 'released' | 'terminal';

export interface TaskOwnership {
  principalId: string;
  userTaskId: string;
  ownerWorkerId: string;
  ownerGeneration: number;
  runId: string | null;
  state: OwnershipState;
  previousOwnerWorkerId: string | null;
  updatedAt: string;
}

export interface FailoverSignal {
  /** Кто и почему отдал задачу: оператор, drain прежнего владельца, явная команда. */
  source: 'operator' | 'drained_owner' | 'released_owner';
  reason: string;
}

export type ClaimOutcome =
  | { outcome: 'granted'; generation: number; previousOwnerWorkerId: string | null }
  | { outcome: 'held_by_other'; ownerWorkerId: string; generation: number }
  | { outcome: 'draining' }
  | { outcome: 'partition_is_not_failover'; ownerWorkerId: string; generation: number }
  | { outcome: 'fenced'; ownerWorkerId: string; generation: number }
  | { outcome: 'already_terminal' }
  | { outcome: 'unknown_task' };

export interface DispatchOwnerStoreOptions {
  /** Общий для воркеров одной VM файл владения (0700, владелец сервисного пользователя). */
  path: string;
  workerId: string;
  clock?: () => Date;
  lockTimeoutMs?: number;
  onEvent?: (event: DispatchOwnerEvent) => void;
}

export interface DispatchOwnerEvent {
  at: string;
  workerId: string;
  event: 'claim_granted' | 'claim_held_by_other' | 'failover_granted' | 'failover_refused' | 'drained' | 'fenced' | 'released' | 'terminal';
  principalId: string;
  userTaskId: string;
  ownerGeneration: number;
  reason: string;
  previousOwnerWorkerId?: string;
}

interface StoreFile {
  schemaVersion: number;
  tasks: Record<string, TaskOwnership>;
  drains: string[];
}

const DEFAULT_LOCK_TIMEOUT_MS = 2000;

/**
 * Реестр владельцев задач для нескольких воркеров на одной VM. Он отвечает на один вопрос:
 * «кто единственный исполнитель этой задачи сейчас». Разделение сети (partition) и падение
 * НЕ являются поводом для перехвата: перехват требует явного сигнала (уточнение владельца
 * 30.09 — partition ≠ failover/rerun), а прежний владелец после перехвата fenced.
 */
export class DispatchOwnerStore {
  readonly path: string;
  readonly workerId: string;
  private readonly clock: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly onEvent: ((event: DispatchOwnerEvent) => void) | undefined;

  constructor(options: DispatchOwnerStoreOptions) {
    this.path = options.path;
    this.workerId = options.workerId;
    this.clock = options.clock ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.onEvent = options.onEvent;
  }

  /**
   * Запрос владения задачей. Первый претендент получает поколение 1; повтор того же рана
   * тем же воркером идемпотентен; НОВАЯ попытка той же задачи — следующее поколение;
   * второй воркер получает `held_by_other` и обязан не запускать вторую копию (AC-322).
   */
  claim(principalId: string, userTaskId: string, runId: string | null): ClaimOutcome {
    return this.withLock((file) => {
      const key = taskKey(principalId, userTaskId);
      const existing = file.tasks[key];
      if (file.drains.includes(this.workerId) && (!existing || existing.ownerWorkerId !== this.workerId)) {
        this.emit('drained', principalId, userTaskId, existing?.ownerGeneration ?? 0, 'worker is draining: it does not accept new tasks');
        return { outcome: 'draining' } satisfies ClaimOutcome;
      }
      if (!existing) {
        const record: TaskOwnership = {
          principalId,
          userTaskId,
          ownerWorkerId: this.workerId,
          ownerGeneration: 1,
          runId,
          state: 'owned',
          previousOwnerWorkerId: null,
          updatedAt: this.now(),
        };
        file.tasks[key] = record;
        this.emit('claim_granted', principalId, userTaskId, record.ownerGeneration, 'first owner of the task');
        return { outcome: 'granted', generation: record.ownerGeneration, previousOwnerWorkerId: null } satisfies ClaimOutcome;
      }
      if (existing.ownerWorkerId === this.workerId) {
        if (runId !== null && existing.runId === runId) {
          existing.state = 'owned';
          existing.updatedAt = this.now();
          this.emit('claim_granted', principalId, userTaskId, existing.ownerGeneration, 'idempotent re-claim of the same run by the current owner');
          return { outcome: 'granted', generation: existing.ownerGeneration, previousOwnerWorkerId: existing.previousOwnerWorkerId } satisfies ClaimOutcome;
        }
        // Новый runId для той же задачи = новая попытка: поколение обязано вырасти.
        existing.ownerGeneration += 1;
        existing.runId = runId;
        existing.state = 'owned';
        existing.updatedAt = this.now();
        this.emit('claim_granted', principalId, userTaskId, existing.ownerGeneration, 'next attempt of the same task by the current owner');
        return { outcome: 'granted', generation: existing.ownerGeneration, previousOwnerWorkerId: existing.previousOwnerWorkerId } satisfies ClaimOutcome;
      }
      if (existing.state === 'released') {
        // Прежний владелец отдал задачу сам — это явный сигнал, молчание сети им не считается.
        const previousOwner = existing.ownerWorkerId;
        existing.ownerWorkerId = this.workerId;
        existing.previousOwnerWorkerId = previousOwner;
        existing.ownerGeneration += 1;
        existing.runId = runId;
        existing.state = 'owned';
        existing.updatedAt = this.now();
        this.emit('failover_granted', principalId, userTaskId, existing.ownerGeneration, 'released_owner: previous owner gave the task up', previousOwner);
        return { outcome: 'granted', generation: existing.ownerGeneration, previousOwnerWorkerId: previousOwner } satisfies ClaimOutcome;
      }
      this.emit('claim_held_by_other', principalId, userTaskId, existing.ownerGeneration, `task is owned by ${existing.ownerWorkerId}`);
      return { outcome: 'held_by_other', ownerWorkerId: existing.ownerWorkerId, generation: existing.ownerGeneration } satisfies ClaimOutcome;
    });
  }

  /**
   * Перехват владения. Только по явному сигналу: без него возврат `partition_is_not_failover`,
   * чтобы «новый» воркер не начал дубль на основании одного молчания сети.
   */
  takeover(principalId: string, userTaskId: string, runId: string | null, signal?: FailoverSignal): ClaimOutcome {
    return this.withLock((file) => {
      const key = taskKey(principalId, userTaskId);
      const existing = file.tasks[key];
      if (!existing) {
        this.emit('failover_refused', principalId, userTaskId, 0, 'unknown task: nothing to take over');
        return { outcome: 'unknown_task' } satisfies ClaimOutcome;
      }
      if (existing.state === 'terminal') return { outcome: 'already_terminal' } satisfies ClaimOutcome;
      if (existing.ownerWorkerId === this.workerId) {
        return { outcome: 'granted', generation: existing.ownerGeneration, previousOwnerWorkerId: existing.previousOwnerWorkerId } satisfies ClaimOutcome;
      }
      if (!signal) {
        this.emit('failover_refused', principalId, userTaskId, existing.ownerGeneration, 'partition is not failover: an explicit signal is required');
        return { outcome: 'partition_is_not_failover', ownerWorkerId: existing.ownerWorkerId, generation: existing.ownerGeneration } satisfies ClaimOutcome;
      }
      const previousOwner = existing.ownerWorkerId;
      const previousGeneration = existing.ownerGeneration;
      file.tasks[key] = {
        principalId,
        userTaskId,
        ownerWorkerId: this.workerId,
        ownerGeneration: existing.ownerGeneration + 1,
        runId,
        state: 'owned',
        previousOwnerWorkerId: previousOwner,
        updatedAt: this.now(),
      };
      this.emit(
        'failover_granted',
        principalId,
        userTaskId,
        existing.ownerGeneration + 1,
        `${signal.source}: ${signal.reason}`,
        previousOwner,
      );
      this.emit('fenced', principalId, userTaskId, previousGeneration, `previous owner ${previousOwner} is fenced at generation ${previousGeneration}`);
      return { outcome: 'granted', generation: existing.ownerGeneration + 1, previousOwnerWorkerId: previousOwner } satisfies ClaimOutcome;
    });
  }

  /** Прежний владелец отдаёт задачу сам: это и есть явный сигнал для следующего воркера. */
  release(principalId: string, userTaskId: string, reason: string): void {
    this.withLock((file) => {
      const existing = file.tasks[taskKey(principalId, userTaskId)];
      if (!existing) return;
      existing.state = 'released';
      existing.runId = null;
      existing.updatedAt = this.now();
      this.emit('released', principalId, userTaskId, existing.ownerGeneration, reason);
    });
  }

  markTerminal(principalId: string, userTaskId: string, reason: string): void {
    this.withLock((file) => {
      const existing = file.tasks[taskKey(principalId, userTaskId)];
      if (!existing) return;
      existing.state = 'terminal';
      existing.updatedAt = this.now();
      this.emit('terminal', principalId, userTaskId, existing.ownerGeneration, reason);
    });
  }

  /** Drain воркера: новые задачи он не берёт, уже принятые — свои. */
  drain(reason: string): void {
    this.withLock((file) => {
      if (!file.drains.includes(this.workerId)) file.drains.push(this.workerId);
      for (const record of Object.values(file.tasks)) {
        if (record.ownerWorkerId === this.workerId && record.state === 'owned') {
          record.state = 'draining';
          record.updatedAt = this.now();
        }
      }
      this.emit('drained', '', '', 0, reason);
    });
  }

  isDraining(): boolean {
    return this.withLock((file) => file.drains.includes(this.workerId), { write: false });
  }

  /**
   * Может ли этот воркер продолжать работу по задаче. Прежний владелец после failover
   * получает `fenced` — его поздний вывод не должен менять текущую попытку (INV-02).
   */
  checkOwner(principalId: string, userTaskId: string): { owner: boolean; outcome: ClaimOutcome } {
    return this.withLock(
      (file) => {
        const existing = file.tasks[taskKey(principalId, userTaskId)];
        if (!existing) return { owner: false, outcome: { outcome: 'unknown_task' } as ClaimOutcome };
        if (existing.ownerWorkerId === this.workerId && existing.state !== 'released') {
          return { owner: true, outcome: { outcome: 'granted', generation: existing.ownerGeneration, previousOwnerWorkerId: existing.previousOwnerWorkerId } as ClaimOutcome };
        }
        const outcome: ClaimOutcome =
          existing.state === 'terminal'
            ? { outcome: 'already_terminal' }
            : { outcome: 'fenced', ownerWorkerId: existing.ownerWorkerId, generation: existing.ownerGeneration };
        this.emit('fenced', principalId, userTaskId, existing.ownerGeneration, `${this.workerId} is not the owner (owner ${existing.ownerWorkerId})`);
        return { owner: false, outcome };
      },
      { write: false },
    );
  }

  get(principalId: string, userTaskId: string): TaskOwnership | null {
    return this.withLock((file) => file.tasks[taskKey(principalId, userTaskId)] ?? null, { write: false });
  }

  /** Срез для `GET /v1/release`: сколько задач держит этот воркер, кто ещё в реестре. */
  view(): { workerId: string; draining: boolean; owned: number; drainingTasks: number; owners: Array<{ workerId: string; tasks: number }> } {
    return this.withLock(
      (file) => {
        const byWorker = new Map<string, number>();
        let owned = 0;
        let drainingTasks = 0;
        for (const record of Object.values(file.tasks)) {
          byWorker.set(record.ownerWorkerId, (byWorker.get(record.ownerWorkerId) ?? 0) + 1);
          if (record.ownerWorkerId === this.workerId) {
            if (record.state === 'owned') owned += 1;
            if (record.state === 'draining') drainingTasks += 1;
          }
        }
        return {
          workerId: this.workerId,
          draining: file.drains.includes(this.workerId),
          owned,
          drainingTasks,
          owners: [...byWorker.entries()].map(([workerId, tasks]) => ({ workerId, tasks })).sort((a, b) => (a.workerId < b.workerId ? -1 : 1)),
        };
      },
      { write: false },
    );
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private emit(
    event: DispatchOwnerEvent['event'],
    principalId: string,
    userTaskId: string,
    ownerGeneration: number,
    reason: string,
    previousOwnerWorkerId?: string,
  ): void {
    if (!this.onEvent) return;
    this.onEvent({
      at: this.now(),
      workerId: this.workerId,
      event,
      principalId,
      userTaskId,
      ownerGeneration,
      reason,
      ...(previousOwnerWorkerId !== undefined ? { previousOwnerWorkerId } : {}),
    });
  }

  private read(): StoreFile {
    if (!existsSync(this.path)) return { schemaVersion: DISPATCH_OWNER_STORE_SCHEMA_VERSION, tasks: {}, drains: [] };
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile;
    if (parsed.schemaVersion !== DISPATCH_OWNER_STORE_SCHEMA_VERSION || typeof parsed.tasks !== 'object' || parsed.tasks === null) {
      throw new Error(`dispatch owner store: unsupported schema ${String(parsed.schemaVersion)} at ${this.path}`);
    }
    return { ...parsed, drains: Array.isArray(parsed.drains) ? parsed.drains : [] };
  }

  /**
   * Read-modify-write под эксклюзивным lock-файлом: два процесса на одной VM (симуляция
   * двух воркеров) не могут выдать владение одной задачей дважды.
   */
  private withLock<T>(fn: (file: StoreFile) => T, options: { write?: boolean } = {}): T {
    const write = options.write ?? true;
    const lockPath = `${this.path}.lock`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockTimeoutMs;
    let fd: number | null = null;
    for (;;) {
      try {
        fd = openSync(lockPath, 'wx', 0o600);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // Зависший lock старше 30 с — это не «занято», это упавший процесс: снимаем.
        try {
          const age = Date.now() - statSync(lockPath).mtimeMs;
          if (age > 30_000) unlinkSync(lockPath);
        } catch {
          // lock уже снят другим процессом — следующая итерация.
        }
        if (Date.now() >= deadline) {
          throw new Error(`dispatch owner store: lock at ${lockPath} is busy after ${this.lockTimeoutMs}ms`);
        }
        sleepSyncMs(10);
      }
    }
    try {
      const file = this.read();
      const result = fn(file);
      if (write) writeFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      return result;
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        // lock уже удалён — ничего страшного.
      }
    }
  }
}

function taskKey(principalId: string, userTaskId: string): string {
  return `${principalId}\u0000${userTaskId}`;
}

/** Синхронная пауза без busy-loop: блокировка хранилища воркеров короткая, event loop тут не нужен. */
function sleepSyncMs(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

export function dispatchOwnerStorePath(dataDir: string, fleetId: string): string {
  return join(dataDir, 'fleet', fleetId, 'owners.json');
}