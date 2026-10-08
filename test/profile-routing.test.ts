import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTenantProfileRoutes, requireTenantProfileRoute, selectProfileRepositoryRoute } from '../src/api/profile-routing.js';
import { createProfileWorkspaceCoordinator } from '../src/api/profile-workspace.js';
import { repositoryNameFor } from '../src/workspace/policy.js';

describe('tenant-scoped profile repository routing', () => {
  it('routes a trusted synthetic tenant to its organization using only a named host secret', () => {
    const routes = parseTenantProfileRoutes(
      JSON.stringify({ 'sandbox3-acceptance': { owner: 'profile-artifacts-sandbox', tokenEnv: 'SANDBOX3_GITHUB_TOKEN' } }),
      { SANDBOX3_GITHUB_TOKEN: 'github-token-fixture' },
    );

    expect(selectProfileRepositoryRoute({
      tenantId: 'sandbox3-acceptance',
      defaultRoute: { owner: 'existing-profile-owner', token: 'default-token' },
      tenantRoutes: routes,
    })).toEqual({ owner: 'profile-artifacts-sandbox', token: 'github-token-fixture' });
  });

  it('preserves the existing default route for ordinary tenants unless strict routing is enabled', () => {
    const input = {
      tenantId: 'ordinary-tenant',
      defaultRoute: { owner: 'existing-profile-owner', token: 'default-token' },
      tenantRoutes: { 'sandbox3-acceptance': { owner: 'profile-artifacts-sandbox', token: 'test-token' } },
    };
    expect(selectProfileRepositoryRoute(input)).toEqual(input.defaultRoute);
    expect(() => selectProfileRepositoryRoute({ ...input, requireTenantRoute: true })).toThrow(/no configured profile repository route/);
  });

  it('rejects malformed, unknown-field, missing-secret and invalid strict-mode configuration', () => {
    expect(() => parseTenantProfileRoutes('{', {})).toThrow(/valid JSON/);
    expect(() => parseTenantProfileRoutes('{"t":{"owner":"org","tokenEnv":"TOKEN","token":"inline"}}', { TOKEN: 'secret' })).toThrow(/unsupported field/);
    expect(() => parseTenantProfileRoutes('{"t":{"owner":"org","tokenEnv":"TOKEN"}}', {})).toThrow(/missing its configured GitHub credential/);
    expect(() => requireTenantProfileRoute('maybe')).toThrow(/must be true or false/);
  });

  it('rejects an unmapped tenant in a strict test lane before creating a repository', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'profile-routing-strict-'));
    try {
      const coordinator = createProfileWorkspaceCoordinator({
        rootDir,
        owner: 'profile-artifacts-sandbox',
        token: 'default-token-fixture',
        objectBackend: 'local-fs',
        requireTenantRoute: true,
        tenantRoutes: { 'sandbox3-acceptance': { owner: 'profile-artifacts-sandbox', token: 'org-token-fixture' } },
      });
      await expect(coordinator.prepare({ principalId: 'unknown', tenantId: 'unknown-tenant', profileId: 'new-profile', scopes: ['runs:write'] }, 'run-1'))
        .rejects.toThrow(/no configured profile repository route/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('supports a strict tenant-only lane with no default owner or credential', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'profile-routing-tenant-only-'));
    try {
      expect(() => createProfileWorkspaceCoordinator({
        rootDir,
        owner: '',
        token: '',
        objectBackend: 'local-fs',
        requireTenantRoute: true,
        tenantRoutes: { 'sandbox3-acceptance': { owner: 'profile-artifacts-sandbox', token: 'org-token-fixture' } },
      })).not.toThrow();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('keeps profiles with the same display name distinct when their trusted profile IDs differ', () => {
    const first = repositoryNameFor('test-user-01');
    const second = repositoryNameFor('test-user-02');
    expect(first).not.toBe(second);
    expect(first).toBe('profile-test-user-01');
    expect(second).toBe('profile-test-user-02');
  });
});
