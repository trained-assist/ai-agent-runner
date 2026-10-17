import { describe, expect, it } from 'vitest';
import { makeRunSpec } from './helpers.js';
import { MockTestWorker, MOCK_SCENARIOS } from '../src/api/mock-test-worker.js';

describe('MockTestWorker', () => {
  it('exposes the full scenario list', () => {
    expect(MOCK_SCENARIOS).toContain('ping-pong');
    expect(MOCK_SCENARIOS).toContain('output-artifact');
    expect(MOCK_SCENARIOS).toContain('mother-and-kids:all-good');
  });

  for (const scenario of ['ping-pong', 'output-artifact', 'mother-and-kids:all-good', 'parallel-sessions:all-good']) {
    it(`runs scenario ${scenario} and returns a contract-shaped result`, async () => {
      const worker = new MockTestWorker();
      const spec = makeRunSpec({
        engine: { name: 'mock-test', adapterVersion: '1' },
        input: { inlinePrompt: `scenario: ${scenario}` },
      });
      const receipt = await worker.launch(spec);
      expect(receipt.status).toBe('accepted');
      const status = await worker.status(spec.runId);
      expect(['succeeded', 'failed']).toContain(status.status);
      const result = await worker.result(spec.runId);
      expect(result.runId).toBe(spec.runId);
      expect(typeof result.logUrl).toBe('string');
      expect(Array.isArray(result.artifacts)).toBe(true);
      await worker.dispose();
    });
  }

  it('returns an artifact for output-artifact scenario', async () => {
    const worker = new MockTestWorker();
    const spec = makeRunSpec({
      engine: { name: 'mock-test', adapterVersion: '1' },
      input: { inlinePrompt: 'scenario: output-artifact' },
    });
    await worker.launch(spec);
    const result = await worker.result(spec.runId);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.path).toBe('report.md');
    expect(result.answer).toBe('artifact ready');
  });

  it('parallel-sessions: parent-dead still completes', async () => {
    const worker = new MockTestWorker();
    const spec = makeRunSpec({
      engine: { name: 'mock-test', adapterVersion: '1' },
      input: { inlinePrompt: 'scenario: parallel-sessions:parent-dead' },
    });
    await worker.launch(spec);
    const result = await worker.result(spec.runId);
    expect(result.status).toBe('started');
    expect(result.answer).toContain('resurrection');
  });

  it('parallel-sessions: session-timeout restores from checkpoint', async () => {
    const worker = new MockTestWorker();
    const spec = makeRunSpec({
      engine: { name: 'mock-test', adapterVersion: '1' },
      input: { inlinePrompt: 'scenario: parallel-sessions:session-timeout' },
    });
    await worker.launch(spec);
    const result = await worker.result(spec.runId);
    expect(result.timedOut).toBe(true);
    expect(result.answer).toContain('restored');
  });

  it('marks mother-dead scenario as failed', async () => {
    const worker = new MockTestWorker();
    const spec = makeRunSpec({
      engine: { name: 'mock-test', adapterVersion: '1' },
      input: { inlinePrompt: 'scenario: mother-and-kids:mother-dead-before-kids' },
    });
    await worker.launch(spec);
    const result = await worker.result(spec.runId);
    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('PARENT_DIED');
  });
});
