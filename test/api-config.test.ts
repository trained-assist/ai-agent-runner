import { describe, expect, it } from 'vitest';
import { loadAgentApiConfig } from '../src/api/config.js';

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
  it('одиночный EXTERNAL_WORKER_URL остаётся рабочим и отвечает дефолтному движку', () => {
    const config = loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'https://worker.example', EXTERNAL_WORKER_TOKEN: 'secret' });
    expect(config.workers).toEqual([
      {
        engine: 'azure-dynamic-ip-agent-run',
        baseUrl: 'https://worker.example',
        token: 'secret',
        launchDeadlineMs: 600000,
        acceptDeadlineMs: 30000,
        cancelDeadlineMs: 30000,
      },
    ]);
    expect(config.engineChain).toBeNull();
  });

  it('AGENT_API_WORKERS задаёт несколько движков, у каждого свой воркер', () => {
    const config = loadAgentApiConfig({
      ...base,
      AGENT_API_WORKERS: JSON.stringify([
        { engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://gha.example', token: 'a' },
        { engine: 'eu-vm-agent-run', baseUrl: 'https://eu.example', token: 'b' },
      ]),
    });
    expect(config.workers.map((worker) => worker.engine)).toEqual(['azure-dynamic-ip-agent-run', 'eu-vm-agent-run']);
    expect(config.workers.map((worker) => worker.baseUrl)).toEqual(['https://gha.example', 'https://eu.example']);
  });

  it('имя движка можно переопределить и в одиночном формате', () => {
    const config = loadAgentApiConfig({
      ...base,
      EXTERNAL_WORKER_URL: 'https://receiver.example',
      EXTERNAL_WORKER_ENGINE: 'eu-vm-agent-run',
    });
    expect(config.workers[0]!.engine).toBe('eu-vm-agent-run');
  });

  it('без воркера — отказ на старте: API без способа запустить агента не поднимается', () => {
    expect(() => loadAgentApiConfig({ ...base })).toThrowError(/no external worker configured/);
  });

  it('один движок дважды — отказ: запрос не должен угадывать, куда идти', () => {
    expect(() =>
      loadAgentApiConfig({
        ...base,
        AGENT_API_WORKERS: JSON.stringify([
          { engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://a.example' },
          { engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://b.example' },
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

  it('AGENT_API_ENGINE_CHAIN задаёт порядок проб, а не сортировку имён', () => {
    const config = loadAgentApiConfig({
      ...base,
      AGENT_API_WORKERS: JSON.stringify([
        { engine: 'rf-vm-agent-run', baseUrl: 'https://rf.example', token: 'c' },
        { engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://gha.example', token: 'a' },
        { engine: 'eu-vm-agent-run', baseUrl: 'https://eu.example', token: 'b' },
      ]),
      AGENT_API_ENGINE_CHAIN: 'azure-dynamic-ip-agent-run,eu-vm-agent-run,rf-vm-agent-run',
    });
    expect(config.engineChain).toEqual(['azure-dynamic-ip-agent-run', 'eu-vm-agent-run', 'rf-vm-agent-run']);
  });

  it('бюджет приёма рана свой у каждого движка, общий — из EXTERNAL_WORKER_ACCEPT_DEADLINE_MS', () => {
    const config = loadAgentApiConfig({
      ...base,
      AGENT_API_WORKERS: JSON.stringify([
        { engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://gha.example', acceptDeadlineMs: 30000 },
        { engine: 'eu-vm-agent-run', baseUrl: 'https://eu.example' },
      ]),
      EXTERNAL_WORKER_ACCEPT_DEADLINE_MS: '120000',
    });
    expect(config.workers.map((worker) => worker.acceptDeadlineMs)).toEqual([30000, 120000]);
  });

  it('движок цепочки без воркера — отказ на старте, а не падение рана на середине цепочки', () => {
    expect(() =>
      loadAgentApiConfig({
        ...base,
        AGENT_API_WORKERS: JSON.stringify([{ engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://gha.example' }]),
        AGENT_API_ENGINE_CHAIN: 'azure-dynamic-ip-agent-run,rf-vm-agent-run',
      }),
    ).toThrowError(/has no worker/);
  });

  it('бюджет reconcile читается из env: мёртвый движок не вешает проверку на таймаут запуска', () => {
    const config = loadAgentApiConfig({
      ...base,
      EXTERNAL_WORKER_URL: 'https://worker.example',
      EXTERNAL_WORKER_RECONCILE_DEADLINE_MS: '2500',
    });
    expect(config.reconcileDeadlineMs).toBe(2500);
  });

  it('публичный адрес API читается из AGENT_API_PUBLIC_URL', () => {
    const config = loadAgentApiConfig({ ...base, EXTERNAL_WORKER_URL: 'https://worker.example', AGENT_API_PUBLIC_URL: 'https://api.example' });
    expect(config.publicUrl).toBe('https://api.example');
  });

  it('цепочка без воркеров не объявляется: ран идёт на названный клиентом движок', () => {
    const config = loadAgentApiConfig({
      ...base,
      AGENT_API_WORKERS: JSON.stringify([{ engine: 'azure-dynamic-ip-agent-run', baseUrl: 'https://gha.example' }]),
    });
    expect(config.engineChain).toBeNull();
  });
});
