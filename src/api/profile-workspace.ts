import type { Principal } from './auth.js';
import { createBlobStore } from '../storage/create-blob-store.js';
import { WorkspaceError, type ProfileRepositoryBinding, type WorkspacePublication } from '../workspace/contract.js';
import { createGitHubRepositoryAdmin } from '../workspace/git/github-admin.js';
import { createLocalGitPort } from '../workspace/git/local-git.js';
import { WorkspaceJournal } from '../workspace/journal.js';
import type { BindingStorePort } from '../workspace/ports.js';
import { WorkspaceService } from '../workspace/service.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EMPTY_TREE } from '../workspace/contract.js';
import { createHash } from 'node:crypto';
import { DEFAULT_EXPORT_POLICY, patternToRegExp } from '../workspace/policy.js';

/** The API key is the authority for tenant/profile; a worker result never supplies either. */
export interface PreparedProfileRun {
  bindingId: string;
  repository: string;
  baseRevision: string;
  token: string;
  objectBucket?: string;
  artifacts: Array<{ path: string; key: string; sha256: string; size: number }>;
  excludedPatterns: string[];
}

export interface ProfileWorkspaceCoordinator {
  prepare(principal: Principal, runId: string): Promise<PreparedProfileRun>;
  publish(principal: Principal, runId: string, commit: string): Promise<WorkspacePublication>;
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
  const workspace = new WorkspaceService({
    git: createLocalGitPort({ rootDir: join(options.rootDir, 'mirrors'), resolveCredential }),
    objects,
    bindings,
    admin: createGitHubRepositoryAdmin({ tokenRef, resolveToken: resolveCredential }),
    journal,
  });
  const identity = (principal: Principal): { tenantId: string; profileId: string } => {
    if (!principal.tenantId) throw new WorkspaceError('WORKSPACE_FORBIDDEN', 'API key has no trusted tenantId');
    return { tenantId: principal.tenantId, profileId: principal.profileId };
  };
  return {
    async prepare(principal, runId) {
      const { tenantId, profileId } = identity(principal);
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
      return {
        bindingId: snapshot.bindingId, repository: ensured.repository, baseRevision: snapshot.baseRevision, token: options.token,
        ...(options.objectBackend === 'gcs' ? { objectBucket: options.env?.['GCS_BUCKET'] ?? '' } : {}),
        artifacts: snapshot.manifest.filter((entry) => entry.artifact !== null).map((entry) => ({
          path: entry.path, key: entry.artifact!.key, sha256: entry.sha256, size: entry.size,
        })),
        excludedPatterns: DEFAULT_EXPORT_POLICY.rules.filter((rule) => rule.action === 'exclude').map((rule) => patternToRegExp(rule.pattern).source),
      };
    },
    async publish(principal, runId, commit) {
      const { tenantId, profileId } = identity(principal);
      const publication = await workspace.publishRunBranch({ operationId: `publish:${runId}`, tenantId, profileId, runId, expectedCommit: commit, credentialTokenRef: tokenRef });
      if (publication.status === 'pending' || publication.outcomeUnknown) {
        return workspace.getWorkspacePublication({ publicationId: publication.publicationId, tenantId, credentialTokenRef: tokenRef });
      }
      return publication;
    },
    async readObject(principal, key) {
      identity(principal);
      if (!key.startsWith(`profiles/${principal.profileId}/workspace/`)) throw new WorkspaceError('WORKSPACE_FORBIDDEN', 'object belongs to another profile');
      return objects.get(key);
    },
  };
}
