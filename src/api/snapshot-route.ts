import type { AgentApi } from './service.js';
import type { WorkspaceSnapshot, WorkspaceSnapshotStore } from '../storage/workspace-snapshot.js';
import type { ArtifactStore } from '../storage/artifact-store.js';
import type { KeyRegistry, Principal } from './auth.js';
import { ApiError } from './errors.js';
import { sha256Hex } from '../storage/blob-store.js';

export interface SnapshotRouteDeps {
  service: AgentApi;
  snapshots: WorkspaceSnapshotStore;
  artifacts: ArtifactStore;
  keys: KeyRegistry;
}

export interface SnapshotView {
  snapshotId: string;
  runId: string;
  userTaskId: string;
  profileId: string;
  version: number;
  status: WorkspaceSnapshot['status'];
  conflictPolicy: WorkspaceSnapshot['conflictPolicy'];
  files: WorkspaceSnapshot['files'];
  /** Указатели на байты в долговечном хранилище (issue #52, шаг 1). */
  artifacts: WorkspaceSnapshot['artifacts'];
  totalBytes: number;
  createdAt: string;
  committedAt: string | null;
  abandonedAt: string | null;
}

export function buildSnapshotView(snapshot: WorkspaceSnapshot): SnapshotView {
  return {
    snapshotId: snapshot.snapshotId,
    runId: snapshot.runId,
    userTaskId: snapshot.userTaskId,
    profileId: snapshot.profileId,
    version: snapshot.version,
    status: snapshot.status,
    conflictPolicy: snapshot.conflictPolicy,
    files: snapshot.files,
    artifacts: snapshot.artifacts,
    totalBytes: snapshot.totalBytes,
    createdAt: snapshot.createdAt,
    committedAt: snapshot.committedAt,
    abandonedAt: snapshot.abandonedAt,
  };
}

/**
 * Снимок в руках его рана и его principal'а. Общая проверка для действий по снимку:
 * раньше `commit`/`abandon` брали `snapshotId` как есть, и чужой principal мог выпустить
 * в мир снимок с чужими указателями на байты.
 */
function requireOwnedSnapshot(
  snapshots: WorkspaceSnapshotStore,
  principal: Principal,
  runId: string,
  snapshotId: string,
): WorkspaceSnapshot {
  const snapshot = snapshots.get(snapshotId);
  if (!snapshot) throw new ApiError('NOT_FOUND', `snapshot ${snapshotId} not found`);
  if (snapshot.runId !== runId) throw new ApiError('FORBIDDEN', `snapshot ${snapshotId} does not belong to run ${runId}`);
  if (snapshot.profileId !== principal.profileId) {
    throw new ApiError('FORBIDDEN', `snapshot ${snapshotId} belongs to a different principal`);
  }
  return snapshot;
}

export async function handleSnapshotAction(
  deps: SnapshotRouteDeps,
  principal: Principal,
  runId: string,
  method: string,
  body: unknown,
): Promise<{ status: number; view: SnapshotView | SnapshotView[] }> {
  deps.service.status(principal, runId);

  if (method === 'POST') {
    const action = readString(body, 'action', 50);
    if (!action) throw new ApiError('INVALID_REQUEST', 'action field is required for POST');

    switch (action) {
      case 'create': {
        const conflictPolicy = readString(body, 'conflictPolicy', 20) as 'reject' | 'overwrite' | 'merge' | null;
        const snapshot = deps.snapshots.create({
          runId,
          userTaskId: `${principal.profileId}-task`,
          profileId: principal.profileId,
          conflictPolicy: conflictPolicy ?? 'reject',
        });
        return { status: 201, view: buildSnapshotView(snapshot) };
      }
      case 'commit': {
        const snapshotId = readString(body, 'snapshotId', 100);
        if (!snapshotId) throw new ApiError('INVALID_REQUEST', 'snapshotId is required');
        // Снимок коммитится только его раном и его владельцем: иначе чужой principal мог бы
        // выпустить в мир указатель на данные, которые сам не проверял.
        const snapshot = requireOwnedSnapshot(deps.snapshots, principal, runId, snapshotId);
        const committed = deps.snapshots.commit(snapshot.snapshotId);
        return { status: 200, view: buildSnapshotView(committed) };
      }
      case 'abandon': {
        const snapshotId = readString(body, 'snapshotId', 100);
        if (!snapshotId) throw new ApiError('INVALID_REQUEST', 'snapshotId is required');
        const snapshot = requireOwnedSnapshot(deps.snapshots, principal, runId, snapshotId);
        const abandoned = deps.snapshots.abandon(snapshot.snapshotId);
        return { status: 200, view: buildSnapshotView(abandoned) };
      }
      default:
        throw new ApiError('INVALID_REQUEST', `unknown action "${action}"`);
    }
  }

  if (method === 'GET') {
    const snapshots = deps.snapshots.listForRun(runId);
    return { status: 200, view: snapshots.map(buildSnapshotView) };
  }

  throw new ApiError('METHOD_NOT_ALLOWED', 'snapshot actions support GET and POST only');
}

export async function handleSnapshotFileAction(
  deps: SnapshotRouteDeps,
  principal: Principal,
  runId: string,
  snapshotId: string,
  method: string,
  body: unknown,
): Promise<{ status: number; view: SnapshotView }> {
  deps.service.status(principal, runId);
  const snapshot = requireOwnedSnapshot(deps.snapshots, principal, runId, snapshotId);

  if (method === 'POST') {
    const action = readString(body, 'action', 50);
    if (!action) throw new ApiError('INVALID_REQUEST', 'action field is required for POST');

    switch (action) {
      case 'record': {
        const filePath = readString(body, 'filePath', 512);
        if (!filePath) throw new ApiError('INVALID_REQUEST', 'filePath is required');
        const size = readPositiveInt(body, 'size');
        const sha256 = readString(body, 'sha256', 64);
        if (!sha256) throw new ApiError('INVALID_REQUEST', 'sha256 is required');
        const mime = readString(body, 'mime', 100) ?? 'application/octet-stream';
        const updated = deps.snapshots.recordFile(snapshotId, filePath, size, sha256, mime);
        return { status: 200, view: buildSnapshotView(updated) };
      }
      /**
       * Снимок — указатель на байты в хранилище (issue #52, шаг 1). Артефакт обязан
       * принадлежать ЭТОМУ рану и этому principal'у, а его манифест — совпадать с
       * объявленными клиентом `sha256`/`size`: иначе в снимок попала бы ссылка на чужие
       * или подменённые байты, а проверить их потом нечем.
       */
      case 'link': {
        const filePath = readString(body, 'path', 512);
        if (!filePath) throw new ApiError('INVALID_REQUEST', 'path is required for action "link"');
        const artifactId = readString(body, 'artifactId', 200);
        if (!artifactId) throw new ApiError('INVALID_REQUEST', 'artifactId is required for action "link"');
        const manifest = deps.artifacts.getManifest(runId, artifactId);
        if (!manifest) {
          throw new ApiError('NOT_FOUND', `artifact ${artifactId} is not registered for run ${runId}`);
        }
        if (manifest.profileId !== principal.profileId) {
          throw new ApiError('FORBIDDEN', `artifact ${artifactId} belongs to a different principal`);
        }
        const claimedSha = readString(body, 'sha256', 64);
        if (claimedSha && claimedSha !== manifest.sha256) {
          throw new ApiError('INVALID_REQUEST', `sha256 does not match the stored artifact ${artifactId}`, {
            artifactId,
            sha256: manifest.sha256,
          });
        }
        const claimedSize = readOptionalInt(body, 'size');
        if (claimedSize !== null && claimedSize !== manifest.size) {
          throw new ApiError('INVALID_REQUEST', `size does not match the stored artifact ${artifactId}`, {
            artifactId,
            size: manifest.size,
          });
        }
        const updated = deps.snapshots.recordArtifact(snapshotId, {
          path: filePath,
          artifactId,
          sha256: manifest.sha256,
          size: manifest.size,
          name: manifest.name,
          mime: manifest.mime,
        });
        return { status: 200, view: buildSnapshotView(updated) };
      }
      default:
        throw new ApiError('INVALID_REQUEST', `unknown action "${action}"`);
    }
  }

  throw new ApiError('METHOD_NOT_ALLOWED', 'snapshot file actions support POST only');
}

function readString(body: unknown, field: string, maxLen: number): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ApiError('INVALID_REQUEST', `${field}: expected a string`);
  if (value.length > maxLen) throw new ApiError('INVALID_REQUEST', `${field}: exceeds maximum length ${maxLen}`);
  return value;
}

function readPositiveInt(body: unknown, field: string): number {
  if (typeof body !== 'object' || body === null) throw new ApiError('INVALID_REQUEST', `${field}: required`);
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ApiError('INVALID_REQUEST', `${field}: expected a positive integer`);
  }
  return value;
}

/** Необязательное целое: отсутствие — не ошибка, но несоответствие объявленному — да. */
function readOptionalInt(body: unknown, field: string): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ApiError('INVALID_REQUEST', `${field}: expected a non-negative integer`);
  }
  return value;
}