import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_WORKER_ENGINE,
  ExternalWorkerAdapter,
  artifactUrl,
  launchRequestFromSpec,
  admissionEvents,
  mapLaunchResult,
  branchUrl,
  mergeUrl,
  repoHasCommit,
  isRetrievableLogUrl,
  runBranchName,
  runLogRef,
  validateLaunchResult,
  workerTransportFailure,
  type LaunchResult,
} from '../src/adapters/external-worker-adapter.js';
import { PreflightError } from '../src/contracts/validate.js';
import { validateRunResult } from '../src/contracts/result.js';
import { validateRunnerEvent } from '../src/contracts/events.js';
import { adapterFor, startMockWorker } from './external-worker-harness.js';
import { makeRunSpec } from './helpers.js';

const TIMES = { startedAt: '2026-10-04T10:00:00.000Z', finishedAt: '2026-10-04T10:00:45.000Z' };

function launchResult(over: Partial<LaunchResult> = {}): LaunchResult {
  return {
    runId: 'run-1',
    status: 'started',
    pid: 4242,
    exitCode: 0,
    exitSignal: null,
    exitReason: 'completed',
    stdout: 'done',
    stderr: '',
    answer: 'отчёт готов',
    answerSource: 'engine_stdout',
    durationMs: 45_000,
    timedOut: false,
    outputTruncated: false,
    artifacts: [{ path: 'report.md', name: 'report.md', mime: 'text/markdown', sha256: 'a'.repeat(64), size: 1234 }],
    logUrl: 'https://storage.googleapis.com/agent-logs/runs/run-1/session.log',
    repo: { fullName: 'owner/name', branch: 'agent-run/run-1', commit: 'abc1234', baseRef: 'main' },
    ...over,
  };
}

describe('launch request: RunSpec → LaunchRequest (issue #73)', () => {
  it('промпт, лимиты, репозиторий и изоляция уезжают в воркер как есть', () => {
    const ingressManifest = {
      contractVersion: 1 as const,
      manifestRef: 'manifest-task-1',
      manifestVersion: 'a'.repeat(64),
      userTaskId: 'task-ingress-1',
      profileId: 'profile-a',
      runId: 'run-ingress-1',
      ownerGeneration: 1,
    };
    const spec = makeRunSpec({
      runId: ingressManifest.runId,
      userTaskId: ingressManifest.userTaskId,
      ingressManifest,
      engine: { name: EXTERNAL_WORKER_ENGINE, adapterVersion: '1', modelSettings: { model: 'free' } },
      input: { inlinePrompt: 'сделай отчёт' },
      envAllowlist: ['PATH', 'HOME'],
      limits: { timeoutMs: 300_000, maxOutputBytes: 1_048_576, maxLogBytes: 1_048_576 },
      repository: { fullName: 'owner/name' },
      isolation: { mode: 'per_run_unix_identity' },
      outputs: [{ path: 'report.md', name: 'report.md', mime: 'text/markdown' }],
    });
    const request = launchRequestFromSpec(spec, {
      env: { PATH: '/usr/bin', HOME: '/home/runner', SECRET: 'nope' },
      resultUrl: 'http://api.local/v1/worker/launches/run_x/result',
      supportsIngressManifest: true,
    });

    expect(request.engine).toEqual({ name: EXTERNAL_WORKER_ENGINE, adapterVersion: '1', modelSettings: { model: 'free' } });
    expect(request.input.inlinePrompt).toBe('сделай отчёт');
    expect(request.limits).toEqual({ timeoutMs: 300_000, maxOutputBytes: 1_048_576, maxLogBytes: 1_048_576 });
    expect(request.repository.fullName).toBe('owner/name');
    // Ветку называет наш API: только он знает runId, поэтому имя уникально и не конфликтует.
    expect(request.repository.branch).toBe(`agent-run/${spec.runId}`);
    expect(request.isolation.mode).toBe('per_run_unix_identity');
    expect(request.outputs).toEqual([{ path: 'report.md', name: 'report.md', mime: 'text/markdown' }]);
    expect(request.ingressManifest).toEqual(ingressManifest);
    // В процесс агента уходят только переменные из envAllowlist; секрет хоста остаётся здесь.
    expect(request.env).toEqual({ PATH: '/usr/bin', HOME: '/home/runner' });
    expect(JSON.stringify(request)).not.toContain('nope');
  });

  it('routes ingress-manifest pins only to VM workers with the trusted CP resolver', async () => {
    const worker = await startMockWorker();
    try {
      const pin = {
        contractVersion: 1 as const,
        manifestRef: 'manifest-vm-route',
        manifestVersion: 'c'.repeat(64),
        userTaskId: 'task-vm-route',
        profileId: 'profile-a',
        runId: 'run-vm-route',
        ownerGeneration: 1,
      };
      const spec = makeRunSpec({
        runId: pin.runId,
        userTaskId: pin.userTaskId,
        engine: { name: 'eu-vm-agent-run', adapterVersion: '1' },
        input: { inlinePrompt: 'run' },
        ingressManifest: pin,
      });
      const vm = new ExternalWorkerAdapter({ engineName: 'eu-vm-agent-run', baseUrl: worker.baseUrl, baseUrlForResult: 'https://api.test' });
      await vm.launch(spec);
      expect(worker.launches[0]?.['ingressManifest']).toEqual(pin);

      const gha = new ExternalWorkerAdapter({ engineName: 'azure-dynamic-ip-agent-run', baseUrl: worker.baseUrl, baseUrlForResult: 'https://api.test' });
      await expect(gha.launch({ ...spec, engine: { name: 'azure-dynamic-ip-agent-run', adapterVersion: '1' } }))
        .rejects.toMatchObject({ code: 'INGRESS_MANIFEST_UNSUPPORTED' });
      expect(worker.launches).toHaveLength(1);
    } finally {
      await worker.close();
    }
  });

  it('подставляет положительные лимиты, когда клиент их не задал', () => {
    const spec = makeRunSpec({ input: { inlinePrompt: 'проверка' }, limits: { timeoutMs: 300_000 } });
    const request = launchRequestFromSpec(spec);
    expect(request.limits).toEqual({ timeoutMs: 300_000, maxOutputBytes: 5_000_000, maxLogBytes: 5_000_000 });
  });

  it('input.refs — preflight-отказ: stateless API нечего материализовать', () => {
    const spec = makeRunSpec({ input: { refs: [{ ref: 'snap-1', snapshotId: 'snapshot-1' }] } });
    try {
      launchRequestFromSpec(spec);
      expect.unreachable('refs must be refused before the worker is called');
    } catch (err) {
      expect(err).toBeInstanceOf(PreflightError);
      expect((err as PreflightError).code).toBe('INPUT_REFS_UNSUPPORTED');
      expect((err as PreflightError).retryable).toBe(false);
    }
  });

  it('без input.inlinePrompt — preflight-отказ INLINE_PROMPT_REQUIRED', () => {
    const spec = makeRunSpec({ input: {} });
    try {
      launchRequestFromSpec(spec);
      expect.unreachable('a run without a prompt must be refused');
    } catch (err) {
      expect((err as PreflightError).code).toBe('INLINE_PROMPT_REQUIRED');
    }
  });
});

describe('валидация LaunchResult', () => {
  it('принимает ответ, соответствующий контракту', () => {
    const validated = validateLaunchResult(launchResult(), 'run-1');
    expect(validated.ok).toBe(true);
  });

  it('ответ без answer принимается: настоящий opencode-шлюз его не присылает', () => {
    // Живая проба #100: реальный результат воркера отвергался как WORKER_PROTOCOL_INVALID
    // только из-за отсутствующего answer — рана с артефактами у клиента не было.
    const { answer: _answer, ...withoutAnswer } = launchResult();
    const validated = validateLaunchResult(withoutAnswer, 'run-1');
    expect(validated.ok).toBe(true);
  });

  it('ANSI и управляющие символы в stderr вычищаются, а не роняют результат', () => {
    // Реальный opencode печатает цветом: раньше такой stderr отвергал весь результат.
    const validated = validateLaunchResult(
      launchResult({ stderr: '\u001b[0m> build · free\u001b[0m\n\u001b[91m\u001b[1mError:\u001b[0m unauthorized\u001b[0m' }),
      'run-1',
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.stderr).not.toContain('\u001b');
    expect(validated.value.stderr).toContain('Error:');
  });

  it('чужой runId, отсутствующие logUrl/repo и неизвестный exitReason — отказ', () => {
    const validated = validateLaunchResult({ runId: 'run-other', exitReason: 'exploded' }, 'run-1');
    expect(validated.ok).toBe(false);
    const errors = validated.ok ? [] : validated.errors;
    expect(errors.some((entry) => entry.includes('launch.runId'))).toBe(true);
    expect(errors.some((entry) => entry.includes('launch.exitReason'))).toBe(true);
    expect(errors.some((entry) => entry.includes('launch.logUrl'))).toBe(true);
    expect(errors.some((entry) => entry.includes('launch.repo'))).toBe(true);
  });

  it('пустой logUrl — законный ответ «лог не опубликован», а не расхождение с контрактом (#133)', () => {
    // Боевой воркер отвечает `logUrl: ''` на отменённый ран и на любой отказ до загрузки
    // лога. Раньше `checkString` отвергал такой результат, и отмена доходила до клиента
    // как failed + WORKER_PROTOCOL_INVALID + worker_crash, неповторяемый отказ.
    for (const exitReason of ['cancelled', 'startup_failure'] as const) {
      const validated = validateLaunchResult(launchResult({ exitCode: null, exitReason, logUrl: '' }), 'run-1');
      expect(validated.ok, `${exitReason}: ${validated.ok ? '' : validated.errors.join('; ')}`).toBe(true);
    }
    // Непустая ссылка по-прежнему принимается и остаётся ссылкой воркера.
    const withUrl = validateLaunchResult(launchResult({ logUrl: 'https://storage.googleapis.com/b/run-1.log' }), 'run-1');
    expect(withUrl.ok).toBe(true);
    // Ключ обязателен: нет ключа — расхождение с контрактом, даже если значение пустое.
    const { logUrl: _logUrl, ...withoutKey } = launchResult({ logUrl: '' });
    const missing = validateLaunchResult(withoutKey, 'run-1');
    expect(missing.ok).toBe(false);
    expect(missing.ok ? [] : missing.errors.some((entry) => entry.includes('logUrl'))).toBe(true);
    // Не строка — тоже отказ: пустую строку вправе прислать только воркер.
    for (const bad of [null, undefined, 42]) {
      expect(validateLaunchResult(launchResult({ logUrl: bad as unknown as string }), 'run-1').ok).toBe(false);
    }
  });
});

describe('маппинг LaunchResult → RunResult + RunnerEvent (epic #74, шаг 2)', () => {
  it('успешный ран: outcome succeeded, outputRefs — ссылки на GitHub, logPath — ссылка на GCS', () => {
    const spec = makeRunSpec({ runId: 'run-1', jobId: 'job-1' });
    const admission = admissionEvents(spec, TIMES.startedAt);
    const mapping = mapLaunchResult(spec, launchResult(), TIMES, { workerBaseUrl: 'https://worker.example' });

    expect(validateRunResult(mapping.result).ok).toBe(true);
    for (const event of admission) expect(validateRunnerEvent(event).ok).toBe(true);
    expect(admission.map((event) => event.type)).toEqual(['claimed', 'inputs_materialized']);
    expect(mapping.result.outcome).toBe('succeeded');
    expect(mapping.result.exitReason).toBe('completed');
    expect(mapping.result.logPath).toBe('https://storage.googleapis.com/agent-logs/runs/run-1/session.log');
    expect(mapping.result.outputRefs).toEqual(['https://github.com/owner/name/blob/abc1234/report.md']);
    expect(mapping.result.persistence).toBe('persisted');
    expect(mapping.result.cleanup).toBe('completed');
    expect(mapping.result.cleanupReason).toContain('external worker owns the workspace');
    expect(mapping.logUrl).toBe('https://storage.googleapis.com/agent-logs/runs/run-1/session.log');
    expect(mapping.repo).toEqual({ fullName: 'owner/name', branch: 'agent-run/run-1', commit: 'abc1234', baseRef: 'main' });
    for (const event of mapping.events) expect(validateRunnerEvent(event).ok).toBe(true);
    const types = mapping.events.map((event) => event.type);
    expect(types).toContain('started');
    expect(types).toContain('exit');
    expect(types).toContain('artifact_exported');
    expect(types[types.length - 1]).toBe('succeeded');
  });

  it('ненулевой код выхода: failed + AGENT_NONZERO_EXIT, событие failed последнее', () => {
    const spec = makeRunSpec({ runId: 'run-1' });
    const mapping = mapLaunchResult(spec, launchResult({ exitCode: 3, exitReason: 'nonzero_exit' }), TIMES);
    expect(mapping.result.outcome).toBe('failed');
    expect(mapping.result.failure?.code).toBe('AGENT_NONZERO_EXIT');
    expect(mapping.result.failure?.retryable).toBe(false);
    expect(mapping.events[mapping.events.length - 1]!.type).toBe('failed');
  });

  it('таймаут: failed + AGENT_TIMEOUT retryable', () => {
    const spec = makeRunSpec({ runId: 'run-1' });
    const mapping = mapLaunchResult(spec, launchResult({ exitCode: null, exitReason: 'timeout', timedOut: true }), TIMES);
    expect(mapping.result.failure).toEqual({
      code: 'AGENT_TIMEOUT',
      failureClass: 'engine',
      safeSummary: 'agent was killed by the worker timeout',
      retryable: true,
    });
  });

  it('отмена воркером: outcome cancelled, exitObserved=false', () => {
    const spec = makeRunSpec({ runId: 'run-1' });
    const mapping = mapLaunchResult(spec, launchResult({ exitCode: null, exitReason: 'cancelled' }), TIMES);
    expect(mapping.result.outcome).toBe('cancelled');
    expect(mapping.result.exitObserved).toBe(false);
    expect(mapping.result.failure).toBeUndefined();
    expect(mapping.events[mapping.events.length - 1]!.type).toBe('cancelled');
  });

  it('отменённый ран без лога: cancelled, без отказа, logPath — адрес рана у воркера (#133)', () => {
    // Боевой отчёт об отмене: джобу убили (SIGTERM) до загрузки лога, поэтому logUrl пуст.
    // Отчёт обязан дойти до клиента отменой, а logPath — остаться непустым (runLogRef).
    const spec = makeRunSpec({ runId: 'run-1', jobId: 'job-1' });
    const report = launchResult({
      status: 'failed',
      pid: null,
      exitCode: null,
      exitSignal: 'SIGTERM',
      exitReason: 'cancelled',
      answer: null,
      answerSource: null,
      artifacts: [],
      logUrl: '',
      repo: { fullName: 'owner/name', branch: 'agent-run/run-1', commit: '0000000000000000000000000000000000000000' },
    });
    const validated = validateLaunchResult(report, 'run-1');
    expect(validated.ok, validated.ok ? '' : validated.errors.join('; ')).toBe(true);

    const mapping = mapLaunchResult(spec, validated.ok ? validated.value : report, TIMES, { workerBaseUrl: 'https://worker.example' });
    expect(validateRunResult(mapping.result).ok).toBe(true);
    expect(mapping.result.outcome).toBe('cancelled');
    expect(mapping.result.exitReason).toBe('cancelled');
    expect(mapping.result.exitSignal).toBe('SIGTERM');
    expect(mapping.result.failure).toBeUndefined();
    expect(mapping.result.logPath).toBe('https://worker.example/v1/runs/run-1');
    // Лога нет — и в наружу это `null`, а не ссылка на пустое и не выдуманное событие.
    expect(mapping.logUrl).toBeNull();
    expect(mapping.events.some((event) => event.type === 'log' && String(event.payload['message']).includes('session log'))).toBe(false);
    for (const event of mapping.events) expect(validateRunnerEvent(event).ok).toBe(true);
    expect(mapping.events[mapping.events.length - 1]!.type).toBe('cancelled');
  });

  it('отказ до старта агента (startup_failure) с пустым logUrl доезжает своим кодом (#133)', () => {
    // Тот же дефект, что и у отмены: `emptyResult` в воркере всегда ставит logUrl: ''.
    // Раньше реальная причина отказа терялась под WORKER_PROTOCOL_INVALID + worker_crash.
    const spec = makeRunSpec({ runId: 'run-1' });
    const report = launchResult({
      status: 'failed',
      pid: null,
      exitCode: null,
      exitReason: 'startup_failure',
      artifacts: [],
      logUrl: '',
      failure: { code: 'WORKSPACE_CLONE_FAILED', failureClass: 'runtime', safeSummary: 'could not clone the repository', retryable: true },
    });
    const validated = validateLaunchResult(report, 'run-1');
    expect(validated.ok, validated.ok ? '' : validated.errors.join('; ')).toBe(true);

    const mapping = mapLaunchResult(spec, validated.ok ? validated.value : report, TIMES, { workerBaseUrl: 'https://worker.example' });
    expect(validateRunResult(mapping.result).ok).toBe(true);
    expect(mapping.result.outcome).toBe('failed');
    expect(mapping.result.exitReason).toBe('startup_failure');
    expect(mapping.result.failure?.code).toBe('WORKSPACE_CLONE_FAILED');
    expect(mapping.result.logPath).toBe('https://worker.example/v1/runs/run-1');
  });

  it('код отказа воркера переносится в RunFailure без потерь', () => {
    const spec = makeRunSpec({ runId: 'run-1' });
    const mapping = mapLaunchResult(
      spec,
      launchResult({
        status: 'failed',
        exitCode: null,
        exitReason: 'preflight_refused',
        artifacts: [],
        failure: { code: 'ISOLATION_UNSUPPORTED', failureClass: 'preflight', safeSummary: 'worker refuses per_run_unix_identity', retryable: false },
      }),
      TIMES,
    );
    expect(mapping.result.failure).toEqual({
      code: 'ISOLATION_UNSUPPORTED',
      failureClass: 'preflight',
      safeSummary: 'worker refuses per_run_unix_identity',
      retryable: false,
    });
  });

  it('ответ воркера без артефактов = not_required, а не «сохранено»', () => {
    const spec = makeRunSpec({ runId: 'run-1' });
    const mapping = mapLaunchResult(spec, launchResult({ artifacts: [] }), TIMES);
    expect(mapping.result.persistence).toBe('not_required');
    expect(mapping.result.outputRefs).toEqual([]);
  });

  it('доступный секрет в stdout не попадает в событие рана', () => {
    const spec = makeRunSpec({ runId: 'run-1' });
    const mapping = mapLaunchResult(spec, launchResult({ stdout: 'using token: ghp_abcdefghijklmnopqrstuvwxyz012345' }), TIMES);
    expect(JSON.stringify(mapping.events)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
  });

  it('многострочный вывод агента даёт событие, которое принимает общий валидатор RunnerEvent', () => {
    const spec = makeRunSpec({ runId: 'run-1' });
    const multiline = `${'line of agent output\n'.repeat(4000)}tail`;
    const mapping = mapLaunchResult(spec, launchResult({ stdout: multiline, stderr: 'boom\r\nstack' }), TIMES);
    const log = mapping.events.filter((event) => event.type === 'log');
    expect(log.length).toBeGreaterThanOrEqual(2);
    for (const event of mapping.events) {
      const validated = validateRunnerEvent(event);
      expect(validated.ok, validated.ok ? '' : validated.errors.join('; ')).toBe(true);
    }
    const message = (log[0]!.payload as { message: string }).message;
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThanOrEqual(10_000);
    expect(message).toContain('[truncated]');
  });

  it('agent_exit_resolved соответствует объявленным полям события', () => {
    const spec = makeRunSpec({ runId: 'run-1', outputs: [{ path: 'report.md' }] });
    const mapping = mapLaunchResult(spec, launchResult({ answerSource: 'agent_file' }), TIMES);
    const resolved = mapping.events.find((event) => event.type === 'agent_exit_resolved');
    expect(resolved?.payload).toMatchObject({
      manifest: 'ok',
      declared: 1,
      fromManifest: 1,
      answerSource: 'agent_file',
      planned: 1,
    });
  });

  it('safeSummary воркера проходит тот же фильтр секретов, что и наши сообщения', () => {
    const spec = makeRunSpec({ runId: 'run-1' });
    const mapping = mapLaunchResult(
      spec,
      launchResult({
        status: 'failed',
        exitCode: null,
        exitReason: 'startup_failure',
        artifacts: [],
        failure: {
          code: 'WORKER_INTERNAL',
          failureClass: 'runtime',
          safeSummary: 'failed with token: ghp_abcdefghijklmnopqrstuvwxyz012345',
          retryable: true,
        },
      }),
      TIMES,
    );
    expect(JSON.stringify(mapping)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(mapping.result.failure?.safeSummary).toContain('[redacted]');
  });
});

describe('отказ воркера на уровне транспорта', () => {
  it('ран всё равно финализируется: worker_crash + WORKER_UNREACHABLE, logPath — URL рана воркера', () => {
    const spec = makeRunSpec({ runId: 'run-1' });
    const mapping = workerTransportFailure(spec, new Error('connect ECONNREFUSED 10.0.0.5:8080'), TIMES, {
      workerBaseUrl: 'https://worker.example/',
    });
    expect(validateRunResult(mapping.result).ok).toBe(true);
    expect(mapping.result.outcome).toBe('failed');
    expect(mapping.result.exitReason).toBe('worker_crash');
    expect(mapping.result.failure?.code).toBe('WORKER_UNREACHABLE');
    expect(mapping.result.failure?.retryable).toBe(true);
    expect(mapping.result.logPath).toBe('https://worker.example/v1/runs/run-1');
    expect(mapping.artifacts).toEqual([]);
    expect(mapping.events[mapping.events.length - 1]!.type).toBe('failed');
  });
});

describe('runLogRef и artifactUrl', () => {
  it('logUrl воркера приоритетнее URL самого рана', () => {
    expect(runLogRef(launchResult(), 'https://worker.example', 'run-1')).toBe(
      'https://storage.googleapis.com/agent-logs/runs/run-1/session.log',
    );
    expect(runLogRef(null, 'https://worker.example/', 'run-1')).toBe('https://worker.example/v1/runs/run-1');
    expect(runLogRef(null, null, 'run-1')).toBe('worker://unconfigured/v1/runs/run-1');
  });

  it('пустой logUrl даёт тот же непустой logPath, что и отсутствие результата (#133)', () => {
    // `RunResult.logPath` обязан быть непустой строкой, иначе результат рана невалиден.
    expect(runLogRef(launchResult({ logUrl: '' }), 'https://worker.example/', 'run-1')).toBe(
      'https://worker.example/v1/runs/run-1',
    );
    expect(runLogRef(launchResult({ logUrl: '' }), null, 'run-1')).toBe('worker://unconfigured/v1/runs/run-1');
    expect(isRetrievableLogUrl('')).toBe(false);
  });

  it('артефакт адресуется коммитом, ветка рана — страницей, результат — ссылкой на merge', () => {
    const repo = { fullName: 'owner/name', branch: 'agent-run/run-1', commit: 'abc1234', baseRef: 'main' };
    expect(artifactUrl(repo, 'docs/report.md')).toBe('https://github.com/owner/name/blob/abc1234/docs/report.md');
    expect(branchUrl(repo)).toBe('https://github.com/owner/name/tree/agent-run/run-1');
    expect(mergeUrl(repo)).toBe('https://github.com/owner/name/compare/main...agent-run/run-1');
  });

  it('без известной базы отдаём страницу ветки, а не выдуманный compare', () => {
    const repo = { fullName: 'owner/name', branch: 'agent-run/run-1', commit: 'abc1234' };
    expect(mergeUrl(repo)).toBe(branchUrl(repo));
  });

  it('имя ветки рана выводится из runId и не путается с ветками юзера', () => {
    expect(runBranchName('run_abc')).toBe('agent-run/run_abc');
    expect(runBranchName('run_abc', 'bots')).toBe('bots/run_abc');
  });
});

describe('реальные расхождения с воркером на GitHub Actions', () => {
  // Эти три случая пришли с боевого воркера: локальные тесты их не видели, потому что
  // мок всегда отвечал «идеально». Агент в GHA живёт на другой машине и коммитит не всегда.

  it('pid не обязателен: агент в GHA запущен на другой машине, локального PID нет', () => {
    const spec = makeRunSpec({ runId: 'run-1' });
    const result = launchResult();
    delete (result as { pid?: unknown }).pid;
    const validated = validateLaunchResult(result, 'run-1');
    expect(validated.ok, validated.ok ? '' : validated.errors.join('; ')).toBe(true);
    // И `started`-событие без pid не выдумывается: pid нет — значит и утверждать нечего.
    const mapping = mapLaunchResult(spec, validated.ok ? validated.value : result, TIMES);
    expect(mapping.events.some((event) => event.type === 'started')).toBe(false);
  });

  it('repo.commit = null (ничего не запушено) — это не отказ, а ран без выходов', () => {
    const spec = makeRunSpec({ runId: 'run-1', outputs: [] });
    const result = launchResult({ artifacts: [], repo: { fullName: 'owner/name', branch: 'agent-run/run-1', commit: null } });
    const validated = validateLaunchResult(result, 'run-1');
    expect(validated.ok, validated.ok ? '' : validated.errors.join('; ')).toBe(true);

    const mapping = mapLaunchResult(spec, validated.ok ? validated.value : result, TIMES);
    expect(mapping.result.outcome).toBe('succeeded');
    // Ссылка на файл не может быть `/blob/null/…` — она адресует ветку, а не коммит.
    const repo = { fullName: 'owner/name', branch: 'agent-run/run-1', commit: null };
    expect(repoHasCommit(repo)).toBe(false);
    expect(artifactUrl(repo, 'report.md')).toBe('https://github.com/owner/name/tree/agent-run/run-1/report.md');
    // И сравнивать нечего: merge ведёт на страницу ветки, а не в пустой compare.
    expect(mergeUrl({ ...repo, baseRef: 'main' })).toBe('https://github.com/owner/name/tree/agent-run/run-1');
  });

  it('null-SHA тоже означает «ничего не запушено», а не валидный коммит', () => {
    const zero = { fullName: 'owner/name', branch: 'agent-run/run-1', commit: '0000000000000000000000000000000000000000' };
    expect(repoHasCommit(zero)).toBe(false);
    expect(artifactUrl(zero, 'a.md')).toContain('/tree/agent-run/run-1/a.md');
    const real = { fullName: 'owner/name', branch: 'agent-run/run-1', commit: 'abc1234' };
    expect(repoHasCommit(real)).toBe(true);
    expect(artifactUrl(real, 'a.md')).toBe('https://github.com/owner/name/blob/abc1234/a.md');
  });

  it('logUrl со схемой local:// не превращается в битый редирект', () => {
    // Воркер без бакета держит лог у себя и отдаёт `local://…`: это честный ответ, но не URL.
    expect(isRetrievableLogUrl('local://run-1/session.log')).toBe(false);
    expect(isRetrievableLogUrl('https://storage.googleapis.com/b/runs/1/session.log')).toBe(true);
  });
});

describe('ExternalWorkerAdapter по HTTP', () => {
  it('launch возвращает квитанцию сразу: runId, operationId и адреса status/result', async () => {
    const worker = await startMockWorker();
    try {
      const adapter = new ExternalWorkerAdapter({
        baseUrl: worker.baseUrl,
        token: 'shared-secret',
        deadlineMs: 5000,
        baseUrlForResult: 'https://api.test',
      });
      const spec = makeRunSpec({ runId: 'run-http-1', input: { inlinePrompt: 'сделай отчёт' }, repository: { fullName: 'owner/name' } });
      const receipt = await adapter.launch(spec);

      expect(worker.launches).toHaveLength(1);
      expect(worker.lastAuthorization()).toBe('Bearer shared-secret');
      // Никакого LaunchResult: соединение закрылось, ран ещё не отработал.
      expect(receipt.runId).toBe('run-http-1');
      expect(receipt.status).toBe('accepted');
      expect(receipt.operationId).toBe(spec.operationId);
      expect(receipt.statusUrl).toContain('/v1/runs/run-http-1/status');
      // Адрес возврата результата уходит в запросе — воркеру не нужно знать, где мы.
      expect(worker.launches[0]!['resultUrl']).toBe('https://api.test/v1/worker/launches/run-http-1/result');
    } finally {
      await worker.close();
    }
  });

  it('status и result читаются отдельными вызовами; до готовности result — ResultNotReadyError', async () => {
    const worker = await startMockWorker({ terminalStatus: 'running' });
    try {
      const adapter = adapterFor(worker);
      const spec = makeRunSpec({ runId: 'run-http-poll', input: { inlinePrompt: 'x' } });
      const receipt = await adapter.launch(spec);

      expect((await adapter.status(receipt.runId)).status).toBe('running');
      // Ран ещё идёт: результата нет, и это не ошибка, а «не готов».
      await expect(adapter.result(receipt.runId)).rejects.toMatchObject({ code: 'RESULT_NOT_READY' });
    } finally {
      await worker.close();
    }
  });

  it('result отдаёт LaunchResult, когда ран терминальный', async () => {
    const worker = await startMockWorker();
    try {
      const adapter = adapterFor(worker);
      const receipt = await adapter.launch(makeRunSpec({ runId: 'run-http-done', input: { inlinePrompt: 'x' } }));
      const result = await adapter.result(receipt.runId);
      expect(result.exitReason).toBe('completed');
      expect(result.repo.fullName).toBe('owner/name');
    } finally {
      await worker.close();
    }
  });

  it('статус unknown у воркера — исход неизвестен, а не failed', async () => {
    const worker = await startMockWorker({ registerAfterMs: 60_000 });
    try {
      const adapter = adapterFor(worker);
      const receipt = await adapter.launch(makeRunSpec({ runId: 'run-http-unknown', input: { inlinePrompt: 'x' } }));
      expect((await adapter.status(receipt.runId)).status).toBe('unknown');
    } finally {
      await worker.close();
    }
  });

  it('cancel ходит на POST /v1/runs/{runId}/cancel', async () => {
    const worker = await startMockWorker();
    try {
      const adapter = adapterFor(worker);
      await adapter.launch(makeRunSpec({ runId: 'run-http-2', input: { inlinePrompt: 'сделай отчёт' } }));
      const receipt = await adapter.cancel('run-http-2');
      expect(receipt.status).toBe('cancelled');
      expect(worker.cancels).toEqual(['run-http-2']);
    } finally {
      await worker.close();
    }
  });

  it('отмена неизвестного рана = unknown_run, а не молчание', async () => {
    const worker = await startMockWorker();
    try {
      const receipt = await adapterFor(worker).cancel('run-never-launched');
      expect(receipt.status).toBe('unknown_run');
    } finally {
      await worker.close();
    }
  });

  it('результат отменённого рана по HTTP читается, а не отвергается контрактом (#133)', async () => {
    // Мок повторяет боевого воркера: у отменённого рана лога нет, `logUrl` пуст. До #133
    // такой ответ падал в WORKER_PROTOCOL_INVALID — и отмена выглядела как отказ воркера.
    const worker = await startMockWorker();
    try {
      const adapter = adapterFor(worker);
      const receipt = await adapter.launch(makeRunSpec({ runId: 'run-http-cancelled', input: { inlinePrompt: 'x' } }));
      await adapter.cancel(receipt.runId);
      expect((await adapter.status(receipt.runId)).status).toBe('cancelled');

      const result = await adapter.result(receipt.runId);
      expect(result.exitReason).toBe('cancelled');
      expect(result.logUrl).toBe('');
      const spec = makeRunSpec({ runId: 'run-http-cancelled', input: { inlinePrompt: 'x' } });
      const mapping = mapLaunchResult(spec, result, TIMES, { workerBaseUrl: worker.baseUrl });
      expect(mapping.result.outcome).toBe('cancelled');
      expect(mapping.result.logPath).toBe(`${worker.baseUrl}/v1/runs/run-http-cancelled`);
    } finally {
      await worker.close();
    }
  });

  it('HTTP-ошибка воркера — WORKER_HTTP_ERROR, тело не теряется молча', async () => {
    const worker = await startMockWorker({ httpStatus: 503 });
    try {
      await expect(adapterFor(worker).launch(makeRunSpec({ runId: 'run-http-3', input: { inlinePrompt: 'сделай отчёт' } }))).rejects.toMatchObject({
        code: 'WORKER_HTTP_ERROR',
      });
    } finally {
      await worker.close();
    }
  });

  it('structured unsupported-workspace refusal is a definitive no-start and can advance the engine chain', async () => {
    const worker = await startMockWorker({ httpStatus: 501, admissionRefusal: 'WORKER_PROFILE_WORKSPACE_UNSUPPORTED' });
    try {
      await expect(adapterFor(worker).launch(makeRunSpec({ runId: 'run-profile-refused', input: { inlinePrompt: 'run' } })))
        .rejects.toMatchObject({ code: 'WORKER_PROFILE_WORKSPACE_UNSUPPORTED', retryable: true });
    } finally {
      await worker.close();
    }
  });

  it('тело вне контракта — WORKER_PROTOCOL_INVALID, а не «успешный» ран', async () => {
    const worker = await startMockWorker({ malformed: true });
    try {
      await expect(adapterFor(worker).launch(makeRunSpec({ runId: 'run-http-4', input: { inlinePrompt: 'сделай отчёт' } }))).rejects.toMatchObject({
        code: 'WORKER_PROTOCOL_INVALID',
      });
    } finally {
      await worker.close();
    }
  });

  it('таймаут launch обрывает HTTP-запрос: воркер не принял задачу, повтор безопасен', async () => {
    const worker = await startMockWorker({ delayMs: 3000 });
    try {
      const adapter = adapterFor(worker, { deadlineMs: 150 });
      await expect(adapter.launch(makeRunSpec({ runId: 'run-http-timeout', input: { inlinePrompt: 'x' } }))).rejects.toMatchObject({
        code: 'WORKER_LAUNCH_UNREACHABLE',
        // Ран не принят — никто его не выполняет, поэтому повтор не создаст второй.
        retryable: true,
      });
      // Отменять нечего: задача не дошла до воркера, и осиротевшего рана нет.
      expect(worker.cancels).not.toContain('run-http-timeout');
    } finally {
      await worker.close();
    }
  }, 20000);

  it('ответ воркера вне контракта и его тело ошибки не теряются и не текут секретами', async () => {
    const worker = await startMockWorker({ httpStatus: 500 });
    const logs: Record<string, unknown>[] = [];
    try {
      const adapter = new ExternalWorkerAdapter({
        baseUrl: worker.baseUrl,
        baseUrlForResult: 'https://api.test',
        deadlineMs: 5000,
        log: (entry) => logs.push(entry),
      });
      await expect(adapter.launch(makeRunSpec({ runId: 'run-http-err', input: { inlinePrompt: 'x' } }))).rejects.toMatchObject({
        code: 'WORKER_HTTP_ERROR',
      });
      const entry = logs.find((item) => item['event'] === 'worker_launch_http_error');
      expect(entry?.['status']).toBe(500);
      expect(entry?.['detail']).toContain('worker is unhappy');
    } finally {
      await worker.close();
    }
  });

  it('хостовый env-пул доходит до воркера только через envAllowlist', async () => {
    const worker = await startMockWorker();
    try {
      const adapter = adapterFor(worker, { env: { PATH: '/usr/bin', TOKEN_X: 'ghp_abcdefghijklmnopqrstuvwxyz012345' } });
      await adapter.launch(makeRunSpec({ runId: 'run-http-env', envAllowlist: ['PATH'], input: { inlinePrompt: 'x' } }));
      expect(worker.launches[0]!['env']).toEqual({ PATH: '/usr/bin' });
    } finally {
      await worker.close();
    }
  });

  it('без адреса воркера — WORKER_NOT_CONFIGURED до сетевого вызова', async () => {
    const adapter = new ExternalWorkerAdapter({ baseUrl: '' });
    expect(adapter.baseUrl).toBe('');
    await expect(adapter.launch(makeRunSpec({ runId: 'run-http-5', input: { inlinePrompt: 'сделай отчёт' } }))).rejects.toMatchObject({
      code: 'WORKER_NOT_CONFIGURED',
    });
  });
});
