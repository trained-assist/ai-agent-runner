import type { LaunchReceipt, LaunchResult, WorkerCancelResult, WorkerStatusView } from '../adapters/external-worker-adapter.js';
import type { RunSpec } from '../contracts/run-spec.js';
import type { ExternalWorker } from '../adapters/external-worker-adapter.js';
import { ResultNotReadyError } from '../adapters/external-worker-adapter.js';

export const MOCK_TEST_ENGINE = 'mock-test';
export const MOCK_TEST_ANSWER = 'pong';

/**
 * In-process test executor. It is registered only when the API deployment explicitly
 * enables sandbox mock-test mode. It never contacts a worker, model, repository, or profile store.
 */
export class MockTestWorker implements ExternalWorker {
  readonly name = MOCK_TEST_ENGINE;
  readonly baseUrl = null;
  private readonly results = new Map<string, LaunchResult>();

  async launch(spec: RunSpec, admittedAt = new Date().toISOString()): Promise<LaunchReceipt> {
    this.results.set(spec.runId, {
      runId: spec.runId,
      status: 'started',
      exitCode: 0,
      exitSignal: null,
      exitReason: 'completed',
      stdout: 'request structure valid; authorization accepted by mock-test',
      stderr: '',
      answer: MOCK_TEST_ANSWER,
      answerSource: 'engine_stdout',
      durationMs: 0,
      timedOut: false,
      outputTruncated: false,
      artifacts: [],
      logUrl: '',
      repo: null,
    });
    const localUrl = `http://mock-test.invalid/v1/runs/${encodeURIComponent(spec.runId)}`;
    return {
      runId: spec.runId,
      operationId: spec.operationId,
      status: 'accepted',
      statusUrl: `${localUrl}/status?acceptedAt=${encodeURIComponent(admittedAt)}`,
      resultUrl: `${localUrl}/result`,
    };
  }

  async status(runId: string): Promise<WorkerStatusView> {
    return { runId, status: this.results.has(runId) ? 'succeeded' : 'unknown' };
  }

  async result(runId: string): Promise<LaunchResult> {
    const result = this.results.get(runId);
    if (!result) throw new ResultNotReadyError(runId);
    return result;
  }

  async cancel(runId: string): Promise<WorkerCancelResult> {
    return this.results.has(runId)
      ? { status: 'rejected', reason: 'mock-test completes immediately' }
      : { status: 'unknown_run' };
  }

  async dispose(): Promise<void> {
    this.results.clear();
  }
}
