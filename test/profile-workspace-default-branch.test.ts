import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileWorkspaceCoordinator } from '../src/api/profile-workspace.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hasBranch(bare: string, branch: string): boolean {
  try {
    execFileSync('git', ['--git-dir', bare, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

describe('profile workspace default branch', () => {
  it('sets a new profile repository default to canonical main after bootstrap publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-default-branch-'));
    roots.push(root);
    const bare = join(root, 'remote.git');
    mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '--bare', '-q', bare]);

    const repository = 'profiles-artifacts/profile-profile-test';
    let exists = false;
    let defaultBranch = '';
    let bootstrapBranch = '';
    const requests: Array<{ method: string; pathname: string; body: string }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init: { method?: string; body?: string } = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      requests.push({ method, pathname: url.pathname, body: init.body ?? '' });
      const repoPath = `/repos/${repository}`;
      if (url.pathname === '/orgs/profiles-artifacts' && method === 'GET') return new Response('{}', { status: 404 });
      if (url.pathname === '/user/repos' && method === 'POST') {
        exists = true;
        return Response.json({ full_name: repository, clone_url: `file://${bare}`, private: true }, { status: 201 });
      }
      if (url.pathname === repoPath && method === 'GET') {
        if (!exists) return Response.json({ message: 'Not Found' }, { status: 404 });
        if (!defaultBranch) {
          // GitHub picks the first branch pushed into an empty repository. Bootstrap's
          // candidate branch precedes main, which is why the API must reconcile this.
          const refs = execFileSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { encoding: 'utf8' }).trim().split('\n');
          bootstrapBranch = refs.find((branch) => branch.startsWith('agent-run/bootstrap-')) ?? refs[0] ?? '';
          defaultBranch = bootstrapBranch;
        }
        return Response.json({ full_name: repository, private: true, default_branch: defaultBranch });
      }
      const branchPrefix = `${repoPath}/branches/`;
      if (url.pathname.startsWith(branchPrefix) && method === 'GET') {
        const branch = decodeURIComponent(url.pathname.slice(branchPrefix.length));
        return hasBranch(bare, branch) ? Response.json({ name: branch }) : Response.json({ message: 'Branch not found' }, { status: 404 });
      }
      if (url.pathname === repoPath && method === 'PATCH') {
        defaultBranch = (JSON.parse(init.body ?? '{}') as { default_branch: string }).default_branch;
        return Response.json({ full_name: repository, private: true, default_branch: defaultBranch });
      }
      return Response.json({ message: `Unexpected ${method} ${url.pathname}` }, { status: 500 });
    });

    const coordinator = createProfileWorkspaceCoordinator({
      rootDir: join(root, 'state'),
      owner: 'profiles-artifacts',
      token: 'fixture-token',
      objectBackend: 'local-fs',
      env: { STORAGE_LOCAL_ROOT: join(root, 'objects') },
    });

    // local-fs intentionally has no signed URL support. Reaching that final check proves
    // repository bootstrap and default-branch reconciliation completed first.
    await expect(coordinator.prepare({ principalId: 'p', tenantId: 'tenant-test', profileId: 'profile-test', scopes: [] }, 'run-test')).rejects.toThrow(/signed download URLs/);
    expect(defaultBranch).toBe('main');
    expect(requests.some((request) => request.method === 'PATCH' && request.pathname === `/repos/${repository}` && JSON.parse(request.body).default_branch === 'main')).toBe(true);
    expect(hasBranch(bare, 'main')).toBe(true);

    // Model an already-existing profile whose default drifted back to GitHub's original
    // bootstrap ref. A later run's prepare must repair it before snapshot delivery.
    defaultBranch = bootstrapBranch;
    await expect(coordinator.prepare({ principalId: 'p', tenantId: 'tenant-test', profileId: 'profile-test', scopes: [] }, 'run-repair')).rejects.toThrow(/signed download URLs/);
    expect(defaultBranch).toBe('main');
    expect(requests.filter((request) => request.method === 'PATCH' && request.pathname === `/repos/${repository}`)).toHaveLength(2);
  });
});
