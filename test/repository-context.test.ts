import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine } from '../src/adapters/engine/fake-engine.js';
import type { Principal } from '../src/api/auth.js';
import { ApiError } from '../src/api/errors.js';
import { AgentApi } from '../src/api/service.js';
import { validateRunSpec, type RunSpec } from '../src/contracts/run-spec.js';
import { isTerminalState } from '../src/runner/state-machine.js';
import { specHash } from '../src/runner/util.js';
import { buildRepositoryUrl, planClone, repositoryBaseUrl, resolveCloneSource } from '../src/runner/repository.js';
import { createHarness, removeDirWithRetry } from './helpers.js';
import {
  cleanupTempDirs,
  createBareRepo,
  createSourceRepo,
  makeTempDir,
  startAuthGitServer,
  type AuthGitServer,
} from './local-git-server.js';

const SECRET_TOKEN = 'ghs_repositoryContextToken0123456789abcdef';

const overriddenEnv = new Map<string, string | undefined>();
const openServers: AuthGitServer[] = [];

function setEnv(name: string, value: string): void {
  if (!overriddenEnv.has(name)) overriddenEnv.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(async () => {
  for (const [name, value] of overriddenEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  overriddenEnv.clear();
  for (const server of openServers.splice(0)) await server.close();
  cleanupTempDirs();
});

describe('repository: сборка источника клонирования', () => {
  it('url по умолчанию — github.com/owner/name.git, base переопределяется env', () => {
    delete process.env['RUNNER_REPOSITORY_BASE_URL'];
    expect(repositoryBaseUrl()).toBe('https://github.com');
    expect(buildRepositoryUrl('owner/name')).toBe('https://github.com/owner/name.git');
    setEnv('RUNNER_REPOSITORY_BASE_URL', 'http://127.0.0.1:9999/');
    expect(buildRepositoryUrl('owner/name')).toBe('http://127.0.0.1:9999/owner/name.git');
  });

  it('без repository берётся дефолтная репа, RUNNER_DEFAULT_REPO переопределяет её', () => {
    delete process.env['RUNNER_DEFAULT_REPO'];
    expect(resolveCloneSource(undefined)).toEqual({
      fullName: 'trained-assist/ai-agent-runner',
      url: 'https://github.com/trained-assist/ai-agent-runner.git',
    });
    setEnv('RUNNER_DEFAULT_REPO', 'other-owner/other-repo');
    expect(resolveCloneSource(undefined).url).toBe('https://github.com/other-owner/other-repo.git');
    setEnv('RUNNER_DEFAULT_REPO', '/tmp/local-fixture.git');
    expect(resolveCloneSource(undefined).url).toBe('/tmp/local-fixture.git');
  });

  it('argv clone никогда не содержит токен — только окружение GIT_ASKPASS-помошника', () => {
    const withoutToken = planClone({ fullName: 'owner/name', url: 'https://github.com/owner/name.git' }, '/tmp/ws');
    expect(withoutToken.args).toEqual(['clone', '--depth', '1', 'https://github.com/owner/name.git', '/tmp/ws']);
    expect(withoutToken.env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(JSON.stringify(withoutToken)).not.toContain(SECRET_TOKEN);

    const withToken = planClone(
      { fullName: 'owner/name', url: 'https://github.com/owner/name.git', token: SECRET_TOKEN },
      '/tmp/ws',
    );
    expect(JSON.stringify(withToken.args)).not.toContain(SECRET_TOKEN);
    expect(withToken.args.slice(0, 3)).toEqual(['-c', 'credential.helper=', 'clone']);
    expect(withToken.env['RUNNER_GIT_TOKEN']).toBe(SECRET_TOKEN);
    const tokenEnvKeys = Object.keys(withToken.env).filter((key) => withToken.env[key] === SECRET_TOKEN);
    expect(tokenEnvKeys).toEqual(['RUNNER_GIT_TOKEN']);
  });

  it('хэш спека не зависит от токена (дедуп переживает ротацию секрета)', () => {
    const base = {
      contractVersion: 1 as const,
      jobId: 'job-1',
      runId: 'run-1',
      operationId: 'op-1',
      userTaskId: 'task-1',
      profileId: 'profile-a',
      conversationId: 'conv-1',
      ownerGeneration: 1,
      engine: { name: 'fake', adapterVersion: '1' },
      cwd: '/tmp/ws/run-1',
      envAllowlist: [],
      limits: { timeoutMs: 5000 },
      repository: { fullName: 'owner/name', token: SECRET_TOKEN },
    };
    const validated = validateRunSpec(base);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(specHash(validated.value)).toBe(specHash({ ...base, repository: { fullName: 'owner/name', token: 'other-token' } }));
    expect(JSON.stringify(validated.value)).toContain(SECRET_TOKEN);
  });
});

describe('repository context: clone перед спавном движка', () => {
  it('repository с токеном: clone локального репозитория через git-сервер с Basic-auth, cwd движка = клон', async () => {
    const server = await startAuthGitServer({ repoName: 'owner/name', token: SECRET_TOKEN });
    openServers.push(server);
    setEnv('RUNNER_REPOSITORY_BASE_URL', server.baseUrl);

    const h = createHarness({ retainWorkspaces: true });
    const spec = h.makeSpec({ repository: { fullName: 'owner/name', token: SECRET_TOKEN } });
    const receipt = h.runner.start(spec);
    const result = await h.runner.waitFor(receipt.runId, 15000);

    expect(result.outcome).toBe('succeeded');
    expect(server.authorizedRequests).toBeGreaterThan(0);
    expect(existsSync(join(spec.cwd, 'source.txt'))).toBe(true);
    expect(existsSync(join(spec.cwd, '.git'))).toBe(true);

    const stateOnDisk = readFileSync(join(h.rootDir, 'runs', spec.runId, 'state.json'), 'utf8');
    const operationsOnDisk = readFileSync(join(h.rootDir, 'operations.json'), 'utf8');
    const visibleSurfaces = JSON.stringify({
      receipt,
      status: h.runner.getRun(receipt.runId),
      events: h.runner.events(receipt.runId),
      result,
      stateOnDisk,
      operationsOnDisk,
    });
    expect(visibleSurfaces).not.toContain(SECRET_TOKEN);
    expect(stateOnDisk).toContain('owner/name');
  });

  it('repository без токена: обычный clone file:// источника (публичный режим)', async () => {
    const rootDir = makeTempDir('ai-agent-runner-file-source-');
    const source = createSourceRepo('public.txt', 'public content\n');
    createBareRepo(source, join(rootDir, 'owner', 'name.git'));
    setEnv('RUNNER_REPOSITORY_BASE_URL', `file://${rootDir}`);

    const h = createHarness({ retainWorkspaces: true });
    const spec = h.makeSpec({ repository: { fullName: 'owner/name' } });
    const receipt = h.runner.start(spec);
    const result = await h.runner.waitFor(receipt.runId, 15000);

    expect(result.outcome).toBe('succeeded');
    expect(readFileSync(join(spec.cwd, 'public.txt'), 'utf8')).toContain('public content');
  });

  it('repository не передан → клон дефолтной репы из RUNNER_DEFAULT_REPO', async () => {
    const fixture = createSourceRepo('default-repo-marker.txt', 'default repo\n');
    setEnv('RUNNER_DEFAULT_REPO', fixture);

    const h = createHarness({ retainWorkspaces: true });
    const { receipt, spec } = h.start();
    const result = await h.runner.waitFor(receipt.runId, 15000);

    expect(result.outcome).toBe('succeeded');
    expect(spec.repository).toBeUndefined();
    expect(readFileSync(join(spec.cwd, 'default-repo-marker.txt'), 'utf8')).toContain('default repo');
  });

  it('repository — пустая группа {} → тоже дефолтная репа', async () => {
    const fixture = createSourceRepo('empty-group-marker.txt', 'empty group\n');
    setEnv('RUNNER_DEFAULT_REPO', fixture);

    const h = createHarness({ retainWorkspaces: true });
    const { receipt, spec } = h.start({ repository: {} as RunSpec['repository'] });
    const result = await h.runner.waitFor(receipt.runId, 15000);

    expect(result.outcome).toBe('succeeded');
    expect(readFileSync(join(spec.cwd, 'empty-group-marker.txt'), 'utf8')).toContain('empty group');
  });

  it('clone fail (несуществующий источник) → REPOSITORY_UNAVAILABLE, состояние failed, воркер жив', async () => {
    const missing = join(makeTempDir('ai-agent-runner-missing-'), 'no-such-repo.git');
    setEnv('RUNNER_DEFAULT_REPO', missing);

    const h = createHarness({ retainWorkspaces: true });
    const { receipt, spec } = h.start();
    const result = await h.runner.waitFor(receipt.runId, 15000);

    expect(result.outcome).toBe('failed');
    expect(result.exitReason).toBe('preflight_refused');
    expect(result.failure?.code).toBe('REPOSITORY_UNAVAILABLE');
    expect(result.failure?.safeSummary).toContain('clone');
    expect(h.runner.getRun(spec.runId)?.state).toBe('failed');
    const failedEvent = h.runner.events(receipt.runId).find((event) => event.type === 'failed');
    expect(failedEvent && failedEvent.type === 'failed' ? failedEvent.payload.code : '').toBe('REPOSITORY_UNAVAILABLE');
    expect(h.runner.health().ready).toBe(true);
  });

  it('clone с чужим токеном → REPOSITORY_UNAVAILABLE без ретраев и без утечки токена', async () => {
    const server = await startAuthGitServer({ repoName: 'owner/name', token: SECRET_TOKEN });
    openServers.push(server);
    setEnv('RUNNER_REPOSITORY_BASE_URL', server.baseUrl);

    const h = createHarness({ retainWorkspaces: true });
    const spec = h.makeSpec({ repository: { fullName: 'owner/name', token: 'wrong-token-should-be-rejected' } });
    const receipt = h.runner.start(spec);
    const result = await h.runner.waitFor(receipt.runId, 15000);

    expect(result.outcome).toBe('failed');
    expect(result.failure?.code).toBe('REPOSITORY_UNAVAILABLE');
    expect(result.failure?.retryable).toBe(false);
    expect(JSON.stringify({ result, events: h.runner.events(receipt.runId) })).not.toContain('wrong-token-should-be-rejected');
  });
});

interface ApiHarnessLite {
  api: AgentApi;
  rootDir: string;
  logs: Record<string, unknown>[];
}

const alpha: Principal = { principalId: 'p-alpha', profileId: 'profile-a', scopes: ['runs:read', 'runs:write'], engines: ['fake'] };

function createApiLite(): ApiHarnessLite {
  const rootDir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-repository-api-'));
  const logs: Record<string, unknown>[] = [];
  const api = new AgentApi({
    rootDir,
    adapters: { fake: new FakeEngine('success') },
    host: { region: 'sandbox-eu', environment: 'sandbox' },
    cancelGraceMs: 500,
    logger: (entry) => logs.push(entry),
  });
  onTestFinished(async () => {
    for (const runId of api.runner.listRunIds()) {
      const snapshot = api.runner.getRun(runId);
      if (snapshot && !isTerminalState(snapshot.state)) {
        try {
          await api.runner.cancel(runId, snapshot.ownerGeneration);
        } catch {
          // финальная уборка убивает дерево ниже
        }
      }
    }
    api.dispose();
    await removeDirWithRetry(rootDir);
  });
  return { api, rootDir, logs };
}

function submitBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: { name: 'fake', adapterVersion: '1' },
    limits: { timeoutMs: 15000 },
    input: { inlinePrompt: 'repository context' },
    ...over,
  };
}

describe('repository context: API', () => {
  it('кривой fullName и пустой токен → 400 INVALID_REPOSITORY', () => {
    const { api } = createApiLite();
    for (const repository of [{ fullName: 'owner' }, { fullName: 'a/b/c' }, { fullName: '../escape' }, { fullName: 'a/b', token: '' }]) {
      let thrown: ApiError | null = null;
      try {
        api.submit(alpha, `idem-bad-${JSON.stringify(repository)}`, submitBody({ repository }));
      } catch (err) {
        thrown = err as ApiError;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      expect(thrown?.code).toBe('INVALID_REPOSITORY');
      expect(thrown?.status).toBe(400);
    }
  });

  it('токен из submit не попадает ни в receipt, status, events, result, логи, state/admissions', async () => {
    const server = await startAuthGitServer({ repoName: 'owner/name', token: SECRET_TOKEN });
    openServers.push(server);
    setEnv('RUNNER_REPOSITORY_BASE_URL', server.baseUrl);
    const { api, rootDir, logs } = createApiLite();

    const receipt = api.submit(alpha, 'idem-repository-secret', submitBody({ repository: { fullName: 'owner/name', token: SECRET_TOKEN } }));
    const result = await api.runner.waitFor(receipt.runId, 15000);
    const status = api.status(alpha, receipt.runId);
    const events = api.events(alpha, receipt.runId);

    expect(result.outcome).toBe('succeeded');
    const admissionsOnDisk = readFileSync(join(rootDir, 'api', 'admissions.json'), 'utf8');
    const stateOnDisk = readFileSync(join(rootDir, 'runs', receipt.runId, 'state.json'), 'utf8');
    const dump = JSON.stringify({ receipt, status, events, result, logs, admissionsOnDisk, stateOnDisk });
    expect(dump).not.toContain(SECRET_TOKEN);
    expect(admissionsOnDisk).toContain('"owner/name"');
    expect(stateOnDisk).toContain('"owner/name"');
  });

  it('тот же Idempotency-Key с другим токеном = дедуп, а не IDEMPOTENCY_CONFLICT', async () => {
    const server = await startAuthGitServer({ repoName: 'owner/name', token: SECRET_TOKEN });
    openServers.push(server);
    setEnv('RUNNER_REPOSITORY_BASE_URL', server.baseUrl);
    const { api } = createApiLite();

    const first = api.submit(alpha, 'idem-rotated-token', submitBody({ repository: { fullName: 'owner/name', token: SECRET_TOKEN } }));
    const second = api.submit(alpha, 'idem-rotated-token', submitBody({ repository: { fullName: 'owner/name', token: 'other-token-9999' } }));
    expect(second.deduplicated).toBe(true);
    expect(second.runId).toBe(first.runId);
    await api.runner.waitFor(first.runId, 15000);
  });

  it('пустая группа repository в submit = дефолтная репа (валидация пропускает)', async () => {
    const fixture = createSourceRepo('api-default-marker.txt', 'api default\n');
    setEnv('RUNNER_DEFAULT_REPO', fixture);
    const { api } = createApiLite();

    const receipt = api.submit(alpha, 'idem-empty-repository', submitBody({ repository: {} }));
    const result = await api.runner.waitFor(receipt.runId, 15000);
    expect(result.outcome).toBe('succeeded');
  });
});
