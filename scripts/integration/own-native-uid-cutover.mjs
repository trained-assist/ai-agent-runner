import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const paths = Object.freeze({
  unit: 'ta-integrator-runner-native-v1.service',
  user: 'ta-integrator-native-v1',
  code: '/opt/sb/ta-integrator-runner-native-v1',
  releases: '/opt/ta-integrator-runner-native-releases',
  oldJournal: '/var/lib/ta-integrator-runner-native-v1/admission.jsonl',
  oldRegistry: '/etc/agent-runner/integrator-native-v1-key-registry.json',
  oldEnv: '/etc/agent-runner/integrator-native-v1-combined.env',
  config: '/etc/ta-integrator-runner-native-own-v1',
  data: '/var/lib/ta-integrator-runner-native-own-v1',
  rollbackData: '/var/lib/ta-integrator-runner-native-rollback-v1',
  backup: '/var/lib/ta-integrator-native-uid-cutover-v1',
  dropin: '/etc/systemd/system/ta-integrator-runner-native-v1.service.d/90-own-uid.conf',
});
const newJournal = join(paths.data, 'admission.jsonl');
const rollbackJournal = join(paths.rollbackData, 'admission.jsonl');
const registry = join(paths.config, 'key-registry.json');
const environment = join(paths.config, 'service.env');
const stateFile = join(paths.backup, 'state.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonicalRun = /^run_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const loaderVariables = Object.freeze(['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG',
  'LD_DEBUG_OUTPUT', 'LD_PROFILE', 'LD_ORIGIN_PATH', 'LD_ASSUME_KERNEL', 'LD_HWCAP_MASK',
  'LD_BIND_NOT', 'LD_BIND_NOW', 'LD_SHOW_AUXV', 'GCONV_PATH', 'GLIBC_TUNABLES',
  'LOCPATH', 'NLSPATH', 'MALLOC_TRACE', 'GETCONF_DIR', 'HOSTALIASES', 'LOCALDOMAIN', 'RES_OPTIONS']);

export function releasePath(commit) {
  assert.ok(typeof commit === 'string' && /^[a-f0-9]{40}$/.test(commit));
  return join(paths.releases, commit);
}

export function validateQuiescence(gate, bytes, action, now = Date.now()) {
  assert.ok(['apply', 'rollback'].includes(action));
  assert.equal(gate.schemaVersion, 'own-native-uid-quiescence-v1');
  assert.equal(gate.unit, paths.unit);
  assert.equal(gate.action, action);
  assert.equal(gate.ownerApproved, true);
  assert.equal(gate.ingressBlocked, true);
  assert.equal(gate.mcpDisabled, true);
  releasePath(gate.releaseCommit);
  assert.ok(Number.isSafeInteger(gate.targetUid) && gate.targetUid >= 10000 && gate.targetUid <= 60000);
  if (gate.inactiveRecovery === true) {
    assert.equal(action, 'rollback');
    assert.equal(gate.mainPid, 0);
  } else {
    assert.ok(gate.inactiveRecovery === undefined || gate.inactiveRecovery === false);
    assert.ok(Number.isSafeInteger(gate.mainPid) && gate.mainPid > 1);
  }
  const checked = Date.parse(gate.checkedAt);
  assert.ok(Number.isFinite(checked) && checked <= now && now - checked <= 300000);
  assert.equal(gate.journalSha256, digest(bytes));
  assert.ok(bytes.length > 0 && bytes.length <= 16777216 && bytes.at(-1) === 10);
  const admissions = new Map();
  const dispatched = new Set();
  for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
    const entry = JSON.parse(line);
    if (entry.kind === 'admission') {
      const record = entry.record;
      assert.ok(canonicalRun.test(record.runId));
      assert.equal(record.schemaVersion, 2);
      assert.equal(record.principalId, 'integration-v1');
      assert.equal(record.profileId, 'integration-v1');
      assert.equal(record.spec.runId, record.runId);
      assert.equal(record.spec.profileId, record.profileId);
      assert.equal(record.spec.userTaskId, record.userTaskId);
      assert.equal(record.spec.ownerGeneration, record.ownerGeneration);
      assert.equal(record.spec.engine.name, 'dynamic-ip-azure-agent-run');
      assert.ok(Number.isSafeInteger(record.ownerGeneration) && record.ownerGeneration >= 1);
      assert.ok(!admissions.has(record.runId));
      admissions.set(record.runId, record);
    } else {
      assert.equal(entry.kind, 'dispatched');
      assert.ok(admissions.has(entry.runId));
      assert.equal(entry.engine, 'dynamic-ip-azure-agent-run');
      dispatched.add(entry.runId);
    }
  }
  assert.ok(admissions.size > 0 && dispatched.size === admissions.size);
  assert.ok(Array.isArray(gate.runs) && gate.runs.length === admissions.size);
  const proven = new Set();
  for (const result of gate.runs) {
    const record = admissions.get(result.runId);
    assert.ok(record && !proven.has(result.runId));
    assert.equal(result.userTaskId, record.userTaskId);
    assert.equal(result.ownerGeneration, record.ownerGeneration);
    assert.equal(result.exitObserved, true);
    assert.ok(['succeeded', 'failed', 'cancelled'].includes(result.state));
    proven.add(result.runId);
  }
  return { admissions: admissions.size, targetUid: gate.targetUid };
}

function privateBytes(file, allowedOwners = [0]) {
  assert.equal(realpathSync(file), file);
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    assert.ok(stat.isFile() && stat.nlink === 1 && allowedOwners.includes(stat.uid)
      && (stat.mode & 0o777) === 0o600 && stat.size <= 16777216);
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

function command(name, args) {
  return execFileSync(name, args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function optionalCommand(name, args) {
  try { return command(name, args); }
  catch (error) { if (error.status === 2) return ''; throw error; }
}

function serviceProperties() {
  const value = command('systemctl', ['show', paths.unit, '-p', 'User', '-p', 'Group', '-p', 'MainPID', '-p', 'ActiveState', '-p', 'SubState', '-p', 'ControlGroup', '-p', 'WorkingDirectory', '-p', 'EnvironmentFiles', '-p', 'Environment', '-p', 'UnsetEnvironment', '-p', 'PassEnvironment']);
  return Object.fromEntries(value.split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
}

export function verifyReleaseTree(root, file = root) {
  assert.equal(realpathSync(root), root);
  const stat = lstatSync(file);
  assert.equal(stat.uid, 0);
  if (stat.isSymbolicLink()) {
    const target = realpathSync(file);
    assert.ok(target.startsWith(`${root}/`));
    assert.equal(lstatSync(target).uid, 0);
    assert.equal(lstatSync(target).mode & 0o022, 0);
    return;
  }
  assert.equal(stat.mode & 0o022, 0);
  assert.ok(stat.isDirectory() || stat.isFile());
  if (stat.isDirectory()) for (const name of readdirSync(file)) verifyReleaseTree(root, join(file, name));
}

export function verifyRootAncestors(file) {
  let ancestor = dirname(file);
  for (;;) {
    const stat = lstatSync(ancestor);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0);
    if (ancestor === '/') break;
    ancestor = dirname(ancestor);
  }
}

export function verifyRootRelease(commit) {
  const root = releasePath(commit);
  verifyRootAncestors(root);
  const parent = lstatSync(paths.releases);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 && (parent.mode & 0o022) === 0);
  verifyReleaseTree(root);
  const manifest = JSON.parse(readFileSync(join(root, 'root-release.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 'own-native-root-release-v1');
  assert.equal(manifest.sourceCommit, commit);
  assert.equal(digest(readFileSync(join(root, 'package-lock.json'))), manifest.packageLockSha256);
  assert.equal(digest(readFileSync(join(root, 'dist/api/main.js'))), manifest.mainSha256);
  assert.equal(manifest.dependenciesInstalledWithScriptsDisabled, true);
  return root;
}

function publish(file, bytes, uid = 0, gid = 0, replace = false) {
  const temporary = `${file}.own-uid.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, bytes);
    chownSync(temporary, uid, gid);
    fsyncSync(descriptor);
    if (!replace) assert.ok(!existsSync(file));
    renameSync(temporary, file);
    const directory = openSync(dirname(file), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function directory(file, uid, gid, mode) {
  assert.ok(!existsSync(file));
  mkdirSync(file, { mode });
  chownSync(file, uid, gid);
  chmodSync(file, mode);
}

function assertProcess(properties, gate, user, journal, registryPath, code) {
  assert.equal(properties.User, user);
  assert.equal(properties.Group, user);
  assert.equal(properties.WorkingDirectory, code);
  assert.equal(properties.ActiveState, 'active');
  assert.equal(Number(properties.MainPID), gate.mainPid);
  const entries = readFileSync(`/proc/${gate.mainPid}/environ`, 'utf8').split('\0');
  const env = Object.fromEntries(entries.filter(Boolean).map(entry => { const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)]; }));
  assert.equal(env.AGENT_API_PORT, '18879');
  assert.equal(env.AGENT_API_HOST, '127.0.0.1');
  assert.equal(env.AGENT_API_ADMISSION_LOG, journal);
  assert.equal(env.AGENT_API_KEY_REGISTRY, registryPath);
  const argv = readFileSync(`/proc/${gate.mainPid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  validateRunnerArgv(argv, properties.WorkingDirectory, code);
  assertMcpDisabled(env);
  return env;
}

export function assertMcpDisabled(env) {
  assert.ok(!env.AGENT_API_DOCUMENTS_MCP_REGISTRATIONS && !env.AGENT_API_DOCUMENTS_MCP_MODULE
    && !env.AGENT_API_REMOTE_MCP_BINDINGS_FILE
    && (!env.AGENT_API_REMOTE_MCP_SERVERS || env.AGENT_API_REMOTE_MCP_SERVERS === '{}'));
}

export function validateRunnerArgv(argv, workingDirectory, code) {
  assert.equal(workingDirectory, code);
  assert.ok(Array.isArray(argv) && argv.length === 2);
  assert.equal(argv[0], '/usr/local/bin/node');
  assert.ok(argv[1] === join(code, 'dist/api/main.js') || argv[1] === 'dist/api/main.js');
}

export function validateInactiveRecovery(properties, gate, release) {
  assert.equal(gate.action, 'rollback');
  assert.equal(gate.inactiveRecovery, true);
  assert.equal(gate.mainPid, 0);
  assert.equal(properties.MainPID, '0');
  assert.equal(properties.ActiveState, 'inactive');
  assert.equal(properties.SubState, 'dead');
  assert.equal(properties.User, paths.user);
  assert.equal(properties.Group, paths.user);
  assert.equal(properties.WorkingDirectory, release);
  assert.equal(properties.EnvironmentFiles, `${environment} (ignore_errors=no)`);
  for (const key of ['Environment', 'UnsetEnvironment', 'PassEnvironment']) assert.equal(properties[key], '');
  assert.equal(properties.ControlGroup, '');
}

export function routingEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => /^(AGENT_API_|EXTERNAL_WORKER_|DYNAMIC_IP_AZURE_|RUNNER_|NODE_|GOOGLE_|GCLOUD_|GCP_)/.test(key)
    || ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(key)).sort(([left], [right]) => left.localeCompare(right)));
}

export function validateStagedEnvironment(actual, baseline, overrides = {}) {
  assertMcpDisabled(actual);
  assertMcpDisabled(baseline);
  assert.deepEqual(routingEnvironment(actual), routingEnvironment({ ...baseline, ...overrides }));
}

export function validateEnvironmentPin(bytes, expected) {
  assert.equal(digest(bytes), expected);
}

export function rejectLoaderEnvironment(env, bytes) {
  for (const name of loaderVariables) {
    assert.ok(!env[name]);
    assert.ok(!bytes.toString('utf8').includes(name));
  }
  assert.ok(!Object.keys(env).some(name => name.startsWith('LD_') && env[name]));
  assert.ok(!bytes.toString('utf8').includes('LD_'));
}

function parseSystemdEnvironment(file, expected) {
  verifyRootAncestors(file);
  const bytes = privateBytes(file);
  validateEnvironmentPin(bytes, expected);
  rejectLoaderEnvironment({}, bytes);
  const output = command('systemd-run', ['--quiet', '--wait', '--pipe', '--collect',
    '--property=Type=exec', '--property=User=root', '--property=Group=root',
    '--property=NoNewPrivileges=yes', '--property=ProtectSystem=strict', '--property=ProtectHome=yes',
    '--property=PrivateNetwork=yes', '--property=PrivateTmp=yes', '--property=RuntimeMaxSec=10',
    `--property=UnsetEnvironment=${loaderVariables.join(' ')}`,
    `--property=EnvironmentFile=${file}`, '/usr/bin/env', '-0']);
  const parsed = Object.fromEntries(output.split('\0').filter(Boolean).map(entry => {
    const index = entry.indexOf('=');
    assert.ok(index > 0);
    return [entry.slice(0, index), entry.slice(index + 1)];
  }));
  validateEnvironmentPin(privateBytes(file), expected);
  return parsed;
}

export function cutoverPlan() {
  return { unit: paths.unit, newUser: paths.user, legacyUidUntouched: 1002,
    sourceOnly: true, defaultAction: 'plan', quiescenceRequired: true,
    journalHasNoTerminalProof: true, newJournal, newRegistry: registry,
    rootReleaseBase: paths.releases, sourceReleaseRequired: true,
    dropin: paths.dropin, vaultProvisioning: false, sharedChown: false,
    rollback: 'fresh gate; stop own unit; copy current journal to isolated rollback path; replace only own drop-in with journal override; start own unit' };
}

export function executeCutover(action, gateFile) {
  assert.ok(process.platform === 'linux' && process.getuid() === 0);
  const lockPath = '/run/ta-integrator-native-uid-cutover-v1.lock';
  const lock = openSync(lockPath, 'wx', 0o600);
  try { return performCutover(action, gateFile); }
  finally { closeSync(lock); unlinkSync(lockPath); }
}

function performCutover(action, gateFile) {
  assert.ok(['apply', 'rollback'].includes(action));
  const gatePath = resolve(gateFile);
  const gateDirectory = lstatSync(dirname(gatePath));
  assert.ok(gateDirectory.isDirectory() && !gateDirectory.isSymbolicLink()
    && gateDirectory.uid === 0 && (gateDirectory.mode & 0o777) === 0o700);
  const gate = JSON.parse(privateBytes(gatePath));
  const uid = gate.targetUid;
  const journal = action === 'apply' ? paths.oldJournal : newJournal;
  const bytes = privateBytes(journal, [action === 'apply' ? 1002 : uid]);
  validateQuiescence(gate, bytes, action);
  const release = verifyRootRelease(gate.releaseCommit);
  const currentCode = action === 'apply' ? paths.code : release;
  const properties = serviceProperties();
  const inactive = gate.inactiveRecovery === true;
  let baseline;
  if (inactive) validateInactiveRecovery(properties, gate, release);
  else baseline = assertProcess(properties, gate, action === 'apply' ? 'sandbox' : paths.user, journal, action === 'apply' ? paths.oldRegistry : registry, currentCode);
  if (baseline) rejectLoaderEnvironment(baseline, Buffer.alloc(0));
  for (const key of ['Environment', 'UnsetEnvironment', 'PassEnvironment']) assert.equal(properties[key], '');
  let state;
  let env;
  let keys;
  let staged;
  let stagedFile;
  let stagedHash;
  const overrides = { AGENT_API_HOST: '127.0.0.1', AGENT_API_PORT: '18879',
    AGENT_API_KEY_REGISTRY: action === 'apply' ? registry : paths.oldRegistry,
    AGENT_API_ADMISSION_LOG: action === 'apply' ? newJournal : rollbackJournal };
  if (action === 'apply') {
    assert.equal(properties.EnvironmentFiles, `${paths.oldEnv} (ignore_errors=no)`);
    assert.ok(!existsSync(paths.backup) && !existsSync(paths.config) && !existsSync(paths.data) && !existsSync(paths.dropin));
    const dropinDirectory = dirname(paths.dropin);
    if (existsSync(dropinDirectory)) {
      const stat = lstatSync(dropinDirectory);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0);
    }
    assert.equal(optionalCommand('getent', ['passwd', paths.user]), '');
    assert.equal(optionalCommand('getent', ['passwd', String(uid)]), '');
    assert.equal(optionalCommand('getent', ['group', paths.user]), '');
    assert.equal(optionalCommand('getent', ['group', String(uid)]), '');
    verifyRootAncestors(paths.oldEnv);
    env = privateBytes(paths.oldEnv);
    rejectLoaderEnvironment(baseline, env);
    keys = privateBytes(paths.oldRegistry, [0, 1002]);
    state = { schemaVersion: 'own-native-uid-cutover-v1', targetUid: uid, releaseCommit: gate.releaseCommit, originalJournalSha256: digest(bytes),
      originalEnvironmentSha256: digest(env), originalRegistrySha256: digest(keys) };
    directory(paths.backup, 0, 0, 0o700);
    const original = join(paths.backup, 'original.env');
    publish(original, env);
    validateStagedEnvironment(parseSystemdEnvironment(original, digest(env)), baseline);
    staged = Buffer.concat([env, Buffer.from(`\nAGENT_API_HOST=127.0.0.1\nAGENT_API_PORT=18879\nAGENT_API_KEY_REGISTRY=${registry}\nAGENT_API_ADMISSION_LOG=${newJournal}\n`)]);
    stagedFile = join(paths.backup, 'staged.env');
  } else {
    state = JSON.parse(privateBytes(stateFile));
    assert.equal(state.schemaVersion, 'own-native-uid-cutover-v1');
    assert.equal(state.targetUid, uid);
    assert.equal(state.releaseCommit, gate.releaseCommit);
    validateEnvironmentPin(privateBytes(environment), state.stagedEnvironmentSha256);
    if (inactive) baseline = parseSystemdEnvironment(environment, state.stagedEnvironmentSha256);
    verifyRootAncestors(paths.oldEnv);
    assert.equal(digest(privateBytes(paths.oldEnv)), state.originalEnvironmentSha256);
    assert.equal(digest(privateBytes(paths.oldRegistry, [0, 1002])), state.originalRegistrySha256);
    assert.equal(digest(privateBytes(paths.oldJournal, [1002])), state.originalJournalSha256);
    assert.equal(command('id', ['-u', paths.user]), String(uid));
    assert.equal(command('id', ['-g', paths.user]), String(uid));
    assert.equal(readFileSync(paths.dropin, 'utf8'), dropinText(release));
    assert.ok(!existsSync(paths.rollbackData));
    env = privateBytes(join(paths.backup, 'original.env'));
    validateEnvironmentPin(env, state.originalEnvironmentSha256);
    staged = Buffer.concat([env, Buffer.from(`\nAGENT_API_ADMISSION_LOG=${rollbackJournal}\n`)]);
    stagedFile = join(paths.backup, 'staged-rollback.env');
  }
  stagedHash = digest(staged);
  if (action === 'apply') state.stagedEnvironmentSha256 = stagedHash;
  publish(stagedFile, staged);
  const expectedEnvironment = parseSystemdEnvironment(stagedFile, stagedHash);
  validateStagedEnvironment(expectedEnvironment, baseline, overrides);
  const beforeStop = serviceProperties();
  assert.deepEqual(beforeStop, properties);
  if (inactive) {
    validateInactiveRecovery(beforeStop, gate, release);
    validateStagedEnvironment(parseSystemdEnvironment(environment, state.stagedEnvironmentSha256), baseline);
  } else validateStagedEnvironment(assertProcess(beforeStop, gate, action === 'apply' ? 'sandbox' : paths.user, journal, action === 'apply' ? paths.oldRegistry : registry, currentCode), baseline);
  verifyRootRelease(gate.releaseCommit);
  validateQuiescence(gate, privateBytes(journal, [action === 'apply' ? 1002 : uid]), action);
  validateEnvironmentPin(privateBytes(stagedFile), stagedHash);
  if (!inactive) command('systemctl', ['stop', paths.unit]);
  assert.equal(serviceProperties().ActiveState, 'inactive');
  if (inactive) validateInactiveRecovery(serviceProperties(), gate, release);
  validateQuiescence(gate, privateBytes(journal, [action === 'apply' ? 1002 : uid]), action);
  if (action === 'apply') {
    publish(join(paths.backup, 'original-admission.jsonl'), bytes);
    publish(stateFile, JSON.stringify(state));
    command('groupadd', ['--gid', String(uid), paths.user]);
    command('useradd', ['--uid', String(uid), '--gid', paths.user, '--no-create-home', '--home-dir', '/', '--shell', '/usr/sbin/nologin', paths.user]);
    assert.equal(command('id', ['-G', paths.user]), String(uid));
    directory(paths.config, 0, uid, 0o750);
    directory(paths.data, uid, uid, 0o700);
    publish(registry, keys, uid, uid);
    publish(newJournal, bytes, uid, uid);
    publish(environment, privateBytes(stagedFile));
    const dropinDirectory = dirname(paths.dropin);
    if (!existsSync(dropinDirectory)) mkdirSync(dropinDirectory, { mode: 0o755 });
    assert.ok(lstatSync(dropinDirectory).isDirectory() && !lstatSync(dropinDirectory).isSymbolicLink() && lstatSync(dropinDirectory).uid === 0);
    publish(paths.dropin, dropinText(release));
    chmodSync(paths.dropin, 0o644);
  } else {
    publish(join(paths.backup, 'rollback-admission.jsonl'), bytes);
    directory(paths.rollbackData, 1002, 1002, 0o700);
    publish(rollbackJournal, bytes, 1002, 1002);
    publish(join(paths.config, 'rollback.env'), privateBytes(stagedFile));
    publish(paths.dropin, `[Service]\nEnvironmentFile=\nEnvironmentFile=${paths.config}/rollback.env\n`, 0, 0, true);
    chmodSync(paths.dropin, 0o644);
  }
  command('systemctl', ['daemon-reload']);
  const activeEnvironment = action === 'apply' ? environment : join(paths.config, 'rollback.env');
  validateEnvironmentPin(privateBytes(activeEnvironment), stagedHash);
  validateStagedEnvironment(parseSystemdEnvironment(activeEnvironment, stagedHash), expectedEnvironment);
  command('systemctl', ['start', paths.unit]);
  try {
  const after = serviceProperties();
  assert.equal(after.User, action === 'apply' ? paths.user : 'sandbox');
  assert.equal(after.Group, after.User);
  assert.equal(after.ActiveState, 'active');
  assert.equal(after.WorkingDirectory, action === 'apply' ? release : paths.code);
  const effectiveUid = Number(readFileSync(`/proc/${after.MainPID}/status`, 'utf8').match(/^Uid:\s+\d+\s+(\d+)/m)?.[1]);
  assert.equal(effectiveUid, action === 'apply' ? uid : 1002);
  assert.equal(after.EnvironmentFiles, `${activeEnvironment} (ignore_errors=no)`);
  for (const key of ['Environment', 'UnsetEnvironment', 'PassEnvironment']) assert.equal(after[key], '');
  validateEnvironmentPin(privateBytes(activeEnvironment), stagedHash);
  validateStagedEnvironment(assertProcess(after, { mainPid: Number(after.MainPID) }, after.User,
    overrides.AGENT_API_ADMISSION_LOG, overrides.AGENT_API_KEY_REGISTRY, after.WorkingDirectory), expectedEnvironment);
  assert.equal(digest(privateBytes(action === 'apply' ? newJournal : rollbackJournal, [action === 'apply' ? uid : 1002])), digest(bytes));
  return { action, unit: paths.unit, user: after.User, admissionBytesPreserved: true,
    healthAndNativeReadbackPending: true, ingressMustRemainBlocked: true };
  } catch (error) {
    command('systemctl', ['stop', paths.unit]);
    throw error;
  }
}

function dropinText(release) {
  return `[Service]\nUser=${paths.user}\nGroup=${paths.user}\nSupplementaryGroups=\nUMask=0077\nWorkingDirectory=${release}\nExecStart=\nExecStart=/usr/local/bin/node ${release}/dist/api/main.js\nEnvironmentFile=\nEnvironmentFile=${environment}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action = 'plan', gateFile, ...extra] = process.argv.slice(2);
    assert.equal(extra.length, 0);
    if (action === 'plan') { assert.equal(gateFile, undefined); console.log(JSON.stringify(cutoverPlan())); }
    else { assert.ok(gateFile); console.log(JSON.stringify(executeCutover(action, gateFile))); }
  } catch {
    console.error('own_native_uid_cutover_refused_or_incomplete; keep ingress blocked; reconcile own unit privately; no automatic restart or rollback');
    process.exitCode = 1;
  }
}
