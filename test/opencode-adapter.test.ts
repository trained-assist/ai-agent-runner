import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeAdapter } from '../src/adapters/engine/opencode-adapter.js';
import { EngineStartupError } from '../src/contracts/validate.js';
import type { EngineStartContext } from '../src/adapters/engine/engine-adapter.js';
import { makeRunSpec } from './helpers.js';

function makeContext(cwd: string, env: Record<string, string>): { ctx: EngineStartContext; exit: Promise<{ code: number | null; signal: string | null }> } {
  let resolveExit: (value: { code: number | null; signal: string | null } | PromiseLike<{ code: number | null; signal: string | null }>) => void = () => undefined;
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveExit = resolve;
  });
  const ctx: EngineStartContext = {
    spec: makeRunSpec({ cwd, engine: { name: 'opencode', adapterVersion: '1' } }),
    cwd,
    env,
    onLog: () => undefined,
    onExit: (code, signal) => resolveExit({ code, signal }),
  };
  return { ctx, exit };
}

describe('OpenCodeAdapter', () => {
  it('reports a missing binary as an engine startup failure', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opencode-adapter-'));
    try {
      const adapter = new OpenCodeAdapter({ binary: join(cwd, 'definitely-not-opencode') });
      expect(adapter.isAvailable()).toBe(false);
      const { ctx } = makeContext(cwd, {});
      await expect(adapter.start(ctx)).rejects.toBeInstanceOf(EngineStartupError);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  const available = new OpenCodeAdapter().isAvailable();

  describe.skipIf(!available)('on a host with the opencode binary installed', () => {
    it('spawns the real binary and observes its exit', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'opencode-live-'));
      try {
        const adapter = new OpenCodeAdapter({ argv: ['--version'] });
        const { ctx, exit } = makeContext(cwd, { PATH: process.env['PATH'] ?? '' });
        const handle = await adapter.start(ctx);
        expect(handle.pid).toBeGreaterThan(0);
        const result = await exit;
        expect(result.code).toBe(0);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
