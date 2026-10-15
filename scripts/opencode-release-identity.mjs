const RELEASE_TAG = /^vm-worker-v(\d+\.\d+\.\d+)$/;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function parseWorkerReleaseIdentity(buildInfo, releaseTag) {
  const tagMatch = RELEASE_TAG.exec(releaseTag ?? '');
  if (!tagMatch) throw new Error('release tag must be vm-worker-vX.Y.Z');
  if (!buildInfo || typeof buildInfo !== 'object') throw new Error('worker build info must be an object');
  if (buildInfo.version !== tagMatch[1]) throw new Error('worker version does not match the release tag');
  if (!SOURCE_COMMIT.test(buildInfo.sourceCommit ?? '')) throw new Error('worker sourceCommit must be a full Git SHA');
  if (!buildInfo.opencode || typeof buildInfo.opencode !== 'object') throw new Error('OpenCode identity is missing from worker build info');
  if (typeof buildInfo.opencode.version !== 'string' || buildInfo.opencode.version.length === 0) throw new Error('OpenCode version is missing');
  if (!SOURCE_COMMIT.test(buildInfo.opencode.sourceCommit ?? '')) throw new Error('OpenCode sourceCommit must be a full Git SHA');
  if (!SHA256.test(buildInfo.opencode.binarySha256 ?? '')) throw new Error('OpenCode binarySha256 must be 64 lowercase hex characters');
  return {
    releaseTag,
    workerVersion: buildInfo.version,
    workerSourceCommit: buildInfo.sourceCommit,
    opencodeVersion: buildInfo.opencode.version,
    opencodeSourceCommit: buildInfo.opencode.sourceCommit,
    opencodeBinarySha256: buildInfo.opencode.binarySha256,
  };
}

export function compareOpenCodeIdentity(actual, expected) {
  if (!actual || typeof actual !== 'object') return { status: 'unknown', reason: 'runtime identity is missing' };
  const fields = [
    ['version', actual.version, expected.opencodeVersion],
    ['sourceCommit', actual.sourceCommit, expected.opencodeSourceCommit],
    ['binarySha256', actual.binarySha256, expected.opencodeBinarySha256],
  ];
  const missing = fields.filter(([, current]) => typeof current !== 'string' || current.length === 0).map(([name]) => name);
  if (missing.length > 0) return { status: 'unknown', reason: `runtime identity is missing ${missing.join(', ')}` };
  const mismatches = fields.filter(([, current, desired]) => current !== desired).map(([name]) => name);
  return mismatches.length > 0 ? { status: 'drift', mismatches } : { status: 'match' };
}
