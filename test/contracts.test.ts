import { describe, expect, it } from 'vitest';
import { RUNNER_EVENT_TYPES, validateRunnerEvent, type RunnerEventType } from '../src/contracts/events.js';
import { validateRunResult } from '../src/contracts/result.js';
import { validateRunSpec } from '../src/contracts/run-spec.js';

function validSpec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    jobId: 'job-1',
    runId: 'run-1',
    operationId: 'op-1',
    userTaskId: 'task-1',
    profileId: 'profile-a',
    conversationId: 'conv-1',
    ownerGeneration: 1,
    engine: { name: 'fake', adapterVersion: '1' },
    cwd: '/tmp/ws/run-1',
    envAllowlist: ['PATH'],
    limits: { timeoutMs: 5000 },
    ...over,
  };
}

const EVENT_PAYLOADS: Record<RunnerEventType, unknown> = {
  claimed: { operationId: 'op-1' },
  materialized: { inputs: 2 },
  started: { pid: 4242 },
  log: { stream: 'stdout', level: 'info', message: 'hello' },
  exit: { code: 0, signal: null },
  finalizing: { reason: 'engine_exit' },
  artifact_exported: {
    artifactId: 'art-1',
    sourcePath: 'out/report.txt',
    size: 14,
    sha256: 'a'.repeat(64),
    mime: 'text/plain',
    version: 2,
  },
  export_committed: {
    version: 2,
    status: 'complete',
    planned: 1,
    exported: 1,
    failed: 0,
    cleanup: 'pruned',
    retained: 0,
  },
  export_failed: { sourcePath: 'out/big.bin', reason: 'blob put timed out after 60000ms', version: 1 },
  succeeded: { outcome: 'succeeded', exitReason: 'completed', exitCode: 0 },
  failed: { outcome: 'failed', exitReason: 'timeout', code: 'TIMEOUT', safeSummary: 'run exceeded limits' },
  cancelled: { outcome: 'cancelled', exitReason: 'cancelled', reason: 'cancelled' },
  connection_lost: { detectedAt: '2026-10-01T10:00:00.000Z', detail: 'partition', engineAlive: true },
  isolation_prepared: {
    slotId: 'ta-agent-1',
    username: 'ta-agent-1',
    uid: 999,
    gid: 988,
    acl: 'posix_0700',
    probe: { checks: 4, failures: 0 },
  },
  agent_exit_resolved: {
    manifest: 'ok',
    declared: 1,
    fromManifest: 2,
    answerSource: 'agent_file',
    answerChars: 128,
    planned: 4,
    reason: 'final manifest declares 2 output(s)',
  },
  agent_answer_saved: { artifactId: 'art-1', source: 'agent_file', chars: 128, size: 128 },
  checkpoint_written: {
    phase: 'cleanup_pending',
    persistence: 'persisted',
    cleanup: 'pending',
    outputRefs: 1,
    reason: 'cleanup intent recorded before sweep',
  },
};

function validEvent(type: RunnerEventType, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: 'run-1:1',
    runId: 'run-1',
    jobId: 'job-1',
    userTaskId: 'task-1',
    profileId: 'profile-a',
    ownerGeneration: 1,
    sequence: 1,
    timestamp: '2026-10-01T10:00:00.000Z',
    type,
    payload: EVENT_PAYLOADS[type],
    ...over,
  };
}

function validResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    jobId: 'job-1',
    userTaskId: 'task-1',
    profileId: 'profile-a',
    ownerGeneration: 1,
    outcome: 'succeeded',
    exitReason: 'completed',
    exitCode: 0,
    exitSignal: null,
    exitObserved: true,
    startedAt: '2026-10-01T10:00:00.000Z',
    finishedAt: '2026-10-01T10:00:01.000Z',
    usage: { status: 'unknown' },
    outputRefs: [],
    persistence: 'persisted',
    cleanup: 'completed',
    logPath: 'runs/run-1/events.jsonl',
    ...over,
  };
}

describe('validateRunSpec', () => {
  it('accepts a minimal valid spec', () => {
    const result = validateRunSpec(validSpec());
    expect(result.ok).toBe(true);
  });

  it('accepts full groups from ARCHITECTURE §5', () => {
    const result = validateRunSpec(
      validSpec({
        deadline: '2026-10-01T11:00:00.000Z',
        input: { refs: [{ ref: 'blob:docs/1', version: 'v3' }], inlinePrompt: 'do the work' },
        isolation: { mode: 'none' },
        regionConstraints: { allowedRegions: ['sandbox-eu'] },
        credentialBindings: [{ ref: 'cred-1', scope: 'llm:call', status: 'active', expiresAt: '2026-12-01T00:00:00.000Z' }],
        budget: { correlationRef: 'budget-1', approved: true },
        result: { destinationRef: 'dest-1', retentionPolicy: '30d' },
        traceId: 'trace-1',
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = validateRunSpec({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('jobId');
      expect(result.errors.join(' ')).toContain('runId');
      expect(result.errors.join(' ')).toContain('ownerGeneration');
    }
  });

  it('rejects unknown top-level fields (secrets cannot enter the spec)', () => {
    const result = validateRunSpec(validSpec({ apiKey: 'sk-nope' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('apiKey');
  });

  it('rejects secret-like nested fields', () => {
    const result = validateRunSpec(validSpec({ engine: { name: 'fake', adapterVersion: '1', accessToken: 'x' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('accessToken');
  });

  it('rejects relative cwd', () => {
    const result = validateRunSpec(validSpec({ cwd: 'relative/path' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('absolute');
  });

  it('rejects env allowlist entries with values', () => {
    const result = validateRunSpec(validSpec({ envAllowlist: ['FOO=bar'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('envAllowlist[0]');
  });

  it('rejects path-unsafe runId', () => {
    const result = validateRunSpec(validSpec({ runId: '../escape' }));
    expect(result.ok).toBe(false);
  });

  it('rejects non-positive limits.timeoutMs', () => {
    const result = validateRunSpec(validSpec({ limits: { timeoutMs: 0 } }));
    expect(result.ok).toBe(false);
  });

  it('accepts a repository group with owner/name and optional token', () => {
    const result = validateRunSpec(validSpec({ repository: { fullName: 'owner/name', token: 'ghs_abcdef0123456789' } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.repository).toEqual({ fullName: 'owner/name', token: 'ghs_abcdef0123456789' });
  });

  it('treats an empty repository group as the default-repository mode', () => {
    const result = validateRunSpec(validSpec({ repository: {} }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.repository).toBeUndefined();
  });

  it('rejects malformed repository fullName', () => {
    for (const fullName of ['owner', 'a/b/c', 'no-slash', '../evil', 'owner/', '/name', 'a/../b']) {
      const result = validateRunSpec(validSpec({ repository: { fullName } }));
      expect(result.ok, `fullName "${fullName}" must be rejected`).toBe(false);
      if (!result.ok) expect(result.errors.join(' ')).toContain('spec.repository.fullName');
    }
  });

  it('rejects an empty or oversized repository token', () => {
    const empty = validateRunSpec(validSpec({ repository: { fullName: 'owner/name', token: '' } }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors.join(' ')).toContain('spec.repository.token');

    const oversized = validateRunSpec(validSpec({ repository: { fullName: 'owner/name', token: 'x'.repeat(501) } }));
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.errors.join(' ')).toContain('spec.repository.token');
  });

  it('rejects unknown fields inside the repository group', () => {
    const result = validateRunSpec(validSpec({ repository: { fullName: 'owner/name', passphrase: 'x' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('unknown field "passphrase"');
  });
});

describe('validateRunnerEvent', () => {
  for (const type of RUNNER_EVENT_TYPES) {
    it(`accepts a valid "${type}" event`, () => {
      const result = validateRunnerEvent(validEvent(type));
      expect(result.ok).toBe(true);
    });
  }

  it('rejects an unknown event type', () => {
    const result = validateRunnerEvent(validEvent('claimed', { type: 'exploded' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a non-UTC timestamp', () => {
    const result = validateRunnerEvent(validEvent('claimed', { timestamp: '2026-10-01T10:00:00+02:00' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a missing envelope field', () => {
    const event = validEvent('claimed');
    delete event['sequence'];
    const result = validateRunnerEvent(event);
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid payload for the type', () => {
    const result = validateRunnerEvent(validEvent('started', { payload: { pid: -1 } }));
    expect(result.ok).toBe(false);
  });
});

describe('validateRunResult', () => {
  it('accepts a valid succeeded result', () => {
    expect(validateRunResult(validResult()).ok).toBe(true);
  });

  it('accepts a valid failed result with structured failure', () => {
    const result = validateRunResult(
      validResult({
        outcome: 'failed',
        exitReason: 'preflight_refused',
        exitCode: null,
        exitObserved: false,
        failure: { code: 'BUDGET_UNAVAILABLE', failureClass: 'preflight', safeSummary: 'no budget', retryable: true },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a failed outcome without a failure block', () => {
    const result = validateRunResult(validResult({ outcome: 'failed', exitReason: 'timeout' }));
    expect(result.ok).toBe(false);
  });

  it('rejects succeeded outcome carrying a failure block', () => {
    const result = validateRunResult(
      validResult({ failure: { code: 'X', failureClass: 'engine', safeSummary: 's', retryable: false } }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects mismatched outcome and exitReason', () => {
    const result = validateRunResult(validResult({ exitReason: 'timeout' }));
    expect(result.ok).toBe(false);
  });

  it('rejects known usage without usd', () => {
    const result = validateRunResult(validResult({ usage: { status: 'known' } }));
    expect(result.ok).toBe(false);
  });
});
