/**
 * Реализация административного порта для GitHub.
 *
 * Единственное место, где модуль обращается к GitHub API: создание приватного репозитория
 * профиля. Организационный credential остаётся у хоста — порт получает его через
 * резолвер и кладёт только в HTTP-заголовок `Authorization`. Токен не попадает ни в URL,
 * ни в тело запроса, ни в журнал, ни в сообщения об ошибках.
 *
 * Идемпотентность — та же, что у legacy `scripts/profile-repo.mjs`: повторный вызов не
 * создаёт второй репозиторий, а гонка с параллельным созданием (422) разрешается повторным
 * чтением. Отличие от legacy: порт не принимает существующий публичный репозиторий и не
 * принимает репозиторий с чужим маркером — это решение сервиса (см. `assertRepositoryOwnership`).
 */

import { WorkspaceError } from '../contract.js';
import type { CredentialResolver, RepositoryAdminPort } from '../ports.js';
import { isTransientFailure, sleep, RETRY_DELAYS_MS } from './transient.js';

export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';

export interface GitHubRepositoryAdminOptions {
  /** Резолвер credential'а хоста: tokenRef → токен. Значение уходит только в заголовок. */
  resolveToken: CredentialResolver;
  /** Ссылка на credential для этого вызова. */
  tokenRef: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface RepoInfo {
  fullName: string;
  url: string;
  created: boolean;
  private: boolean;
}

export function createGitHubRepositoryAdmin(options: GitHubRepositoryAdminOptions): RepositoryAdminPort {
  const baseUrl = (options.baseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let ownerKind: 'org' | 'user' | null = null;

  /**
   * Запрос с повторами для транзиентных сбоев. Сетевой обрыв («fetch failed»,
   * «Connection reset», 5xx) повторяется с backoff; 401/403 и «not found» — нет: повтор
   * не поможет, а только задержит честную ошибку.
   */
  const request = async (pathname: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; json: () => Promise<unknown> }> => {
    if (typeof fetchImpl !== 'function') {
      throw new WorkspaceError('WORKSPACE_INVALID', 'GitHub admin port requires fetch (Node ≥ 18)', { retryable: false });
    }
    const token = await options.resolveToken(options.tokenRef);
    if (!token) {
      throw new WorkspaceError('WORKSPACE_INVALID', 'the GitHub admin port has no credential for the requested tokenRef', { retryable: false });
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let lastError: string | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${pathname}`, {
          method: init.method ?? 'GET',
          headers,
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (!isTransientFailure(lastError, false) || attempt === RETRY_DELAYS_MS.length) break;
        await sleep(RETRY_DELAYS_MS[attempt] as number);
        continue;
      }
      // Транзиентный HTTP-статус тоже повторяем: 502/503/504 и обрыв соединения.
      const transientStatus = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
      if (!transientStatus) return { status: response.status, json: () => response.json().catch(() => ({})) };
      lastError = `HTTP ${response.status}`;
      if (attempt === RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempt] as number);
    }
    throw new WorkspaceError(
      'WORKSPACE_GIT_FAILED',
      `GitHub API is unreachable for ${init.method ?? 'GET'} ${pathname}: ${lastError ?? 'no response'}`,
      { retryable: true },
    );
  };

  const readRepo = async (owner: string, name: string): Promise<RepoInfo | null> => {
    const response = await request(`/repos/${owner}/${name}`);
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw apiError('GET', `/repos/${owner}/${name}`, response.status, await response.json());
    }
    const info = (await response.json()) as { full_name?: unknown; clone_url?: unknown; html_url?: unknown; private?: unknown };
    if (typeof info.full_name !== 'string') {
      throw new WorkspaceError('WORKSPACE_GIT_FAILED', `GitHub returned a repository without full_name for ${owner}/${name}`, { retryable: true });
    }
    return {
      fullName: info.full_name,
      // clone_url, а не html_url: binding.url используется как remote для git-зеркала.
      url: typeof info.clone_url === 'string' ? info.clone_url : (typeof info.html_url === 'string' ? info.html_url : `${baseUrl}/${info.full_name}`),
      created: false,
      private: info.private === true,
    };
  };

  const createRepo = async (owner: string, name: string, description: string): Promise<RepoInfo> => {
    if (ownerKind === null) {
      const probe = await request(`/orgs/${owner}`);
      // Угадывать тип владельца нельзя: при сбое пробы мы бы создали репозиторий не там.
      // 200 → организация, 404 → личный аккаунт, всё остальное — ошибка.
      if (probe.status === 200) ownerKind = 'org';
      else if (probe.status === 404) ownerKind = 'user';
      else throw apiError('GET', `/orgs/${owner}`, probe.status, await probe.json());
    }
    const pathname = ownerKind === 'org' ? `/orgs/${owner}/repos` : '/user/repos';
    const response = await request(pathname, {
      method: 'POST',
      body: { name, private: true, description, has_issues: false, has_projects: false, has_wiki: false, auto_init: false },
    });
    if (response.status === 201) {
      const info = (await response.json()) as { full_name?: unknown; clone_url?: unknown; private?: unknown };
      if (typeof info.full_name !== 'string') {
        throw new WorkspaceError('WORKSPACE_GIT_FAILED', `GitHub created ${owner}/${name} but returned no full_name`, { retryable: true });
      }
      return {
        fullName: info.full_name,
        url: typeof info.clone_url === 'string' ? info.clone_url : `${baseUrl}/${info.full_name}`,
        created: true,
        private: info.private === true,
      };
    }
    if (response.status === 422) {
      // Имя занято: гонка с параллельным созданием или репозиторий уже существует. Повторное
      // чтение — идемпотентный no-op, а не ошибка: иначе два параллельных ensure дали бы
      // один репозиторий и одну ошибку.
      const existing = await readRepo(owner, name);
      if (existing) return existing;
    }
    throw apiError('POST', pathname, response.status, await response.json());
  };

  return {
    async ensurePrivateRepository(input) {
      const existing = await readRepo(input.owner, input.name);
      if (existing) return existing;
      return createRepo(input.owner, input.name, input.description);
    },
    async setDefaultBranch(input) {
      const parts = input.repository.split('/');
      if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part)) || !/^[A-Za-z0-9._/-]+$/.test(input.branch) || input.branch.startsWith('/') || input.branch.endsWith('/')) {
        throw new WorkspaceError('WORKSPACE_INVALID', 'GitHub default branch update requires an owner/repository and a valid branch name', { retryable: false });
      }
      const [owner, name] = parts as [string, string];
      const repoPath = `/repos/${owner}/${name}`;
      const repoResponse = await request(repoPath);
      if (repoResponse.status !== 200) {
        throw apiError('GET', repoPath, repoResponse.status, await repoResponse.json());
      }
      const repo = (await repoResponse.json()) as { full_name?: unknown; private?: unknown; default_branch?: unknown };
      if (repo.full_name !== input.repository || repo.private !== true) {
        throw new WorkspaceError('WORKSPACE_REPOSITORY_NOT_PRIVATE', `repository ${input.repository} is not the expected private profile repository`, { retryable: false });
      }
      if (repo.default_branch === input.branch) return;

      const branchPath = `${repoPath}/branches/${encodeURIComponent(input.branch)}`;
      const branchResponse = await request(branchPath);
      if (branchResponse.status !== 200) {
        throw apiError('GET', branchPath, branchResponse.status, await branchResponse.json());
      }

      const response = await request(repoPath, { method: 'PATCH', body: { default_branch: input.branch } });
      if (response.status !== 200) {
        throw apiError('PATCH', repoPath, response.status, await response.json());
      }
    },
  };
}

function apiError(method: string, pathname: string, status: number, payload: unknown): WorkspaceError {
  const message = (payload as { message?: unknown } | null)?.message;
  const detail = typeof message === 'string' ? message : 'no detail from GitHub';
  const retryable = status === 403 || status === 401 ? false : status >= 500;
  const code = status === 403 || status === 401 ? 'WORKSPACE_FORBIDDEN' : 'WORKSPACE_GIT_FAILED';
  return new WorkspaceError(code, `GitHub ${method} ${pathname} → ${status}: ${detail}`, { retryable });
}
