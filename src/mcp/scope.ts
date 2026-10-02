import type { CredentialBinding, McpServerSpec, RunSpec } from '../contracts/run-spec.js';
import type { CapabilityBinding } from './capabilities.js';

/**
 * Scoped bindings рана: какие MCP-серверы и какие инструменты ран вообще может
 * использовать, и под каким credential binding'ом. Три слоя приёмки:
 *  1) объявление в RunSpec (`binding.ref` обязан быть в `credentialBindings`) — статика, run-spec;
 *  2) `authorizeTool` — рантайм: инструмент вне `allowedTools` не уходит в сервер;
 *  3) scope binding'а против `requiredScopes` handler'а — в CapabilityRegistry.
 *
 * Значения binding'ов резолвятся хостом и живут только в окружении дочернего процесса:
 * ни в spec, ни в state, ни в events, ни в логах их нет.
 */

export type McpDenyReason =
  | 'unknown_server'
  | 'tool_not_in_scope'
  | 'binding_not_declared'
  | 'binding_missing'
  | 'binding_expired'
  | 'binding_value_unavailable';

export type McpScopeErrorCode =
  | 'MCP_BINDING_NOT_DECLARED'
  | 'MCP_BINDING_MISSING'
  | 'MCP_BINDING_EXPIRED'
  | 'MCP_BINDING_VALUE_UNAVAILABLE';

export class McpScopeError extends Error {
  readonly code: McpScopeErrorCode;
  readonly serverId: string;
  readonly bindingRef: string | null;

  constructor(code: McpScopeErrorCode, serverId: string, message: string, bindingRef: string | null = null) {
    super(message);
    this.name = 'McpScopeError';
    this.code = code;
    this.serverId = serverId;
    this.bindingRef = bindingRef;
  }
}

/** Резолвер значений credential binding'ов; в песочнице — фикстура, в бою — Credential Broker / SM. */
export type BindingValueResolver = (ref: string) => string | null | undefined | Promise<string | null | undefined>;

export type McpToolDecision =
  | { allowed: true; serverId: string; tool: string; binding: CapabilityBinding | undefined }
  | { allowed: false; serverId: string; tool: string; reason: McpDenyReason };

export interface ScopedServer {
  serverId: string;
  spec: McpServerSpec;
  binding: CapabilityBinding | undefined;
}

export interface ScopedToolView {
  serverId: string;
  /** Имя MCP-инструмента равно capabilityId: один идентификатор для MCP, API facade и каталога. */
  name: string;
  bindingRef: string | null;
  bindingScope: string | null;
}

export class McpRunScope {
  readonly servers: ScopedServer[];
  private readonly byId = new Map<string, ScopedServer>();

  private constructor(servers: ScopedServer[], private readonly resolveValue?: BindingValueResolver) {
    this.servers = servers;
    for (const server of servers) this.byId.set(server.serverId, server);
  }

  /**
   * Структурная проверка объявленных серверов. Бросает McpScopeError, если binding
   * не объявлен/просрочен — это fail-closed до спавна любого процесса.
   */
  static fromSpec(spec: RunSpec, resolveValue?: BindingValueResolver): McpRunScope {
    const declared = new Map<string, CredentialBinding>();
    for (const binding of spec.credentialBindings ?? []) declared.set(binding.ref, binding);

    const servers: ScopedServer[] = (spec.mcp?.servers ?? []).map((serverSpec) => {
      let binding: CapabilityBinding | undefined;
      if (serverSpec.bindingRef !== undefined) {
        const record = declared.get(serverSpec.bindingRef);
        if (!record) {
          throw new McpScopeError(
            'MCP_BINDING_NOT_DECLARED',
            serverSpec.serverId,
            `mcp server "${serverSpec.serverId}" references credential binding "${serverSpec.bindingRef}", which is not declared in spec.credentialBindings`,
            serverSpec.bindingRef,
          );
        }
        if (record.status === 'missing') {
          throw new McpScopeError(
            'MCP_BINDING_MISSING',
            serverSpec.serverId,
            `credential binding "${record.ref}" required by mcp server "${serverSpec.serverId}" is missing`,
            record.ref,
          );
        }
        if (record.status === 'expired') {
          throw new McpScopeError(
            'MCP_BINDING_EXPIRED',
            serverSpec.serverId,
            `credential binding "${record.ref}" required by mcp server "${serverSpec.serverId}" is expired`,
            record.ref,
          );
        }
        binding = { ref: record.ref, scope: record.scope };
      }
      return { serverId: serverSpec.serverId, spec: serverSpec, binding };
    });

    return new McpRunScope(servers, resolveValue);
  }

  get size(): number {
    return this.servers.length;
  }

  server(serverId: string): ScopedServer | undefined {
    return this.byId.get(serverId);
  }

  /** Инструменты, объявленные ран'ом: всё, что движок увидит в tools/list. */
  toolView(): ScopedToolView[] {
    const view: ScopedToolView[] = [];
    for (const server of this.servers) {
      for (const tool of server.spec.allowedTools) {
        view.push({
          serverId: server.serverId,
          name: tool,
          bindingRef: server.binding?.ref ?? null,
          bindingScope: server.binding?.scope ?? null,
        });
      }
    }
    return view;
  }

  /** Есть ли инструмент в объявленных tools хотя бы одного сервера рана. */
  declaresTool(tool: string): boolean {
    return this.servers.some((server) => server.spec.allowedTools.includes(tool));
  }

  /**
   * Решение по вызову инструмента. Отказ здесь — до похода в дочерний процесс:
   * чужой инструмент недоступен, даже если модель/движок его запросили.
   *
   * Пустой serverId — это запрос, у которого владелец инструмента неизвестен (например,
   * broker не нашёл инструмент в tools/list и не знает, какому серверу он принадлежит):
   * отказ всё равно фиксируется, а причина в логе остаётся точной.
   */
  authorizeTool(serverId: string, tool: string): McpToolDecision {
    const server = this.byId.get(serverId);
    if (!server) {
      return { allowed: false, serverId, tool, reason: this.declaresTool(tool) ? 'unknown_server' : 'tool_not_in_scope' };
    }
    if (!server.spec.allowedTools.includes(tool)) {
      return { allowed: false, serverId, tool, reason: 'tool_not_in_scope' };
    }
    if (server.spec.bindingRef !== undefined && !server.binding) {
      return { allowed: false, serverId, tool, reason: 'binding_not_declared' };
    }
    return { allowed: true, serverId, tool, binding: server.binding };
  }

  /**
   * Значение binding'а для исходящего вызова capability. Отсутствие значения — отказ
   * (fail-closed): сервер, для которого хост не может получить учётные данные, не поднимаем.
   * Значение уходит только в HTTP-запрос host-side handler'а, в дочерний процесс — никогда.
   */
  async bindingValue(server: ScopedServer): Promise<string> {
    if (!server.binding) {
      throw new McpScopeError('MCP_BINDING_NOT_DECLARED', server.serverId, `mcp server "${server.serverId}" has no credential binding`);
    }
    const value = await this.resolveValue?.(server.binding.ref);
    if (!value) {
      throw new McpScopeError(
        'MCP_BINDING_VALUE_UNAVAILABLE',
        server.serverId,
        `credential binding "${server.binding.ref}" has no value on this host (binding ref is declared, the value is not resolvable)`,
        server.binding.ref,
      );
    }
    return value;
  }
}
