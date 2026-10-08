import {
  chmodSync, chownSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { KeyRegistry, RUN_SCOPES } from '../api/auth.js';

export const SANDBOX_TEST_PRINCIPAL = {
  principalId: 'integration-telegram-ux-v1-mock-test',
  profileId: 'integration-telegram-ux-v1',
  scopes: ['runs:read', 'runs:write'] as const,
  engines: ['mock-test'] as const,
} as const;

interface RegistryRecord {
  keyHash: string;
  principalId: string;
  profileId: string;
  scopes: string[];
  engines?: string[];
  tenantId?: string;
}

interface RegistryFile {
  schemaVersion: number;
  principals: RegistryRecord[];
}

export interface SandboxPrincipalProvisionResult {
  changed: boolean;
  principalId: string;
  profileId: string;
  scopes: readonly string[];
  engines: readonly string[];
}

function validateKeyHash(keyHash: unknown): asserts keyHash is string {
  if (typeof keyHash !== 'string' || !/^[a-f0-9]{64}$/.test(keyHash)) {
    throw new Error('sandbox_principal_invalid_key_hash');
  }
}

function parseRegistry(raw: string): RegistryFile {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('sandbox_principal_registry_invalid_json'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('sandbox_principal_registry_invalid_shape');
  }
  const value = parsed as Record<string, unknown>;
  if (value['schemaVersion'] !== 1 || !Array.isArray(value['principals'])) {
    throw new Error('sandbox_principal_registry_invalid_shape');
  }
  const principals = value['principals'].map((entry): RegistryRecord => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('sandbox_principal_registry_invalid_record');
    }
    const record = entry as Record<string, unknown>;
    if (typeof record['keyHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(record['keyHash'])
      || typeof record['principalId'] !== 'string' || typeof record['profileId'] !== 'string'
      || !Array.isArray(record['scopes']) || record['scopes'].length === 0
      || record['scopes'].some((scope) => typeof scope !== 'string' || !(RUN_SCOPES as readonly string[]).includes(scope))) {
      throw new Error('sandbox_principal_registry_invalid_record');
    }
    if (record['engines'] !== undefined && (!Array.isArray(record['engines']) || record['engines'].some((engine) => typeof engine !== 'string'))) {
      throw new Error('sandbox_principal_registry_invalid_record');
    }
    if (record['tenantId'] !== undefined && typeof record['tenantId'] !== 'string') {
      throw new Error('sandbox_principal_registry_invalid_record');
    }
    return {
      keyHash: record['keyHash'],
      principalId: record['principalId'],
      profileId: record['profileId'],
      scopes: [...record['scopes']] as string[],
      ...(record['engines'] === undefined ? {} : { engines: [...record['engines']] as string[] }),
      ...(record['tenantId'] === undefined ? {} : { tenantId: record['tenantId'] as string }),
    };
  });
  return { schemaVersion: 1, principals };
}

/** Add a key hash for the fixed sandbox-only mock-test principal. Never accepts a raw key. */
export function provisionSandboxMockPrincipal(registryPath: string, keyHash: unknown): SandboxPrincipalProvisionResult {
  validateKeyHash(keyHash);
  if (!existsSync(registryPath)) throw new Error('sandbox_principal_registry_missing');
  const before = lstatSync(registryPath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('sandbox_principal_registry_not_regular_file');
  if ((before.mode & 0o077) !== 0) throw new Error('sandbox_principal_registry_permissions_too_open');
  if (KeyRegistry.loadFile(registryPath).size() === 0) throw new Error('sandbox_principal_registry_empty');

  const lockPath = `${registryPath}.bootstrap-lock`;
  let lockFd: number;
  try { lockFd = openSync(lockPath, 'wx', 0o600); } catch { throw new Error('sandbox_principal_bootstrap_busy'); }
  const tempPath = join(dirname(registryPath), `.${basename(registryPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const registry = parseRegistry(readFileSync(registryPath, 'utf8'));
    if (registry.principals.some((record) => record.principalId === SANDBOX_TEST_PRINCIPAL.principalId
      && (record.profileId !== SANDBOX_TEST_PRINCIPAL.profileId || record.tenantId !== undefined))) {
      throw new Error('sandbox_principal_identity_conflict');
    }
    const existingByHash = registry.principals.find((record) => record.keyHash === keyHash);
    if (existingByHash) {
      if (existingByHash.principalId !== SANDBOX_TEST_PRINCIPAL.principalId
        || existingByHash.profileId !== SANDBOX_TEST_PRINCIPAL.profileId
        || JSON.stringify([...existingByHash.scopes].sort()) !== JSON.stringify([...SANDBOX_TEST_PRINCIPAL.scopes].sort())
        || JSON.stringify([...(existingByHash.engines ?? [])].sort()) !== JSON.stringify([...SANDBOX_TEST_PRINCIPAL.engines].sort())) {
        throw new Error('sandbox_principal_key_hash_conflict');
      }
      return { changed: false, ...SANDBOX_TEST_PRINCIPAL };
    }

    const record: RegistryRecord = {
      keyHash,
      principalId: SANDBOX_TEST_PRINCIPAL.principalId,
      profileId: SANDBOX_TEST_PRINCIPAL.profileId,
      scopes: [...SANDBOX_TEST_PRINCIPAL.scopes],
      engines: [...SANDBOX_TEST_PRINCIPAL.engines],
    };
    registry.principals.push(record);
    writeFileSync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chownSync(tempPath, before.uid, before.gid);
    chmodSync(tempPath, 0o600);
    const tempFd = openSync(tempPath, 'r');
    try { fsyncSync(tempFd); } finally { closeSync(tempFd); }
    renameSync(tempPath, registryPath);
    const dirFd = openSync(dirname(registryPath), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    return { changed: true, ...SANDBOX_TEST_PRINCIPAL };
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    closeSync(lockFd);
    unlinkSync(lockPath);
  }
}
