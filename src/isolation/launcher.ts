import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter } from 'node:path';
import { CleanRoomError, type RunIdentity } from './contract.js';

/**
 * Переключение идентичности дочернего процесса.
 *
 * Почему не `spawn({uid, gid})`: libuv ставит только первичные uid/gid, а дополнительные
 * группы наследуются от родителя. Если Runner идёт от root (или из группы с правами на
 * чужие файлы), дочерний процесс получил бы эти группы и читал бы файлы, закрытые для
 * слота. Поэтому запуск идёт через setpriv/runuser с `--clear-groups`/`initgroups`:
 * у процесса рана нет ни одной дополнительной группы.
 */
export interface ProcessLauncher {
  readonly kind: 'setpriv' | 'runuser';
  /** Оборачивает команду так, чтобы она исполнилась под идентичностью рана. */
  wrap(identity: RunIdentity, command: string, args: string[]): { command: string; args: string[] };
  /** Проверка на хосте: команда под чужим UID реально меняет идентичность. */
  selfTest(identity: RunIdentity): Promise<{ ok: boolean; detail: string }>;
}

interface LauncherCandidate {
  kind: 'setpriv' | 'runuser';
  path: string;
}

function candidates(preferred?: string): LauncherCandidate[] {
  const list: LauncherCandidate[] = [];
  if (preferred) list.push({ kind: 'setpriv', path: preferred });
  for (const name of ['setpriv', 'runuser']) {
    const found = findOnPath(name);
    if (found) list.push({ kind: name as 'setpriv' | 'runuser', path: found });
  }
  return list;
}

function findOnPath(name: string): string | null {
  const pathEnv = process.env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = `${dir}/${name}`;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function resolveIdentity(identity: RunIdentity): void {
  if (!Number.isInteger(identity.uid) || identity.uid <= 0) {
    throw new CleanRoomError('ISOLATION_IDENTITY_INVALID', `slot "${identity.slotId}" has no usable uid`);
  }
  if (!Number.isInteger(identity.gid) || identity.gid <= 0) {
    throw new CleanRoomError('ISOLATION_IDENTITY_INVALID', `slot "${identity.slotId}" has no usable gid`);
  }
}

class SetPrivLauncher implements ProcessLauncher {
  readonly kind = 'setpriv' as const;
  constructor(private readonly path: string) {}

  wrap(identity: RunIdentity, command: string, args: string[]): { command: string; args: string[] } {
    resolveIdentity(identity);
    return {
      command: this.path,
      args: [`--reuid=${identity.uid}`, `--regid=${identity.gid}`, '--clear-groups', '--', command, ...args],
    };
  }

  async selfTest(identity: RunIdentity): Promise<{ ok: boolean; detail: string }> {
    const probe = this.wrap(identity, '/usr/bin/id', ['-u']);
    const child = spawn(probe.command, probe.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
    const uid = Number(out.trim());
    if (code === 0 && uid === identity.uid) return { ok: true, detail: `setpriv exec keeps pid, uid=${uid}` };
    return { ok: false, detail: `setpriv self-test exit=${code} uid=${out.trim() || '?'} expected=${identity.uid} ${err.trim()}` };
  }
}

class RunUserLauncher implements ProcessLauncher {
  readonly kind = 'runuser' as const;
  constructor(private readonly path: string) {}

  wrap(identity: RunIdentity, command: string, args: string[]): { command: string; args: string[] } {
    resolveIdentity(identity);
    return { command: this.path, args: ['-u', identity.username, '--', command, ...args] };
  }

  async selfTest(identity: RunIdentity): Promise<{ ok: boolean; detail: string }> {
    const probe = this.wrap(identity, '/usr/bin/id', ['-u']);
    const child = spawn(probe.command, probe.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
    const uid = Number(out.trim());
    if (code === 0 && uid === identity.uid) return { ok: true, detail: `runuser initgroups, uid=${uid}` };
    return { ok: false, detail: `runuser self-test exit=${code} uid=${out.trim() || '?'} expected=${identity.uid} ${err.trim()}` };
  }
}

/**
 * Выбирает лаунчер для хоста. Возвращает null, если переключение идентичности невозможно —
 * вызывающий обязан отказать рану, а не запустить его под service UID.
 */
export function resolveLauncher(preferred?: string): ProcessLauncher | null {
  for (const candidate of candidates(preferred)) {
    if (!existsSync(candidate.path)) continue;
    const launcher = candidate.kind === 'setpriv' ? new SetPrivLauncher(candidate.path) : new RunUserLauncher(candidate.path);
    return launcher;
  }
  return null;
}
