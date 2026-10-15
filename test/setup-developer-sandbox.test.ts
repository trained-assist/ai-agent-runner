import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { developerRecord, initializeKey, readKey } from '../scripts/setup-developer-sandbox.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('local sandbox developer credential setup', () => {
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
