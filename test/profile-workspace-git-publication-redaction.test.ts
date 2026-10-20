import { execFileSync, spawn } from 'node:child_process';
import { createHash as hash } from 'node:crypto';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EngineAdapter, EngineHandle, EngineStartContext } from '../src/adapters/engine/engine-adapter.js';
import type { BlobStore } from '../src/storage/blob-store.js';
import { createRunBranchWorker } from '../src/workspace/run-branch-worker.js';
import { createHarness, waitFor } from './helpers.js';

/** The value the host handed to the run. It must not leave the host in any published byte. */
const SECRET = 'ghp_drill_value_9f2c41ab7d5e4c8fa310';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function digest(bytes: Uint8Array): string {
  return hash('sha256').update(bytes).digest('hex');
}

function createStore(): { store: BlobStore; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const store: BlobStore = {
    backend: 'local-fs',
    async put(key, bytes) {
      const value = Buffer.from(bytes);
      objects.set(key, value);
      return { sha256: digest(value), size: value.length, generation: null };
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) throw new Error('missing object');
      return value;
    },
    async head(key) {
      const value = objects.get(key);
      if (!value) throw new Error('missing object');
      return { size: value.length, generation: null };
    },
  };
  return { store, objects };
}

describe('the git publication path', () => {
  it('publishes the run files with the credential value edited out and leaves the workspace on disk intact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-git-redaction-'));
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
      git(seed, 'add', 'existing.md');
      git(seed, 'commit', '-m', 'profile base');
      git(seed, 'remote', 'add', 'origin', bare);
      git(seed, 'push', '-u', 'origin', 'main');
      const revision = git(seed, 'rev-parse', 'HEAD');
      execFileSync('git', ['clone', bare, cwd], { encoding: 'utf8' });

      const { store, objects } = createStore();
      const worker = createRunBranchWorker(store, { repositoryUrl: () => bare });
      const spec = {
        contractVersion: 1 as const, runId: 'run-git-redaction', profileId: 'profile-a',
        repository: { fullName: 'owner/profile-a', revision },
        profileWorkspace: { bindingId: 'binding-a', artifacts: [], excludedPatterns: [] },
      } as never;
      await worker.prepare(spec, cwd, 'test-token');

      // The agent wrote the credential into a file of the profile and into a heavy trace.
      writeFileSync(join(cwd, 'answer.md'), `the credential is ${SECRET}\n`);
      mkdirSync(join(cwd, '.session-traces'), { recursive: true });
      writeFileSync(join(cwd, '.session-traces', 'trace.json'), `{"token":"${SECRET}"}`);

      const commit = await worker.publish(spec, cwd, 'test-token', [SECRET]);
      expect(commit).toMatch(/^[0-9a-f]{40}$/);

      // The committed file carries the marker, not the value.
      const committed = git(root, '--git-dir', bare, 'show', `${commit}:answer.md`);
      expect(committed).toContain('[redacted]');
      expect(committed).not.toContain(SECRET);

      // The workspace on disk is what the agent wrote: the index was edited, not the disk.
      expect(readFileSync(join(cwd, 'answer.md'), 'utf8')).toContain(SECRET);

      // The heavy artifact is stored edited, and the manifest describes the published bytes.
      const index = JSON.parse(git(root, '--git-dir', bare, 'show', `${commit}:.trained-assist/artifacts.json`)) as {
        artifacts: Array<{ path: string; key: string; sha256: string; size: number }>;
      };
      const heavy = index.artifacts.find((entry) => entry.path === '.session-traces/trace.json');
      expect(heavy).toBeDefined();
      const published = objects.get(heavy!.key)!;
      expect(published.toString('utf8')).not.toContain(SECRET);
      expect(published.toString('utf8')).toContain('[redacted]');
      expect(heavy!.sha256).toBe(digest(published));
      expect(heavy!.size).toBe(published.length);
      // The key is content-addressed by the published bytes.
      expect(heavy!.key.endsWith(heavy!.sha256)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** An engine that writes the run secret into the declared output and prints it, like a careless agent does. */
class LeakyEngine implements EngineAdapter {
  readonly name = 'leaky';

  async start(ctx: EngineStartContext): Promise<EngineHandle> {
    const script = [
      "require('node:fs').writeFileSync('ran.txt', process.env.DRILL_SECRET ?? 'leak');",
      "console.log('the credential is ' + (process.env.DRILL_SECRET ?? 'leak'));",
    ].join('');
    const child = spawn(process.execPath, ['-e', script], {
      cwd: ctx.cwd, env: ctx.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) ctx.onLog('stdout', line);
    });
    child.stderr?.on('data', () => undefined);
    child.on('close', (code) => ctx.onExit(code, null));
    return {
      pid: child.pid ?? null,
      pgid: child.pid ?? null,
      killTree: (signal: NodeJS.Signals = 'SIGTERM') => {
        try { process.kill(-(child.pid ?? 0), signal); } catch { /* the run is already over */ }
      },
      dispose: () => undefined,
    };
  }
}

describe('the artifact export', () => {
  it('exports the declared output with the credential value edited out and describes what was published', async () => {
    const prior = process.env['DRILL_SECRET'];
    process.env['DRILL_SECRET'] = SECRET;
    const harness = createHarness({ artifactExport: true, adapters: { fake: new LeakyEngine() } });
    try {
      const { receipt } = harness.start({
        outputs: [{ path: 'ran.txt', name: 'ran.txt', mime: 'text/plain' }],
        envAllowlist: ['DRILL_SECRET'],
      });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const snapshot = harness.runner.getRun(receipt.runId);
        if (snapshot && ['succeeded', 'failed', 'cancelled'].includes(snapshot.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const manifest = harness.exports?.read(receipt.runId);
      expect(manifest?.status).toBe('complete');
      expect(manifest?.entries).toHaveLength(1);
      const entry = manifest!.entries[0]!;
      expect(entry.status).toBe('exported');
      const artifact = await harness.artifacts!.read(receipt.runId, entry.artifactId!);
      // The exported bytes carry the marker, not the value.
      expect(artifact.bytes.toString('utf8')).not.toContain(SECRET);
      expect(artifact.bytes.toString('utf8')).toContain('[redacted]');
      // The manifest describes the published content, not the file that was on disk.
      expect(entry.sha256).toBe(digest(artifact.bytes));
      expect(entry.size).toBe(artifact.bytes.length);

      // The answer artifact leaves the host too: it is edited by value as well.
      const answer = harness.artifacts!.list(receipt.runId).find((item) => item.name === 'answer.txt');
      expect(answer).toBeDefined();
      const answerBytes = (await harness.artifacts!.read(receipt.runId, answer!.artifactId)).bytes;
      expect(answerBytes.toString('utf8')).not.toContain(SECRET);
      expect(answerBytes.toString('utf8')).toContain('[redacted]');
    } finally {
      harness.runner.dispose();
      if (prior === undefined) delete process.env['DRILL_SECRET'];
      else process.env['DRILL_SECRET'] = prior;
    }
  });

  it('refuses to publish the declared output after a worker restart, because the run cannot clear the value', async () => {
    const prior = process.env['DRILL_SECRET'];
    process.env['DRILL_SECRET'] = SECRET;
    const harness = createHarness({ artifactExport: true, adapters: { fake: new LeakyEngine() } });
    try {
      // The export fails once: the run stays in `finalizing`, so the worker can die there.
      harness.faults.inject('export', { kind: 'throw', once: true });
      const { receipt } = harness.start({
        outputs: [{ path: 'ran.txt', name: 'ran.txt', mime: 'text/plain' }],
        envAllowlist: ['DRILL_SECRET'],
      });
      await waitFor(() => (harness.exports?.read(receipt.runId)?.attempts ?? 0) >= 1);

      // The worker dies in the middle of the finalization: the values of the run's secrets
      // are gone with its memory, and they are not on disk by design.
      harness.reopen();
      await harness.runner.recover();

      const manifest = harness.exports?.read(receipt.runId);
      expect(manifest?.entries[0]?.status).toBe('failed');
      expect(manifest?.entries[0]?.reason).toContain('unknown');
      // Nothing of the declared output left the host.
      expect(harness.artifacts!.list(receipt.runId).filter((item) => item.name === 'ran.txt')).toHaveLength(0);
    } finally {
      harness.runner.dispose();
      if (prior === undefined) delete process.env['DRILL_SECRET'];
      else process.env['DRILL_SECRET'] = prior;
    }
  });

  it('refuses to publish the profile after a worker restart, because the run cannot clear the value', async () => {
    const prior = process.env['DRILL_SECRET'];
    const priorBase = process.env['RUNNER_REPOSITORY_BASE_URL'];
    process.env['DRILL_SECRET'] = SECRET;
    const root = mkdtempSync(join(tmpdir(), 'profile-git-restart-'));
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
      writeFileSync(join(seed, 'existing.md'), 'profile state\n');
      git(seed, 'add', 'existing.md');
      git(seed, 'commit', '-m', 'profile base');
      git(seed, 'remote', 'add', 'origin', bare);
      git(seed, 'push', '-u', 'origin', 'main');
      const revision = git(seed, 'rev-parse', 'HEAD');
      process.env['RUNNER_REPOSITORY_BASE_URL'] = `file://${repoRoot}`;

      // The publication must never be attempted with bytes the run cannot clear.
      const publish = vi.fn(async () => 'published-commit-sha');
      const logs: string[] = [];
      const harness = createHarness({
        adapters: { fake: new LeakyEngine() },
        profileWorkspace: { prepare: vi.fn(async () => undefined), publish },
        logSink: (_file, line) => { logs.push(line); },
      });
      try {
        // The finalization fails once: the run stays in `finalizing` and the host dies
        // before the publication.
        harness.faults.inject('finalization', { kind: 'throw', once: true });
        const { receipt } = harness.start({
          repository: { fullName: 'owner/profile', revision, token: 'one-run-github-token' },
          profileWorkspace: {
            bindingId: 'binding-profile', snapshotUrl: 'https://example.test/snapshot',
            snapshotSha256: 'a'.repeat(64), snapshotSize: 1,
            savebackUrl: 'https://api.example/profile-changes', savebackToken: 't'.repeat(43),
            artifacts: [], excludedPatterns: [],
          },
          envAllowlist: ['DRILL_SECRET'],
        });
        await waitFor(() => harness.runner.getRun(receipt.runId)?.state === 'finalizing');
        expect(publish).toHaveBeenCalledTimes(0);

        // The worker dies before the publication: the values of the run's secrets are gone
        // with its memory, and they are not on disk by design.
        harness.reopen();
        await harness.runner.recover();

        // The publication is refused: the run cannot clear the bytes it would publish.
        expect(publish).toHaveBeenCalledTimes(0);
        expect(logs.join('\n')).toContain('profile_workspace.publish_refused');
        expect(logs.join('\n')).toContain('the run secret values are unknown after a worker restart');
        // The refused workspace does not stay on the host: it may hold a copy of the value.
        expect(existsSync(join(harness.rootDir, 'ws', receipt.runId))).toBe(false);
      } finally {
        harness.runner.dispose();
      }
    } finally {
      if (prior === undefined) delete process.env['DRILL_SECRET'];
      else process.env['DRILL_SECRET'] = prior;
      if (priorBase === undefined) delete process.env['RUNNER_REPOSITORY_BASE_URL'];
      else process.env['RUNNER_REPOSITORY_BASE_URL'] = priorBase;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
