import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateApiKey,
  hashApiKey,
  KeyRegistry,
  keyRecordFor,
  RUN_SCOPES,
  type Principal,
} from '../src/api/auth.js';
import {
  submitPayloadHash,
  validateCancelRequest,
  validateIdempotencyKey,
  validateSubmitRequest,
} from '../src/api/contracts.js';
import { ApiStore, type AdmissionRecord } from '../src/api/store.js';
import { ApiError } from '../src/api/errors.js';
import { makeRunSpec } from './helpers.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ai-agent-runner-api-'));
}

describe('api key registry', () => {
  const principal: Principal = { principalId: 'p-alpha', profileId: 'profile-a', scopes: ['runs:read', 'runs:write'], engines: ['fake'] };

  it('generates keys that are never the plaintext stored in records', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^ak_[0-9a-f]{48}$/);
    const record = keyRecordFor(key, principal);
    expect(record.keyHash).toBe(hashApiKey(key));
    expect(record.keyHash).not.toContain(key);
    expect(record.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(generateApiKey()).not.toBe(key);
  });

  it('authenticates a bearer key and returns an isolated principal copy', () => {
    const key = generateApiKey();
    const registry = KeyRegistry.fromRecords([keyRecordFor(key, principal), keyRecordFor(generateApiKey(), { principalId: 'p-beta', profileId: 'profile-b', scopes: ['runs:read'] })]);

    const found = registry.authenticate(`Bearer ${key}`);
    expect(found).toMatchObject({ principalId: 'p-alpha', profileId: 'profile-a', scopes: ['runs:read', 'runs:write'], engines: ['fake'] });
    found!.scopes.push('runs:read');
    const again = registry.authenticate(`Bearer ${key}`);
    expect(again!.scopes).toEqual(['runs:read', 'runs:write']);

    expect(registry.authenticate('Bearer ak_deadbeef')).toBeNull();
    expect(registry.authenticate('Basic whatever')).toBeNull();
    expect(registry.authenticate('Bearer ')).toBeNull();
    expect(registry.authenticate(undefined)).toBeNull();
    expect(registry.authenticate('')).toBeNull();
  });

  it('loads a hashed key file and fails fast on a malformed one', () => {
    const dir = tempDir();
    try {
      const key = generateApiKey();
      const path = join(dir, 'keys.json');
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, principals: [keyRecordFor(key, principal)] }));
      const loaded = KeyRegistry.loadFile(path);
      expect(loaded.authenticate(`Bearer ${key}`)).toMatchObject({ principalId: 'p-alpha' });
      expect(loaded.size()).toBe(1);

      writeFileSync(path, '{ not json');
      expect(() => KeyRegistry.loadFile(path)).toThrow();

      writeFileSync(path, JSON.stringify({ schemaVersion: 1, principals: [{ principalId: 'x' }] }));
      expect(() => KeyRegistry.loadFile(path)).toThrow(/invalid keyHash/);

      expect(KeyRegistry.loadFile(join(dir, 'missing.json')).size()).toBe(0);
      expect(RUN_SCOPES).toEqual(['runs:read', 'runs:write']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('submit contract validation', () => {
  const validBody = {
    engine: { name: 'fake', adapterVersion: '1' },
    limits: { timeoutMs: 5000 },
    input: { inlinePrompt: 'do the thing' },
    envAllowlist: [],
  };

  it('accepts a minimal typed job and keeps optional fields', () => {
    const result = validateSubmitRequest({ ...validBody, userTaskId: 'task-client-1', conversationId: 'conv-1', instructions: 'save each step', traceId: 'trace-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.userTaskId).toBe('task-client-1');
    expect(result.value.instructions).toBe('save each step');
    expect(result.value.engine).toEqual({ name: 'fake', adapterVersion: '1' });
    expect(result.value.limits).toEqual({ timeoutMs: 5000 });
  });

  it('rejects missing engine, unknown server-owned fields and bad types', () => {
    expect(validateSubmitRequest({ limits: { timeoutMs: 1000 } })).toMatchObject({ ok: false });
    const missing = validateSubmitRequest({ limits: { timeoutMs: 1000 } });
    expect(!missing.ok && missing.errors.join(' ')).toContain('missing required field "engine"');

    const unknown = validateSubmitRequest({ ...validBody, runId: 'run_hijack', cwd: '/etc' });
    expect(!unknown.ok && unknown.errors.join(' ')).toContain('unknown field "runId"');
    expect(!unknown.ok && unknown.errors.join(' ')).toContain('unknown field "cwd"');

    const badType = validateSubmitRequest({ ...validBody, userTaskId: 42 });
    expect(!badType.ok && badType.errors.join(' ')).toContain('request.userTaskId');

    const badLimits = validateSubmitRequest({ ...validBody, limits: { timeoutMs: -1 } });
    expect(!badLimits.ok && badLimits.errors.join(' ')).toContain('request.limits.timeoutMs');
  });

  it('produces a payload hash independent of key order but sensitive to values', () => {
    const a = validateSubmitRequest(validBody);
    const b = validateSubmitRequest({ input: { inlinePrompt: 'do the thing' }, envAllowlist: [], limits: { timeoutMs: 5000 }, engine: { adapterVersion: '1', name: 'fake' } });
    const c = validateSubmitRequest({ ...validBody, limits: { timeoutMs: 6000 } });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(submitPayloadHash(a.value)).toBe(submitPayloadHash(b.value));
    expect(submitPayloadHash(c.value)).not.toBe(submitPayloadHash(a.value));
  });

  it('validates cancel bodies and idempotency keys', () => {
    expect(validateCancelRequest({})).toEqual({ ok: true, value: {} });
    expect(validateCancelRequest({ ownerGeneration: 2, reason: 'client stop' })).toEqual({ ok: true, value: { ownerGeneration: 2, reason: 'client stop' } });
    expect(validateCancelRequest({ ownerGeneration: -1 }).ok).toBe(false);
    expect(validateCancelRequest({ ownerGeneration: '2' }).ok).toBe(false);

    expect(validateIdempotencyKey('key-1')).toEqual({ ok: true, value: 'key-1' });
    expect(validateIdempotencyKey(undefined).ok).toBe(false);
    expect(validateIdempotencyKey('bad\u0000key').ok).toBe(false);
  });
});

describe('admission store durability', () => {
  function record(over: Partial<AdmissionRecord> = {}): AdmissionRecord {
    const spec = makeRunSpec();
    return {
      schemaVersion: 1,
      requestId: 'req_1',
      userTaskId: 'task-1',
      principalId: 'p-alpha',
      jobId: 'job_1',
      idempotencyKey: 'idem-1',
      payloadHash: 'hash-1',
      runId: spec.runId,
      operationId: spec.operationId,
      ownerGeneration: 1,
      spec,
      createdAt: new Date().toISOString(),
      ...over,
    };
  }

  it('indexes admissions by key, run and task, and survives reopen', () => {
    const dir = tempDir();
    try {
      const store = new ApiStore(dir);
      store.init();
      const first = record();
      store.put(first);
      expect(store.getByAdmission('p-alpha', 'idem-1')).toMatchObject({ runId: first.runId });
      expect(store.getByAdmission('p-beta', 'idem-1')).toBeNull();
      expect(store.getByRun(first.runId)).toMatchObject({ requestId: 'req_1' });
      expect(store.currentAttempt('p-alpha', 'task-1')).toMatchObject({ ownerGeneration: 1 });

      const secondSpec = makeRunSpec();
      const second = record({
        idempotencyKey: 'idem-2',
        payloadHash: 'hash-2',
        runId: secondSpec.runId,
        operationId: secondSpec.operationId,
        ownerGeneration: 2,
        spec: secondSpec,
      });
      store.put(second);
      expect(store.attempts('p-alpha', 'task-1').map((entry) => entry.ownerGeneration)).toEqual([1, 2]);
      expect(store.currentAttempt('p-alpha', 'task-1')).toMatchObject({ runId: secondSpec.runId });
      expect(store.listAll()).toHaveLength(2);

      const reopened = new ApiStore(dir);
      reopened.init();
      expect(reopened.getByAdmission('p-alpha', 'idem-1')).toMatchObject({ runId: first.runId });
      expect(reopened.currentAttempt('p-alpha', 'task-1')).toMatchObject({ ownerGeneration: 2 });
      expect(reopened.getByRun(secondSpec.runId)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed store file instead of silently losing admissions', () => {
    const dir = tempDir();
    try {
      const store = new ApiStore(dir);
      store.init();
      store.put(record());
      const path = join(dir, 'api', 'admissions.json');
      writeFileSync(path, '{"schemaVersion":99,"admissions":[]}');
      expect(() => new ApiStore(dir).init()).toThrow(/schemaVersion/);
      writeFileSync(path, 'nope');
      expect(() => new ApiStore(dir).init()).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('structured api errors', () => {
  it('maps codes to http statuses and never leaks raw secrets in messages', () => {
    const err = new ApiError('UNAUTHENTICATED', 'missing key ak_supersecretvalue');
    expect(err.status).toBe(401);
    expect(err.body()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'missing key ak_supersecretvalue' } });
    expect(new ApiError('IDEMPOTENCY_CONFLICT', 'conflict').status).toBe(409);
    expect(new ApiError('RESULT_NOT_READY', 'busy').status).toBe(409);
    expect(new ApiError('SCOPE_DENIED', 'no scope').status).toBe(403);
  });
});
