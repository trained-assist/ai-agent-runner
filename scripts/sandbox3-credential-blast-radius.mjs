#!/usr/bin/env node
/**
 * Blast-radius drill for a bound credential.
 *
 * The drill answers one question with measurements instead of assumptions:
 * **where does the credential value end up, and what survives the host dying?**
 *
 * The value is delivered to the agent in its environment (host-resolved trusted
 * runtime). That mode cannot stop the agent from writing the value down: the
 * drill does not pretend otherwise. What the drill measures is the radius.
 *
 * The drill runs two runs on the lane under test:
 *
 *   A — the leak radius. The agent is asked to persist the credential in the
 *       middle of the run. The run finishes normally, and the value must not
 *       have reached the run record, the events, the runner log, the run state,
 *       the session transcript or the published profile — and the copy must not
 *       survive on the host's disk when the run ends.
 *
 *   B — the kill. The agent is asked to persist the credential again, and the
 *       worker control group is SIGKILLed mid-flight. The run's outcome is a
 *       measurement (the coordinator may re-dispatch it), the copy on the dead
 *       host's disk must be swept by the recovery, and the custody store must
 *       stay independent of the host.
 *
 * The drill never prints the value. It compares by exact value inside the
 * process and reports only booleans, counts and hashes.
 *
 * Required environment:
 *   - RUNNER_API_URL: the Runner API base URL of the lane under test
 *   - RUNNER_API_KEY_AGENT_API: the principal key of that lane
 *   - VM_HOST / VM_SSH_KEY: the host that runs the worker
 *
 * Optional environment:
 *   - CREDENTIAL_REF: the registry ref to drill (default: the registry's "github")
 *   - VM_SSH_USER / VM_WORKER_SERVICE / VM_RUNNER_ROOT: the host's coordinates
 *   - CF_TOKEN / CUSTODY_ACCOUNT_ID / CUSTODY_DATABASE_ID: the custody journal
 *   - WALLET_API_URL / WALLET_SERVICE_TOKEN: the wallet that owns the value
 *   - DRILL_WAIT_MS: how long a run may take, in milliseconds (default: 900000).
 *     It is also the timeout limit the run is created with.
 *   - DRILL_KILL: set to "0" to skip the kill phase (the leak radius alone)
 *   - DRILL_REVOKE: set to "1" to revoke the drilled credential at the end.
 *     The revocation destroys the value, so the lane loses that credential
 *     until a new value is minted. Off by default.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const BLAST_RADIUS_REF = 'github';
export const DEFAULT_SERVICE = 'ai-agent-vm-worker.service';
export const DEFAULT_RUNNER_ROOT = '/var/lib/ai-agent-runner';

/** The file the agent is asked to write the credential into, inside the run's workspace. */
export const LEAK_RELATIVE_PATH = 'blast/leak.txt';

const PROMPT = [
  'Do exactly two things, in this order.',
  'First, run the shell command: mkdir -p blast && printf \'%s\' "$CREDENTIAL_ENV_NAME" > blast/leak.txt',
  'Second, answer with the single word: saved.',
];

/**
 * The value never leaves this process: the drill compares by exact value and
 * reports counts and hashes. A failed step prints the position of the value,
 * never the value itself.
 */
export function fingerprint(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

export function parseStateCwd(stateText) {
  const state = JSON.parse(stateText);
  const cwd = state?.spec?.cwd;
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new Error('the run state has no workspace path');
  return {
    cwd,
    pid: Number.isInteger(state?.pid) ? state.pid : null,
    runState: typeof state?.state === 'string' ? state.state : null,
  };
}

/**
 * The engine's environment is where the credential lives in trusted-runtime
 * mode. Anything that can read the host's processes can read the value — that
 * is the exposure the drill measures, not a defect of the drill.
 */
/**
 * The engine environment is NUL-separated on the host (`/proc/<pid>/environ`).
 * A caller that pipes it through `tr '\0' '\n'` gets newlines instead, so both
 * separators are accepted: the drill reads the file raw, and the fake host in
 * the tests hands back the same bytes.
 */
export function parseEngineEnv(envText, name) {
  for (const entry of envText.split(/[\0\n]/)) {
    const at = entry.indexOf('=');
    if (at === -1) continue;
    if (entry.slice(0, at) === name) return entry.slice(at + 1);
  }
  return null;
}

/**
 * "The host died" is the whole worker control group, not one process: the
 * worker, the engine it spawned and the MCP servers it started. `systemctl
 * kill` defaults to the main process only, and `--kill-whom=all` refuses on
 * this systemd ("Failed to send signal SIGKILL to auxiliary processes"), so
 * the drill takes the cgroup apart itself.
 */
export function killWorkerCgroup(service) {
  return [
    `MAIN=$(systemctl show -p MainPID --value ${service})`,
    `[ -n "$MAIN" ] && [ "$MAIN" != 0 ] || { echo "the service has no main process"; exit 1; }`,
    `CG=$(sed 's/^0:://' /proc/$MAIN/cgroup)`,
    `for p in $(cat /sys/fs/cgroup$CG/cgroup.procs); do kill -9 $p 2>/dev/null || true; done`,
    `echo "killed $CG"`,
  ].join('; ');
}

export function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function runCredentialBlastRadiusDrill({
  apiUrl,
  apiKey,
  registry,
  ref = BLAST_RADIUS_REF,
  host,
  custody,
  service = DEFAULT_SERVICE,
  runnerRoot = DEFAULT_RUNNER_ROOT,
  kill = true,
  revoke = false,
  waitMs = 900_000,
  captureWaitMs = 120_000,
  sweepWaitMs = 180_000,
}) {
  const configured = registry?.[ref];
  if (!configured) throw new Error(`the credential registry has no "${ref}" ref`);
  const envName = configured.env;
  const steps = [];
  async function step(name, fn) {
    try {
      const detail = await fn();
      steps.push(`ok   ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
      steps.push(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }

  async function runner(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    return { status: response.status, text, body: parsed };
  }

  /** Reads the published bytes themselves: a hash says what should have landed, the bytes say what did. */
  async function runnerBytes(path) {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, bytes, sha256: response.headers.get('x-content-sha256'), text: new TextDecoder().decode(bytes) };
  }

  const statePath = (runId) => `${runnerRoot}/runner/runs/${runId}/state.json`;
  const checkpointPath = (runId) => `${runnerRoot}/runner/runs/${runId}/checkpoint.json`;

  /**
   * The run's own record of the cleanup: the checkpoint says whether the
   * workspace was removed, and why not when it was not. Probing the file only
   * ever says "gone" — a blocked sweep looks exactly like a clean host.
   */
  async function cleanupStatus(runId) {
    const checkpoint = await host.exec(`test -e ${checkpointPath(runId)} && cat ${checkpointPath(runId)} || true`);
    if (!checkpoint.stdout.trim()) return { status: 'pending', reason: null };
    try {
      const parsed = JSON.parse(checkpoint.stdout);
      return { status: String(parsed.cleanup?.status ?? 'unknown'), reason: parsed.cleanup?.reason ?? null };
    } catch {
      return { status: 'unreadable', reason: null };
    }
  }

  async function startRun(label, { profileWorkspace = false } = {}) {
    const taskId = `blast-radius-${label}-${Date.now()}`;
    const response = await runner('/v1/runs', {
      method: 'POST',
      headers: { 'idempotency-key': taskId },
      body: {
        userTaskId: taskId,
        input: { inlinePrompt: PROMPT.join(' ').replaceAll('CREDENTIAL_ENV_NAME', envName) },
        envAllowlist: ['LLM_LADDER_TOKEN'],
        credentialBindings: [{ ref, scope: configured.scope }],
        // Полоса публикует профиль: без этого запроса координатор не даёт рану
        // публиковать, и шаг проверки публикации нечего проверять.
        ...(profileWorkspace ? { profileWorkspace: {} } : {}),
        limits: { timeoutMs: waitMs },
      },
    });
    assert.equal(response.status, 202, `${response.status}: ${response.text}`);
    return response.body.runId;
  }

  async function waitForState(runId) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const response = await runner(`/v1/runs/${runId}/status`);
      assert.equal(response.status, 200, response.text);
      if (['succeeded', 'failed', 'cancelled'].includes(String(response.body?.state))) return response.body;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error('the run never reported a terminal state');
  }

  /**
   * Reads the value out of the engine's environment while the engine is alive,
   * and reports where the copy on disk came from: the agent wrote it, or the
   * drill planted it from the environment (a free model may not comply, and the
   * radius of a copy that exists does not depend on who wrote it).
   */
  async function captureValue(runId, { plant = true } = {}) {
    const deadline = Date.now() + captureWaitMs;
    let parsed = null;
    while (Date.now() < deadline) {
      const state = await host.exec(`cat ${statePath(runId)} 2>/dev/null || true`);
      if (state.stdout.trim()) {
        try { parsed = parseStateCwd(state.stdout); } catch { parsed = null; }
        if (parsed?.pid) {
          const environ = await host.exec(`cat /proc/${parsed.pid}/environ 2>/dev/null || true`);
          const value = parseEngineEnv(environ.stdout, envName);
          if (value && value.length >= 4) {
            const leak = await host.exec(`cat ${parsed.cwd}/${LEAK_RELATIVE_PATH} 2>/dev/null || true`);
            if (leak.stdout === value) return { value, cwd: parsed.cwd, writtenBy: 'the agent' };
            if (!plant) return { value, cwd: parsed.cwd, writtenBy: null };
            // Копия сажается, только пока ран жив: уборка рана происходит на его
            // выходе, и копия, посаженная после неё, осталась бы на диске навсегда
            // (восстановление её уже не увидит). Живость ран читается у самого
            // хоста: его state.json — это тот же источник, по которому идёт уборка.
            if (parsed.runState && ['succeeded', 'failed', 'cancelled'].includes(parsed.runState)) {
              throw new Error(`the run ended before the drill could plant the copy (host state=${parsed.runState})`);
            }
            // Копия сажается от владельца рабочего каталога и с его правами:
            // иначе уборка упрётся в права файла, и это будет сказано о правах,
            // а не о значении. Так копия неотличима от того, что записал бы агент.
            await host.exec(`mkdir -p ${parsed.cwd}/blast && printf '%s' ${shellQuote(value)} > ${parsed.cwd}/${LEAK_RELATIVE_PATH} && chown --reference=${parsed.cwd} ${parsed.cwd}/blast ${parsed.cwd}/${LEAK_RELATIVE_PATH} && chmod 600 ${parsed.cwd}/${LEAK_RELATIVE_PATH}`);
            return { value, cwd: parsed.cwd, writtenBy: 'the drill' };
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error('the engine environment never carried the credential');
  }

  // ---------------------------------------------------------------- run A
  let runA = null;
  let valueA = null;

  await step('A: the Runner API accepts a run that binds the credential', async () => {
    runA = await startRun('leak', { profileWorkspace: true });
    return runA;
  });

  await step('A: the credential reaches the agent in its environment, and only there', async () => {
    const captured = await captureValue(runA);
    valueA = captured.value;
    steps.push(`note the copy in the workspace was written by ${captured.writtenBy}`);
    return `value=${fingerprint(valueA)}`;
  });

  await step('A: the run finishes', async () => {
    const status = await waitForState(runA);
    assert.equal(status.state, 'succeeded', `the run ended as ${status.state}: ${JSON.stringify(status).slice(0, 300)}`);
    return `state=${status.state}`;
  });

  await step('A: the value does not reach the run record, the status or the events', async () => {
    if (!valueA) return 'skipped: the value was not captured';
    const status = await runner(`/v1/runs/${runA}/status`);
    const events = await runner(`/v1/runs/${runA}/events?cursor=0`);
    const record = status.text + events.text;
    assert.ok(!record.includes(valueA), 'the value must not appear in the run record');
    return 'value-free';
  });

  await step('A: the host counts the hosts that received the value', async () => {
    // Радиус креды — это число. Custody считает выдачи (одна выдача на ран),
    // хост считает доставки (сколько воркеров получили значение). Ран A не
    // переотдавался, поэтому доставка ровно одна, а повторов быть не может.
    const status = await runner(`/v1/runs/${runA}/status`);
    assert.equal(status.status, 200, status.text);
    const deliveries = Number(status.body?.credentialDeliveries ?? 0);
    const repeats = Number(status.body?.credentialGrantRepeats ?? 0);
    assert.ok(deliveries >= 1, 'the run reports no credential delivery');
    assert.equal(repeats, 0, `the custody recognised ${repeats} grant(s) of this run as a repeat`);
    return `deliveries=${deliveries} repeats=${repeats}`;
  });

  await step('A: the value does not reach the runner log, the run state or the session transcript', async () => {
    if (!valueA) return 'skipped: the value was not captured';
    const log = await host.exec(`cat ${runnerRoot}/runner/runs/${runA}/events.jsonl 2>/dev/null || true`);
    assert.ok(!log.stdout.includes(valueA), 'the value must not appear in the runner log');
    const state = await host.exec(`cat ${statePath(runA)}`);
    assert.ok(!state.stdout.includes(valueA), 'the value must not appear in the run state');
    const traces = await host.exec(`cat ${valueA.cwd}/.session-traces/*.json 2>/dev/null || true`);
    assert.ok(!traces.stdout.includes(valueA), 'the value must not appear in the session transcript');
    return 'value-free';
  });

  await step('A: the copy does not survive the run on the host', async () => {
    if (!valueA) return 'skipped: the value was not captured';
    // Рабочий каталог — тоже место, где значение может остаться. Штатный выход
    // рана обязан его подмести: иначе значение продолжает лежать на хосте.
    const deadline = Date.now() + sweepWaitMs;
    while (Date.now() < deadline) {
      const cleanup = await cleanupStatus(runA);
      if (cleanup.status === 'completed') return 'the workspace was swept';
      if (cleanup.status === 'blocked') throw new Error(`the cleanup was blocked: ${cleanup.reason}`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error('the workspace copy survived the run');
  });

  await step('A: the published profile carries the file without the value', async () => {
    if (!valueA) return 'skipped: the value was not captured';
    const response = await runner(`/v1/runs/${runA}/result`);
    assert.equal(response.status, 200, response.text);
    const manifest = response.body?.profileChanges?.files ?? [];
    const entry = manifest.find((file) => file.path === LEAK_RELATIVE_PATH);
    assert.ok(entry, `the run published no ${LEAK_RELATIVE_PATH}: ${JSON.stringify(response.body?.profileChanges ?? null)}`);
    // Манифест говорит, что должно было приземлиться; байты говорят, что приземлилось.
    const published = await runnerBytes(`/v1/runs/${runA}/profile-changes?path=${encodeURIComponent(LEAK_RELATIVE_PATH)}`);
    assert.equal(published.status, 200, `the published bytes are not readable: HTTP ${published.status}`);
    const digest = createHash('sha256').update(published.bytes).digest('hex');
    assert.equal(digest, entry.sha256, 'the published bytes do not match the published manifest');
    assert.equal(published.sha256, entry.sha256, 'the published bytes carry another digest in the header');
    assert.ok(!published.text.includes(valueA), 'the published file carries the value');
    assert.ok(published.text.includes('[redacted]'), 'the published file carries no redaction marker');
    const raw = createHash('sha256').update(valueA).digest('hex');
    assert.notEqual(entry.sha256, raw, 'the published file carries the value');
    return `published without the value (${entry.size} bytes, sha256 ${digest.slice(0, 16)})`;
  });

  if (!kill) {
    steps.push('note the kill phase is skipped (DRILL_KILL=0)');
    return steps;
  }

  // ---------------------------------------------------------------- run B
  let runB = null;
  let valueB = null;

  await step('B: the Runner API accepts the second run that will be killed', async () => {
    runB = await startRun('kill');
    return runB;
  });

  await step('B: the credential is in the engine environment and the copy is on the disk', async () => {
    const captured = await captureValue(runB);
    valueB = captured;
    steps.push(`note the copy in the workspace was written by ${captured.writtenBy}`);
    return `value=${fingerprint(captured.value)}`;
  });

  await step('B: the host dies mid-flight: the worker is SIGKILLed', async () => {
    if (!valueB?.cwd) return 'skipped: the value was not captured';
    // --kill-whom=all: гибнет вся контрольная группа воркера, включая движок.
    // Это и есть «хост умер» — падение питания, а не падение одного процесса.
    //
    // Убийство должно попасть по активному рану, а не по тому, что уже
    // закончился: иначе drill измеряет штатный выход, а не смерть хоста.
    // Проверяется до самого удара: если движок вышел за секунду до него,
    // утверждение падает, а не молча проходит.
    const before = await runner(`/v1/runs/${runB}/status`);
    assert.notEqual(before.body?.state, 'succeeded', 'the run finished before the host died');
    assert.notEqual(before.body?.state, 'failed', 'the run failed before the host died');
    const killed = await host.exec(killWorkerCgroup(service));
    assert.equal(killed.code, 0, `the kill failed: ${killed.stderr}`);
    assert.ok(!killed.stdout.includes('no main process'), killed.stdout);
    return 'the worker control group is dead';
  });

  await step('B: the copy on the dead host is swept by the recovery, not by the kill', async () => {
    if (!valueB?.cwd) return 'skipped: the value was not captured';
    const deadline = Date.now() + sweepWaitMs;
    while (Date.now() < deadline) {
      const cleanup = await cleanupStatus(runB);
      if (cleanup.status === 'completed') return 'the workspace copy is gone';
      if (cleanup.status === 'blocked') throw new Error(`the recovery blocked the sweep: ${cleanup.reason}`);
      const probe = await host.exec(`test -e ${valueB.cwd}/${LEAK_RELATIVE_PATH} && echo present || echo gone`);
      if (probe.stdout.trim() === 'gone') return 'the workspace copy is gone';
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error('the workspace copy survived the recovery');
  });

  await step('B: the outcome of the run whose host died', async () => {
    // Это измерение, а не утверждение: координатор по замыслу переживает
    // недоступность воркера и может переотдать ран другому хосту. Тогда ран
    // завершится успешно, и значение получат два хоста — это видно по счётчику
    // доставок на стороне хоста (custody хранит одну выдачу на ран), и именно
    // этим измеряется радиус, а не «успех» рана.
    const deadline = Date.now() + sweepWaitMs;
    let state = null;
    while (Date.now() < deadline) {
      const response = await runner(`/v1/runs/${runB}/status`);
      assert.equal(response.status, 200, response.text);
      state = response.body?.state;
      if (['succeeded', 'failed', 'cancelled'].includes(String(state))) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    return `state=${state ?? 'unknown'}`;
  });

  await step('B: the custody store is independent of the host', async () => {
    if (!custody?.token || !custody?.accountId || !custody?.databaseId) return 'skipped: the custody database is not configured';
    const rows = await custodyRows(custody, configured.connection_id);
    const granted = rows.filter((row) => row.action === 'granted');
    assert.ok(granted.length >= 1, `the custody journal has no grant: ${JSON.stringify(rows)}`);
    // Custody выдаёт грант один раз на ран: повторный запрос — это тот же грант,
    // и журнал не растёт. Поэтому число выдач в журнале — это факт custody, а
    // радиус (сколько хостов получили значение) измеряется на стороне хоста.
    const forRun = granted.filter((row) => String(row.actor) === runB).length;
    const forRunA = granted.filter((row) => String(row.actor) === runA).length;
    assert.equal(forRunA, 1, `the custody journal holds ${forRunA} grants for run A`);
    assert.equal(forRun, 1, `the custody journal holds ${forRun} grants for run B`);
    const statusB = await runner(`/v1/runs/${runB}/status`);
    const deliveriesB = Number(statusB.body?.credentialDeliveries ?? 0);
    const repeatsB = Number(statusB.body?.credentialGrantRepeats ?? 0);
    steps.push(`note the journal reads ${rows.map((row) => row.action).join(',')} (${granted.length} grants; run A ${forRunA}, run B ${forRun})`);
    steps.push(`note the host counts ${deliveriesB} deliveries to run B, of which ${repeatsB} the custody recognised as the same grant`);
    if (!revoke) return 'the custody outlived the host';
    if (!custody.serviceToken || !custody.walletUrl) return 'skipped: the wallet service token is not configured';
    const owner = await custodyOwner(custody, configured.connection_id);
    assert.ok(owner?.owner_id && owner?.profile_id, 'the custody does not name the owner of the connection');
    const revoked = await custodyRevoke(custody, configured.connection_id, owner.owner_id, owner.profile_id);
    assert.ok(revoked, 'the custody refused the revocation');
    const after = await custodyRows(custody, configured.connection_id);
    assert.ok(after.some((row) => row.action === 'revoked'), 'the journal has no revocation');
    return `journal: ${after.map((row) => row.action).join(',')}`;
  });

  return steps;
}

async function custodyRows(custody, connectionId) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${custody.accountId}/d1/database/${custody.databaseId}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${custody.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      sql: 'SELECT event_id, action, actor FROM credential_events WHERE connection_id = ? ORDER BY event_id',
      params: [connectionId],
    }),
  });
  const body = await response.json();
  return body.result?.[0]?.results ?? [];
}

/**
 * The revocation goes through the wallet API, not through the database: the
 * journal is an append-only record and the value rows are destroyed by the
 * store that owns them. The wallet is the only side that holds the data key.
 */
async function custodyRevoke(custody, connectionId, ownerId, profileId) {
  const response = await fetch(`${custody.walletUrl}/internal/vault/values/${connectionId}/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${custody.serviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ owner_id: ownerId, profile_id: profileId }),
  });
  return response.ok;
}

async function custodyOwner(custody, connectionId) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${custody.accountId}/d1/database/${custody.databaseId}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${custody.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      sql: 'SELECT owner_id, profile_id FROM credential_values WHERE connection_id = ? LIMIT 1',
      params: [connectionId],
    }),
  });
  const body = await response.json();
  return body.result?.[0]?.results?.[0] ?? null;
}

function createSshHost({ host, user = 'root', key }) {
  return {
    async exec(command) {
      const args = ['-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', `${user}@${host}`, command];
      try {
        const { stdout, stderr } = await execFileAsync('ssh', args, { maxBuffer: 16 * 1024 * 1024 });
        return { stdout, stderr, code: 0 };
      } catch (error) {
        return { stdout: error.stdout ?? '', stderr: error.stderr ?? String(error), code: error.code ?? 1 };
      }
    },
  };
}

const invokedDirectly = process.argv[1]?.endsWith('sandbox3-credential-blast-radius.mjs');
if (invokedDirectly) {
  const apiUrl = process.env.RUNNER_API_URL;
  const apiKey = process.env.RUNNER_API_KEY_AGENT_API;
  if (!apiUrl || !apiKey) throw new Error('RUNNER_API_URL and RUNNER_API_KEY_AGENT_API are required');
  const vmHost = process.env.VM_HOST;
  const vmKey = process.env.VM_SSH_KEY;
  if (!vmHost || !vmKey) throw new Error('VM_HOST and VM_SSH_KEY are required: the drill measures the host');
  const config = JSON.parse(await readFile(new URL('../wrangler.sandbox3.jsonc', import.meta.url), 'utf8'));
  const registry = JSON.parse(config.vars.ZEROCREDS_WALLET_CREDENTIALS);
  const steps = await runCredentialBlastRadiusDrill({
    apiUrl,
    apiKey,
    registry,
    ref: process.env.CREDENTIAL_REF ?? BLAST_RADIUS_REF,
    host: createSshHost({ host: vmHost, key: vmKey, user: process.env.VM_SSH_USER ?? 'root' }),
    service: process.env.VM_WORKER_SERVICE ?? DEFAULT_SERVICE,
    runnerRoot: process.env.VM_RUNNER_ROOT ?? DEFAULT_RUNNER_ROOT,
    kill: process.env.DRILL_KILL !== '0',
    revoke: process.env.DRILL_REVOKE === '1',
    waitMs: Number(process.env.DRILL_WAIT_MS ?? 900_000),
    custody: {
      token: process.env.CF_TOKEN,
      accountId: process.env.CUSTODY_ACCOUNT_ID,
      databaseId: process.env.CUSTODY_DATABASE_ID,
      walletUrl: process.env.WALLET_API_URL,
      serviceToken: process.env.WALLET_SERVICE_TOKEN,
    },
  });
  console.log(steps.join('\n'));
}
