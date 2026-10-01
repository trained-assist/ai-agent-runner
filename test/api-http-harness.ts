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
import { AgentApi, type AgentApiOptions, type ServiceRecoveryReport } from '../src/api/service.js';
import { FaultRegistry } from '../src/faults/registry.js';
import { isTerminalState } from '../src/runner/state-machine.js';
import { removeDirWithRetry } from './helpers.js';

export const alphaKey = generateApiKey();
export const betaKey = generateApiKey();
export const readerKey = generateApiKey();

export const alphaPrincipal: Principal = { principalId: 'p-alpha', profileId: 'profile-a', scopes: ['runs:read', 'runs:write'], engines: ['fake'] };
export const betaPrincipal: Principal = { principalId: 'p-beta', profileId: 'profile-b', scopes: ['runs:read', 'runs:write'] };
export const readerPrincipal: Principal = { principalId: 'p-reader', profileId: 'profile-r', scopes: ['runs:read'] };

export function testKeyRegistry(): KeyRegistry {
  return KeyRegistry.fromRecords([
    keyRecordFor(alphaKey, alphaPrincipal),
    keyRecordFor(betaKey, betaPrincipal),
    keyRecordFor(readerKey, readerPrincipal),
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
}

export interface HttpHarness {
  readonly rootDir: string;
  readonly fake: FakeEngine;
  readonly faults: FaultRegistry;
  readonly logs: Record<string, unknown>[];
  readonly service: AgentApi;
  readonly base: string;
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
  const rootDir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-api-http-'));
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
  const serviceOptions: AgentApiOptions = {
    rootDir,
    adapters: { fake, opencode: new OpenCodeAdapter() },
    host: { region: 'sandbox-eu', environment: 'sandbox' },
    faults,
    cancelGraceMs: 500,
    logger,
    ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
  };

  let service = new AgentApi(serviceOptions);
  await service.recover();
  let server = createAgentApiServer(service, { keys, logger, streamPollMs, keepaliveMs, maxBodyBytes });
  let port = await listen(server);

  const harness: HttpHarness = {
    rootDir,
    fake,
    faults,
    logs,
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
      service = new AgentApi(serviceOptions);
      const report = await service.recover();
      server = createAgentApiServer(service, { keys, logger, streamPollMs, keepaliveMs, maxBodyBytes });
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
