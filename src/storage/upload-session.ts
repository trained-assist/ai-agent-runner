import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSafeId } from '../contracts/validate.js';
import { StorageError } from './errors.js';
import type { ArtifactManifest } from './manifest.js';

export const UPLOAD_SESSION_SCHEMA_VERSION = 1 as const;

export type UploadSessionStatus = 'active' | 'completed' | 'aborted' | 'expired';

export interface UploadPart {
  number: number;
  size: number;
  sha256: string;
}

export interface UploadSession {
  schemaVersion: typeof UPLOAD_SESSION_SCHEMA_VERSION;
  sessionId: string;
  runId: string;
  userTaskId: string;
  profileId: string;
  artifactName: string;
  mime: string;
  totalBytes: number;
  sha256: string;
  status: UploadSessionStatus;
  uploadedBytes: number;
  parts: UploadPart[];
  storageKey: string;
  presignedUrl: string | null;
  expiresAt: string;
  createdAt: string;
  completedAt: string | null;
  abortedAt: string | null;
  cleanupDone: boolean;
}

export interface CreateUploadSessionInput {
  runId: string;
  userTaskId: string;
  profileId: string;
  artifactName: string;
  mime: string;
  totalBytes: number;
  sha256: string;
  ttlSeconds?: number;
}

export interface UploadSessionStoreOptions {
  rootDir: string;
  ttlSeconds?: number;
  maxTotalBytes?: number;
  maxParts?: number;
  partSizeBytes?: number;
  now?: () => Date;
}

const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_PARTS = 10_000;
const DEFAULT_PART_SIZE_BYTES = 5 * 1024 * 1024;

export class UploadSessionStore {
  readonly rootDir: string;
  readonly ttlSeconds: number;
  readonly maxTotalBytes: number;
  readonly maxParts: number;
  readonly partSizeBytes: number;
  private readonly now: () => Date;

  constructor(options: UploadSessionStoreOptions) {
    if (typeof options.rootDir !== 'string' || options.rootDir.length === 0) {
      throw new StorageError('UPLOAD_SESSION_INVALID', 'upload session store requires a data root directory');
    }
    this.rootDir = options.rootDir;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxParts = options.maxParts ?? DEFAULT_MAX_PARTS;
    this.partSizeBytes = options.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  sessionsDir(): string {
    return join(this.rootDir, 'upload-sessions');
  }

  sessionPath(sessionId: string): string {
    return join(this.sessionsDir(), `${sessionId}.json`);
  }

  assertId(value: unknown, field: string): string {
    if (!isSafeId(value)) {
      throw new StorageError('UPLOAD_SESSION_INVALID', `invalid ${field}: expected an id matching [A-Za-z0-9][A-Za-z0-9._:-]*`);
    }
    return value;
  }

  create(input: CreateUploadSessionInput): UploadSession {
    this.assertId(input.runId, 'runId');
    if (input.totalBytes <= 0 || input.totalBytes > this.maxTotalBytes) {
      throw new StorageError('UPLOAD_SESSION_INVALID', `totalBytes must be in [1, ${this.maxTotalBytes}]`);
    }
    if (input.sha256.length !== 64) {
      throw new StorageError('UPLOAD_SESSION_INVALID', 'sha256 must be a 64-character hex string');
    }

    const sessionId = `up-${randomBytes(12).toString('hex')}`;
    const at = this.now().toISOString();
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000).toISOString();
    const storageKey = `runs/${input.runId}/uploads/${sessionId}/${input.artifactName}`;

    const session: UploadSession = {
      schemaVersion: UPLOAD_SESSION_SCHEMA_VERSION,
      sessionId,
      runId: input.runId,
      userTaskId: input.userTaskId,
      profileId: input.profileId,
      artifactName: input.artifactName,
      mime: input.mime,
      totalBytes: input.totalBytes,
      sha256: input.sha256,
      status: 'active',
      uploadedBytes: 0,
      parts: [],
      storageKey,
      presignedUrl: null,
      expiresAt,
      createdAt: at,
      completedAt: null,
      abortedAt: null,
      cleanupDone: false,
    };

    this.writeSession(session);
    return session;
  }

  get(sessionId: string): UploadSession | null {
    const path = this.sessionPath(this.assertId(sessionId, 'sessionId'));
    if (!existsSync(path)) return null;
    return this.parseSession(readFileSync(path, 'utf8'), path);
  }

  updateProgress(
    sessionId: string,
    uploadedBytes: number,
    parts: UploadPart[] = [],
  ): UploadSession {
    const session = this.requireActive(sessionId);
    if (uploadedBytes > session.totalBytes) {
      throw new StorageError('UPLOAD_SESSION_INVALID', `uploaded bytes ${uploadedBytes} exceed total ${session.totalBytes}`);
    }
    const mergedParts = this.mergeParts(session.parts, parts);
    const updated: UploadSession = {
      ...session,
      uploadedBytes,
      parts: mergedParts,
    };
    this.writeSession(updated);
    return updated;
  }

  complete(sessionId: string, manifest: ArtifactManifest): UploadSession {
    const session = this.requireActive(sessionId);
    if (session.uploadedBytes !== session.totalBytes) {
      throw new StorageError(
        'UPLOAD_SESSION_INVALID',
        `cannot complete: uploaded ${session.uploadedBytes} of ${session.totalBytes} bytes`,
      );
    }
    const completed: UploadSession = {
      ...session,
      status: 'completed',
      completedAt: this.now().toISOString(),
      cleanupDone: true,
    };
    this.writeSession(completed);
    return completed;
  }

  abort(sessionId: string): UploadSession {
    const session = this.requireActive(sessionId);
    const aborted: UploadSession = {
      ...session,
      status: 'aborted',
      abortedAt: this.now().toISOString(),
    };
    this.writeSession(aborted);
    return aborted;
  }

  expire(sessionId: string): UploadSession {
    const session = this.requireActive(sessionId);
    const expired: UploadSession = {
      ...session,
      status: 'expired',
    };
    this.writeSession(expired);
    return expired;
  }

  cleanupExpired(): number {
    const dir = this.sessionsDir();
    if (!existsSync(dir)) return 0;
    let cleaned = 0;
    const now = this.now().getTime();
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const path = join(dir, entry);
      try {
        const session = this.parseSession(readFileSync(path, 'utf8'), path);
        if (session.status === 'active' && new Date(session.expiresAt).getTime() <= now) {
          this.abort(session.sessionId);
          cleaned += 1;
        }
      } catch {
        // skip malformed sessions
      }
    }
    return cleaned;
  }

  listForRun(runId: string): UploadSession[] {
    this.assertId(runId, 'runId');
    const dir = this.sessionsDir();
    if (!existsSync(dir)) return [];
    const sessions: UploadSession[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const session = this.parseSession(readFileSync(join(dir, entry), 'utf8'), join(dir, entry));
        if (session.runId === runId) sessions.push(session);
      } catch {
        // skip malformed sessions
      }
    }
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private requireActive(sessionId: string): UploadSession {
    const session = this.get(sessionId);
    if (!session) {
      throw new StorageError('UPLOAD_SESSION_NOT_FOUND', `upload session ${sessionId} not found`);
    }
    if (session.status !== 'active') {
      throw new StorageError(
        'UPLOAD_SESSION_INVALID',
        `upload session ${sessionId} is already "${session.status}"`,
      );
    }
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      this.expire(sessionId);
      throw new StorageError('UPLOAD_SESSION_EXPIRED', `upload session ${sessionId} has expired`);
    }
    return session;
  }

  private mergeParts(existing: UploadPart[], incoming: UploadPart[]): UploadPart[] {
    const byNumber = new Map<number, UploadPart>();
    for (const part of existing) byNumber.set(part.number, part);
    for (const part of incoming) {
      const existingPart = byNumber.get(part.number);
      if (existingPart && existingPart.sha256 !== part.sha256) {
        throw new StorageError(
          'UPLOAD_SESSION_INVALID',
          `part ${part.number} hash mismatch: existing ${existingPart.sha256} vs incoming ${part.sha256}`,
        );
      }
      byNumber.set(part.number, part);
    }
    return [...byNumber.values()].sort((a, b) => a.number - b.number);
  }

  private parseSession(raw: string, source: string): UploadSession {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StorageError('UPLOAD_SESSION_INVALID', `upload session is not valid JSON: ${source}`);
    }
    const session = parsed as UploadSession;
    if (session.schemaVersion !== UPLOAD_SESSION_SCHEMA_VERSION) {
      throw new StorageError('UPLOAD_SESSION_INVALID', `unsupported schema version ${session.schemaVersion}`);
    }
    return session;
  }

  private writeSession(session: UploadSession): void {
    const path = this.sessionPath(session.sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  }
}