import { onTestFinished } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineAdapter } from '../src/adapters/engine/engine-adapter.js';
import { FakeEngine, type FakeScenario } from '../src/adapters/engine/fake-engine.js';
import { isProcessAlive, killProcessTree, sleep } from '../src/adapters/engine/process-tree.js';
import { OpenCodeAdapter } from '../src/adapters/engine/opencode-adapter.js';
import { validateRunSpec, type RunSpec } from '../src/contracts/run-spec.js';
import { FaultRegistry } from '../src/faults/registry.js';
import { Runner, type RunnerHostInfo, type RunnerOptions, type StartReceipt } from '../src/runner/runner.js';
import { isTerminalState } from '../src/runner/state-machine.js';
import type { LogSink } from '../src/runner/scoped-log.js';
import type { BlobStore } from '../src/storage/blob-store.js';
import { createBlobStore } from '../src/storage/create-blob-store.js';
import { ArtifactStore } from '../src/storage/artifact-store.js';
import { RunExportStore } from '../src/storage/export.js';
import { InputMaterializer } from '../src/storage/input-materializer.js';
import { WorkspaceSnapshotStore } from '../src/storage/workspace-snapshot.js';
import type { CapabilityRegistry } from '../src/mcp/capabilities.js';
import type { BindingValueResolver } from '../src/mcp/scope.js';
import type { CleanRoomProvider } from '../src/isolation/contract.js';
import type { EngineConfigTemplate } from '../src/isolation/engine-config.js';
import type { IngressArtifactResolver } from '../src/storage/ingress-artifact.js';

let counter = 0;

export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function makeRunSpec(over: Partial<RunSpec> = {}): RunSpec {
  const runId = nextId('run');
  const base = {
    contractVersion: 1,
    jobId: nextId('job'),
    runId,
    operationId: nextId('op'),
    userTaskId: nextId('task'),
    profileId: 'profile-a',
    conversationId: nextId('conv'),
    ownerGeneration: 1,
    engine: { name: 'fake', adapterVersion: '1' },
    cwd: join(tmpdir(), 'ai-agent-runner-tests', 'ws', runId),
    envAllowlist: [],
    limits: { timeoutMs: 5000 },
  };
  const merged = { ...base, ...over };
  const validated = validateRunSpec(merged);
  if (!validated.ok) throw new Error(`bad test spec: ${validated.errors.join('; ')}`);
  return validated.value;
}

export async function waitFor(cond: () => boolean, timeoutMs = 8000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${label}`);
}

export interface HarnessOptions {
  /**
   * Каталог состояния. По умолчанию — свежий временный каталог; явный rootDir нужен,
   * чтобы эмулировать рестарт воркера поверх ДОЛГОВЕЧНЫХ данных (identity-аренды, сокеты).
   */
  rootDir?: string;
  scenario?: FakeScenario;
  host?: RunnerHostInfo;
  heartbeatIntervalMs?: number;
  cancelGraceMs?: number;
  logSink?: LogSink;
  faults?: FaultRegistry;
  adapters?: Record<string, EngineAdapter>;
  blob?: BlobStore;
  profileTrace?: boolean;
  /** Включить стадию экспорта артефактов (P07). */
  artifactExport?: boolean;
  /** Отключить удаление локальных копий после подтверждённого сохранения. */
  pruneLocalCopies?: boolean;
  /**
   * Оставить каталоги ранов после финализации (диагностика). Тесты, которые проверяют
   * содержимое workspace после ранa, обязаны включать его явно: по умолчанию рабочий
   * каталог снимается вместе с уборкой чистой среды (issue #52).
   */
  retainWorkspaces?: boolean;
  /** Реестр capability handler'ов (P13): общий для MCP-вызовов рана и API. */
  capabilities?: CapabilityRegistry;
  /** Резолвер значений credential binding'ов (P13). */
  bindingResolver?: BindingValueResolver;
  /**
   * Граница Agent clean room (issue #51): per-run Unix-идентичность. Фабрика получает
   * rootDir харнесса — каталоги аренд и чистых сред обязаны лежать рядом с состоянием ранов.
   */
  isolation?: CleanRoomProvider | ((rootDir: string) => CleanRoomProvider);
  /** Хостовые шаблоны конфигурации движка для run-scoped HOME (issue #51). */
  engineConfigTemplates?: EngineConfigTemplate | null;
  /**
   * Снимки workspace + материализация входов из них (issue #52, шаг 1). Ставится так же,
   * как в dist/api/main.ts: снимки и артефакты поверх ОДНОГО хранилища, иначе указатель
   * снимка нечего проверять.
   */
  snapshotInputs?: boolean;
  ingressResolver?: IngressArtifactResolver;
}

export interface Harness {
  rootDir: string;
  fake: FakeEngine;
  /** Каталог чистых сред (identity/leases, cleanrooms/<runId>) — граница issue #51. */
  isolationRoot(): string;
  faults: FaultRegistry;
  readonly runner: Runner;
  exports: RunExportStore | null;
  /** Хранилище байт ранов (общий для экспорта и снимков); null без `artifactExport`. */
  blob: BlobStore | null;
  artifacts: ArtifactStore | null;
  snapshots: WorkspaceSnapshotStore | null;
  inputs: InputMaterializer | null;
  makeSpec: (over?: Partial<RunSpec>) => RunSpec;
  start: (over?: Partial<RunSpec>) => { receipt: StartReceipt; spec: RunSpec };
  reopen: () => Runner;
  /** Рестарт воркера БЕЗ dispose предыдущего процесса — эмуляция падения воркера. */
  reopenWithoutDispose: () => Runner;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const ownsRoot = options.rootDir === undefined;
  const rootDir = options.rootDir ?? mkdtempSync(join(tmpdir(), 'ai-agent-runner-harness-'));
  const faults = options.faults ?? new FaultRegistry();
  const fake = new FakeEngine(options.scenario ?? 'success');
  const adapters = options.adapters ?? { fake, opencode: new OpenCodeAdapter() };
  const base: RunnerOptions = {
    rootDir,
    adapters,
    host: options.host ?? { region: 'sandbox-eu', environment: 'sandbox' },
    faults,
    cancelGraceMs: options.cancelGraceMs ?? 500,
  };
  if (options.logSink) base.logSink = options.logSink;
  if (options.heartbeatIntervalMs !== undefined) base.heartbeatIntervalMs = options.heartbeatIntervalMs;
  if (options.blob) base.blob = options.blob;
  if (options.profileTrace !== undefined) base.profileTrace = options.profileTrace;
  if (options.retainWorkspaces !== undefined) base.retainWorkspaces = options.retainWorkspaces;
  if (options.capabilities) base.capabilities = options.capabilities;
  if (options.bindingResolver) base.bindingResolver = options.bindingResolver;
  if (options.isolation) base.isolation = typeof options.isolation === 'function' ? options.isolation(rootDir) : options.isolation;
  if (options.engineConfigTemplates) base.engineConfigTemplates = options.engineConfigTemplates;
  if (options.ingressResolver) base.ingressResolver = options.ingressResolver;
  let exports: RunExportStore | null = null;
  let artifacts: ArtifactStore | null = null;
  let blob: BlobStore | null = options.blob ?? null;
  if (options.artifactExport) {
    blob = options.blob ?? createBlobStore({ backend: 'local-fs', localRoot: join(rootDir, 'blobs') });
    base.blob = blob;
    artifacts = new ArtifactStore({ rootDir, blob });
    exports = new RunExportStore({
      rootDir,
      artifacts,
      ...(options.pruneLocalCopies !== undefined ? { pruneLocalCopies: options.pruneLocalCopies } : {}),
    });
    base.exports = exports;
  }
  let snapshots: WorkspaceSnapshotStore | null = null;
  let inputs: InputMaterializer | null = null;
  if (options.snapshotInputs) {
    // Снимок указывает на байты ArtifactStore, поэтому без хранилища артефактов указатель
    // проверять нечем: тогда материализация и не подключается.
    snapshots = new WorkspaceSnapshotStore({ rootDir });
    base.snapshots = snapshots;
    if (artifacts) {
      inputs = new InputMaterializer({ snapshots, artifacts });
      base.inputs = inputs;
    }
  }

  let runner = new Runner(base);

  const harness: Harness = {
    rootDir,
    fake,
    faults,
    isolationRoot: () => rootDir,
    exports,
    blob,
    artifacts,
    snapshots,
    inputs,
    get runner() {
      return runner;
    },
    makeSpec(over: Partial<RunSpec> = {}) {
      const runId = nextId('run');
      return makeRunSpec({
        runId,
        jobId: nextId('job'),
        operationId: nextId('op'),
        userTaskId: nextId('task'),
        conversationId: nextId('conv'),
        cwd: join(rootDir, 'ws', runId),
        ...over,
      });
    },
    start(over: Partial<RunSpec> = {}) {
      const spec = harness.makeSpec(over);
      const receipt = runner.start(spec);
      return { receipt, spec };
    },
    reopen() {
      runner.dispose();
      runner = new Runner(base);
      return runner;
    },
    /** Рестарт воркера БЕЗ dispose предыдущего процесса — эмуляция падения воркера. */
    reopenWithoutDispose() {
      runner = new Runner(base);
      return runner;
    },
  };

  onTestFinished(async () => {
    for (const runId of runner.listRunIds()) {
      const snap = runner.getRun(runId);
      if (snap && !isTerminalState(snap.state)) killProcessTree(snap.pgid, snap.pid, 'SIGKILL');
    }
    runner.dispose();
    // Явный rootDir переживает тест: следующий харнесс эмулирует рестарт воркера поверх него.
    if (ownsRoot) await removeDirWithRetry(rootDir);
  });

  return harness;
}

/**
 * clone пишет .git асинхронно; dispose убивает git-процесс сигналом, но файлы могут
 * дописываться доли секунды — один rmSync в этот момент падает ENOTEMPTY.
 */
export async function removeDirWithRetry(dir: string, attempts = 10): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt === attempts - 1) throw err;
      await sleep(50);
    }
  }
}

export { isProcessAlive, killProcessTree, sleep };
