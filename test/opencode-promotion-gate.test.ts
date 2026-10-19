import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  extractCandidateBinary,
  parseGateArgs,
  readCandidateIdentity,
  runGateStep,
  sha256OfFile,
} from '../scripts/opencode-promotion-gate.mjs';

const workDir = mkdtempSync(join(tmpdir(), 'promotion-gate-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A tar.gz holding a runnable `opencode` that reports the version we choose. */
function buildCandidateArchive(version: string) {
  const stage = mkdtempSync(join(workDir, 'stage-'));
  const binary = join(stage, 'opencode');
  writeFileSync(binary, `#!/bin/sh\necho "opencode v${version}"\n`, { mode: 0o755 });
  const archive = join(stage, 'opencode-linux-x64.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', stage, 'opencode']);
  return { archive, digest: sha256OfFile(archive) };
}

describe('OpenCode promotion gate', () => {
  it('requires the identity of the candidate being gated', () => {
    expect(() => parseGateArgs(['--candidate-tag', 'mem-preview-20261018-x-17355bd'])).toThrow('--candidate-source is required');
    expect(() => parseGateArgs(['--candidate-tag', 't', '--candidate-source', 'a'.repeat(40), '--work-dir', workDir, '--archive-sha256', 'nope'])).toThrow('64 lowercase hex');
    expect(parseGateArgs(['--candidate-tag', 't', '--candidate-source', 'a'.repeat(40), '--work-dir', workDir, '--archive-sha256', 'a'.repeat(64), '--live', '--suite', 'test/e2e-loop.test.ts'])).toMatchObject({ live: true, suites: ['test/e2e-loop.test.ts'] });
  });

  it('refuses an archive whose bytes do not match the release digest', () => {
    const { archive } = buildCandidateArchive('0.0.0-trim-web-serve-202610172230');
    expect(() => extractCandidateBinary(archive, join(workDir, 'bad'), 'f'.repeat(64))).toThrow('sha256 mismatch');
  });

  it('extracts the binary only after the digest matches, and reads its identity', () => {
    const { archive, digest } = buildCandidateArchive('0.0.0-fork-at-17355bd0dce1');
    const binary = extractCandidateBinary(archive, join(workDir, 'good'), digest);
    const identity = readCandidateIdentity(binary);
    expect(identity.version).toBe('0.0.0-fork-at-17355bd0dce1');
    expect(identity.embeddedSourceCommit).toBe('17355bd0dce1');
    expect(identity.binarySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a release build as carrying no embedded source commit', () => {
    const { archive, digest } = buildCandidateArchive('0.0.0-trim-web-serve-202610172230');
    const binary = extractCandidateBinary(archive, join(workDir, 'release'), digest);
    expect(readCandidateIdentity(binary).embeddedSourceCommit).toBeNull();
  });

  it('does not pretend a Linux binary ran on a host that cannot run it', () => {
    const stage = mkdtempSync(join(workDir, 'elf-'));
    const binary = join(stage, 'opencode');
    // ELF magic of a Linux x64 executable.
    writeFileSync(binary, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]));
    const identity = readCandidateIdentity(binary);
    if (process.platform === 'linux') {
      expect(identity.executableHere).toBe(true);
    } else {
      expect(identity.executableHere).toBe(false);
      expect(identity.version).toBeNull();
      expect(identity.reason).toContain('cannot run on');
      expect(identity.binarySha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('rejects an archive that does not contain an opencode binary', () => {
    const stage = mkdtempSync(join(workDir, 'empty-'));
    writeFileSync(join(stage, 'README'), 'nothing here');
    const archive = join(stage, 'opencode-linux-x64.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', stage, 'README']);
    expect(() => extractCandidateBinary(archive, join(workDir, 'empty'), sha256OfFile(archive))).toThrow('does not contain an opencode binary');
  });

  it('records a failing gate step instead of throwing, so the report survives', () => {
    const failed = runGateStep({ label: 'runner_e2e', command: 'sh', args: ['-c', 'echo boom >&2; exit 3'], cwd: workDir, env: {} });
    expect(failed.status).toBe('fail');
    expect(failed.output).toContain('boom');
    const passed = runGateStep({ label: 'runner_e2e', command: 'sh', args: ['-c', 'echo ok'], cwd: workDir, env: {} });
    expect(passed).toMatchObject({ status: 'pass' });
    expect(passed.output.trim()).toBe('ok');
  });

  it('hashes the candidate bytes so the promotion record names an exact artifact', () => {
    expect(sha256OfFile(join(workDir, 'good', 'candidate', 'opencode'))).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256('abc')).toBe(sha256OfFile((() => { const p = join(workDir, 'abc.txt'); writeFileSync(p, 'abc'); return p; })()));
  });
});
