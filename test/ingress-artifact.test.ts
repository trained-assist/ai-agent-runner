import { createHmac, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, onTestFinished } from 'vitest';
import { launchRequestFromSpec } from '../src/adapters/external-worker-adapter.js';
import { validateRunSpec, type IngressManifestRef } from '../src/contracts/run-spec.js';
import { PreflightError } from '../src/contracts/validate.js';
import type { IngressArtifact, IngressArtifactResolver, IngressInputItem } from '../src/storage/ingress-artifact.js';
import { createHarness, waitFor } from './helpers.js';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

function manifestArtifact(bytes: Uint8Array, over: Partial<IngressArtifact> = {}): IngressArtifact {
  return {
    contractVersion: 1, ref: 'buffer-ref-a', version: 'object-v1', ownerProfileId: 'profile-a',
    mediaType: 'audio/ogg', name: 'voice.ogg', sizeBytes: bytes.length, sha256: hash(bytes), ...over,
  };
}

function pinFor(spec: ReturnType<ReturnType<typeof createHarness>['makeSpec']>, items: IngressInputItem[] = []): IngressManifestRef {
  const canonical = JSON.stringify({ contractVersion: 1, userTaskId: spec.userTaskId, profileId: spec.profileId, inputItems: items.map((item) => ({ ...(item.text === undefined ? {} : { text: item.text }), artifacts: item.artifacts })) });
  return { contractVersion: 1, manifestRef: `cp-input-manifest:${spec.userTaskId}`, manifestVersion: hash(canonical), userTaskId: spec.userTaskId, profileId: spec.profileId, runId: spec.runId, ownerGeneration: spec.ownerGeneration };
}

function resolverFor(options: {
  items?: Array<{ text?: string; artifacts: IngressArtifact[] }>;
  bytes?: Map<string, Uint8Array>;
  profileId?: string;
  taskId?: string;
  fail?: Error;
  onManifest?: () => void;
  onArtifact?: () => void;
} = {}): IngressArtifactResolver {
  return {
    async getManifest(requestedTaskId) {
      options.onManifest?.();
      if (options.fail) throw options.fail;
      const taskId = options.taskId ?? requestedTaskId;
      const profileId = options.profileId ?? 'profile-a';
      const items = options.items ?? [];
      const canonical = JSON.stringify({ contractVersion: 1, userTaskId: taskId, profileId, inputItems: items.map((item) => ({ ...(item.text === undefined ? {} : { text: item.text }), artifacts: item.artifacts })) });
      return {
        contractVersion: 1,
        manifestRef: `cp-input-manifest:${taskId}`,
        manifestVersion: hash(canonical),
        userTaskId: taskId,
        profileId,
        inputItems: items,
      };
    },
    async getArtifact(_taskId, _pin, artifact) {
      options.onArtifact?.();
      if (options.fail) throw options.fail;
      const bytes = options.bytes?.get(artifact.ref) ?? new Uint8Array();
      return { bytes, ref: artifact.ref, version: artifact.version, ownerProfileId: artifact.ownerProfileId, mediaType: artifact.mediaType, sizeBytes: bytes.length, sha256: hash(bytes) };
    },
  };
}

async function terminal(runner: ReturnType<typeof createHarness>['runner'], runId: string) {
  await waitFor(() => ['succeeded', 'failed', 'cancelled'].includes(runner.getRun(runId)?.state ?? ''), 10_000, `terminal ${runId}`);
  return runner.getRun(runId)?.result;
}

describe('task-scoped ingress artifacts', () => {
  it('materializes ordered text and audio bytes in one run-scoped workspace before spawn', async () => {
    const audio = new TextEncoder().encode('audio bytes');
    const artifact = manifestArtifact(audio, { name: '../../voice.ogg' });
    const items = [{ text: 'first message', artifacts: [] }, { text: 'transcribe this', artifacts: [artifact] }];
    const h = createHarness({ retainWorkspaces: true, ingressResolver: resolverFor({
      items,
      bytes: new Map([[artifact.ref, audio]]),
    }) });
    const spec = h.makeSpec();
    const bound = { ...spec, ingressManifest: pinFor(spec, items) };
    h.runner.start(bound);
    expect((await terminal(h.runner, spec.runId))?.outcome).toBe('succeeded');
    const root = join(spec.cwd, '.inputs', 'ingress', spec.runId);
    const index = JSON.parse(readFileSync(join(root, 'input-items.json'), 'utf8')) as { inputItems: Array<{ text?: string; artifacts: Array<{ path: string }> }> };
    expect(index.inputItems.map((item) => item.text)).toEqual(['first message', 'transcribe this']);
    const relative = index.inputItems[1]?.artifacts[0]?.path;
    expect(relative).toMatch(/^00-voice\.ogg$/);
    expect(readFileSync(join(root, relative as string))).toEqual(Buffer.from(audio));
    expect(h.runner.events(spec.runId).some((event) => event.type === 'started')).toBe(true);
  });

  it('deduplicates identical artifact reads and same-operation starts', async () => {
    const bytes = new TextEncoder().encode('duplicate-safe');
    const artifact = manifestArtifact(bytes);
    let manifests = 0;
    let reads = 0;
    const items = [{ artifacts: [artifact, artifact] }];
    const h = createHarness({ retainWorkspaces: true, ingressResolver: resolverFor({
      items, bytes: new Map([[artifact.ref, bytes]]),
      onManifest: () => manifests++, onArtifact: () => reads++,
    }) });
    const spec = h.makeSpec();
    const bound = { ...spec, ingressManifest: pinFor(spec, items) };
    const first = h.runner.start(bound);
    const second = h.runner.start(bound);
    expect(second.deduplicated).toBe(true);
    expect((await terminal(h.runner, spec.runId))?.outcome).toBe('succeeded');
    expect(manifests).toBe(1);
    expect(reads).toBe(1);
    expect(existsSync(join(spec.cwd, '.inputs', 'ingress', spec.runId, '00-voice.ogg'))).toBe(true);
    expect(existsSync(join(spec.cwd, '.inputs', 'ingress', spec.runId, '01-voice.ogg'))).toBe(true);
    expect(first.runId).toBe(second.runId);
  });

  it('fails closed on a task/profile mismatch without starting the engine', async () => {
    const h = createHarness({ retainWorkspaces: true, ingressResolver: resolverFor({ profileId: 'profile-other' }) });
    const spec = h.makeSpec();
    h.runner.start({ ...spec, ingressManifest: pinFor(spec) });
    const result = await terminal(h.runner, spec.runId);
    expect(result?.failure?.code).toBe('INGRESS_INPUT_INVALID');
    expect(result?.failure?.retryable).toBe(false);
    expect(h.runner.events(spec.runId).map((event) => event.type)).not.toContain('started');
    expect(existsSync(join(spec.cwd, '.inputs', 'ingress', spec.runId))).toBe(false);
  });

  it('does not persist deployment credentials in the Run record or events', async () => {
    const { ControlPlaneIngressResolver } = await import('../src/storage/ingress-artifact.js');
    const secret = 'deployment-only-secret-should-never-persist';
    const resolver = new ControlPlaneIngressResolver({
      baseUrl: 'https://cp.example.test', principalId: 'runner', secret,
      fetcher: (async () => new Response(null, { status: 503 })) as typeof fetch,
    });
    const h = createHarness({ ingressResolver: resolver });
    const spec = h.makeSpec();
    h.runner.start({ ...spec, ingressManifest: pinFor(spec) });
    await terminal(h.runner, spec.runId);
    const persisted = JSON.stringify({ run: h.runner.getRun(spec.runId), events: h.runner.events(spec.runId) });
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('x-principal-sig');
  });

  it('treats transport outage as retryable but checksum mismatch as permanent', async () => {
    const outage = createHarness({ ingressResolver: resolverFor({ fail: new PreflightError('INGRESS_INPUT_UNAVAILABLE', 'offline', { retryable: true }) }) });
    const first = outage.makeSpec();
    outage.runner.start({ ...first, ingressManifest: pinFor(first) });
    const failed = await terminal(outage.runner, first.runId);
    expect(failed?.failure).toMatchObject({ code: 'INGRESS_INPUT_UNAVAILABLE', retryable: true });
    expect(outage.runner.events(first.runId).map((event) => event.type)).not.toContain('started');

    const bytes = new TextEncoder().encode('trusted');
    const artifact = manifestArtifact(bytes);
    const items = [{ artifacts: [artifact] }];
    const mismatch = createHarness({ ingressResolver: resolverFor({ items, bytes: new Map([[artifact.ref, new TextEncoder().encode('tampered')]]) }) });
    const second = mismatch.makeSpec();
    mismatch.runner.start({ ...second, ingressManifest: pinFor(second, items) });
    const invalid = await terminal(mismatch.runner, second.runId);
    expect(invalid?.failure).toMatchObject({ code: 'INGRESS_INPUT_INVALID', retryable: false });
    expect(mismatch.runner.events(second.runId).map((event) => event.type)).not.toContain('started');
    expect(existsSync(join(second.cwd, '.inputs'))).toBe(false);
  });

  it('allows an explicit new-generation retry without replaying the old run', async () => {
    const bytes = new TextEncoder().encode('retry success');
    const artifact = manifestArtifact(bytes);
    const items = [{ artifacts: [artifact] }];
    let online = false;
    const base = resolverFor({ items, bytes: new Map([[artifact.ref, bytes]]) });
    const resolver: IngressArtifactResolver = {
      getManifest: async (taskId) => {
        if (!online) throw new PreflightError('INGRESS_INPUT_UNAVAILABLE', 'offline', { retryable: true });
        return base.getManifest(taskId);
      },
      getArtifact: (...args) => base.getArtifact(...args),
    };
    const h = createHarness({ retainWorkspaces: true, ingressResolver: resolver });
    const first = h.makeSpec();
    h.runner.start({ ...first, ingressManifest: pinFor(first, items) });
    expect((await terminal(h.runner, first.runId))?.failure?.retryable).toBe(true);
    online = true;
    const retry = h.makeSpec({ userTaskId: first.userTaskId, profileId: first.profileId, ownerGeneration: first.ownerGeneration + 1 });
    h.runner.start({ ...retry, ingressManifest: pinFor(retry, items) });
    expect((await terminal(h.runner, retry.runId))?.outcome).toBe('succeeded');
    expect(h.runner.getRun(first.runId)?.state).toBe('failed');
    expect(h.runner.events(first.runId).map((event) => event.type)).not.toContain('started');
  });

  it('enforces per-artifact and aggregate quotas before downloading or spawning', async () => {
    let reads = 0;
    const tooLarge = manifestArtifact(new Uint8Array(), { sizeBytes: 20 * 1024 * 1024 + 1 });
    const items = [{ artifacts: [tooLarge] }];
    const h = createHarness({ ingressResolver: resolverFor({ items, onArtifact: () => reads++ }) });
    const spec = h.makeSpec();
    h.runner.start({ ...spec, ingressManifest: pinFor(spec, items) });
    expect((await terminal(h.runner, spec.runId))?.failure?.code).toBe('INGRESS_INPUT_INVALID');
    expect(reads).toBe(0);
    expect(h.runner.events(spec.runId).map((event) => event.type)).not.toContain('started');
  });

  it('refuses a repository-provided .inputs symlink before writing outside the run root', async () => {
    const { materializeIngressManifest } = await import('../src/storage/ingress-artifact.js');
    const base = mkdtempSync(join(tmpdir(), 'runner-ingress-symlink-'));
    const cwd = join(base, 'workspace');
    const outside = join(base, 'outside');
    mkdirSync(cwd);
    mkdirSync(outside);
    symlinkSync(outside, join(cwd, '.inputs'));
    onTestFinished(() => rmSync(base, { recursive: true, force: true }));
    const h = createHarness();
    const spec = h.makeSpec();
    const items = [{ artifacts: [] }];
    await expect(materializeIngressManifest(resolverFor({ items }), pinFor(spec, items), {
      runId: spec.runId, userTaskId: spec.userTaskId, profileId: spec.profileId,
      ownerGeneration: spec.ownerGeneration, cwd,
    })).rejects.toMatchObject({ code: 'INGRESS_INPUT_INVALID' });
    expect(existsSync(join(outside, 'ingress'))).toBe(false);
  });

  it('rejects path traversal names and spec pins bound to another task, run, profile, or generation', () => {
    const h = createHarness();
    const spec = h.makeSpec();
    const pin = pinFor(spec);
    for (const change of [
      { userTaskId: 'another-task' }, { profileId: 'another-profile' }, { runId: 'another-run' }, { ownerGeneration: 2 },
    ]) {
      expect(validateRunSpec({ ...spec, ingressManifest: { ...pin, ...change } }).ok).toBe(false);
    }
    expect(() => launchRequestFromSpec({ ...spec, ingressManifest: pin }, { resultUrl: 'https://runner.test/result' })).toThrow(/cannot resolve task-scoped ingress/);
  });
});

describe('Control Plane ingress resolver auth and transport', () => {
  it('signs only the principal identity and rejects redirects without forwarding credentials', async () => {
    const { ControlPlaneIngressResolver } = await import('../src/storage/ingress-artifact.js');
    const calls: Request[] = [];
    const resolver = new ControlPlaneIngressResolver({
      baseUrl: 'https://cp.example.test', principalId: 'runner', secret: 'never-in-spec',
      fetcher: (async (input: URL | Request, init?: RequestInit) => {
        calls.push(new Request(input, init));
        return Response.json({});
      }) as typeof fetch,
    });
    await resolver.getManifest('task-1');
    const request = calls[0] as Request;
    expect(request.headers.get('x-principal')).toBe('runner');
    expect(request.headers.get('x-principal-sig')).toBe(createHmac('sha256', 'never-in-spec').update('runner').digest('hex'));
    expect(request.redirect).toBe('error');
    const requestBody = { ingressManifest: { contractVersion: 1, manifestRef: 'cp-input-manifest:task-1', manifestVersion: 'b'.repeat(64), userTaskId: 'task-1', profileId: 'profile-1', runId: 'run-1', ownerGeneration: 1 } };
    expect(JSON.stringify(requestBody)).not.toContain('never-in-spec');
    expect(new URL(request.url).searchParams.get('taskId')).toBe('task-1');
  });

  it('requests artifact bytes with the complete immutable task and manifest pin', async () => {
    const { ControlPlaneIngressResolver } = await import('../src/storage/ingress-artifact.js');
    const bytes = new TextEncoder().encode('voice');
    const artifact = manifestArtifact(bytes);
    const spec = createHarness().makeSpec();
    const pin = pinFor(spec, [{ artifacts: [artifact] }]);
    let requestUrl = '';
    const resolver = new ControlPlaneIngressResolver({
      baseUrl: 'https://cp.example.test/', principalId: 'runner', secret: 'private',
      fetcher: (async (input: URL | Request) => {
        requestUrl = String(input);
        return new Response(bytes, { headers: {
          'content-length': String(bytes.length), 'content-type': artifact.mediaType,
          'x-artifact-ref': artifact.ref, 'x-artifact-version': artifact.version,
          'x-artifact-owner-profile-id': spec.profileId, 'x-artifact-size-bytes': String(bytes.length), 'x-artifact-sha256': hash(bytes),
        } });
      }) as typeof fetch,
    });
    const result = await resolver.getArtifact(spec.userTaskId, pin, artifact);
    const url = new URL(requestUrl);
    expect(url.pathname).toBe('/runner/input-artifact');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      taskId: spec.userTaskId, manifestRef: pin.manifestRef, manifestVersion: pin.manifestVersion,
      ref: artifact.ref, version: artifact.version,
    });
    expect(Buffer.from(result.bytes)).toEqual(Buffer.from(bytes));
    expect(result.sha256).toBe(artifact.sha256);
  });
});
