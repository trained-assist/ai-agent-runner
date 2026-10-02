/**
 * Capability handler — единый контракт доменного действия для всех транспортных фасадов
 * (TASK-ROUTER-AND-MCP §5 «Один domain handler имеет contract и разные transport facades»,
 * §11.4 «Контракт handler»).
 *
 * Один и тот же handler обслуживает:
 *  - MCP-вызов рана (`tools/call` через per-run stdio процесс);
 *  - внутренний вызов control plane (`POST /v1/capabilities/invoke`).
 *
 * Набор outcome-kinds взят из спецификации (completed / missing_input / blocked /
 * needs_agent / technical_error) — второй набор терминов ради MCP не заводим.
 */

export const CAPABILITY_OUTCOME_KINDS = ['completed', 'missing_input', 'blocked', 'needs_agent', 'technical_error'] as const;

export type CapabilityOutcomeKind = (typeof CAPABILITY_OUTCOME_KINDS)[number];

/** Кто вызывает capability. Приходит из хоста, никогда — из текста модели. */
export interface CapabilityCaller {
  principalId: string;
  profileId: string;
  userTaskId: string;
  /** null для headless-вызова control plane (вне рана). */
  runId: string | null;
  operationId: string;
}

/**
 * Credential binding вызова. Хост подставляет его сам (MCP-сервер рана не может выбрать,
 * под каким binding'ом исполнить действие: значение приходит из `credentialBindings`
 * рана, а scope проверяется против `requiredScopes` handler'а).
 */
export interface CapabilityBinding {
  ref: string;
  scope: string;
}

export interface CapabilityInvocation {
  capabilityId: string;
  arguments: Record<string, unknown>;
  caller: CapabilityCaller;
  binding?: CapabilityBinding;
}

/**
 * Квитанция эффекта: доказуемый результат внешнего действия, а не «ок» инструмента
 * (AC-119 / ловушка PR-16).
 */
export interface EffectReceipt {
  receiptId: string;
  capabilityId: string;
  capabilityVersion: number;
  operationId: string;
  bindingRef: string;
  at: string;
  /** Идентификатор операции на стороне внешнего сервиса, если он есть. */
  externalRef?: string;
}

export type CapabilityOutcome =
  | { kind: 'completed'; result: Record<string, unknown>; effectReceipt?: EffectReceipt }
  | { kind: 'missing_input'; fields: string[] }
  | { kind: 'blocked'; reason: string }
  | { kind: 'needs_agent'; reason: string }
  | { kind: 'technical_error'; code: string };

export interface CapabilityHandlerContext {
  /** Значение credential binding'а (host-owned). В логи и результат не попадает. */
  bindingValue?: string;
  now: () => Date;
}

export interface CapabilityHandler {
  capabilityId: string;
  capabilityVersion: number;
  /** Области credential binding, без которых действие не исполняется. */
  requiredScopes: readonly string[];
  /** Обязательные аргументы: их отсутствие даёт missing_input, а не выдуманный результат. */
  requiredArguments: readonly string[];
  /** read — без внешнего эффекта, write — обязан вернуть effectReceipt. */
  effect: 'read' | 'write';
  description: string;
  invoke: (invocation: CapabilityInvocation, ctx: CapabilityHandlerContext) => Promise<CapabilityOutcome>;
}

/** Отказ хоста до исполнения handler'а (semantic validation, §11.2 шаг 4). */
export class CapabilityError extends Error {
  readonly code: 'CAPABILITY_NOT_FOUND' | 'CAPABILITY_VERSION_UNKNOWN' | 'BINDING_SCOPE_MISSING' | 'BINDING_REQUIRED';
  readonly details: Record<string, unknown>;

  constructor(code: CapabilityError['code'], message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
    this.details = details;
  }
}

export interface CapabilityRegistryOptions {
  clock?: () => Date;
}

export class CapabilityRegistry {
  private readonly handlers = new Map<string, CapabilityHandler>();
  private readonly clock: () => Date;

  constructor(options: CapabilityRegistryOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  register(handler: CapabilityHandler): this {
    const existing = this.handlers.get(handler.capabilityId);
    if (existing && existing.capabilityVersion !== handler.capabilityVersion) {
      throw new Error(
        `capability "${handler.capabilityId}" is already registered at version ${existing.capabilityVersion}; ` +
          'registering a second version in the same process is not supported yet',
      );
    }
    this.handlers.set(handler.capabilityId, handler);
    return this;
  }

  has(capabilityId: string): boolean {
    return this.handlers.has(capabilityId);
  }

  size(): number {
    return this.handlers.size;
  }

  list(): CapabilityHandler[] {
    return [...this.handlers.values()].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  }

  get(capabilityId: string, version?: number): CapabilityHandler {
    const handler = this.handlers.get(capabilityId);
    if (!handler) {
      throw new CapabilityError('CAPABILITY_NOT_FOUND', `capability "${capabilityId}" is not registered on this host`, { capabilityId });
    }
    if (version !== undefined && version !== handler.capabilityVersion) {
      throw new CapabilityError(
        'CAPABILITY_VERSION_UNKNOWN',
        `capability "${capabilityId}" is registered at version ${handler.capabilityVersion}, requested ${version}`,
        { capabilityId, registeredVersion: handler.capabilityVersion, requestedVersion: version },
      );
    }
    return handler;
  }

  /**
   * Исполнение capability с проверками хоста: версия, обязательные аргументы, scope
   * binding'а. Значение binding'а резолвится вызывающим (host) и в registry не попадает.
   */
  async invoke(invocation: CapabilityInvocation, bindingValue?: string): Promise<CapabilityOutcome> {
    const handler = this.get(invocation.capabilityId);
    const missing = handler.requiredArguments.filter((name) => {
      const value = invocation.arguments[name];
      return value === undefined || value === null || value === '';
    });
    if (missing.length > 0) return { kind: 'missing_input', fields: [...missing] };

    if (handler.requiredScopes.length > 0) {
      const binding = invocation.binding;
      if (!binding) {
        return {
          kind: 'blocked',
          reason:
            `capability "${handler.capabilityId}" requires a credential binding with scope ` +
            `${handler.requiredScopes.join('|')} and the caller has none`,
        };
      }
      if (!handler.requiredScopes.includes(binding.scope)) {
        throw new CapabilityError(
          'BINDING_SCOPE_MISSING',
          `credential binding "${binding.ref}" has scope "${binding.scope}", capability "${handler.capabilityId}" requires ${handler.requiredScopes.join('|')}`,
          { capabilityId: handler.capabilityId, bindingRef: binding.ref, bindingScope: binding.scope, requiredScopes: [...handler.requiredScopes] },
        );
      }
    }

    const outcome = await handler.invoke(invocation, {
      ...(bindingValue !== undefined ? { bindingValue } : {}),
      now: this.clock,
    });

    if (handler.effect === 'write' && outcome.kind === 'completed' && !outcome.effectReceipt) {
      // «Ок» без проверяемого результата — ловушка PR-16: наружу такое completed не выходит.
      return { kind: 'technical_error', code: 'EFFECT_RECEIPT_MISSING' };
    }
    return outcome;
  }
}
