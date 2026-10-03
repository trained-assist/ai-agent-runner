import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { FakeEngine, fakeScenarioResult, type FakeScenario } from '../adapters/engine/fake-engine.js';
import { OpenCodeAdapter } from '../adapters/engine/opencode-adapter.js';
import { ArtifactStore } from '../storage/artifact-store.js';
import { createBlobStore } from '../storage/create-blob-store.js';
import { RunExportStore } from '../storage/export.js';
import { ShareTokenIssuer } from '../storage/share.js';
import { UploadSessionStore } from '../storage/upload-session.js';
import { WorkspaceSnapshotStore } from '../storage/workspace-snapshot.js';
import { cohortFromEnv, type CohortPolicy } from '../release/cohort.js';
import { DispatchOwnerStore } from '../release/dispatch-owner.js';
import { releaseIdentity, releaseManifestFromEnv, type ReleaseManifest } from '../release/manifest.js';
import { allowedEnginesForRegion, parsePlacementPolicyText, type PlacementPolicy } from '../release/placement.js';
import { PromotionJournal, ReleaseStateController } from '../release/promotion.js';
import { KeyRegistry } from './auth.js';
import { handleArtifactRequest, type ArtifactRouteDeps } from './artifact-route.js';
import { ApiError } from './errors.js';
import { createAgentApiServer } from './server.js';
import { AgentApi, type ApiLogger, type PromotionRuntime } from './service.js';

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
  releaseManifestPath: string;
  cohort: CohortPolicy;
  /** Файл состояния релиза: вход отката, читается при старте (AC-324). */
  releaseStatePath: string;
  /** Общий реестр владения задачами флота; без него установка одиночная. */
  ownerStorePath: string;
  /** Политика размещения (P30): регион × провайдер × credentials × резидентность. */
  placementPolicyPath: string;
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

  const releaseManifestPath = env['AGENT_API_RELEASE_MANIFEST']?.trim();
  if (!releaseManifestPath) {
    throw new Error('AGENT_API_RELEASE_MANIFEST is required: pinned release/config manifest (P29, AC-170)');
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
    releaseManifestPath: describePath(releaseManifestPath),
    cohort: cohortFromEnv(env),
    releaseStatePath: describePath(env['AGENT_API_RELEASE_STATE']?.trim() || join(dataDir, 'release-state.json')),
    ownerStorePath: env['AGENT_API_OWNER_STORE']?.trim() ? describePath(env['AGENT_API_OWNER_STORE'].trim()) : '',
    placementPolicyPath: env['AGENT_API_PLACEMENT_POLICY']?.trim() ? describePath(env['AGENT_API_PLACEMENT_POLICY'].trim()) : '',
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
  const manifest: ReleaseManifest = releaseManifestFromEnv(process.env);
  const identity = releaseIdentity(manifest);
  const log: ApiLogger = (entry) => {
    // Каждая строка журнала несёт закреплённый релиз и машину: прод и песочница различимы
    // в логах без догадок (SANDBOX · I10).
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...identity, ...entry })}\n`);
  };
  const journal = new PromotionJournal({
    path: join(config.dataDir, 'promotion.jsonl'),
    releaseId: manifest.releaseId,
    workerId: manifest.host.workerId,
    region: manifest.host.region,
  });
  const releaseState = new ReleaseStateController({
    path: config.releaseStatePath,
    releaseId: manifest.releaseId,
    previousReleaseId: envPreviousReleaseId(),
    journal,
    cohortId: config.cohort.cohortId,
  });
  const owners = config.ownerStorePath
    ? new DispatchOwnerStore({
        path: config.ownerStorePath,
        workerId: manifest.host.workerId,
        onEvent: (event) => {
          log({ ...event, event: `ownership_${event.event}` });
          // drain/failover/fenced — переходы состояния флота: они обязаны жить в durable-журнале
          // с причиной, иначе «почему задача сменила владельца» читается только из логов процесса.
          const kind = ownerEventKind(event.event);
          if (kind !== null) {
            journal.append({
              kind,
              reason: event.reason,
              ownerGeneration: event.ownerGeneration,
              detail: {
                principalId: event.principalId,
                userTaskId: event.userTaskId,
                ...(event.previousOwnerWorkerId !== undefined ? { previousOwnerWorkerId: event.previousOwnerWorkerId } : {}),
              },
            });
          }
        },
      })
    : undefined;
  const promotion: PromotionRuntime = { manifest, cohort: config.cohort, state: releaseState, journal };
  if (owners) promotion.owners = owners;
  let placement: PlacementPolicy | undefined;
  if (config.placementPolicyPath !== '') {
    placement = parsePlacementPolicyText(readFileSync(config.placementPolicyPath, 'utf8'));
    promotion.placement = placement;
  }

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
  const exports = new RunExportStore({ rootDir: config.dataDir, artifacts });
  const uploads = new UploadSessionStore({ rootDir: config.dataDir });
  const snapshots = new WorkspaceSnapshotStore({ rootDir: config.dataDir });
  const tokens = new ShareTokenIssuer(shareSecret !== undefined ? { secret: shareSecret } : {});
  const baseUrl = process.env['ARTIFACT_BASE_URL']?.trim();

  const service = new AgentApi({
    rootDir: config.dataDir,
    adapters: { fake: new FakeEngine(config.fakeScenario), opencode: new OpenCodeAdapter() },
    host: {
      region: config.region,
      environment: config.environment,
      release: manifest.releaseId,
      workerId: manifest.host.workerId,
      ...(placement ? { allowedEngines: allowedEnginesForRegion(placement, manifest.host.region) } : {}),
    },
    logger: log,
    blob,
    exports,
    uploads,
    snapshots,
    promotion,
  });
  const recovery = await service.recover();

  const artifactDeps: ArtifactRouteDeps = { artifacts, keys, tokens, logger: log };
  const apiServerOptions: Parameters<typeof createAgentApiServer>[1] = { keys, logger: log, artifacts, exports, tokens, uploads, snapshots };
  if (baseUrl) apiServerOptions.baseUrl = baseUrl;
  const apiServer = createAgentApiServer(service, apiServerOptions);

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
      release: {
        ...identity,
        builtAt: manifest.builtAt,
        engines: [...manifest.engines],
        paidEngines: [...manifest.paid.engines],
        bindings: manifest.bindings.length,
        retention: manifest.retention,
        cohort: { cohortId: config.cohort.cohortId, mode: config.cohort.mode, rolloutPercent: config.cohort.rolloutPercent, principals: config.cohort.principals.length },
        servingReleaseId: releaseState.snapshot().servingReleaseId,
        rolledBack: releaseState.paused,
        ownerStore: config.ownerStorePath === '' ? 'single_worker' : 'shared_fleet_registry',
      },
      recovery: {
        scanned: recovery.scanned,
        resumedQueued: recovery.resumedQueued,
        orphaned: recovery.orphaned,
        lost: recovery.lost,
        terminal: recovery.terminal,
        healed: recovery.healed,
      },
      artifactExport: { enabled: true, versions: 'runs/<runId>/export/v<N>.json' },
      startedAt: new Date().toISOString(),
    });
    // Первая запись журнала промоушена: что закреплено и в каком состоянии обслуживание.
    journal.append({
      kind: 'release_pinned',
      reason: 'service start with a pinned release manifest',
      servingReleaseId: releaseState.snapshot().servingReleaseId,
      cohortId: config.cohort.cohortId,
      detail: {
        sourceCommit: manifest.sourceCommit,
        configVersion: manifest.configVersion,
        environment: manifest.host.environment,
        paidProfilesAllowed: manifest.paid.allowed,
        rolledBack: releaseState.paused,
        retention: manifest.retention,
        ownerStore: config.ownerStorePath === '' ? 'single_worker' : 'shared_fleet_registry',
      },
    });
    journal.append({
      kind: 'cohort_configured',
      reason: `cohort ${config.cohort.cohortId} is ${config.cohort.mode}`,
      cohortId: config.cohort.cohortId,
      detail: { mode: config.cohort.mode, rolloutPercent: config.cohort.rolloutPercent, principals: config.cohort.principals.length },
    });
  });
}

/** Предыдущий релиз для отката: без него rollback некуда возвращать. */
function envPreviousReleaseId(): string | null {
  const previous = process.env['AGENT_API_PREVIOUS_RELEASE']?.trim();
  return previous === undefined || previous === '' ? null : previous;
}

/** События реестра владения, которые являются переходами состояния флота (P29/P30). */
function ownerEventKind(event: string): 'drain' | 'failover' | 'fenced' | null {
  switch (event) {
    case 'drained':
      return 'drain';
    case 'failover_granted':
      return 'failover';
    case 'fenced':
      return 'fenced';
    default:
      return null;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event: 'startup_failed', message })}\n`);
  process.exit(1);
});
