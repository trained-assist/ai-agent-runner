import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { AgentApi } from '../src/api/service.js';
import type { Principal } from '../src/api/auth.js';
import type { ExternalWorker, WorkerRunStatus } from '../src/adapters/external-worker-adapter.js';
import { ResultNotReadyError } from '../src/adapters/external-worker-adapter.js';
import { PreflightError } from '../src/contracts/validate.js';

const principal: Principal = { principalId: 'fixture-owner', profileId: 'fixture-profile',
  scopes: ['runs:read', 'runs:write'], engines: ['dynamic-ip-azure-agent-run'] };

async function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T00:00:00Z'));
  const current: { state: WorkerRunStatus } = { state: 'accepted' };
  const worker: ExternalWorker = {
    name: 'dynamic-ip-azure-agent-run', baseUrl: 'https://worker.invalid',
    launch: vi.fn<ExternalWorker['launch']>(async spec => ({ runId: spec.runId, operationId: spec.operationId!, status: 'accepted',
      statusUrl: `https://worker.invalid/v1/runs/${spec.runId}/status`, resultUrl: `https://worker.invalid/v1/runs/${spec.runId}/result` })),
    status: vi.fn<ExternalWorker['status']>(async runId => ({ runId, status: current.state })),
    result: vi.fn<ExternalWorker['result']>(async runId => ({ runId, status: 'started', exitCode: 0, exitSignal: null, exitReason: 'completed',
      stdout: 'late result', stderr: '', durationMs: 100, timedOut: false, outputTruncated: false,
      artifacts: [], logUrl: 'https://logs.invalid/fixture', repo: { fullName: 'fixture/result', branch: 'fixture', commit: 'abc1234' } })),
    cancel: vi.fn<ExternalWorker['cancel']>(async () => ({ status: 'rejected' })),
  };
  const logger = vi.fn();
  const api = new AgentApi({ workers: [worker], logger, resultGraceMs: 0 });
  const services = [api];
  onTestFinished(async () => {
    for (const service of services) await service.dispose();
    await vi.advanceTimersByTimeAsync(10000);
    vi.useRealTimers();
  });
  const receipt = api.submit(principal, 'late-queued-attempt', {
    userTaskId: 'fixture-task',
    engine: { name: worker.name, adapterVersion: '1' }, limits: { timeoutMs: 1000 },
    envAllowlist: [], input: { inlinePrompt: 'offline late queue fixture' },
  });
  await vi.advanceTimersByTimeAsync(0);
  return { api, services, worker, logger, current, receipt };
}

describe('accepted native runs reconcile after the observation budget', () => {
  it.each(['not_ready', 'transport'] as const)('retries terminal result %s on the same accepted run', async failure => {
    const { api, worker, current, receipt } = await fixture();
    current.state = 'succeeded';
    vi.mocked(worker.result).mockRejectedValueOnce(failure === 'not_ready'
      ? new ResultNotReadyError(receipt.runId) : new TypeError('fetch failed'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.status(principal, receipt.runId).state).toBe('unknown');
    expect(() => api.result(principal, receipt.runId)).toThrow();
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.result(principal, receipt.runId)).toMatchObject({ runId: receipt.runId,
      userTaskId: 'fixture-task', ownerGeneration: 1, outcome: 'succeeded', exitObserved: true });
    expect(worker.launch).toHaveBeenCalledOnce();
    expect(worker.cancel).not.toHaveBeenCalled();
    expect(worker.result).toHaveBeenCalledTimes(2);
    expect(vi.mocked(worker.result).mock.calls.every(([runId]) => runId === receipt.runId)).toBe(true);
    expect(api.store.dispatchedRuns()).toHaveLength(1);
  });

  it.each(['WORKER_PROTOCOL_INVALID', 'LAUNCH_RESULT_INVALID'])('keeps invalid result %s terminal', async code => {
    const { api, worker, current, receipt } = await fixture();
    current.state = 'succeeded';
    vi.mocked(worker.result).mockRejectedValueOnce(new PreflightError(code, 'invalid fixture result', { failureClass: 'runtime', retryable: true }));
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.result(principal, receipt.runId)).toMatchObject({ outcome: 'failed', failure: { code } });
    expect(worker.result).toHaveBeenCalledOnce();
    expect(worker.launch).toHaveBeenCalledOnce();
    expect(api.resumeDispatched()).toBe(0);
  });

  it('collects a late queued completion on the same job with capped polling and no relaunch', async () => {
    const { api, worker, logger, current, receipt } = await fixture();
    await vi.advanceTimersByTimeAsync(30000);
    expect(api.status(principal, receipt.runId).state).toBe('unknown');
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ event: 'run_outcome_unknown', reason: 'budget_exceeded' }));
    const polls = vi.mocked(worker.status).mock.calls.length;
    expect(polls).toBeGreaterThan(3);
    expect(polls).toBeLessThan(12);
    expect(worker.result).not.toHaveBeenCalled();
    current.state = 'succeeded';
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.status(principal, receipt.runId).state).toBe('succeeded');
    expect(api.result(principal, receipt.runId)).toMatchObject({ runId: receipt.runId, userTaskId: 'fixture-task', ownerGeneration: 1, exitObserved: true });
    expect(worker.launch).toHaveBeenCalledOnce();
    expect(worker.cancel).not.toHaveBeenCalled();
    expect(worker.result).toHaveBeenCalledOnce();
    expect(worker.result).toHaveBeenCalledWith(receipt.runId);
    expect(vi.mocked(worker.status).mock.calls.every(([runId]) => runId === receipt.runId)).toBe(true);
    expect(api.store.dispatchedRuns()).toHaveLength(1);
    const terminalPolls = vi.mocked(worker.status).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(worker.status).toHaveBeenCalledTimes(terminalPolls);
  });

  it('restored dispatched polling also crosses the deadline without another launch', async () => {
    const { api, services, worker, current, receipt } = await fixture();
    await api.dispose();
    const restored = new AgentApi({ workers: [worker], store: api.store, logger: vi.fn(), resultGraceMs: 0 });
    services.push(restored);
    expect(restored.resumeDispatched()).toBe(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(restored.status(principal, receipt.runId).state).toBe('unknown');
    const polls = vi.mocked(worker.status).mock.calls.length;
    current.state = 'succeeded';
    await vi.advanceTimersByTimeAsync(10000);
    expect(restored.status(principal, receipt.runId).state).toBe('succeeded');
    expect(vi.mocked(worker.status).mock.calls.length).toBeGreaterThan(polls);
    expect(worker.launch).toHaveBeenCalledOnce();
    expect(worker.result).toHaveBeenCalledOnce();
    expect(worker.result).toHaveBeenCalledWith(receipt.runId);
  });

  it('disposal stops reconciliation after expiry without cancelling the accepted job', async () => {
    const { api, worker, receipt } = await fixture();
    await vi.advanceTimersByTimeAsync(30000);
    expect(api.status(principal, receipt.runId).state).toBe('unknown');
    const polls = vi.mocked(worker.status).mock.calls.length;
    await api.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(worker.status).toHaveBeenCalledTimes(polls);
    expect(worker.launch).toHaveBeenCalledOnce();
    expect(worker.result).not.toHaveBeenCalled();
    expect(worker.cancel).not.toHaveBeenCalled();
  });
});
