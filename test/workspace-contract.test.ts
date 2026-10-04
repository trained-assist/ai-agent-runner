import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceJournal, MemoryWorkspaceJournal, operationPayloadHash } from '../src/workspace/journal.js';
import {
  changeSetHash,
  isCommitSha,
  isRevision,
  validateBinding,
  validateCandidate,
  validateConflict,
  validatePublication,
  validateWorkspaceSnapshot,
  WorkspaceError,
  type ProfileRepositoryBinding,
  type WorkspaceChangeEntry,
  type WorkspaceConflict,
  type WorkspacePublication,
  type WorkspaceResolutionCandidate,
} from '../src/workspace/contract.js';
import { cleanupTempDirs, tempDir } from './workspace-fixtures.js';

afterEach(cleanupTempDirs);

function binding(overrides: Partial<ProfileRepositoryBinding> = {}): ProfileRepositoryBinding {
  return {
    schemaVersion: 1,
    bindingId: 'wsbind-1',
    tenantId: 'tenant-a',
    profileId: 'alice',
    owner: 'profiles-artifacts',
    repository: 'profiles-artifacts/profile-alice',
    url: 'https://example.test/profiles-artifacts/profile-alice',
    private: true,
    branch: 'main',
    headRevision: null,
    importedAt: null,
    importManifestHash: null,
    createdAt: '2026-10-04T10:00:00.000Z',
    updatedAt: '2026-10-04T10:00:00.000Z',
    ...overrides,
  };
}

function publication(overrides: Partial<WorkspacePublication> = {}): WorkspacePublication {
  const changes: WorkspaceChangeEntry[] = [{ path: 'notes/a.md', kind: 'add', sha256: 'a'.repeat(64), size: 3, artifact: null }];
  return {
    schemaVersion: 1,
    publicationId: 'wspub-1',
    operationId: 'op-1',
    origin: 'run',
    bindingId: 'wsbind-1',
    tenantId: 'tenant-a',
    profileId: 'alice',
    runId: 'run-1',
    ownerGeneration: 1,
    baseRevision: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    expectedHeadRevision: null,
    committedRevision: null,
    status: 'pending',
    reason: null,
    manifestHash: changeSetHash(changes),
    changes,
    artifacts: [],
    conflictId: null,
    candidateId: null,
    branch: 'agent-run/run-1',
    candidateCommit: null,
    candidatePushed: false,
    outcomeUnknown: false,
    mergeAttempts: 0,
    cleanup: { cleanupAllowed: false, reason: 'not completed', retained: ['notes/a.md'] },
    exportPolicyId: 'profile-workspace-v1',
    createdAt: '2026-10-04T10:00:00.000Z',
    updatedAt: '2026-10-04T10:00:00.000Z',
    committedAt: null,
    ...overrides,
  };
}

function conflict(overrides: Partial<WorkspaceConflict> = {}): WorkspaceConflict {
  return {
    schemaVersion: 1,
    conflictId: 'wsconf-1',
    publicationId: 'wspub-1',
    bindingId: 'wsbind-1',
    tenantId: 'tenant-a',
    profileId: 'alice',
    baseRevision: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    runRevision: 'b'.repeat(40),
    currentRevision: 'c'.repeat(40),
    entries: [{ path: 'notes/a.md', kind: 'content', runSha256: 'a'.repeat(64), currentSha256: 'b'.repeat(64) }],
    artifacts: [],
    candidateCommit: null,
    resolutionAttempts: 0,
    createdAt: '2026-10-04T10:00:00.000Z',
    updatedAt: '2026-10-04T10:00:00.000Z',
    ...overrides,
  };
}

function candidate(overrides: Partial<WorkspaceResolutionCandidate> = {}): WorkspaceResolutionCandidate {
  return {
    schemaVersion: 1,
    candidateId: 'wscand-1',
    conflictId: 'wsconf-1',
    bindingId: 'wsbind-1',
    tenantId: 'tenant-a',
    profileId: 'alice',
    baseRevision: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    expectedHeadRevision: 'c'.repeat(40),
    tree: 'd'.repeat(40),
    entries: [{ path: 'notes/a.md', kind: 'content', runSha256: 'a'.repeat(64), currentSha256: 'b'.repeat(64) }],
    source: 'deterministic',
    resolverRunId: null,
    evidence: 'deterministic merge',
    createdAt: '2026-10-04T10:00:00.000Z',
    ...overrides,
  };
}

describe('revisions', () => {
  it('accepts a commit sha and the empty tree as versions of state', () => {
    expect(isCommitSha('a'.repeat(40))).toBe(true);
    expect(isCommitSha('a'.repeat(64))).toBe(true);
    expect(isCommitSha('a'.repeat(39))).toBe(false);
    expect(isCommitSha('4b825dc642cb6eb9a060e54bf8d69288fbee4904')).toBe(true);
    expect(isRevision('4b825dc642cb6eb9a060e54bf8d69288fbee4904')).toBe(true);
    expect(isRevision('main')).toBe(false);
  });

  it('changeSetHash is order independent but content sensitive', () => {
    const a: WorkspaceChangeEntry = { path: 'a.md', kind: 'add', sha256: 'a'.repeat(64), size: 1, artifact: null };
    const b: WorkspaceChangeEntry = { path: 'b.md', kind: 'update', sha256: 'b'.repeat(64), size: 2, artifact: null };
    expect(changeSetHash([a, b])).toBe(changeSetHash([b, a]));
    expect(changeSetHash([a])).not.toBe(changeSetHash([{ ...a, sha256: 'c'.repeat(64) }]));
  });
});

describe('record validation', () => {
  it('accepts a well formed binding, publication, conflict and candidate', () => {
    expect(validateBinding(binding()).ok).toBe(true);
    expect(validatePublication(publication()).ok).toBe(true);
    expect(validateConflict(conflict()).ok).toBe(true);
    expect(validateCandidate(candidate()).ok).toBe(true);
  });

  it('rejects a published record without a committed revision', () => {
    const result = validatePublication(publication({ status: 'published', committedRevision: null }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join()).toMatch(/committedRevision/);
  });

  it('rejects a published record that still forbids cleanup', () => {
    const result = validatePublication(publication({ status: 'published', committedRevision: 'e'.repeat(40) }));
    expect(result.ok === false && result.errors.join()).toMatch(/must allow cleanup/);
  });

  it('rejects a deleted change entry that carries a hash or size', () => {
    const bad = publication({ changes: [{ path: 'a.md', kind: 'delete', sha256: 'a'.repeat(64), size: 5, artifact: null }] });
    const result = validatePublication(bad);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join()).toMatch(/carries no content hash|no size/);
  });

  it('rejects an exported entry that does not point at verified bytes', () => {
    const bad = publication({
      artifacts: [{ key: 'k', sha256: 'a'.repeat(64), size: 1, mime: 'application/octet-stream', verifiedAt: '2026-10-04T10:00:00.000Z' }],
    });
    expect(validatePublication(bad).ok).toBe(true);
    const broken = publication({
      artifacts: [{ key: 'k', sha256: 'not-a-digest', size: 1, mime: 'application/octet-stream', verifiedAt: '2026-10-04T10:00:00.000Z' }],
    });
    expect(validatePublication(broken).ok).toBe(false);
  });

  it('rejects duplicate change paths instead of silently keeping the last one', () => {
    const dup = publication({
      changes: [
        { path: 'a.md', kind: 'add', sha256: 'a'.repeat(64), size: 1, artifact: null },
        { path: 'a.md', kind: 'update', sha256: 'b'.repeat(64), size: 1, artifact: null },
      ],
    });
    const result = validatePublication(dup);
    expect(result.ok === false && result.errors.join()).toMatch(/duplicate path/);
  });

  it('rejects an unsafe path anywhere in a durable record', () => {
    const escape = publication({ changes: [{ path: '../outside.md', kind: 'add', sha256: 'a'.repeat(64), size: 1, artifact: null }] });
    expect(validatePublication(escape).ok).toBe(false);
  });

  it('rejects a snapshot whose manifest references an unknown field', () => {
    const snap = {
      schemaVersion: 1,
      workspaceSnapshotId: 'wssnap-1',
      bindingId: 'wsbind-1',
      profileId: 'alice',
      baseRevision: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      headRevision: null,
      manifest: [],
      files: 0,
      bytes: 0,
      artifacts: 0,
      warnings: [],
      exportPolicyId: 'profile-workspace-v1',
      createdAt: '2026-10-04T10:00:00.000Z',
      secret: 'x',
    };
    const result = validateWorkspaceSnapshot(snap);
    expect(result.ok === false && result.errors.join()).toMatch(/unknown field "secret"/);
  });
});

describe('journal: idempotency by operationId', () => {
  /** Два вызова одного operationId: внешний эффект должен выполниться ровно один раз. */
  const twice = async (journal: WorkspaceJournal | MemoryWorkspaceJournal, calls: { count: number }): Promise<void> => {
    const payload = { profileId: 'alice', head: 'a'.repeat(40) };
    for (const _ of [1, 2]) {
      const result = await journal.runOperation({
        operationId: 'op-1',
        method: 'publish_run_changes',
        payload,
        execute: async () => {
          calls.count += 1;
          return { publicationId: 'wspub-1' };
        },
      });
      expect(result.result.publicationId).toBe('wspub-1');
    }
  };

  it('replays the same result for the same payload (memory)', async () => {
    const calls = { count: 0 };
    await twice(new MemoryWorkspaceJournal(), calls);
    expect(calls.count).toBe(1);
  });

  it('replays the same result after a restart (file journal)', async () => {
    const dir = tempDir('ws-journal-');
    const first = new WorkspaceJournal(dir);
    first.init();
    const calls = { count: 0 };
    await twice(first, calls);
    expect(calls.count).toBe(1);

    // Новый процесс читает durable-журнал и не выполняет операцию повторно.
    const restarted = new WorkspaceJournal(dir);
    restarted.init();
    const afterRestart = { count: 0 };
    await twice(restarted, afterRestart);
    expect(afterRestart.count).toBe(0);
    expect(calls.count).toBe(1);
  });

  it('refuses a different payload under the same operationId', async () => {
    const journal = new MemoryWorkspaceJournal();
    await journal.runOperation({ operationId: 'op-1', method: 'm', payload: { a: 1 }, execute: async () => 'first' });
    await expect(journal.runOperation({ operationId: 'op-1', method: 'm', payload: { a: 2 }, execute: async () => 'second' })).rejects.toMatchObject({
      code: 'WORKSPACE_OPERATION_CONFLICT',
    });
  });

  it('allows a retry of a failed operation with the same payload', async () => {
    const journal = new MemoryWorkspaceJournal();
    await expect(
      journal.runOperation({
        operationId: 'op-2',
        method: 'm',
        payload: { a: 1 },
        execute: async () => {
          throw new WorkspaceError('WORKSPACE_STORAGE_UNAVAILABLE', 'injected');
        },
      }),
    ).rejects.toBeInstanceOf(WorkspaceError);
    const retry = await journal.runOperation({ operationId: 'op-2', method: 'm', payload: { a: 1 }, execute: async () => 'ok' });
    expect(retry.result).toBe('ok');
  });

  it('hashes payloads canonically, so key order does not matter', () => {
    expect(operationPayloadHash({ a: 1, b: 2 })).toBe(operationPayloadHash({ b: 2, a: 1 }));
  });

  it('rejects an operation id that could not be a key', async () => {
    const journal = new MemoryWorkspaceJournal();
    await expect(journal.runOperation({ operationId: 'op/../x', method: 'm', payload: {}, execute: async () => 1 })).rejects.toMatchObject({
      code: 'WORKSPACE_INVALID',
    });
  });
});

describe('journal: durable records and cursors', () => {
  it('stores, indexes and reloads publications, conflicts and candidates', async () => {
    const dir = tempDir('ws-journal-records-');
    const journal = new WorkspaceJournal(dir);
    journal.init();
    journal.putPublication(publication());
    journal.putConflict(conflict());
    journal.putCandidate(candidate());
    journal.putBinding(binding());
    journal.setBatchCursor('op-batch', 'profile-b');

    const reloaded = new WorkspaceJournal(dir);
    reloaded.init();
    expect(reloaded.getPublication('wspub-1')?.status).toBe('pending');
    expect(reloaded.findPublicationByOperation('op-1')?.publicationId).toBe('wspub-1');
    expect(reloaded.getConflict('wsconf-1')?.entries).toHaveLength(1);
    expect(reloaded.getCandidate('wscand-1')?.tree).toBe('d'.repeat(40));
    expect(reloaded.getBatchCursor('op-batch')).toBe('profile-b');
    expect(reloaded.stats()).toMatchObject({ publications: 1, conflicts: 1, candidates: 1, bindings: 1 });
  });

  it('refuses to start from a corrupt journal instead of silently losing history', () => {
    const dir = tempDir('ws-journal-corrupt-');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workspace-journal.json'), '{"schemaVersion": 1, "publications": {"x": {"status": "published"}}}');
    expect(() => new WorkspaceJournal(dir).init()).toThrowError(/publication x is invalid/);
  });

  it('counts resolution attempts durably — the guard against a resolver loop', () => {
    const dir = tempDir('ws-journal-attempts-');
    const journal = new WorkspaceJournal(dir);
    journal.init();
    journal.putConflict(conflict());
    expect(journal.bumpResolutionAttempts('wsconf-1')).toBe(1);
    expect(journal.bumpResolutionAttempts('wsconf-1')).toBe(2);
    const reloaded = new WorkspaceJournal(dir);
    reloaded.init();
    expect(reloaded.bumpResolutionAttempts('wsconf-1')).toBe(3);
  });

  it('never prunes publications, only operation noise', () => {
    const journal = new MemoryWorkspaceJournal();
    journal.putPublication(publication());
    expect(journal.pruneOperations('2999-01-01T00:00:00.000Z')).toEqual([]);
    expect(journal.getPublication('wspub-1')).not.toBeNull();
  });
});
