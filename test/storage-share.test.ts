import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GcsBucketLike } from '../src/storage/gcs.js';
import { createLocalFsBlobStore } from '../src/storage/local-fs.js';
import type { ArtifactManifest } from '../src/storage/manifest.js';
import {
  ARTIFACT_TOKEN_PARAM,
  ShareTokenIssuer,
  artifactSharePath,
  createShareLink,
} from '../src/storage/share.js';

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'storage-share-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function manifest(over: Partial<ArtifactManifest> = {}): ArtifactManifest {
  return {
    artifactId: 'art-1',
    runId: 'run-1',
    userTaskId: 'task-1',
    profileId: 'profile-a',
    name: 'report.txt',
    mime: 'text/plain',
    size: 15,
    sha256: 'a'.repeat(64),
    storageKey: 'runs/run-1/artifacts/art-1',
    createdAt: '2026-10-01T10:00:00.000Z',
    ...over,
  };
}

function gcsBucketWithSignedUrls(): GcsBucketLike {
  return {
    name: 'fake-bucket',
    file(key: string) {
      const missing = () => Object.assign(new Error('not found'), { code: 404 });
      return {
        async save() {
          throw missing();
        },
        async getMetadata() {
          throw missing();
        },
        async download() {
          throw missing();
        },
        async exists() {
          return [false];
        },
        async delete() {
          throw missing();
        },
        async getSignedUrl(options: Record<string, unknown>) {
          const expires = options['expires'] as Date;
          return [`https://storage.fake.test/${key}?generation=42&expires=${expires.toISOString()}`];
        },
      };
    },
  };
}

describe('share tokens', () => {
  it('issues a short-lived token bound to the artifact id', () => {
    const clock = { now: new Date('2026-10-01T10:00:00.000Z') };
    const issuer = new ShareTokenIssuer({ secret: 'test-secret', ttlSeconds: 60, now: () => clock.now });
    const issued = issuer.issue('art-1');
    expect(issued.expiresAt).toBe('2026-10-01T10:01:00.000Z');
    expect(issued.token.split('.')[0]).toBe(String(Date.parse('2026-10-01T10:01:00.000Z')));
    expect(issuer.verify('art-1', issued.token)).toBe(true);
  });

  it('rejects tampering, foreign artifacts, garbage and expiry', () => {
    const clock = { now: new Date('2026-10-01T10:00:00.000Z') };
    const issuer = new ShareTokenIssuer({ secret: 'test-secret', ttlSeconds: 60, now: () => clock.now });
    const issued = issuer.issue('art-1');

    expect(issuer.verify('art-2', issued.token)).toBe(false);
    expect(issuer.verify('art-1', `${issued.token}x`)).toBe(false);
    expect(issuer.verify('art-1', issued.token.replace(/\d/, '9'))).toBe(false);
    expect(issuer.verify('art-1', 'garbage')).toBe(false);
    expect(issuer.verify('art-1', '')).toBe(false);
    expect(issuer.verify('art-1', null)).toBe(false);

    clock.now = new Date('2026-10-01T10:01:00.001Z');
    expect(issuer.verify('art-1', issued.token)).toBe(false);
  });

  it('does not accept tokens minted with another secret', () => {
    const a = new ShareTokenIssuer({ secret: 'secret-a' });
    const b = new ShareTokenIssuer({ secret: 'secret-b' });
    const issued = a.issue('art-1');
    expect(b.verify('art-1', issued.token)).toBe(false);
  });

  it('builds an api url and refuses an empty base url', () => {
    expect(artifactSharePath('http://localhost:8080/', 'art-1', 'tok')).toBe('http://localhost:8080/v1/artifacts/art-1?t=tok');
    expect(artifactSharePath('http://localhost:8080', 'art 1', 'a.b')).toBe('http://localhost:8080/v1/artifacts/art%201?t=a.b');
    try {
      artifactSharePath('', 'art-1', 'tok');
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('BLOB_BACKEND_MISCONFIGURED');
    }
  });
});

describe('share links', () => {
  it('routes a local-fs artifact through the api with a token url', async () => {
    const blob = createLocalFsBlobStore({ rootDir: root() });
    const tokens = new ShareTokenIssuer({ secret: 'test-secret', ttlSeconds: 120 });
    const link = await createShareLink({ blob, tokens, baseUrl: 'http://localhost:8080' }, manifest());
    expect(link.backend).toBe('local-fs');
    expect(link.url.startsWith('http://localhost:8080/v1/artifacts/art-1?t=')).toBe(true);
    expect(link.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const token = link.url.split(`${ARTIFACT_TOKEN_PARAM}=`)[1] ?? '';
    expect(tokens.verify('art-1', token)).toBe(true);
    expect(tokens.verify('art-2', token)).toBe(false);
  });

  it('keeps the link out of the manifest', async () => {
    const blob = createLocalFsBlobStore({ rootDir: root() });
    const tokens = new ShareTokenIssuer({ secret: 'test-secret' });
    const source = manifest();
    const before = JSON.stringify(source);
    await createShareLink({ blob, tokens, baseUrl: 'http://localhost:8080' }, source);
    expect(JSON.stringify(source)).toBe(before);
    expect(Object.keys(source)).not.toContain('url');
  });

  it('uses a presigned generation url when the backend provides one', async () => {
    const local = createLocalFsBlobStore({ rootDir: root() });
    const tokens = new ShareTokenIssuer({ secret: 'test-secret' });
    const presigned = {
      backend: 'gcs' as const,
      put: (key: string, bytes: Uint8Array | string) => local.put(key, bytes),
      get: (key: string) => local.get(key),
      head: (key: string) => local.head(key),
      async shareUrl(key: string) {
        return { url: `https://storage.fake.test/${key}?generation=7`, expiresAt: '2026-10-01T10:10:00.000Z' };
      },
    };
    const link = await createShareLink({ blob: presigned, tokens, baseUrl: 'http://localhost:8080' }, manifest());
    expect(link.backend).toBe('gcs');
    expect(link.url).toContain('runs/run-1/artifacts/art-1');
    expect(link.url).toContain('generation=7');
    expect(link.url).not.toMatch(/[?&]t=/);
    expect(link.expiresAt).toBe('2026-10-01T10:10:00.000Z');
  });

  it('prefers the real gcs backend signed url', async () => {
    const { createGcsBlobStore } = await import('../src/storage/gcs.js');
    const blob = createGcsBlobStore({ bucket: gcsBucketWithSignedUrls() });
    const tokens = new ShareTokenIssuer({ secret: 'test-secret' });
    const link = await createShareLink({ blob, tokens, baseUrl: 'http://localhost:8080' }, manifest());
    expect(link.url).toContain('https://storage.fake.test/runs/run-1/artifacts/art-1');
    expect(link.url).toContain('expires=');
    expect(link.url).not.toMatch(/[?&]t=/);
  });

  it('declares missing capabilities instead of inventing a link', async () => {
    const blob = createLocalFsBlobStore({ rootDir: root() });
    await expect(createShareLink({ blob }, manifest())).rejects.toMatchObject({ code: 'BLOB_BACKEND_UNSUPPORTED' });

    const tokens = new ShareTokenIssuer({ secret: 'test-secret' });
    await expect(createShareLink({ blob, tokens }, manifest())).rejects.toMatchObject({ code: 'BLOB_BACKEND_MISCONFIGURED' });
  });

  it('rejects a non-positive ttl', () => {
    expect(() => new ShareTokenIssuer({ ttlSeconds: 0 })).toThrow(/positive number/);
  });
});
