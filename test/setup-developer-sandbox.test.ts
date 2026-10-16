import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { developerRecord, initializeKey, readKey, waitForBuildSha } from '../scripts/setup-developer-sandbox.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('local sandbox developer credential setup', () => {
  it('waits for the exact deployed Worker SHA during edge propagation', async () => {
    const sha = 'a'.repeat(40);
    const observed: string[] = [];
    const result = await waitForBuildSha(sha, {
      delays: [0, 1, 2],
      sleep: async () => undefined,
      fetchImpl: async () => {
        const buildSha = observed.length < 2 ? 'b'.repeat(40) : sha;
        observed.push(buildSha);
        return { ok: true, json: async () => ({ buildSha }) } as Response;
      },
    });
    expect(result.buildSha).toBe(sha);
    expect(observed).toEqual(['b'.repeat(40), 'b'.repeat(40), sha]);
  });

  it('fails closed if the deployed Worker never serves the expected SHA', async () => {
    await expect(waitForBuildSha('a'.repeat(40), {
      delays: [0, 1],
      sleep: async () => undefined,
      fetchImpl: async () => ({ ok: true, json: async () => ({ buildSha: 'b'.repeat(40) }) } as Response),
    })).rejects.toThrow('sandbox_build_sha_mismatch');
  });

  it('generates once, keeps the raw key private, and produces only a hash for the Worker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-developer-key-'));
    dirs.push(dir);
    const path = join(dir, 'secrets', 'key');
    expect(initializeKey(path)).toEqual({ created: true, path });
    const first = readKey(path);
    expect(first).toMatch(/^sra_sb_[A-Za-z0-9_-]{43}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'secrets')).mode & 0o777).toBe(0o700);
    expect(initializeKey(path)).toEqual({ created: false, path });
    expect(readKey(path)).toBe(first);
    const record = developerRecord(first);
    expect(record.developerApi).toBe(true);
    expect(record.repository).toBe('trained-assist/ai-agent-runner');
    expect(JSON.stringify(record)).not.toContain(first);
  });

  it('rejects a key file with loose permissions, malformed key or symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-developer-key-'));
    dirs.push(dir);
    const path = join(dir, 'secrets', 'key');
    initializeKey(path);
    writeFileSync(path, 'not-a-key');
    expect(() => readKey(path)).toThrow('developer_key_invalid');
    const link = join(dir, 'secrets', 'link');
    symlinkSync(path, link);
    expect(() => readKey(link)).toThrow('developer_key_file_symlink_forbidden');
    expect(readFileSync(path, 'utf8')).toBe('not-a-key');
  });
});
