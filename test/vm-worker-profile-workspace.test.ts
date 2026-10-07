import { describe, expect, it, vi } from 'vitest';
import type { RunBranchWorker } from '../src/workspace/run-branch-worker.js';
import { createVmProfileWorkspaceWorker } from '../src/vm-worker/profile-workspace.js';
import { makeRunSpec } from './helpers.js';

describe('VM profile workspace wrapper', () => {
  it('forwards the run-scoped saveback capability to API-owned prepare and publish', async () => {
    const prepare = vi.fn(async () => undefined);
    const publish = vi.fn(async () => 'no-commit');
    const changes = vi.fn(() => ({ files: [], deletes: [] }));
    const apiSaveback: RunBranchWorker & { supportsSaveback(): boolean; changes: typeof changes } = {
      supportsSaveback: () => true,
      prepare,
      publish,
      changes,
    };
    const legacy: RunBranchWorker = {
      prepare: vi.fn(async () => undefined),
      publish: vi.fn(async () => 'legacy-commit'),
    };
    const worker = createVmProfileWorkspaceWorker('/tmp/unused-saveback-test', legacy, apiSaveback);
    const spec = makeRunSpec({
      runId: 'run_vm_profile_wrapper',
      profileWorkspace: {
        bindingId: 'binding-a', snapshotUrl: 'https://api.example/snapshot', snapshotSha256: 'a'.repeat(64), snapshotSize: 1,
        savebackToken: 'run-scoped-saveback-capability-0123456789', savebackUrl: 'https://api.example/profile-changes',
        artifacts: [], excludedPatterns: [],
      },
    });

    await worker.prepare(spec, '/tmp/profile', 'run-scoped-saveback-capability-0123456789');
    await worker.publish(spec, '/tmp/profile', 'run-scoped-saveback-capability-0123456789');

    expect(prepare).toHaveBeenCalledWith(spec, '/tmp/profile', 'run-scoped-saveback-capability-0123456789');
    expect(publish).toHaveBeenCalledWith(spec, '/tmp/profile', 'run-scoped-saveback-capability-0123456789');
    expect(legacy.prepare).not.toHaveBeenCalled();
    expect(legacy.publish).not.toHaveBeenCalled();
  });
});
