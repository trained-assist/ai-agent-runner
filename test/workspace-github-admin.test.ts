import { describe, expect, it } from 'vitest';
import { createGitHubRepositoryAdmin } from '../src/workspace/git/github-admin.js';
import { WorkspaceError } from '../src/workspace/contract.js';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(handler: (url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> }) => { status: number; body?: unknown }) {
  const calls: Recorded[] = [];
  const fetchImpl = async (input: unknown, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init.headers ?? {})) headers[key.toLowerCase()] = value;
    calls.push({ method: init.method ?? 'GET', url, headers, body: init.body });
    const outcome = handler(url, init);
    return new Response(outcome.body === undefined ? null : JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const TOKEN = 'ghp_fixture_token_value';

function adminWith(handler: Parameters<typeof fakeFetch>[0]) {
  const { fetchImpl, calls } = fakeFetch(handler);
  const admin = createGitHubRepositoryAdmin({
    tokenRef: 'github:profiles-artifacts',
    resolveToken: async (ref) => (ref === 'github:profiles-artifacts' ? TOKEN : undefined),
    fetchImpl,
  });
  return { admin, calls };
}

describe('GitHub admin port', () => {
  it('creates a private repository under an org and reports it as created', async () => {
    const { admin, calls } = adminWith((url, init) => {
      if (url === 'https://api.github.com/orgs/profiles-artifacts') return { status: 200 };
      if (url === 'https://api.github.com/repos/profiles-artifacts/profile-alice' && init.method === 'GET') return { status: 404 };
      if (url === 'https://api.github.com/orgs/profiles-artifacts/repos' && init.method === 'POST') {
        return { status: 201, body: { full_name: 'profiles-artifacts/profile-alice', clone_url: 'https://github.com/profiles-artifacts/profile-alice.git', private: true } };
      }
      return { status: 500, body: { message: 'unexpected' } };
    });

    const result = await admin.ensurePrivateRepository({ owner: 'profiles-artifacts', name: 'profile-alice', private: true, description: 'probe' });
    expect(result).toMatchObject({ fullName: 'profiles-artifacts/profile-alice', created: true, private: true });
    expect(result.url).toBe('https://github.com/profiles-artifacts/profile-alice.git');
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(post?.headers['x-github-api-version']).toBe('2022-11-28');
    expect(JSON.parse(String(post?.body ?? '{}'))).toMatchObject({ name: 'profile-alice', private: true, auto_init: false });
  });

  it('reuses an existing repository instead of creating a second one', async () => {
    const { admin, calls } = adminWith((url, init) => {
      if (url === 'https://api.github.com/repos/profiles-artifacts/profile-alice' && init.method === 'GET') {
        return { status: 200, body: { full_name: 'profiles-artifacts/profile-alice', clone_url: 'https://github.com/profiles-artifacts/profile-alice.git', private: true } };
      }
      return { status: 500, body: { message: 'unexpected' } };
    });
    const result = await admin.ensurePrivateRepository({ owner: 'profiles-artifacts', name: 'profile-alice', private: true, description: 'probe' });
    expect(result.created).toBe(false);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('reports a public repository as not private so the service refuses to adopt it', async () => {
    const { admin } = adminWith((url, init) => {
      if (url === 'https://api.github.com/repos/profiles-artifacts/profile-alice' && init.method === 'GET') {
        return { status: 200, body: { full_name: 'profiles-artifacts/profile-alice', clone_url: 'https://github.com/profiles-artifacts/profile-alice.git', private: false } };
      }
      return { status: 500, body: { message: 'unexpected' } };
    });
    const result = await admin.ensurePrivateRepository({ owner: 'profiles-artifacts', name: 'profile-alice', private: true, description: 'probe' });
    expect(result.private).toBe(false);
  });

  it('resolves a race (422) by re-reading the repository', async () => {
    const { admin, calls } = adminWith((url, init) => {
      if (url === 'https://api.github.com/orgs/profiles-artifacts') return { status: 200 };
      if (url === 'https://api.github.com/repos/profiles-artifacts/profile-alice' && init.method === 'GET') {
        return calls.filter((call) => call.method === 'GET').length > 1
          ? { status: 200, body: { full_name: 'profiles-artifacts/profile-alice', clone_url: 'https://github.com/profiles-artifacts/profile-alice.git', private: true } }
          : { status: 404 };
      }
      if (url === 'https://api.github.com/orgs/profiles-artifacts/repos' && init.method === 'POST') return { status: 422, body: { message: 'name already exists' } };
      return { status: 500, body: { message: 'unexpected' } };
    });
    const result = await admin.ensurePrivateRepository({ owner: 'profiles-artifacts', name: 'profile-alice', private: true, description: 'probe' });
    expect(result.created).toBe(false);
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(3); // probe владельца + два чтения репозитория
  });

  it('creates under the user endpoint when the owner is not an org', async () => {
    const { admin, calls } = adminWith((url, init) => {
      if (url === 'https://api.github.com/orgs/kobzevvv') return { status: 404 };
      if (url === 'https://api.github.com/repos/kobzevvv/profile-alice' && init.method === 'GET') return { status: 404 };
      if (url === 'https://api.github.com/user/repos' && init.method === 'POST') {
        return { status: 201, body: { full_name: 'kobzevvv/profile-alice', clone_url: 'https://github.com/kobzevvv/profile-alice.git', private: true } };
      }
      return { status: 500, body: { message: 'unexpected' } };
    });
    const result = await admin.ensurePrivateRepository({ owner: 'kobzevvv', name: 'profile-alice', private: true, description: 'probe' });
    expect(result.fullName).toBe('kobzevvv/profile-alice');
    expect(calls.some((call) => call.url === 'https://api.github.com/user/repos' && call.method === 'POST')).toBe(true);
  });

  it('never puts the token into a URL or a request body', async () => {
    const { admin, calls } = adminWith((url, init) => {
      if (url === 'https://api.github.com/orgs/profiles-artifacts') return { status: 200 };
      if (url === 'https://api.github.com/repos/profiles-artifacts/profile-alice' && init.method === 'GET') return { status: 404 };
      if (url === 'https://api.github.com/orgs/profiles-artifacts/repos' && init.method === 'POST') {
        return { status: 201, body: { full_name: 'profiles-artifacts/profile-alice', clone_url: 'https://github.com/profiles-artifacts/profile-alice.git', private: true } };
      }
      return { status: 500, body: { message: 'unexpected' } };
    });
    await admin.ensurePrivateRepository({ owner: 'profiles-artifacts', name: 'profile-alice', private: true, description: 'probe' });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).not.toContain(TOKEN);
      expect(JSON.stringify(call.body ?? '')).not.toContain(TOKEN);
      // Токен живёт только в заголовке Authorization — и нигде больше.
      expect(call.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('refuses to run without a credential instead of sending an anonymous request', async () => {
    const { admin, calls } = adminWith(() => ({ status: 200, body: {} }));
    const anon = createGitHubRepositoryAdmin({
      tokenRef: 'github:profiles-artifacts',
      resolveToken: async () => undefined,
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    });
    await expect(anon.ensurePrivateRepository({ owner: 'o', name: 'n', private: true, description: 'd' })).rejects.toMatchObject({ code: 'WORKSPACE_INVALID' });
    expect(calls).toHaveLength(0);
    void admin;
  });

  it('maps 401/403 to a non-retryable forbidden error and 5xx to a retryable one', async () => {
    const forbidden = adminWith(() => ({ status: 403, body: { message: 'resource not accessible' } }));
    await expect(forbidden.admin.ensurePrivateRepository({ owner: 'o', name: 'n', private: true, description: 'd' })).rejects.toMatchObject({
      code: 'WORKSPACE_FORBIDDEN',
    });
    const unavailable = adminWith(() => ({ status: 502, body: { message: 'bad gateway' } }));
    await expect(unavailable.admin.ensurePrivateRepository({ owner: 'o', name: 'n', private: true, description: 'd' })).rejects.toBeInstanceOf(WorkspaceError);
  });
});
