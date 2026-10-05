import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { plan, release, validateStaticElf, verifyOfficialBinary } from './own-cloudflared-release.mjs';

function elf(arch = 'x64', type = 1) {
  const bytes = Buffer.alloc(120);
  bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(release.assets[arch].machine, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(type, 64);
  return bytes;
}

test('default plan has no download, mutation or runtime actions', () => {
  const result = JSON.parse(execFileSync(process.execPath, [new URL('./own-cloudflared-release.mjs', import.meta.url).pathname], { encoding: 'utf8' }));
  assert.deepEqual(result, plan());
  assert.equal(result.base, '/opt/ta-integrator-cloudflared-releases');
  assert.equal(result.preserveCurrentPidAndUrl, true);
});
for (const arch of ['x64', 'arm64']) test(`${arch} ELF layout accepted but synthetic checksum never passes official verification`, () => {
  validateStaticElf(elf(arch), arch);
  assert.throws(() => verifyOfficialBinary(elf(arch), 'linux', arch));
  assert.throws(() => verifyOfficialBinary(elf(arch), 'darwin', arch));
});
for (const type of [2, 3]) test(`loader dependency program header ${type} refuses`, () => {
  assert.throws(() => validateStaticElf(elf('x64', type), 'x64'));
});
test('wrong machine, unsupported architecture, truncated and malformed headers refuse', () => {
  assert.throws(() => validateStaticElf(elf(), 'arm64'));
  assert.throws(() => validateStaticElf(elf(), 'ia32'));
  assert.throws(() => validateStaticElf(elf().subarray(0, 100), 'x64'));
  const bytes = elf();
  bytes.writeBigUInt64LE(0xffffffffffffffffn, 32);
  assert.throws(() => validateStaticElf(bytes, 'x64'));
});
test('verifier source cannot download, stage, execute inspected binary or operate units', () => {
  const source = readFileSync(new URL('./own-cloudflared-release.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /execFile|spawn|fetch\(|https\.get|writeFile|mkdir|chmod|chown|rename|systemctl/);
});
