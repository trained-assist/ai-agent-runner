import { describe, expect, it } from 'vitest';
import { createExternalWorkers, loadAgentApiConfig } from '../src/api/config.js';
import type { RunSpec } from '../src/contracts/run-spec.js';

/**
 * Конфигурация воркеров — это и есть способ подключить движок. Тест закрепляет оба формата:
 * одиночный `EXTERNAL_WORKER_URL` (обратная совместимость) и список `AGENT_API_WORKERS`
 * (несколько движков, включая раннер на GitHub Actions).
 */

const base = {
  AGENT_API_KEY_REGISTRY: '/etc/agent-runner/key-registry.json',
  AGENT_API_PORT: '8787',
};

describe('конфигурация воркеров', () => {
  it('public callback URL reaches every worker without entering the run env pool', () => {
    const config = loadAgentApiConfig({
      ...base,
      AGENT_API_PUBLIC_URL: ' https://runner.example/sandbox/ ',
      AGENT_API_WORKERS: JSON.stringify([
        { engine: 'dynamic-ip-azure-agent-run', baseUrl: 'https://azure.example', token: 'a' },
        { engine: 'github-actions-agent-run', baseUrl: 'https://receiver.example', token: 'b' },
      ]),
    });
    expect(config.publicUrl).toBe('https://runner.example/sandbox/');
    expect(config.env).toEqual({});
    const spec = { runId: 'run-callback' } as RunSpec;
    for (const worker of createExternalWorkers(config)) {
      expect(worker.resultUrlFor(spec)).toBe('https://runner.example/sandbox/v1/worker/launches/run-callback/result');
    }
  });

  it.each([undefined, '   '])('missing public callback URL retains the existing preflight refusal (%s)', (publicUrl) => {
    const config = loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'https://worker.example', AGENT_API_PUBLIC_URL: publicUrl });
    expect(config.publicUrl).toBeNull();
    expect(() => createExternalWorkers(config)[0]!.resultUrlFor({ runId: 'run-callback' } as RunSpec)).toThrowError(/does not know its own public URL/);
  });

  it('allows an explicitly configured HTTP sandbox callback', () => {
    const config = loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'https://worker.example', AGENT_API_PUBLIC_URL: 'http://runner.example:18878' });
    expect(createExternalWorkers(config)[0]!.resultUrlFor({ runId: 'run-callback' } as RunSpec)).toBe('http://runner.example:18878/v1/worker/launches/run-callback/result');
  });

  it.each(['not-a-url', 'ftp://runner.example', 'https://user:secret@runner.example', 'https://runner.example?token=secret', 'https://runner.example#fragment'])('rejects invalid callback configuration without echoing its value (%s)', (publicUrl) => {
    const load = () => loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'https://worker.example', AGENT_API_PUBLIC_URL: publicUrl });
    expect(load).toThrowError('AGENT_API_PUBLIC_URL: expected an absolute http(s) URL without credentials, query, or fragment');
    try {
      load();
    } catch (error) {
      expect((error as Error).message).not.toContain(publicUrl);
    }
  });

  it('одиночный EXTERNAL_WORKER_URL остаётся рабочим и отвечает дефолтному движку', () => {
    const config = loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'https://worker.example', EXTERNAL_WORKER_TOKEN: 'secret' });
    expect(config.workers).toEqual([
      {
        engine: 'dynamic-ip-azure-agent-run',
        baseUrl: 'https://worker.example',
        token: 'secret',
        launchDeadlineMs: 600000,
        cancelDeadlineMs: 30000,
      },
    ]);
  });

  it('AGENT_API_WORKERS задаёт несколько движков, у каждого свой воркер', () => {
    const config = loadAgentApiConfig({
      ...base,
      AGENT_API_WORKERS: JSON.stringify([
        { engine: 'dynamic-ip-azure-agent-run', baseUrl: 'https://azure.example', token: 'a' },
        { engine: 'github-actions-agent-run', baseUrl: 'https://receiver.example', token: 'b' },
      ]),
    });
    expect(config.workers.map((worker) => worker.engine)).toEqual(['dynamic-ip-azure-agent-run', 'github-actions-agent-run']);
    expect(config.workers.map((worker) => worker.baseUrl)).toEqual(['https://azure.example', 'https://receiver.example']);
  });

  it('имя движка можно переопределить и в одиночном формате', () => {
    const config = loadAgentApiConfig({
      ...base,
      EXTERNAL_WORKER_URL: 'https://receiver.example',
      EXTERNAL_WORKER_ENGINE: 'github-actions-agent-run',
    });
    expect(config.workers[0]!.engine).toBe('github-actions-agent-run');
  });

  it('без воркера — отказ на старте: API без способа запустить агента не поднимается', () => {
    expect(() => loadAgentApiConfig({ ...base })).toThrowError(/no external worker configured/);
  });

  it('один движок дважды — отказ: запрос не должен угадывать, куда идти', () => {
    expect(() =>
      loadAgentApiConfig({
        ...base,
        AGENT_API_WORKERS: JSON.stringify([
          { engine: 'github-actions-agent-run', baseUrl: 'https://a.example' },
          { engine: 'github-actions-agent-run', baseUrl: 'https://b.example' },
        ]),
      }),
    ).toThrowError(/declared twice/);
  });

  it('не http(s) URL воркера — отказ до старта', () => {
    expect(() => loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'ftp://worker.example' })).toThrowError(/http\(s\)/);
  });

  it('таймауты воркера читаются из env и применяются ко всем движкам', () => {
    const config = loadAgentApiConfig({
      ...base,
      EXTERNAL_WORKER_URL: 'https://worker.example',
      EXTERNAL_WORKER_LAUNCH_DEADLINE_MS: '120000',
      EXTERNAL_WORKER_CANCEL_DEADLINE_MS: '5000',
    });
    expect(config.workers[0]).toMatchObject({ launchDeadlineMs: 120000, cancelDeadlineMs: 5000 });
  });

  it('пул окружения и репозиторий по умолчанию разбираются из env', () => {
    const config = loadAgentApiConfig({
      ...base,
      EXTERNAL_WORKER_URL: 'https://worker.example',
      AGENT_API_ENV: JSON.stringify({ PATH: '/usr/bin', LANG: 'C.UTF-8' }),
      RUNNER_DEFAULT_REPO: 'org/default-repo',
    });
    expect(config.env).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8' });
    expect(config.defaultRepository).toBe('org/default-repo');
  });

  it('кривой JSON в AGENT_API_WORKERS — отказ с понятной причиной, а не падение позже', () => {
    expect(() => loadAgentApiConfig({ ...base, AGENT_API_WORKERS: '{ nope' })).toThrowError(/JSON array/);
    expect(() => loadAgentApiConfig({ ...base, AGENT_API_WORKERS: '[]' })).toThrowError(/non-empty/);
  });
});
