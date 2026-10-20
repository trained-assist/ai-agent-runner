import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  BLAST_RADIUS_REF,
  LEAK_RELATIVE_PATH,
  killWorkerCgroup,
  parseEngineEnv,
  parseStateCwd,
  runCredentialBlastRadiusDrill,
  shellQuote,
} from '../scripts/sandbox3-credential-blast-radius.mjs';

const SECRET = 'ghp_drillvalue0123456789ABCDEFG';
const REGISTRY = {
  github: { connection_id: 'conn-drill', env: 'GITHUB_TOKEN', field: 'token', scope: 'repo' },
};

function makeHost({ agentWroteTheFile = true, sweepAfterKill = true, engineHasNoCredential = false, sweepBlocked = false } = {}) {
  const calls: string[] = [];
  let killed = false;
  const state = JSON.stringify({ pid: 4242, state: 'running', spec: { cwd: '/var/lib/ai-agent-runner/workspaces/run_x' } });
  const cleanup = sweepAfterKill && !sweepBlocked
    ? { status: 'completed', reason: 'run workspace and its MCP socket are gone' }
    : { status: 'blocked', reason: 'the workspace could not be removed: EACCES: permission denied' };
  const checkpoint = JSON.stringify({ cleanup });
  return {
    calls,
    get killed() { return killed; },
    async exec(command: string) {
      calls.push(command);
      if (command.startsWith('cat /var/lib/ai-agent-runner/runner/runs/') && command.endsWith('events.jsonl')) {
        return { stdout: 'token=[redacted]\n', stderr: '', code: 0 };
      }
      if (command.startsWith('cat /var/lib/ai-agent-runner/runner/runs/')) return { stdout: state, stderr: '', code: 0 };
      if (command.includes('/proc/4242/environ')) {
        return { stdout: engineHasNoCredential ? 'PATH=/usr/bin\0' : `PATH=/usr/bin\0GITHUB_TOKEN=${SECRET}\0`, stderr: '', code: 0 };
      }
      if (command.includes('checkpoint.json')) {
        // Чекпойнт рана: уборка помечена выполненной, если рабочий каталог
        // убран. Блокированная уборка — это отдельная причина, а не «файл остался».
        if (sweepBlocked || (!sweepAfterKill && killed)) return { stdout: checkpoint, stderr: '', code: 0 };
        return { stdout: JSON.stringify({ cleanup: { status: 'completed', reason: 'run workspace and its MCP socket are gone' } }), stderr: '', code: 0 };
      }
      if (command.startsWith(`cat /var/lib/ai-agent-runner/workspaces/run_x/${LEAK_RELATIVE_PATH}`)) {
        return { stdout: agentWroteTheFile ? SECRET : '', stderr: '', code: 0 };
      }
      if (command.startsWith('systemctl kill') || command.includes('cgroup.procs')) { killed = true; return { stdout: 'killed /system.slice/ai-agent-vm-worker.service', stderr: '', code: 0 }; }
      if (command.startsWith('test -e')) {
        const present = !sweepAfterKill || !killed;
        return { stdout: present ? 'present' : 'gone', stderr: '', code: 0 };
      }
      if (command.startsWith('mkdir -p')) return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
  };
}

function makeApi({ state = 'succeeded', publishedBytes = 'token=[redacted]\n', deadRunPublishes = true } = {}, host?: { killed: boolean }, journal: Array<Record<string, unknown>> = []) {
  const requests: Array<{ url: string; method: string }> = [];
  const bytes = Buffer.from(publishedBytes);
  const publishedDigest = createHash('sha256').update(bytes).digest('hex');
  const manifest = { profileChanges: { files: [{ path: LEAK_RELATIVE_PATH, sha256: publishedDigest, size: bytes.length }], deletes: [] } };
  // Ран, чей хост умер, публикует профиль только если хост успел это сделать. Когда
  // публикация отказана (значения секретов ран уже не знает), профиля нет вовсе.
  const deadManifest = { profileChanges: { files: [], deletes: [] } };
  const reply = (status: number, body: unknown) => ({ status, headers: new Headers(), text: async () => JSON.stringify(body), json: async () => body,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  // Пока хост жив, ран, который будет убит, идёт; после убийства — терминальный.
  // Так проверка «убийство попало по активному рану» не проходит вхолостую.
  let phaseASeen = false;
  return {
    requests,
    async fetch(url: string, init?: { method?: string }) {
      requests.push({ url: String(url), method: init?.method ?? 'GET' });
      const text = String(url);
      if (text.startsWith('https://api.cloudflare.com/')) {
        return reply(200, { result: [{ results: journal }] });
      }
      if (text.endsWith('/v1/runs') && (init?.method ?? 'GET') === 'POST') return reply(202, { runId: 'run_x' });
      if (text.includes('/profile-changes')) {
        // Опубликованные байты, а не только манифест: drill читает их назад.
        const response = reply(200, {});
        response.text = async () => bytes.toString();
        response.headers = new Headers({ 'x-content-sha256': publishedDigest });
        return response;
      }
      if (text.includes('/result')) return reply(200, host?.killed && !deadRunPublishes ? deadManifest : manifest);
      if (text.endsWith('/status')) {
        // Счётчик доставок — факт хоста: сколько воркеров получили значение.
        const counted = { credentialDeliveries: 1, credentialGrantRepeats: 0 };
        if (!host) return reply(200, { state, answer: 'saved', ...counted });
        if (!phaseASeen) { phaseASeen = true; return reply(200, { state: 'succeeded', answer: 'saved', ...counted }); }
        return reply(200, { state: host.killed ? 'succeeded' : 'running', answer: 'saved', ...counted });
      }
      return reply(200, { events: [] });
    },
  };
}

describe('sandbox3 credential blast-radius drill', () => {
  it('names every environment variable it reads in the runbook', () => {
    // Док — единственное место, где оператор берёт эти переменные. Если скрипт
    // начал читать новую, а док молчит, оператор не узнает, что её надо задать.
    const script = readFileSync(new URL('../scripts/sandbox3-credential-blast-radius.mjs', import.meta.url), 'utf8');
    const doc = readFileSync(new URL('../docs/CREDENTIAL-BLAST-RADIUS-DRILL.md', import.meta.url), 'utf8');
    const names = [...new Set([...script.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]!))];
    const missing = names.filter((name) => !doc.includes(name)).sort();
    expect(missing, `переменные без строки в доке: ${missing.join(', ')}`).toEqual([]);
  });

  it('is reachable from the repository index', () => {
    const index = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
    expect(index).toContain('docs/CREDENTIAL-BLAST-RADIUS-DRILL.md');
  });

  it('reads the workspace, the engine pid and the run state out of the run state', () => {
    const parsed = parseStateCwd(JSON.stringify({ pid: 7, state: 'running', spec: { cwd: '/var/lib/ai-agent-runner/workspaces/run_x' } }));
    expect(parsed).toEqual({ cwd: '/var/lib/ai-agent-runner/workspaces/run_x', pid: 7, runState: 'running' });
  });

  it('reads the credential out of the engine environment', () => {
    expect(parseEngineEnv('PATH=/usr/bin\0GITHUB_TOKEN=secret-value\0', 'GITHUB_TOKEN')).toBe('secret-value');
    expect(parseEngineEnv('PATH=/usr/bin\0', 'GITHUB_TOKEN')).toBeNull();
    // Реальный путь читает файл как есть; вызов через `tr` даёт переводы строк.
    expect(parseEngineEnv('PATH=/usr/bin\nGITHUB_TOKEN=secret-value\n', 'GITHUB_TOKEN')).toBe('secret-value');
    expect(parseEngineEnv('A=1\nB=2\nGITHUB_TOKEN=secret-value\nC=3\n', 'GITHUB_TOKEN')).toBe('secret-value');
  });

  it('kills the whole worker control group, not one process', () => {
    const command = killWorkerCgroup('ai-agent-vm-worker.service');
    // `systemctl kill` по умолчанию бьёт только главный процесс, а
    // `--kill-whom=all` на этой systemd отказывает — поэтому контрольная группа
    // разбирается по себе: движок и MCP-серверы должны умереть вместе с воркером.
    expect(command).toContain('systemctl show -p MainPID');
    expect(command).toContain('cgroup.procs');
    expect(command).toContain('kill -9');
    expect(command).not.toContain('systemctl kill');
  });

  it('quotes a value for the shell', () => {
    expect(shellQuote('abc')).toBe("'abc'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it('measures the radius without ever printing the value', async () => {
    const host = makeHost();
    const api = makeApi({}, host);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = api.fetch as unknown as typeof fetch;
    try {
      const steps = await runCredentialBlastRadiusDrill({
        apiUrl: 'https://runner.example',
        apiKey: 'key',
        registry: REGISTRY,
        ref: BLAST_RADIUS_REF,
        host,
        kill: false,
        captureWaitMs: 2_000,
        sweepWaitMs: 2_000,
      });
      const report = steps.join('\n');
      expect(report).not.toContain(SECRET);
      expect(steps.every((line) => !line.includes(SECRET))).toBe(true);
      expect(steps.filter((line) => line.startsWith('FAIL'))).toEqual([]);
      expect(report).toContain('value-free');
      // The drill asked the agent to persist the value, and read the copy back.
      expect(host.calls.some((command) => command.includes(LEAK_RELATIVE_PATH))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails when the published bytes carry the value, even when the manifest matches them', async () => {
    const host = makeHost();
    // Опубликованные байты несут значение, и манифест честно их хеширует.
    // Хеш совпадает — а публикация всё равно утечка: проверять надо байты.
    const api = makeApi({ publishedBytes: SECRET }, host);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = api.fetch as unknown as typeof fetch;
    try {
      const steps = await runCredentialBlastRadiusDrill({
        apiUrl: 'https://runner.example',
        apiKey: 'key',
        registry: REGISTRY,
        host,
        kill: false,
        captureWaitMs: 2_000,
        sweepWaitMs: 2_000,
      });
      const failed = steps.filter((line) => line.startsWith('FAIL'));
      expect(failed.some((line) => line.includes('the published file carries the value'))).toBe(true);
      expect(steps.join('\n')).not.toContain(SECRET);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('plants the copy itself when the agent did not write it', async () => {
    const host = makeHost({ agentWroteTheFile: false });
    const api = makeApi({}, host);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = api.fetch as unknown as typeof fetch;
    try {
      const steps = await runCredentialBlastRadiusDrill({
        apiUrl: 'https://runner.example',
        apiKey: 'key',
        registry: REGISTRY,
        host,
        kill: false,
        captureWaitMs: 2_000,
        sweepWaitMs: 2_000,
      });
      const report = steps.join('\n');
      expect(report).not.toContain(SECRET);
      expect(report).toContain('written by the drill');
      expect(host.calls.some((command) => command.startsWith('mkdir -p') && command.includes(SECRET))).toBe(true);
      // Копия принадлежит владельцу рабочего каталога: иначе уборка упирается
      // в права файла, и это говорит о правах, а не о значении.
      expect(host.calls.some((command) => command.includes('chown --reference='))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('kills the whole worker control group, and reports the run outcome instead of judging it', async () => {
    const host = makeHost();
    const api = makeApi({}, host);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = api.fetch as unknown as typeof fetch;
    try {
      const steps = await runCredentialBlastRadiusDrill({
        apiUrl: 'https://runner.example',
        apiKey: 'key',
        registry: REGISTRY,
        host,
        kill: true,
        captureWaitMs: 2_000,
        sweepWaitMs: 2_000,
      });
      expect(steps.filter((line) => line.startsWith('FAIL'))).toEqual([]);
      // Гибнет вся контрольная группа: «хост умер», а не «умер один процесс».
      expect(host.calls.some((command) => command.includes('cgroup.procs') && command.includes('kill -9'))).toBe(true);
      // Исход рана — измерение: координатор вправе переотдать ран после смерти хоста.
      expect(steps.some((line) => line.includes('the outcome of the run whose host died'))).toBe(true);
      // Профиль мёртвого рана тоже читается назад: значение не уходит с хоста.
      expect(steps.some((line) => line.includes('the profile published by the dead run carries no value'))).toBe(true);
      expect(steps.join('\n')).not.toContain(SECRET);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports the refused publication of the run whose host died', async () => {
    // Хост умер до публикации: ран больше не знает значений своих секретов, поэтому
    // профиль не публикуется вовсе. Это тоже результат: наружу не ушло ничего.
    const host = makeHost();
    const api = makeApi({ deadRunPublishes: false }, host);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = api.fetch as unknown as typeof fetch;
    try {
      const steps = await runCredentialBlastRadiusDrill({
        apiUrl: 'https://runner.example',
        apiKey: 'key',
        registry: REGISTRY,
        host,
        kill: true,
        captureWaitMs: 2_000,
        sweepWaitMs: 2_000,
      });
      expect(steps.filter((line) => line.startsWith('FAIL'))).toEqual([]);
      expect(steps.join('\n')).toContain('the publication was refused: nothing left the host');
      expect(steps.join('\n')).not.toContain(SECRET);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports the value-dependent checks as skipped when the value was never captured', async () => {
    const host = makeHost({ engineHasNoCredential: true });
    const api = makeApi({}, host);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = api.fetch as unknown as typeof fetch;
    try {
      const steps = await runCredentialBlastRadiusDrill({
        apiUrl: 'https://runner.example',
        apiKey: 'key',
        registry: REGISTRY,
        ref: BLAST_RADIUS_REF,
        host,
        kill: false,
        waitMs: 1_000,
        captureWaitMs: 200,
        sweepWaitMs: 200,
      });
      expect(steps.some((line) => line.startsWith('FAIL'))).toBe(true);
      // Проверки радиуса не должны дать ложной находки: без значения они
      // пропускаются, а не «проходят» по строке "null".
      expect(steps.some((line) => line.includes('skipped: the value was not captured'))).toBe(true);
      expect(steps.join('\n')).not.toContain(SECRET);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports a blocked sweep with the reason the recovery recorded', async () => {
    const host = makeHost({ sweepBlocked: true });
    const api = makeApi({}, host);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = api.fetch as unknown as typeof fetch;
    try {
      const steps = await runCredentialBlastRadiusDrill({
        apiUrl: 'https://runner.example',
        apiKey: 'key',
        registry: REGISTRY,
        host,
        kill: true,
        waitMs: 1_000,
        captureWaitMs: 2_000,
        sweepWaitMs: 2_000,
      });
      // Заблокированная уборка — это не «файл остался», а конкретная причина
      // из чекпойнта рана: без неё оператор не знает, что чинить.
      const failed = steps.filter((line) => line.startsWith('FAIL'));
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.some((line) => line.includes('the recovery blocked the sweep'))).toBe(true);
      expect(steps.join('\n')).not.toContain(SECRET);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails the drill when the kill would land on a run that already finished', async () => {
    const host = makeHost();
    // API без живой фазы: ран всегда терминален — убийство попало бы в пустоту.
    const api = makeApi({ state: 'succeeded' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = api.fetch as unknown as typeof fetch;
    try {
      const steps = await runCredentialBlastRadiusDrill({
        apiUrl: 'https://runner.example',
        apiKey: 'key',
        registry: REGISTRY,
        host,
        kill: true,
        waitMs: 1_000,
        captureWaitMs: 2_000,
        sweepWaitMs: 2_000,
      });
      // Удар по завершившемуся рану измеряет штатный выход, а не смерть хоста.
      const failed = steps.filter((line) => line.startsWith('FAIL'));
      expect(failed.some((line) => line.includes('the run finished before the host died'))).toBe(true);
      expect(steps.join('\n')).not.toContain(SECRET);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails the drill when a copy survives the recovery', async () => {
    const host = makeHost({ sweepAfterKill: false });
    const api = makeApi({}, host);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = api.fetch as unknown as typeof fetch;
    try {
      const steps = await runCredentialBlastRadiusDrill({
        apiUrl: 'https://runner.example',
        apiKey: 'key',
        registry: REGISTRY,
        host,
        kill: true,
        waitMs: 1_000,
        captureWaitMs: 2_000,
        sweepWaitMs: 2_000,
      });
      expect(steps.filter((line) => line.startsWith('FAIL')).length).toBeGreaterThan(0);
      expect(steps.join('\n')).not.toContain(SECRET);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports how many hosts received the value', async () => {
    const host = makeHost();
    const api = makeApi({}, host);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = api.fetch as unknown as typeof fetch;
    try {
      const steps = await runCredentialBlastRadiusDrill({
        apiUrl: 'https://runner.example',
        apiKey: 'key',
        registry: REGISTRY,
        host,
        kill: false,
        captureWaitMs: 2_000,
        sweepWaitMs: 2_000,
      });
      // Радиус — это число, а не ощущение: сколько хостов получили значение.
      expect(steps.some((line) => line.includes('deliveries=1 repeats=0'))).toBe(true);
      expect(steps.join('\n')).not.toContain(SECRET);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails the drill when the custody journal holds a second grant for one run', async () => {
    const host = makeHost();
    // Custody выдаёт грант один раз на ран. Две выдачи одному рану — это
    // либо сломанная идемпотентность, либо рост радиуса, который drill обязан
    // показать, а не пройти.
    const journal = [
      { event_id: 1, action: 'granted', actor: 'run_x' },
      { event_id: 2, action: 'granted', actor: 'run_x' },
    ];
    const api = makeApi({}, host, journal);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = api.fetch as unknown as typeof fetch;
    try {
      const steps = await runCredentialBlastRadiusDrill({
        apiUrl: 'https://runner.example',
        apiKey: 'key',
        registry: REGISTRY,
        host,
        custody: { token: 'cf-token', accountId: 'account', databaseId: 'database' },
        kill: true,
        waitMs: 1_000,
        captureWaitMs: 2_000,
        sweepWaitMs: 2_000,
      });
      const failed = steps.filter((line) => line.startsWith('FAIL'));
      expect(failed.some((line) => line.includes('the custody journal holds 2 grants for run A'))).toBe(true);
      expect(steps.join('\n')).not.toContain(SECRET);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
