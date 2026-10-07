import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ProfileWorkspaceSpec, RunSpec } from '../contracts/run-spec.js';
import type { RunBranchWorker } from './run-branch-worker.js';
import { resolveInsideRoot, isSafeRelativePath } from '../storage/local-paths.js';
import { DEFAULT_EXPORT_POLICY, compilePolicy, matchRule, scanWorkspace } from './policy.js';
import { writeFileAtomic } from '../runner/util.js';

const POLICY = compilePolicy(DEFAULT_EXPORT_POLICY);
const MAX_SNAPSHOT_BYTES = 512_000_000;
const MAX_FILE_BYTES = 100_000_000;
const MAX_RUN_BYTES = 256_000_000;
const NULL_COMMIT = '0'.repeat(40);

export interface ProfileSavebackManifest {
  files: Array<{ path: string; sha256: string; size: number }>;
  deletes: string[];
}

interface DurableReceipt {
  baseline: string;
  manifest?: ProfileSavebackManifest;
}

/** Implements snapshot + API-owned publication for a regional VM, without GitHub credentials. */
export function createApiSavebackWorker(dataDir: string): RunBranchWorker & {
  supportsSaveback(): boolean;
  changes(spec: RunSpec): ProfileSavebackManifest | undefined;
} {
  const receipts = join(dataDir, 'profile-saveback');
  return {
    supportsSaveback: () => true,
    async prepare(spec, cwd) {
      const profile = requiredSavebackWorkspace(spec);
      if (existsSync(cwd) && readdirSync(cwd).length > 0) throw new Error('profile snapshot target is not empty');
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const temp = mkdtempSync(join(tmpdir(), `profile-snapshot-${spec.runId}-`));
      const archive = join(temp, 'snapshot.tar.gz');
      try {
        const response = await fetch(profile.snapshotUrl, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`profile snapshot download failed with HTTP ${response.status}`);
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength !== profile.snapshotSize) throw new Error('profile snapshot content length did not match its pin');
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_SNAPSHOT_BYTES || bytes.length !== profile.snapshotSize
          || createHash('sha256').update(bytes).digest('hex') !== profile.snapshotSha256) throw new Error('profile snapshot size or checksum did not match its pin');
        writeFileSync(archive, bytes, { mode: 0o600 });
        const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean);
        const details = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean);
        if (names.length !== details.length || details.some((entry) => !['-', 'd'].includes(entry[0] ?? ''))) throw new Error('profile snapshot contains a link or special archive entry');
        for (const name of names) {
          const relative = name.replace(/^\.\//, '').replace(/\/$/, '');
          if (relative && !isSafeRelativePath(relative)) throw new Error('profile snapshot contains an unsafe path');
        }
        execFileSync('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', archive, '-C', cwd], { stdio: 'pipe' });
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
      // A local baseline lets git identify modifications and deletions. It has no remote,
      // credential helper, or user credential; API publication remains the only write path.
      git(cwd, ['init', '--quiet']);
      git(cwd, ['add', '-A', '--', '.']);
      git(cwd, ['-c', 'user.name=Trained Assist Runner', '-c', 'user.email=runner@trained-assist.invalid', 'commit', '--quiet', '--allow-empty', '-m', `snapshot ${spec.runId}`]);
      const baseline = gitText(cwd, ['rev-parse', 'HEAD']).trim();
      mkdirSync(receipts, { recursive: true, mode: 0o700 });
      writeReceipt(receiptPath(receipts, spec.runId), { baseline });
    },
    async publish(spec, cwd, token) {
      const profile = requiredSavebackWorkspace(spec);
      if (!token) throw new Error('run-scoped profile saveback capability is unavailable');
      const path = receiptPath(receipts, spec.runId);
      const receipt = readReceipt(path);
      if (gitText(cwd, ['rev-parse', 'HEAD']).trim() !== receipt.baseline) throw new Error('agent changed the profile snapshot baseline');
      const changed = new Set([
        ...gitText(cwd, ['diff', 'HEAD', '--name-only', '-z']).split('\0'),
        ...gitText(cwd, ['ls-files', '--others', '-z']).split('\0'),
      ].filter(Boolean));
      const scanned = scanWorkspace(POLICY, cwd);
      const byPath = new Map(scanned.files.map((entry) => [entry.path, entry]));
      const files: ProfileSavebackManifest['files'] = [];
      const deletes: string[] = [];
      let totalBytes = 0;
      const runRoot = resolve(cwd);
      for (const relative of [...changed].sort()) {
        if (!isSafeRelativePath(relative) || relative.split('/')[0] === '.trained-assist'
          || matchRule(POLICY, relative).action === 'exclude') continue;
        const entry = byPath.get(relative);
        if (!entry) {
          deletes.push(relative);
          continue;
        }
        if (entry.size > MAX_FILE_BYTES || totalBytes + entry.size > MAX_RUN_BYTES) throw new Error('profile changes exceed the VM saveback size limits');
        const absolute = resolveInsideRoot(runRoot, relative, 'profile saveback path');
        const bytes = readFileSync(absolute);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== entry.sha256 || bytes.length !== entry.size) throw new Error(`profile change changed while saving: ${relative}`);
        await uploadFile(profile, token, relative, bytes, sha256);
        files.push({ path: relative, sha256, size: bytes.length });
        totalBytes += bytes.length;
      }
      const manifest = { files, deletes };
      writeReceipt(path, { ...receipt, manifest });
      return NULL_COMMIT;
    },
    changes(spec) {
      try { return readReceipt(receiptPath(receipts, spec.runId)).manifest; } catch { return undefined; }
    },
  };
}

function requiredSavebackWorkspace(spec: RunSpec): ProfileWorkspaceSpec {
  if (!spec.profileWorkspace?.savebackUrl || !spec.profileWorkspace.snapshotUrl) {
    throw new Error('profile saveback requires a pinned snapshot and run-scoped API capability');
  }
  return spec.profileWorkspace;
}

async function uploadFile(profile: ProfileWorkspaceSpec, token: string, relative: string, bytes: Buffer, sha256: string): Promise<void> {
  const endpoint = new URL(profile.savebackUrl!);
  endpoint.searchParams.set('path', relative);
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-content-sha256': sha256 },
    body: bytes,
  });
  if (!response.ok) throw new Error(`profile saveback upload failed with HTTP ${response.status}`);
}

function receiptPath(root: string, runId: string): string { return join(root, `${runId}.json`); }

function writeReceipt(path: string, value: DurableReceipt): void {
  writeFileAtomic(path, `${JSON.stringify(value)}\n`);
}

function readReceipt(path: string): DurableReceipt {
  return JSON.parse(readFileSync(path, 'utf8')) as DurableReceipt;
}

function git(cwd: string, args: string[]): void { execFileSync('git', ['-c', 'credential.helper=', ...args], { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }); }
function gitText(cwd: string, args: string[]): string { return execFileSync('git', ['-c', 'credential.helper=', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }); }
