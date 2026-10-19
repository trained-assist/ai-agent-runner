import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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
      writeFileSync(fakeOpenCode, '#!/bin/sh\nif [ "$1" = "export" ]; then printf "{}\\n"; exit 0; fi\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\n');
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
      ctx.spec.input = { inlinePrompt: 'Do a task.' };
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

  it('exports the full OpenCode session before reporting process exit', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opencode-checkpoint-'));
    try {
      const fakeOpenCode = join(cwd, 'opencode-stub.sh');
      const sessionId = 'ses_01J9A3J9Y7V8W2K4M6N0PQRSTZ';
      writeFileSync(fakeOpenCode, [
        '#!/bin/sh',
        'if [ "$1" = "export" ]; then',
        '  printf \'{"info":{"id":"%s"},"messages":[]}\\n\' "$2"',
        '  exit 0',
        'fi',
        'printf "%s\\n" "$@" > "$CAPTURE_ARGS"',
        `printf '{"type":"text","sessionID":"${sessionId}","part":{"type":"text","text":"answer"}}\\n'`,
      ].join('\n'));
      chmodSync(fakeOpenCode, 0o700);
      const capturedArgs = join(cwd, 'captured-args.txt');
      const { ctx, exit } = makeContext(cwd, { CAPTURE_ARGS: capturedArgs });
      ctx.spec.input = { inlinePrompt: 'Do a task.' };
      const adapter = new OpenCodeAdapter({ binary: fakeOpenCode });
      await adapter.start(ctx);
      await exit;

      const args = readFileSync(capturedArgs, 'utf8').trim().split('\n');
      expect(args).toContain('--format');
      expect(args).not.toContain('--session');
      const checkpoint = JSON.parse(readFileSync(join(cwd, '.session-traces', `${sessionId}.json`), 'utf8')) as { info: { id: string } };
      expect(checkpoint.info.id).toBe(sessionId);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(['ses_01J9A3J9Y7V8W2K4M6N0PQRSTZ', 'ses_eabdad9efffecDKCL3aEAtfJdY'])('forwards a typed question for %s without exposing it as an unstructured log', async (sessionId) => {
    const cwd = mkdtempSync(join(tmpdir(), 'opencode-question-'));
    try {
      const fakeOpenCode = join(cwd, 'opencode-stub.sh');
      writeFileSync(fakeOpenCode, [
        '#!/bin/sh',
        'if [ "$1" = "export" ]; then printf \'{"info":{"id":"%s"},"messages":[]}\\n\' "$2"; exit 0; fi',
        `printf '%s\\n' '${JSON.stringify({ type: 'question_asked', sessionID: sessionId, request: { id: 'question-1', sessionID: sessionId, questions: [{ header: 'Choice', question: 'Which environment?', multiple: false, options: [{ label: 'Sandbox', description: 'Test safely' }] },], tool: { callID: 'call-1' } } })}'`,
      ].join('\n'));
      chmodSync(fakeOpenCode, 0o700);
      const logs: string[] = [];
      const questions: unknown[] = [];
      const { ctx, exit } = makeContext(cwd, {});
      ctx.spec.input = { inlinePrompt: 'Ask for a clarification.' };
      ctx.onLog = (_stream, line) => logs.push(line);
      ctx.onAssistantQuestion = (question) => questions.push(question);

      await new OpenCodeAdapter({ binary: fakeOpenCode }).start(ctx);
      await exit;

      expect(questions).toEqual([{
        sessionId,
        requestId: 'question-1',
        questions: [{ header: 'Choice', question: 'Which environment?', multiple: false, options: [{ label: 'Sandbox', description: 'Test safely' }] }],
        toolCallId: 'call-1',
      }]);
      expect(logs.some((line) => line.includes('question-1'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('publishes one completed assistant message only when the step continues to tools', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opencode-messages-'));
    try {
      const sessionId = 'ses_01J9A3J9Y7V8W2K4M6N0PQRSTZ';
      const toolMessageId = 'msg_01J9A3J9Y7V8W2K4M6N0PQRSTZ';
      const finalMessageId = 'msg_01J9A3J9Y7V8W2K4M6N0PQRST0';
      const binary = join(cwd, 'opencode-stub.sh');
      writeFileSync(binary, [
        '#!/bin/sh',
        'if [ "$1" = "export" ]; then printf \'{"info":{"id":"%s"},"messages":[]}\\n\' "$2"; exit 0; fi',
        `printf '%s\\n' '${JSON.stringify({ type: 'text', sessionID: sessionId, part: { type: 'text', id: 'prt_01J9A3J9Y7V8W2K4M6N0PQRSTZ', messageID: toolMessageId, text: 'Сейчас проверю.', time: { end: 1 } } })}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'step_finish', sessionID: sessionId, part: { type: 'step-finish', messageID: toolMessageId, reason: 'tool-calls' } })}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'text', sessionID: sessionId, part: { type: 'text', id: 'prt_01J9A3J9Y7V8W2K4M6N0PQRST0', messageID: finalMessageId, text: 'Готово.', time: { end: 2 } } })}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'step_finish', sessionID: sessionId, part: { type: 'step-finish', messageID: finalMessageId, reason: 'stop' } })}'`,
      ].join('\n'));
      chmodSync(binary, 0o700);
      const { ctx, exit } = makeContext(cwd, {});
      ctx.spec.input = { inlinePrompt: 'Inspect then continue.' };
      const messages: Array<{ sessionId: string; messageId: string; text: string }> = [];
      const outputLines: Array<{ stream: string; text: string }> = [];
      ctx.onLog = (stream, text) => outputLines.push({ stream, text });
      ctx.onAssistantMessage = (message) => messages.push(message);
      await new OpenCodeAdapter({ binary }).start(ctx);
      await exit;
      expect(messages).toEqual([{ sessionId, messageId: toolMessageId, text: 'Сейчас проверю.' }]);
      expect(outputLines.filter((line) => line.stream === 'stdout').map((line) => line.text)).toEqual(['Готово.']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('imports a durable prior session before continuing it with the same OpenCode session id', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'opencode-resume-'));
    try {
      const sessionId = 'ses_01J9A3J9Y7V8W2K4M6N0PQRSTZ';
      mkdirSync(join(cwd, '.session-traces'), { recursive: true });
      const sessionBytes = Buffer.from(JSON.stringify({ info: { id: sessionId }, messages: [] }));
      const checkpointPath = `.session-traces/${sessionId}.json`;
      writeFileSync(join(cwd, ...checkpointPath.split('/')), sessionBytes);
      const fakeOpenCode = join(cwd, 'opencode-stub.sh');
      const capture = join(cwd, 'calls.txt');
      writeFileSync(fakeOpenCode, [
        '#!/bin/sh',
        'if [ "$1" = "import" ]; then touch "$IMPORTED"; echo import >> "$CAPTURE"; exit 0; fi',
        'if [ "$1" = "export" ]; then printf \'{"info":{"id":"%s"},"messages":[]}\\n\' "$2"; exit 0; fi',
        '[ -f "$IMPORTED" ] || exit 9',
        'printf "%s\\n" "$@" >> "$CAPTURE"',
      ].join('\n'));
      chmodSync(fakeOpenCode, 0o700);
      const { ctx, exit } = makeContext(cwd, { CAPTURE: capture, IMPORTED: join(cwd, 'imported') });
      ctx.spec.profileWorkspace = { bindingId: 'profile-a', snapshotUrl: 'https://example.test/snapshot', snapshotSha256: 'a'.repeat(64), snapshotSize: 1, savebackUrl: 'https://example.test/saveback', artifacts: [], excludedPatterns: [] };
      ctx.spec.input = { inlinePrompt: 'Continue the task.', resumeSessionFrom: {
        sourceRunId: 'run-previous', sessionId, path: checkpointPath,
        sha256: createHash('sha256').update(sessionBytes).digest('hex'), size: sessionBytes.length,
      } };
      await new OpenCodeAdapter({ binary: fakeOpenCode }).start(ctx);
      await exit;
      const calls = readFileSync(capture, 'utf8');
      expect(calls.startsWith('import\n')).toBe(true);
      expect(calls).toContain(`--session\n${sessionId}`);
      expect(calls).toContain('Continue the task.');
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
