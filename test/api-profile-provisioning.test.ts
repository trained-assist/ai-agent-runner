import { describe, expect, it, onTestFinished } from 'vitest';
import { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import type { Principal } from '../src/api/auth.js';
import { KeyRegistry, keyRecordFor } from '../src/api/auth.js';
import { createAgentApiServer } from '../src/api/server.js';
import { AgentApi } from '../src/api/service.js';
import type { ProfileWorkspaceCoordinator, ProvisionedProfileWorkspace } from '../src/api/profile-workspace.js';
import type { WorkspacePublication } from '../src/workspace/contract.js';
import { adapterFor, startMockWorker } from './external-worker-harness.js';

const key = 'ak_profile_provisioning_test_key_0123456789';
const secret = 'profile-provisioning-delegation-secret';
const principal: Principal = {
  principalId: 'control-plane', tenantId: 'tenant-sandbox', profileId: 'default-profile',
  scopes: ['profiles:provision'],
};

describe('POST /v1/profiles/workspace', () => {
  it('requires a signed delegated profile, a provisioning scope and an empty body; it never launches an agent', async () => {
    const worker = await startMockWorker();
    onTestFinished(() => worker.close());
    let provisions = 0;
    const receipt: ProvisionedProfileWorkspace = {
      status: 'ready', tenantId: 'tenant-sandbox', profileId: 'profile-test', bindingId: 'binding-test',
      repository: 'profile-artifacts-sandbox/ta-profile-test', branch: 'main', revision: 'a'.repeat(40), private: true,
    };
    const workspace: ProfileWorkspaceCoordinator = {
      async provision(auth) {
        provisions += 1;
        expect(auth).toMatchObject({ tenantId: receipt.tenantId, profileId: receipt.profileId });
        return receipt;
      },
      async prepare() { throw new Error('no run should be prepared'); },
      async upload() {},
      async publish(): Promise<WorkspacePublication> { throw new Error('no run should publish'); },
      async readObject() { throw new Error('no run object should be read'); },
    };
    const api = new AgentApi({ workers: [adapterFor(worker)], profileWorkspace: workspace });
    const server = createAgentApiServer(api, {
      keys: KeyRegistry.fromRecords([keyRecordFor(key, principal)]),
      profileDelegationSecret: secret,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const expiresAt = String(Date.now() + 60_000);
    const signature = createHmac('sha256', secret)
      .update(`${principal.principalId}\0${principal.tenantId}\0${receipt.profileId}\0${expiresAt}`)
      .digest('hex');
    const headers = {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'x-agent-profile-id': receipt.profileId,
      'x-agent-profile-tenant': receipt.tenantId,
      'x-agent-profile-exp': expiresAt,
      'x-agent-profile-sig': signature,
    };

    try {
      const capabilities = await fetch(`${base}/v1/capabilities`, { headers: { authorization: `Bearer ${key}` } });
      expect(capabilities.status).toBe(200);
      expect(await capabilities.json()).toMatchObject({ profileWorkspaceProvisioning: { enabled: true, launchesAgent: false } });

      const missingCapability = await fetch(`${base}/v1/profiles/workspace`, {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}',
      });
      expect(missingCapability.status).toBe(403);

      const foreignTenant = 'tenant-forged';
      const foreignExpiry = String(Date.now() + 60_000);
      const foreignSignature = createHmac('sha256', secret)
        .update(`${principal.principalId}\0${foreignTenant}\0${receipt.profileId}\0${foreignExpiry}`)
        .digest('hex');
      const foreign = await fetch(`${base}/v1/profiles/workspace`, {
        method: 'POST',
        headers: { ...headers, 'x-agent-profile-tenant': foreignTenant, 'x-agent-profile-exp': foreignExpiry, 'x-agent-profile-sig': foreignSignature },
        body: '{}',
      });
      expect(foreign.status).toBe(403);

      const extraInput = await fetch(`${base}/v1/profiles/workspace`, {
        method: 'POST', headers, body: JSON.stringify({ owner: 'attacker', repository: 'chosen-by-client' }),
      });
      expect(extraInput.status).toBe(400);

      const first = await fetch(`${base}/v1/profiles/workspace`, { method: 'POST', headers, body: '{}' });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual(receipt);

      const second = await fetch(`${base}/v1/profiles/workspace`, { method: 'POST', headers, body: '{}' });
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(receipt);
      expect(provisions).toBe(2);
      expect(worker.launches).toHaveLength(0);
      expect(api.store.listAll()).toHaveLength(0);
    } finally {
      api.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('requires the separate profiles:provision scope', async () => {
    const worker = await startMockWorker();
    onTestFinished(() => worker.close());
    const noProvisionKey = 'ak_profile_provisioning_read_only_0123456789';
    const readOnly: Principal = { ...principal, scopes: ['runs:read', 'runs:write'] };
    const api = new AgentApi({ workers: [adapterFor(worker)] });
    const server = createAgentApiServer(api, {
      keys: KeyRegistry.fromRecords([keyRecordFor(noProvisionKey, readOnly)]),
      profileDelegationSecret: secret,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const expiresAt = String(Date.now() + 60_000);
    const profileId = 'profile-test';
    const signature = createHmac('sha256', secret)
      .update(`${readOnly.principalId}\0${readOnly.tenantId}\0${profileId}\0${expiresAt}`)
      .digest('hex');
    try {
      const response = await fetch(`${base}/v1/profiles/workspace`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${noProvisionKey}`, 'content-type': 'application/json',
          'x-agent-profile-id': profileId, 'x-agent-profile-tenant': readOnly.tenantId!,
          'x-agent-profile-exp': expiresAt, 'x-agent-profile-sig': signature,
        },
        body: '{}',
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'SCOPE_DENIED' } });
      expect(worker.launches).toHaveLength(0);
    } finally {
      api.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
