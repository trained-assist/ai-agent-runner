import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeEngine, type FakeScenario } from '../src/adapters/engine/fake-engine.js';
import { EngineStartupError } from '../src/contracts/validate.js';
import { isProcessAlive, waitForProcessDeath, type EngineHandle } from '../src/adapters/engine/index.js';
import { makeRunSpec, waitFor } from './helpers.js';

function withCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), 'fake-engine-'));
  return fn(cwd).finally(() => rmSync(cwd, { recursive: true, force: true }));
}

interface RunOutput {
  handle: EngineHandle;
  exit: Promise<{ code: number | null; signal: string | null }>;
  lines: string[];
}

async function startEngine(scenario: FakeScenario, cwd: string): Promise<RunOutput> {
  const engine = new FakeEngine(scenario);
  const lines: string[] = [];
  let resolveExit: (value: { code: number | null; signal: string | null }) => void = () => undefined;
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveExit = resolve;
  });
  const handle = await engine.start({
    spec: makeRunSpec({ cwd }),
    cwd,
    env: {},
    onLog: (_stream, line) => lines.push(line),
    onExit: (code, signal) => resolveExit({ code, signal }),
  });
  return { handle, exit, lines };
}

describe('FakeEngine scenarios', () => {
  it('success exits 0 and writes into its own cwd', async () => {
    await withCwd(async (cwd) => {
      const run = await startEngine('success', cwd);
      const result = await run.exit;
      expect(result.code).toBe(0);
      expect(run.lines.join('\n')).toContain('fake-engine: done');
      const { readFileSync } = await import('node:fs');
      expect(readFileSync(join(cwd, 'ran.txt'), 'utf8')).toBe('ok');
    });
  });

  it('nonzero-exit returns a non-zero code', async () => {
    await withCwd(async (cwd) => {
      const run = await startEngine('nonzero-exit', cwd);
      const result = await run.exit;
      expect(result.code).toBe(3);
    });
  });

  it('startup-failure rejects before spawning anything', async () => {
    await withCwd(async (cwd) => {
      const engine = new FakeEngine('startup-failure');
      await expect(
        engine.start({
          spec: makeRunSpec({ cwd }),
          cwd,
          env: {},
          onLog: () => undefined,
          onExit: () => undefined,
        }),
      ).rejects.toBeInstanceOf(EngineStartupError);
      expect(engine.startCalls).toBe(1);
    });
  });

  it('crash dies from SIGKILL', async () => {
    await withCwd(async (cwd) => {
      const run = await startEngine('crash', cwd);
      const result = await run.exit;
      expect(result.signal).toBe('SIGKILL');
      expect(result.code).toBeNull();
    });
  });

  it('timeout scenario keeps running until the tree is killed', async () => {
    await withCwd(async (cwd) => {
      const run = await startEngine('timeout', cwd);
      expect(isProcessAlive(run.handle.pid)).toBe(true);
      run.handle.killTree('SIGKILL');
      const dead = await waitForProcessDeath(run.handle.pgid, run.handle.pid, 3000);
      expect(dead).toBe(true);
      const result = await run.exit;
      expect(result.signal).toBe('SIGKILL');
    });
  });

  it('cancel-with-children: killing the tree also kills the grandchild', async () => {
    await withCwd(async (cwd) => {
      const run = await startEngine('cancel-with-children', cwd);
      await waitFor(() => run.lines.some((line) => line.startsWith('grandchild:')), 5000, 'grandchild log line');
      const grandchildLine = run.lines.find((line) => line.startsWith('grandchild:'));
      const grandchildPid = Number(grandchildLine?.split(':')[1]);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      run.handle.killTree('SIGKILL');
      const dead = await waitForProcessDeath(run.handle.pgid, run.handle.pid, 3000);
      expect(dead).toBe(true);
      await waitFor(() => !isProcessAlive(grandchildPid), 3000, 'grandchild to die');
      expect(isProcessAlive(grandchildPid)).toBe(false);
    });
  });
});
