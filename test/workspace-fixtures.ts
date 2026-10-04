/**
 * Фикстуры приёмки модуля постоянного workspace.
 *
 * Всё детерминированно и локально: «remote» — bare-репозиторий на диске (`file://`),
 * object storage и binding-хранилище — в памяти, креды не нужны вовсе. Сеть, GitHub и
 * реальные профили в приёмке не участвуют — по правилам потока менять production и
 * legacy-данные нельзя, а доказать поведение можно и так.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sha256Hex } from '../src/storage/blob-store.js';
import type { ProfileRepositoryBinding } from '../src/workspace/contract.js';
import { MemoryWorkspaceJournal } from '../src/workspace/journal.js';
import { createLocalGitPort } from '../src/workspace/git/local-git.js';
import { DEFAULT_EXPORT_POLICY } from '../src/workspace/policy.js';
import { WorkspaceService, type WorkspaceServiceDeps } from '../src/workspace/service.js';
import type {
  BindingStorePort,
  GitMirror,
  GitRepositoryPort,
  RepositoryAdminPort,
  WorkspaceObjectStore,
} from '../src/workspace/ports.js';

export const GIT_IDENTITY = ['-c', 'user.email=fixture@ai-agent-runner.test', '-c', 'user.name=fixture'];

const tempDirs: string[] = [];

export function tempDir(prefix = 'workspace-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Каталог с файлами: карта относительный путь → содержимое. */
export function writeFiles(root: string, files: Record<string, string | Buffer>): string {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

export function readFileAt(root: string, path: string): Buffer {
  return readFileSync(join(root, ...path.split('/')));
}

export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else out.push(relative);
    }
  };
  walk(root, '');
  return out.sort();
}

// ── «remote»: bare-репозитории на диске ───────────────────────────────────────

export class FakeRepositoryAdmin implements RepositoryAdminPort {
  readonly rootDir: string;
  readonly calls: string[] = [];
  readonly publicRepos = new Set<string>();
  readonly failFor = new Set<string>();
  created = 0;
  /** Репозитории, созданные этой админкой: только их `created` истинно. */
  private readonly owned = new Set<string>();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(rootDir, { recursive: true });
  }

  async ensurePrivateRepository(input: {
    owner: string;
    name: string;
    private: boolean;
    description: string;
  }): Promise<{ fullName: string; url: string; created: boolean; private: boolean }> {
    this.calls.push(`${input.owner}/${input.name}`);
    const fullName = `${input.owner}/${input.name}`;
    if (this.failFor.has(fullName)) throw new Error(`injected admin failure for ${fullName}`);
    const dir = join(this.rootDir, `${input.owner}--${input.name}.git`);
    let created = false;
    if (!existsFile(dir)) {
      mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q', '--bare', dir]);
      // Ветка по умолчанию — main (а не master): иначе clone такого репозитория
      // выглядит пустым, и приёмка получала бы пустые деревья вместо данных профиля.
      execFileSync('git', ['--git-dir', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
      this.created += 1;
      created = true;
    }
    this.owned.add(fullName);
    return {
      fullName,
      url: `file://${dir}`,
      // `created` означает «создан этим вызовом»: им пользуется ensure, чтобы отличить
      // свой пустой репозиторий от чужого существующего (его нужно проверить маркером).
      created: created || !this.owned.has(fullName) ? created : false,
      private: !this.publicRepos.has(fullName),
    };
  }

  /** Путь bare-репозитория по полному имени (для прямых проверок в тестах). */
  pathOf(fullName: string): string {
    return join(this.rootDir, `${fullName.replace('/', '--')}.git`);
  }
}

function existsFile(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Значение ref в remote (или null, если его нет). */
export function remoteRef(admin: FakeRepositoryAdmin, fullName: string, ref: string): string | null {
  const dir = admin.pathOf(fullName);
  try {
    const out = execFileSync('git', ['--git-dir', dir, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Родители коммита в remote: merge-коммит имеет двух, обычный — одного. */
export function remoteParents(admin: FakeRepositoryAdmin, fullName: string, commit: string): string[] {
  const dir = admin.pathOf(fullName);
  const out = execFileSync('git', ['--git-dir', dir, 'rev-list', '--parents', '-n', '1', commit], { encoding: 'utf8' }).trim();
  return out.split(/\s+/).slice(1);
}

/** Дерево из локального зеркала модуля: так читаются кандидаты ранов, которых нет в remote. */
export async function mirrorTree(h: Harness, bindingId: string, revision: string): Promise<Record<string, string>> {
  const binding = await h.bindings.get(bindingId);
  if (!binding) throw new Error(`no binding ${bindingId}`);
  const mirror = await h.git.ensureMirror(binding, {});
  const out: Record<string, string> = {};
  for (const entry of await h.git.listTree(mirror, revision)) {
    out[entry.path] = (await h.git.readBlob(mirror, entry.oid)).toString('utf8');
  }
  return out;
}

/** Прямая публикация в «remote» мимо сервиса: имитация другого писателя профиля. */
export function commitToRemote(
  admin: FakeRepositoryAdmin,
  fullName: string,
  files: Record<string, string>,
  message = 'external publication',
): string {
  const dir = admin.pathOf(fullName);
  if (!existsFile(dir)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', dir]);
    execFileSync('git', ['--git-dir', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  const work = tempDir('workspace-remote-');
  execFileSync('git', ['clone', '-q', dir, work]);
  execFileSync('git', ['-C', work, 'config', 'user.email', 'other@fixture.test']);
  execFileSync('git', ['-C', work, 'config', 'user.name', 'other writer']);
  writeFiles(work, files);
  execFileSync('git', ['-C', work, 'add', '-A']);
  execFileSync('git', ['-C', work, 'commit', '-q', '-m', message]);
  execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'HEAD:refs/heads/main']);
  const sha = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD']).toString('utf8').trim();
  rmSync(work, { recursive: true, force: true });
  return sha;
}

export function remoteTree(admin: FakeRepositoryAdmin, fullName: string, revision = 'main'): Record<string, string> {
  const dir = admin.pathOf(fullName);
  const out: Record<string, string> = {};
  // Отсутствующая ветка — пустое состояние, а не падение фикстуры: так проверяется, что
  // публикация действительно не дошла до remote.
  try {
    execFileSync('git', ['--git-dir', dir, 'rev-parse', '--verify', '--quiet', revision], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    return out;
  }
  const raw = execFileSync('git', ['--git-dir', dir, 'ls-tree', '-r', revision]).toString('utf8');
  for (const line of raw.split('\n').filter(Boolean)) {
    const meta = line.split('\t')[0] ?? '';
    const path = line.split('\t')[1] ?? '';
    const oid = meta.split(/\s+/)[2];
    if (!oid || path === '') continue;
    out[path] = execFileSync('git', ['--git-dir', dir, 'cat-file', 'blob', oid]).toString('utf8');
  }
  return out;
}

// ── порты в памяти ─────────────────────────────────────────────────────────────

export class MemoryBindings implements BindingStorePort {
  readonly byBindingId = new Map<string, ProfileRepositoryBinding>();
  saves = 0;

  async get(bindingId: string): Promise<ProfileRepositoryBinding | null> {
    return this.byBindingId.get(bindingId) ?? null;
  }

  async findByProfile(tenantId: string, profileId: string): Promise<ProfileRepositoryBinding | null> {
    for (const binding of this.byBindingId.values()) {
      if (binding.tenantId === tenantId && binding.profileId === profileId) return binding;
    }
    return null;
  }

  async save(binding: ProfileRepositoryBinding): Promise<void> {
    this.saves += 1;
    this.byBindingId.set(binding.bindingId, binding);
  }

  async list(tenantId?: string): Promise<ProfileRepositoryBinding[]> {
    return [...this.byBindingId.values()].filter((item) => (tenantId ? item.tenantId === tenantId : true));
  }
}

export class MemoryObjects implements WorkspaceObjectStore {
  readonly objects = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly failPut = new Set<string>();
  readonly corruptGet = new Set<string>();
  unavailable = false;

  async put(key: string, bytes: Uint8Array | string): Promise<{ sha256: string; size: number; generation: string | null }> {
    if (this.unavailable) throw Object.assign(new Error('injected object storage outage'), { code: 'BLOB_BACKEND_MISCONFIGURED' });
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array);
    if (this.failPut.has(key)) throw Object.assign(new Error('injected upload failure'), { code: 'BLOB_BACKEND_MISCONFIGURED' });
    this.puts.push(key);
    this.objects.set(key, Buffer.from(buf));
    return { sha256: sha256Hex(buf), size: buf.length, generation: 'gen-1' };
  }

  async get(key: string): Promise<Buffer> {
    if (this.unavailable) throw Object.assign(new Error('injected object storage outage'), { code: 'BLOB_BACKEND_MISCONFIGURED' });
    const stored = this.objects.get(key);
    if (!stored) throw Object.assign(new Error(`no object ${key}`), { code: 404 });
    if (this.corruptGet.has(key)) return Buffer.concat([stored, Buffer.from('tampered')]);
    return Buffer.from(stored);
  }

  async head(key: string): Promise<{ size: number; generation: string | null }> {
    if (this.unavailable) throw Object.assign(new Error('injected object storage outage'), { code: 'BLOB_BACKEND_MISCONFIGURED' });
    const stored = this.objects.get(key);
    if (!stored) throw Object.assign(new Error(`no object ${key}`), { code: 404 });
    return { size: stored.length, generation: 'gen-1' };
  }
}

export interface GitInterception {
  /** Первые N вызовов pushBranch получают заданный исход (unknown/rejected/head_changed). */
  pushBranchOutcomes?: { count: number; outcome: 'unknown' | 'rejected' | 'head_changed' }[];
  /** Ошибка на N-м вызове pushBranch — имитация смерти процесса после записи кандидата. */
  throwOnPushBranchCall?: number;
  /** Имитация недоступного remote. */
  offline?: boolean;
}

/** Прокси над git-портом: единственный способ внедрить отказ push в приёмку. */
export function interceptGit(port: GitRepositoryPort, interception: GitInterception = {}): GitRepositoryPort {
  let pushCalls = 0;
  return {
    ...port,
    async pushBranch(mirror, input) {
      pushCalls += 1;
      if (interception.throwOnPushBranchCall === pushCalls) {
        throw new Error('injected process death after the candidate ref was pushed');
      }
      const queued = interception.pushBranchOutcomes?.find((item) => item.count > 0);
      if (queued) {
        queued.count -= 1;
        return { outcome: queued.outcome, detail: `injected ${queued.outcome}` };
      }
      return port.pushBranch(mirror, input);
    },
    async fetch(mirror, credentials) {
      if (interception.offline) throw new Error('injected network outage');
      return port.fetch(mirror, credentials);
    },
    async ensureMirror(binding, credentials) {
      if (interception.offline) throw new Error('injected network outage');
      return port.ensureMirror(binding, credentials);
    },
  };
}

export interface Harness {
  service: WorkspaceService;
  admin: FakeRepositoryAdmin;
  objects: MemoryObjects;
  bindings: MemoryBindings;
  journal: MemoryWorkspaceJournal;
  git: GitRepositoryPort;
  stateDir: string;
  mirrorDir: string;
}

/**
 * Сборка стенда. `interception` позволяет тесту подменить исход push — без этого
 * «timeout после записи кандидата» и «kill перед push» не воспроизводятся.
 */
export function harness(options: { interception?: GitInterception; mergeAttempts?: number; resolutionAttempts?: number; policyTextMaxBytes?: number } = {}): Harness {
  const root = tempDir('workspace-harness-');
  const stateDir = join(root, 'state');
  const mirrorDir = join(root, 'mirrors');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(mirrorDir, { recursive: true });
  // Резолвер credential'а в приёмке всегда есть: «remote» — file:// и токен не используется,
  // но наличие резолвера проверяет, что интегратор не забудет его подключить.
  const base = createLocalGitPort({ rootDir: mirrorDir, resolveCredential: async () => 'test-token' });
  const git = interceptGit(base, options.interception ?? {});
  const admin = new FakeRepositoryAdmin(join(root, 'remote'));
  const objects = new MemoryObjects();
  const bindings = new MemoryBindings();
  const journal = new MemoryWorkspaceJournal();
  const service = new WorkspaceService({
    git,
    objects,
    bindings,
    admin,
    journal,
    ...(options.mergeAttempts !== undefined ? { mergeAttempts: options.mergeAttempts } : {}),
    ...(options.resolutionAttempts !== undefined ? { resolutionAttempts: options.resolutionAttempts } : {}),
    // Порог «тяжёлого» файла меняется без потери правил исключения: иначе тест на
    // тяжёлые артефакты тихо публиковал бы credential'ы.
    ...(options.policyTextMaxBytes !== undefined
      ? {
          policy: {
            ...DEFAULT_EXPORT_POLICY,
            policyId: 'test-policy',
            textMaxBytes: options.policyTextMaxBytes,
            maxFiles: 500,
            maxTotalBytes: 32 * 1024 * 1024,
          },
        }
      : {}),
  });
  return { service, admin, objects, bindings, journal, git, stateDir, mirrorDir };
}

/** Зеркало профиля для прямых проверок git-состояния. */
export async function mirrorOf(h: Harness, bindingId: string, url: string, branch = 'main'): Promise<GitMirror> {
  return h.git.ensureMirror(
    {
      schemaVersion: 1,
      bindingId,
      tenantId: 'tenant-a',
      profileId: 'p',
      owner: 'o',
      repository: url,
      url,
      private: true,
      branch,
      headRevision: null,
      importedAt: null,
      importManifestHash: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {},
  );
}

export function serviceDeps(h: Harness): WorkspaceServiceDeps {
  return {
    git: h.git,
    objects: h.objects,
    bindings: h.bindings,
    admin: h.admin,
    journal: h.journal,
  };
}
