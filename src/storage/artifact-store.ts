import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeId } from '../contracts/validate.js';
import { writeFileAtomic } from '../runner/util.js';
import type { BlobBackend, BlobStore } from './blob-store.js';
import { sha256Hex, toBuffer } from './blob-store.js';
import { StorageError, isNotFound } from './errors.js';
import { runArtifactKey } from './keys.js';
import { parseArtifactManifest, validateArtifactManifest, type ArtifactManifest } from './manifest.js';

export type ArtifactVerifyStatus = 'verified' | 'present' | 'missing' | 'size_mismatch' | 'corrupt';

export interface ArtifactVerifyResult {
  runId: string;
  artifactId: string;
  storageKey: string;
  status: ArtifactVerifyStatus;
  checkedAt: string;
}

export interface ArtifactExportReceipt {
  runId: string;
  exportedAt: string;
  backend: BlobBackend;
  ok: number;
  failed: number;
  artifacts: ArtifactVerifyResult[];
}

export interface PutArtifactInput {
  runId: string;
  userTaskId: string;
  profileId: string;
  name: string;
  mime: string;
  bytes: Uint8Array | string;
  artifactId?: string;
}

export interface ArtifactStoreOptions {
  rootDir: string;
  blob: BlobStore;
  now?: () => Date;
}

function assertId(value: unknown, field: string): string {
  if (!isSafeId(value)) throw new StorageError('BLOB_UNSAFE_KEY', `invalid ${field}: expected an id matching [A-Za-z0-9][A-Za-z0-9._:-]*`);
  return value;
}

export function generateArtifactId(): string {
  return `art-${randomBytes(12).toString('hex')}`;
}

export class ArtifactStore {
  readonly rootDir: string;
  readonly blob: BlobStore;
  readonly runsDir: string;
  private readonly now: () => Date;
  private readonly index = new Map<string, string>();
  private indexed = false;

  constructor(options: ArtifactStoreOptions) {
    if (typeof options.rootDir !== 'string' || options.rootDir.length === 0) {
      throw new StorageError('BLOB_BACKEND_MISCONFIGURED', 'artifact store requires a data root directory');
    }
    this.rootDir = options.rootDir;
    this.blob = options.blob;
    this.now = options.now ?? (() => new Date());
    this.runsDir = join(this.rootDir, 'runs');
  }

  manifestPath(runId: string, artifactId: string): string {
    assertId(runId, 'runId');
    assertId(artifactId, 'artifactId');
    return join(this.runsDir, runId, 'artifacts', `${artifactId}.json`);
  }

  getManifest(runId: string, artifactId: string): ArtifactManifest | null {
    const path = this.manifestPath(runId, artifactId);
    if (!existsSync(path)) return null;
    return parseArtifactManifest(readFileSync(path, 'utf8'), path);
  }

  list(runId: string): ArtifactManifest[] {
    assertId(runId, 'runId');
    const dir = join(this.runsDir, runId, 'artifacts');
    if (!existsSync(dir)) return [];
    const manifests: ArtifactManifest[] = [];
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.json')) continue;
      const artifactId = entry.slice(0, -'.json'.length);
      if (!isSafeId(artifactId)) continue;
      const manifest = this.getManifest(runId, artifactId);
      if (manifest) manifests.push(manifest);
    }
    return manifests;
  }

  find(artifactId: string): { runId: string; manifest: ArtifactManifest } | null {
    if (!isSafeId(artifactId)) return null;
    if (!this.indexed) this.scanIndex();
    const cached = this.index.get(artifactId);
    if (cached !== undefined) {
      const manifest = this.getManifest(cached, artifactId);
      if (manifest) return { runId: cached, manifest };
      this.index.delete(artifactId);
    }
    this.scanIndex();
    const runId = this.index.get(artifactId);
    if (runId === undefined) return null;
    const manifest = this.getManifest(runId, artifactId);
    return manifest ? { runId, manifest } : null;
  }

  async put(input: PutArtifactInput): Promise<ArtifactManifest> {
    const runId = assertId(input.runId, 'runId');
    const artifactId = input.artifactId ?? generateArtifactId();
    assertId(artifactId, 'artifactId');
    const bytes = toBuffer(input.bytes);
    const sha256 = sha256Hex(bytes);
    const storageKey = runArtifactKey(runId, artifactId);

    const existing = this.getManifest(runId, artifactId);
    if (existing) {
      if (existing.sha256 === sha256 && existing.size === bytes.length) return existing;
      throw new StorageError('ARTIFACT_CONFLICT', `artifact ${artifactId} of run ${runId} already exists with different bytes`);
    }

    const ref = await this.blob.put(storageKey, bytes);
    if (ref.sha256 !== sha256) {
      throw new StorageError('BLOB_SHA_MISMATCH', `backend reported sha256 ${ref.sha256} for ${storageKey}, expected ${sha256}`);
    }
    if (ref.size !== bytes.length) {
      throw new StorageError('BLOB_UPLOAD_UNVERIFIED', `backend stored ${ref.size} bytes for ${storageKey}, expected ${bytes.length}`);
    }

    const candidate: ArtifactManifest = {
      artifactId,
      runId,
      userTaskId: input.userTaskId,
      profileId: input.profileId,
      name: input.name,
      mime: input.mime,
      size: bytes.length,
      sha256,
      storageKey,
      createdAt: this.now().toISOString(),
    };
    const validated = validateArtifactManifest(candidate);
    if (!validated.ok) {
      throw new StorageError('ARTIFACT_MANIFEST_INVALID', `refusing to persist an invalid artifact manifest: ${validated.errors.join('; ')}`);
    }

    writeFileAtomic(this.manifestPath(runId, artifactId), `${JSON.stringify(validated.value, null, 2)}\n`);
    if (this.indexed) this.index.set(artifactId, runId);
    return validated.value;
  }

  async read(runId: string, artifactId: string): Promise<{ manifest: ArtifactManifest; bytes: Buffer }> {
    const manifest = this.getManifest(runId, artifactId);
    if (!manifest) throw new StorageError('BLOB_NOT_FOUND', `unknown artifact ${artifactId} of run ${runId}`);
    const bytes = await this.blob.get(manifest.storageKey);
    if (bytes.length !== manifest.size) {
      throw new StorageError('BLOB_SHA_MISMATCH', `artifact ${artifactId} stored ${bytes.length} bytes, manifest declares ${manifest.size}`);
    }
    const sha256 = sha256Hex(bytes);
    if (sha256 !== manifest.sha256) {
      throw new StorageError('BLOB_SHA_MISMATCH', `artifact ${artifactId} bytes do not match the manifest digest`);
    }
    return { manifest, bytes };
  }

  async commit(runId: string, artifactId: string): Promise<ArtifactVerifyResult> {
    const manifest = this.getManifest(runId, artifactId);
    if (!manifest) throw new StorageError('BLOB_NOT_FOUND', `no artifact manifest for ${artifactId} of run ${runId}`);
    const checkedAt = this.now().toISOString();
    const base = { runId, artifactId, storageKey: manifest.storageKey, checkedAt };
    const head = await this.headOrNull(manifest.storageKey);
    if (!head) return { ...base, status: 'missing' };
    if (head.size !== manifest.size) return { ...base, status: 'size_mismatch' };
    const bytes = await this.blob.get(manifest.storageKey);
    if (bytes.length !== manifest.size || sha256Hex(bytes) !== manifest.sha256) return { ...base, status: 'corrupt' };
    return { ...base, status: 'verified' };
  }

  async export(runId: string, options: { deep?: boolean } = {}): Promise<ArtifactExportReceipt> {
    assertId(runId, 'runId');
    const exportedAt = this.now().toISOString();
    const artifacts: ArtifactVerifyResult[] = [];
    for (const manifest of this.list(runId)) {
      const base = { runId, artifactId: manifest.artifactId, storageKey: manifest.storageKey, checkedAt: exportedAt };
      const head = await this.headOrNull(manifest.storageKey);
      if (!head) {
        artifacts.push({ ...base, status: 'missing' });
        continue;
      }
      if (head.size !== manifest.size) {
        artifacts.push({ ...base, status: 'size_mismatch' });
        continue;
      }
      if (!options.deep) {
        artifacts.push({ ...base, status: 'present' });
        continue;
      }
      const bytes = await this.blob.get(manifest.storageKey);
      artifacts.push({ ...base, status: bytes.length === manifest.size && sha256Hex(bytes) === manifest.sha256 ? 'verified' : 'corrupt' });
    }
    const failed = artifacts.filter((item) => item.status === 'missing' || item.status === 'size_mismatch' || item.status === 'corrupt').length;
    return {
      runId,
      exportedAt,
      backend: this.blob.backend,
      ok: artifacts.length - failed,
      failed,
      artifacts,
    };
  }

  private async headOrNull(storageKey: string): Promise<{ size: number; generation: string | null } | null> {
    try {
      return await this.blob.head(storageKey);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  private scanIndex(): void {
    this.index.clear();
    if (existsSync(this.runsDir)) {
      for (const runId of readdirSync(this.runsDir).sort()) {
        if (!isSafeId(runId)) continue;
        const dir = join(this.runsDir, runId, 'artifacts');
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir)) {
          if (!entry.endsWith('.json')) continue;
          const artifactId = entry.slice(0, -'.json'.length);
          if (isSafeId(artifactId)) this.index.set(artifactId, runId);
        }
      }
    }
    this.indexed = true;
  }
}
