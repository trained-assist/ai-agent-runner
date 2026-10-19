import { describe, expect, it } from 'vitest';
import { pinFromDecision, readOpenCodePin, writeOpenCodePin } from '../scripts/update-opencode-release-pin.mjs';

const workflow = `name: Signed VM worker release
jobs:
  build-and-attest:
    steps:
      - name: Download and verify pinned OpenCode fork
        env:
          GH_TOKEN: \${{ github.token }}
          OPENCODE_RELEASE_TAG: mem-preview-20261018-trim-web-serve-17355bd
          OPENCODE_VERSION: 0.0.0-trim-web-serve-202610172230
          OPENCODE_SOURCE_SHA: ${'1'.repeat(40)}
          OPENCODE_ARCHIVE_SHA256: ${'a'.repeat(64)}
          OPENCODE_BINARY_SHA256: ${'b'.repeat(64)}
        run: |
          test "$GITHUB_REF_NAME" = "vm-worker-v\$VERSION"
`;

const nextPin = {
  OPENCODE_RELEASE_TAG: 'mem-preview-20261019-mem-v2-950f0d8',
  OPENCODE_VERSION: '0.0.0-fork-at-950f0d869b8d',
  OPENCODE_SOURCE_SHA: '9'.repeat(40),
  OPENCODE_ARCHIVE_SHA256: 'c'.repeat(64),
  OPENCODE_BINARY_SHA256: 'd'.repeat(64),
};

describe('OpenCode fork pin in the VM worker release workflow', () => {
  it('reads all five pinned values', () => {
    expect(readOpenCodePin(workflow)).toEqual({
      OPENCODE_RELEASE_TAG: 'mem-preview-20261018-trim-web-serve-17355bd',
      OPENCODE_VERSION: '0.0.0-trim-web-serve-202610172230',
      OPENCODE_SOURCE_SHA: '1'.repeat(40),
      OPENCODE_ARCHIVE_SHA256: 'a'.repeat(64),
      OPENCODE_BINARY_SHA256: 'b'.repeat(64),
    });
  });

  it('rewrites the whole block and leaves the rest of the workflow untouched', () => {
    const updated = writeOpenCodePin(workflow, nextPin);
    expect(readOpenCodePin(updated)).toEqual(nextPin);
    expect(updated.split('\n').length).toBe(workflow.split('\n').length);
    expect(updated).toContain('GH_TOKEN: ${{ github.token }}');
    expect(updated).toContain('test "$GITHUB_REF_NAME" = "vm-worker-v$VERSION"');
    expect(updated.replace(/OPENCODE_[A-Z0-9_]+: \S+/g, 'X')).toBe(workflow.replace(/OPENCODE_[A-Z0-9_]+: \S+/g, 'X'));
  });

  it('refuses a missing or duplicated pin line instead of guessing', () => {
    expect(() => readOpenCodePin(workflow.replace(/^\s*OPENCODE_BINARY_SHA256:.*\n/m, ''))).toThrow('exactly one OPENCODE_BINARY_SHA256');
    expect(() => readOpenCodePin(`${workflow}\n          OPENCODE_VERSION: 1.2.3\n`)).toThrow('exactly one OPENCODE_VERSION');
    expect(() => writeOpenCodePin(workflow.replace(/^\s*OPENCODE_VERSION:.*\n/m, ''), nextPin)).toThrow('exactly one OPENCODE_VERSION');
  });

  it('rejects an incomplete or malformed pin rather than writing a half-verified release', () => {
    expect(() => writeOpenCodePin(workflow, { ...nextPin, OPENCODE_SOURCE_SHA: '950f0d8' })).toThrow('full 40-character Git SHA');
    expect(() => writeOpenCodePin(workflow, { ...nextPin, OPENCODE_BINARY_SHA256: 'short' })).toThrow('64 lowercase hex');
    expect(() => writeOpenCodePin(workflow, { ...nextPin, OPENCODE_RELEASE_TAG: 'nightly' })).toThrow('Invalid fork release tag');
    expect(() => writeOpenCodePin(workflow, { ...nextPin, OPENCODE_VERSION: '' })).toThrow('version is required');
  });

  it('builds a pin only from a green gate decision', () => {
    const candidate = {
      tag: nextPin.OPENCODE_RELEASE_TAG,
      version: nextPin.OPENCODE_VERSION,
      sourceCommit: nextPin.OPENCODE_SOURCE_SHA,
      archiveSha256: nextPin.OPENCODE_ARCHIVE_SHA256,
      binarySha256: nextPin.OPENCODE_BINARY_SHA256,
    };
    expect(pinFromDecision({ outcome: 'promote', candidate })).toEqual(nextPin);
    expect(() => pinFromDecision({ outcome: 'hold', candidate })).toThrow('not a promotion');
  });
});
