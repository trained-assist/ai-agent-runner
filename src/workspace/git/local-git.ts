/**
 * Локальный git-порт поверх CLI `git`.
 *
 * Три свойства, ради которых реализация написана именно так:
 *
 * 1. **Секрет не попадает в argv.** Токен передаётся потомку через `GIT_ASKPASS` и
 *    переменную окружения; в аргументах команд его нет (argv виден всем локальным
 *    пользователям через `ps`). Это наследует приёмку `runner/repository.ts`.
 * 2. **Нет force push.** `pushBranch` отправляет коммит без `--force`: сравнение
 *    «ожидаемая голова == текущая» обеспечивает сам git (fast-forward only), а порт
 *    переводит отказ в `head_changed`. Перезаписать чужую голову нечем.
 * 3. **Никакой работы в workspace рана.** Зеркало — bare-репозиторий модуля, индекс
 *    временный. В clean room агента не появляется ни `.git`, ни remote, ни
 *    организационного credential'а.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactSecrets } from '../../runner/util.js';
import { WorkspaceError, type ProfileRepositoryBinding } from '../contract.js';
import { isTransientFailure, sleep, RETRY_DELAYS_MS } from './transient.js';
import {
  GIT_MODE_FILE,
  type CredentialResolver,
  type GitAuthor,
  type GitCredentials,
  type GitMirror,
  type GitRepositoryPort,
  type GitTreeEntry,
  type PushOutcome,
  type TreeWrite,
} from '../ports.js';

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;
export const DEFAULT_BRANCH = 'main';
export const CANDIDATE_REF_PREFIX = 'refs/workspace/publications/';
export const RUN_BRANCH_REF_PREFIX = 'refs/heads/agent-run/';
export const SYNC_BRANCH_REF_PREFIX = 'refs/heads/profile-sync/';

/**
 * Статический askpass-помошник: значение подставляется из окружения процесса, в файл
 * не пишется. Ровно тот же приём, что в `runner/repository.ts`, чтобы не заводить
 * второй способ передачи секрета в git.
 */
const ASKPASS_SCRIPT = ['#!/bin/sh', "case \"$1\" in", "  *sername*) printf '%s\\n' 'x-access-token' ;;", '  *) printf \'%s\\n\' "$WORKSPACE_GIT_TOKEN" ;;', 'esac', ''].join('\n');

/** Конфиг git для аутентификации: пустой credential helper + токен через askpass. */
const AUTH_CONFIG = ['-c', 'credential.helper=', '-c', 'credential.useHttpPath=true'];

export interface LocalGitPortOptions {
  /** Корень, где живут bare-зеркала модуля. */
  rootDir: string;
  /**
   * Резолвер credential'а: значение уходит в git-процесс и не возвращается в модуль.
   * Без него зеркала читаются/пишутся без аутентификации (локальные file:// тесты).
   */
  resolveCredential?: CredentialResolver;
  timeoutMs?: number;
  defaultBranch?: string;
  author?: GitAuthor;
  /** URL удалённого репозитория: по умолчанию берётся из binding. */
  remoteUrl?: (binding: ProfileRepositoryBinding) => string;
}

interface RunResult {
  code: number;
  stdout: string;
  stdoutBytes: Buffer;
  stderr: string;
  timedOut: boolean;
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: Buffer;
  timeoutMs?: number;
}

export function createLocalGitPort(options: LocalGitPortOptions): GitRepositoryPort {
  if (typeof options.rootDir !== 'string' || options.rootDir.length === 0) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'local git port requires a root directory for mirrors');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const defaultBranch = options.defaultBranch ?? DEFAULT_BRANCH;
  const author = options.author ?? { name: 'Trained Assist Workspace', email: 'workspace@trained-assist.invalid' };
  const remoteUrl = options.remoteUrl ?? ((binding: ProfileRepositoryBinding) => binding.url);

  const run = (args: string[], opts: RunOptions = {}): Promise<RunResult> =>
    new Promise<RunResult>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_PAGER: 'cat',
        LC_ALL: 'C',
        ...opts.env,
      };
      const child = spawn('git', args, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrLength = 0;
      let timedOut = false;
      let settled = false;
      const limit = opts.timeoutMs ?? timeoutMs;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, limit);
      timer.unref?.();

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= 64 * 1024 * 1024) stdoutChunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrLength += chunk.length;
        if (stderrLength <= 64 * 1024) stderrChunks.push(chunk);
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err.code === 'ENOENT') {
          reject(new WorkspaceError('WORKSPACE_GIT_FAILED', 'git is not available on this host; the profile workspace cannot be published', { retryable: false }));
          return;
        }
        reject(new WorkspaceError('WORKSPACE_GIT_FAILED', `git ${args[0] ?? ''} failed: ${redactSecrets(err.message)}`, { retryable: true }));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const out = Buffer.concat(stdoutChunks);
        resolve({
          code: code ?? -1,
          stdout: out.toString('utf8'),
          stdoutBytes: out,
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          timedOut,
        });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input ?? Buffer.alloc(0));
    });

  const inMirror = (mirror: GitMirror, args: string[], opts: RunOptions = {}): Promise<RunResult> => run(['--git-dir', mirror.dir, ...args], opts);

  const requireOk = async (args: string[], opts: RunOptions = {}): Promise<string> => {
    const result = await run(args, opts);
    if (result.timedOut) {
      throw new WorkspaceError('WORKSPACE_GIT_FAILED', `git ${args.join(' ')} timed out after ${opts.timeoutMs ?? timeoutMs}ms`, { retryable: true });
    }
    if (result.code !== 0) {
      throw new WorkspaceError('WORKSPACE_GIT_FAILED', `git ${args.join(' ')} failed (exit ${result.code}): ${summarize(result.stderr)}`, { retryable: true });
    }
    return result.stdout;
  };

  /**
   * Запуск с credential'ом: токен кладётся в окружение конкретного процесса и в
   * `GIT_ASKPASS`, а не в argv. Временный скрипт удаляется сразу после вызова.
   */
  const runAuthenticated = async (args: string[], credentials: GitCredentials | undefined, opts: RunOptions = {}): Promise<RunResult> => {
    const token = await resolveToken(options.resolveCredential, credentials);
    if (token === undefined) return run(args, opts);
    const dir = mkdtempSync(join(tmpdir(), 'workspace-git-askpass-'));
    const script = join(dir, 'askpass.sh');
    try {
      writeFileSync(script, ASKPASS_SCRIPT, { mode: 0o700 });
      return await run([...AUTH_CONFIG, ...args], { ...opts, env: { ...opts.env, GIT_ASKPASS: script, WORKSPACE_GIT_TOKEN: token } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const withTempIndex = async <T>(body: (env: Record<string, string>) => Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'workspace-git-index-'));
    try {
      return await body({ GIT_INDEX_FILE: join(dir, 'index') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const head = async (mirror: GitMirror, ref?: string): Promise<string | null> => {
    const target = ref ?? defaultBranch;
    const result = await inMirror(mirror, ['rev-parse', '--verify', '--quiet', `refs/heads/${target}^{commit}`]);
    if (result.code !== 0) return null;
    const sha = result.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  };

  const catBlob = async (mirror: GitMirror, oid: string): Promise<Buffer> => {
    const result = await inMirror(mirror, ['cat-file', 'blob', oid]);
    if (result.code !== 0 || result.timedOut) {
      throw new WorkspaceError('WORKSPACE_GIT_FAILED', `cat-file ${oid} failed: ${summarize(result.stderr)}`, { retryable: true });
    }
    return result.stdoutBytes;
  };

  const hashObject = async (mirror: GitMirror, bytes: Buffer): Promise<string> => {
    const result = await inMirror(mirror, ['hash-object', '-w', '--stdin'], { input: bytes });
    if (result.code !== 0) {
      throw new WorkspaceError('WORKSPACE_GIT_FAILED', `hash-object failed: ${summarize(result.stderr)}`, { retryable: true });
    }
    return result.stdout.trim();
  };

  /**
   * Сборка дерева идёт через временный индекс и ОДИН `update-index --index-info`:
   * bare-репозиторий не имеет рабочего дерева, поэтому `--force-remove`/`--cacheinfo`
   * здесь неприменимы (git требует worktree), а формат `mode SP oid TAB path` с mode `0`
   * добавляет и удаляет пути без него. Один процесс вместо N — ещё и атомарнее: индекс
   * либо обновлён целиком, либо нет.
   */
  const writeTree = async (mirror: GitMirror, baseRevision: string | null, writes: readonly TreeWrite[]): Promise<string> =>
    withTempIndex(async (env) => {
      if (baseRevision) await requireOk(['--git-dir', mirror.dir, 'read-tree', baseRevision], { env });
      if (writes.length > 0) {
        const payload = writes
          .map((write) =>
            write.oid === null
              ? `0 ${'0'.repeat(40)}\t${write.path}\n`
              : `${write.mode ?? GIT_MODE_FILE} ${write.oid}\t${write.path}\n`,
          )
          .join('');
        await requireOk(['--git-dir', mirror.dir, 'update-index', '--index-info'], { env, input: Buffer.from(payload, 'utf8') });
      }
      return (await requireOk(['--git-dir', mirror.dir, 'write-tree'], { env })).trim();
    });

  const commitTree = async (
    mirror: GitMirror,
    input: { tree: string; parents: string[]; message: string; author: GitAuthor; metadata?: Record<string, string> },
  ): Promise<string> => {
    const args = ['commit-tree', input.tree];
    for (const parent of input.parents) args.push('-p', parent);
    args.push('-m', input.message);
    if (input.metadata) {
      for (const [key, value] of Object.entries(input.metadata)) args.push('-m', `${key}: ${value}`);
    }
    const env: Record<string, string> = {
      GIT_AUTHOR_NAME: input.author.name,
      GIT_AUTHOR_EMAIL: input.author.email,
      GIT_COMMITTER_NAME: input.author.name,
      GIT_COMMITTER_EMAIL: input.author.email,
      // Фиксированные даты: два одинаковых прогона дают одинаковый commit sha, и
      // идемпотентность публикации проверяется по содержимому, а не по времени.
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00+0000',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00+0000',
    };
    return (await requireOk(['--git-dir', mirror.dir, ...args], { env })).trim();
  };

  /**
   * Слияние одного файла. `git merge-file` читает файлы, а не stdin, поэтому три
   * версии кладутся во временный каталог; он удаляется в `finally` — артефактов слияния
   * вне временного каталога не остаётся.
   */
  const mergeBlobs = async (
    mirror: GitMirror,
    input: { baseOid: string | null; currentOid: string | null; otherOid: string | null },
  ): Promise<{ status: 'clean' | 'conflict' | 'unchanged'; oid: string | null; detail: string | null }> => {
    const { baseOid, currentOid, otherOid } = input;
    if (baseOid === null || currentOid === null || otherOid === null) {
      return { status: 'conflict', oid: null, detail: 'a side of the merge is missing' };
    }
    const base = await catBlob(mirror, baseOid);
    const current = await catBlob(mirror, currentOid);
    const other = await catBlob(mirror, otherOid);
    if (isBinary(base) || isBinary(current) || isBinary(other)) {
      return { status: 'conflict', oid: null, detail: 'binary content cannot be merged automatically' };
    }
    const dir = mkdtempSync(join(tmpdir(), 'workspace-git-merge-'));
    try {
      writeFileSync(join(dir, 'current'), current);
      writeFileSync(join(dir, 'base'), base);
      writeFileSync(join(dir, 'other'), other);
      const result = await run(['merge-file', '-p', '--diff3', join(dir, 'current'), join(dir, 'base'), join(dir, 'other')]);
      if (result.timedOut) {
        throw new WorkspaceError('WORKSPACE_GIT_FAILED', `merge-file timed out after ${timeoutMs}ms`, { retryable: true });
      }
      if (result.code === 0) {
        return { status: 'clean', oid: await hashObject(mirror, result.stdoutBytes), detail: null };
      }
      if (result.code === 1) return { status: 'conflict', oid: null, detail: 'overlapping edits in the same file' };
      throw new WorkspaceError('WORKSPACE_GIT_FAILED', `merge-file failed: ${summarize(result.stderr)}`, { retryable: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const pushAuthenticated = async (
    mirror: GitMirror,
    args: string[],
    credentials: GitCredentials,
  ): Promise<{ outcome: PushOutcome; detail: string | null }> => classifyPush(await runAuthenticated(['--git-dir', mirror.dir, ...args], credentials));

  /** Кандидатские ref'ы тянутся тем же fetch: после смерти VM восстановление публикации
   * обязано увидеть свой кандидат в remote, а не полагаться на локальный остаток. */
  const fetchMirror = async (mirror: GitMirror, credentials: GitCredentials): Promise<void> => {
    const args = [
      '--git-dir',
      mirror.dir,
      'fetch',
      '--prune',
      'origin',
      '+refs/heads/*:refs/heads/*',
      `${CANDIDATE_REF_PREFIX}*:${CANDIDATE_REF_PREFIX}*`,
    ];
    // Транзиентный сбой сети повторяется с backoff: зеркало обязано дойти до remote,
    // иначе следующий publish увидит устаревшую голову и сделает лишний merge-проход.
    let last: RunResult | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const result = await runAuthenticated(args, credentials);
      last = result;
      if (result.code === 0) return;
      if (!isTransientFailure(result.stderr, result.timedOut)) {
        throw new WorkspaceError('WORKSPACE_GIT_FAILED', `git fetch failed: ${summarize(result.stderr)}`, { retryable: true });
      }
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt] as number);
      }
    }
    throw new WorkspaceError(
      'WORKSPACE_GIT_FAILED',
      `git fetch failed after ${RETRY_DELAYS_MS.length + 1} attempts: ${last ? summarize(last.stderr) : 'no output'}`,
      { retryable: true },
    );
  };

  return {
    async ensureMirror(binding, credentials) {
      const dir = join(options.rootDir, `${binding.bindingId}.git`);
      const mirror: GitMirror = { dir, bindingId: binding.bindingId };
      const url = remoteUrl(binding);
      const probe = await run(['--git-dir', dir, 'rev-parse', '--git-dir']);
      if (probe.code !== 0) {
        // Именно bare, а не --mirror: у mirror-клона включён неявный `--mirror` для push,
        // который несовместим с явными refspec'ами — а нам нужны и ветка профиля, и
        // неканонические ref'ы кандидатов (`refs/workspace/*`).
        let cloned: RunResult | null = null;
        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
          cloned = await runAuthenticated(['clone', '--bare', url, dir], credentials);
          if (cloned.code === 0) break;
          if (!isTransientFailure(cloned.stderr, cloned.timedOut)) {
            throw new WorkspaceError('WORKSPACE_GIT_FAILED', `clone of ${binding.repository} failed: ${summarize(cloned.stderr)}`, { retryable: true });
          }
          if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt] as number);
        }
        if (!cloned || cloned.code !== 0) {
          throw new WorkspaceError(
            'WORKSPACE_GIT_FAILED',
            `clone of ${binding.repository} failed after ${RETRY_DELAYS_MS.length + 1} attempts: ${cloned ? summarize(cloned.stderr) : 'no output'}`,
            { retryable: true },
          );
        }
        return mirror;
      }
      const current = await run(['--git-dir', dir, 'config', '--get', 'remote.origin.url']);
      if (current.stdout.trim() !== url) await run(['--git-dir', dir, 'remote', 'set-url', 'origin', url]);
      // Зеркало обновляется на каждый вызов: после рестарта VM локальная копия головы
      // не источник истины, источник истины — remote.
      await fetchMirror(mirror, credentials);
      return mirror;
    },

    fetch: fetchMirror,

    head,

    async listTree(mirror, revision) {
      const out = await requireOk(['--git-dir', mirror.dir, 'ls-tree', '-r', '-z', '--full-tree', revision]);
      const entries: GitTreeEntry[] = [];
      for (const record of out.split('\0')) {
        if (record.length === 0) continue;
        const tab = record.indexOf('\t');
        if (tab < 0) continue;
        const meta = record.slice(0, tab);
        const path = record.slice(tab + 1);
        const [mode, type, oid] = meta.split(/\s+/);
        if (!mode || !type || !oid) continue;
        if (type !== 'blob' && type !== 'commit') continue;
        entries.push({ mode, oid, path });
      }
      return entries.sort((a, b) => a.path.localeCompare(b.path));
    },

    readBlob: catBlob,

    hashObject: (mirror, bytes) => hashObject(mirror, Buffer.from(bytes)),

    writeTree,

    commitTree,

    mergeBlobs,

    async pushBranch(mirror, input) {
      // Ожидаемая голова проверяется ДО push, а не force-флагом: без `--force` git и так
      // откажет не-fast-forward, если голову занял кто-то ещё.
      const currentHead = await head(mirror, input.branch);
      if (currentHead !== input.expectedHead) {
        return {
          outcome: 'head_changed',
          detail: `branch ${input.branch} is at ${currentHead ?? 'null'}, the publication expected ${input.expectedHead ?? 'null'}`,
        };
      }
      return pushAuthenticated(mirror, ['push', 'origin', `${input.commit}:refs/heads/${input.branch}`], input.credentials);
    },

    async pushRef(mirror, input) {
      // Разрешены только ветки рана/синхронизации и легаси-кандидаты: молчаливая запись
      // в произвольную ветку профиля запрещена (main обновляется только CAS-merge'ом).
      const allowed =
        input.ref.startsWith(RUN_BRANCH_REF_PREFIX) || input.ref.startsWith(SYNC_BRANCH_REF_PREFIX) || input.ref.startsWith(CANDIDATE_REF_PREFIX);
      if (!allowed) {
        throw new WorkspaceError(
          'WORKSPACE_INVALID',
          `refusing to push "${input.ref}": only ${RUN_BRANCH_REF_PREFIX}*, ${SYNC_BRANCH_REF_PREFIX}* and ${CANDIDATE_REF_PREFIX}* are allowed`,
        );
      }
      return pushAuthenticated(mirror, ['push', 'origin', `${input.commit}:${input.ref}`], input.credentials);
    },

    async deleteRef(mirror, input) {
      const allowed = input.ref.startsWith(RUN_BRANCH_REF_PREFIX) || input.ref.startsWith(SYNC_BRANCH_REF_PREFIX);
      if (!allowed) {
        throw new WorkspaceError('WORKSPACE_INVALID', `refusing to delete "${input.ref}": only run/sync branches are removable`);
      }
      return pushAuthenticated(mirror, ['push', 'origin', `:${input.ref}`], input.credentials);
    },

    async hasCommit(mirror, commit) {
      return (await inMirror(mirror, ['cat-file', '-e', `${commit}^{commit}`])).code === 0;
    },

    async isAncestor(mirror, ancestor, commit) {
      const result = await inMirror(mirror, ['merge-base', '--is-ancestor', ancestor, commit]);
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      throw new WorkspaceError('WORKSPACE_GIT_FAILED', `merge-base --is-ancestor failed: ${summarize(result.stderr)}`, { retryable: true });
    },

    async candidateRefCommit(mirror, ref) {
      const result = await inMirror(mirror, ['rev-parse', '--verify', '--quiet', ref]);
      if (result.code !== 0) return null;
      const sha = result.stdout.trim();
      return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
    },
  };
}

async function resolveToken(resolver: CredentialResolver | undefined, credentials: GitCredentials | undefined): Promise<string | undefined> {
  if (!credentials?.tokenRef) return undefined;
  if (!resolver) {
    throw new WorkspaceError('WORKSPACE_INVALID', 'a git credential ref was provided but no credential resolver is configured');
  }
  const token = await resolver(credentials.tokenRef);
  return token && token.length > 0 ? token : undefined;
}

function classifyPush(result: RunResult): { outcome: PushOutcome; detail: string | null } {
  if (result.timedOut) {
    // Исход неизвестен: команда могла дойти до remote. Повторять движок нельзя, а
    // сверять надо — этим занимается reconcile публикации.
    return { outcome: 'unknown', detail: 'push timed out: the remote may or may not have accepted the commit' };
  }
  if (result.code === 0) return { outcome: 'pushed', detail: null };
  const stderr = result.stderr;
  const rejected = /non-fast-forward|fetch first|stale info|behind its remote counterpart|\[rejected\]/.test(stderr);
  const unknown = /Could not read from remote repository|early EOF|connection reset|timed out|unable to access|50[234]|network is unreachable/.test(stderr);
  if (rejected) return { outcome: 'head_changed', detail: summarize(stderr) };
  if (unknown) return { outcome: 'unknown', detail: summarize(stderr) };
  return { outcome: 'rejected', detail: summarize(stderr) };
}

function isBinary(bytes: Buffer): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function summarize(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return 'no git output';
  const joined = lines.slice(-3).join('; ');
  return redactSecrets(joined.length > 400 ? `${joined.slice(0, 400)}...` : joined);
}

export function candidateRefFor(publicationId: string): string {
  return `${CANDIDATE_REF_PREFIX}${publicationId}`;
}
