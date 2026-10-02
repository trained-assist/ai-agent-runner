import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSafeId } from '../contracts/validate.js';
import { StorageError } from './errors.js';

export const WORKSPACE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type SnapshotConflictPolicy = 'reject' | 'overwrite' | 'merge';

export interface WorkspaceFileEntry {
  path: string;
  size: number;
  sha256: string;
  mime: string;
  createdAt: string;
}

export interface WorkspaceSnapshot {
  schemaVersion: typeof WORKSPACE_SNAPSHOT_SCHEMA_VERSION;
  snapshotId: string;
  runId: string;
  userTaskId: string;
  profileId: string;
  version: number;
  status: 'active' | 'committed' | 'conflict' | 'abandoned';
  conflictPolicy: SnapshotConflictPolicy;
  files: WorkspaceFileEntry[];
  totalBytes: number;
  createdAt: string;
  committedAt: string | null;
  abandonedAt: string | null;
}

export interface CreateSnapshotInput {
  runId: string;
  userTaskId: string;
  profileId: string;
  conflictPolicy?: SnapshotConflictPolicy;
}

export interface SnapshotStoreOptions {
  rootDir: string;
}

export class WorkspaceSnapshotStore {
  readonly rootDir: string;

  constructor(options: SnapshotStoreOptions) {
    if (typeof options.rootDir !== 'string' || options.rootDir.length === 0) {
      throw new StorageError('SNAPSHOT_INVALID', 'snapshot store requires a data root directory');
    }
    this.rootDir = options.rootDir;
  }

  snapshotsDir(): string {
    return join(this.rootDir, 'snapshots');
  }

  snapshotPath(snapshotId: string): string {
    return join(this.snapshotsDir(), `${snapshotId}.json`);
  }

  assertId(value: unknown, field: string): string {
    if (!isSafeId(value)) {
      throw new StorageError('SNAPSHOT_INVALID', `invalid ${field}: expected an id matching [A-Za-z0-9][A-Za-z0-9._:-]*`);
    }
    return value;
  }

  create(input: CreateSnapshotInput): WorkspaceSnapshot {
    this.assertId(input.runId, 'runId');
    const snapshotId = `snap-${randomBytes(12).toString('hex')}`;
    const at = new Date().toISOString();

    const snapshot: WorkspaceSnapshot = {
      schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
      snapshotId,
      runId: input.runId,
      userTaskId: input.userTaskId,
      profileId: input.profileId,
      version: 1,
      status: 'active',
      conflictPolicy: input.conflictPolicy ?? 'reject',
      files: [],
      totalBytes: 0,
      createdAt: at,
      committedAt: null,
      abandonedAt: null,
    };

    this.writeSnapshot(snapshot);
    return snapshot;
  }

  get(snapshotId: string): WorkspaceSnapshot | null {
    const path = this.snapshotPath(this.assertId(snapshotId, 'snapshotId'));
    if (!existsSync(path)) return null;
    return this.parseSnapshot(readFileSync(path, 'utf8'), path);
  }

  listForRun(runId: string): WorkspaceSnapshot[] {
    this.assertId(runId, 'runId');
    const dir = this.snapshotsDir();
    if (!existsSync(dir)) return [];
    const snapshots: WorkspaceSnapshot[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const snapshot = this.parseSnapshot(readFileSync(join(dir, entry), 'utf8'), join(dir, entry));
        if (snapshot.runId === runId) snapshots.push(snapshot);
      } catch {
        // skip malformed snapshots
      }
    }
    return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  recordFile(
    snapshotId: string,
    filePath: string,
    size: number,
    sha256: string,
    mime: string,
  ): WorkspaceSnapshot {
    const snapshot = this.requireActive(snapshotId);
    const existing = snapshot.files.find((f) => f.path === filePath);
    if (existing) {
      if (existing.sha256 !== sha256) {
        if (snapshot.conflictPolicy === 'reject') {
          const updated: WorkspaceSnapshot = {
            ...snapshot,
            status: 'conflict',
            abandonedAt: new Date().toISOString(),
          };
          this.writeSnapshot(updated);
          throw new StorageError(
            'SNAPSHOT_CONFLICT',
            `file "${filePath}" has been modified by another writer (sha256 mismatch)`,
          );
        }
      }
    }

    const fileEntry: WorkspaceFileEntry = {
      path: filePath,
      size,
      sha256,
      mime,
      createdAt: new Date().toISOString(),
    };

    const files = snapshot.files.map((f) => (f.path === filePath ? fileEntry : f));
    if (!files.find((f) => f.path === filePath)) {
      files.push(fileEntry);
    }

    const updated: WorkspaceSnapshot = {
      ...snapshot,
      files,
      totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    };
    this.writeSnapshot(updated);
    return updated;
  }

  commit(snapshotId: string): WorkspaceSnapshot {
    const snapshot = this.requireActive(snapshotId);
    const committed: WorkspaceSnapshot = {
      ...snapshot,
      status: 'committed',
      committedAt: new Date().toISOString(),
    };
    this.writeSnapshot(committed);
    return committed;
  }

  abandon(snapshotId: string): WorkspaceSnapshot {
    const snapshot = this.requireActive(snapshotId);
    const abandoned: WorkspaceSnapshot = {
      ...snapshot,
      status: 'abandoned',
      abandonedAt: new Date().toISOString(),
    };
    this.writeSnapshot(abandoned);
    return abandoned;
  }

  private requireActive(snapshotId: string): WorkspaceSnapshot {
    const snapshot = this.get(snapshotId);
    if (!snapshot) {
      throw new StorageError('SNAPSHOT_NOT_FOUND', `snapshot ${snapshotId} not found`);
    }
    if (snapshot.status !== 'active') {
      throw new StorageError(
        'SNAPSHOT_INVALID',
        `snapshot ${snapshotId} is already "${snapshot.status}"`,
      );
    }
    return snapshot;
  }

  private parseSnapshot(raw: string, source: string): WorkspaceSnapshot {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StorageError('SNAPSHOT_INVALID', `snapshot is not valid JSON: ${source}`);
    }
    const snapshot = parsed as WorkspaceSnapshot;
    if (snapshot.schemaVersion !== WORKSPACE_SNAPSHOT_SCHEMA_VERSION) {
      throw new StorageError('SNAPSHOT_INVALID', `unsupported schema version ${snapshot.schemaVersion}`);
    }
    return snapshot;
  }

  private writeSnapshot(snapshot: WorkspaceSnapshot): void {
    const path = this.snapshotPath(snapshot.snapshotId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  }
}