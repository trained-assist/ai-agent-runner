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
  scenario?: FakeScenario;
  host?: RunnerHostInfo;
  heartbeatIntervalMs?: number;
  cancelGraceMs?: number;
  logSink?: LogSink;
  faults?: FaultRegistry;
  adapters?: Record<string, EngineAdapter>;
  blob?: BlobStore;
  profileTrace?: boolean;
}

export interface Harness {
  rootDir: string;
  fake: FakeEngine;
  faults: FaultRegistry;
  readonly runner: Runner;
  makeSpec: (over?: Partial<RunSpec>) => RunSpec;
  start: (over?: Partial<RunSpec>) => { receipt: StartReceipt; spec: RunSpec };
  reopen: () => Runner;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const rootDir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-harness-'));
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

  let runner = new Runner(base);

  const harness: Harness = {
    rootDir,
    fake,
    faults,
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
  };

  onTestFinished(async () => {
    for (const runId of runner.listRunIds()) {
      const snap = runner.getRun(runId);
      if (snap && !isTerminalState(snap.state)) killProcessTree(snap.pgid, snap.pid, 'SIGKILL');
    }
    runner.dispose();
    await removeDirWithRetry(rootDir);
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
