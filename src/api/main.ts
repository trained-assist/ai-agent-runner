import { statSync } from 'node:fs';
import { createServer } from 'node:http';
import {
  DEFAULT_CANCEL_DEADLINE_MS,
  DEFAULT_LAUNCH_DEADLINE_MS,
  ExternalWorkerAdapter,
} from '../adapters/external-worker-adapter.js';
import { KeyRegistry } from './auth.js';
import { createAgentApiServer } from './server.js';
import { AgentApi, type ApiLogger } from './service.js';

export const DEFAULT_API_PORT = 8787;
export const DEFAULT_API_HOST = '0.0.0.0';

/**
 * Конфигурация процесса (epic #74). Ни `dataDir`, ни release manifest, ни ключей к состоянию
 * на диске: у сервеless-оркестратора их просто нет. Единственный секрет — общий токен воркера,
 * он приходит из окружения.
 */
export interface AgentApiProcessConfig {
  host: string;
  port: number;
  keyRegistryPath: string;
  worker: {
    baseUrl: string;
    token: string;
    launchDeadlineMs: number;
    cancelDeadlineMs: number;
  };
  /** Пулы значений окружения, которые можно передать воркеру (по envAllowlist рана). */
  env: Record<string, string>;
  /** Репозиторий по умолчанию, когда клиент не объявил `repository` (воркер клонирует его сам). */
  defaultRepository: string | null;
}

function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function intEnv(name: string, fallback: number): number {
  const raw = envValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name}: expected a positive integer, got "${raw}"`);
  }
  return value;
}

/** `AGENT_API_ENV='{"PATH":"/usr/bin","LANG":"C.UTF-8"}'` — значения, отдаваемые воркеру. */
function parseEnvPool(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AGENT_API_ENV: expected a JSON object of environment name → value');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('AGENT_API_ENV: expected a JSON object of environment name → value');
  }
  const pool: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error(`AGENT_API_ENV.${name}: expected a string value`);
    pool[name] = value;
  }
  return pool;
}

export function loadAgentApiConfig(env: Record<string, string | undefined> = process.env): AgentApiProcessConfig {
  const portRaw = env['AGENT_API_PORT']?.trim() || String(DEFAULT_API_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`AGENT_API_PORT: expected an integer in [1, 65535], got "${portRaw}"`);
  }

  const keyRegistryPath = env['AGENT_API_KEY_REGISTRY']?.trim();
  if (!keyRegistryPath) {
    throw new Error('AGENT_API_KEY_REGISTRY is required: path to a mode-0600 key registry JSON file with a principals array');
  }

  // ТЗ внешнего воркера (docs/TZ-EXTERNAL-OPENCODE-WORKER.md §10.2) называет переменные
  // DYNAMIC_IP_AZURE_*, epic #74 — EXTERNAL_WORKER_*. Принимаем оба имени, второе приоритетнее.
  const baseUrl = env['EXTERNAL_WORKER_URL']?.trim() || env['DYNAMIC_IP_AZURE_URL']?.trim();
  if (!baseUrl) {
    throw new Error('EXTERNAL_WORKER_URL is required: base URL of the external worker that launches the agent');
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error(`EXTERNAL_WORKER_URL: expected an http(s) URL, got "${baseUrl}"`);
  }
  const token = env['EXTERNAL_WORKER_TOKEN']?.trim() || env['DYNAMIC_IP_AZURE_TOKEN']?.trim() || '';

  return {
    host: env['AGENT_API_HOST']?.trim() || DEFAULT_API_HOST,
    port,
    keyRegistryPath,
    worker: {
      baseUrl,
      token,
      launchDeadlineMs: intEnv('EXTERNAL_WORKER_LAUNCH_DEADLINE_MS', DEFAULT_LAUNCH_DEADLINE_MS),
      cancelDeadlineMs: intEnv('EXTERNAL_WORKER_CANCEL_DEADLINE_MS', DEFAULT_CANCEL_DEADLINE_MS),
    },
    env: parseEnvPool(env['AGENT_API_ENV']),
    defaultRepository: env['RUNNER_DEFAULT_REPO']?.trim() || null,
  };
}

function requireKeyRegistry(path: string): KeyRegistry {
  try {
    statSync(path);
  } catch {
    throw new Error(`key registry not found: ${path}`);
  }
  const registry = KeyRegistry.loadFile(path);
  if (registry.size() === 0) {
    throw new Error(`key registry ${path} holds no keys; refusing to start an API that cannot authenticate anyone`);
  }
  return registry;
}

async function main(): Promise<void> {
  const config = loadAgentApiConfig();
  const log: ApiLogger = (entry) => {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  };
  const keys = requireKeyRegistry(config.keyRegistryPath);
  const worker = new ExternalWorkerAdapter({
    baseUrl: config.worker.baseUrl,
    ...(config.worker.token ? { token: config.worker.token } : {}),
    deadlineMs: config.worker.launchDeadlineMs,
    cancelDeadlineMs: config.worker.cancelDeadlineMs,
    log,
  });
  const service = new AgentApi({
    worker,
    logger: log,
    env: config.env,
    ...(config.defaultRepository ? { defaultRepository: config.defaultRepository } : {}),
  });
  const server = createAgentApiServer(service, { keys, logger: log });
  // Терминальные раны не переживают себя: без этого процесса память только растёт, а у
  // stateless-сервиса нет ни файла, ни внешнего сборщика мусора.
  const sweeper = setInterval(() => {
    const dropped = service.store.sweep();
    if (dropped > 0) log({ event: 'store_swept', dropped });
  }, 60_000);
  sweeper.unref?.();

  let stopping = false;
  let stopped = false;
  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(sweeper);
    service.dispose();
    log({ event: 'stopped' });
    process.exit(0);
  };
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log({ event: 'shutting_down', signal });
    server.closeAllConnections();
    server.close(() => finish());
    const timer = setTimeout(finish, 5000);
    timer.unref?.();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('uncaughtException', (err) => {
    log({ event: 'uncaught_exception', message: err.message, stack: err.stack ?? '' });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log({ event: 'unhandled_rejection', message: reason instanceof Error ? reason.message : String(reason) });
    process.exit(1);
  });

  server.on('error', (err) => {
    log({ event: 'listen_failed', message: err.message });
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    log({
      event: 'api_listening',
      host: config.host,
      port: config.port,
      keyRegistry: config.keyRegistryPath,
      keys: keys.size(),
      engine: worker.name,
      worker: worker.baseUrl,
      workerAuth: config.worker.token === '' ? 'none' : 'bearer',
      storage: 'stateless: receipts and run progress live in process memory',
      artifacts: 'github links returned by the worker; the API keeps no bytes',
      logs: 'google storage links returned by the worker',
      health: '/healthz',
      startedAt: new Date().toISOString(),
    });
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event: 'startup_failed', message })}\n`);
  process.exit(1);
});
