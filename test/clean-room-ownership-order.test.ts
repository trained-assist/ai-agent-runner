import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * Порядок владения каталогами рана (issue #51; найдено на песочной VM2, где Runner
 * работает как непривилегированный сервис, а не под root).
 *
 * Каталоги среды создавались ПОСЛЕ того, как корень среды уже отдан слоту. Создать
 * запись внутри каталога, принадлежащего другому uid, может только root или процесс с
 * CAP_DAC_OVERRIDE — ровно те права, которых у Runner'а (User=sandbox + четыре
 * capability) нет и быть не должно. На привилегированной пробе это не видно: там Runner
 * работал под root, и mkdir/chown проходили.
 *
 * Тест моделирует правило DAC ядра (запись в каталоге может создать его владелец или
 * root) и прогоняет настоящий `acquire()`: слот — непривилегированный `nobody`, реальная
 * смена владельца невозможна и потому моделируется. Проверяется, что провайдер создаёт
 * все каталоги среды ДО передачи их слоту. Права после этого прежние: 0700 и
 * владелец-слот.
 *
 * Блок с `acquire()` требует POSIX-хоста, где слот ищется через `getent` (Linux). На
 * хосте без `getent` (macOS) проверяется сама модель DAC — с зубами: прежний порядок она
 * ловит, новый — нет.
 */
const trace: { owners: Map<string, number>; violations: string[]; slotUid: number } = {
  owners: new Map<string, number>(),
  violations: [],
  slotUid: -1,
};

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    chownSync: (path: string, uid: number, gid: number) => {
      trace.owners.set(String(path), uid);
      try {
        actual.chownSync(path, uid, gid);
      } catch {
        /* unprivileged CI: реальная смена владельца невозможна, правило DAC моделируется */
      }
    },
    mkdirSync: (path: string, options?: unknown) => {
      const parent = dirname(String(path));
      if (trace.owners.get(parent) === trace.slotUid) trace.violations.push(String(path));
      return actual.mkdirSync(path, options as never);
    },
  };
});

const { UnixCleanRoomProvider } = await import('../src/isolation/clean-room.js');

/** Слот без полномочий: `nobody` есть на любом POSIX-хосте, его uid ≠ uid этого процесса. */
const SLOT = 'nobody';
const slotUid = (): number => Number(execFileSync('id', ['-u', SLOT], { encoding: 'utf8' }).trim());
const hasGetent = existsSync('/usr/bin/getent');

/** Лаунчер-загстушка: реальное переключение uid проверяет проба на привилегированной VM. */
const launcher = {
  kind: 'setpriv' as const,
  wrap: (_identity: unknown, command: string, args: string[]) => ({ command, args }),
  selfTest: async () => ({ ok: true, detail: 'recording launcher' }),
};

function providerFor(rootDir: string): InstanceType<typeof UnixCleanRoomProvider> {
  return new UnixCleanRoomProvider({
    rootDir,
    policy: { mode: 'per_run_unix_identity', slots: [SLOT], toolPaths: ['/usr/bin'], runnerUid: process.getuid?.() ?? 0 },
    launcher,
    probeScript: join(rootDir, 'probe.mjs'),
    log: () => undefined,
  });
}

describe.skipIf(!hasGetent)('порядок владения каталогами чистой среды (нужен POSIX-хост с getent)', () => {
  it('acquire() создаёт все каталоги среды ДО передачи их слоту', async () => {
    trace.owners.clear();
    trace.violations.length = 0;
    trace.slotUid = slotUid();

    const rootDir = mkdtempSync(join(tmpdir(), 'clean-room-order-'));
    const provider = providerFor(rootDir);
    const runId = 'run_order';
    const cwd = join(rootDir, 'workspaces', runId);

    // На непривилегированном хосте acquire обязан закончиться ЧИСТЫМ отказом (прав на
    // setfacl/пробу нет), а не сырой ошибкой прав доступа на каталогах рана.
    let refusal: unknown = null;
    try {
      await provider.acquire(runId, 'task_order', 'profile-order', cwd);
    } catch (error) {
      refusal = error;
    }

    expect(trace.violations).toEqual([]);
    expect(refusal).not.toBeNull();
    const code = (refusal as { code?: string })?.code ?? '';
    const message = (refusal as { message?: string })?.message ?? '';
    expect(['ISOLATION_ACL_UNAVAILABLE', 'ISOLATION_PROBE_UNAVAILABLE', 'ISOLATION_PROBE_FAILED']).toContain(code);
    expect(message).not.toMatch(/EPERM|EACCES/);

    // Каталоги среды созданы и отданы слоту — перестановка не ослабила границу.
    const paths = provider.pathsFor(runId, cwd);
    for (const dir of [paths.root, paths.home, paths.config, paths.cache, paths.data, paths.tmp, paths.mcp]) {
      expect(trace.owners.get(dir)).toBe(trace.slotUid);
    }
  });
});

describe('модель правила DAC для каталогов рана', () => {
  it('создание подкаталога после отдачи родителя слоту — нарушение', async () => {
    const { mkdirSync, chownSync } = await import('node:fs');
    trace.owners.clear();
    trace.violations.length = 0;
    trace.slotUid = slotUid();

    const rootDir = mkdtempSync(join(tmpdir(), 'clean-room-order-old-'));
    const root = join(rootDir, 'root');
    const home = join(root, 'home');
    // Прежний порядок: корень отдан слоту, потом Runner создаёт в нём home.
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chownSync(root, trace.slotUid, trace.slotUid);
    mkdirSync(home, { recursive: true, mode: 0o700 });

    expect(trace.violations).toEqual([home]);
  });

  it('создание всех каталогов до отдачи — нарушений нет', async () => {
    const { mkdirSync, chownSync } = await import('node:fs');
    trace.owners.clear();
    trace.violations.length = 0;
    trace.slotUid = slotUid();

    const rootDir = mkdtempSync(join(tmpdir(), 'clean-room-order-new-'));
    const root = join(rootDir, 'root');
    const dirs = [root, join(root, 'home'), join(root, 'config'), join(root, 'tmp')];
    for (const dir of dirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const dir of dirs) chownSync(dir, trace.slotUid, trace.slotUid);

    expect(trace.violations).toEqual([]);
  });
});
