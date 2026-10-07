import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ProfileWorkspaceSpec, RunSpec } from '../contracts/run-spec.js';
import type { BlobStore } from '../storage/blob-store.js';
import { sha256Hex } from '../storage/blob-store.js';
import { mimeForName } from '../storage/export-manifest.js';
import { resolveInsideRoot, isSafeRelativePath } from '../storage/local-paths.js';
import { DEFAULT_EXPORT_POLICY, compilePolicy, scanWorkspace, matchRule } from './policy.js';
import { ARTIFACT_INDEX_PATH } from './contract.js';
import { runBranchName } from './branches.js';
import { buildRepositoryUrl } from '../runner/repository.js';
import { killProcessTree } from '../adapters/engine/process-tree.js';

const POLICY = compilePolicy(DEFAULT_EXPORT_POLICY);
const ASKPASS = ['#!/bin/sh', 'case "$1" in', "  *sername*) printf '%s\\n' 'x-access-token' ;;", '  *) printf \'%s\\n\' "$RUNNER_GIT_TOKEN" ;;', 'esac', ''].join('\n');

export interface RunBranchWorker {
  supportsSaveback?(): boolean;
  prepare(spec: RunSpec, cwd: string, token?: string): Promise<void>;
  publish(spec: RunSpec, cwd: string, token?: string): Promise<string>;
  changes?(spec: RunSpec): { files: Array<{ path: string; sha256: string; size: number }>; deletes: string[] } | undefined;
}

/** Implements the existing CP profile-workspace branch contract on a VM worker. */
export function createRunBranchWorker(objects: BlobStore, options: { repositoryUrl?: (fullName: string) => string } = {}): RunBranchWorker {
  const repositoryUrl = options.repositoryUrl ?? buildRepositoryUrl;
  return {
    async prepare(spec, cwd, token = '') {
      const workspace = requiredWorkspace(spec);
      const revision = spec.repository?.revision;
      if (!revision) throw new Error('profile workspace requires a pinned base revision');
      const branch = runBranchName(spec.runId);
      await git(cwd, ['remote', 'set-url', 'origin', repositoryUrl(spec.repository!.fullName)], token);
      await git(cwd, ['-c', 'credential.helper=', 'fetch', '--depth=1', 'origin', revision], token);
      await git(cwd, ['checkout', '-B', branch, 'FETCH_HEAD'], token);
      if ((await gitText(cwd, ['rev-parse', 'HEAD'], token)).trim() !== revision) throw new Error('profile checkout did not match the pinned base revision');
      for (const artifact of workspace.artifacts) {
        if (!isSafeRelativePath(artifact.path) || !artifact.key.startsWith(`profiles/${spec.profileId}/workspace/`)
          || !/^[0-9a-f]{64}$/.test(artifact.sha256) || artifact.size < 0) throw new Error(`invalid profile artifact reference: ${artifact.path}`);
        const bytes = await objects.get(artifact.key);
        if (bytes.length !== artifact.size || sha256Hex(bytes) !== artifact.sha256) throw new Error(`profile artifact checksum mismatch: ${artifact.path}`);
        const target = resolveInsideRoot(cwd, artifact.path, 'profile artifact path');
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, { mode: 0o600 });
      }
      // The clone contains the complete Git tree. Remove files excluded from the profile
      // image before the agent starts, so credentials/runtime data cannot be read by it.
      const excluded = scanWorkspace(POLICY, cwd).excluded;
      for (const entry of excluded) {
        if (entry.path === '.git') continue;
        rmSync(resolveInsideRoot(cwd, entry.path, 'excluded profile path'), { recursive: true, force: true });
      }
    },
    async publish(spec, cwd, token = '') {
      requiredWorkspace(spec);
      const branch = runBranchName(spec.runId);
      if ((await gitText(cwd, ['rev-parse', 'HEAD'], token)).trim() !== spec.repository!.revision) throw new Error('agent changed the pinned profile base commit; refusing publication');
      if ((await gitText(cwd, ['branch', '--show-current'], token)).trim() !== branch) throw new Error('agent changed the run branch; refusing publication');
      // Never trust a remote URL that may have been edited by the agent in .git/config.
      await git(cwd, ['remote', 'set-url', 'origin', repositoryUrl(spec.repository!.fullName)], token);
      const scanned = scanWorkspace(POLICY, cwd);
      const artifacts: Array<{ path: string; key: string; sha256: string; size: number; mime: string }> = [];
      for (const file of scanned.files) {
        if (file.action !== 'heavy') continue;
        const bytes = readFileSync(resolveInsideRoot(cwd, file.path, 'profile artifact path'));
        if (sha256Hex(bytes) !== file.sha256) throw new Error(`profile artifact changed during publication: ${file.path}`);
        const key = `profiles/${spec.profileId}/workspace/${spec.runId}/${file.sha256}`;
        const uploaded = await objects.put(key, bytes);
        const verified = await objects.get(key);
        if (uploaded.sha256 !== file.sha256 || verified.length !== file.size || sha256Hex(verified) !== file.sha256) throw new Error(`profile artifact upload verification failed: ${file.path}`);
        artifacts.push({ path: file.path, key, sha256: file.sha256, size: file.size, mime: mimeForName(file.path) });
      }
      // Use a private index so excluded/runtime files can never be staged by broad `git add -A`.
      const indexPath = join(cwd, '.git', `runner-index-${spec.runId}`);
      const env = { GIT_INDEX_FILE: indexPath };
      await git(cwd, ['read-tree', spec.repository!.revision!], token, env);
      const allowed = new Set<string>();
      for (const file of scanned.files) {
        if (file.action === 'publish') {
          allowed.add(file.path);
          await git(cwd, ['add', '-f', '--', file.path], token, env);
        }
      }
      const tracked = (await gitText(cwd, ['ls-tree', '-r', '--name-only', spec.repository!.revision!], token)).split('\n').filter(Boolean);
      for (const path of tracked) {
        if (path === ARTIFACT_INDEX_PATH || path === '.trained-assist/profile.json' || allowed.has(path)) continue;
        if (matchRule(POLICY, path).action !== 'exclude' && !artifacts.some((artifact) => artifact.path === path)) {
          await git(cwd, ['update-index', '--force-remove', '--', path], token, env, true);
        }
      }
      const index = { version: 1, artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)) };
      const indexFile = resolveInsideRoot(cwd, ARTIFACT_INDEX_PATH, 'artifact index path');
      mkdirSync(dirname(indexFile), { recursive: true });
      writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
      await git(cwd, ['add', '-f', '--', ARTIFACT_INDEX_PATH], token, env);
      await git(cwd, ['-c', 'user.name=Trained Assist Runner', '-c', 'user.email=runner@trained-assist.invalid', 'commit', '--allow-empty', '-m', `run ${spec.runId} profile workspace`], token, env);
      await git(cwd, ['-c', 'credential.helper=', 'push', 'origin', `HEAD:refs/heads/${branch}`], token);
      return (await gitText(cwd, ['rev-parse', 'HEAD'], token)).trim();
    },
  };
}

function requiredWorkspace(spec: RunSpec): ProfileWorkspaceSpec {
  if (!spec.profileWorkspace || !spec.repository?.revision) throw new Error('profile workspace and pinned repository revision are required');
  return spec.profileWorkspace;
}

async function git(cwd: string, args: string[], token: string, extraEnv: NodeJS.ProcessEnv = {}, allowFailure = false): Promise<void> {
  await runGit(cwd, args, token, extraEnv, allowFailure, false);
}

async function gitText(cwd: string, args: string[], token: string): Promise<string> {
  return runGit(cwd, args, token, {}, false, true);
}

function runGit(cwd: string, args: string[], token: string, extraEnv: NodeJS.ProcessEnv, allowFailure: boolean, capture: boolean): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, RUNNER_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0' };
  const askpassDir = join(cwd, '.git', 'runner-askpass');
  mkdirSync(askpassDir, { recursive: true, mode: 0o700 });
  const askpassPath = join(askpassDir, 'askpass.sh');
  writeFileSync(askpassPath, ASKPASS, { mode: 0o700 });
  env.GIT_ASKPASS = askpassPath;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, child.pid, 'SIGKILL');
    }, 60_000);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => { if (capture && stdout.length < 1_000_000) stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 1000) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error(`git ${args[0]} timed out after 60s`)); return; }
      if (code === 0 || allowFailure) resolve(stdout);
      else reject(new Error(`git ${args[0]} failed (exit ${code}): ${stderr.replaceAll(token, '[REDACTED]').slice(0, 300)}`));
    });
  });
}
