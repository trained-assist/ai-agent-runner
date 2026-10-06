import { describe, expect, it, onTestFinished } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from '../src/contracts/result.js';
import { type BlobStore, sha256Hex } from '../src/storage/blob-store.js';
import { StorageError } from '../src/storage/errors.js';
import { createLocalFsBlobStore } from '../src/storage/local-fs.js';
import { createHarness, waitFor, type Harness } from './helpers.js';
import {
  alphaKey,
  authHeader,
  betaKey,
  startHttpHarness,
  submitBody,
  waitForAsync,
  type HttpHarness,
} from './api-http-harness.js';

/**
 * Приёмка шага 1 (issue #52): разрешённый ref/снимок материализуется в workspace нового
 * рана, расхождение дайджеста и чужой владелец отказывают и не оставляют байт, а
 * недоступное хранилище даёт повторяемый отказ вместо падения воркера.
 */

function harnessWithSnapshots(over: Parameters<typeof createHarness>[0] = {}): Harness {
  return createHarness({ artifactExport: true, snapshotInputs: true, retainWorkspaces: true, ...over });
}

async function terminal(runner: Harness['runner'], runId: string): Promise<RunResult> {
  await waitFor(() => {
    const state = runner.getRun(runId)?.state;
    return state === 'succeeded' || state === 'failed' || state === 'cancelled';
  }, 10_000, `terminal state of ${runId}`);
  const result = runner.getRun(runId)?.result;
  if (!result) throw new Error(`run ${runId} has no result`);
  return result;
}

function inputsEvent(runner: Harness['runner'], runId: string) {
  const event = runner.events(runId).find((entry) => entry.type === 'inputs_materialized');
  if (!event || event.type !== 'inputs_materialized') throw new Error(`run ${runId} has no inputs_materialized event`);
  return event.payload;
}

function runLogs(runner: Harness['runner'], runId: string): string {
  return runner
    .events(runId)
    .filter((event) => event.type === 'log')
    .map((event) => (event.type === 'log' ? event.payload.message : ''))
    .join('\n');
}

/**
 * Снимок-указатель на артефакт предыдущего рана: байты лежат в хранилище, в снимке только
 * `{ path, artifactId, sha256, size }`. По HTTP то же самое делает маршрут `link`.
 */
async function committedSnapshot(
  h: Harness,
  options: { runId: string; profileId: string; path?: string; bytes?: string; commit?: boolean },
): Promise<{ snapshotId: string; artifactId: string; path: string; bytes: string }> {
  if (!h.artifacts || !h.snapshots) throw new Error('harness without artifact/snapshot stores');
  const path = options.path ?? 'notes.md';
  const bytes = options.bytes ?? 'materialized payload';
  const artifactId = `art-${sha256Hex(`${options.runId}/${path}`).slice(0, 16)}`;
  const manifest = await h.artifacts.put({
    runId: options.runId,
    userTaskId: `task-${options.runId}`,
    profileId: options.profileId,
    name: path.split('/').pop() as string,
    mime: 'text/plain',
    bytes,
    artifactId,
  });
  const snapshot = h.snapshots.create({
    runId: options.runId,
    userTaskId: `task-${options.runId}`,
    profileId: options.profileId,
  });
  h.snapshots.recordArtifact(snapshot.snapshotId, {
    path,
    artifactId: manifest.artifactId,
    sha256: manifest.sha256,
    size: manifest.size,
    name: manifest.name,
    mime: manifest.mime,
  });
  if (options.commit !== false) h.snapshots.commit(snapshot.snapshotId);
  return { snapshotId: snapshot.snapshotId, artifactId: manifest.artifactId, path, bytes };
}

/**
 * Прокси над хранилищем: чтение падает по требованию, запись и head работают. Так
 * проверяется ТРАНЗИЕНТНЫЙ отказ «хранилище недоступно» — не «байтов нет».
 */
function flakyReads(inner: BlobStore): { store: BlobStore; failReads: { value: boolean } } {
  const failReads = { value: false };
  const store: BlobStore = {
    backend: inner.backend,
    put: (key, bytes, options) => inner.put(key, bytes, options),
    head: (key, options) => inner.head(key, options),
    get: async (key, options) => {
      if (failReads.value) throw new StorageError('BLOB_TIMEOUT', `blob get ${key} timed out after 60000ms`);
      return inner.get(key, options);
    },
    ...(inner.shareUrl ? { shareUrl: (key, options) => inner.shareUrl!(key, options) } : {}),
    ...(inner.delete ? { delete: (key, options) => inner.delete!(key, options) } : {}),
  };
  return { store, failReads };
}

describe('materialize snapshot inputs into a new run workspace', () => {
  it('кладёт разрешённый снимок в workspace нового рана и пишет это в журнал', async () => {
    const h = harnessWithSnapshots();
    const source = await committedSnapshot(h, { runId: 'run-prev', profileId: 'profile-a', path: 'docs/notes.md' });

    const { receipt, spec } = h.start({
      input: { refs: [{ ref: 'prior', snapshotId: source.snapshotId }], inlinePrompt: 'work' },
    });
    const result = await terminal(h.runner, receipt.runId);

    expect(result.outcome).toBe('succeeded');
    expect(readFileSync(join(spec.cwd, '.inputs', source.snapshotId, 'docs/notes.md'), 'utf8')).toBe(source.bytes);

    const payload = inputsEvent(h.runner, receipt.runId);
    expect(payload.status).toBe('materialized');
    expect(payload.requested).toBe(1);
    expect(payload.files).toBe(1);
    expect(payload.bytes).toBe(source.bytes.length);
    expect(payload.entries[0]).toMatchObject({ ref: 'prior', snapshotId: source.snapshotId, status: 'materialized' });

    // В журнал рана идут счётчики и идентификаторы, но не содержимое входа.
    const logs = runLogs(h.runner, receipt.runId);
    expect(logs).toContain(`inputs.materialized runId=${receipt.runId} refs=1 files=1 bytes=${source.bytes.length}`);
    expect(logs).not.toContain(source.bytes);
  });

  it('сужает ref до одного файла снимка, если путь объявлен', async () => {
    const h = harnessWithSnapshots();
    const source = await committedSnapshot(h, { runId: 'run-prev', profileId: 'profile-a', path: 'docs/notes.md' });

    const { receipt, spec } = h.start({
      input: { refs: [{ ref: 'prior', snapshotId: source.snapshotId, path: 'docs/notes.md' }] },
    });
    expect((await terminal(h.runner, receipt.runId)).outcome).toBe('succeeded');
    expect(existsSync(join(spec.cwd, '.inputs', source.snapshotId, 'docs/notes.md'))).toBe(true);
  });

  it('checksum mismatch → отказ и НИ ОДНОГО байта в workspace рана', async () => {
    const h = harnessWithSnapshots();
    const source = await committedSnapshot(h, { runId: 'run-prev', profileId: 'profile-a', bytes: 'trusted payload' });

    // Управляемый сбой: байты в хранилище подменены на другие той же длины. Указатель
    // снимка и манифест артефакта продолжают объявлять исходный дайджест.
    const blobPath = join(h.rootDir, 'blobs', 'runs', 'run-prev', 'artifacts', source.artifactId);
    expect(readFileSync(blobPath, 'utf8')).toBe('trusted payload');
    writeFileSync(blobPath, 'tampered payload');
    expect(sha256Hex('tampered payload')).not.toBe(sha256Hex('trusted payload'));

    const { receipt, spec } = h.start({ input: { refs: [{ ref: 'prior', snapshotId: source.snapshotId }] } });
    const result = await terminal(h.runner, receipt.runId);

    expect(result.outcome).toBe('failed');
    expect(result.failure?.code).toBe('MATERIALIZE_BYTES_MISMATCH');
    expect(result.failure?.retryable).toBe(false);
    const payload = inputsEvent(h.runner, receipt.runId);
    expect(payload.status).toBe('refused');
    expect(payload.files).toBe(0);
    expect(payload.entries[0]?.code).toBe('MATERIALIZE_BYTES_MISMATCH');
    expect(String(payload.entries[0]?.reason)).toContain('sha256');
    // Ни файла, ни каталога входов, ни остатка staging: отказ не оставил ничего.
    expect(existsSync(join(spec.cwd, '.inputs'))).toBe(false);
    expect(h.runner.events(receipt.runId).map((event) => event.type)).not.toContain('started');
  });

  it('чужой владелец снимка → отказ без записи байт', async () => {
    const h = harnessWithSnapshots();
    const foreign = await committedSnapshot(h, { runId: 'run-foreign', profileId: 'profile-b', bytes: 'profile-b secret' });

    const { receipt, spec } = h.start({ input: { refs: [{ ref: 'theirs', snapshotId: foreign.snapshotId }] } });
    const result = await terminal(h.runner, receipt.runId);

    expect(result.outcome).toBe('failed');
    expect(result.failure?.code).toBe('MATERIALIZE_REF_FOREIGN');
    expect(result.failure?.retryable).toBe(false);
    expect(existsSync(join(spec.cwd, '.inputs'))).toBe(false);
    const logs = runLogs(h.runner, receipt.runId);
    expect(logs).toContain('MATERIALIZE_REF_FOREIGN');
    expect(logs).not.toContain('profile-b secret');
  });

  it('незакоммиченный снимок — не указатель на байты: отказ', async () => {
    const h = harnessWithSnapshots();
    const source = await committedSnapshot(h, { runId: 'run-prev', profileId: 'profile-a', commit: false });

    const { receipt } = h.start({ input: { refs: [{ ref: 'draft', snapshotId: source.snapshotId }] } });
    const result = await terminal(h.runner, receipt.runId);
    expect(result.failure?.code).toBe('MATERIALIZE_REF_INVALID');
    expect(String(inputsEvent(h.runner, receipt.runId).reason)).toContain('committed');
  });

  it('следующий разрешённый ран видит снимок прошлого и не видит чужих данных', async () => {
    const h = harnessWithSnapshots();
    const mine = await committedSnapshot(h, { runId: 'run-mine', profileId: 'profile-a', bytes: 'my own output' });
    const theirs = await committedSnapshot(h, { runId: 'run-theirs', profileId: 'profile-b', bytes: 'their output' });

    const withRef = h.start({ input: { refs: [{ ref: 'mine', snapshotId: mine.snapshotId }] } });
    expect((await terminal(h.runner, withRef.receipt.runId)).outcome).toBe('succeeded');
    expect(readFileSync(join(withRef.spec.cwd, '.inputs', mine.snapshotId, mine.path), 'utf8')).toBe('my own output');

    // Ран того же профиля без ref'а не видит ничего: чужие байты не достаются «по умолчанию».
    const withoutRef = h.start({ input: { inlinePrompt: 'no inputs' } });
    expect((await terminal(h.runner, withoutRef.receipt.runId)).outcome).toBe('succeeded');
    expect(existsSync(join(withoutRef.spec.cwd, '.inputs'))).toBe(false);

    // Снимок чужого профиля недостижим даже при явном ref'е.
    const foreign = h.start({ input: { refs: [{ ref: 'theirs', snapshotId: theirs.snapshotId }] } });
    expect((await terminal(h.runner, foreign.receipt.runId)).failure?.code).toBe('MATERIALIZE_REF_FOREIGN');
    expect(existsSync(join(foreign.spec.cwd, '.inputs'))).toBe(false);
    expect(existsSync(join(foreign.spec.cwd, '.inputs', theirs.snapshotId))).toBe(false);
  });

  it('недоступное хранилище: повторяемый отказ с причиной, воркер жив, повтор проходит', async () => {
    // Своё хранилище внутри рабочего каталога и управляемый отказ чтения: иначе «нет
    // доступа к байтам» нельзя отличить от «байтов нет».
    const root = scratchRoot('flaky-blob');
    const flaky = flakyReads(createLocalFsBlobStore({ rootDir: join(root, 'blobs') }));
    const h = createHarness({ artifactExport: true, snapshotInputs: true, retainWorkspaces: true, blob: flaky.store, rootDir: root });
    const source = await committedSnapshot(h, { runId: 'run-prev', profileId: 'profile-a' });

    flaky.failReads.value = true;
    const blocked = h.start({ input: { refs: [{ ref: 'prior', snapshotId: source.snapshotId }] } });
    const blockedResult = await terminal(h.runner, blocked.receipt.runId);

    expect(blockedResult.outcome).toBe('failed');
    expect(blockedResult.failure?.code).toBe('MATERIALIZE_REF_UNAVAILABLE');
    expect(blockedResult.failure?.retryable).toBe(true);
    expect(inputsEvent(h.runner, blocked.receipt.runId).status).toBe('unavailable');
    expect(existsSync(join(blocked.spec.cwd, '.inputs'))).toBe(false);
    expect(runLogs(h.runner, blocked.receipt.runId)).toContain('retryable=true');

    // Тот же ref после восстановления хранилища материализуется: отказ был транзиентным.
    flaky.failReads.value = false;
    const retry = h.start({ input: { refs: [{ ref: 'prior', snapshotId: source.snapshotId }] } });
    expect((await terminal(h.runner, retry.receipt.runId)).outcome).toBe('succeeded');
    expect(readFileSync(join(retry.spec.cwd, '.inputs', source.snapshotId, source.path), 'utf8')).toBe(source.bytes);
  });

  it('ref со снимком без настроенного materializer’а отказывается, а не проходит молча', async () => {
    const h = createHarness({ artifactExport: true, retainWorkspaces: true });
    const { receipt } = h.start({ input: { refs: [{ ref: 'prior', snapshotId: 'snap-draft' }] } });
    const result = await terminal(h.runner, receipt.runId);
    expect(result.failure?.code).toBe('MATERIALIZE_REF_INVALID');
    expect(String(inputsEvent(h.runner, receipt.runId).reason)).toContain('no snapshot materializer');
  });

  it('неразрешённый versioned ref отказывается до запуска движка, а не считается пустым входом', async () => {
    const h = harnessWithSnapshots();
    const { receipt, spec } = h.start({ input: { inlinePrompt: 'process the upload', refs: [{ ref: 'ingress-media-1', version: 'v1' }] } });
    const result = await terminal(h.runner, receipt.runId);

    expect(result.outcome).toBe('failed');
    expect(result.failure?.code).toBe('MATERIALIZE_REF_INVALID');
    expect(result.failure?.retryable).toBe(false);
    expect(inputsEvent(h.runner, receipt.runId)).toMatchObject({
      status: 'refused',
      declared: 1,
      requested: 1,
      files: 0,
      bytes: 0,
      entries: [{ ref: 'ingress-media-1', status: 'refused', code: 'MATERIALIZE_REF_INVALID' }],
    });
    expect(existsSync(join(spec.cwd, '.inputs'))).toBe(false);
    expect(h.runner.events(receipt.runId).map((event) => event.type)).not.toContain('started');
  });

  it('путь без snapshotId и некорректный snapshotId не проходят контракт', () => {
    const h = harnessWithSnapshots();
    expect(() => h.makeSpec({ input: { refs: [{ ref: 'prior', path: 'notes.md' }] } })).toThrow(/requires snapshotId/);
    expect(() => h.makeSpec({ input: { refs: [{ ref: 'prior', snapshotId: '../escape' }] } })).toThrow(/snapshotId/);
    expect(() => h.makeSpec({ input: { refs: [{ ref: 'prior', snapshotId: 'snap-1', path: '../escape' }] } })).toThrow(/path/);
  });
});

describe('snapshot store as a pointer to durable bytes', () => {
  it('link хранит указатель, а отвергает небезопасный путь и чужой дайджест', async () => {
    const h = harnessWithSnapshots();
    const store = h.snapshots;
    if (!store || !h.artifacts) throw new Error('harness without stores');
    const source = await committedSnapshot(h, { runId: 'run-prev', profileId: 'profile-a', commit: false });

    expect(store.get(source.snapshotId)?.artifacts).toHaveLength(1);
    expect(store.get(source.snapshotId)?.artifacts[0]).toMatchObject({
      path: source.path,
      artifactId: source.artifactId,
      sha256: sha256Hex(source.bytes),
      size: source.bytes.length,
    });

    const draft = store.create({ runId: 'run-prev', userTaskId: 'task-run-prev', profileId: 'profile-a' });
    const link = {
      artifactId: source.artifactId,
      sha256: sha256Hex(source.bytes),
      size: source.bytes.length,
      name: 'notes.md',
      mime: 'text/plain',
    };
    expect(() => store.recordArtifact(draft.snapshotId, { ...link, path: '../escape.md' })).toThrow(StorageError);
    expect(() => store.recordArtifact(draft.snapshotId, { ...link, path: 'notes.md', sha256: 'not-a-digest' })).toThrow(
      /sha256/,
    );
  });

  it('снимок без указателей на байты не материализует «ничего» молча', async () => {
    const h = harnessWithSnapshots();
    if (!h.snapshots) throw new Error('harness without snapshots');
    const empty = h.snapshots.create({ runId: 'run-empty', userTaskId: 'task-run-empty', profileId: 'profile-a' });
    h.snapshots.commit(empty.snapshotId);

    const { receipt } = h.start({ input: { refs: [{ ref: 'empty', snapshotId: empty.snapshotId }] } });
    const result = await terminal(h.runner, receipt.runId);
    expect(result.failure?.code).toBe('MATERIALIZE_REF_INVALID');
    expect(String(inputsEvent(h.runner, receipt.runId).reason)).toContain('no materialized artifacts');
  });

  it('снимок без указателей на байты читается как снимок (обратная совместимость записи)', async () => {
    const h = harnessWithSnapshots();
    const store = h.snapshots;
    if (!store) throw new Error('harness without snapshots');
    const legacy = store.create({ runId: 'run-legacy', userTaskId: 'task-run-legacy', profileId: 'profile-a' });
    const path = join(h.rootDir, 'snapshots', `${legacy.snapshotId}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete raw['artifacts'];
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    expect(store.get(legacy.snapshotId)?.artifacts).toEqual([]);
  });
});

let scratchCounter = 0;

/** Каталог состояния теста: только внутри рабочего дерева репозитория. */
function scratchRoot(name: string): string {
  scratchCounter += 1;
  const root = join(process.cwd(), '_scratch', `test-${name}-${process.pid}-${scratchCounter}`);
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

interface HttpEvents {
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

async function runEvents(api: HttpHarness, key: string, runId: string): Promise<HttpEvents> {
  const response = await fetch(`${api.base}/v1/runs/${runId}/events?cursor=0&limit=200`, { headers: authHeader(key) });
  return (await response.json()) as HttpEvents;
}

async function postJson(api: HttpHarness, key: string, path: string, body: unknown, idempotencyKey?: string): Promise<Response> {
  const headers: Record<string, string> = { ...authHeader(key), 'content-type': 'application/json' };
  if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
  return fetch(`${api.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function submitRun(api: HttpHarness, key: string, idempotencyKey: string, body: unknown): Promise<string> {
  const response = await fetch(`${api.base}/v1/runs`, {
    method: 'POST',
    headers: { ...authHeader(key), 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { runId?: string };
  if (!payload.runId) throw new Error(`submit failed: ${response.status}`);
  return payload.runId;
}
