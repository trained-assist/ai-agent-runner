import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { handleForChild } from '../src/adapters/engine/process-tree.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness } from './helpers.js';
import type { EngineAdapter } from '../src/adapters/engine/engine-adapter.js';
import { ANSWER_MAX_CHARS } from '../src/runner/checkpoint.js';
function engine(lines: string[]): EngineAdapter {
  return { name: 'fake', async start(ctx) {
    const source = `for (const line of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(line) + '\\n');`;
    const child = spawn(process.execPath, ['-e', source], { cwd: ctx.cwd, env: ctx.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return handleForChild(child, { onLog: (stream, line) => ctx.onLog(stream, stream === 'stdout' ? JSON.parse(line) : line), onExit: ctx.onExit });
  } };
}
describe('complete authoritative stdout answer', () => {
  it('preserves a long structured document beyond the log preview, including blank paragraphs and code', async () => {
    const text = `# Service architecture\n\n${'A complete paragraph with Unicode 🧪. '.repeat(130)}\n\n\`\`\`sql\nSELECT 1;\n\`\`\`\n\nFinal acceptance criterion.`;
    const h = createHarness({ adapters: { fake: engine([text]) }, artifactExport: true });
    const { receipt } = h.start({ limits: { timeoutMs: 5000, maxOutputBytes: 100000, maxLogBytes: 128 } });
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('succeeded');
    expect(result.text).toBe(text);
    const checkpoint = JSON.parse(readFileSync(join(h.rootDir, 'runs', receipt.runId, 'checkpoint.json'), 'utf8'));
    expect(checkpoint.answer.text).toBe(text);
    const artifact = await h.artifacts!.read(receipt.runId, checkpoint.answer.artifactId);
    expect(artifact.bytes.toString('utf8')).toBe(text);
    const stdout = h.runner.events(receipt.runId).flatMap(e => e.type === 'log' && e.payload.stream === 'stdout' ? [e.payload] : []);
    expect(stdout).toHaveLength(1);
    expect(String(stdout[0]!.message).length).toBeLessThan(150);
    expect(String(stdout[0]!.message)).not.toContain('\n');
  });
  it('keeps more than 200 output lines with their paragraph separators', async () => {
    const lines = Array.from({ length: 240 }, (_, i) => i % 3 === 0 ? '' : `Requirement ${i}`);
    const h = createHarness({ adapters: { fake: engine(lines) } });
    const { receipt } = h.start();
    expect((await h.runner.waitFor(receipt.runId)).text).toBe(lines.join('\n'));
  });
  it('redacts credentials in both the complete answer and its log projection', async () => {
    const text = `${'Full document. '.repeat(200)}\n\nBearer sk-testSecret123456789 and password=private-value\n\nThe ending is preserved.`;
    const h = createHarness({ adapters: { fake: engine([text]) } });
    const { receipt } = h.start();
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.text).not.toContain('private-value');
    expect(result.text).not.toContain('testSecret123456789');
    expect(result.text).toContain('\n\nThe ending is preserved.');
    expect(JSON.stringify(h.runner.events(receipt.runId))).not.toContain('private-value');
  });
  it('honours an explicit UTF-8 output byte ceiling without bisecting an emoji', async () => {
    const h = createHarness({ adapters: { fake: engine(['🧪'.repeat(300)]) } });
    const { receipt } = h.start({ limits: { timeoutMs: 5000, maxOutputBytes: 801 } });
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.outcome).toBe('succeeded');
    expect(Buffer.byteLength(result.text!, 'utf8')).toBe(800);
    expect(result.text).toBe('🧪'.repeat(200));
  });
  it('retains the existing overall answer ceiling without replacing its beginning with a tail', async () => {
    const h = createHarness({ adapters: { fake: engine(['START\n' + 'x'.repeat(ANSWER_MAX_CHARS), 'EXCESS']) } });
    const { receipt } = h.start();
    const result = await h.runner.waitFor(receipt.runId);
    expect(result.text?.length).toBe(ANSWER_MAX_CHARS);
    expect(result.text?.startsWith('START\n')).toBe(true);
    expect(result.text).not.toContain('EXCESS');
  });
});
