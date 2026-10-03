import { describe, expect, it } from 'vitest';
import {
  DATA_RESIDENCY_NONE,
  decidePlacement,
  allowedEnginesForRegion,
  providerOf,
  screenWorkers,
  validatePlacementPolicy,
  type PlacementPolicy,
} from '../src/release/placement.js';

const POLICY: PlacementPolicy = {
  schemaVersion: 1,
  policyId: 'p30-test',
  authority: 'sandbox_probe',
  decisionRef: 'https://github.com/trained-assist/trained-agent-architecture/issues/69 (симуляция P30, не утверждённая политика RU/EU)',
  engines: {
    fake: { allowedRegions: ['sandbox-ru', 'sandbox-eu'], explicitProfileRef: 'sandbox-free-profile' },
    opencode: {
      allowedRegions: ['sandbox-ru', 'sandbox-eu'],
      explicitProfileRef: 'sandbox-free-profile',
      providers: {
        'free-ladder': { allowedRegions: ['sandbox-ru', 'sandbox-eu'] },
        zen: { allowedRegions: ['sandbox-eu'] },
      },
    },
    claude: { allowedRegions: ['sandbox-eu'], explicitProfileRef: null },
    codex: { allowedRegions: ['sandbox-eu'], explicitProfileRef: null },
  },
  credentialScopes: {
    'llm:call': { regions: ['sandbox-eu'] },
    'sandbox:fixture': { regions: ['sandbox-ru', 'sandbox-eu'] },
  },
  dataResidency: { decided: false, decisionRef: null, regions: [] },
};

const RU = { workerId: 'sb-ru', region: 'sandbox-ru' };
const EU = { workerId: 'sb-eu', region: 'sandbox-eu' };

function refusalOf(decision: ReturnType<typeof decidePlacement>): { code: string; reason: string } {
  expect(decision.place).toBe(false);
  if (decision.place) throw new Error('expected a placement refusal');
  return { code: decision.code, reason: decision.reason };
}

describe('политика размещения: валидация fail-closed', () => {
  it('принимает корректную политику и отвергает мягкие варианты', () => {
    expect(validatePlacementPolicy(POLICY).ok).toBe(true);

    const emptyRegions = validatePlacementPolicy({ ...POLICY, engines: { fake: { allowedRegions: [], explicitProfileRef: 'p' } } });
    expect(emptyRegions.ok).toBe(false);
    if (!emptyRegions.ok) expect(emptyRegions.errors.join('; ')).toMatch(/at least one region/);

    const noEngines = validatePlacementPolicy({ ...POLICY, engines: {} });
    expect(noEngines.ok).toBe(false);

    const ownerWithoutRef = validatePlacementPolicy({ ...POLICY, authority: 'owner_decision', decisionRef: null });
    expect(ownerWithoutRef.ok).toBe(false);
    if (!ownerWithoutRef.ok) expect(ownerWithoutRef.errors.join('; ')).toMatch(/decisionRef/);

    // Резидентность не может быть «решена» симуляцией песочницы.
    const sandboxDecidesResidency = validatePlacementPolicy({
      ...POLICY,
      dataResidency: { decided: true, decisionRef: 'issue#1', regions: ['sandbox-eu'] },
    });
    expect(sandboxDecidesResidency.ok).toBe(false);
    if (!sandboxDecidesResidency.ok) expect(sandboxDecidesResidency.errors.join('; ')).toMatch(/owner_decision/);

    const decidedWithoutRef = validatePlacementPolicy({
      ...POLICY,
      authority: 'owner_decision',
      decisionRef: 'issue#1',
      dataResidency: { decided: true, decisionRef: null, regions: ['sandbox-eu'] },
    });
    expect(decidedWithoutRef.ok).toBe(false);
  });
});

describe('decidePlacement: регион × провайдер × credentials × резидентность', () => {
  it('OpenCode разрешён в обеих зонах, но провайдер решает отдельно', () => {
    expect(decidePlacement(POLICY, RU, { engineName: 'opencode', model: 'free-ladder/grok' }).place).toBe(true);
    expect(decidePlacement(POLICY, EU, { engineName: 'opencode', model: 'free-ladder/grok' }).place).toBe(true);
    expect(refusalOf(decidePlacement(POLICY, RU, { engineName: 'opencode', model: 'zen/grok' })).code).toBe('PROVIDER_REGION_FORBIDDEN');
    expect(decidePlacement(POLICY, EU, { engineName: 'opencode', model: 'zen/grok' }).place).toBe(true);
  });

  it('Claude и Codex не в RU; в EU — только с явным профилем', () => {
    expect(refusalOf(decidePlacement(POLICY, RU, { engineName: 'claude' })).code).toBe('REGION_ENGINE_FORBIDDEN');
    expect(refusalOf(decidePlacement(POLICY, RU, { engineName: 'codex' })).code).toBe('REGION_ENGINE_FORBIDDEN');
    expect(refusalOf(decidePlacement(POLICY, EU, { engineName: 'claude' })).code).toBe('REGION_EXPLICIT_PROFILE_REQUIRED');
    expect(refusalOf(decidePlacement(POLICY, EU, { engineName: 'codex' })).code).toBe('REGION_EXPLICIT_PROFILE_REQUIRED');
  });

  it('необъявленный движок и необъявленный провайдер не проходят «по умолчанию»', () => {
    expect(refusalOf(decidePlacement(POLICY, RU, { engineName: 'gemini' })).code).toBe('REGION_ENGINE_UNDECLARED');
    expect(refusalOf(decidePlacement(POLICY, RU, { engineName: 'opencode', model: 'mystery/model' })).code).toBe('PROVIDER_UNDECLARED');
    // Без модели нечего сопоставлять с картой провайдеров: запрос уходит дальше (paid/движок),
    // а не блокируется региональной политикой.
    expect(decidePlacement(POLICY, RU, { engineName: 'opencode' }).place).toBe(true);
  });

  it('credential scope проверяется по региону воркера', () => {
    expect(
      decidePlacement(POLICY, EU, { engineName: 'fake', credentialBindings: [{ ref: 'sb-llm', scope: 'llm:call' }] }).place,
    ).toBe(true);
    expect(
      refusalOf(decidePlacement(POLICY, RU, { engineName: 'fake', credentialBindings: [{ ref: 'sb-llm', scope: 'llm:call' }] })).code,
    ).toBe('CREDENTIAL_REGION_FORBIDDEN');
    expect(
      refusalOf(decidePlacement(POLICY, RU, { engineName: 'fake', credentialBindings: [{ ref: 'sb-x', scope: 'unknown:scope' }] })).code,
    ).toBe('CREDENTIAL_SCOPE_UNDECLARED');
  });

  it('резидентность данных не угадывается: без решения владельца — отказ', () => {
    expect(refusalOf(decidePlacement(POLICY, EU, { engineName: 'fake', regionConstraints: { dataResidency: 'sandbox-ru' } })).code).toBe(
      'DATA_RESIDENCY_UNDECIDED',
    );
    expect(
      decidePlacement(POLICY, EU, { engineName: 'fake', regionConstraints: { dataResidency: DATA_RESIDENCY_NONE } }).place,
    ).toBe(true);
    expect(decidePlacement(POLICY, EU, { engineName: 'fake' }).place).toBe(true);
  });

  it('regionConstraints рана проверяются на приёме, а не только в preflight', () => {
    expect(refusalOf(decidePlacement(POLICY, RU, { engineName: 'fake', regionConstraints: { allowedRegions: ['sandbox-eu'] } })).code).toBe(
      'REGION_NOT_ALLOWED',
    );
  });

  it('screenWorkers отбирает подходящих воркеров и называет причину отказа каждого', () => {
    const screened = screenWorkers(POLICY, [RU, { ...EU, draining: true }], { engineName: 'opencode', model: 'free-ladder/grok' });
    expect(screened.eligible).toEqual([{ workerId: 'sb-ru', region: 'sandbox-ru', provider: 'free-ladder' }]);
    expect(screened.rejected).toHaveLength(1);
    expect(screened.rejected[0]).toMatchObject({ workerId: 'sb-eu', code: 'WORKER_DRAINING' });
  });

  it('allowedEnginesForRegion — то, что Runner проверяет повторно', () => {
    expect(allowedEnginesForRegion(POLICY, 'sandbox-ru')).toEqual(['fake', 'opencode']);
    expect(allowedEnginesForRegion(POLICY, 'sandbox-eu')).toEqual(['fake', 'opencode']);
    const withProfile: PlacementPolicy = {
      ...POLICY,
      engines: { ...POLICY.engines, claude: { allowedRegions: ['sandbox-eu'], explicitProfileRef: 'owner-decision#1' } },
    };
    expect(allowedEnginesForRegion(withProfile, 'sandbox-eu')).toEqual(['claude', 'fake', 'opencode']);
  });
});

describe('providerOf', () => {
  it('берёт провайдера из модели', () => {
    expect(providerOf('zen/grok')).toBe('zen');
    expect(providerOf('anthropic/claude-x')).toBe('anthropic');
    expect(providerOf('free-ladder')).toBe('free-ladder');
    expect(providerOf(undefined)).toBeNull();
    expect(providerOf('   ')).toBeNull();
  });
});
