import { mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import {
  DEFAULT_CANCEL_DEADLINE_MS,
  DEFAULT_LAUNCH_DEADLINE_MS,
  EXTERNAL_WORKER_ENGINE,
  ExternalWorkerAdapter,
} from '../adapters/external-worker-adapter.js';
import { KeyRegistry } from './auth.js';
import { createAgentApiServer } from './server.js';
import { AgentApi, type ApiLogger } from './service.js';
import { createExternalWorkers, loadAgentApiConfig, requireKeyRegistry } from './config.js';

/** Путь журнала приёмных записей: явный env, без значения — дедупликация только в памяти. */
function admissionLogFile(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value && value.length > 0 ? value : null;
}

async function main(): Promise<void> {
  const config = loadAgentApiConfig();
  const log: ApiLogger = (entry) => {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  };
  const keys = requireKeyRegistry(config.keyRegistryPath);
  const workers = createExternalWorkers(config, log);
  // Журнал приёмных записей: дедупликация по `Idempotency-Key` переживает рестарт API.
  // Без него повторный submit с тем же ключом после рестарта запустил бы второй ран.
  //
  // Читаем из `process.env`, а не из `config.env`: `config.env` — это пул переменных,
  // которые уходят ВОРКЕРУ в каждом ране (envAllowlist). Хостовая настройка API не должна
  // лежать в пуле, который видят агенты, — иначе путь к журналу утекает в каждый ран.
  const admissionLogPath = admissionLogFile(process.env['AGENT_API_ADMISSION_LOG']);
  if (admissionLogPath) {
    try {
      mkdirSync(dirname(admissionLogPath), { recursive: true, mode: 0o700 });
    } catch (err) {
      log({ event: 'admission_log_unavailable', message: err instanceof Error ? err.message : String(err) });
    }
  }
  const service = new AgentApi({
    workers,
    logger: log,
    env: config.env,
    ...(config.defaultRepository ? { defaultRepository: config.defaultRepository } : {}),
    ...(admissionLogPath ? { admissionLogPath } : {}),
  });
  // Раны, принятые воркером до рестарта API, снова под опросом: без этого результат
  // потерян, а повтор клиента с новым ключом завёл бы второй ран.
  const resumed = service.resumeDispatched();
  if (resumed > 0) log({ event: 'dispatched_runs_resumed', count: resumed });

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
  const finish = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(sweeper);
    await service.dispose();
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
      engines: workers.map((entry) => entry.name),
      workers: workers.map((entry) => ({ engine: entry.name, baseUrl: entry.baseUrl })),
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
