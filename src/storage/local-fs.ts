import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BlobCallOptions, BlobHead, BlobRef, BlobStore } from './blob-store.js';
import { DEFAULT_DEADLINE_MS, boundCall, sha256Hex, toBuffer } from './blob-store.js';
import { StorageError, isNotFound } from './errors.js';
import { assertSafeStorageKey } from './keys.js';

export interface LocalFsStat {
  size: number;
  mtimeMs: number;
}

export interface LocalFsIo {
  write(absPath: string, bytes: Buffer): void | Promise<void>;
  read(absPath: string): Buffer | Promise<Buffer>;
  stat(absPath: string): LocalFsStat | null | Promise<LocalFsStat | null>;
  remove(absPath: string): void | Promise<void>;
}

export interface LocalFsBlobStoreOptions {
  rootDir: string;
  deadlineMs?: number;
  io?: LocalFsIo;
}

export const DEFAULT_LOCAL_FS_ROOT = 'data/blobs';

let tmpCounter = 0;

function defaultIo(): LocalFsIo {
  return {
    write(absPath, bytes) {
      mkdirSync(dirname(absPath), { recursive: true });
      tmpCounter += 1;
      const tmp = `${absPath}.${process.pid}.${tmpCounter}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, absPath);
    },
    read(absPath) {
      return readFileSync(absPath);
    },
    stat(absPath) {
      try {
        const info = statSync(absPath);
        if (!info.isFile()) return null;
        return { size: info.size, mtimeMs: info.mtimeMs };
      } catch {
        return null;
      }
    },
    remove(absPath) {
      rmSync(absPath, { force: true });
    },
  };
}

export class LocalFsBlobStore implements BlobStore {
  readonly backend = 'local-fs' as const;
  readonly rootDir: string;
  private readonly deadlineMs: number;
  private readonly io: LocalFsIo;

  constructor(options: LocalFsBlobStoreOptions) {
    if (typeof options.rootDir !== 'string' || options.rootDir.length === 0) {
      throw new StorageError('BLOB_BACKEND_MISCONFIGURED', 'local-fs backend requires a root directory (STORAGE_LOCAL_ROOT)');
    }
    this.rootDir = resolve(options.rootDir);
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.io = options.io ?? defaultIo();
  }

  private path(key: string): string {
    assertSafeStorageKey(key);
    return join(this.rootDir, ...key.split('/'));
  }

  put(key: string, bytes: Uint8Array | string, options?: BlobCallOptions): Promise<BlobRef> {
    return boundCall(`blob put ${key}`, options, this.deadlineMs, async () => {
      const absPath = this.path(key);
      const buf = toBuffer(bytes);
      await this.io.write(absPath, buf);
      let stored: Buffer;
      try {
        stored = await this.io.read(absPath);
      } catch (err) {
        throw new StorageError(
          'BLOB_UPLOAD_UNVERIFIED',
          `blob put ${key} wrote the object but the stored bytes could not be read back: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const sha256 = sha256Hex(stored);
      if (sha256 !== sha256Hex(buf)) {
        throw new StorageError('BLOB_SHA_MISMATCH', `stored bytes differ from the uploaded bytes for ${key}`);
      }
      const info = await this.io.stat(absPath);
      return { sha256, size: stored.length, generation: info ? String(info.mtimeMs) : null };
    });
  }

  get(key: string, options?: BlobCallOptions): Promise<Buffer> {
    return boundCall(`blob get ${key}`, options, this.deadlineMs, async () => {
      const absPath = this.path(key);
      try {
        return await this.io.read(absPath);
      } catch (err) {
        if (isNotFound(err)) throw new StorageError('BLOB_NOT_FOUND', `blob not found: ${key}`);
        throw err;
      }
    });
  }

  head(key: string, options?: BlobCallOptions): Promise<BlobHead> {
    return boundCall(`blob head ${key}`, options, this.deadlineMs, async () => {
      const absPath = this.path(key);
      const info = await this.io.stat(absPath);
      if (!info) throw new StorageError('BLOB_NOT_FOUND', `blob not found: ${key}`);
      return { size: info.size, generation: String(info.mtimeMs) };
    });
  }

  delete(key: string, options?: BlobCallOptions): Promise<void> {
    return boundCall(`blob delete ${key}`, options, this.deadlineMs, async () => {
      await this.io.remove(this.path(key));
    });
  }
}

export function createLocalFsBlobStore(options: LocalFsBlobStoreOptions): LocalFsBlobStore {
  return new LocalFsBlobStore(options);
}
