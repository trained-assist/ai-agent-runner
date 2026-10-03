import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cohortBucket, cohortDecision, cohortFromEnv, validateCohortPolicy } from '../src/release/cohort.js';
import { DispatchOwnerStore } from '../src/release/dispatch-owner.js';
import {
  isPaidProfile,
  releaseIdentity,
  ReleaseConfigError,
  releaseManifestFromEnv,
  validateReleaseManifest,
  type ReleaseManifest,
} from '../src/release/manifest.js';
import {
  checkPromotionBoundary,
  descriptorFromManifest,
  PromotionJournal,
  ReleaseStateController,
  readJournal,
} from '../src/release/promotion.js';
import { retentionHealth } from '../src/release/retention.js';

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const COMMIT = 'a'.repeat(40);

function manifestFixture(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    releaseId: 'r-2026-10-03.1',
    sourceCommit: COMMIT,
    configVersion: 7,
    builtAt: '2026-10-03T09:00:00.000Z',
    engines: ['fake'],
    paid: { engines: ['claude', 'codex'], allowed: false },
    bindings: [
      { name: 'AGENT_API_KEY_REGISTRY', required: true, source: 'env:/etc/agent-runner/agent-runner-api.env', owner: 'operator', rotatedAt: '2026-10-01T00:00:00.000Z' },
      { name: 'ARTIFACT_SHARE_SECRET', required: false, source: 'env:/etc/agent-runner/agent-runner-api.env', owner: 'operator' },
    ],
    retention: { mainEventsDays: 30, verboseLogsDays: 7 },
    host: {
      workerId: 'sb-eu-a',
      region: 'sandbox-eu',
      environment: 'sandbox',
      roles: { schedule: false, delivery: false },
      roots: { dataDir: '/var/lib/agent-runner-fleet/p29/worker-a', configDir: '/etc/agent-runner-fleet/p29/worker-a' },
      endpoint: { host: '127.0.0.1', port: 8788 },
      configVersion: 7,
    },
    ...over,
  };
}

describe('закреплённый релиз и конфиг (P29, AC-170)', () => {
  it('принимает корректный манифест и отдаёт идентичность без путей и секретов', () => {
    const result = validateReleaseManifest(manifestFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.releaseId).toBe('r-2026-10-03.1');
    expect(result.value.sourceCommit).toBe(COMMIT);
    expect(result.value.paid.allowed).toBe(false);
    expect(result.value.host.roles).toEqual({ schedule: false, delivery: false });

    const identity = releaseIdentity(result.value);
    expect(identity).toEqual({
      releaseId: 'r-2026-10-03.1',
      sourceCommit: COMMIT,
      configVersion: 7,
      workerId: 'sb-eu-a',
      region: 'sandbox-eu',
      environment: 'sandbox',
      paidProfilesAllowed: false,
    });
    expect(JSON.stringify(identity)).not.toMatch(/var\/lib|\/etc\//);
  });

  it('отклоняет незакреплённый sourceCommit, неизвестные поля и paid без решения владельца', () => {
    const unpinned = validateReleaseManifest(manifestFixture({ sourceCommit: 'main' }));
    expect(unpinned.ok).toBe(false);
    expect(unpinned.ok === false && unpinned.errors.join(' ')).toMatch(/pinned 40-hex source commit/);

    const unknown = validateReleaseManifest(manifestFixture({ paidFallback: true }));
    expect(unknown.ok === false && unknown.errors.join(' ')).toMatch(/unknown field "paidFallback"/);

    const paidWithoutDecision = validateReleaseManifest(manifestFixture({ paid: { engines: ['claude'], allowed: true } }));
    expect(paidWithoutDecision.ok === false && paidWithoutDecision.errors.join(' ')).toMatch(/approvedBy/);

    const paidWithDecision = validateReleaseManifest(manifestFixture({ paid: { engines: ['claude'], allowed: true, approvedBy: 'arch#23' } }));
    expect(paidWithDecision.ok).toBe(true);
  });

  it('платный профиль — это и объявленный, и любой незаявленный движок; бесплатный берётся из allowlist', () => {
    const manifest = validateReleaseManifest(manifestFixture());
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(isPaidProfile(manifest.value, 'fake')).toBe(false);
    expect(isPaidProfile(manifest.value, 'claude')).toBe(true);
    // Забытый движок не проходит молча как бесплатный.
    expect(isPaidProfile(manifest.value, 'opencode')).toBe(true);
  });

  it('без манифеста и без обязательного binding старт падает внятно, значения секретов в ошибке нет', () => {
    expect(() => releaseManifestFromEnv({})).toThrow(ReleaseConfigError);
    try {
      releaseManifestFromEnv({});
      throw new Error('expected ReleaseConfigError');
    } catch (err) {
      expect((err as ReleaseConfigError).code).toBe('RELEASE_MANIFEST_MISSING');
    }

    const dir = tempDir('ai-agent-runner-release-');
    const path = join(dir, 'release.json');
    writeFileSync(path, JSON.stringify(manifestFixture()), { mode: 0o600 });
    try {
      releaseManifestFromEnv({ AGENT_API_RELEASE_MANIFEST: path });
      throw new Error('expected RELEASE_BINDING_MISSING');
    } catch (err) {
      const configError = err as ReleaseConfigError;
      expect(configError.code).toBe('RELEASE_BINDING_MISSING');
      expect(configError.errors[0]).toMatch(/AGENT_API_KEY_REGISTRY/);
      expect(configError.message).not.toMatch(/ak_[0-9a-f]{6}/);
    }

    const manifest = releaseManifestFromEnv({
      AGENT_API_RELEASE_MANIFEST: path,
      AGENT_API_KEY_REGISTRY: join(dir, 'key-registry.json'),
    });
    expect(manifest.releaseId).toBe('r-2026-10-03.1');
  });

  it('env-манифест с неизвестным полем даёт RELEASE_MANIFEST_INVALID, а не тихий дефолт', () => {
    const dir = tempDir('ai-agent-runner-release-bad-');
    const path = join(dir, 'release.json');
    writeFileSync(path, JSON.stringify(manifestFixture({ telemetryEndpoint: 'https://example.invalid' })), { mode: 0o600 });
    try {
      releaseManifestFromEnv({ AGENT_API_RELEASE_MANIFEST: path });
      throw new Error('expected RELEASE_MANIFEST_INVALID');
    } catch (err) {
      expect((err as ReleaseConfigError).code).toBe('RELEASE_MANIFEST_INVALID');
      expect((err as ReleaseConfigError).errors.join(' ')).toMatch(/unknown field "telemetryEndpoint"/);
    }
  });
});

describe('флаг когорты', () => {
  it('off не пускает никого, allowlist пускает только список, процент детерминирован', () => {
    const off = validateCohortPolicy({ cohortId: 'off', mode: 'off' });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(cohortDecision(off.value, 'p-alpha')).toMatchObject({ inCohort: false, reason: 'cohort_off' });

    const allowlist = validateCohortPolicy({ cohortId: 'c1', mode: 'allowlist', principals: ['p-alpha'] });
    expect(allowlist.ok).toBe(true);
    if (!allowlist.ok) return;
    expect(cohortDecision(allowlist.value, 'p-alpha').reason).toBe('allowlisted');
    expect(cohortDecision(allowlist.value, 'p-beta')).toMatchObject({ inCohort: false, reason: 'outside_allowlist' });

    const rollout = validateCohortPolicy({ cohortId: 'c2', mode: 'percentage', rolloutPercent: 50 });
    expect(rollout.ok).toBe(true);
    if (!rollout.ok) return;
    const first = cohortDecision(rollout.value, 'p-alpha');
    const again = cohortDecision(rollout.value, 'p-alpha');
    expect(again.bucket).toBe(first.bucket);
    expect(again.inCohort).toBe(first.inCohort);
    expect(cohortBucket('c2', 'p-alpha')).toBe(first.bucket);
    // Другая когорта — другое решение: состав когорты не «переезжает» молча.
    expect(cohortBucket('c3', 'p-alpha')).not.toBe(first.bucket);

    const outside = Array.from({ length: 200 }, (_, index) => `p-${index}`).filter(
      (principalId) => !cohortDecision(rollout.value, principalId).inCohort,
    );
    expect(outside.length).toBeGreaterThan(50);
  });

  it('пустой allowlist и нулевой процент — ошибка конфигурации, а не «никого не пускаем молча»', () => {
    expect(validateCohortPolicy({ cohortId: 'c', mode: 'allowlist', principals: [] }).ok).toBe(false);
    expect(validateCohortPolicy({ cohortId: 'c', mode: 'percentage', rolloutPercent: 0 }).ok).toBe(false);
    expect(validateCohortPolicy({ cohortId: 'c', mode: 'unknown' }).ok).toBe(false);
  });

  it('cohortFromEnv: без переменных когорта выключена, режим из env разбирается', () => {
    expect(cohortFromEnv({})).toEqual({ cohortId: 'off', mode: 'off', principals: [], rolloutPercent: 0 });
    expect(cohortFromEnv({ AGENT_API_COHORT_ID: 'c-1', AGENT_API_COHORT_MODE: 'allowlist', AGENT_API_COHORT_PRINCIPALS: 'p-a, p-b' })).toEqual({
      cohortId: 'c-1',
      mode: 'allowlist',
      principals: ['p-a', 'p-b'],
      rolloutPercent: 0,
    });
    expect(() => cohortFromEnv({ AGENT_API_COHORT_ID: 'c', AGENT_API_COHORT_MODE: 'half' })).toThrow(/AGENT_API_COHORT_MODE/);
  });
});

describe('журнал промоушена и откат (P29, AC-324)', () => {
  it('откат переводит обслуживание на предыдущий релиз, resume возвращает свой, причины в журнале', () => {
    const dir = tempDir('ai-agent-runner-rollback-');
    const journalPath = join(dir, 'promotion.jsonl');
    const statePath = join(dir, 'release-state.json');
    const journal = new PromotionJournal({ path: journalPath, releaseId: 'r2', workerId: 'sb-eu-a', region: 'sandbox-eu' });

    const before = new ReleaseStateController({ path: statePath, releaseId: 'r2', previousReleaseId: 'r1', journal, cohortId: 'c1' });
    expect(before.paused).toBe(false);
    expect(before.snapshot()).toMatchObject({ releaseId: 'r2', servingReleaseId: 'r2', previousReleaseId: 'r1', rolledBack: false });

    const rolled = before.rollback('error rate on sandbox cohort', 'operator-1');
    expect(rolled).toMatchObject({ servingReleaseId: 'r1', previousReleaseId: 'r2', rolledBack: true, transitions: 1 });
    expect(before.paused).toBe(true);

    const resumed = before.resume('fix verified in sandbox', 'operator-1');
    expect(resumed).toMatchObject({ servingReleaseId: 'r2', previousReleaseId: 'r1', rolledBack: false, transitions: 2 });

    const entries = readJournal(journalPath);
    expect(entries.map((entry) => entry.kind)).toEqual(['rollback', 'rollback_resumed']);
    expect(entries[0]).toMatchObject({ seq: 1, workerId: 'sb-eu-a', region: 'sandbox-eu', cohortId: 'c1' });
    expect(entries[0]!.reason).toBe('error rate on sandbox cohort');
    expect(entries[0]!.detail).toMatchObject({ newAdmissions: 'refused_promotion_paused', acceptedRuns: 'stay_with_current_owner' });
    expect(entries[1]!.detail).toMatchObject({ newAdmissions: 'accepted' });

    // Новый процесс читает то же состояние с диска: seq журнала продолжается, а не начинается заново.
    const afterRestart = new ReleaseStateController({ path: statePath, releaseId: 'r2', previousReleaseId: 'r1', journal });
    expect(afterRestart.paused).toBe(false);
    journal.append({ kind: 'promoted', reason: 'serving again', servingReleaseId: 'r2' });
    const entriesAfter = readJournal(journalPath);
    expect(entriesAfter[entriesAfter.length - 1]!.seq).toBe(3);
  });

  it('откат без предыдущего релиза и состояние чужого релиза — явные ошибки', () => {
    const dir = tempDir('ai-agent-runner-rollback-bad-');
    const statePath = join(dir, 'release-state.json');
    const controller = new ReleaseStateController({ path: statePath, releaseId: 'r2' });
    expect(() => controller.rollback('no fallback', 'operator')).toThrow(/nothing to fall back to/);

    writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, releaseId: 'r-other', servingReleaseId: 'r-other', previousReleaseId: null, rolledBack: false, reason: null, updatedAt: '2026-10-03T00:00:00.000Z', transitions: 0 }));
    expect(() => new ReleaseStateController({ path: statePath, releaseId: 'r2' })).toThrow(/release state belongs to r-other/);
  });

  it('журнал переживает повреждённую строку и не теряет нумерацию', () => {
    const dir = tempDir('ai-agent-runner-journal-');
    const path = join(dir, 'promotion.jsonl');
    const journal = new PromotionJournal({ path, releaseId: 'r1' });
    journal.append({ kind: 'promoted', reason: 'first' });
    writeFileSync(path, '{broken\n', { flag: 'a' });
    const reopened = new PromotionJournal({ path, releaseId: 'r1' });
    const record = reopened.append({ kind: 'promoted', reason: 'second' });
    expect(record.seq).toBe(2);
    expect(readJournal(path).map((entry) => entry.reason)).toEqual(['first', 'second']);
    expect(existsSync(path)).toBe(true);
  });

  it('два писателя в один журнал не выдают второй одинаковый seq (сервис воркера + операторский откат)', () => {
    const dir = tempDir('ai-agent-runner-journal-two-writers-');
    const path = join(dir, 'promotion.jsonl');
    // Сервис воркера поднят раньше оператора: его счётчик seq уже в памяти, когда оператор
    // дописывает откат, и сервис продолжает писать в тот же файл.
    const service = new PromotionJournal({ path, releaseId: 'r2', workerId: 'sb-eu-a' });
    const operator = new PromotionJournal({ path, releaseId: 'r2', workerId: 'sb-eu-a' });

    service.append({ kind: 'release_pinned', reason: 'worker started' });
    operator.append({ kind: 'rollback', reason: 'operator rollback', servingReleaseId: 'r1' });
    service.append({ kind: 'admission_refused', reason: 'promotion paused' });
    operator.append({ kind: 'rollback_resumed', reason: 'gate green', servingReleaseId: 'r2' });

    const entries = readJournal(path);
    expect(entries.map((entry) => entry.kind)).toEqual(['release_pinned', 'rollback', 'admission_refused', 'rollback_resumed']);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(new Set(entries.map((entry) => entry.seq)).size).toBe(entries.length);
  });
});

describe('граница промоушена (AC-171, AC-09)', () => {
  const sandbox: ReleaseManifest = validateReleaseManifest(manifestFixture()).ok
    ? (validateReleaseManifest(manifestFixture()) as { value: ReleaseManifest }).value
    : (undefined as never);

  function production(): ReturnType<typeof descriptorFromManifest> {
    return descriptorFromManifest(
      {
        host: {
          workerId: 'prod-primary',
          region: 'eu',
          environment: 'production',
          roles: { schedule: true, delivery: true },
          roots: { dataDir: '/var/lib/agent-runner', configDir: '/etc/agent-runner' },
          endpoint: { host: '0.0.0.0', port: 8787 },
        },
      },
      ['hash-prod-1'],
    );
  }

  it('песочница и прод не пересекаются по корням, ключам, endpoint и доставке', () => {
    const check = checkPromotionBoundary(descriptorFromManifest(sandbox, ['hash-sandbox-1']), production());
    expect(check.violations).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('совпадение ключа, вложенный корень, общий endpoint и две машины-доставщика — нарушения', () => {
    const check = checkPromotionBoundary(
      {
        environment: 'sandbox',
        workerId: 'prod-primary',
        dataRoot: '/var/lib/agent-runner',
        configDir: '/etc/agent-runner/extra',
        endpoint: { host: '0.0.0.0', port: 8787 },
        keyHashes: ['hash-prod-1'],
        ownsDelivery: true,
      },
      { ...production(), keyHashes: ['hash-prod-1'], dataRoot: '/var/lib/agent-runner/p29', configDir: '/etc/agent-runner' },
    );
    expect(check.ok).toBe(false);
    const rules = check.violations.map((violation) => violation.rule).sort();
    expect(rules).toEqual(['configDir', 'dataRoot', 'delivery', 'endpoint', 'keys', 'workerId']);
  });

  it('релиз, объявленный для песочницы, нельзя выдать за production без нового манифеста', () => {
    const check = checkPromotionBoundary(descriptorFromManifest(sandbox, ['hash-sandbox-1']), production());
    expect(check.violations).toEqual([]);
    // Прод-цель отличается окружением, поэтому тот же манифест в прод не годится: проверка
    // границы ловит это как «разные окружения», а «тот же манифест в прод» — как отсутствие
    // собственного манифеста прод-развёртывания.
    const sameManifestInProd = checkPromotionBoundary(descriptorFromManifest(sandbox, ['hash-sandbox-1']), {
      ...production(),
      environment: 'sandbox',
    });
    expect(sameManifestInProd.ok).toBe(false);
    expect(sameManifestInProd.violations[0]!.rule).toBe('environment');
  });
});

describe('реестр владельцев задач (два воркера на одной VM)', () => {
  function store(workerId: string, path: string): DispatchOwnerStore {
    return new DispatchOwnerStore({ path, workerId });
  }

  it('второй воркер не получает задачу, перехват только по явному сигналу, прежний fenced', () => {
    const dir = tempDir('ai-agent-runner-fleet-');
    const path = join(dir, 'owners.json');
    const a = store('sb-a', path);
    const b = store('sb-b', path);

    expect(a.claim('p-alpha', 'task-1', 'run-a1')).toMatchObject({ outcome: 'granted', generation: 1 });
    expect(a.claim('p-alpha', 'task-1', 'run-a1')).toMatchObject({ outcome: 'granted', generation: 1 });

    const held = b.claim('p-alpha', 'task-1', 'run-b1');
    expect(held).toMatchObject({ outcome: 'held_by_other', ownerWorkerId: 'sb-a', generation: 1 });

    // Молчание сети не повод для failover.
    expect(b.takeover('p-alpha', 'task-1', 'run-b1')).toMatchObject({ outcome: 'partition_is_not_failover', ownerWorkerId: 'sb-a' });
    expect(b.claim('p-alpha', 'task-1', 'run-b1')).toMatchObject({ outcome: 'held_by_other' });

    // Явный сигнал оператора: новое поколение, прежний владелец fenced.
    const failover = b.takeover('p-alpha', 'task-1', 'run-b1', { source: 'operator', reason: 'drain sb-a for the cohort switch' });
    expect(failover).toMatchObject({ outcome: 'granted', generation: 2, previousOwnerWorkerId: 'sb-a' });
    expect(a.checkOwner('p-alpha', 'task-1')).toMatchObject({ owner: false, outcome: { outcome: 'fenced', ownerWorkerId: 'sb-b', generation: 2 } });
    expect(a.claim('p-alpha', 'task-1', 'run-a2')).toMatchObject({ outcome: 'held_by_other', ownerWorkerId: 'sb-b' });
    expect(b.checkOwner('p-alpha', 'task-1')).toMatchObject({ owner: true });
  });

  it('прежний владелец отдаёт задачу сам — это сигнал; новая попытка того же владельца растит поколение', () => {
    const dir = tempDir('ai-agent-runner-fleet-b-');
    const path = join(dir, 'owners.json');
    const a = store('sb-a', path);
    const b = store('sb-b', path);

    a.claim('p-alpha', 'task-2', 'run-a1');
    a.release('p-alpha', 'task-2', 'worker drained before the rollout');
    expect(b.claim('p-alpha', 'task-2', 'run-b1')).toMatchObject({ outcome: 'granted', generation: 2, previousOwnerWorkerId: 'sb-a' });
    // Новая попытка на том же воркере: тот же userTaskId, новый runId, поколение +1.
    expect(b.claim('p-alpha', 'task-2', 'run-b2')).toMatchObject({ outcome: 'granted', generation: 3 });
  });

  it('drain: воркер не берёт новых задач, свои доигрывает; попытка без владельца и терминальная — отказ', () => {
    const dir = tempDir('ai-agent-runner-fleet-c-');
    const path = join(dir, 'owners.json');
    const a = store('sb-a', path);
    const b = store('sb-b', path);

    a.claim('p-alpha', 'task-3', 'run-a1');
    a.drain('promotion: worker sb-a leaves the cohort');
    expect(a.isDraining()).toBe(true);
    expect(a.claim('p-beta', 'task-4', 'run-a2')).toMatchObject({ outcome: 'draining' });
    expect(a.checkOwner('p-alpha', 'task-3').owner).toBe(true);
    expect(a.view()).toMatchObject({ workerId: 'sb-a', draining: true, drainingTasks: 1 });

    expect(b.takeover('p-alpha', 'unknown-task', 'run-b1')).toMatchObject({ outcome: 'unknown_task' });
    b.markTerminal('p-alpha', 'task-3', 'run finished on sb-a');
    expect(b.takeover('p-alpha', 'task-3', 'run-b1', { source: 'operator', reason: 'late switch' })).toMatchObject({ outcome: 'already_terminal' });
  });
});

describe('retention логов (ускоренный clock)', () => {
  it('терминальные раны старше TTL попадают в кандидаты, живые — в защищённые', () => {
    const now = new Date('2026-10-03T12:00:00.000Z');
    const health = retentionHealth({
      policy: { mainEventsDays: 30, verboseLogsDays: 7 },
      now,
      runs: [
        { runId: 'run-old', state: 'succeeded', updatedAt: '2026-09-01T00:00:00.000Z' },
        { runId: 'run-mid', state: 'failed', updatedAt: '2026-09-20T00:00:00.000Z' },
        { runId: 'run-live', state: 'running', updatedAt: '2026-09-01T00:00:00.000Z' },
        { runId: 'run-queued', state: 'queued', updatedAt: '2026-09-01T00:00:00.000Z' },
      ],
    });

    expect(health.expiredRuns).toEqual(['run-old']);
    expect(health.verboseExpiredRuns).toEqual(['run-mid', 'run-old']);
    expect(health.protectedActiveRuns).toEqual(['run-live', 'run-queued']);
    expect(health).toMatchObject({ total: 4, active: 2, terminal: 2, removalPerformed: false, verdict: 'attention' });
    // Кандидат на очистку никогда не пересекается с живым раном.
    expect(health.expiredRuns.filter((runId) => health.protectedActiveRuns.includes(runId))).toEqual([]);
  });
});