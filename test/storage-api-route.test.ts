import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { KeyRegistry, generateApiKey, hashApiKey, type KeyRecord } from '../src/api/auth.js';
import { createArtifactServer } from '../src/api/artifact-route.js';
import { ArtifactStore } from '../src/storage/artifact-store.js';
import { sha256Hex } from '../src/storage/blob-store.js';
import { createLocalFsBlobStore } from '../src/storage/local-fs.js';
import { ShareTokenIssuer } from '../src/storage/share.js';

const artifactsOfProfileA = 'artifact alpha contents';
const artifactsOfProfileB = 'artifact beta contents';

let tempRoot = '';
let server: Server;
let baseUrl = '';
let artifacts: ArtifactStore;
let tokens: ShareTokenIssuer;
let tokenA = '';
const logs: Record<string, unknown>[] = [];

function key(name: string, profileId: string, scopes: KeyRecord['scopes']): { key: string; record: KeyRecord } {
  const key = generateApiKey();
  return { key, record: { keyHash: hashApiKey(key), principalId: name, profileId, scopes } };
}

const keyA = key('principal-a', 'profile-a', ['runs:read']);
const keyB = key('principal-b', 'profile-b', ['runs:read']);
const keyWriter = key('principal-writer', 'profile-a', ['runs:write']);

function auth(entry: { key: string }): Record<string, string> {
  return { authorization: `Bearer ${entry.key}` };
}

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'storage-api-route-'));
  const blob = createLocalFsBlobStore({ rootDir: join(tempRoot, 'blobs') });
  artifacts = new ArtifactStore({ rootDir: tempRoot, blob });
  await artifacts.put({
    runId: 'run-1',
    userTaskId: 'task-1',
    profileId: 'profile-a',
    name: 'report.txt',
    mime: 'text/plain',
    bytes: artifactsOfProfileA,
    artifactId: 'art-a',
  });
  await artifacts.put({
    runId: 'run-2',
    userTaskId: 'task-2',
    profileId: 'profile-b',
    name: 'second.bin',
    mime: 'application/octet-stream',
    bytes: artifactsOfProfileB,
    artifactId: 'art-b',
  });

  tokens = new ShareTokenIssuer({ secret: 'route-secret', ttlSeconds: 600 });
  tokenA = tokens.issue('art-a').token;

  server = createArtifactServer({
    artifacts,
    keys: KeyRegistry.fromRecords([keyA.record, keyB.record, keyWriter.record]),
    tokens,
    logger: (entry) => logs.push(entry),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('artifact download route', () => {
  it('serves bytes to a share-token holder with integrity headers', async () => {
    const res = await fetch(`${baseUrl}/v1/artifacts/art-a?t=${encodeURIComponent(tokenA)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('x-artifact-sha256')).toBe(sha256Hex(artifactsOfProfileA));
    expect(res.headers.get('etag')).toBe(`"${sha256Hex(artifactsOfProfileA)}"`);
    expect(res.headers.get('content-disposition')).toContain('report.txt');
    expect(await res.text()).toBe(artifactsOfProfileA);
  });

  it('accepts the short /artifact/:id alias', async () => {
    const res = await fetch(`${baseUrl}/artifact/art-a?t=${encodeURIComponent(tokenA)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(artifactsOfProfileA);
  });

  it('rejects a token issued for another artifact', async () => {
    const res = await fetch(`${baseUrl}/v1/artifacts/art-b?t=${encodeURIComponent(tokenA)}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('rejects an expired share token', async () => {
    const expiring = tokens.issue('art-a', { ttlSeconds: 0.001 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const res = await fetch(`${baseUrl}/v1/artifacts/art-a?t=${encodeURIComponent(expiring.token)}`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a valid token on an unknown artifact', async () => {
    const unknown = tokens.issue('art-none').token;
    const res = await fetch(`${baseUrl}/v1/artifacts/art-none?t=${encodeURIComponent(unknown)}`);
    expect(res.status).toBe(404);
  });

  it('serves the manifest as meta without any share url', async () => {
    const res = await fetch(`${baseUrl}/v1/artifacts/art-a/meta`, { headers: auth(keyA) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ artifactId: 'art-a', runId: 'run-1', profileId: 'profile-a', storageKey: 'runs/run-1/artifacts/art-a' });
    expect(Object.keys(body)).toEqual([
      'artifactId',
      'runId',
      'userTaskId',
      'profileId',
      'name',
      'mime',
      'size',
      'sha256',
      'storageKey',
      'createdAt',
    ]);
    expect(JSON.stringify(body)).not.toContain('?t=');
    expect(JSON.stringify(body)).not.toContain('http');
  });

  it('authenticates api keys and enforces the profile scope', async () => {
    const own = await fetch(`${baseUrl}/v1/artifacts/art-a`, { headers: auth(keyA) });
    expect(own.status).toBe(200);
    expect(await own.text()).toBe(artifactsOfProfileA);

    const foreign = await fetch(`${baseUrl}/v1/artifacts/art-a`, { headers: auth(keyB) });
    expect(foreign.status).toBe(404);

    const wrongScope = await fetch(`${baseUrl}/v1/artifacts/art-a`, { headers: auth(keyWriter) });
    expect(wrongScope.status).toBe(403);
    expect(await wrongScope.json()).toMatchObject({ error: { code: 'SCOPE_DENIED' } });
  });

  it('refuses anonymous and malformed requests', async () => {
    const anonymous = await fetch(`${baseUrl}/v1/artifacts/art-a`);
    expect(anonymous.status).toBe(401);

    const noTokenParam = await fetch(`${baseUrl}/v1/artifacts/art-a?t=`);
    expect(noTokenParam.status).toBe(401);

    const deep = await fetch(`${baseUrl}/v1/artifacts/art-a/extra?t=${encodeURIComponent(tokenA)}`);
    expect(deep.status).toBe(404);
    expect(await deep.json()).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });

    const post = await fetch(`${baseUrl}/v1/artifacts/art-a?t=${encodeURIComponent(tokenA)}`, { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it('leaves foreign routes to the host server', async () => {
    const res = await fetch(`${baseUrl}/v1/runs/run-1/status`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
  });

  it('surfaces a corrupted object instead of serving unverified bytes', async () => {
    const manifest = artifacts.getManifest('run-1', 'art-a');
    expect(manifest).not.toBeNull();
    await fetch(`${baseUrl}/v1/artifacts/art-a`, { headers: auth(keyA) });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(tempRoot, 'blobs', 'runs', 'run-1', 'artifacts', 'art-a'), 'corrupted bytes');
    const res = await fetch(`${baseUrl}/v1/artifacts/art-a`, { headers: auth(keyA) });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'INTERNAL' } });
  });

  it('logs paths without the share token or any query string', async () => {
    const freshToken = tokens.issue('art-b').token;
    const download = await fetch(`${baseUrl}/v1/artifacts/art-b?t=${encodeURIComponent(freshToken)}`);
    expect(download.status).toBe(200);
    const meta = await fetch(`${baseUrl}/v1/artifacts/art-b/meta`, { headers: auth(keyB) });
    expect(meta.status).toBe(200);

    expect(logs.length).toBeGreaterThan(0);
    for (const entry of logs) {
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(tokenA);
      expect(serialized).not.toContain(freshToken);
      expect(serialized).not.toContain('?t=');
      expect(String(entry['path'] ?? '')).not.toContain('?');
    }
    const tokenLog = logs.find((entry) => entry['auth'] === 'token' && entry['artifactId'] === 'art-b' && entry['action'] === 'download');
    expect(tokenLog).toMatchObject({ event: 'artifact_request', status: 200, runId: 'run-2', action: 'download' });
    const keyLog = logs.find((entry) => entry['auth'] === 'key' && entry['principalId'] === 'principal-b' && entry['action'] === 'meta');
    expect(keyLog).toMatchObject({ event: 'artifact_request', status: 200, artifactId: 'art-b' });
    expect(logs.some((entry) => entry['status'] === 401)).toBe(true);
    expect(logs.some((entry) => entry['status'] === 404)).toBe(true);
  });
});

// Приёмка M1.3 (arch-репо #109): финализация артефактов работает ПОСЛЕ restart —
// «рестарт процесса» = новые инстансы ArtifactStore/ShareTokenIssuer/сервера над теми же каталогами.
describe('artifact route переживает рестарт процесса (M1.3)', () => {
  async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async function close(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const restartBytes = 'artifact bytes across a restart';

  it('share-токен, выданный до рестарта, и Bearer-доступ работают после; повторный put идемпотентен', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'storage-api-restart-'));
    const registry = KeyRegistry.fromRecords([keyA.record, keyB.record]);
    let server: Server | null = null;
    try {
      // --- до рестарта
      const blobBefore = createLocalFsBlobStore({ rootDir: join(dataRoot, 'blobs') });
      const storeBefore = new ArtifactStore({ rootDir: dataRoot, blob: blobBefore });
      const manifestBefore = await storeBefore.put({
        runId: 'run-restart',
        userTaskId: 'task-restart',
        profileId: 'profile-a',
        name: 'restart.txt',
        mime: 'text/plain',
        bytes: restartBytes,
        artifactId: 'art-restart',
      });
      const tokensBefore = new ShareTokenIssuer({ secret: 'restart-secret', ttlSeconds: 600 });
      const tokenBefore = tokensBefore.issue('art-restart').token;

      server = createArtifactServer({ artifacts: storeBefore, keys: registry, tokens: tokensBefore, logger: () => undefined });
      const baseBefore = await listen(server);
      const first = await fetch(`${baseBefore}/v1/artifacts/art-restart?t=${encodeURIComponent(tokenBefore)}`);
      expect(first.status).toBe(200);
      expect(await first.text()).toBe(restartBytes);
      await close(server);
      server = null;

      // --- «рестарт»: новые инстансы над теми же каталогами (secret из env переживает рестарт)
      const blobAfter = createLocalFsBlobStore({ rootDir: join(dataRoot, 'blobs') });
      const storeAfter = new ArtifactStore({ rootDir: dataRoot, blob: blobAfter });
      const tokensAfter = new ShareTokenIssuer({ secret: 'restart-secret', ttlSeconds: 600 });
      server = createArtifactServer({ artifacts: storeAfter, keys: registry, tokens: tokensAfter, logger: () => undefined });
      const baseAfter = await listen(server);

      // токен, выданный ДО рестарта, валиден после
      const byOldToken = await fetch(`${baseAfter}/v1/artifacts/art-restart?t=${encodeURIComponent(tokenBefore)}`);
      expect(byOldToken.status).toBe(200);
      expect(byOldToken.headers.get('x-artifact-sha256')).toBe(sha256Hex(restartBytes));
      expect(await byOldToken.text()).toBe(restartBytes);

      // Bearer: meta (индекс find строится с диска) + скачивание после рестарта
      const meta = await fetch(`${baseAfter}/v1/artifacts/art-restart/meta`, { headers: auth(keyA) });
      expect(meta.status).toBe(200);
      expect(await meta.json()).toMatchObject({ artifactId: 'art-restart', runId: 'run-restart', sha256: sha256Hex(restartBytes) });
      const byKey = await fetch(`${baseAfter}/v1/artifacts/art-restart`, { headers: auth(keyA) });
      expect(byKey.status).toBe(200);
      expect(await byKey.text()).toBe(restartBytes);

      // идемпотентный повтор put тех же байт новым инстансом = тот же manifest, без конфликта
      const again = await storeAfter.put({
        runId: 'run-restart',
        userTaskId: 'task-restart',
        profileId: 'profile-a',
        name: 'restart.txt',
        mime: 'text/plain',
        bytes: restartBytes,
        artifactId: 'art-restart',
      });
      expect(again).toEqual(manifestBefore);

      // чужой профиль после рестарта по-прежнему 404
      const foreign = await fetch(`${baseAfter}/v1/artifacts/art-restart`, { headers: auth(keyB) });
      expect(foreign.status).toBe(404);
    } finally {
      if (server) await close(server);
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
