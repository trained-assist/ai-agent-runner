import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { paths, releasePath, verifyRootAncestors, verifyRootRelease, verifyReleaseTree } from './own-native-uid-cutover.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateSourceTar(bytes, commit) {
  releasePath(commit);
  assert.ok(bytes.length > 1024 && bytes.length <= 67108864 && bytes.length % 512 === 0);
  let offset = 0;
  let sourceComment = false;
  const names = new Set();
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) {
      assert.ok(bytes.subarray(offset).every(value => value === 0));
      break;
    }
    const text = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const expected = Number.parseInt(text(148, 156).trim(), 8);
    const checksum = [...header].reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    assert.equal(checksum, expected);
    const size = Number.parseInt(text(124, 136).trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= bytes.length);
    const type = text(156, 157);
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    if (type === 'g') {
      assert.ok(!sourceComment);
      assert.ok(new RegExp(`^\\d+ comment=${commit}\\n$`).test(body.toString('utf8')));
      sourceComment = true;
    } else {
      assert.ok(['', '0', '5'].includes(type));
      assert.equal(text(157, 257), '');
      const prefix = text(345, 500);
      const name = `${prefix ? `${prefix}/` : ''}${text(0, 100)}`.replace(/\/$/, '');
      assert.ok(name && /^[A-Za-z0-9_.\/-]+$/.test(name));
      assert.ok(name.split('/').every(part => part && part !== '.' && part !== '..'));
      assert.ok(!['node_modules', 'dist', '.git'].includes(name.split('/')[0]));
      assert.ok(!names.has(name) && name !== 'root-release.json');
      if (type === '5') assert.equal(size, 0);
      names.add(name);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(sourceComment && names.has('package.json') && names.has('package-lock.json') && names.has('src/api/main.ts'));
  return { entries: names.size };
}

export function stagePlan() {
  return { defaultAction: 'plan', releaseBase: paths.releases, existingCodeUntouched: paths.code,
    rootOnly: true, sourceCommitAndArchiveHashRequired: true, sharedChown: false,
    serviceOperations: false, vaultAccess: false, rootBuildEnvironment: 'empty except local PATH/HOME/npm cache' };
}

function harden(file) {
  const stat = lstatSync(file);
  assert.equal(stat.uid, 0);
  if (stat.isSymbolicLink()) return;
  assert.ok(stat.isFile() || stat.isDirectory());
  chmodSync(file, stat.isDirectory() || stat.mode & 0o111 ? 0o755 : 0o644);
  if (stat.isDirectory()) for (const name of readdirSync(file)) harden(join(file, name));
}

export function stageRelease(archive, commit, archiveSha256, packageLockSha256) {
  assert.ok(process.platform === 'linux' && process.getuid() === 0);
  assert.ok(/^[a-f0-9]{64}$/.test(archiveSha256) && /^[a-f0-9]{64}$/.test(packageLockSha256));
  const final = releasePath(commit);
  const archivePath = resolve(archive);
  assert.equal(realpathSync(archivePath), archivePath);
  const descriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = fstatSync(descriptor);
    assert.ok(stat.isFile() && stat.uid === 0 && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size <= 67108864);
    bytes = readFileSync(descriptor);
  } finally { closeSync(descriptor); }
  assert.equal(hash(bytes), archiveSha256);
  validateSourceTar(bytes, commit);
  verifyRootAncestors(paths.releases);
  const base = lstatSync(dirname(paths.releases));
  assert.ok(base.isDirectory() && !base.isSymbolicLink() && base.uid === 0 && (base.mode & 0o022) === 0);
  try { mkdirSync(paths.releases, { mode: 0o755 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const parent = lstatSync(paths.releases);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 && (parent.mode & 0o022) === 0);
  assert.equal(realpathSync(paths.releases), paths.releases);
  try { lstatSync(final); throw new Error('RELEASE_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = `${final}.staging`;
  mkdirSync(staging, { mode: 0o700 });
  const privateLog = `${final}.build.private.log`;
  const log = openSync(privateLog, 'wx', 0o600);
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(staging, '.build-home'),
    npm_config_cache: join(staging, '.npm-cache') };
  mkdirSync(env.HOME, { mode: 0o700 });
  const run = (name, args, input) => execFileSync(name, args, {
    cwd: staging, env, input, stdio: [input ? 'pipe' : 'ignore', log, log], timeout: 300000,
  });
  try {
    run('tar', ['--no-same-owner', '--no-same-permissions', '--keep-old-files', '-xf', '-'], bytes);
    assert.equal(hash(readFileSync(join(staging, 'package-lock.json'))), packageLockSha256);
    run('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
    run('npm', ['run', 'build']);
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
    assert.equal(hash(readFileSync(join(staging, 'package-lock.json'))), packageLockSha256);
    run(process.execPath, ['--check', 'dist/api/main.js']);
    run(process.execPath, ['--input-type=module', '-e', "await import('./dist/adapters/remote-mcp.js'); await import('@google-cloud/storage');"]);
    rmSync(env.HOME, { recursive: true });
    rmSync(env.npm_config_cache, { recursive: true });
    writeFileSync(join(staging, 'root-release.json'), JSON.stringify({ schemaVersion: 'own-native-root-release-v1',
      sourceCommit: commit, archiveSha256, packageLockSha256, mainSha256: hash(readFileSync(join(staging, 'dist/api/main.js'))),
      dependenciesInstalledWithScriptsDisabled: true }), { mode: 0o644 });
    harden(staging);
    verifyReleaseTree(staging);
    renameSync(staging, final);
    const directory = openSync(paths.releases, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    verifyRootRelease(commit);
    return { sourceCommit: commit, release: final, compiledModulesLoad: true, dependenciesPinned: true,
      rootOwned: true, sharedCodeUntouched: true, serviceOperations: false, privateBuildLog: privateLog };
  } finally { fsyncSync(log); closeSync(log); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action = 'plan', ...args] = process.argv.slice(2);
    if (action === 'plan') { assert.equal(args.length, 0); console.log(JSON.stringify(stagePlan())); }
    else { assert.equal(action, 'stage'); assert.equal(args.length, 4); console.log(JSON.stringify(stageRelease(...args))); }
  } catch { console.error('own_native_root_release_refused_or_incomplete; no service changes; inspect private staging log'); process.exitCode = 1; }
}
