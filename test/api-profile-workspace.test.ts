import { describe, expect, it, onTestFinished } from 'vitest';
import { createHash } from 'node:crypto';
import { AgentApi } from '../src/api/service.js';
import type { Principal } from '../src/api/auth.js';
import type { ProfileWorkspaceCoordinator } from '../src/api/profile-workspace.js';
import type { WorkspacePublication } from '../src/workspace/contract.js';
import { adapterFor, startMockWorker } from './external-worker-harness.js';

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
  it('prepares the trusted profile, pins its revision, and publishes the confirmed run branch', async () => {
    const worker = await startMockWorker();
    onTestFinished(() => worker.close());
    const calls: Array<{ runId: string; commit: string; tenantId?: string; profileId: string }> = [];
    let canonicalRevision = 'a'.repeat(40);
    const workspace: ProfileWorkspaceCoordinator = {
      async prepare(auth, runId) {
        expect(auth).toMatchObject({ tenantId: 'tenant-a', profileId: 'profile-a' });
        return { bindingId: 'binding-a', repository: 'owner/name', baseRevision: canonicalRevision, token: 'github-token-for-profile', artifacts: [], excludedPatterns: [] };
      },
      async publish(auth, runId, commit) {
        calls.push({ runId, commit, tenantId: auth.tenantId, profileId: auth.profileId });
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
    expect(calls).toEqual([{ runId: receipt.runId, commit: 'abc1234', tenantId: 'tenant-a', profileId: 'profile-a' }]);
    expect(api.status(principal, receipt.runId).publication).toMatchObject({ status: 'published', committedRevision: 'b'.repeat(40) });
    const next = api.submit(principal, 'profile-run-next', body);
    await waitFor(api, next.runId, 'succeeded');
    expect(worker.launches[1]?.['repository']).toMatchObject({ fullName: 'owner/name', revision: 'b'.repeat(40), branch: `agent-run/${next.runId}` });
    expect(() => api.submit(principal, 'foreign-repo', { ...body, repository: { fullName: 'another/repo' } })).toThrowError(expect.objectContaining({ code: 'INVALID_REPOSITORY' }));
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
        return { bindingId: 'binding-a', repository: 'owner/name', baseRevision: 'a'.repeat(40), token: 'profile-token', artifacts: [], excludedPatterns: [] };
      },
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
});
