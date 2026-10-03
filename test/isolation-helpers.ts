import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessLauncher } from '../src/isolation/launcher.js';
import {
  CleanRoomError,
  RUN_ISOLATION_SCHEMA_VERSION,
  type BoundaryProbeResult,
  type CleanRoom,
  type CleanRoomLease,
  type CleanRoomPaths,
  type CleanRoomProvider,
  type IsolationCapability,
  type IsolationPolicy,
  type RunIdentity,
  type SweepOptions,
} from '../src/isolation/contract.js';

export interface LauncherCall {
  identity: RunIdentity;
  command: string;
  args: string[];
}

/**
 * Лаунчер-заглушка: записывает обёртки идентичности и ничего не меняет в команде.
 * Тесты проверяют, что движок и per-run MCP-процессы стартуют ЧЕРЕЗ лаунчер рана,
 * а реальное переключение uid проверяется пробой на песочной VM (#51).
 */
export class RecordingLauncher implements ProcessLauncher {
  readonly kind = 'setpriv' as const;
  readonly calls: LauncherCall[] = [];

  wrap(identity: RunIdentity, command: string, args: string[]): { command: string; args: string[] } {
    this.calls.push({ identity, command, args });
    return { command, args };
  }

  async selfTest(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'recording launcher: commands pass through unchanged' };
  }

  forCommand(needle: string): LauncherCall[] {
    return this.calls.filter((call) => call.args.some((arg) => arg.includes(needle)) || call.command.includes(needle));
  }
}

export interface StubProviderOptions {
  rootDir: string;
  slots?: string[];
  /** Ответ пробы границы; ok=false имитирует нарушение/недоказанную границу. */
  probe?: Partial<BoundaryProbeResult>;
  /** Проба не выполнилась вовсе (нет вывода/таймаут). */
  probeUnavailable?: boolean;
  /** Sweep оставляет каталоги на диске: слот не должен освободиться. */
  sweepFails?: boolean;
  selfTestOk?: boolean;
}

/**
 * Провайдер чистой среды без переключения uid: те же инварианты (слот, run-scoped
 * каталоги 0700, аренда, sweep, блокировка слота), но без привилегий хоста.
 */
export class StubCleanRoomProvider implements CleanRoomProvider {
  readonly policy: IsolationPolicy;
  readonly launcher: ProcessLauncher | null;
  private readonly rootDir: string;
  private readonly options: StubProviderOptions;
  private readonly store = new Map<string, CleanRoomLease>();
  private counter = 0;

  private leasePath(runId: string): string {
    return join(this.rootDir, 'identity', 'leases', `${runId}.json`);
  }

  private persist(lease: CleanRoomLease): void {
    const dir = join(this.rootDir, 'identity', 'leases');
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.leasePath(lease.runId), `${JSON.stringify(lease, null, 2)}\n`);
  }

  private load(): void {
    const dir = join(this.rootDir, 'identity', 'leases');
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as CleanRoomLease;
        if (parsed.schemaVersion === RUN_ISOLATION_SCHEMA_VERSION) this.store.set(parsed.runId, parsed);
      } catch {
        // повреждённая аренда не должна ронять чтение остальных
      }
    }
  }
  selfTestCalls = 0;
  released: Array<{ runId: string; reason: string; options: SweepOptions }> = [];

  constructor(options: StubProviderOptions, launcher: ProcessLauncher | null = null) {
    this.rootDir = options.rootDir;
    this.options = options;
    this.policy = {
      mode: 'per_run_unix_identity',
      slots: options.slots ?? ['slot-a', 'slot-b'],
      toolPaths: ['/opt/agent-tools'],
      runnerUid: typeof process.getuid === 'function' ? process.getuid() : 0,
    };
    this.launcher = launcher;
  }

  capability(): IsolationCapability {
    if (!this.launcher) return 'configured_but_refusing_runs';
    return this.options.selfTestOk === false ? 'configured_but_refusing_runs' : 'per_run_unix_identity_verified';
  }

  async selfTest(): Promise<{ ok: boolean; detail: string }> {
    this.selfTestCalls += 1;
    const ok = this.options.selfTestOk !== false && this.launcher !== null;
    return { ok, detail: ok ? 'stub self-test ok' : 'stub self-test failed' };
  }

  freeSlots(): string[] {
    this.load();
    const busy = new Set([...this.store.values()].filter((lease) => lease.status !== 'released').map((lease) => lease.identity.slotId));
    return this.policy.slots.filter((slot) => !busy.has(slot));
  }

  leases(): CleanRoomLease[] {
    this.load();
    return [...this.store.values()].sort((a, b) => a.runId.localeCompare(b.runId));
  }

  lease(runId: string): CleanRoomLease | null {
    this.load();
    return this.store.get(runId) ?? null;
  }

  pathsFor(runId: string, cwd: string): CleanRoomPaths {
    const root = join(this.rootDir, 'cleanrooms', runId);
    return {
      root,
      cwd,
      home: join(root, 'home'),
      config: join(root, 'config'),
      cache: join(root, 'cache'),
      data: join(root, 'data'),
      tmp: join(root, 'tmp'),
      mcp: join(root, 'mcp'),
    };
  }

  async acquire(runId: string, userTaskId: string, profileId: string, cwd: string): Promise<CleanRoom> {
    if (!this.launcher) throw new CleanRoomError('ISOLATION_UNAVAILABLE', 'stub provider without launcher');
    const free = this.freeSlots();
    if (free.length === 0) {
      throw new CleanRoomError('ISOLATION_SLOT_BUSY', `all ${this.policy.slots.length} identity slots are leased`, true);
    }
    this.counter += 1;
    const slotId = free[0] as string;
    const uid = 40000 + this.counter;
    const identity: RunIdentity = { slotId, username: slotId, uid, gid: uid - 1 };
    const paths = this.pathsFor(runId, cwd);
    for (const dir of [paths.root, paths.home, paths.config, paths.cache, paths.data, paths.tmp, paths.mcp, paths.cwd]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch {
        // платформа без posix-прав — каталоги всё равно остаются внутри data root
      }
    }
    if (this.options.probeUnavailable) throw new CleanRoomError('ISOLATION_PROBE_UNAVAILABLE', 'boundary probe did not produce a verdict');
    const probe: BoundaryProbeResult = {
      ok: this.options.probe?.ok ?? true,
      uid: identity.uid,
      gid: identity.gid,
      groups: [],
      checks: this.options.probe?.checks ?? [{ name: 'sibling.cwd_denied', expect: 'denied', target: '/other/run', outcome: 'denied', detail: 'EACCES' }],
      failures: this.options.probe?.failures ?? [],
    };
    if (!probe.ok) {
      throw new CleanRoomError('ISOLATION_PROBE_FAILED', `boundary probe failed: ${probe.failures.join('; ')}`);
    }
    const at = new Date().toISOString();
    const lease: CleanRoomLease = {
      schemaVersion: RUN_ISOLATION_SCHEMA_VERSION,
      runId,
      userTaskId,
      profileId,
      identity,
      paths,
      status: 'active',
      reason: null,
      createdAt: at,
      updatedAt: at,
      releasedAt: null,
    };
    this.store.set(runId, lease);
    this.persist(lease);
    return {
      runId,
      identity,
      paths,
      env: {
        HOME: paths.home,
        XDG_CONFIG_HOME: paths.config,
        XDG_CACHE_HOME: paths.cache,
        XDG_DATA_HOME: paths.data,
        TMPDIR: paths.tmp,
      },
      probe,
      acl: 'posix_0700',
    };
  }

  async sweep(room: CleanRoom, reason: string, options: SweepOptions = {}): Promise<string[]> {
    if (this.options.sweepFails) return [];
    const targets = options.keepWorkspace ? [room.paths.root] : [room.paths.root, room.paths.cwd];
    const removed: string[] = [];
    for (const target of targets) {
      if (!existsSync(target)) continue;
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
    return removed;
  }

  async release(room: CleanRoom, reason: string, options: SweepOptions = {}): Promise<void> {
    this.load();
    this.released.push({ runId: room.runId, reason, options });
    await this.sweep(room, reason, options);
    const lease = this.store.get(room.runId);
    if (!lease) return;
    const retainedWorkspace = options.keepWorkspace === true && existsSync(room.paths.cwd);
    const clean = this.options.sweepFails !== true && !retainedWorkspace;
    const next: CleanRoomLease = {
      ...lease,
      status: clean ? 'released' : 'blocked',
      reason: this.options.sweepFails === true ? 'sweep left the run directory on disk' : retainedWorkspace ? 'workspace retained as the only copy' : null,
      updatedAt: new Date().toISOString(),
      releasedAt: clean ? new Date().toISOString() : null,
    };
    this.store.set(room.runId, next);
    this.persist(next);
  }

  async reconcile(lease: CleanRoomLease, options: SweepOptions = {}): Promise<void> {
    if (lease.status === 'released') return;
    await this.release(
      { runId: lease.runId, identity: lease.identity, paths: lease.paths, env: {}, probe: null, acl: 'posix_0700' },
      'worker_restart',
      options,
    );
  }
}

export function logMessages(rootDir: string, runId: string): string[] {
  const path = join(rootDir, 'runs', runId, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { payload?: { message?: string } }).payload?.message ?? '');
}

export function eventTypes(rootDir: string, runId: string): string[] {
  const path = join(rootDir, 'runs', runId, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

export function listDir(path: string): string[] {
  return existsSync(path) ? readdirSync(path).sort() : [];
}