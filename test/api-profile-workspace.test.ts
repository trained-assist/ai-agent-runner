import { describe, expect, it, onTestFinished } from 'vitest';
import { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AgentApi } from '../src/api/service.js';
import type { Principal } from '../src/api/auth.js';
import type { ProfileWorkspaceCoordinator } from '../src/api/profile-workspace.js';
import type { WorkspacePublication } from '../src/workspace/contract.js';
import { adapterFor, startMockWorker } from './external-worker-harness.js';
import { createAgentApiServer } from '../src/api/server.js';
import { KeyRegistry, keyRecordFor } from '../src/api/auth.js';
import { StatelessStore } from '../src/api/stateless-store.js';

const principal: Principal = { principalId: 'user-a', tenantId: 'tenant-a', profileId: 'profile-a', scopes: ['runs:read', 'runs:write'] };
const body = { engine: { name: 'azure-dynamic-ip-agent-run', adapterVersion: '1' }, input: { inlinePrompt: 'save profile' }, limits: { timeoutMs: 3000 }, envAllowlist: [] };

async function waitFor(api: AgentApi, runId: string, state: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (api.status(principal, runId).state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} did not reach ${state}`);
}

describe('profile workspace lifecycle', () => {
  it('does not persist snapshot URLs or saveback capabilities in the admission journal', () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-capability-journal-'));
    try {
      const path = join(root, 'admissions.jsonl');
      const store = new StatelessStore({}, path, true);
      store.appendPrepared('run_secret_test', { fullName: 'owner/name', revision: 'a'.repeat(40) }, {
        bindingId: 'binding-a', snapshotUrl: 'https://signed.example/private?sig=secret-url', snapshotSha256: 'a'.repeat(64),
        snapshotSize: 1, savebackToken: 'one-run-secret-token-1234567890123456', artifacts: [], excludedPatterns: [],
      });
      const journal = readFileSync(path, 'utf8');
      expect(journal).not.toContain('secret-url');
      expect(journal).not.toContain('one-run-secret-token');
      expect(journal).toContain('"snapshotUrl":""');
      expect(journal).toContain('"savebackToken":""');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prepares the trusted profile, pins its revision, and publishes the confirmed run branch', async () => {
    const worker = await startMockWorker();
    onTestFinished(() => worker.close());
    const calls: Array<{ runId: string; revision: string; files: unknown; deletes: unknown; tenantId?: string; profileId: string }> = [];
    let canonicalRevision = 'a'.repeat(40);
    const workspace: ProfileWorkspaceCoordinator = {
      async prepare(auth, runId) {
        expect(auth).toMatchObject({ tenantId: 'tenant-a', profileId: 'profile-a' });
        return { bindingId: 'binding-a', repository: 'owner/name', baseRevision: canonicalRevision, snapshotUrl: 'https://storage.googleapis.com/snapshot', snapshotSha256: 'c'.repeat(64), snapshotSize: 123, savebackToken: 'x'.repeat(43), artifacts: [], excludedPatterns: [] };
      },
      async upload() {},
      async publish(auth, runId, revision, files, deletes) {
        calls.push({ runId, revision, files, deletes, tenantId: auth.tenantId, profileId: auth.profileId });
        canonicalRevision = 'b'.repeat(40);
        return { status: 'published', committedRevision: canonicalRevision, conflictId: null, publicationId: 'pub-a', reason: null } as WorkspacePublication;
      },
      async readObject() { throw new Error('no object in this fixture'); },
    };
    const api = new AgentApi({ workers: [adapterFor(worker)], profileWorkspace: workspace });
    onTestFinished(() => api.dispose());
    const receipt = api.submit(principal, 'profile-run-one', body);
    expect(() => api.submit(principal, 'profile-run-two', body)).toThrowError(expect.objectContaining({ code: 'TASK_ATTEMPT_ACTIVE' }));
    await waitFor(api, receipt.runId, 'succeeded');
    expect(worker.launches).toHaveLength(1);
    expect(worker.launches[0]?.['repository']).toMatchObject({ fullName: 'owner/name', revision: 'a'.repeat(40), branch: `agent-run/${receipt.runId}` });
    expect(worker.launches[0]?.['publicationToken']).toBeUndefined();
    expect((worker.launches[0]?.['profileWorkspace'] as Record<string, unknown>)?.['savebackToken']).toBe('x'.repeat(43));
    expect(calls).toEqual([{ runId: receipt.runId, revision: 'a'.repeat(40), files: [], deletes: [], tenantId: 'tenant-a', profileId: 'profile-a' }]);
    expect(api.status(principal, receipt.runId).publication).toMatchObject({ status: 'published', committedRevision: 'b'.repeat(40) });
    const next = api.submit(principal, 'profile-run-next', body);
    await waitFor(api, next.runId, 'succeeded');
    expect(worker.launches[1]?.['repository']).toMatchObject({ fullName: 'owner/name', revision: 'b'.repeat(40), branch: `agent-run/${next.runId}` });
    expect(() => api.submit(principal, 'foreign-repo', { ...body, repository: { fullName: 'another/repo' } })).toThrowError(expect.objectContaining({ code: 'INVALID_REPOSITORY' }));
  });

  it('sends profile snapshot runs to GHA and skips VM workers that still require git credentials', async () => {
    const eu = await startMockWorker();
    const gha = await startMockWorker();
    onTestFinished(() => eu.close());
    onTestFinished(() => gha.close());
    const workspace: ProfileWorkspaceCoordinator = {
      async prepare() {
        return { bindingId: 'binding-a', repository: 'owner/name', baseRevision: 'a'.repeat(40), snapshotUrl: 'https://storage.googleapis.com/snapshot', snapshotSha256: 'c'.repeat(64), snapshotSize: 123, savebackToken: 'x'.repeat(43), artifacts: [], excludedPatterns: [] };
      },
      async upload() {},
      async publish() {
        return { status: 'published', committedRevision: 'b'.repeat(40), conflictId: null, publicationId: 'pub-a', reason: null } as WorkspacePublication;
      },
      async readObject() { return Buffer.alloc(0); },
    };
    const api = new AgentApi({
      workers: [adapterFor(eu, { engineName: 'eu-vm-agent-run' }), adapterFor(gha, { engineName: 'azure-dynamic-ip-agent-run' })],
      engineChain: ['eu-vm-agent-run', 'azure-dynamic-ip-agent-run'],
      profileWorkspace: workspace,
    });
    onTestFinished(() => api.dispose());
    const request = { ...body } as Record<string, unknown>;
    delete request['engine'];
    const receipt = api.submit(principal, 'profile-saveback-engine-choice', request);
    await waitFor(api, receipt.runId, 'succeeded');
    expect(eu.launches).toHaveLength(0);
    expect(gha.launches).toHaveLength(1);
    expect((gha.launches[0]?.['profileWorkspace'] as Record<string, unknown>)?.['snapshotUrl']).toBe('https://storage.googleapis.com/snapshot');
  });

  it('records failed profile saveback without publishing a fabricated empty manifest', async () => {
    const worker = await startMockWorker({
      omitProfileChanges: true,
      resultFailure: { code: 'ARTIFACTS_PUSH_FAILED', failureClass: 'finalization', safeSummary: 'profile saveback failed: API upload unavailable', retryable: true },
    });
    onTestFinished(() => worker.close());
    let publications = 0;
    const workspace: ProfileWorkspaceCoordinator = {
      async prepare() {
        return { bindingId: 'binding-a', repository: 'owner/name', baseRevision: 'a'.repeat(40), snapshotUrl: 'https://storage.googleapis.com/snapshot', snapshotSha256: 'c'.repeat(64), snapshotSize: 123, savebackToken: 'x'.repeat(43), artifacts: [], excludedPatterns: [] };
      },
      async upload() {},
      async publish() {
        publications += 1;
        return { status: 'published', committedRevision: 'b'.repeat(40), conflictId: null, publicationId: 'pub-a', reason: null } as WorkspacePublication;
      },
      async readObject() { return Buffer.alloc(0); },
    };
    const adapter = adapterFor(worker);
    const api = new AgentApi({ workers: [adapter], profileWorkspace: workspace });
    onTestFinished(() => api.dispose());
    const receipt = api.submit(principal, 'profile-saveback-upload-failed', body);
    await waitFor(api, receipt.runId, 'succeeded');
    expect(publications).toBe(0);
    expect(api.result(principal, receipt.runId)).toMatchObject({
      outcome: 'succeeded', persistence: 'failed',
      persistenceReason: 'profile saveback failed in worker: ARTIFACTS_PUSH_FAILED: profile saveback failed: API upload unavailable',
    });
  });

  it('serves a profile object only for its admitted run and verifies stored bytes', async () => {
    const worker = await startMockWorker();
    onTestFinished(() => worker.close());
    const bytes = Buffer.alloc(1_200_000, 0x61);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let storedBytes = bytes;
    let reads = 0;
    const workspace: ProfileWorkspaceCoordinator = {
      async prepare() {
        return { bindingId: 'binding-a', repository: 'owner/name', baseRevision: 'a'.repeat(40), snapshotUrl: 'https://storage.googleapis.com/snapshot', snapshotSha256: 'c'.repeat(64), snapshotSize: 123, savebackToken: 'x'.repeat(43), artifacts: [], excludedPatterns: [] };
      },
      async upload() {},
      async publish() {
        return { status: 'published', committedRevision: 'b'.repeat(40), conflictId: null, publicationId: 'pub-a', reason: null } as WorkspacePublication;
      },
      async readObject() {
        reads += 1;
        return storedBytes;
      },
    };
    const api = new AgentApi({ workers: [adapterFor(worker)], profileWorkspace: workspace });
    onTestFinished(() => api.dispose());
    const receipt = api.submit(principal, 'profile-artifact', body);
    await waitFor(api, receipt.runId, 'succeeded');
    const run = api.store.progressOf(receipt.runId)!;
    run.artifacts = [{
      path: 'large/output.bin', name: 'output.bin', mime: 'application/octet-stream', size: bytes.length, sha256,
      objectKey: `profiles/profile-a/workspace/${receipt.runId}/large/output.bin`,
    }];

    await expect(api.downloadArtifact(principal, receipt.runId, 'large/output.bin')).resolves.toEqual({ bytes, mime: 'application/octet-stream', sha256 });
    expect(api.artifacts(principal, receipt.runId).artifacts[0]?.url).toBe(`/v1/runs/${receipt.runId}/artifacts?path=large%2Foutput.bin`);

    const other = { ...principal, principalId: 'user-b' };
    await expect(api.downloadArtifact(other, receipt.runId, 'large/output.bin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(api.downloadArtifact({ ...principal, tenantId: 'tenant-b' }, receipt.runId, 'large/output.bin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(api.downloadArtifact(principal, receipt.runId, 'unlisted.bin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(reads).toBe(1);

    run.artifacts[0]!.objectKey = `profiles/profile-a/workspace/another-run/large/output.bin`;
    await expect(api.downloadArtifact(principal, receipt.runId, 'large/output.bin')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(reads).toBe(1);

    run.artifacts[0]!.objectKey = `profiles/profile-a/workspace/${receipt.runId}/large/output.bin`;
    storedBytes = Buffer.alloc(bytes.length, 0x62);
    await expect(api.downloadArtifact(principal, receipt.runId, 'large/output.bin')).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('accepts saveback only through the matching run-scoped capability and validates upload bytes', async () => {
    const worker = await startMockWorker({ terminalStatus: 'running' });
    onTestFinished(() => worker.close());
    const uploadCalls: Array<{ runId: string; path: string; sha256: string }> = [];
    const workspace: ProfileWorkspaceCoordinator = {
      async prepare() {
        return { bindingId: 'binding-a', repository: 'owner/name', baseRevision: 'a'.repeat(40), snapshotUrl: 'https://storage.googleapis.com/snapshot', snapshotSha256: 'c'.repeat(64), snapshotSize: 123, savebackToken: 'run-secret-token-' + 'x'.repeat(32), artifacts: [], excludedPatterns: [] };
      },
      async upload(_auth, runId, _token, path, bytes, sha256) {
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
        uploadCalls.push({ runId, path, sha256 });
      },
      async publish() {
        return { status: 'published', committedRevision: 'b'.repeat(40), conflictId: null, publicationId: 'pub-saveback', reason: null } as WorkspacePublication;
      },
      async readObject() { return Buffer.alloc(0); },
    };
    const adapter = adapterFor(worker);
    const api = new AgentApi({ workers: [adapter], profileWorkspace: workspace });
    onTestFinished(() => api.dispose());
    const key = 'ak_' + 'k'.repeat(48);
    const keys = KeyRegistry.fromRecords([keyRecordFor(key, principal)]);
    const server = createAgentApiServer(api, { keys });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    adapter.setResultBaseUrl(`http://127.0.0.1:${address.port}`);
    onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

    const receipt = api.submit(principal, 'profile-saveback-route', body);
    const deadline = Date.now() + 2000;
    while (worker.launches.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const launch = worker.launches[0]!;
    const profile = launch['profileWorkspace'] as { savebackUrl: string; savebackToken: string };
    const bytes = Buffer.from('new profile note\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const url = new URL(profile.savebackUrl);
    url.host = `127.0.0.1:${address.port}`;
    url.protocol = 'http:';
    url.searchParams.set('path', 'notes/from-agent.md');
    const valid = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${profile.savebackToken}`, 'x-content-sha256': sha256 }, body: bytes });
    expect(valid.status, await valid.clone().text()).toBe(201);
    expect(uploadCalls).toEqual([{ runId: receipt.runId, path: 'notes/from-agent.md', sha256 }]);

    const invalidToken = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer wrong-run-token', 'x-content-sha256': sha256 }, body: bytes });
    expect(invalidToken.status).toBe(401);
    const badHash = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${profile.savebackToken}`, 'x-content-sha256': '0'.repeat(64) }, body: bytes });
    expect(badHash.status).toBe(422);
    expect(uploadCalls).toHaveLength(1);
  });
});
