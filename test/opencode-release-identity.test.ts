import { describe, expect, it } from 'vitest';
import { compareOpenCodeIdentity, parseWorkerReleaseIdentity } from '../scripts/opencode-release-identity.mjs';

const buildInfo = {
  version: '0.3.16',
  sourceCommit: 'a'.repeat(40),
  opencode: { version: '0.0.0-preview', sourceCommit: 'b'.repeat(40), binarySha256: 'c'.repeat(64) },
};

const expected = parseWorkerReleaseIdentity(buildInfo, 'vm-worker-v0.3.16');

describe('signed worker release OpenCode identity', () => {
  it('accepts complete metadata pinned by the immutable worker release tag', () => {
    expect(expected).toEqual({
      releaseTag: 'vm-worker-v0.3.16',
      workerVersion: '0.3.16',
      workerSourceCommit: 'a'.repeat(40),
      opencodeVersion: '0.0.0-preview',
      opencodeSourceCommit: 'b'.repeat(40),
      opencodeBinarySha256: 'c'.repeat(64),
    });
  });

  it('rejects tag/version disagreement and incomplete or malformed binary identity', () => {
    expect(() => parseWorkerReleaseIdentity(buildInfo, 'vm-worker-v0.3.17')).toThrow('does not match');
    expect(() => parseWorkerReleaseIdentity({ ...buildInfo, opencode: undefined }, 'vm-worker-v0.3.16')).toThrow('identity is missing');
    expect(() => parseWorkerReleaseIdentity({ ...buildInfo, opencode: { ...buildInfo.opencode, binarySha256: 'bad' } }, 'vm-worker-v0.3.16')).toThrow('64 lowercase hex');
  });

  it('distinguishes exact runtime match, actionable drift, and unreported runtime identity', () => {
    expect(compareOpenCodeIdentity({ version: expected.opencodeVersion, sourceCommit: expected.opencodeSourceCommit, binarySha256: expected.opencodeBinarySha256 }, expected)).toEqual({ status: 'match' });
    expect(compareOpenCodeIdentity({ version: expected.opencodeVersion, sourceCommit: 'd'.repeat(40), binarySha256: expected.opencodeBinarySha256 }, expected)).toEqual({ status: 'drift', mismatches: ['sourceCommit'] });
    expect(compareOpenCodeIdentity(undefined, expected)).toEqual({ status: 'unknown', reason: 'runtime identity is missing' });
  });
});
