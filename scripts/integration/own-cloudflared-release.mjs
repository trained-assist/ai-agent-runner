import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const release = Object.freeze({
  version: '2026.9.3',
  base: '/opt/ta-integrator-cloudflared-releases',
  unit: 'ta-integrator-native-tunnel-v1.service',
  source: 'https://github.com/cloudflare/cloudflared/releases/tag/2026.9.3',
  assets: Object.freeze({
    x64: Object.freeze({ name: 'cloudflared-linux-amd64', machine: 62,
      sha256: '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2' }),
    arm64: Object.freeze({ name: 'cloudflared-linux-arm64', machine: 183,
      sha256: 'aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d' }),
  }),
});

export function validateStaticElf(bytes, arch) {
  const asset = release.assets[arch];
  assert.ok(asset && bytes.length >= 64 && bytes.length <= 134217728);
  assert.deepEqual([...bytes.subarray(0, 7)], [127, 69, 76, 70, 2, 1, 1]);
  assert.ok([0, 3].includes(bytes[7]));
  assert.ok([2, 3].includes(bytes.readUInt16LE(16)));
  assert.equal(bytes.readUInt16LE(18), asset.machine);
  assert.equal(bytes.readUInt32LE(20), 1);
  assert.equal(bytes.readUInt16LE(52), 64);
  const offset = Number(bytes.readBigUInt64LE(32));
  const size = bytes.readUInt16LE(54);
  const count = bytes.readUInt16LE(56);
  assert.ok(Number.isSafeInteger(offset) && offset >= 64 && size === 56 && count > 0 && count < 65535);
  assert.ok(offset + size * count <= bytes.length);
  let load = false;
  for (let index = 0; index < count; index += 1) {
    const type = bytes.readUInt32LE(offset + index * size);
    assert.ok(type !== 2 && type !== 3);
    if (type === 1) load = true;
  }
  assert.ok(load);
}

export function verifyOfficialBinary(bytes, platform, arch) {
  assert.equal(platform, 'linux');
  validateStaticElf(bytes, arch);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, release.assets[arch].sha256);
  return { version: release.version, asset: release.assets[arch].name, sha256, staticElf: true };
}

export function plan() {
  return { defaultAction: 'plan', ...release, downloads: false, stagingWrites: false,
    serviceOperations: false, preserveCurrentPidAndUrl: true, runtimeVerificationPending: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action = 'plan', file, ...extra] = process.argv.slice(2);
    assert.equal(extra.length, 0);
    if (action === 'plan') { assert.equal(file, undefined); console.log(JSON.stringify(plan())); }
    else {
      assert.equal(action, 'verify');
      assert.ok(file && process.platform === 'linux' && process.getuid() === 0);
      const absolute = resolve(file);
      assert.equal(realpathSync(absolute), absolute);
      const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(descriptor);
        assert.ok(stat.isFile() && stat.uid === 0 && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size <= 134217728);
        console.log(JSON.stringify(verifyOfficialBinary(readFileSync(descriptor), process.platform, process.arch)));
      } finally { closeSync(descriptor); }
    }
  } catch {
    console.error('own_cloudflared_verification_refused; no mutation performed');
    process.exitCode = 1;
  }
}
