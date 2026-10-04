import { onTestFinished } from 'vitest';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine, type FakeScenario } from '../src/adapters/engine/fake-engine.js';
import { sleep, waitForProcessDeath } from '../src/adapters/engine/process-tree.js';
import { OpenCodeAdapter } from '../src/adapters/engine/opencode-adapter.js';
import { generateApiKey, KeyRegistry, keyRecordFor, type Principal } from '../src/api/auth.js';
import { createAgentApiServer } from '../src/api/server.js';
import { AgentApi, type AgentApiOptions, type PromotionRuntime, type ServiceRecoveryReport } from '../src/api/service.js';
import { FaultRegistry } from '../src/faults/registry.js';
import { isTerminalState } from '../src/runner/state-machine.js';
import { ArtifactStore } from '../src/storage/artifact-store.js';
import { RunExportStore } from '../src/storage/export.js';
import { InputMaterializer } from '../src/storage/input-materializer.js';
import { WorkspaceSnapshotStore } from '../src/storage/workspace-snapshot.js';
import { createBlobStore } from '../src/storage/create-blob-store.js';
import type { CapabilityRegistry } from '../src/mcp/capabilities.js';
import type { BindingValueResolver } from '../src/mcp/scope.js';
import { removeDirWithRetry } from './helpers.js';

export const alphaKey = generateApiKey();
export const betaKey = generateApiKey();
export const readerKey = generateApiKey();
export const noScopeKey = generateApiKey();

export const alphaPrincipal: Principal = { principalId: 'p-alpha', profileId: 'profile-a', scopes: ['runs:read', 'runs:write'], engines: ['fake'] };
export const betaPrincipal: Principal = { principalId: 'p-beta', profileId: 'profile-b', scopes: ['runs:read', 'runs:write'] };
export const readerPrincipal: Principal = { principalId: 'p-reader', profileId: 'profile-r', scopes: ['runs:read'] };
export const noScopePrincipal: Principal = { principalId: 'p-noscope', profileId: 'profile-a', scopes: [] };

export function testKeyRegistry(): KeyRegistry {
  return KeyRegistry.fromRecords([
    keyRecordFor(alphaKey, alphaPrincipal),
    keyRecordFor(betaKey, betaPrincipal),
    keyRecordFor(readerKey, readerPrincipal),
    keyRecordFor(noScopeKey, noScopePrincipal),
  ]);
}

export function authHeader(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

export async function waitForAsync(condition: () => boolean | Promise<boolean>, timeoutMs = 8000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${label}`);
}

export interface HttpHarnessOptions {
  scenario?: FakeScenario;
  heartbeatIntervalMs?: number;
  streamPollMs?: number;
  keepaliveMs?: number;
  maxBodyBytes?: number;
  /** Artifact store для маршрута GET /v1/runs/{id}/artifacts (общий с AgentApi rootDir). */
  artifacts?: ArtifactStore;
  /** Свой dataDir вместо временного — нужен, когда store создаётся снаружи на том же корне. */
  rootDir?: string;
  /** Реестр capability handler'ов (P13): раскрывает POST /v1/capabilities/invoke. */
  capabilities?: CapabilityRegistry;
  /** Резолвер значений credential binding'ов (P13). */
  bindingResolver?: BindingValueResolver;
  /** Регион воркера (P30): по умолчанию sandbox-eu; для симуляции двух воркеров задаётся явно. */
  hostRegion?: string;
  /**
   * Стадия сохранения выходов (P07/#54): blob + манифесты экспорта, как в dist/API.
   * Без неё `outputRefs` в результате всегда пуст — хранилища нет, сохранять некуда.
   */
  artifactExport?: boolean;
  /**
   * Снимки workspace и материализация входов (issue #52, шаг 1). Подключаются ровно как в
   * dist/api/main.ts и требуют `artifactExport`: указатель снимка проверяется тем же
   * хранилищем артефактов.
   */
  snapshotInputs?: boolean;
  /** Оставить рабочие каталоги ранов: нужно, чтобы проверить байты ВХОДА на диске. */
  retainWorkspaces?: boolean;
  /**
   * Промоушен-контур (P29). Фабрика, а не готовый объект: рестарт сервиса должен заново
   * прочитать файл состояния релиза — иначе откат нельзя было бы проверить перезапуском.
   */
  promotion?: () => PromotionRuntime;
}

export interface HttpHarness {
  readonly rootDir: string;
  readonly fake: FakeEngine;
  readonly faults: FaultRegistry;
  readonly logs: Record<string, unknown>[];
  readonly service: AgentApi;
  readonly base: string;
  /** Хранилище выходов рана; создаётся только при `artifactExport: true`. */
  readonly artifacts: ArtifactStore | null;
  readonly exports: RunExportStore | null;
  /** Снимки workspace; создаётся только при `snapshotInputs: true`. */
  readonly snapshots: WorkspaceSnapshotStore | null;
  restart(options?: { killProcesses?: boolean }): Promise<ServiceRecoveryReport>;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as AddressInfo).port;
}

async function shutdown(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function startHttpHarness(options: HttpHarnessOptions = {}): Promise<HttpHarness> {
  const rootDir = options.rootDir ?? mkdtempSync(join(tmpdir(), 'ai-agent-runner-api-http-'));
  const fake = new FakeEngine(options.scenario ?? 'success');
  const faults = new FaultRegistry();
  const logs: Record<string, unknown>[] = [];
  const keys = testKeyRegistry();
  const streamPollMs = options.streamPollMs ?? 20;
  const keepaliveMs = options.keepaliveMs ?? 10_000;
  const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
  const logger = (entry: Record<string, unknown>): void => {
    logs.push(entry);
  };
  // Стадия сохранения выходов подключается ровно как в dist/API (main.ts): без неё
  // ран завершается, но сохранять выходы некуда и outputRefs всегда пуст.
  const blob = options.artifactExport ? createBlobStore({ env: {}, localRoot: join(rootDir, 'blobs') }) : null;
  const artifacts = blob ? new ArtifactStore({ rootDir, blob }) : (options.artifacts ?? null);
  const exports = blob ? new RunExportStore({ rootDir, artifacts: artifacts as ArtifactStore }) : null;
  const snapshots = options.snapshotInputs && artifacts ? new WorkspaceSnapshotStore({ rootDir }) : null;
  const inputs = snapshots ? new InputMaterializer({ snapshots, artifacts: artifacts as ArtifactStore }) : null;
  const serviceOptions: AgentApiOptions = {
    rootDir,
    adapters: { fake, opencode: new OpenCodeAdapter() },
    host: { region: options.hostRegion ?? 'sandbox-eu', environment: 'sandbox' },
    faults,
    cancelGraceMs: 500,
    logger,
    ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options.bindingResolver ? { bindingResolver: options.bindingResolver } : {}),
    ...(blob ? { blob } : {}),
    ...(exports ? { exports } : {}),
    ...(snapshots ? { snapshots } : {}),
    ...(inputs ? { inputs } : {}),
    ...(options.retainWorkspaces !== undefined ? { retainWorkspaces: options.retainWorkspaces } : {}),
  };
  const start = (): AgentApi => {
    const service = new AgentApi(options.promotion ? { ...serviceOptions, promotion: options.promotion() } : serviceOptions);
    return service;
  };

  let service = start();
  await service.recover();
  const serverOptions = {
    keys,
    logger,
    streamPollMs,
    keepaliveMs,
    maxBodyBytes,
    ...(artifacts ? { artifacts } : {}),
    ...(exports ? { exports } : {}),
    ...(snapshots ? { snapshots } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options.bindingResolver ? { bindingResolver: options.bindingResolver } : {}),
  };
  let server = createAgentApiServer(service, serverOptions);
  let port = await listen(server);

  const harness: HttpHarness = {
    rootDir,
    fake,
    faults,
    logs,
    artifacts,
    exports,
    snapshots,
    get service() {
      return service;
    },
    get base() {
      return `http://127.0.0.1:${port}`;
    },
    async restart(restartOptions = {}) {
      const killProcesses = restartOptions.killProcesses ?? true;
      const victims = killProcesses
        ? service.runner
            .listRunIds()
            .map((runId) => service.runner.getRun(runId))
            .filter((snapshot) => snapshot !== null && !isTerminalState(snapshot.state) && snapshot.pid !== null)
            .map((snapshot) => ({ pgid: snapshot!.pgid, pid: snapshot!.pid }))
        : [];
      await shutdown(server);
      service.dispose({ killProcesses });
      for (const victim of victims) await waitForProcessDeath(victim.pgid, victim.pid, 3000);
      service = start();
      const report = await service.recover();
      server = createAgentApiServer(service, serverOptions);
      port = await listen(server);
      return report;
    },
    async close() {
      await shutdown(server);
      service.dispose({ killProcesses: true });
      await removeDirWithRetry(rootDir);
    },
  };

  onTestFinished(() => harness.close());
  return harness;
}

export function submitBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: { name: 'fake', adapterVersion: '1' },
    limits: { timeoutMs: 15000 },
    input: { inlinePrompt: 'hello agent' },
    ...over,
  };
}

export async function postSubmit(
  base: string,
  key: string,
  idempotencyKey: string | null,
  body: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { ...authHeader(key), 'content-type': 'application/json' };
  if (idempotencyKey !== null) headers['idempotency-key'] = idempotencyKey;
  return fetch(`${base}/v1/runs`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

export async function getStatus(base: string, key: string, runId: string): Promise<Response> {
  return fetch(`${base}/v1/runs/${runId}/status`, { headers: authHeader(key) });
}

export async function postCancel(base: string, key: string, runId: string, body: unknown = {}): Promise<Response> {
  return fetch(`${base}/v1/runs/${runId}/cancel`, {
    method: 'POST',
    headers: { ...authHeader(key), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
}

export class SseCollector {
  private buffer = '';
  private readonly frames: SseFrame[] = [];
  private readonly decoder = new TextDecoder();

  constructor(private readonly body: ReadableStreamDefaultReader<Uint8Array>) {}

  get all(): SseFrame[] {
    return this.frames;
  }

  lastEventId(): number {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (frame?.id) return Number(frame.id);
    }
    return 0;
  }

  async waitFor(predicate: (frames: SseFrame[]) => boolean, timeoutMs = 8000): Promise<SseFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.frames)) {
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for sse frames; got [${this.frames.map((frame) => frame.event ?? '?').join(', ')}]`);
      }
      const remaining = Math.max(1, deadline - Date.now());
      const chunk = await withTimeout(this.body.read(), remaining);
      if (chunk.done) break;
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      this.drain();
    }
    if (!predicate(this.frames)) {
      throw new Error(`sse stream ended before the condition; got [${this.frames.map((frame) => frame.event ?? '?').join(', ')}]`);
    }
    return this.frames;
  }

  async waitEnd(timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = Math.max(1, deadline - Date.now());
      const chunk = await withTimeout(this.body.read(), remaining);
      if (chunk.done) return;
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      this.drain();
    }
  }

  private drain(): void {
    let index = this.buffer.indexOf('\n\n');
    while (index >= 0) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const frame: SseFrame = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) frame.id = line.slice(3).trim();
        else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
        else if (line.startsWith('data:')) frame.data = line.slice(5).trim();
      }
      if (frame.event !== undefined) this.frames.push(frame);
      index = this.buffer.indexOf('\n\n');
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('sse read timeout')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
