import type { AgentApi } from './service.js';
import type { UploadSession, UploadSessionStore } from '../storage/upload-session.js';
import type { ArtifactStore } from '../storage/artifact-store.js';
import type { KeyRegistry, Principal } from './auth.js';
import { ApiError } from './errors.js';
import { sha256Hex } from '../storage/blob-store.js';

export interface UploadRouteDeps {
  service: AgentApi;
  uploads: UploadSessionStore;
  artifacts: ArtifactStore;
  keys: KeyRegistry;
}

export interface UploadSessionView {
  sessionId: string;
  runId: string;
  userTaskId: string;
  profileId: string;
  artifactName: string;
  mime: string;
  totalBytes: number;
  sha256: string;
  status: UploadSession['status'];
  uploadedBytes: number;
  parts: UploadSession['parts'];
  presignedUrl: string | null;
  expiresAt: string;
  createdAt: string;
  completedAt: string | null;
  abortedAt: string | null;
}

export function buildUploadSessionView(session: UploadSession): UploadSessionView {
  return {
    sessionId: session.sessionId,
    runId: session.runId,
    userTaskId: session.userTaskId,
    profileId: session.profileId,
    artifactName: session.artifactName,
    mime: session.mime,
    totalBytes: session.totalBytes,
    sha256: session.sha256,
    status: session.status,
    uploadedBytes: session.uploadedBytes,
    parts: session.parts,
    presignedUrl: session.presignedUrl,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    completedAt: session.completedAt,
    abortedAt: session.abortedAt,
  };
}

export async function handleUploadAction(
  deps: UploadRouteDeps,
  principal: Principal,
  runId: string,
  method: string,
  body: unknown,
): Promise<{ status: number; view: UploadSessionView | UploadSessionView[] }> {
  deps.service.status(principal, runId);

  if (method === 'POST') {
    const artifactName = readString(body, 'artifactName', 200);
    if (!artifactName) throw new ApiError('INVALID_REQUEST', 'artifactName is required');
    const mime = readString(body, 'mime', 100) ?? 'application/octet-stream';
    const totalBytes = readPositiveInt(body, 'totalBytes');
    const sha256 = readString(body, 'sha256', 64);
    if (!sha256) throw new ApiError('INVALID_REQUEST', 'sha256 is required');

    const userTaskId = `${principal.profileId}-upload`;
    const upload = deps.uploads.create({
      runId,
      userTaskId,
      profileId: principal.profileId,
      artifactName,
      mime,
      totalBytes,
      sha256,
    });
    return { status: 201, view: buildUploadSessionView(upload) };
  }

  if (method === 'GET') {
    const sessions = deps.uploads.listForRun(runId);
    return { status: 200, view: sessions.map(buildUploadSessionView) };
  }

  throw new ApiError('METHOD_NOT_ALLOWED', 'upload session supports GET and POST only');
}

export async function handleUploadSessionAction(
  deps: UploadRouteDeps,
  principal: Principal,
  runId: string,
  sessionId: string,
  method: string,
  body: unknown,
): Promise<{ status: number; view: UploadSessionView }> {
  deps.service.status(principal, runId);
  const session = deps.uploads.get(sessionId);
  if (!session) throw new ApiError('NOT_FOUND', `upload session ${sessionId} not found`);
  if (session.runId !== runId) throw new ApiError('FORBIDDEN', `session ${sessionId} does not belong to run ${runId}`);
  if (session.profileId !== principal.profileId) throw new ApiError('FORBIDDEN', `session ${sessionId} belongs to a different principal`);

  switch (method) {
    case 'GET':
      return { status: 200, view: buildUploadSessionView(session) };

    case 'POST': {
      const action = readString(body, 'action', 50);
      if (!action) throw new ApiError('INVALID_REQUEST', 'action field is required for POST');
      switch (action) {
        case 'complete': {
          const manifest = await verifyAndRegister(deps, session);
          const completed = deps.uploads.complete(sessionId, manifest);
          return { status: 200, view: buildUploadSessionView(completed) };
        }
        case 'abort': {
          const aborted = deps.uploads.abort(sessionId);
          await cleanupUpload(deps, session);
          return { status: 200, view: buildUploadSessionView(aborted) };
        }
        case 'resume': {
          if (session.status !== 'active') {
            throw new ApiError('UPLOAD_SESSION_INVALID', `cannot resume session in "${session.status}" state`);
          }
          const uploadedBytes = readPositiveInt(body, 'uploadedBytes');
          const parts = readParts(body);
          const updated = deps.uploads.updateProgress(sessionId, uploadedBytes, parts);
          return { status: 200, view: buildUploadSessionView(updated) };
        }
        default:
          throw new ApiError('INVALID_REQUEST', `unknown action "${action}"`);
      }
    }

    default:
      throw new ApiError('METHOD_NOT_ALLOWED', 'upload session supports GET and POST only');
  }
}

async function verifyAndRegister(
  deps: UploadRouteDeps,
  session: UploadSession,
): Promise<import('../storage/manifest.js').ArtifactManifest> {
  const artifactStore = deps.artifacts;
  const storageKey = session.storageKey;

  let bytes: Buffer;
  try {
    bytes = await artifactStore.blob.get(storageKey);
  } catch {
    throw new ApiError('UPLOAD_SESSION_INVALID', `no data found for session ${session.sessionId}`);
  }

  const actualSha256 = sha256Hex(bytes);
  if (actualSha256 !== session.sha256) {
    throw new ApiError('UPLOAD_HASH_MISMATCH', `uploaded bytes sha256 ${actualSha256} does not match expected ${session.sha256}`);
  }
  if (bytes.length !== session.totalBytes) {
    throw new ApiError('UPLOAD_SIZE_MISMATCH', `uploaded bytes size ${bytes.length} does not match expected ${session.totalBytes}`);
  }

  return artifactStore.put({
    runId: session.runId,
    userTaskId: session.userTaskId,
    profileId: session.profileId,
    name: session.artifactName,
    mime: session.mime,
    bytes,
  });
}

async function cleanupUpload(deps: UploadRouteDeps, session: UploadSession): Promise<void> {
  if (session.cleanupDone) return;
  try {
    await deps.artifacts.blob.delete?.(session.storageKey);
  } catch {
    // cleanup is best-effort
  }
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

function readParts(body: unknown): UploadSession['parts'] {
  if (typeof body !== 'object' || body === null) return [];
  const parts = (body as Record<string, unknown>)['parts'];
  if (!parts) return [];
  if (!Array.isArray(parts)) throw new ApiError('INVALID_REQUEST', 'parts: expected an array');
  return parts.map((part, i) => {
    if (typeof part !== 'object' || part === null) throw new ApiError('INVALID_REQUEST', `parts[${i}]: expected an object`);
    const p = part as Record<string, unknown>;
    const number = typeof p['number'] === 'number' && Number.isInteger(p['number']) && p['number'] > 0
      ? p['number']
      : (() => { throw new ApiError('INVALID_REQUEST', `parts[${i}].number: expected a positive integer`); })();
    const size = typeof p['size'] === 'number' && Number.isInteger(p['size']) && p['size'] >= 0
      ? p['size']
      : (() => { throw new ApiError('INVALID_REQUEST', `parts[${i}].size: expected a non-negative integer`); })();
    const sha256 = typeof p['sha256'] === 'string' && p['sha256'].length === 64
      ? p['sha256']
      : (() => { throw new ApiError('INVALID_REQUEST', `parts[${i}].sha256: expected a 64-character hex string`); })();
    return { number, size, sha256 };
  });
}