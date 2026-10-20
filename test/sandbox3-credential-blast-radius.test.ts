import { describe, expect, it } from 'vitest';
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
  const state = JSON.stringify({ pid: 4242, spec: { cwd: '/var/lib/ai-agent-runner/workspaces/run_x' } });
  const cleanup = sweepAfterKill && !sweepBlocked
    ? { status: 'completed', reason: 'run workspace and its MCP socket are gone' }
    : { status: 'blocked', reason: 'the workspace could not be removed: EACCES: permission denied' };
  const checkpoint = JSON.stringify({ cleanup });
  return {
    calls,
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

function makeApi({ state = 'succeeded' } = {}) {
  const requests: Array<{ url: string; method: string }> = [];
  const manifest = { profileChanges: { files: [{ path: LEAK_RELATIVE_PATH, sha256: 'a'.repeat(64), size: 10 }], deletes: [] } };
  const reply = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
  return {
    requests,
    async fetch(url: string, init?: { method?: string }) {
      requests.push({ url: String(url), method: init?.method ?? 'GET' });
      const text = String(url);
      if (text.endsWith('/v1/runs') && (init?.method ?? 'GET') === 'POST') return reply(202, { runId: 'run_x' });
      if (text.includes('/result')) return reply(200, manifest);
      if (text.endsWith('/status')) return reply(200, { state, answer: 'saved' });
      return reply(200, { events: [] });
    },
  };
}

describe('sandbox3 credential blast-radius drill', () => {
  it('reads the workspace and the engine pid out of the run state', () => {
    const parsed = parseStateCwd(JSON.stringify({ pid: 7, spec: { cwd: '/var/lib/ai-agent-runner/workspaces/run_x' } }));
    expect(parsed).toEqual({ cwd: '/var/lib/ai-agent-runner/workspaces/run_x', pid: 7 });
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
    const api = makeApi();
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

  it('plants the copy itself when the agent did not write it', async () => {
    const host = makeHost({ agentWroteTheFile: false });
    const api = makeApi();
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
    const api = makeApi();
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
      expect(steps.join('\n')).not.toContain(SECRET);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports the value-dependent checks as skipped when the value was never captured', async () => {
    const host = makeHost({ engineHasNoCredential: true });
    const api = makeApi();
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
    const api = makeApi();
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

  it('fails the drill when a copy survives the recovery', async () => {
    const host = makeHost({ sweepAfterKill: false });
    const api = makeApi();
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
});
