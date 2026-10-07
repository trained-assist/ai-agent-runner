import type { Principal } from './auth.js';
import { createBlobStore } from '../storage/create-blob-store.js';
import { WorkspaceError, type ProfileRepositoryBinding, type WorkspacePublication } from '../workspace/contract.js';
import { createGitHubRepositoryAdmin } from '../workspace/git/github-admin.js';
import { createLocalGitPort } from '../workspace/git/local-git.js';
import { WorkspaceJournal } from '../workspace/journal.js';
import type { BindingStorePort } from '../workspace/ports.js';
import { WorkspaceService } from '../workspace/service.js';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EMPTY_TREE } from '../workspace/contract.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { compilePolicy, DEFAULT_EXPORT_POLICY, matchRule, patternToRegExp } from '../workspace/policy.js';
import { resolveInsideRoot, isSafeRelativePath } from '../storage/local-paths.js';
import { execFileSync } from 'node:child_process';

/** The API key is the authority for tenant/profile; a worker result never supplies either. */
export interface PreparedProfileRun {
  bindingId: string;
  repository: string;
  baseRevision: string;
  snapshotUrl: string;
  snapshotSha256: string;
  snapshotSize: number;
  savebackToken: string;
  objectBucket?: string;
  artifacts: Array<{ path: string; key: string; sha256: string; size: number }>;
  excludedPatterns: string[];
}

export interface ProfileWorkspaceCoordinator {
  prepare(principal: Principal, runId: string): Promise<PreparedProfileRun>;
  upload(principal: Principal, runId: string, token: string, path: string, bytes: Buffer, sha256: string): Promise<void>;
  publish(principal: Principal, runId: string, baseRevision: string, files: Array<{ path: string; sha256: string; size: number }>, deletes: string[]): Promise<WorkspacePublication>;
  readObject(principal: Principal, key: string): Promise<Buffer>;
}

class JournalBindings implements BindingStorePort {
  constructor(private readonly journal: WorkspaceJournal) {}

  async get(bindingId: string): Promise<ProfileRepositoryBinding | null> {
    return this.journal.read().bindings[bindingId] ?? null;
  }

  async findByProfile(tenantId: string, profileId: string): Promise<ProfileRepositoryBinding | null> {
    return Object.values(this.journal.read().bindings).find((binding) => binding.tenantId === tenantId && binding.profileId === profileId) ?? null;
  }

  async save(binding: ProfileRepositoryBinding): Promise<void> {
    this.journal.putBinding(binding);
  }

  async list(tenantId?: string): Promise<ProfileRepositoryBinding[]> {
    return Object.values(this.journal.read().bindings).filter((binding) => !tenantId || binding.tenantId === tenantId);
  }
}

export interface ProfileWorkspaceRuntimeOptions {
  rootDir: string;
  owner: string;
  token: string;
  objectBackend: 'gcs' | 'local-fs';
  env?: Record<string, string | undefined>;
}

/** Durable journal/mirrors live on the API host; canonical bytes live in Git and object storage. */
export function createProfileWorkspaceCoordinator(options: ProfileWorkspaceRuntimeOptions): ProfileWorkspaceCoordinator {
  if (!options.rootDir || !options.owner || !options.token) throw new Error('profile workspace requires rootDir, owner and GitHub token');
  if (options.objectBackend === 'local-fs' && process.env['NODE_ENV'] === 'production') {
    throw new Error('production profile workspace requires remote object storage');
  }
  const journal = new WorkspaceJournal(join(options.rootDir, 'journal'));
  journal.init();
  const bindings = new JournalBindings(journal);
  const tokenRef = 'profile-workspace-github';
  const resolveCredential = async (ref: string): Promise<string | undefined> => ref === tokenRef ? options.token : undefined;
  const objects = createBlobStore({ backend: options.objectBackend, env: options.env });
  const admin = createGitHubRepositoryAdmin({ tokenRef, resolveToken: resolveCredential });
  const exportPolicy = compilePolicy(DEFAULT_EXPORT_POLICY);
  const workspace = new WorkspaceService({
    git: createLocalGitPort({ rootDir: join(options.rootDir, 'mirrors'), resolveCredential }),
    objects,
    bindings,
    admin,
    journal,
  });
  const identity = (principal: Principal): { tenantId: string; profileId: string } => {
    if (!principal.tenantId) throw new WorkspaceError('WORKSPACE_FORBIDDEN', 'API key has no trusted tenantId');
    return { tenantId: principal.tenantId, profileId: principal.profileId };
  };
  return {
    async prepare(principal, runId) {
      const { tenantId, profileId } = identity(principal);
      if ((await bindings.list()).some((binding) => binding.profileId === profileId && binding.tenantId !== tenantId)) {
        throw new WorkspaceError('WORKSPACE_FORBIDDEN', 'profileId is already bound to another tenant');
      }
      const profileKey = createHash('sha256').update(`${tenantId}\0${profileId}`).digest('hex').slice(0, 32);
      const ensured = await workspace.ensureProfileRepository({
        operationId: `ensure:${profileKey}`,
        tenantId,
        profileId,
        owner: options.owner,
        credentialTokenRef: tokenRef,
      });
      if (!(await bindings.findByProfile(tenantId, profileId))?.headRevision) {
        const empty = mkdtempSync(join(tmpdir(), 'profile-bootstrap-'));
        try {
          const bootstrap = await workspace.publishRunChanges({
            operationId: `bootstrap:${profileKey}`,
            tenantId, profileId, runId: `bootstrap-${profileKey}`,
            workspacePath: empty, baseRevision: EMPTY_TREE, credentialTokenRef: tokenRef,
          });
          if (bootstrap.status !== 'published') throw new WorkspaceError('WORKSPACE_GIT_FAILED', 'profile bootstrap was not published');
        } finally {
          rmSync(empty, { recursive: true, force: true });
        }
      }
      // GitHub may choose the first pushed branch (the durable bootstrap candidate) as
      // default. Once the canonical branch has been published, align repository browsing
      // with the same ref used for future snapshots. This also repairs existing profiles.
      const binding = await bindings.findByProfile(tenantId, profileId);
      if (binding?.headRevision) {
        await admin.setDefaultBranch({ repository: binding.repository, branch: binding.branch });
      }
      const unresolved = journal.listPublications({ profileId }).find((entry) => entry.tenantId === tenantId && !['published', 'failed'].includes(entry.status));
      if (unresolved) {
        throw new WorkspaceError('WORKSPACE_HEAD_CHANGED', `profile has unresolved publication ${unresolved.publicationId}`, {
          detail: { publicationId: unresolved.publicationId, status: unresolved.status, conflictId: unresolved.conflictId },
        });
      }
      const snapshot = await workspace.prepareProfileWorkspace({
        operationId: `prepare:${runId}`,
        tenantId,
        profileId,
        credentialTokenRef: tokenRef,
      });
      if (snapshot.warnings.length > 0 || (snapshot.artifacts > 0 && options.objectBackend !== 'gcs')) {
        throw new WorkspaceError('WORKSPACE_STORAGE_UNAVAILABLE', 'profile snapshot cannot be fully materialized by this worker', {
          retryable: true,
          detail: { runId, warnings: snapshot.warnings, artifacts: snapshot.artifacts },
        });
      }
      if (!objects.shareUrl) throw new WorkspaceError('WORKSPACE_STORAGE_UNAVAILABLE', 'profile snapshot requires storage with signed download URLs');
      const archiveRoot = mkdtempSync(join(tmpdir(), `profile-${runId}-`));
      const archivePath = join(archiveRoot, 'snapshot.tar.gz');
      const materialized = join(archiveRoot, 'workspace');
      mkdirSync(materialized, { recursive: true, mode: 0o700 });
      try {
        for (const entry of snapshot.manifest) {
          if (!isSafeRelativePath(entry.path)) throw new WorkspaceError('WORKSPACE_PATH_DENIED', `unsafe snapshot path ${entry.path}`);
          const bytes = await workspace.readProfileBlob({ tenantId, profileId, revision: snapshot.baseRevision, path: entry.path, credentialTokenRef: tokenRef });
          if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
            throw new WorkspaceError('WORKSPACE_STORAGE_UNAVAILABLE', `snapshot checksum mismatch for ${entry.path}`);
          }
          const target = resolveInsideRoot(materialized, entry.path, 'profile snapshot path');
          mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
          writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
        }
        try {
          execFileSync('tar', ['--format', 'ustar', '-czf', archivePath, '-C', materialized, '.'], { stdio: 'pipe' });
        } catch {
          throw new WorkspaceError('WORKSPACE_PATH_DENIED', 'profile snapshot contains a path unsupported by the portable USTAR format');
        }
        const archiveBytes = readFileSync(archivePath);
        const archiveKey = `profiles/${profileId}/snapshots/${runId}/${createHash('sha256').update(archiveBytes).digest('hex')}.tar.gz`;
        await objects.put(archiveKey, archiveBytes);
        const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
        const signed = await objects.shareUrl(archiveKey, { expiresAt });
        const writebackToken = randomBytes(32).toString('base64url');
        const savebackDir = join(options.rootDir, 'saveback', runId);
        mkdirSync(savebackDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(savebackDir, 'capability.json'), JSON.stringify({ tokenHash: createHash('sha256').update(writebackToken).digest('hex'), tenantId, profileId, baseRevision: snapshot.baseRevision, snapshotKey: archiveKey, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }), { mode: 0o600 });
        return {
          bindingId: snapshot.bindingId, repository: ensured.repository, baseRevision: snapshot.baseRevision,
          snapshotUrl: signed.url, snapshotSha256: createHash('sha256').update(archiveBytes).digest('hex'), snapshotSize: archiveBytes.length,
          savebackToken: writebackToken,
          ...(options.objectBackend === 'gcs' ? { objectBucket: options.env?.['GCS_BUCKET'] ?? '' } : {}),
          artifacts: snapshot.manifest.filter((entry) => entry.artifact !== null).map((entry) => ({ path: entry.path, key: entry.artifact!.key, sha256: entry.sha256, size: entry.size })),
          excludedPatterns: DEFAULT_EXPORT_POLICY.rules.filter((rule) => rule.action === 'exclude').map((rule) => patternToRegExp(rule.pattern).source),
        };
      } finally {
        rmSync(archiveRoot, { recursive: true, force: true });
      }
    },
    async upload(principal, runId, token, path, bytes, sha256) {
      const { tenantId, profileId } = identity(principal);
      if (!isSafeRelativePath(path) || !/^[0-9a-f]{64}$/.test(sha256) || createHash('sha256').update(bytes).digest('hex') !== sha256) throw new WorkspaceError('WORKSPACE_PATH_DENIED', 'saveback path or checksum is invalid');
      if (matchRule(exportPolicy, path).action === 'exclude') throw new WorkspaceError('WORKSPACE_PATH_DENIED', 'saveback path is excluded by the profile export policy');
      if (bytes.length > 100_000_000) throw new WorkspaceError('WORKSPACE_TOO_LARGE', 'saveback file exceeds the 100 MB per-file limit');
      const dir = join(options.rootDir, 'saveback', runId);
      const capPath = join(dir, 'capability.json');
      if (!existsSync(capPath)) throw new WorkspaceError('WORKSPACE_FORBIDDEN', 'saveback capability is not active');
      const cap = JSON.parse(readFileSync(capPath, 'utf8')) as { tokenHash: string; tenantId: string; profileId: string; expiresAt: string; uploaded?: Record<string, { sha256: string; size: number }> };
      const suppliedHash = createHash('sha256').update(token).digest();
      const expectedHash = Buffer.from(cap.tokenHash, 'hex');
      if (cap.tenantId !== tenantId || cap.profileId !== profileId || Date.parse(cap.expiresAt) <= Date.now() || expectedHash.length !== suppliedHash.length || !timingSafeEqual(expectedHash, suppliedHash)) throw new WorkspaceError('WORKSPACE_FORBIDDEN', 'saveback capability is invalid or expired');
      const target = resolveInsideRoot(join(dir, 'files'), path, 'saveback path');
      const priorSize = cap.uploaded?.[path]?.size ?? 0;
      const totalBefore = Object.values(cap.uploaded ?? {}).reduce((sum, item) => sum + item.size, 0);
      if (totalBefore - priorSize + bytes.length > 256_000_000) throw new WorkspaceError('WORKSPACE_TOO_LARGE', 'saveback exceeds the 256 MB per-run limit');
      mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600 });
      cap.uploaded = { ...(cap.uploaded ?? {}), [path]: { sha256, size: bytes.length } };
      writeFileSync(capPath, JSON.stringify(cap), { mode: 0o600 });
    },
    async publish(principal, runId, baseRevision, files, deletes) {
      const { tenantId, profileId } = identity(principal);
      const dir = join(options.rootDir, 'saveback', runId);
      const capPath = join(dir, 'capability.json');
      if (!existsSync(capPath)) throw new WorkspaceError('WORKSPACE_FORBIDDEN', 'saveback capability is not active');
      const cap = JSON.parse(readFileSync(capPath, 'utf8')) as { tenantId: string; profileId: string; baseRevision: string; snapshotKey?: string; expiresAt: string; uploaded?: Record<string, { sha256: string; size: number }> };
      if (cap.tenantId !== tenantId || cap.profileId !== profileId || cap.baseRevision !== baseRevision || Date.parse(cap.expiresAt) <= Date.now()) throw new WorkspaceError('WORKSPACE_FORBIDDEN', 'saveback run binding is invalid or expired');
      const workspacePath = mkdtempSync(join(tmpdir(), `profile-save-${runId}-`));
      let durablePublication = false;
      try {
        const snapshot = await workspace.prepareProfileWorkspace({ operationId: `saveback-base:${runId}`, tenantId, profileId, revision: baseRevision, credentialTokenRef: tokenRef });
        for (const entry of snapshot.manifest) {
          const bytes = await workspace.readProfileBlob({ tenantId, profileId, revision: baseRevision, path: entry.path, credentialTokenRef: tokenRef });
          const target = resolveInsideRoot(workspacePath, entry.path, 'profile base path');
          mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
          writeFileSync(target, bytes, { mode: 0o600 });
        }
        const declared = new Map(files.map((entry) => [entry.path, entry]));
        if (declared.size !== files.length || new Set(deletes).size !== deletes.length || deletes.some((path) => declared.has(path))) throw new WorkspaceError('WORKSPACE_INVALID', 'saveback manifest contains duplicate or conflicting paths');
        for (const [path, entry] of declared) {
          if (!isSafeRelativePath(path)) throw new WorkspaceError('WORKSPACE_PATH_DENIED', `unsafe saveback path ${path}`);
          const target = resolveInsideRoot(workspacePath, path, 'saveback path');
          const uploaded = resolveInsideRoot(join(dir, 'files'), path, 'saveback upload');
          if (!existsSync(uploaded)) throw new WorkspaceError('WORKSPACE_NOT_FOUND', `saveback file ${path} was not uploaded`);
          const bytes = readFileSync(uploaded);
          if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new WorkspaceError('WORKSPACE_STORAGE_UNAVAILABLE', `saveback checksum mismatch for ${path}`);
          if (cap.uploaded?.[path]?.sha256 !== entry.sha256 || cap.uploaded?.[path]?.size !== entry.size) throw new WorkspaceError('WORKSPACE_FORBIDDEN', `saveback file ${path} is not in this run's upload receipt`);
          mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
          writeFileSync(target, bytes, { mode: 0o600 });
        }
        for (const path of deletes) {
          if (!isSafeRelativePath(path)) throw new WorkspaceError('WORKSPACE_PATH_DENIED', `unsafe saveback delete path ${path}`);
          if (matchRule(exportPolicy, path).action === 'exclude') throw new WorkspaceError('WORKSPACE_PATH_DENIED', 'saveback delete path is excluded by the profile export policy');
          rmSync(resolveInsideRoot(workspacePath, path, 'saveback delete'), { force: true });
        }
        const publication = await workspace.publishRunChanges({ operationId: `publish:${runId}`, tenantId, profileId, runId, workspacePath, baseRevision, credentialTokenRef: tokenRef });
        durablePublication = true;
        return publication;
      } finally {
        rmSync(workspacePath, { recursive: true, force: true });
        // Keep staged bytes and the capability on transient Git/storage failure so that
        // API result reconciliation can retry the same publication without rerunning the agent.
        if (durablePublication) {
          if (cap.snapshotKey && objects.delete) await objects.delete(cap.snapshotKey).catch(() => undefined);
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
    async readObject(principal, key) {
      identity(principal);
      if (!key.startsWith(`profiles/${principal.profileId}/workspace/`)) throw new WorkspaceError('WORKSPACE_FORBIDDEN', 'object belongs to another profile');
      return objects.get(key);
    },
  };
}
