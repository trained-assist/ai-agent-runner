import { createApiSavebackWorker } from '../workspace/api-saveback-worker.js';
import type { RunSpec } from '../contracts/run-spec.js';
import type { RunBranchWorker } from '../workspace/run-branch-worker.js';

export type VmProfileWorkspaceWorker = RunBranchWorker & {
  supportsSaveback(): boolean;
};

/** Keep the run-scoped capability flowing through the VM wrapper to API saveback. */
export function createVmProfileWorkspaceWorker(
  dataDir: string,
  legacy: RunBranchWorker,
  apiSaveback: VmProfileWorkspaceWorker = createApiSavebackWorker(dataDir),
): VmProfileWorkspaceWorker {
  return {
    supportsSaveback: () => true,
    prepare: (spec, cwd, token) => spec.profileWorkspace?.savebackUrl
      ? apiSaveback.prepare(spec, cwd, token)
      : legacy.prepare(spec, cwd, token),
    publish: (spec, cwd, token) => spec.profileWorkspace?.savebackUrl
      ? apiSaveback.publish(spec, cwd, token)
      : legacy.publish(spec, cwd, token),
    ...(apiSaveback.changes ? { changes: (spec) => apiSaveback.changes!(spec) } : {}),
  };
}
