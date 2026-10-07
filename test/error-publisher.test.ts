import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createErrorPublisher,
  getDroppedCount,
  getSpool,
  resolveErrorPublisher,
  runnerEventToErrorEvent,
  type C12ErrorEvent,
} from '../src/contracts/error-publisher.js';
import type { RunnerEvent, RunnerEventType } from '../src/contracts/events.js';
import { createHarness, waitFor } from './helpers.js';

function runnerEvent(type: RunnerEventType, payload: unknown, over: Record<string, unknown> = {}): RunnerEvent {
  return {
    schemaVersion: 1,
    eventId: 'run-1:4',
    runId: 'run-1',
    jobId: 'job-1',
    userTaskId: 'task-1',
    profileId: 'profile-a',
    ownerGeneration: 1,
    sequence: 4,
    timestamp: '2026-10-07T12:00:00.000Z',
    type,
    payload,
    ...over,
  } as RunnerEvent;
}

const FAILED_PAYLOAD = {
  outcome: 'failed',
  exitReason: 'nonzero_exit',
  code: 'ENGINE_EXIT_NONZERO',
  safeSummary: 'engine exited with code 3',
};

function mappedFailed(over: Record<string, unknown> = {}): C12ErrorEvent {
  const mapped = runnerEventToErrorEvent(runnerEvent('failed', FAILED_PAYLOAD, over));
  if (!mapped) throw new Error('failed event must map to a C12 error event');
  return mapped;
}

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Watcher {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

async function startWatcher(statusCode = 202): Promise<Watcher> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.statusCode = statusCode;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/errors`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runnerEventToErrorEvent: маппинг error-событий рана в C12 ErrorEvent', () => {
  it('failed → код и safeSummary из payload, severity error, outcome failed, retryable', () => {
    const mapped = runnerEventToErrorEvent(runnerEvent('failed', FAILED_PAYLOAD));
    expect(mapped).toEqual({
      schemaVersion: 1,
      eventId: 'run-1:4',
      occurredAt: '2026-10-07T12:00:00.000Z',
      source: { service: 'ai-agent-runner', release: 'unknown', environment: 'production' },
      scope: { kind: 'profile', profileId: 'profile-a' },
      correlation: { userTaskId: 'task-1', runId: 'run-1' },
      replyContext: { status: 'not_applicable' },
      error: {
        code: 'ENGINE_EXIT_NONZERO',
        operation: 'failed',
        severity: 'error',
        retryable: true,
        outcome: 'failed',
        safeSummary: 'engine exited with code 3',
      },
      origin: { kind: 'application', diagnosticDepth: 0 },
    });
  });

  it('export_failed → код EXPORT_FAILED, safeSummary = reason', () => {
    const mapped = runnerEventToErrorEvent(
      runnerEvent('export_failed', { sourcePath: 'out/answer.md', reason: 'object storage rejected the upload', version: 2 }),
    );
    expect(mapped?.error).toEqual({
      code: 'EXPORT_FAILED',
      operation: 'export_failed',
      severity: 'error',
      retryable: true,
      outcome: 'failed',
      safeSummary: 'object storage rejected the upload',
    });
    expect(mapped?.eventId).toBe('run-1:4');
  });

  it('connection_lost → код CONNECTION_LOST, outcome unknown', () => {
    const mapped = runnerEventToErrorEvent(
      runnerEvent('connection_lost', { detectedAt: '2026-10-07T12:00:00.000Z', detail: 'engine socket closed', engineAlive: false }),
    );
    expect(mapped?.error).toEqual({
      code: 'CONNECTION_LOST',
      operation: 'connection_lost',
      severity: 'error',
      retryable: true,
      outcome: 'unknown',
      safeSummary: 'engine socket closed',
    });
  });

  it('log c level=error → код RUNNER_LOG_ERROR, outcome unknown', () => {
    const mapped = runnerEventToErrorEvent(
      runnerEvent('log', { stream: 'runner', level: 'error', message: 'profile_workspace.publish_failed' }),
    );
    expect(mapped?.error).toEqual({
      code: 'RUNNER_LOG_ERROR',
      operation: 'log',
      severity: 'error',
      retryable: false,
      outcome: 'unknown',
      safeSummary: 'profile_workspace.publish_failed',
    });
  });

  it('source.environment и source.release берутся из контекста вызова', () => {
    const mapped = runnerEventToErrorEvent(runnerEvent('failed', FAILED_PAYLOAD), {
      environment: 'staging',
      release: '0.3.1',
    });
    expect(mapped?.source).toEqual({ service: 'ai-agent-runner', release: '0.3.1', environment: 'staging' });
  });

  it('не-error события → null', () => {
    const nonErrorEvents: Array<[RunnerEventType, unknown]> = [
      ['claimed', { operationId: 'op-1' }],
      ['started', { pid: 4242 }],
      ['succeeded', { outcome: 'succeeded', exitReason: 'completed', exitCode: 0 }],
      ['cancelled', { outcome: 'cancelled', exitReason: 'cancelled', reason: 'cancelled' }],
      ['exit', { code: 0, signal: null }],
      ['export_committed', { version: 1, status: 'complete', planned: 1, exported: 1, failed: 0, cleanup: 'nothing_to_prune', retained: 0 }],
      ['log', { stream: 'runner', level: 'info', message: 'spawned' }],
      ['log', { stream: 'stderr', level: 'warn', message: 'slow' }],
    ];
    for (const [type, payload] of nonErrorEvents) {
      expect(runnerEventToErrorEvent(runnerEvent(type, payload)), type).toBeNull();
    }
  });
});

describe('createErrorPublisher: публикация в Error Watcher', () => {
  it('POST /errors с x-watcher-key/x-watcher-scopes и телом C12 ErrorEvent', async () => {
    const watcher = await startWatcher();
    try {
      const publisher = createErrorPublisher({ watcherUrl: watcher.url, watcherKey: 'wk-test', environment: 'sandbox-eu' });
      const mapped = mappedFailed();
      await publisher.publishError(mapped);

      const request = watcher.requests[0];
      if (!request) throw new Error('watcher did not receive a request');
      expect(watcher.requests).toHaveLength(1);
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/errors');
      expect(request.headers['x-watcher-key']).toBe('wk-test');
      expect(request.headers['x-watcher-scopes']).toBe('error:write');
      expect(String(request.headers['content-type'])).toContain('application/json');

      const body = JSON.parse(request.body) as C12ErrorEvent;
      expect(body).toEqual({
        ...mapped,
        source: { ...mapped.source, service: 'ai-agent-runner', environment: 'sandbox-eu' },
      });
    } finally {
      await watcher.close();
    }
  });

  it('redact перед публикацией: секреты в safeSummary не уходят наружу', async () => {
    const watcher = await startWatcher();
    try {
      const publisher = createErrorPublisher({ watcherUrl: watcher.url, watcherKey: 'wk-test', environment: 'production' });
      const mapped = runnerEventToErrorEvent(
        runnerEvent('failed', {
          outcome: 'failed',
          exitReason: 'auth_failure',
          code: 'AUTH_REJECTED',
          safeSummary: 'auth failed: token=supersecret123 and sk-abcdefghijkl',
        }),
      );
      if (!mapped) throw new Error('failed event must map');
      await publisher.publishError(mapped);

      const request = watcher.requests[0];
      if (!request) throw new Error('watcher did not receive a request');
      const body = JSON.parse(request.body) as C12ErrorEvent;
      expect(body.error.safeSummary).toContain('[redacted]');
      expect(body.error.safeSummary).not.toContain('supersecret123');
      expect(body.error.safeSummary).not.toContain('sk-abcdefghijkl');
    } finally {
      await watcher.close();
    }
  });

  it('сбой сети: не бросает, инкрементит dropped count и кладёт событие в spool', async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal('fetch', (_input: unknown, init: RequestInit | undefined) => {
      captured = init;
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    const publisher = createErrorPublisher({
      watcherUrl: 'http://127.0.0.1:1/errors',
      watcherKey: 'wk-test',
      environment: 'production',
    });
    const event = mappedFailed({ eventId: 'net-fail:1', runId: 'net-fail' });
    const droppedBefore = getDroppedCount();

    await expect(publisher.publishError(event)).resolves.toBeUndefined();

    expect(getDroppedCount()).toBe(droppedBefore + 1);
    expect(getSpool().some((spooled) => spooled.eventId === 'net-fail:1')).toBe(true);
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
  });

  it('HTTP-ответ не-2xx тоже считается сбоем публикации', async () => {
    const watcher = await startWatcher(500);
    try {
      const publisher = createErrorPublisher({ watcherUrl: watcher.url, watcherKey: 'wk-test', environment: 'production' });
      const event = mappedFailed({ eventId: 'http-500:1', runId: 'http-500' });
      const droppedBefore = getDroppedCount();

      await publisher.publishError(event);

      expect(getDroppedCount()).toBe(droppedBefore + 1);
      expect(getSpool().some((spooled) => spooled.eventId === 'http-500:1')).toBe(true);
    } finally {
      await watcher.close();
    }
  });

  it('spool ограничен 100 записями, остальное уходит в dropped count', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('watcher down')));
    const publisher = createErrorPublisher({
      watcherUrl: 'http://127.0.0.1:1/errors',
      watcherKey: 'wk-test',
      environment: 'production',
    });
    const droppedBefore = getDroppedCount();

    for (let i = 0; i < 105; i += 1) {
      await publisher.publishError(mappedFailed({ eventId: `spool-cap:${i}`, runId: 'spool-cap' }));
    }

    expect(getDroppedCount()).toBe(droppedBefore + 105);
    expect(getSpool()).toHaveLength(100);
  });
});

describe('resolveErrorPublisher: конфигурация из env', () => {
  it('без переменных → null', () => {
    expect(resolveErrorPublisher({})).toBeNull();
    expect(resolveErrorPublisher({ ERROR_WATCHER_URL: '', ERROR_WATCHER_KEY: '' })).toBeNull();
  });

  it('обе переменные → издатель с env-окружением', () => {
    const publisher = resolveErrorPublisher({
      ERROR_WATCHER_URL: 'http://127.0.0.1:9/errors',
      ERROR_WATCHER_KEY: 'wk-env',
      ERROR_WATCHER_ENVIRONMENT: 'staging',
    });
    expect(publisher).not.toBeNull();
    expect(typeof publisher?.publishError).toBe('function');
  });

  it('частичная конфигурация → ошибка, а не тихий null', () => {
    expect(() => resolveErrorPublisher({ ERROR_WATCHER_URL: 'http://127.0.0.1:9/errors' })).toThrow(
      'ERROR_WATCHER_URL and ERROR_WATCHER_KEY must be configured together',
    );
    expect(() => resolveErrorPublisher({ ERROR_WATCHER_KEY: 'wk-env' })).toThrow(
      'ERROR_WATCHER_URL and ERROR_WATCHER_KEY must be configured together',
    );
  });
});

describe('Runner публикует error-события через errorPublisher', () => {
  it('failed-ран публикует один C12 error event, привязанный к runId', async () => {
    const published: C12ErrorEvent[] = [];
    const harness = createHarness({
      scenario: 'nonzero-exit',
      errorPublisher: {
        publishError: async (event) => {
          published.push(event);
        },
      },
    });
    const { receipt, spec } = harness.start();
    const result = await harness.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('failed');

    await waitFor(() => published.some((event) => event.error.outcome === 'failed'), 5000, 'failed event published');
    const event = published.find((entry) => entry.error.outcome === 'failed');
    if (!event) throw new Error('failed event missing');
    expect(event.schemaVersion).toBe(1);
    expect(event.source.service).toBe('ai-agent-runner');
    expect(event.correlation.runId).toBe(receipt.runId);
    expect(event.correlation.userTaskId).toBe(spec.userTaskId);
    expect(event.scope.profileId).toBe('profile-a');
    expect(event.error.code).toBe(result.failure?.code);
    expect(event.error.safeSummary).toBe(result.failure?.safeSummary);
    expect(event.error.severity).toBe('error');
    expect(event.error.outcome).toBe('failed');
  });

  it('успешный ран не порождает failed-outcome событий', async () => {
    const published: C12ErrorEvent[] = [];
    const harness = createHarness({
      errorPublisher: {
        publishError: async (event) => {
          published.push(event);
        },
      },
    });
    const { receipt } = harness.start();
    const result = await harness.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('succeeded');
    expect(published.filter((event) => event.error.outcome === 'failed')).toHaveLength(0);
  });
});
