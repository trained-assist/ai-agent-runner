import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFullRepositoryName, type RepositorySpec } from '../contracts/run-spec.js';
import { PreflightError } from '../contracts/validate.js';
import { killProcessTree } from '../adapters/engine/process-tree.js';

/**
 * Дефолтная репа: этот самый продукт — задачи без явного repository идут в его контексте.
 * RUNNER_DEFAULT_REPO (env-оверрайд) — для тестов: `owner/name` под base-url'ом либо
 * готовый источник клонирования (путь/URL, например file:///tmp/fixture.git).
 */
export const DEFAULT_REPOSITORY_FULL_NAME = 'trained-assist/ai-agent-runner';
export const CLONE_TIMEOUT_MS = 60_000;

const ASKPASS_SCRIPT = [
  '#!/bin/sh',
  '# Статический askpass-помошник git: секрет подставляется из окружения процесса,',
  '# в сам файл он не записан и на диск не попадает.',
  'case "$1" in',
  "  *sername*) printf '%s\\n' 'x-access-token' ;;",
  "  *) printf '%s\\n' \"$RUNNER_GIT_TOKEN\" ;;",
  'esac',
  '',
].join('\n');

const MAX_GIT_STDERR = 300;

const NOT_RETRYABLE =
  /not found|does not exist|does not appear|authentication failed|403|401|404|permission denied|could not read username|terminal prompts disabled/i;

export interface CloneSource {
  fullName: string;
  url: string;
  token?: string;
}

export interface ClonePlan {
  args: string[];
  env: Record<string, string>;
}

export function repositoryBaseUrl(): string {
  const override = process.env.RUNNER_REPOSITORY_BASE_URL;
  if (override && override.trim().length > 0) return override.replace(/\/+$/, '');
  return 'https://github.com';
}

export function buildRepositoryUrl(fullName: string): string {
  return `${repositoryBaseUrl()}/${fullName}.git`;
}

export function resolveCloneSource(repository?: RepositorySpec): CloneSource {
  if (repository && isFullRepositoryName(repository.fullName)) {
    return { fullName: repository.fullName, url: buildRepositoryUrl(repository.fullName), ...(repository.token ? { token: repository.token } : {}) };
  }
  const override = process.env.RUNNER_DEFAULT_REPO;
  const fallback = override && override.trim().length > 0 ? override.trim() : DEFAULT_REPOSITORY_FULL_NAME;
  if (isFullRepositoryName(fallback)) {
    return { fullName: fallback, url: buildRepositoryUrl(fallback) };
  }
  return { fullName: fallback, url: fallback };
}

/**
 * argv и окружение child-процесса git.
 *
 * Токен кладётся ТОЛЬКО в окружение (RUNNER_GIT_TOKEN) и доходит до git через
 * GIT_ASKPASS-помошника: вариант с `https://x-access-token:<token>@github.com/...`
 * в argv отбрасываем — argv виден всем локальным пользователям через `ps`,
 * а URL с секретом git ещё и цитирует в своих сообщениях об ошибках.
 * На диск секрет не пишется: askpass-скрипт статический, секрет живёт в env child'а
 * (читается только владельцем процесса), файл удаляется сразу после clone.
 */
export function planClone(source: CloneSource, targetDir: string): ClonePlan {
  const args: string[] = [];
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (source.token) {
    // git-опция -c идёт ДО подкоманды clone: явный токен важнее сохранённых credential helper'ов
    args.push('-c', 'credential.helper=');
    env['RUNNER_GIT_TOKEN'] = source.token;
  }
  args.push('clone', '--depth', '1', source.url, targetDir);
  return { args, env };
}

export async function cloneRepository(source: CloneSource, targetDir: string, timeoutMs: number = CLONE_TIMEOUT_MS): Promise<void> {
  const plan = planClone(source, targetDir);
  let askpassDir: string | null = null;
  const env: NodeJS.ProcessEnv = { ...process.env, ...plan.env };
  if (source.token) {
    askpassDir = mkdtempSync(join(tmpdir(), 'runner-askpass-'));
    const scriptPath = join(askpassDir, 'askpass.sh');
    writeFileSync(scriptPath, ASKPASS_SCRIPT, { mode: 0o700 });
    env['GIT_ASKPASS'] = scriptPath;
  }
  try {
    await runGit(plan.args, env, timeoutMs, source);
  } finally {
    if (askpassDir) rmSync(askpassDir, { recursive: true, force: true });
  }
}

function runGit(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, source: CloneSource): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (err: PreflightError | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, child.pid, 'SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(
        err.code === 'ENOENT'
          ? new PreflightError('REPOSITORY_UNAVAILABLE', 'git is not available on this worker; cannot clone the run repository', {
              retryable: false,
            })
          : new PreflightError('REPOSITORY_UNAVAILABLE', `clone of "${source.fullName}" failed: ${err.message}`, { retryable: true }),
      );
    });
    child.on('close', (code) => {
      if (timedOut) {
        settle(
          new PreflightError('REPOSITORY_UNAVAILABLE', `clone of "${source.fullName}" timed out after ${Math.round(timeoutMs / 1000)}s`, {
            retryable: true,
          }),
        );
        return;
      }
      if (code === 0) {
        settle(null);
        return;
      }
      const detail = summarizeStderr(stderr);
      settle(
        new PreflightError('REPOSITORY_UNAVAILABLE', `clone of "${source.fullName}" failed (exit ${code})${detail ? `: ${detail}` : ''}`, {
          retryable: !NOT_RETRYABLE.test(stderr),
        }),
      );
    });
  });
}

function summarizeStderr(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return '';
  const joined = lines.slice(-2).join('; ');
  return joined.length > MAX_GIT_STDERR ? `${joined.slice(0, MAX_GIT_STDERR)}...` : joined;
}
