import { mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { EXTERNAL_WORKER_ENGINE } from '../adapters/external-worker-adapter.js';
import { KeyRegistry } from './auth.js';
import { createAgentApiServer } from './server.js';
import { AgentApi, type ApiLogger } from './service.js';
import { loadAgentApiConfig, requireKeyRegistry } from './config.js';
import { createExternalWorkers } from './workers.js';
import { createProfileWorkspaceCoordinator } from './profile-workspace.js';

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
  const profileRoot = process.env['AGENT_API_PROFILE_WORKSPACE_ROOT']?.trim();
  if (profileRoot && !admissionLogPath) throw new Error('AGENT_API_ADMISSION_LOG is required with profile workspace');
  const objectBackend = process.env['AGENT_API_PROFILE_OBJECT_BACKEND']?.trim() ?? 'gcs';
  if (profileRoot && objectBackend !== 'gcs' && objectBackend !== 'local-fs') throw new Error('AGENT_API_PROFILE_OBJECT_BACKEND must be gcs or local-fs');
  const profileWorkspace = profileRoot ? createProfileWorkspaceCoordinator({
    rootDir: profileRoot,
    owner: process.env['AGENT_API_PROFILE_OWNER']?.trim() ?? '',
    token: process.env['AGENT_API_PROFILE_GITHUB_TOKEN']?.trim() ?? '',
    objectBackend: objectBackend as 'gcs' | 'local-fs',
    env: process.env,
  }) : undefined;
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
    // Цепочка движков (issue #100): null = ран идёт ровно на названный клиентом движок.
    engineChain: config.engineChain ?? undefined,
    mockTestEnabled: config.mockTestEnabled,
    // Бюджет reconcile: мёртвый движок не должен вешать проверку на таймаут запуска.
    reconcileDeadlineMs: config.reconcileDeadlineMs,
    ...(config.defaultRepository ? { defaultRepository: config.defaultRepository } : {}),
    ...(admissionLogPath ? { admissionLogPath } : {}),
    ...(profileWorkspace ? { profileWorkspace } : {}),
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
    // Воркеру нужен адрес, на который он вернёт результат. Порт известен только после
    // старта, поэтому адрес задаётся здесь: без него каждый запуск падает с
    // RESULT_URL_UNSET, а воркер не узнаёт, куда отвечать.
    const publicUrl = config.publicUrl ?? `http://${config.host}:${config.port}`;
    for (const worker of workers) worker.setResultBaseUrl(publicUrl);
    log({
      event: 'api_listening',
      host: config.host,
      port: config.port,
      publicUrl,
      keyRegistry: config.keyRegistryPath,
      keys: keys.size(),
      engines: workers.map((entry) => entry.name),
      engineChain: config.engineChain,
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
