import { redactSecrets } from '../redact.js';
import type { RunnerEvent } from './events.js';

export interface C12ErrorEvent {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  source: { service: string; release: string; environment: string };
  scope: { kind: string; tenantId?: string; profileId?: string };
  correlation: { userTaskId: string; runId: string; traceId?: string };
  replyContext: { channel?: string; destinationRef?: string; status: string };
  error: {
    code: string;
    operation: string;
    severity: 'error' | 'warning' | 'info';
    retryable: boolean;
    outcome: 'failed' | 'unknown';
    safeSummary: string;
    privateDetailsRef?: string;
  };
  origin: { kind: string; incidentId?: string; diagnosticDepth: number };
}

export interface ErrorPublisher {
  publishError(event: C12ErrorEvent): Promise<void>;
}

export interface ErrorEventSourceContext {
  environment?: string;
  release?: string;
}

export interface ErrorPublisherOptions {
  watcherUrl: string;
  watcherKey: string;
  environment: string;
}

const SPOOL_MAX_ENTRIES = 100;
const PUBLISH_TIMEOUT_MS = 5000;
const WATCHER_SCOPES = 'error:write';
const RUNNER_SERVICE = 'ai-agent-runner';

let spool: C12ErrorEvent[] = [];
let droppedCount = 0;

export function getDroppedCount(): number {
  return droppedCount;
}

export function getSpool(): C12ErrorEvent[] {
  return [...spool];
}

export function runnerEventToErrorEvent(event: RunnerEvent, source: ErrorEventSourceContext = {}): C12ErrorEvent | null {
  const error = errorPayloadFor(event);
  if (!error) return null;
  return {
    schemaVersion: 1,
    eventId: event.eventId,
    occurredAt: event.timestamp,
    source: {
      service: RUNNER_SERVICE,
      release: source.release ?? 'unknown',
      environment: source.environment ?? 'production',
    },
    scope: { kind: 'profile', profileId: event.profileId },
    correlation: { userTaskId: event.userTaskId, runId: event.runId },
    replyContext: { status: 'not_applicable' },
    error,
    origin: { kind: 'application', diagnosticDepth: 0 },
  };
}

function errorPayloadFor(event: RunnerEvent): C12ErrorEvent['error'] | null {
  switch (event.type) {
    case 'failed':
      return {
        code: event.payload.code,
        operation: event.type,
        severity: 'error',
        retryable: true,
        outcome: 'failed',
        safeSummary: event.payload.safeSummary,
      };
    case 'export_failed':
      return {
        code: 'EXPORT_FAILED',
        operation: event.type,
        severity: 'error',
        retryable: true,
        outcome: 'failed',
        safeSummary: event.payload.reason,
      };
    case 'connection_lost':
      return {
        code: 'CONNECTION_LOST',
        operation: event.type,
        severity: 'error',
        retryable: true,
        outcome: 'unknown',
        safeSummary: event.payload.detail,
      };
    case 'log':
      if (event.payload.level !== 'error') return null;
      return {
        code: 'RUNNER_LOG_ERROR',
        operation: event.type,
        severity: 'error',
        retryable: false,
        outcome: 'unknown',
        safeSummary: event.payload.message,
      };
    default:
      return null;
  }
}

export function createErrorPublisher(options: ErrorPublisherOptions): ErrorPublisher {
  return {
    async publishError(event: C12ErrorEvent): Promise<void> {
      try {
        const response = await fetch(options.watcherUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-watcher-key': options.watcherKey,
            'x-watcher-scopes': WATCHER_SCOPES,
          },
          body: JSON.stringify(redactEvent({
            ...event,
            source: { ...event.source, service: RUNNER_SERVICE, environment: options.environment },
          })),
          signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
        });
        if (!response.ok) spoolEvent(event);
      } catch {
        spoolEvent(event);
      }
    },
  };
}

export function resolveErrorPublisher(env: Record<string, string | undefined>): ErrorPublisher | null {
  const watcherUrl = env['ERROR_WATCHER_URL']?.trim();
  const watcherKey = env['ERROR_WATCHER_KEY']?.trim();
  if (!watcherUrl && !watcherKey) return null;
  if (!watcherUrl || !watcherKey) {
    throw new Error('ERROR_WATCHER_URL and ERROR_WATCHER_KEY must be configured together');
  }
  return createErrorPublisher({
    watcherUrl,
    watcherKey,
    environment: env['ERROR_WATCHER_ENVIRONMENT']?.trim() || 'production',
  });
}

function spoolEvent(event: C12ErrorEvent): void {
  spool.push(event);
  if (spool.length > SPOOL_MAX_ENTRIES) spool.shift();
  droppedCount += 1;
}

function redactEvent(event: C12ErrorEvent): C12ErrorEvent {
  return redactValue(event) as C12ErrorEvent;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]));
  }
  return value;
}
