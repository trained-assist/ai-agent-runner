import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('passes the runtime-only ingress index instruction to the engine without mutating RunSpec text', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opencode-ingress-'));
    try {
      const runSpec = makeRunSpec({ cwd, engine: { name: 'opencode', adapterVersion: '1' }, input: { inlinePrompt: 'Summarize the supplied audio.' } });
      const indexPath = join(cwd, '.inputs', 'ingress', runSpec.runId, 'input-items.json');
      mkdirSync(join(cwd, '.inputs', 'ingress', runSpec.runId), { recursive: true });
      writeFileSync(indexPath, JSON.stringify({ inputItems: [{ text: 'context', artifacts: [{ path: '00-voice.ogg' }] }] }));
      const capturedArgs = join(cwd, 'captured-args.txt');
      const fakeOpenCode = join(cwd, 'opencode-stub.sh');
      writeFileSync(fakeOpenCode, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\n');
      chmodSync(fakeOpenCode, 0o700);
      const originalPrompt = runSpec.input?.inlinePrompt;
      runSpec.ingressManifest = {
        contractVersion: 1,
        manifestRef: `cp-input-manifest:${runSpec.userTaskId}`,
        manifestVersion: 'a'.repeat(64),
        userTaskId: runSpec.userTaskId,
        profileId: runSpec.profileId,
        runId: runSpec.runId,
        ownerGeneration: runSpec.ownerGeneration,
      };
      const { ctx, exit } = makeContext(cwd, { CAPTURE_ARGS: capturedArgs });
      ctx.spec = runSpec;
      const adapter = new OpenCodeAdapter({ binary: fakeOpenCode });
      await adapter.start(ctx);
      await exit;
      const args = readFileSync(capturedArgs, 'utf8');
      expect(args).toContain('Summarize the supplied audio.');
      expect(args).toContain(indexPath);
      expect(args).toContain('Process inputItems in array order');
      expect(args).toContain('Artifact paths are relative to the index directory');
      expect(runSpec.input?.inlinePrompt).toBe(originalPrompt);
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
