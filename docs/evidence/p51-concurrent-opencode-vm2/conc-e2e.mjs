import { createHmac } from 'node:crypto';

const BASE = 'http://127.0.0.1:8899';
const PRINCIPAL = 'sandbox-cp23';
const PROFILE = 'profile-cp23';
const SECRET = process.env.PRINCIPAL_SECRET;
const RUNNER = 'http://169.58.15.230:8787';
const RKEY = process.env.RUNNER_API_KEY;

const sig = createHmac('sha256', SECRET).update(PRINCIPAL).digest('hex');
const auth = { 'x-principal': PRINCIPAL, 'x-principal-sig': sig };
const call = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? auth : { ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
};
const rcall = async (method, path, body) => {
  const res = await fetch(`${RUNNER}${path}`, {
    method,
    headers: { Authorization: `Bearer ${RKEY}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) throw new Error(`runner ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

const waitFor = async (taskId, want) => {
  for (let i = 0; i < 200; i++) {
    const s = await call('POST', '/status', { taskId });
    if (want.includes(s.taskStore.status)) return s;
    await sleep(2000);
  }
  throw new Error(`timeout waiting ${want} for ${taskId}`);
};
const runnerRunId = async (taskId) => {
  for (let i = 0; i < 80; i++) {
    const s = await call('POST', '/status', { taskId });
    const r = s.taskStore?.result?.runId;
    if (r) return r;
    await sleep(1500);
  }
  throw new Error(`runId Runner'а не появился для ${taskId}`);
};
const evOf = async (runId) => (await rcall('GET', `/v1/runs/${runId}/events?limit=300`)).events || [];
const resOf = async (runId) => rcall('GET', `/v1/runs/${runId}/result`);
const msg = (evs, needle) => {
  const e = evs.find((x) => String(x.payload?.message || '').includes(needle));
  return e ? String(e.payload.message) : null;
};

// ── Две задачи одновременно ───────────────────────────────────────────────
const tagA = `ALPHA-${Date.now()}`;
const tagB = `BETA-${Date.now()}`;
const [a, b] = await Promise.all([
  call('POST', '/intake', { contractVersion: 1, requestId: `ca-${tagA}`, profileId: PROFILE,
    inputItems: [{ text: `Создай файл out.txt с единственной строкой ${tagA}. Дальше ничего не делай, просто подожди 25 секунд.` }] }),
  call('POST', '/intake', { contractVersion: 1, requestId: `cb-${tagB}`, profileId: PROFILE,
    inputItems: [{ text: `Создай файл out.txt с единственной строкой ${tagB}. Дальше ничего не делай, просто подожди 25 секунд.` }] }),
]);
record('обе задачи приняты', a.durable && b.durable, `${a.userTaskId} / ${b.userTaskId}`);

const [aStart, bStart] = await Promise.all([
  call('POST', '/start', { taskId: a.userTaskId, profileId: PROFILE, goal: 'a' }),
  call('POST', '/start', { taskId: b.userTaskId, profileId: PROFILE, goal: 'b' }),
]);
record('оба рана стартовали', Boolean(aStart.runId) && Boolean(bStart.runId), `${aStart.runId} / ${bStart.runId}`);

const [rRunA, rRunB] = await Promise.all([runnerRunId(a.userTaskId), runnerRunId(b.userTaskId)]);
record('runId движка у обеих', Boolean(rRunA) && Boolean(rRunB), `${rRunA} / ${rRunB}`);

// ── Ждём завершения обеих, затем смотрим перекрытие по времени ────────────
const [aDone, bDone] = await Promise.all([waitFor(a.userTaskId, ['done', 'failed']), waitFor(b.userTaskId, ['done', 'failed'])]);
record('обе задачи завершились', aDone.taskStore.status === 'done' && bDone.taskStore.status === 'done',
  `${aDone.taskStore.status} / ${bDone.taskStore.status}`);

const [ra, rb] = await Promise.all([resOf(rRunA), resOf(rRunB)]);
const overlap = ra.startedAt <= rb.finishedAt && rb.startedAt <= ra.finishedAt;
record('два настоящих OpenCode пересекались по времени', overlap,
  `A ${ra.startedAt}→${ra.finishedAt} | B ${rb.startedAt}→${rb.finishedAt}`);

// ── Разные идентичности ───────────────────────────────────────────────────
const [evA, evB] = await Promise.all([evOf(rRunA), evOf(rRunB)]);
const idA = msg(evA, 'identity_verified') || '';
const idB = msg(evB, 'identity_verified') || '';
const slotA = /slot=(\S+)/.exec(idA)?.[1] || null;
const slotB = /slot=(\S+)/.exec(idB)?.[1] || null;
const uidA = /uid=(\d+)/.exec(idA)?.[1] || null;
const uidB = /uid=(\d+)/.exec(idB)?.[1] || null;
record('у каждого свой слот', Boolean(slotA) && Boolean(slotB) && slotA !== slotB, `${slotA} vs ${slotB}`);
record('у каждого свой uid', Boolean(uidA) && Boolean(uidB) && uidA !== uidB, `${uidA} vs ${uidB}`);
record('конфиг движка виден обоим', Boolean(msg(evA, 'engine_config.seeded')) && Boolean(msg(evB, 'engine_config.seeded')),
  'opencode.json в workspace каждого');
record('оба на бесплатном rung', evA.some((e) => JSON.stringify(e).includes('· free')) && evB.some((e) => JSON.stringify(e).includes('· free')),
  'ladder/free, платный fallback выключен');

// ── Чужие данные не всплывают ─────────────────────────────────────────────
const leakA = evA.some((e) => JSON.stringify(e).includes(tagB));
const leakB = evB.some((e) => JSON.stringify(e).includes(tagA));
record('чужая метка не встретилась в журнале', !leakA && !leakB, leakA || leakB ? `утечка: ${leakA ?? leakB}` : 'каждый видит только своё');

// ── Следующий ра�� после освобождения leases ──────────────────────────────
const c = await call('POST', '/intake', { contractVersion: 1, requestId: `cc-${Date.now()}`, profileId: PROFILE,
  inputItems: [{ text: 'Создай файл out.txt с единственной строкой GAMMA. Ничего больше.' }] });
const cStart = await call('POST', '/start', { taskId: c.userTaskId, profileId: PROFILE, goal: 'c' });
const cDone = await waitFor(c.userTaskId, ['done', 'failed']);
record('следующий ра�� запускается после освобождения leases', cDone.taskStore.status === 'done', cDone.taskStore.status);

// ── Дубль приёма ──────────────────────────────────────────────────────────
const dup = await call('POST', '/intake', { contractVersion: 1, requestId: `ca-${tagA}`, profileId: PROFILE,
  inputItems: [{ text: `Создай файл out.txt с единственной строкой ${tagA}. Дальше ничего не делай, просто подожди 25 секунд.` }] });
record('дубль приёма → та же задача', dup.duplicate === true && dup.userTaskId === a.userTaskId, `duplicate=${dup.duplicate}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} проверок пройдено ===`);
if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exit(1); }
