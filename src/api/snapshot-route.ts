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
    totalBytes: snapshot.totalBytes,
    createdAt: snapshot.createdAt,
    committedAt: snapshot.committedAt,
    abandonedAt: snapshot.abandonedAt,
  };
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
        const committed = deps.snapshots.commit(snapshotId);
        return { status: 200, view: buildSnapshotView(committed) };
      }
      case 'abandon': {
        const snapshotId = readString(body, 'snapshotId', 100);
        if (!snapshotId) throw new ApiError('INVALID_REQUEST', 'snapshotId is required');
        const abandoned = deps.snapshots.abandon(snapshotId);
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
  const snapshot = deps.snapshots.get(snapshotId);
  if (!snapshot) throw new ApiError('NOT_FOUND', `snapshot ${snapshotId} not found`);
  if (snapshot.runId !== runId) throw new ApiError('FORBIDDEN', `snapshot ${snapshotId} does not belong to run ${runId}`);
  if (snapshot.profileId !== principal.profileId) throw new ApiError('FORBIDDEN', `snapshot ${snapshotId} belongs to a different principal`);

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