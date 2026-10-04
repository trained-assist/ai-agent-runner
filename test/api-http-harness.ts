import { onTestFinished } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateApiKey, KeyRegistry, keyRecordFor, type Principal } from '../src/api/auth.js';
import { createAgentApiServer } from '../src/api/server.js';
import { AgentApi } from '../src/api/service.js';
import { StatelessStore } from '../src/api/stateless-store.js';
import { adapterFor, startMockWorker, type MockWorker, type MockWorkerOptions } from './external-worker-harness.js';

/**
 * HTTP-харнесс stateless API (epic #74). Поднимает мок внешнего воркера, адаптер и сам API —
 * весь путь submit → worker → result → artifacts → logUrl проходит по настоящим сокетам.
 */

export const alphaKey = generateApiKey();
export const betaKey = generateApiKey();
export const readerKey = generateApiKey();
export const noScopeKey = generateApiKey();

export const alphaPrincipal: Principal = {
  principalId: 'p-alpha',
  profileId: 'profile-a',
  scopes: ['runs:read', 'runs:write'],
<<<<<<< HEAD
  engines: ['github-actions-agent-run'],
=======
  engines: ['azure-dynamic-ip-agent-run'],
>>>>>>> 4998441 (rename(worker): основной движок — azure-dynamic-ip-agent-run)
};
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
    await delay(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HttpHarnessOptions {
  worker?: MockWorkerOptions;
  streamPollMs?: number;
  keepaliveMs?: number;
  maxBodyBytes?: number;
  workerToken?: string;
  env?: Record<string, string>;
  store?: StatelessStore;
}

export interface HttpHarness {
  readonly base: string;
  readonly worker: MockWorker;
  readonly service: AgentApi;
  readonly logs: Record<string, unknown>[];
  close(): Promise<void>;
}

export async function startHttpHarness(options: HttpHarnessOptions = {}): Promise<HttpHarness> {
  const worker = await startMockWorker(options.worker ?? {});
  const adapter = adapterFor(worker, {
    ...(options.workerToken !== undefined ? { token: options.workerToken } : {}),
    env: options.env ?? {},
  });
  const logs: Record<string, unknown>[] = [];
  const logger = (entry: Record<string, unknown>): void => {
    logs.push(entry);
  };
  const service = new AgentApi({
    workers: [adapter],
    logger,
    env: options.env ?? {},
    ...(options.store ? { store: options.store } : {}),
  });
  const server = createAgentApiServer(service, {
    keys: testKeyRegistry(),
    logger,
    streamPollMs: options.streamPollMs ?? 10,
    keepaliveMs: options.keepaliveMs ?? 10_000,
    maxBodyBytes: options.maxBodyBytes ?? 1_000_000,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  // Адрес нашего API становится известен только после старта: воркер получает его в
  // `LaunchRequest.resultUrl`, и результат приходит на реальный порт харнесса.
  adapter.setResultBaseUrl(`http://127.0.0.1:${port}`);

  const harness: HttpHarness = {
    base: `http://127.0.0.1:${port}`,
    worker,
    service,
    logs,
    async close() {
      service.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await worker.close();
    },
  };
  onTestFinished(() => harness.close());
  return harness;
}

export function submitBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
<<<<<<< HEAD
    engine: { name: 'github-actions-agent-run', adapterVersion: '1' },
=======
    engine: { name: 'azure-dynamic-ip-agent-run', adapterVersion: '1' },
>>>>>>> 4998441 (rename(worker): основной движок — azure-dynamic-ip-agent-run)
    limits: { timeoutMs: 15000 },
    envAllowlist: [],
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

export async function getResult(base: string, key: string, runId: string): Promise<Response> {
  return fetch(`${base}/v1/runs/${runId}/result`, { headers: authHeader(key) });
}

export async function getArtifacts(base: string, key: string, runId: string): Promise<Response> {
  return fetch(`${base}/v1/runs/${runId}/artifacts`, { headers: authHeader(key) });
}

export async function postCancel(base: string, key: string, runId: string, body: unknown = {}): Promise<Response> {
  return fetch(`${base}/v1/runs/${runId}/cancel`, {
    method: 'POST',
    headers: { ...authHeader(key), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function waitForTerminal(base: string, key: string, runId: string, timeoutMs = 8000): Promise<string> {
  let state = 'queued';
  await waitForAsync(async () => {
    const response = await getStatus(base, key, runId);
    const view = (await response.json()) as { state: string };
    state = view.state;
    return state === 'succeeded' || state === 'failed' || state === 'cancelled';
  }, timeoutMs, `run ${runId} to reach a terminal state`);
  return state;
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

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return (server.address() as AddressInfo).port;
}
