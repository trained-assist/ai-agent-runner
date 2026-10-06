import { execFileSync } from 'node:child_process';
import { createHash as hash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BlobStore } from '../src/storage/blob-store.js';
import { createRunBranchWorker } from '../src/workspace/run-branch-worker.js';
import { Runner } from '../src/runner/runner.js';
import { FakeEngine } from '../src/adapters/engine/fake-engine.js';
import { makeRunSpec } from './helpers.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('profile workspace run branch worker', () => {
  it('runs a VM-style Runner lifecycle and returns the pushed commit in its durable result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-runner-e2e-'));
    const priorBase = process.env['RUNNER_REPOSITORY_BASE_URL'];
    try {
      const repoRoot = join(root, 'repos');
      const bare = join(repoRoot, 'owner', 'profile.git');
      const seed = join(root, 'seed');
      mkdirSync(join(repoRoot, 'owner'), { recursive: true });
      mkdirSync(seed);
      git(root, 'init', '--bare', bare);
      git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      git(seed, 'init', '-b', 'main');
      git(seed, 'config', 'user.name', 'test');
      git(seed, 'config', 'user.email', 'test@example.invalid');
      writeFileSync(join(seed, 'profile.md'), 'saved state\n');
      git(seed, 'add', 'profile.md');
      git(seed, 'commit', '-m', 'profile bootstrap');
      git(seed, 'remote', 'add', 'origin', bare);
      git(seed, 'push', '-u', 'origin', 'main');
      const revision = git(seed, 'rev-parse', 'HEAD');
      process.env['RUNNER_REPOSITORY_BASE_URL'] = `file://${repoRoot}`;
      const objects = new Map<string, Buffer>();
      const blob: BlobStore = {
        backend: 'local-fs',
        async put(key, bytes) { const data = Buffer.from(bytes); objects.set(key, data); return { sha256: createHash(data), size: data.length, generation: null }; },
        async get(key) { const data = objects.get(key); if (!data) throw new Error('missing object'); return data; },
        async head(key) { const data = objects.get(key); if (!data) throw new Error('missing object'); return { size: data.length, generation: null }; },
      };
      const runner = new Runner({
        rootDir: join(root, 'runner'), adapters: { fake: new FakeEngine('success') },
        profileWorkspace: createRunBranchWorker(blob, { repositoryUrl: () => bare }),
      });
      const spec = makeRunSpec({
        repository: { fullName: 'owner/profile', revision, token: 'one-run-github-token' },
        profileWorkspace: { bindingId: 'binding-profile', artifacts: [], excludedPatterns: [] },
      });
      runner.start(spec);
      const result = await runner.waitFor(spec.runId, 15_000);
      expect(result.outcome).toBe('succeeded');
      expect(result.repositoryCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(runner.profileWorkspaceCommit(spec.runId)).toBe(result.repositoryCommit);
      expect(git(root, '--git-dir', bare, 'show', `${result.repositoryCommit}:ran.txt`)).toBe('ok');
      const durableState = readFileSync(join(root, 'runner', 'runs', spec.runId, 'state.json'), 'utf8');
      expect(durableState).toContain(result.repositoryCommit);
      expect(durableState).not.toContain('one-run-github-token');
      runner.dispose();
    } finally {
      if (priorBase === undefined) delete process.env['RUNNER_REPOSITORY_BASE_URL'];
      else process.env['RUNNER_REPOSITORY_BASE_URL'] = priorBase;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks out the pinned base, publishes safe text and verified heavy artifacts to a run branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-run-branch-'));
    try {
      const bare = join(root, 'profile.git');
      const seed = join(root, 'seed');
      const cwd = join(root, 'workspace');
      mkdirSync(seed);
      git(root, 'init', '--bare', bare);
      git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      git(seed, 'init', '-b', 'main');
      git(seed, 'config', 'user.name', 'test');
      git(seed, 'config', 'user.email', 'test@example.invalid');
      writeFileSync(join(seed, 'existing.md'), 'profile state\n');
      writeFileSync(join(seed, '.env'), 'SHOULD_NOT_REACH_AGENT=secret\n');
      git(seed, 'add', 'existing.md', '.env');
      git(seed, 'commit', '-m', 'profile base');
      git(seed, 'remote', 'add', 'origin', bare);
      git(seed, 'push', '-u', 'origin', 'main');
      const revision = git(seed, 'rev-parse', 'HEAD');
      execFileSync('git', ['clone', bare, cwd], { encoding: 'utf8' });

      const objects = new Map<string, Buffer>();
      const previousArtifact = Buffer.alloc(1024 * 1024 + 3, 4);
      const previousArtifactSha = createHash(previousArtifact);
      const previousArtifactKey = `profiles/profile-a/workspace/older-run/${previousArtifactSha}`;
      objects.set(previousArtifactKey, previousArtifact);
      const store: BlobStore = {
        backend: 'local-fs',
        async put(key, bytes) {
          const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
          objects.set(key, value);
          return { sha256: createHash(value), size: value.length, generation: null };
        },
        async get(key) { const value = objects.get(key); if (!value) throw new Error('missing object'); return value; },
        async head(key) { const value = objects.get(key); if (!value) throw new Error('missing object'); return { size: value.length, generation: null }; },
      };
      const worker = createRunBranchWorker(store, { repositoryUrl: () => bare });
      const spec = {
        contractVersion: 1 as const, runId: 'run-workspace-test', profileId: 'profile-a',
        repository: { fullName: 'owner/profile-a', revision },
        profileWorkspace: { bindingId: 'binding-a', artifacts: [{ path: 'previous.zip', key: previousArtifactKey, sha256: previousArtifactSha, size: previousArtifact.length }], excludedPatterns: [] },
      } as never;
      await worker.prepare(spec, cwd, 'test-token');
      expect(git(cwd, 'branch', '--show-current')).toBe('agent-run/run-workspace-test');
      expect(existsSync(join(cwd, '.env'))).toBe(false);
      expect(existsSync(join(cwd, 'previous.zip'))).toBe(true);
      writeFileSync(join(cwd, 'answer.md'), 'saved user data\n');
      writeFileSync(join(cwd, 'archive.zip'), Buffer.alloc(1024 * 1024 + 1, 7));
      git(cwd, 'remote', 'set-url', 'origin', join(root, 'attacker.git'));

      const commit = await worker.publish(spec, cwd, 'test-token');
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      expect(git(root, '--git-dir', bare, 'rev-parse', 'refs/heads/agent-run/run-workspace-test')).toBe(commit);
      expect(git(root, '--git-dir', bare, 'show', `${commit}:answer.md`)).toBe('saved user data');
      const index = JSON.parse(git(root, '--git-dir', bare, 'show', `${commit}:.trained-assist/artifacts.json`)) as { artifacts: Array<{ path: string; key: string }> };
      expect(index.artifacts.map((entry) => entry.path)).toContain('archive.zip');
      expect(objects.has(index.artifacts.find((entry) => entry.path === 'archive.zip')!.key)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function createHash(bytes: Uint8Array): string {
  return hash('sha256').update(bytes).digest('hex');
}
