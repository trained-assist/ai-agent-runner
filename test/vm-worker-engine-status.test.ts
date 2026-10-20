import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeEngineStatus, readBinaryVersion, sha256OfFile } from '../src/vm-worker/engine-status.js';

function sha256Of(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('VM worker engine status', () => {
  it('reports the path, the version and the hash of the binary the worker executes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-engine-status-'));
    const binary = join(dir, 'opencode');
    const script = '#!/bin/sh\necho "0.0.0-ladder-cache-test"\n';
    writeFileSync(binary, script, { mode: 0o755 });
    chmodSync(binary, 0o755);

    const status = await describeEngineStatus(binary);
    expect(status).toEqual({
      name: 'opencode',
      binaryPath: binary,
      binarySha256: sha256Of(script),
      binaryVersion: '0.0.0-ladder-cache-test',
    });
  });

  it('reports an unavailable engine when no binary resolves', async () => {
    expect(await describeEngineStatus(null)).toEqual({
      name: 'opencode',
      binaryPath: null,
      binarySha256: null,
      binaryVersion: null,
    });
  });

  it('keeps the hash and the version unknown when the binary cannot be read or run', async () => {
    const missing = join(tmpdir(), 'ai-agent-runner-engine-status-missing');
    const status = await describeEngineStatus(missing);
    expect(status.binaryPath).toBe(missing);
    expect(status.binarySha256).toBeNull();
    expect(status.binaryVersion).toBeNull();
  });

  it('reads the version of a binary that fails to start as unknown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-agent-runner-engine-broken-'));
    const binary = join(dir, 'opencode');
    writeFileSync(binary, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    chmodSync(binary, 0o755);
    expect(readBinaryVersion(binary)).toBeNull();
  });

  it('hashes a file that cannot be opened as unknown', async () => {
    expect(await sha256OfFile(join(tmpdir(), 'ai-agent-runner-engine-status-absent'))).toBeNull();
  });
});
