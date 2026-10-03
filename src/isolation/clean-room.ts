import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import {
  CleanRoomError,
  type BoundaryProbeResult,
  type CleanRoom,
  type CleanRoomAcl,
  type CleanRoomLease,
  type CleanRoomPaths,
  type CleanRoomProvider,
  type IsolationCapability,
  type IsolationPolicy,
  type RunIdentity,
  type SweepOptions,
  RUN_ISOLATION_SCHEMA_VERSION,
} from './contract.js';
import { resolveLauncher, type ProcessLauncher } from './launcher.js';
import { writeFileAtomic } from '../runner/util.js';

export interface UnixCleanRoomOptions {
  rootDir: string;
  policy: IsolationPolicy;
  /** Готовый лаунчер (тесты); без него выбирается по хосту. */
  launcher?: ProcessLauncher | null;
  /** Путь к скрипту пробы границы; по умолчанию — рядом с этим модулем в dist. */
  probeScript?: string;
  now?: () => Date;
  log?: (message: string) => void;
}

const PROBE_DEFAULT_TIMEOUT_MS = 15_000;

function defaultProbeScript(): string {
  // dist/isolation/clean-room.js → dist/isolation/probe/boundary-probe.mjs
  return new URL('./probe/boundary-probe.mjs', import.meta.url).pathname;
}

interface ExitOnce {
  once: (event: string, cb: (code: number | null) => void) => void;
}

function exitCode(child: ExitOnce): Promise<number> {
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * Реализация границы на Unix-идентичностях хоста.
 *
 * Слот = непривилегированный Unix-пользователь пула (`ta-agent-N`). На время рана слот
 * арендуется эксклюзивно: каталог рана (cwd + run-scoped HOME/config/cache/tmp) создаётся
 * с правами 0700 и владельцем-слотом, поэтому соседний ран под другим UID не может его
 * прочитать, а процесс рана не может убить соседа (EPERM) и не наследует группы Runner'а.
 */
export class UnixCleanRoomProvider implements CleanRoomProvider {
  readonly policy: IsolationPolicy;
  readonly identityEnforcement = 'enforced' as const;
  readonly launcher: ProcessLauncher | null;
  private readonly rootDir: string;
  private readonly probeScript: string;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  /** Последнее подтверждение границы на этом хосте: selfTest при старте или проба рана. */
  private verification: { ok: boolean; detail: string; at: number } | null = null;
  /**
   * Слоты, занятые в этом процессе между выбором и записью аренды. Без этого резервирования
   * два одновременных acquire'а выбирали бы один слот: между freeSlots() и writeLease()
   * есть await, и второй ран успевал прочитать пустой реестр.
   */
  private readonly reservedSlots = new Set<string>();

  constructor(options: UnixCleanRoomOptions) {
    this.rootDir = options.rootDir;
    this.policy = options.policy;
    this.launcher = options.launcher === undefined ? resolveLauncher() : options.launcher;
    this.probeScript = options.probeScript ?? defaultProbeScript();
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  capability(): IsolationCapability {
    if (!this.launcher) return 'configured_but_refusing_runs';
    // Объявляем ровно то, что подтверждено на этом хосте: selfTest при старте или проба
    // границы последнего рана. Неподтверждённая граница объявляется как отказ, а не как
    // «probably работает» — иначе клиент получил бы ложное обещание.
    return this.verification?.ok ? 'per_run_unix_identity_verified' : 'configured_but_refusing_runs';
  }

  async selfTest(): Promise<{ ok: boolean; detail: string }> {
    if (!this.launcher) return this.record({ ok: false, detail: 'no identity launcher (setpriv/runuser) on this host' });
    const slot = this.policy.slots[0];
    if (!slot) return this.record({ ok: false, detail: 'no slots configured' });
    let identity: RunIdentity;
    try {
      identity = await this.resolveSlot(slot);
    } catch (error) {
      return this.record({ ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    return this.record(await this.launcher.selfTest(identity));
  }

  private record(result: { ok: boolean; detail: string }): { ok: boolean; detail: string } {
    this.verification = { ...result, at: Date.now() };
    return result;
  }

  freeSlots(): string[] {
    // `released` — единственное состояние, в котором слот можно переиспользовать:
    // проверенный sweep закрыл аренду. Иначе закрытая аренда навсегда занимала бы слот,
    // и пул из двух слотов исчерпывался после двух ранов за жизнь хоста.
    const busy = new Set(
      this.leases()
        .filter((lease) => lease.status !== 'released')
        .map((lease) => lease.identity.slotId),
    );
    return this.policy.slots.filter((slot) => !busy.has(slot) && !this.reservedSlots.has(slot));
  }

  leases(): CleanRoomLease[] {
    const dir = this.leasesDir();
    if (!existsSync(dir)) return [];
    const leases: CleanRoomLease[] = [];
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as CleanRoomLease;
        if (parsed.schemaVersion === RUN_ISOLATION_SCHEMA_VERSION) leases.push(parsed);
      } catch {
        // повреждённая аренда не должна ронять чтение остальных
      }
    }
    return leases;
  }

  lease(runId: string): CleanRoomLease | null {
    const path = this.leasePath(runId);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as CleanRoomLease;
      return parsed.schemaVersion === RUN_ISOLATION_SCHEMA_VERSION ? parsed : null;
    } catch {
      return null;
    }
  }

  async acquire(runId: string, userTaskId: string, profileId: string, cwd: string): Promise<CleanRoom> {
    if (!this.launcher) {
      throw new CleanRoomError(
        'ISOLATION_UNAVAILABLE',
        'per-run unix identity requires setpriv/runuser on this host; refusing to fall back to the service UID',
      );
    }
    const free = this.freeSlots();
    if (free.length === 0) {
      const busy = this.leases()
        .filter((lease) => lease.status !== 'released')
        .map((lease) => `${lease.identity.slotId}:${lease.runId}:${lease.status}`)
        .join(' ');
      throw new CleanRoomError(
        'ISOLATION_SLOT_BUSY',
        `all ${this.policy.slots.length} identity slots are leased (slots: ${this.policy.slots.join(',') || 'none'}, free: ${free.join(',') || 'none'}, leases: ${busy || 'none'}, reserved: ${[...this.reservedSlots].join(',') || 'none'}); no fallback to the service UID`,
        true,
      );
    }
    const slotId = free[0] as string;
    // Резервируем слот до первого await: иначе второй одновременный ран выберет тот же.
    // Снимается в finally — после записи долговечной аренды, поэтому слот не может
    // «зависнуть» в резерве при любом отказе подъёма границы.
    this.reservedSlots.add(slotId);
    try {
      const identity = await this.resolveSlot(slotId);
      const paths = this.pathsFor(runId, cwd);
      const at = this.now().toISOString();

      // Каталоги среды создаются под служебным uid, и только потом отдаются слоту. Создать
      // каталог ВНУТРИ уже отданного слота каталога (и тем более дойти до него по пути,
      // чтобы передать владение) может только root или DAC_OVERRIDE, а Runner намеренно без
      // них работает (User=sandbox + CAP_SETUID/SETGID/CHOWN/FOWNER). Поэтому: сначала всё
      // создаётся, потом владение передаётся снизу вверх — корень среды последним.
      const runDirs = [paths.root, paths.home, paths.config, paths.cache, paths.data, paths.tmp, paths.mcp];
      for (const dir of runDirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const dir of [...runDirs].reverse()) chownSync(dir, identity.uid, identity.gid);
      this.adoptTree(paths.cwd, identity);

      // Каталоги рана у слота, но путь к ним лежит под сервисным dataDir: без явного
      // traverse-доступа процесс рана не дойдёт до собственного HOME. Доступ выдаётся
      // ТОЛЬКО слоту через ACL и только на путь (x, без r); без setfacl ран отказывает —
      // мировой o+x раскрыл бы список каталогов флота. Слабого запасного варианта нет.
      const traverse = this.ensureTraverse(paths, identity);
      if (!traverse) {
        this.removeTree(paths.root);
        this.removeTree(paths.cwd);
        this.record({ ok: false, detail: 'the run identity cannot traverse into its own room (no ACL support on this host)' });
        throw new CleanRoomError(
          'ISOLATION_ACL_UNAVAILABLE',
          `slot "${slotId}" cannot traverse to its clean room: setfacl is required to grant per-slot path access without world-traversable directories`,
        );
      }

      let acl: CleanRoomAcl = 'posix_0700';
      const runnerUid = this.policy.runnerUid ?? safeUid();
      if (runnerUid && runnerUid !== identity.uid) {
        // Доступ Runner'а нужен на ВСЕ каталоги рана, а не только на корень: persist
        // читает выходы из cwd и пишет конфиг движка в HOME/config, sweep удаляет всё
        // дерево. Раньше ACL выдавался на {root, cwd}, и persist/sweep падали с EPERM,
        // как только ран шёл не под service UID.
        acl = (await this.applyAcl([...runDirs, paths.cwd], runnerUid)) ? 'posix_0700_acl' : 'posix_0700';
      }

      const probe = await this.runProbe(runId, identity, paths);
      if (!probe) {
        // Проба не смогла выполниться — граница не доказана, ран не запускаем.
        this.removeTree(paths.root);
        this.removeTree(paths.cwd);
        this.record({ ok: false, detail: `boundary probe produced no verdict for slot "${slotId}"` });
        throw new CleanRoomError('ISOLATION_PROBE_UNAVAILABLE', `boundary probe could not run for slot "${slotId}"`);
      }
      if (!probe.ok) {
        this.removeTree(paths.root);
        this.removeTree(paths.cwd);
        this.record({ ok: false, detail: `boundary probe failed for slot "${slotId}": ${probe.failures.join('; ')}` });
        this.log(`clean_room.probe_failed runId=${runId} slot=${slotId} failures=${probe.failures.join('; ')} checks=${JSON.stringify(probe.checks)}`);
        throw new CleanRoomError('ISOLATION_PROBE_FAILED', `boundary probe failed for slot "${slotId}": ${probe.failures.join('; ')}`);
      }
      this.record({ ok: true, detail: `boundary probe passed for slot "${slotId}" (${probe.checks.length} checks)` });
      this.log(`clean_room.probe_passed runId=${runId} slot=${slotId} checks=${probe.checks.length}`);

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
      this.writeLease(lease);
      this.log(`clean_room.acquired runId=${runId} slot=${slotId} uid=${identity.uid} gid=${identity.gid} acl=${acl} probeChecks=${probe.checks.length}`);
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
        acl,
      };
    } catch (error) {
      // Слота нет на хосте — это поломка настройки границы, а не отсутствие ёмкости:
      // capabilities перестают объявлять проверенную границу.
      if (error instanceof CleanRoomError && error.code === 'ISOLATION_IDENTITY_UNAVAILABLE') {
        this.record({ ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    } finally {
      this.reservedSlots.delete(slotId);
    }
  }


  async sweep(room: CleanRoom, reason: string, options: SweepOptions = {}): Promise<string[]> {
    const targets = options.keepWorkspace ? [room.paths.root] : [room.paths.root, room.paths.cwd];
    const removed: string[] = [];
    for (const target of targets) {
      if (!existsSync(target)) continue;
      this.removeTree(target);
      removed.push(target);
    }
    this.log(`clean_room.swept runId=${room.runId} reason=${reason} removed=${removed.length} keepWorkspace=${options.keepWorkspace === true}`);
    return removed;
  }

  async release(room: CleanRoom, reason: string, options: SweepOptions = {}): Promise<void> {
    const removed = await this.sweep(room, reason, options);
    const expected = options.keepWorkspace ? [room.paths.root] : [room.paths.root, room.paths.cwd];
    const missing = expected.filter((target) => existsSync(target));
    // Единственная копия выхода осталась в workspace: каталог не трогаем, слот не отдаём.
    const retainedWorkspace = options.keepWorkspace === true && existsSync(room.paths.cwd);
    const releasable = missing.length === 0 && !retainedWorkspace;
    const lease = this.lease(room.runId);
    const at = this.now().toISOString();
    const reason2 =
      missing.length > 0
        ? `sweep left ${missing.length} target(s) behind: ${missing.join(', ')}`
        : retainedWorkspace
          ? `workspace ${room.paths.cwd} retained as the only copy of a run output`
          : null;
    const next: CleanRoomLease = {
      ...(lease ?? {
        schemaVersion: RUN_ISOLATION_SCHEMA_VERSION,
        runId: room.runId,
        userTaskId: '',
        profileId: '',
        identity: room.identity,
        paths: room.paths,
        createdAt: at,
        releasedAt: null,
      }),
      status: releasable ? 'released' : 'blocked',
      reason: reason2,
      updatedAt: at,
      releasedAt: releasable ? at : null,
    };
    this.writeLease(next);
    this.log(
      `clean_room.${releasable ? 'released' : 'blocked'} runId=${room.runId} reason=${reason} removed=${removed.length} ${reason2 ?? ''}`.trim(),
    );
  }

  async reconcile(lease: CleanRoomLease, options: SweepOptions = {}): Promise<void> {
    if (lease.status === 'released') return;
    const room: CleanRoom = {
      runId: lease.runId,
      identity: lease.identity,
      paths: lease.paths,
      env: {
        HOME: lease.paths.home,
        XDG_CONFIG_HOME: lease.paths.config,
        XDG_CACHE_HOME: lease.paths.cache,
        XDG_DATA_HOME: lease.paths.data,
        TMPDIR: lease.paths.tmp,
      },
      probe: null,
      acl: 'posix_0700',
    };
    await this.release(room, 'worker_restart', options);
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

  private leasesDir(): string {
    return join(this.rootDir, 'identity', 'leases');
  }

  private leasePath(runId: string): string {
    return join(this.leasesDir(), `${runId}.json`);
  }

  private writeLease(lease: CleanRoomLease): void {
    const dir = this.leasesDir();
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(this.leasePath(lease.runId), `${JSON.stringify(lease, null, 2)}\n`);
  }

  private async resolveSlot(slotId: string): Promise<RunIdentity> {
    const child = spawn('/usr/bin/getent', ['passwd', slotId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    const code = await exitCode(child);
    const line = out.split('\n').find((entry) => entry.trim().length > 0) ?? '';
    const parts = line.split(':');
    if (code !== 0 || parts.length < 4) {
      throw new CleanRoomError(
        'ISOLATION_IDENTITY_UNAVAILABLE',
        `slot "${slotId}" is not a unix account on this host (${err.trim() || `exit ${code}`})`,
      );
    }
    const uid = Number(parts[2]);
    const gid = Number(parts[3]);
    if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0) {
      throw new CleanRoomError('ISOLATION_IDENTITY_INVALID', `slot "${slotId}" has no usable uid/gid`);
    }
    return { slotId, username: parts[0] as string, uid, gid };
  }

  private prepareDirectory(path: string, identity: RunIdentity, mode: number): void {
    mkdirSync(path, { recursive: true, mode });
    chownSync(path, identity.uid, identity.gid);
  }

  /**
   * Проходимость пути до каталога рана и до общих бинарей инструментов.
   *
   * Каталоги рана принадлежат слоту, но путь к ним лежит под сервисными каталогами
   * (fleet root, namespace, worker, dataDir), которые закрыты для остальных. Без явного
   * traverse-доступа процесс рана не дойдёт даже до собственного HOME — граница была бы
   * декларацией. Доступ выдаётся ТОЛЬКО слоту через ACL и только на путь (x, без r):
   * список каталогов слот при этом не видит. Мировой o+x не выдаём — он открыл бы обзор
   * соседних ранов. Без setfacl ран отказывает: слабого запасного варианта нет.
   */
  private ensureTraverse(paths: CleanRoomPaths, identity: RunIdentity): boolean {
    const setfacl = findSetfacl();
    if (!setfacl) return false;
    const segments = new Set<string>();
    for (const target of [paths.root, paths.cwd, ...this.policy.toolPaths]) {
      for (const dir of this.chainToRoot(target)) segments.add(dir);
    }
    // Порядок важен: сначала закрываем свои корни, потом выдаём проходимость. Иначе
    // снятие o+x отняло бы у слота доступ, который он успел получить по старой правке.
    for (const dir of [join(this.rootDir, 'cleanrooms'), join(this.rootDir, 'workspaces')]) {
      let stat;
      try {
        stat = statSync(dir);
      } catch {
        continue;
      }
      if (stat.uid !== identity.uid && stat.mode & 0o077) chmodSync(dir, 0o700);
    }
    for (const dir of segments) {
      let stat;
      try {
        stat = statSync(dir);
      } catch {
        continue;
      }
      if (stat.uid === identity.uid) continue;
      if (stat.mode & 0o001) continue;
      const result = spawnSync(setfacl, ['-m', `u:${identity.uid}:x`, dir], { stdio: ['ignore', 'ignore', 'pipe'] });
      if (result.status !== 0) return false;
    }
    return true;
  }

  /** Все сегменты пути от корня файловой системы до каталога (включая оба). */
  private chainToRoot(target: string): string[] {
    const chain: string[] = [];
    let current = target;
    for (;;) {
      chain.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return chain.reverse();
  }

  /**
   * Владение каталогом workspace отдаётся слоту СНИЗУ ВВЕРХ: пока каталог ещё наш, в
   * него можно пройти, а `chown` требует проходимости по всем родителям. Обратный порядок
   * (сначала корень) закрывает каталог слотом (0700) и делает невозможным даже дойти до
   * его содержимого — на хосте с root это проходило молча, оставляя файлы workspace
   * принадлежащими Runner'у.
   */
  private adoptTree(path: string, identity: RunIdentity): void {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chownSync(path, identity.uid, identity.gid);
      return;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(path);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const child = join(path, entry);
      let stat;
      try {
        stat = statSync(child);
      } catch {
        continue;
      }
      if (stat.isDirectory()) this.adoptTree(child, identity);
      else chownSync(child, identity.uid, identity.gid);
    }
    chownSync(path, identity.uid, identity.gid);
    // Workspace развернут materialize'ом под сервисным uid и с правами по umask (0755):
    // оставленный таким, он читался бы соседним слотом. Для чистой среды каталог закрыт.
    try {
      if (statSync(path).mode & 0o077) chmodSync(path, 0o700);
    } catch {
      // если снять права не удалось — это поймает проба границы ниже
    }
  }

  private async applyAcl(targets: string[], runnerUid: number): Promise<boolean> {
    const setfacl = findSetfacl();
    if (!setfacl) return false;
    let applied = true;
    for (const target of targets) {
      if (!existsSync(target)) continue;
      for (const args of [
        ['-m', `u:${runnerUid}:rwx`, target],
        ['-d', '-m', `u:${runnerUid}:rwx`, target],
      ]) {
        const child = spawn(setfacl, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        if ((await exitCode(child)) !== 0) applied = false;
      }
    }
    return applied;
  }

  private runProbe(runId: string, identity: RunIdentity, paths: CleanRoomPaths): Promise<BoundaryProbeResult | null> {
    if (!this.launcher) return Promise.resolve(null);
    const launch = this.launcher.wrap(identity, process.execPath, [this.probeScript]);
    const env: Record<string, string> = {
      HOME: paths.home,
      XDG_CONFIG_HOME: paths.config,
      XDG_CACHE_HOME: paths.cache,
      XDG_DATA_HOME: paths.data,
      TMPDIR: paths.tmp,
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      RUN_CLEAN_ROOM_ID: runId,
      RUN_CLEAN_ROOM_DIR: paths.root,
      RUN_CLEAN_ROOM_CWD: paths.cwd,
      RUNNER_ROOT: this.rootDir,
      RUNNER_EXPECTED_UID: String(identity.uid),
      RUNNER_EXPECTED_GID: String(identity.gid),
      RUNNER_SIBLINGS: JSON.stringify(this.siblingHints(runId)),
      RUNNER_TOOL_PATHS: JSON.stringify(this.policy.toolPaths),
      RUNNER_CREDENTIAL_PATHS: JSON.stringify(this.credentialPaths()),
    };
    const child = spawn(launch.command, launch.args, {
      cwd: paths.cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    const timeoutMs = this.policy.probeTimeoutMs ?? PROBE_DEFAULT_TIMEOUT_MS;
    return new Promise<BoundaryProbeResult | null>((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // already gone
        }
        resolve(null);
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        const parsed = parseProbeOutput(out);
        if (parsed) {
          resolve(parsed);
          return;
        }
        this.log(`clean_room.probe_unparsed runId=${runId} stderr=${err.trim().slice(0, 300)}`);
        resolve(null);
      });
    });
  }

  private siblingHints(runId: string): Array<{ runId: string; cwd: string; home: string; pid: number }> {
    const hints: Array<{ runId: string; cwd: string; home: string; pid: number }> = [];
    for (const lease of this.leases()) {
      if (lease.runId === runId) continue;
      hints.push({ runId: lease.runId, cwd: lease.paths.cwd, home: lease.paths.home, pid: 0 });
    }
    return hints;
  }

  private credentialPaths(): string[] {
    const candidates = [join(this.rootDir, 'config', 'api-key'), join(this.rootDir, 'api-key'), join(this.rootDir, 'config', 'key-registry.json')];
    return candidates.filter((path) => existsSync(path));
  }

  private removeTree(path: string): void {
    rmSync(path, { recursive: true, force: true });
  }
}

function parseProbeOutput(out: string): BoundaryProbeResult | null {
  const line = out
    .split('\n')
    .reverse()
    .find((entry) => entry.trim().startsWith('{'));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as BoundaryProbeResult;
    if (typeof parsed.ok !== 'boolean' || !Array.isArray(parsed.checks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function findSetfacl(): string | null {
  for (const dir of (process.env['PATH'] ?? '/usr/bin:/bin').split(':')) {
    if (!dir) continue;
    const candidate = `${dir}/setfacl`;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function safeUid(): number | null {
  try {
    return typeof process.getuid === 'function' ? process.getuid() : null;
  } catch {
    return null;
  }
}
