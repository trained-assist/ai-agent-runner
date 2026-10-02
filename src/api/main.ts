import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { FakeEngine, fakeScenarioResult, type FakeScenario } from '../adapters/engine/fake-engine.js';
import { OpenCodeAdapter } from '../adapters/engine/opencode-adapter.js';
import { ArtifactStore } from '../storage/artifact-store.js';
import { createBlobStore } from '../storage/create-blob-store.js';
import { ShareTokenIssuer } from '../storage/share.js';
import { KeyRegistry } from './auth.js';
import { handleArtifactRequest, type ArtifactRouteDeps } from './artifact-route.js';
import { ApiError } from './errors.js';
import { createAgentApiServer } from './server.js';
import { AgentApi, type ApiLogger } from './service.js';

export const DEFAULT_API_PORT = 8787;
export const DEFAULT_API_HOST = '0.0.0.0';

export interface AgentApiProcessConfig {
  host: string;
  port: number;
  dataDir: string;
  keyRegistryPath: string;
  shareSecret: string;
  ephemeralShareSecret: boolean;
  region: string;
  environment: string;
  fakeScenario: FakeScenario;
}

function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function describePath(path: string): string {
  if (isAbsolute(path)) return path;
  return `${process.cwd()}${sep}${path}`;
}

function isInsideTemporary(path: string): boolean {
  const temp = resolve(tmpdir());
  const resolved = resolve(path);
  return resolved === temp || resolved.startsWith(`${temp}${sep}`);
}

export function loadAgentApiConfig(env: Record<string, string | undefined> = process.env): AgentApiProcessConfig {
  const portRaw = env['AGENT_API_PORT']?.trim() || String(DEFAULT_API_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`AGENT_API_PORT: expected an integer in [1, 65535], got "${portRaw}"`);
  }

  const dataDir = resolve(env['AGENT_API_DATA_DIR']?.trim() || 'data');
  if (isInsideTemporary(dataDir)) {
    throw new Error(`AGENT_API_DATA_DIR must be a durable directory, not a temporary one: ${dataDir}`);
  }

  const keyRegistryPath = env['AGENT_API_KEY_REGISTRY']?.trim();
  if (!keyRegistryPath) {
    throw new Error('AGENT_API_KEY_REGISTRY is required: path to a mode-0600 key registry JSON file with a principals array');
  }

  const fakeScenarioRaw = env['AGENT_API_FAKE_SCENARIO']?.trim() || 'success';
  const fakeScenario = fakeScenarioResult(fakeScenarioRaw);
  if (!fakeScenario.ok) throw new Error(`AGENT_API_FAKE_SCENARIO: ${fakeScenario.errors.join('; ')}`);

  const host = env['AGENT_API_HOST']?.trim() || DEFAULT_API_HOST;
  const shareSecret = env['ARTIFACT_SHARE_SECRET']?.trim();
  return {
    host,
    port,
    dataDir,
    keyRegistryPath: describePath(keyRegistryPath),
    shareSecret: shareSecret ?? '',
    ephemeralShareSecret: shareSecret === undefined,
    region: env['AGENT_API_REGION']?.trim() || 'sandbox',
    environment: env['AGENT_API_ENVIRONMENT']?.trim() || 'sandbox',
    fakeScenario: fakeScenario.value,
  };
}

function requireKeyRegistry(path: string): KeyRegistry {
  if (!exists(path)) throw new Error(`key registry not found: ${path}`);
  const registry = KeyRegistry.loadFile(path);
  if (registry.size() === 0) {
    throw new Error(`key registry ${path} holds no keys; refusing to start an API that cannot authenticate anyone`);
  }
  return registry;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function writeJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function main(): Promise<void> {
  const config = loadAgentApiConfig();
  const log: ApiLogger = (entry) => {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  };

  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);
  if (statSync(config.dataDir).mode & 0o077) {
    throw new Error(`data directory ${config.dataDir} must not be group/world accessible (expected mode 0700)`);
  }

  const keys = requireKeyRegistry(config.keyRegistryPath);
  if (config.ephemeralShareSecret) {
    log({ event: 'share_secret_ephemeral', message: 'ARTIFACT_SHARE_SECRET is unset; links issued by this process will not survive a restart' });
  }
  const shareSecret = config.shareSecret === '' ? undefined : config.shareSecret;

  const blob = createBlobStore({ env: process.env, localRoot: join(config.dataDir, 'blobs') });
  const artifacts = new ArtifactStore({ rootDir: config.dataDir, blob });
  const tokens = new ShareTokenIssuer(shareSecret !== undefined ? { secret: shareSecret } : {});

  const service = new AgentApi({
    rootDir: config.dataDir,
    adapters: { fake: new FakeEngine(config.fakeScenario), opencode: new OpenCodeAdapter() },
    host: { region: config.region, environment: config.environment },
    logger: log,
    blob,
  });
  const recovery = await service.recover();

  const artifactDeps: ArtifactRouteDeps = { artifacts, keys, tokens, logger: log };
  const apiServer = createAgentApiServer(service, { keys, logger: log });

  const server: Server = createServer((req, res) => {
    handleArtifactRequest(req, res, artifactDeps)
      .then((status) => {
        if (status === null) apiServer.emit('request', req, res);
      })
      .catch((err: unknown) => {
        const apiError = err instanceof ApiError ? err : new ApiError('INTERNAL', 'internal error');
        if (!(err instanceof ApiError)) {
          log({ event: 'artifact_internal_error', message: err instanceof Error ? err.message : String(err) });
        }
        if (res.headersSent) res.end();
        else writeJson(res, apiError.status, apiError.body());
      });
  });

  let stopping = false;
  let stopped = false;
  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      service.dispose({ killProcesses: true });
    } catch (err) {
      log({ event: 'dispose_failed', message: err instanceof Error ? err.message : String(err) });
    }
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
      dataDir: config.dataDir,
      keyRegistry: config.keyRegistryPath,
      keys: keys.size(),
      engines: ['fake', 'opencode'],
      fakeScenario: config.fakeScenario,
      health: '/healthz',
      recovery: {
        scanned: recovery.scanned,
        resumedQueued: recovery.resumedQueued,
        orphaned: recovery.orphaned,
        lost: recovery.lost,
        terminal: recovery.terminal,
        healed: recovery.healed,
      },
      startedAt: new Date().toISOString(),
    });
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event: 'startup_failed', message })}\n`);
  process.exit(1);
});
