import type { LaunchReceipt, LaunchResult, WorkerCancelResult, WorkerStatusView } from '../adapters/external-worker-adapter.js';
import type { RunSpec } from '../contracts/run-spec.js';
import type { ExternalWorker } from '../adapters/external-worker-adapter.js';
import { ResultNotReadyError } from '../adapters/external-worker-adapter.js';

export const MOCK_TEST_ENGINE = 'mock-test';
export const MOCK_TEST_ANSWER = 'pong';

export const MOCK_SCENARIOS = [
  'ping-pong',
  'output-artifact',
  'mother-and-kids:all-good',
  'mother-and-kids:mother-dead-before-kids',
  'mother-and-kids:one-child-dead',
  'mother-and-kids:all-dead',
  'parallel-sessions:all-good',
  'parallel-sessions:parent-dead',
  'parallel-sessions:one-child-dead',
  'parallel-sessions:all-dead',
  'parallel-sessions:session-timeout',
] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];

function parseScenario(spec: RunSpec): MockScenario {
  const prompt = (spec.input?.inlinePrompt ?? '').trim();;
  const match = prompt.match(/^(?:scenario|mock):\s*(\S+)/i);
  if (match) {
    const candidate = match[1] ?? "";
    if ((MOCK_SCENARIOS as readonly string[]).includes(candidate)) return candidate as MockScenario;
  }
  if (/output[-_ ]?artifact/i.test(prompt)) return 'output-artifact';
  if (/mother/i.test(prompt)) return 'mother-and-kids:all-good';
  if (/parallel/i.test(prompt) && /timeout/i.test(prompt)) return 'parallel-sessions:session-timeout';
  if (/parallel/i.test(prompt)) return 'parallel-sessions:all-good';
  return 'ping-pong';
}

function now(): string {
  return new Date().toISOString();
}

function baseResult(spec: RunSpec, scenario: MockScenario): LaunchResult {
  const localUrl = `http://mock-test.invalid/v1/runs/${encodeURIComponent(spec.runId)}`;
  const startedAt = now();
  switch (scenario) {
    case 'output-artifact':
      return {
        runId: spec.runId,
        status: 'started',
        exitCode: 0,
        exitSignal: null,
        exitReason: 'completed',
        stdout: 'mock-test: materialized input\nmock-test: wrote report.md\nmock-test: done',
        stderr: '',
        answer: 'artifact ready',
        answerSource: 'engine_stdout',
        durationMs: 12,
        timedOut: false,
        outputTruncated: false,
        artifacts: [
          {
            path: 'report.md',
            name: 'report.md',
            mime: 'text/markdown',
            sha256: 'a'.repeat(64),
            size: 1234,
          },
        ],
        logUrl: `${localUrl}/log`,
        repo: null,
      };
    case 'mother-and-kids:all-good':
      return {
        runId: spec.runId,
        status: 'started',
        exitCode: 0,
        exitSignal: null,
        exitReason: 'completed',
        stdout: [
          'mock-test: parent started',
          'mock-test: spawned child 1 (run_child_1)',
          'mock-test: spawned child 2 (run_child_2)',
          'mock-test: spawned child 3 (run_child_3)',
          'mock-test: child 1 completed',
          'mock-test: child 2 completed',
          'mock-test: child 3 completed',
          'mock-test: parent completed',
        ].join('\n'),
        stderr: '',
        answer: 'mother and 3 kids completed',
        answerSource: 'engine_stdout',
        durationMs: 30,
        timedOut: false,
        outputTruncated: false,
        artifacts: [],
        logUrl: `${localUrl}/log`,
        repo: null,
      };
    case 'mother-and-kids:mother-dead-before-kids':
      return {
        runId: spec.runId,
        status: 'failed',
        exitCode: null,
        exitSignal: 'SIGKILL',
        exitReason: 'crash',
        stdout: 'mock-test: parent started\nmock-test: spawned child 1 (run_child_1)\nmock-test: parent died before children settled',
        stderr: 'mock-test: parent killed',
        answer: null,
        answerSource: 'engine_stdout',
        durationMs: 8,
        timedOut: false,
        outputTruncated: false,
        artifacts: [],
        logUrl: `${localUrl}/log`,
        repo: null,
        failure: { code: 'PARENT_DIED', failureClass: 'runtime', safeSummary: 'parent died before children settled', retryable: true },
      };
    case 'mother-and-kids:one-child-dead':
      return {
        runId: spec.runId,
        status: 'failed',
        exitCode: 1,
        exitSignal: null,
        exitReason: 'nonzero_exit',
        stdout: [
          'mock-test: parent started',
          'mock-test: spawned child 1 (run_child_1)',
          'mock-test: spawned child 2 (run_child_2)',
          'mock-test: spawned child 3 (run_child_3)',
          'mock-test: child 2 died (exit 1)',
          'mock-test: parent aborted',
        ].join('\n'),
        stderr: 'mock-test: child 2 failed',
        answer: null,
        answerSource: 'engine_stdout',
        durationMs: 20,
        timedOut: false,
        outputTruncated: false,
        artifacts: [],
        logUrl: `${localUrl}/log`,
        repo: null,
        failure: { code: 'CHILD_DIED', failureClass: 'runtime', safeSummary: 'child 2 died (exit 1)', retryable: true },
      };
    case 'mother-and-kids:all-dead':
      return {
        runId: spec.runId,
        status: 'failed',
        exitCode: null,
        exitSignal: 'SIGKILL',
        exitReason: 'crash',
        stdout: 'mock-test: parent started\nmock-test: all children died',
        stderr: 'mock-test: parent and children killed',
        answer: null,
        answerSource: 'engine_stdout',
        durationMs: 5,
        timedOut: false,
        outputTruncated: false,
        artifacts: [],
        logUrl: `${localUrl}/log`,
        repo: null,
        failure: { code: 'ALL_DIED', failureClass: 'runtime', safeSummary: 'parent and all children died', retryable: true },
      };
    case 'parallel-sessions:all-good':
      return {
        runId: spec.runId,
        status: 'started',
        exitCode: 0,
        exitSignal: null,
        exitReason: 'completed',
        stdout: [
          'mock-test: parent started',
          'mock-test: spawned child 1 (session_child_1) task=research-A',
          'mock-test: spawned child 2 (session_child_2) task=research-B',
          'mock-test: spawned child 3 (session_child_3) task=research-C',
          'mock-test: child 1 report -> parent (result-A)',
          'mock-test: child 2 report -> parent (result-B)',
          'mock-test: child 3 report -> parent (result-C)',
          'mock-test: parent synthesized final answer',
          'mock-test: final answer -> user',
        ].join('\n'),
        stderr: '',
        answer: 'parallel result: A + B + C',
        answerSource: 'engine_stdout',
        durationMs: 45,
        timedOut: false,
        outputTruncated: false,
        artifacts: [],
        logUrl: `${localUrl}/log`,
        repo: null,
      };
    case 'parallel-sessions:parent-dead':
      return {
        runId: spec.runId,
        status: 'started',
        exitCode: 0,
        exitSignal: null,
        exitReason: 'completed',
        stdout: [
          'mock-test: parent started',
          'mock-test: spawned child 1 (session_child_1)',
          'mock-test: spawned child 2 (session_child_2)',
          'mock-test: parent died',
          'mock-test: parent resurrected',
          'mock-test: received pending reports from children',
          'mock-test: final answer -> user',
        ].join('\n'),
        stderr: '',
        answer: 'parallel result after parent resurrection',
        answerSource: 'engine_stdout',
        durationMs: 60,
        timedOut: false,
        outputTruncated: false,
        artifacts: [],
        logUrl: `${localUrl}/log`,
        repo: null,
      };
    case 'parallel-sessions:one-child-dead':
      return {
        runId: spec.runId,
        status: 'started',
        exitCode: 0,
        exitSignal: null,
        exitReason: 'completed',
        stdout: [
          'mock-test: parent started',
          'mock-test: spawned child 1 (session_child_1)',
          'mock-test: spawned child 2 (session_child_2)',
          'mock-test: spawned child 3 (session_child_3)',
          'mock-test: child 2 died (exit 1)',
          'mock-test: parent continued with partial results',
          'mock-test: final answer -> user (partial)',
        ].join('\n'),
        stderr: 'mock-test: child 2 failed',
        answer: 'parallel result: A + C (B lost)',
        answerSource: 'engine_stdout',
        durationMs: 40,
        timedOut: false,
        outputTruncated: false,
        artifacts: [],
        logUrl: `${localUrl}/log`,
        repo: null,
      };
    case 'parallel-sessions:all-dead':
      return {
        runId: spec.runId,
        status: 'failed',
        exitCode: null,
        exitSignal: 'SIGKILL',
        exitReason: 'crash',
        stdout: 'mock-test: parent started\nmock-test: all children died',
        stderr: 'mock-test: parent and children killed',
        answer: null,
        answerSource: 'engine_stdout',
        durationMs: 10,
        timedOut: false,
        outputTruncated: false,
        artifacts: [],
        logUrl: `${localUrl}/log`,
        repo: null,
        failure: { code: 'ALL_DIED', failureClass: 'runtime', safeSummary: 'parent and all children died', retryable: true },
      };
    case 'parallel-sessions:session-timeout':
      return {
        runId: spec.runId,
        status: 'started',
        exitCode: 0,
        exitSignal: null,
        exitReason: 'completed',
        stdout: [
          'mock-test: parent started',
          'mock-test: spawned child 1 (session_child_1)',
          'mock-test: spawned child 2 (session_child_2)',
          'mock-test: session timeout reached (10s)',
          'mock-test: checkpoint saved (2 child reports)',
          'mock-test: parent resurrected',
          'mock-test: restored from checkpoint',
          'mock-test: final answer -> user',
        ].join('\n'),
        stderr: '',
        answer: 'parallel result restored after session timeout',
        answerSource: 'engine_stdout',
        durationMs: 10000,
        timedOut: true,
        outputTruncated: false,
        artifacts: [],
        logUrl: `${localUrl}/log`,
        repo: null,
      };
    case 'ping-pong':
    default:
      return {
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
        logUrl: `${localUrl}/log`,
        repo: null,
      };
  }
}

/**
 * In-process test executor. It is registered only when the API deployment explicitly
 * enables sandbox mock-test mode. It never contacts a worker, model, repository, or profile store.
 */
export class MockTestWorker implements ExternalWorker {
  readonly name = MOCK_TEST_ENGINE;
  readonly baseUrl = null;
  private readonly results = new Map<string, LaunchResult>();

  async launch(spec: RunSpec, admittedAt = new Date().toISOString()): Promise<LaunchReceipt> {
    const scenario = parseScenario(spec);
    const result = baseResult(spec, scenario);
    this.results.set(spec.runId, result);
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
    const result = this.results.get(runId);
    if (!result) return { runId, status: 'unknown' };
    return { runId, status: result.status === 'started' ? 'succeeded' : 'failed' };
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
