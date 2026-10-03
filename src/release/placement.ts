import {
  ErrorCollector,
  checkArray,
  checkKeys,
  checkObject,
  checkString,
  isRecord,
  type ValidationResult,
} from '../contracts/validate.js';

export const PLACEMENT_POLICY_SCHEMA_VERSION = 1 as const;

/**
 * Кто утвердил политику размещения. `sandbox_probe` — симуляция на песочнице, такой документ
 * нельзя выдать за утверждённую региональную политику RU/EU; `owner_decision` — решение
 * владельца, и тогда обязательна ссылка на него.
 */
export const PLACEMENT_AUTHORITIES = ['sandbox_probe', 'owner_decision'] as const;

export type PlacementAuthority = (typeof PLACEMENT_AUTHORITIES)[number];

/** Явное «резидентность данных не объявлена»: обычное требование к ранy отсутствует. */
export const DATA_RESIDENCY_NONE = 'none';

const REGION_ID = /^[a-z0-9][a-z0-9-]{0,49}$/;

export interface PlacementProviderRule {
  allowedRegions: string[];
}

export interface PlacementEngineRule {
  allowedRegions: string[];
  /**
   * Ссылка на разрешённый explicit profile. Пока её нет, движок в этом регионе не
   * запускается — «разрешён по умолчанию» здесь означало бы тихое разрешение Claude/Codex
   * в RU, чего приёмка P30 прямо запрещает.
   */
  explicitProfileRef: string | null;
  /** Ограничения провайдера/модели внутри движка (OpenCode: разные провайдеры — разные зоны). */
  providers?: Record<string, PlacementProviderRule>;
}

export interface PlacementCredentialRule {
  regions: string[];
}

/**
 * Резидентность данных (где могут лежать данные рана). Это решение владельца, и по умолчанию
 * оно НЕ принято: `decided: false` заставляет placement отказывать с DATA_RESIDENCY_UNDECIDED,
 * а не угадывать, где хранить. Утверждается отдельно от политики вычислений.
 */
export interface PlacementDataResidencyPolicy {
  decided: boolean;
  decisionRef: string | null;
  regions: string[];
}

export interface PlacementPolicy {
  schemaVersion: typeof PLACEMENT_POLICY_SCHEMA_VERSION;
  policyId: string;
  authority: PlacementAuthority;
  decisionRef: string | null;
  engines: Record<string, PlacementEngineRule>;
  credentialScopes: Record<string, PlacementCredentialRule>;
  dataResidency: PlacementDataResidencyPolicy;
}

export type PlacementRefusalCode =
  | 'REGION_ENGINE_UNDECLARED'
  | 'REGION_ENGINE_FORBIDDEN'
  | 'REGION_EXPLICIT_PROFILE_REQUIRED'
  | 'REGION_NOT_ALLOWED'
  | 'PROVIDER_UNDECLARED'
  | 'PROVIDER_REGION_FORBIDDEN'
  | 'CREDENTIAL_SCOPE_UNDECLARED'
  | 'CREDENTIAL_REGION_FORBIDDEN'
  | 'DATA_RESIDENCY_UNDECIDED'
  | 'DATA_RESIDENCY_FORBIDDEN'
  | 'DATA_RESIDENCY_REGION_MISMATCH';

export interface PlacementSubject {
  engineName: string;
  /** `provider/model` или `model`; провайдер — первый сегмент. */
  model?: string;
  credentialBindings?: Array<{ ref: string; scope: string }>;
  regionConstraints?: { allowedRegions?: string[]; dataResidency?: string };
}

export interface PlacementAcceptance {
  place: true;
  workerId: string;
  region: string;
  policyId: string;
  /** Провайдер (первый сегмент модели) либо null, если модель не объявлена. */
  provider: string | null;
  /** Почему placement разрешён — те же строки, что попадают в лог и в ответ. */
  reasons: string[];
}

export interface PlacementRefusal {
  place: false;
  code: PlacementRefusalCode;
  reason: string;
  detail: Record<string, unknown>;
}

export type PlacementDecision = PlacementAcceptance | PlacementRefusal;

export interface PlacementWorker {
  workerId: string;
  region: string;
  /** Воркер в drain не берёт новых задач (ACM-323: старые доигрывает прежний владелец). */
  draining?: boolean;
}

const POLICY_KEYS = ['schemaVersion', 'policyId', 'authority', 'decisionRef', 'engines', 'credentialScopes', 'dataResidency'] as const;
const POLICY_REQUIRED = ['schemaVersion', 'policyId', 'authority', 'engines', 'credentialScopes', 'dataResidency'] as const;
const ENGINE_RULE_KEYS = ['allowedRegions', 'explicitProfileRef', 'providers'] as const;
const ENGINE_RULE_REQUIRED = ['allowedRegions'] as const;
const PROVIDER_RULE_KEYS = ['allowedRegions'] as const;
const CREDENTIAL_RULE_KEYS = ['regions'] as const;
const RESIDENCY_KEYS = ['decided', 'decisionRef', 'regions'] as const;
const RESIDENCY_REQUIRED = ['decided'] as const;

function validateRegionList(value: unknown, path: string, collector: ErrorCollector): string[] {
  if (!checkArray(value, path, collector)) return [];
  if (value.length === 0) collector.push(`${path}: at least one region is required (an empty list means "nowhere", not "anywhere")`);
  if (value.length > 32) collector.push(`${path}: at most 32 regions`);
  const seen = new Set<string>();
  const parsed: string[] = [];
  value.forEach((entry, index) => {
    checkString(entry, `${path}[${index}]`, collector, 50);
    if (typeof entry !== 'string' || entry.length === 0) return;
    if (!REGION_ID.test(entry)) collector.push(`${path}[${index}]: expected a region id like "sandbox-ru"`);
    if (seen.has(entry)) {
      collector.push(`${path}[${index}]: duplicate region "${entry}"`);
      return;
    }
    seen.add(entry);
    parsed.push(entry);
  });
  return parsed;
}

function validateEngineRule(value: unknown, path: string, collector: ErrorCollector): PlacementEngineRule {
  const rule: PlacementEngineRule = { allowedRegions: [], explicitProfileRef: null };
  if (!checkObject(value, path, collector)) return rule;
  checkKeys(value, ENGINE_RULE_KEYS, ENGINE_RULE_REQUIRED, path, collector);
  rule.allowedRegions = validateRegionList(value['allowedRegions'], `${path}.allowedRegions`, collector);
  if (value['explicitProfileRef'] !== undefined && value['explicitProfileRef'] !== null) {
    checkString(value['explicitProfileRef'], `${path}.explicitProfileRef`, collector, 500);
    if (typeof value['explicitProfileRef'] === 'string' && value['explicitProfileRef'].length > 0) {
      rule.explicitProfileRef = value['explicitProfileRef'];
    }
  }
  if (value['providers'] !== undefined) {
    const providers: Record<string, PlacementProviderRule> = {};
    if (checkObject(value['providers'], `${path}.providers`, collector)) {
      const entries = Object.entries(value['providers']);
      if (entries.length > 32) collector.push(`${path}.providers: at most 32 providers`);
      for (const [providerId, raw] of entries) {
        const providerPath = `${path}.providers.${providerId}`;
        if (!REGION_ID.test(providerId)) collector.push(`${providerPath}: provider id must match ${REGION_ID.source}`);
        if (!checkObject(raw, providerPath, collector)) continue;
        checkKeys(raw, PROVIDER_RULE_KEYS, PROVIDER_RULE_KEYS, providerPath, collector);
        providers[providerId] = { allowedRegions: validateRegionList(raw['allowedRegions'], `${providerPath}.allowedRegions`, collector) };
      }
    }
    rule.providers = providers;
  }
  return rule;
}

function validateCredentialRule(value: unknown, path: string, collector: ErrorCollector): PlacementCredentialRule {
  if (!checkObject(value, path, collector)) return { regions: [] };
  checkKeys(value, CREDENTIAL_RULE_KEYS, CREDENTIAL_RULE_KEYS, path, collector);
  return { regions: validateRegionList(value['regions'], `${path}.regions`, collector) };
}

function validateDataResidency(value: unknown, path: string, collector: ErrorCollector): PlacementDataResidencyPolicy {
  const residency: PlacementDataResidencyPolicy = { decided: false, decisionRef: null, regions: [] };
  if (!checkObject(value, path, collector)) return residency;
  checkKeys(value, RESIDENCY_KEYS, RESIDENCY_REQUIRED, path, collector);
  if (typeof value['decided'] !== 'boolean') collector.push(`${path}.decided: expected boolean`);
  else residency.decided = value['decided'];
  if (value['decisionRef'] !== undefined && value['decisionRef'] !== null) {
    checkString(value['decisionRef'], `${path}.decisionRef`, collector, 500);
    if (typeof value['decisionRef'] === 'string' && value['decisionRef'].length > 0) residency.decisionRef = value['decisionRef'];
  }
  if (value['regions'] !== undefined) {
    if (checkArray(value['regions'], `${path}.regions`, collector)) {
      if (value['regions'].length > 32) collector.push(`${path}.regions: at most 32 regions`);
      const seen = new Set<string>();
      value['regions'].forEach((entry, index) => {
        checkString(entry, `${path}.regions[${index}]`, collector, 50);
        if (typeof entry !== 'string' || entry.length === 0) return;
        if (!REGION_ID.test(entry)) collector.push(`${path}.regions[${index}]: expected a region id like "sandbox-eu"`);
        if (seen.has(entry)) {
          collector.push(`${path}.regions[${index}]: duplicate region "${entry}"`);
          return;
        }
        seen.add(entry);
        residency.regions.push(entry);
      });
    }
  }
  return residency;
}

/**
 * Валидация fail-closed: движок, провайдер или scope, которых нет в политике, считаются
 * неразрешёнными. «Мягкая» политика (пустой список регионов, decided без решения) отвергается.
 */
export function validatePlacementPolicy(input: unknown): ValidationResult<PlacementPolicy> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'placement', collector)) return collector.finish(undefined as never);
  checkKeys(input, POLICY_KEYS, POLICY_REQUIRED, 'placement', collector);

  if (input['schemaVersion'] !== PLACEMENT_POLICY_SCHEMA_VERSION) {
    collector.push(`placement.schemaVersion: expected ${PLACEMENT_POLICY_SCHEMA_VERSION}`);
  }
  checkString(input['policyId'], 'placement.policyId', collector, 100);

  const authority = input['authority'];
  let authorityValue: PlacementAuthority = 'sandbox_probe';
  if (typeof authority !== 'string' || !(PLACEMENT_AUTHORITIES as readonly string[]).includes(authority)) {
    collector.push(`placement.authority: expected one of ${PLACEMENT_AUTHORITIES.join(', ')}`);
  } else {
    authorityValue = authority as PlacementAuthority;
  }

  let decisionRef: string | null = null;
  if (input['decisionRef'] !== undefined && input['decisionRef'] !== null) {
    checkString(input['decisionRef'], 'placement.decisionRef', collector, 500);
    if (typeof input['decisionRef'] === 'string' && input['decisionRef'].length > 0) decisionRef = input['decisionRef'];
  }
  if (authorityValue === 'owner_decision' && decisionRef === null) {
    collector.push('placement.decisionRef: an owner-approved placement policy must reference the decision');
  }

  const engines: Record<string, PlacementEngineRule> = {};
  if (checkObject(input['engines'], 'placement.engines', collector)) {
    const entries = Object.entries(input['engines']);
    if (entries.length === 0) collector.push('placement.engines: at least one engine must be declared');
    if (entries.length > 64) collector.push('placement.engines: at most 64 engines');
    for (const [engineName, raw] of entries) {
      checkString(engineName, 'placement.engines[]', collector, 100);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(engineName)) {
        collector.push(`placement.engines.${engineName}: expected an engine name like "opencode"`);
      }
      engines[engineName] = validateEngineRule(raw, `placement.engines.${engineName}`, collector);
    }
  }

  const credentialScopes: Record<string, PlacementCredentialRule> = {};
  if (checkObject(input['credentialScopes'], 'placement.credentialScopes', collector)) {
    const entries = Object.entries(input['credentialScopes']);
    if (entries.length > 100) collector.push('placement.credentialScopes: at most 100 scopes');
    for (const [scope, raw] of entries) {
      checkString(scope, 'placement.credentialScopes[]', collector, 300);
      credentialScopes[scope] = validateCredentialRule(raw, `placement.credentialScopes.${scope}`, collector);
    }
  }

  const dataResidency = validateDataResidency(input['dataResidency'], 'placement.dataResidency', collector);
  if (dataResidency.decided) {
    // Резидентность — отдельное решение владельца; симуляция песочницы не может его принять.
    if (authorityValue !== 'owner_decision') {
      collector.push('placement.dataResidency.decided: only an owner_decision policy may declare data residency as decided');
    }
    if (dataResidency.decisionRef === null) {
      collector.push('placement.dataResidency.decisionRef: a decided residency policy must reference the owner decision');
    }
    if (dataResidency.regions.length === 0) {
      collector.push('placement.dataResidency.regions: a decided residency policy must list the regions where data may stay');
    }
  }

  if (!collector.ok) return collector.finish(undefined as never);

  return collector.finish({
    schemaVersion: PLACEMENT_POLICY_SCHEMA_VERSION,
    policyId: input['policyId'] as string,
    authority: authorityValue,
    decisionRef,
    engines,
    credentialScopes,
    dataResidency,
  });
}

/**
 * Провайдер из модели: `zen/grok` → `zen`, `anthropic/claude-x` → `anthropic`. Модель без
 * слэша — сама провайдер (OpenCode у нас адресует провайдера явно).
 */
export function providerOf(model: string | undefined): string | null {
  if (model === undefined || model.trim() === '') return null;
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  const provider = slash > 0 ? trimmed.slice(0, slash) : trimmed;
  return provider === '' ? null : provider;
}

/**
 * Решение о размещении на КОНКРЕТНОМ воркере: регион × провайдер × credentials × резидентность.
 * Функция чистая и детерминированная — её результат целиком попадает в лог, поэтому «почему
 * воркер отказал» читается без доступа к состоянию флота.
 *
 * Порядок проверок — часть контракта:
 * 1) движок объявлен в политике (fail-closed: неизвестный движок не «разрешён по умолчанию»);
 * 2) движок разрешён в регионе воркера;
 * 3) explicit profile, если регион его требует;
 * 4) провайдер/модель;
 * 5) credential bindings по регионам;
 * 6) резидентность данных (не решена → отказ, а не догадка);
 * 7) regionConstraints самого рана.
 */
export function decidePlacement(policy: PlacementPolicy, worker: PlacementWorker, subject: PlacementSubject): PlacementDecision {
  const region = worker.region;
  const reasons: string[] = [`region ${region} is allowed for engine "${subject.engineName}"`];

  const rule = policy.engines[subject.engineName];
  if (!rule) {
    return refuse('REGION_ENGINE_UNDECLARED', `engine "${subject.engineName}" is not declared in placement policy ${policy.policyId}; an undeclared engine is not allowed anywhere`, {
      engine: subject.engineName,
      region,
      policyId: policy.policyId,
      declaredEngines: Object.keys(policy.engines).sort(),
    });
  }
  if (!rule.allowedRegions.includes(region)) {
    return refuse('REGION_ENGINE_FORBIDDEN', `engine "${subject.engineName}" is not allowed in region ${region} (allowed: ${rule.allowedRegions.join(', ') || 'none'})`, {
      engine: subject.engineName,
      region,
      allowedRegions: [...rule.allowedRegions],
      policyId: policy.policyId,
    });
  }
  if (rule.explicitProfileRef === null) {
    return refuse(
      'REGION_EXPLICIT_PROFILE_REQUIRED',
      `engine "${subject.engineName}" runs in region ${region} only under an explicitly approved profile; placement policy ${policy.policyId} records no such profile`,
      {
        engine: subject.engineName,
        region,
        allowedRegions: [...rule.allowedRegions],
        policyId: policy.policyId,
        explicitProfileRef: null,
        requiredBy: 'ARCHITECTURE §8, приёмка P30: Claude/Codex вне RU только с явным профилем',
      },
    );
  }
  reasons.push(`explicit profile ${rule.explicitProfileRef}`);

  const provider = providerOf(subject.model);
  if (rule.providers !== undefined) {
    if (provider === null) {
      return refuse('PROVIDER_UNDECLARED', `engine "${subject.engineName}" declares provider constraints in policy ${policy.policyId}, but the run has no model`, {
        engine: subject.engineName,
        region,
        declaredProviders: Object.keys(rule.providers).sort(),
        policyId: policy.policyId,
      });
    }
    const providerRule = rule.providers[provider];
    if (!providerRule) {
      return refuse('PROVIDER_UNDECLARED', `provider "${provider}" is not declared for engine "${subject.engineName}" in placement policy ${policy.policyId}`, {
        engine: subject.engineName,
        provider,
        region,
        declaredProviders: Object.keys(rule.providers).sort(),
        policyId: policy.policyId,
      });
    }
    if (!providerRule.allowedRegions.includes(region)) {
      return refuse('PROVIDER_REGION_FORBIDDEN', `provider "${provider}" is not available in region ${region} (allowed: ${providerRule.allowedRegions.join(', ') || 'none'})`, {
        engine: subject.engineName,
        provider,
        region,
        allowedRegions: [...providerRule.allowedRegions],
        policyId: policy.policyId,
      });
    }
    reasons.push(`provider ${provider} is available in region ${region}`);
  }

  for (const binding of subject.credentialBindings ?? []) {
    const scopeRule = policy.credentialScopes[binding.scope];
    if (!scopeRule) {
      return refuse('CREDENTIAL_SCOPE_UNDECLARED', `credential scope "${binding.scope}" is not declared in placement policy ${policy.policyId}; an undeclared scope is not provisioned anywhere`, {
        bindingRef: binding.ref,
        scope: binding.scope,
        region,
        declaredScopes: Object.keys(policy.credentialScopes).sort(),
        policyId: policy.policyId,
      });
    }
    if (!scopeRule.regions.includes(region)) {
      return refuse('CREDENTIAL_REGION_FORBIDDEN', `credential scope "${binding.scope}" is not provisioned in region ${region} (provisioned: ${scopeRule.regions.join(', ') || 'none'})`, {
        bindingRef: binding.ref,
        scope: binding.scope,
        region,
        provisionedRegions: [...scopeRule.regions],
        policyId: policy.policyId,
      });
    }
    reasons.push(`credential scope ${binding.scope} is provisioned in region ${region}`);
  }

  const residency = subject.regionConstraints?.dataResidency;
  if (residency !== undefined && residency !== DATA_RESIDENCY_NONE) {
    if (!policy.dataResidency.decided) {
      return refuse(
        'DATA_RESIDENCY_UNDECIDED',
        `run requires data residency in ${residency}, but storage residency is not an approved decision (policy ${policy.policyId}); placement refuses instead of choosing a storage region`,
        {
          requiredRegion: residency,
          region,
          policyId: policy.policyId,
          decisionRef: policy.dataResidency.decisionRef,
          decidedBy: null,
          ownerDecisionRequired: true,
        },
      );
    }
    if (!policy.dataResidency.regions.includes(residency)) {
      return refuse('DATA_RESIDENCY_FORBIDDEN', `data residency region ${residency} is not part of the approved decision (${policy.dataResidency.decisionRef ?? 'no decision ref'})`, {
        requiredRegion: residency,
        region,
        approvedRegions: [...policy.dataResidency.regions],
        decisionRef: policy.dataResidency.decisionRef,
        policyId: policy.policyId,
      });
    }
    if (residency !== region) {
      return refuse('DATA_RESIDENCY_REGION_MISMATCH', `run requires data to stay in ${residency}, but this worker runs in ${region}`, {
        requiredRegion: residency,
        region,
        decisionRef: policy.dataResidency.decisionRef,
        policyId: policy.policyId,
      });
    }
    reasons.push(`data residency ${residency} approved by ${policy.dataResidency.decisionRef ?? 'decision'}`);
  }

  const allowedRegions = subject.regionConstraints?.allowedRegions;
  if (allowedRegions !== undefined && allowedRegions.length > 0 && !allowedRegions.includes(region)) {
    return refuse('REGION_NOT_ALLOWED', `worker region ${region} is outside the run's allowed regions [${allowedRegions.join(', ')}]`, {
      region,
      allowedRegions: [...allowedRegions],
      policyId: policy.policyId,
    });
  }

  return {
    place: true,
    workerId: worker.workerId,
    region,
    policyId: policy.policyId,
    provider,
    reasons,
  };
}

/**
 * Отбор воркеров флота для control plane: «кому вообще можно отдать этот запрос». Отказ
 * здесь не «запрет во флоте», а «этот воркер не подходит» — другой воркер может принять
 * задачу, и причина отказа обязана быть в ответе.
 */
export function screenWorkers(
  policy: PlacementPolicy,
  workers: PlacementWorker[],
  subject: PlacementSubject,
): { eligible: Array<{ workerId: string; region: string; provider: string | null }>; rejected: Array<{ workerId: string; region: string; code: string; reason: string }> } {
  const eligible: Array<{ workerId: string; region: string; provider: string | null }> = [];
  const rejected: Array<{ workerId: string; region: string; code: string; reason: string }> = [];
  for (const worker of workers) {
    if (worker.draining === true) {
      rejected.push({
        workerId: worker.workerId,
        region: worker.region,
        code: 'WORKER_DRAINING',
        reason: `worker ${worker.workerId} is draining: it does not accept new tasks, accepted ones stay with it`,
      });
      continue;
    }
    const decision = decidePlacement(policy, worker, subject);
    if (decision.place) {
      eligible.push({ workerId: worker.workerId, region: decision.region, provider: decision.provider });
    } else {
      rejected.push({ workerId: worker.workerId, region: worker.region, code: decision.code, reason: decision.reason });
    }
  }
  return { eligible, rejected };
}

/**
 * Список движков, разрешённых в регионе — для повторной проверки Runner'ом (ARCHITECTURE §8:
 * «Runner повторно проверяет region/policy compatibility»). Явный профиль здесь тоже нужен:
 * подтвердить его может только policy.
 */
export function allowedEnginesForRegion(policy: PlacementPolicy, region: string): string[] {
  return Object.entries(policy.engines)
    .filter(([, rule]) => rule.allowedRegions.includes(region) && rule.explicitProfileRef !== null)
    .map(([engineName]) => engineName)
    .sort();
}

/** Отчёт без значений секретов: только binding'и по именам и регион. Для /v1/release. */
export function placementSummary(policy: PlacementPolicy): Record<string, unknown> {
  return {
    policyId: policy.policyId,
    authority: policy.authority,
    decisionRef: policy.decisionRef,
    engines: Object.fromEntries(
      Object.entries(policy.engines)
        .map(([engineName, rule]) => [
          engineName,
          {
            allowedRegions: [...rule.allowedRegions],
            explicitProfileRef: rule.explicitProfileRef,
            ...(rule.providers
              ? { providers: Object.fromEntries(Object.entries(rule.providers).map(([id, providerRule]) => [id, { allowedRegions: [...providerRule.allowedRegions] }])) }
              : {}),
          },
        ])
        .sort((entryA, entryB) => (entryA[0]! < entryB[0]! ? -1 : entryA[0]! > entryB[0]! ? 1 : 0)),
    ),
    credentialScopes: Object.fromEntries(
      Object.entries(policy.credentialScopes)
        .map(([scope, rule]) => [scope, { regions: [...rule.regions] }])
        .sort((entryA, entryB) => (entryA[0]! < entryB[0]! ? -1 : entryA[0]! > entryB[0]! ? 1 : 0)),
    ),
    dataResidency: {
      decided: policy.dataResidency.decided,
      decisionRef: policy.dataResidency.decisionRef,
      regions: [...policy.dataResidency.regions],
    },
  };
}

function refuse(code: PlacementRefusalCode, reason: string, detail: Record<string, unknown>): PlacementRefusal {
  return { place: false, code, reason, detail };
}

export function isRegionId(value: unknown): value is string {
  return typeof value === 'string' && REGION_ID.test(value);
}

/** Политика из env-хоста: `AGENT_API_PLACEMENT_POLICY` — путь к JSON, значения секретов там нет. */
export function placementPolicyFromJson(parsed: unknown): PlacementPolicy {
  const result = validatePlacementPolicy(parsed);
  if (!result.ok) {
    throw new Error(`placement policy is invalid: ${result.errors.join('; ')}`);
  }
  return result.value;
}

export function parsePlacementPolicyText(text: string): PlacementPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`placement policy is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return placementPolicyFromJson(isRecord(parsed) ? parsed : null);
}