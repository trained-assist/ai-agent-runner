import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Step,
  describePathMode,
  findSecretsInText,
  findSecretsInTree,
  isTerminalState,
  sha256Hex,
  sleep,
  validateEventChain,
} from './checks.mjs';
import {
  collectAllEvents,
  downloadArtifact,
  getEvents,
  getResult,
  getStatus,
  openEventStream,
  postCancel,
  submitRun,
  waitForStatus,
  waitTerminal,
} from './client.mjs';

const PROBE_SCRIPT = fileURLToPath(new URL('./engine-scripts/probe.mjs', import.meta.url));

// macOS/Node инжектит эту переменную в child process env сам — она не приходит из host-окружения
const PLATFORM_INJECTED_ENV = new Set(['__CF_USER_TEXT_ENCODING']);

function runtimeEnvKeys(keys) {
  return (keys ?? []).filter((name) => !PLATFORM_INJECTED_ENV.has(name));
}

function engineBody(engine, over = {}) {
  const body = {
    engine: { name: engine, adapterVersion: '1' },
    limits: { timeoutMs: over.timeoutMs ?? 15000 },
    envAllowlist: over.envAllowlist ?? [],
    input: over.input ?? { inlinePrompt: 'e2e' },
  };
  if (over.credentialBindings) body.credentialBindings = over.credentialBindings;
  return body;
}

function parseProbeLine(message) {
  const match = /E2E_PROBE name=(\S+) target=(.*?) verdict=(\S+)(?: detail=(.*))?$/.exec(message);
  if (!match) return null;
  return { name: match[1], target: match[2], verdict: match[3], detail: match[4] ?? '' };
}

function findLog(events, pattern) {
  return events.filter((event) => event.type === 'log' && pattern.test(event.payload.message));
}

function logMessages(events) {
  return events.filter((event) => event.type === 'log').map((event) => event.payload.message);
}

function envKeysFromLogs(events) {
  for (const message of logMessages(events)) {
    const match = /^E2E_ENV keys=(.*)$/.exec(message);
    if (match) return match[1].length > 0 ? match[1].split(',') : [];
  }
  return null;
}

// ---------------------------------------------------------------- step 1

export async function stepSubmitIdempotency(ctx, step) {
  const before = await ctx.control.health();
  const body = engineBody('fake', { input: { inlinePrompt: 'e2e step 1: idempotent submit' } });

  const first = await submitRun(ctx.base, ctx.key, 'e2e-step-1', body);
  step.check('первый submit принят: HTTP 202', first.status === 202, `got ${first.status} ${first.text.slice(0, 200)}`);
  const receipt = first.json ?? {};
  step.check(
    'receipt содержит requestId/userTaskId/runId',
    Boolean(receipt.requestId && receipt.userTaskId && receipt.runId),
    JSON.stringify(first.json),
  );
  step.check('deduplicated=false на первом submit', receipt.deduplicated === false, `got ${String(receipt.deduplicated)}`);

  const duplicate = await submitRun(ctx.base, ctx.key, 'e2e-step-1', body);
  step.check('дубль submit: HTTP 200', duplicate.status === 200, `got ${duplicate.status}`);
  step.check('дубль вернул тот же runId', duplicate.json?.runId === receipt.runId, `${duplicate.json?.runId} vs ${receipt.runId}`);
  step.check(
    'дубль вернул тот же requestId и userTaskId',
    duplicate.json?.requestId === receipt.requestId && duplicate.json?.userTaskId === receipt.userTaskId,
    JSON.stringify(duplicate.json),
  );
  step.check('deduplicated=true на дубле', duplicate.json?.deduplicated === true, `got ${String(duplicate.json?.deduplicated)}`);

  const conflictBody = engineBody('fake', { input: { inlinePrompt: 'e2e step 1: different payload' } });
  const conflict = await submitRun(ctx.base, ctx.key, 'e2e-step-1', conflictBody);
  step.check(
    'тот же ключ + другой payload → 409 IDEMPOTENCY_CONFLICT',
    conflict.status === 409 && conflict.json?.error?.code === 'IDEMPOTENCY_CONFLICT',
    `got ${conflict.status} ${conflict.text.slice(0, 200)}`,
  );

  const status = await waitTerminal(ctx.base, ctx.key, receipt.runId);
  step.check('run дошёл до succeeded', status.state === 'succeeded', `state=${status.state}`);
  const result = await getResult(ctx.base, ctx.key, receipt.runId);
  step.check('result доступен: outcome=succeeded', result.status === 200 && result.json?.outcome === 'succeeded', `HTTP ${result.status}`);

  const after = await ctx.control.health();
  const sameRun = after.runsDetail.filter((entry) => entry.runId === receipt.runId);
  step.check('в store ровно одна запись этого run', sameRun.length === 1, `records=${sameRun.length}`);
  step.check('admissions выросли ровно на 1', after.admissions - before.admissions === 1, `${before.admissions}→${after.admissions}`);
  const startsDelta = (after.startsByEngine.fake ?? 0) - (before.startsByEngine.fake ?? 0);
  step.check('engine fake стартовал ровно 1 раз (дубль не перезапустил)', startsDelta === 1, `starts delta=${startsDelta}`);
}

// ---------------------------------------------------------------- step 2

export async function stepEventsStreamReplay(ctx, step) {
  const before = await ctx.control.health();
  const body = engineBody('fake-slow', {
    input: { inlinePrompt: JSON.stringify({ sleepMs: 1400 }) },
    timeoutMs: 20000,
  });
  const submit = await submitRun(ctx.base, ctx.key, 'e2e-step-2', body);
  step.check('submit принят: HTTP 202', submit.status === 202, `got ${submit.status}`);
  const runId = submit.json.runId;

  const first = await openEventStream(ctx.base, ctx.key, runId, { cursor: 0 });
  await first.waitFor(
    (frames) => frames.some((frame) => frame.event === 'started') && frames.some((frame) => frame.event === 'log'),
    10000,
    'started + log over SSE',
  );
  const firstFrames = first.frames;
  const snapshot = firstFrames.find((frame) => frame.event === 'snapshot');
  step.check('SSE отдаёт snapshot перед событиями', Boolean(snapshot), `snapshot=${snapshot ? 'present' : 'absent'}`);
  step.check('SSE в реальном времени доставил started', firstFrames.some((frame) => frame.event === 'started'));
  const resumeFrom = first.lastEventId();
  step.check('cursor для reconnect > 0', resumeFrom > 0, `cursor=${resumeFrom}`);
  first.close();
  await sleep(60);

  const second = await openEventStream(ctx.base, ctx.key, runId, { cursor: resumeFrom });
  await second
    .waitFor((frames) => frames.some((frame) => ['succeeded', 'failed', 'cancelled'].includes(frame.event)), 12000, 'terminal frame after reconnect')
    .catch(() => undefined);

  const conn1 = first.eventFrames().map((frame) => JSON.parse(frame.data));
  const conn2 = second.eventFrames().map((frame) => JSON.parse(frame.data));
  const secondSnapshot = second.frames.find((frame) => frame.event === 'snapshot');
  second.close();

  if (conn2.length > 0) {
    const duplicates = conn1.map((event) => event.sequence).filter((sequence) => conn2.some((event) => event.sequence === sequence));
    step.check('reconnect по cursor не повторяет уже полученные события', duplicates.length === 0, `dupes: ${duplicates.join(',')}`);
    step.check('reconnect продолжает с cursor+1', conn2[0].sequence === resumeFrom + 1, `first=${conn2[0].sequence} cursor=${resumeFrom}`);
  } else {
    const state = secondSnapshot ? JSON.parse(secondSnapshot.data).state : null;
    step.check(
      'reconnect: run уже терминален на момент переподключения (события дочитаны по cursor)',
      isTerminalState(state ?? ''),
      `snapshot state=${state}`,
    );
  }

  const all = await collectAllEvents(ctx.base, ctx.key, runId, { from: 0 });
  const chain = validateEventChain(all, { requireTerminal: true });
  step.check('полнота и порядок claimed→…→succeeded', chain.ok, chain.problems.join('; '));
  step.check('терминальное событие succeeded', all[all.length - 1]?.type === 'succeeded', `last=${all[all.length - 1]?.type}`);
  step.check('claimed ровно один (rerun отсутствует)', all.filter((event) => event.type === 'claimed').length === 1);
  step.check('started присутствует', all.some((event) => event.type === 'started'));

  const bySequence = new Map(all.map((event) => [event.sequence, event]));
  const mismatch = [...conn1, ...conn2].filter((event) => bySequence.get(event.sequence)?.type !== event.type);
  step.check('SSE-события совпадают с JSON replay по sequence', mismatch.length === 0, `mismatch: ${mismatch.map((event) => event.sequence).join(',')}`);

  const middle = Math.max(1, Math.floor(all.length / 2));
  const tail = await getEvents(ctx.base, ctx.key, runId, middle);
  step.check(
    'cursor-реплей от середины отдаёт только события > cursor',
    tail.status === 200 && tail.json.events.every((event) => event.sequence > middle),
    `HTTP ${tail.status}, first=${tail.json?.events?.[0]?.sequence}`,
  );

  const after = await ctx.control.health();
  step.check('engine fake-slow стартовал 1 раз (reconnect ≠ rerun)', (after.startsByEngine['fake-slow'] ?? 0) - (before.startsByEngine['fake-slow'] ?? 0) === 1);
  step.check('admissions выросли ровно на 1', after.admissions - before.admissions === 1, `${before.admissions}→${after.admissions}`);
}

// ---------------------------------------------------------------- step 3

const FAULT_CASES = [
  {
    name: 'nonzero-exit',
    engine: 'fake-nonzero',
    expect: { outcome: 'failed', exitReason: 'nonzero_exit', code: 'ENGINE_NONZERO_EXIT' },
  },
  {
    name: 'startup-failure',
    engine: 'fake-startup',
    expect: { outcome: 'failed', exitReason: 'startup_failure', code: 'ENGINE_STARTUP_FAILED' },
  },
  {
    name: 'timeout',
    engine: 'fake-timeout',
    timeoutMs: 400,
    expect: { outcome: 'failed', exitReason: 'timeout', code: 'TIMEOUT' },
  },
  {
    name: 'crash',
    engine: 'fake-crash',
    expect: { outcome: 'failed', exitReason: 'crash', code: 'ENGINE_CRASH' },
  },
  {
    name: 'fault-spawn',
    engine: 'fake',
    fault: 'spawn',
    expect: { outcome: 'failed', exitReason: 'startup_failure', code: 'ENGINE_STARTUP_FAILED' },
  },
  {
    name: 'fault-preflight',
    engine: 'fake',
    fault: 'preflight',
    expect: { outcome: 'failed', exitReason: 'preflight_refused', code: 'PREFLIGHT_FAILED' },
  },
];

export async function stepFaultInjection(ctx, step) {
  for (const testCase of FAULT_CASES) {
    if (testCase.fault) await ctx.control.injectFault(testCase.fault, { kind: 'throw', once: true });
    const body = engineBody(testCase.engine, {
      timeoutMs: testCase.timeoutMs ?? 15000,
      input: { inlinePrompt: `e2e step 3: ${testCase.name}` },
    });
    const submit = await submitRun(ctx.base, ctx.key, `e2e-step-3-${testCase.name}`, body);
    step.check(`${testCase.name}: submit принят`, submit.status === 202, `HTTP ${submit.status} ${submit.text.slice(0, 160)}`);
    if (submit.status !== 202) continue;
    const runId = submit.json.runId;

    const status = await waitTerminal(ctx.base, ctx.key, runId, 20000);
    step.check(`${testCase.name}: состояние failed`, status.state === 'failed', `state=${status.state}`);

    const result = await getResult(ctx.base, ctx.key, runId);
    const runResult = result.json ?? {};
    step.check(`${testCase.name}: result.outcome=failed`, result.status === 200 && runResult.outcome === 'failed', `HTTP ${result.status} outcome=${runResult.outcome}`);
    step.check(
      `${testCase.name}: структурированный exitReason`,
      runResult.exitReason === testCase.expect.exitReason,
      `expected ${testCase.expect.exitReason}, got ${runResult.exitReason}`,
    );
    step.check(
      `${testCase.name}: failure.code=${testCase.expect.code}`,
      runResult.failure?.code === testCase.expect.code,
      `got ${runResult.failure?.code}`,
    );
    step.check(
      `${testCase.name}: failureClass/retryable заполнены`,
      typeof runResult.failure?.failureClass === 'string' && typeof runResult.failure?.retryable === 'boolean',
      JSON.stringify(runResult.failure ?? null),
    );
    step.check(`${testCase.name}: logPath указывает на scoped log`, typeof runResult.logPath === 'string' && runResult.logPath.includes(runId), String(runResult.logPath));

    const events = await collectAllEvents(ctx.base, ctx.key, runId, { from: 0 });
    const chain = validateEventChain(events, { requireTerminal: true });
    step.check(`${testCase.name}: цепочка событий полная`, chain.ok, chain.problems.join('; '));
    const terminal = events[events.length - 1];
    step.check(
      `${testCase.name}: терминальное событие failed видно клиенту в events`,
      terminal?.type === 'failed' && terminal.payload.code === testCase.expect.code,
      `last=${terminal?.type} code=${terminal?.payload?.code}`,
    );
  }

  await ctx.control.clearFaults();
  const recoveryBody = engineBody('fake', { input: { inlinePrompt: 'e2e step 3: registry drained' } });
  const recovery = await submitRun(ctx.base, ctx.key, 'e2e-step-3-recovery', recoveryBody);
  step.check('после очистки реестра обычный run снова принимается', recovery.status === 202, `HTTP ${recovery.status}`);
  if (recovery.status === 202) {
    const status = await waitTerminal(ctx.base, ctx.key, recovery.json.runId, 20000);
    step.check('реестр faults исчерпан: обычный run succeeded', status.state === 'succeeded', `state=${status.state}`);
  }
}
