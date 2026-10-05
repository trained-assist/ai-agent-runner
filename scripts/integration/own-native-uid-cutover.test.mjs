import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cutoverPlan, paths, validateQuiescence } from './own-native-uid-cutover.mjs';

const now = Date.parse('2026-10-05T07:00:00Z');
const runId = 'run_00000000-0000-0000-0000-000000000001';
const record = { schemaVersion: 2, runId, principalId: 'integration-v1', profileId: 'integration-v1',
  userTaskId: 'task-1', ownerGeneration: 1,
  spec: { runId, profileId: 'integration-v1', userTaskId: 'task-1', ownerGeneration: 1, engine: { name: 'dynamic-ip-azure-agent-run' } } };
function fixture(action = 'apply') {
  const bytes = Buffer.from(`${JSON.stringify({ kind: 'admission', record })}\n${JSON.stringify({ kind: 'dispatched', runId, engine: 'dynamic-ip-azure-agent-run' })}\n`);
  const gate = { schemaVersion: 'own-native-uid-quiescence-v1', action, unit: paths.unit, ownerApproved: true,
    ingressBlocked: true, mcpDisabled: true, targetUid: 12079, mainPid: 12345,
    checkedAt: new Date(now - 1000).toISOString(), journalSha256: createHash('sha256').update(bytes).digest('hex'),
    runs: [{ runId, userTaskId: 'task-1', ownerGeneration: 1, state: 'succeeded', exitObserved: true }] };
  return { bytes, gate };
}

test('default CLI prints a plan without Linux/root/file/service access', () => {
  const output = execFileSync(process.execPath, [new URL('./own-native-uid-cutover.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), cutoverPlan());
  assert.equal(cutoverPlan().sharedChown, false);
  assert.equal(cutoverPlan().vaultProvisioning, false);
  assert.equal(cutoverPlan().legacyUidUntouched, 1002);
});

for (const action of ['apply', 'rollback']) test(`${action} accepts only fresh complete terminal reconciliation`, () => {
  const { bytes, gate } = fixture(action);
  assert.deepEqual(validateQuiescence(gate, bytes, action, now), { admissions: 1, targetUid: 12079 });
});

for (const [name, change] of [
  ['legacy unit', { unit: 'agent-runner-api.service' }], ['missing approval', { ownerApproved: false }],
  ['live ingress', { ingressBlocked: false }], ['enabled MCP', { mcpDisabled: false }],
  ['legacy UID', { targetUid: 1002 }], ['bad UID', { targetUid: 12079.1 }], ['unknown PID', { mainPid: 0 }],
  ['stale', { checkedAt: new Date(now - 300001).toISOString() }], ['future', { checkedAt: new Date(now + 1).toISOString() }],
  ['wrong journal', { journalSha256: '0'.repeat(64) }], ['wrong action', { action: 'rollback' }],
  ['omitted run', { runs: [] }],
]) test(`refuses ${name} before any mutation`, () => {
  const { bytes, gate } = fixture();
  assert.throws(() => validateQuiescence({ ...gate, ...change }, bytes, 'apply', now));
});

for (const state of ['queued', 'starting', 'running', 'unknown', 'interrupted']) test(`refuses ${state} reconciliation`, () => {
  const { bytes, gate } = fixture();
  gate.runs[0].state = state;
  assert.throws(() => validateQuiescence(gate, bytes, 'apply', now));
});

for (const change of [{ runId: runId.slice(4) }, { userTaskId: 'task-2' }, { ownerGeneration: 2 }, { exitObserved: false }]) {
  test(`refuses substituted terminal identity ${Object.keys(change)[0]}`, () => {
    const { bytes, gate } = fixture();
    Object.assign(gate.runs[0], change);
    assert.throws(() => validateQuiescence(gate, bytes, 'apply', now));
  });
}

test('new CSV admission invalidates a previously all-terminal gate', () => {
  const { bytes, gate } = fixture();
  const next = { ...record, runId: 'run_00000000-0000-0000-0000-000000000002' };
  const changed = Buffer.concat([bytes, Buffer.from(`${JSON.stringify({ kind: 'admission', record: next })}\n`)]);
  assert.throws(() => validateQuiescence(gate, changed, 'apply', now));
  gate.journalSha256 = createHash('sha256').update(changed).digest('hex');
  assert.throws(() => validateQuiescence(gate, changed, 'apply', now));
});

test('partial or unrecognized journal refuses instead of ignoring corruption', () => {
  const { bytes, gate } = fixture();
  for (const changed of [bytes.subarray(0, bytes.length - 1), Buffer.from(''), Buffer.from('{"kind":"terminal"}\n')]) {
    gate.journalSha256 = createHash('sha256').update(changed).digest('hex');
    assert.throws(() => validateQuiescence(gate, changed, 'apply', now));
  }
});

test('operator cannot claim terminal records belonging to another admission owner', () => {
  const { gate } = fixture();
  const changed = Buffer.from(`${JSON.stringify({ kind: 'admission', record: { ...record, principalId: 'legacy' } })}\n`);
  gate.journalSha256 = createHash('sha256').update(changed).digest('hex');
  assert.throws(() => validateQuiescence(gate, changed, 'apply', now));
});

test('duplicated evidence cannot hide a missing admission', () => {
  const { bytes, gate } = fixture();
  gate.runs.push({ ...gate.runs[0] });
  assert.throws(() => validateQuiescence(gate, bytes, 'apply', now));
});

test('unsafe CLI action emits only a fixed refusal, not private inputs', () => {
  const result = spawnSync(process.execPath, [new URL('./own-native-uid-cutover.mjs', import.meta.url).pathname, 'unsafe-secret-sentinel'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('unsafe-secret-sentinel'));
});

test('script never invokes recursive chown, legacy units, SSH, Google or vault provisioning', () => {
  const source = readFileSync(new URL('./own-native-uid-cutover.mjs', import.meta.url), 'utf8');
  assert.ok(!/chown.*-R|https?:\/\/|ssh|\.host-encryption-key|userdel|groupdel/.test(source));
  assert.ok(!source.includes("['restart'"));
  assert.ok(!source.includes("['enable'"));
  assert.ok(!source.includes('publish(paths.oldJournal'));
});
