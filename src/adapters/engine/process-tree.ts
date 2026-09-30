import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { EngineHandle, EngineLogStream } from './engine-adapter.js';

export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isProcessGroupAlive(pgid: number | null | undefined): boolean {
  if (!pgid || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function killProcessGroup(pgid: number | null | undefined, signal: NodeJS.Signals): boolean {
  if (!pgid || pgid <= 1) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

export function killProcessTree(pgid: number | null | undefined, pid: number | null | undefined, signal: NodeJS.Signals): void {
  if (isProcessGroupAlive(pgid)) {
    killProcessGroup(pgid, signal);
    return;
  }
  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, signal);
    } catch {
      // process already gone
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForProcessDeath(pgid: number | null | undefined, pid: number | null | undefined, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = isProcessGroupAlive(pgid) || isProcessAlive(pid);
    if (!alive) return true;
    await sleep(20);
  }
  return !isProcessGroupAlive(pgid) && !isProcessAlive(pid);
}

export function findOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env['PATH'];
  if (!path) return null;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface LineReader {
  flush: () => void;
}

function attachLineReader(stream: NodeJS.ReadableStream | null | undefined, name: EngineLogStream, onLine: (stream: EngineLogStream, line: string) => void): LineReader {
  if (!stream) return { flush: () => undefined };
  stream.setEncoding('utf8');
  let buffer = '';
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      onLine(name, line);
      index = buffer.indexOf('\n');
    }
  });
  return {
    flush: () => {
      const rest = buffer.replace(/\r$/, '');
      buffer = '';
      if (rest.length > 0) onLine(name, rest);
    },
  };
}

export interface HandleFromChildOptions {
  onLog: (stream: EngineLogStream, line: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
}

export function handleForChild(child: ChildProcess, opts: HandleFromChildOptions): EngineHandle {
  const pid = child.pid ?? null;
  const pgid = pid;
  let exited = false;

  const out = attachLineReader(child.stdout, 'stdout', opts.onLog);
  const err = attachLineReader(child.stderr, 'stderr', opts.onLog);

  const finish = (code: number | null, signal: string | null): void => {
    if (exited) return;
    exited = true;
    out.flush();
    err.flush();
    opts.onExit(code, signal);
  };

  child.once('exit', (code, signal) => finish(code, signal));
  child.once('error', () => finish(null, null));

  return {
    pid,
    pgid,
    killTree(signal: NodeJS.Signals = 'SIGTERM'): void {
      if (pgid) killProcessGroup(pgid, signal);
      else if (pid) {
        try {
          process.kill(pid, signal);
        } catch {
          // already gone
        }
      }
    },
    dispose(): void {
      child.removeAllListeners();
      if (child.stdout) child.stdout.removeAllListeners();
      if (child.stderr) child.stderr.removeAllListeners();
    },
  };
}
