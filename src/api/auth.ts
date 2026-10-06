import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type Scope = 'runs:read' | 'runs:write';

export const RUN_SCOPES: readonly Scope[] = ['runs:read', 'runs:write'];

export interface Principal {
  principalId: string;
  /** Trusted tenant from the API key registry; required for a profile workspace. */
  tenantId?: string;
  profileId: string;
  scopes: Scope[];
  engines?: string[];
}

export interface KeyRecord {
  keyHash: string;
  principalId: string;
  tenantId?: string;
  profileId: string;
  scopes: Scope[];
  engines?: string[];
}

export function generateApiKey(): string {
  return `ak_${randomBytes(24).toString('hex')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function keyRecordFor(key: string, principal: Principal): KeyRecord {
  const record: KeyRecord = {
    keyHash: hashApiKey(key),
    principalId: principal.principalId,
    ...(principal.tenantId ? { tenantId: principal.tenantId } : {}),
    profileId: principal.profileId,
    scopes: [...principal.scopes],
  };
  if (principal.engines) record.engines = [...principal.engines];
  return record;
}

interface RegistryFile {
  schemaVersion: number;
  principals: KeyRecord[];
}

function parseRecord(value: unknown, index: number): KeyRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`key registry: entry ${index} is not an object`);
  }
  const entry = value as Record<string, unknown>;
  const keyHash = entry['keyHash'];
  const principalId = entry['principalId'];
  const profileId = entry['profileId'];
  const tenantId = entry['tenantId'];
  const scopes = entry['scopes'];
  if (typeof keyHash !== 'string' || !/^[0-9a-f]{64}$/.test(keyHash)) {
    throw new Error(`key registry: entry ${index} has an invalid keyHash`);
  }
  if (typeof principalId !== 'string' || principalId.length === 0) {
    throw new Error(`key registry: entry ${index} has an invalid principalId`);
  }
  if (typeof profileId !== 'string' || profileId.length === 0) {
    throw new Error(`key registry: entry ${index} has an invalid profileId`);
  }
  if (tenantId !== undefined && (typeof tenantId !== 'string' || tenantId.length === 0)) {
    throw new Error(`key registry: entry ${index} has an invalid tenantId`);
  }
  if (!Array.isArray(scopes) || scopes.some((scope) => !(RUN_SCOPES as readonly string[]).includes(scope as string))) {
    throw new Error(`key registry: entry ${index} has invalid scopes`);
  }
  const record: KeyRecord = { keyHash, principalId, profileId, scopes: scopes as Scope[], ...(tenantId ? { tenantId: tenantId as string } : {}) };
  const engines = entry['engines'];
  if (engines !== undefined) {
    if (!Array.isArray(engines) || engines.some((name) => typeof name !== 'string')) {
      throw new Error(`key registry: entry ${index} has invalid engines`);
    }
    record.engines = engines as string[];
  }
  return record;
}

export class KeyRegistry {
  private readonly byHash = new Map<string, Principal>();
  private readonly profileTenants = new Map<string, string>();
  private readonly principalBindings = new Map<string, string>();
  private filePath: string | null = null;
  private fileDigest: string | null = null;
  private fileSnapshot: KeyRegistry | null = null;

  static fromRecords(records: KeyRecord[]): KeyRegistry {
    const registry = new KeyRegistry();
    for (const record of records) registry.add(record);
    return registry;
  }

  static loadFile(path: string): KeyRegistry {
    const registry = new KeyRegistry();
    registry.filePath = path;
    registry.refreshFile();
    return registry;
  }

  /** A file-backed registry swaps complete snapshots between requests. */
  private current(): KeyRegistry {
    if (this.filePath === null) return this;
    this.refreshFile();
    return this.fileSnapshot!;
  }

  private refreshFile(): void {
    const path = this.filePath!;
    let raw: string | null;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      raw = null;
    }
    const digest = raw === null ? 'missing' : createHash('sha256').update(raw).digest('hex');
    if (this.fileSnapshot !== null && digest === this.fileDigest) return;

    // Parse and validate a fresh snapshot before making it visible. A malformed
    // replacement invalidates the old snapshot, so a revoked key cannot survive
    // a failed reload. The next request retries after the file is fixed.
    this.fileSnapshot = null;
    const parsed = raw === null ? { schemaVersion: 1, principals: [] } : JSON.parse(raw) as RegistryFile;
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.principals)) {
      throw new Error('key registry: file must contain a principals array');
    }
    const next = KeyRegistry.fromRecords(parsed.principals.map((entry, index) => parseRecord(entry, index)));
    const wasLoaded = this.fileDigest !== null;
    this.fileSnapshot = next;
    this.fileDigest = digest;
    if (wasLoaded) console.warn(JSON.stringify({ event: 'key_registry_reloaded', keys: next.size() }));
  }

  add(record: KeyRecord): void {
    if (record.tenantId) {
      const priorTenant = this.profileTenants.get(record.profileId);
      if (priorTenant && priorTenant !== record.tenantId) throw new Error(`key registry: profileId ${record.profileId} is bound to multiple tenants`);
      const binding = `${record.tenantId}\0${record.profileId}`;
      const priorBinding = this.principalBindings.get(record.principalId);
      if (priorBinding && priorBinding !== binding) throw new Error(`key registry: principalId ${record.principalId} is bound to multiple profiles`);
      this.profileTenants.set(record.profileId, record.tenantId);
      this.principalBindings.set(record.principalId, binding);
    }
    const principal: Principal = {
      principalId: record.principalId,
      ...(record.tenantId ? { tenantId: record.tenantId } : {}),
      profileId: record.profileId,
      scopes: [...record.scopes],
    };
    if (record.engines) principal.engines = [...record.engines];
    this.byHash.set(record.keyHash, principal);
  }

  size(): number {
    const current = this.current();
    return current === this ? this.byHash.size : current.size();
  }

  authenticate(authorizationHeader: string | undefined): Principal | null {
    if (typeof authorizationHeader !== 'string') return null;
    const match = /^Bearer[ \t]+(\S+)$/i.exec(authorizationHeader.trim());
    if (!match) return null;
    const key = match[1];
    if (!key) return null;
    const current = this.current();
    if (current !== this) return current.authenticate(authorizationHeader);
    const presented = Buffer.from(hashApiKey(key), 'hex');
    for (const [storedHash, principal] of this.byHash) {
      const stored = Buffer.from(storedHash, 'hex');
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
        const copy: Principal = {
          principalId: principal.principalId,
          ...(principal.tenantId ? { tenantId: principal.tenantId } : {}),
          profileId: principal.profileId,
          scopes: [...principal.scopes],
        };
        if (principal.engines) copy.engines = [...principal.engines];
        return copy;
      }
    }
    return null;
  }
}
