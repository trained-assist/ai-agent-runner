import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, KeyRegistry } from '../src/api/auth.js';
import { isSandboxPrincipalProvisionerEntrypoint, parseSandboxPrincipalProvisionRequest } from '../src/ops/sandbox-principal-provisioner-cli.js';
import { provisionSandboxMockPrincipal, SANDBOX_TEST_PRINCIPAL } from '../src/ops/sandbox-principal-registry.js';

const directories: string[] = [];

function fixture(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'runner-sandbox-principal-'));
  directories.push(dir);
  const path = join(dir, 'key-registry.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, principals: [{
    keyHash: 'a'.repeat(64), principalId: 'existing-test-user', profileId: 'existing-profile', scopes: ['runs:read'],
  }] }), { mode: 0o600 });
  return { dir, path };
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('sandbox mock-test principal provisioning', () => {
  it('recognizes a provisioner CLI invoked through the current release symlink', () => {
    const { dir } = fixture();
    const target = join(dir, 'provisioner.js');
    const link = join(dir, 'current-provisioner.js');
    writeFileSync(target, '');
    symlinkSync(target, link);
    expect(isSandboxPrincipalProvisionerEntrypoint(link, target)).toBe(true);
    expect(isSandboxPrincipalProvisionerEntrypoint(undefined, target)).toBe(false);
    expect(isSandboxPrincipalProvisionerEntrypoint(join(dir, 'missing.js'), target)).toBe(false);
  });

  it('adds a hash-only, minimally scoped principal atomically and is idempotent', () => {
    const { path } = fixture();
    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const registryView = KeyRegistry.loadFile(path);
    const result = provisionSandboxMockPrincipal(path, keyHash);
    const registry = JSON.parse(readFileSync(path, 'utf8')) as { principals: Array<Record<string, unknown>> };
    const record = registry.principals.find((entry) => entry['keyHash'] === keyHash);

    expect(result).toMatchObject({ changed: true, principalId: SANDBOX_TEST_PRINCIPAL.principalId, tenantId: SANDBOX_TEST_PRINCIPAL.tenantId, profileId: SANDBOX_TEST_PRINCIPAL.profileId });
    expect(record).toMatchObject({ principalId: SANDBOX_TEST_PRINCIPAL.principalId, tenantId: SANDBOX_TEST_PRINCIPAL.tenantId, profileId: SANDBOX_TEST_PRINCIPAL.profileId, scopes: ['runs:read', 'runs:write'], engines: ['mock-test'] });
    expect(JSON.stringify(result)).not.toContain(rawKey);
    expect(JSON.stringify(result)).not.toContain(keyHash);
    expect(JSON.stringify(registry)).not.toContain(rawKey);
    expect(registryView.authenticate(`Bearer ${rawKey}`)).toMatchObject({ principalId: SANDBOX_TEST_PRINCIPAL.principalId, tenantId: SANDBOX_TEST_PRINCIPAL.tenantId, profileId: SANDBOX_TEST_PRINCIPAL.profileId, engines: ['mock-test'] });
    expect(provisionSandboxMockPrincipal(path, keyHash)).toMatchObject({ changed: false });
    expect((JSON.parse(readFileSync(path, 'utf8')) as { principals: unknown[] }).principals).toHaveLength(2);
  });

  it('preserves the sandbox API-readable 0640 registry mode during atomic replacement', () => {
    const { path } = fixture();
    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    chmodSync(path, 0o640);
    provisionSandboxMockPrincipal(path, keyHash);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(KeyRegistry.loadFile(path).authenticate(`Bearer ${rawKey}`)).toMatchObject({
      principalId: SANDBOX_TEST_PRINCIPAL.principalId,
      profileId: SANDBOX_TEST_PRINCIPAL.profileId,
    });
  });

  it('rejects invalid hashes, existing hash collisions, unsafe file modes and symlinks', () => {
    const { dir, path } = fixture();
    expect(() => provisionSandboxMockPrincipal(path, 'ak_not-a-hash')).toThrow('sandbox_principal_invalid_key_hash');
    expect(() => provisionSandboxMockPrincipal(path, 'a'.repeat(64))).toThrow('sandbox_principal_key_hash_conflict');

    const identityConflict = join(dir, 'identity-conflict.json');
    writeFileSync(identityConflict, JSON.stringify({ schemaVersion: 1, principals: [{
      keyHash: 'd'.repeat(64), principalId: SANDBOX_TEST_PRINCIPAL.principalId, profileId: 'wrong-profile', scopes: ['runs:read'],
    }] }), { mode: 0o600 });
    expect(() => provisionSandboxMockPrincipal(identityConflict, 'e'.repeat(64))).toThrow('sandbox_principal_identity_conflict');

    const openPath = join(dir, 'open.json');
    writeFileSync(openPath, JSON.stringify({ schemaVersion: 1, principals: [] }), { mode: 0o644 });
    expect(() => provisionSandboxMockPrincipal(openPath, 'b'.repeat(64))).toThrow('sandbox_principal_registry_permissions_too_open');

    const linkPath = join(dir, 'linked.json');
    symlinkSync(path, linkPath);
    expect(() => provisionSandboxMockPrincipal(linkPath, 'c'.repeat(64))).toThrow('sandbox_principal_registry_not_regular_file');
  });

  it('accepts only a hash and the fixed sandbox target; raw keys and target overrides fail closed', () => {
    const keyHash = createHash('sha256').update('test').digest('hex');
    expect(parseSandboxPrincipalProvisionRequest(JSON.stringify({ schemaVersion: 1, target: 'agent-runner-api-mcp-test', keyHash }))).toEqual({ keyHash });
    expect(() => parseSandboxPrincipalProvisionRequest(JSON.stringify({ schemaVersion: 1, target: 'agent-runner-api-mcp-test', keyHash, apiKey: 'secret' }))).toThrow('sandbox_principal_request_invalid_shape');
    expect(() => parseSandboxPrincipalProvisionRequest(JSON.stringify({ schemaVersion: 1, target: 'agent-runner-api.service', keyHash }))).toThrow('sandbox_principal_request_invalid_shape');
  });
});
