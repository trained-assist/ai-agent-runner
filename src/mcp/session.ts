import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isProcessAlive, killProcessTree, waitForProcessDeath } from '../adapters/engine/process-tree.js';
import type { ProcessLauncher } from '../isolation/launcher.js';
import type { RunIdentity } from '../isolation/contract.js';
import type { RunSpec } from '../contracts/run-spec.js';
import type { CapabilityRegistry } from './capabilities.js';
import { BRIDGE_SOCKET_PATH_LIMIT, McpBridgeServer, bridgeSocketPath, type McpBridgeCallRequest, type McpBridgeCaller, type McpBridgeCallResult } from './bridge.js';
import { RPC_ERROR_CODES, StdioJsonRpcClient, StdioRpcError } from './jsonrpc.js';
import type { McpDenyReason, McpRunScope, ScopedServer, ScopedToolView } from './scope.js';

/**
 * Per-run MCP lifecycle (карточка P13, этап I04).
 *
 * Топология рана — по TASK-ROUTER-AND-MCP §5 («Agent-local MCP: engine client подключает
 * local stdio process/proxy на Run; ограниченные bindings»), при этом remote domain MCP
 * остаётся общим сервисом и на каждый ран не поднимается:
 *
 *   engine ──stdio──▶ broker (per-run proxy, значений binding'ов не видит)
 *                      │  unix socket + run token
 *                      ▼
 *                    хост: McpRunSession → scoped bindings → stdio MCP-сервер (per-run процесс)
 *                      │  capability/invoke
 *                      ▼
 *                    CapabilityRegistry (общий handler) → внешний доменный сервис
 *
 * Что здесь намеренно НЕ заявлено: per-run процессы MCP стартуют под тем же service UID,
 * что и runner. Это ограничение приёмки, а не доказанная изоляция — см. docs/MCP-LIFECYCLE.md.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18' as const;
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const DEFAULT_MCP_READINESS_TIMEOUT_MS = 5000;
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 10_000;
export const DEFAULT_MCP_KILL_GRACE_MS = 500;
export const MCP_CLIENT_NAME = 'ai-agent-runner';

export type McpLogLevel = 'info' | 'warn' | 'error';
export type McpLogFields = Record<string, string | number | boolean | null>;

export type McpLogger = (level: McpLogLevel, event: string, fields: McpLogFields) => void;

export type McpStartupFailure =
  | 'spawn_failed'
  | 'handshake_timeout'
  | 'handshake_failed'
  | 'readiness_failed'
  | 'transport_closed'
  | 'capability_unknown'
  | 'binding_unavailable'
  | 'socket_path_too_long';

export class McpStartupError extends Error {
  readonly code = 'MCP_STARTUP_FAILED' as const;
  readonly serverId: string;
  readonly reason: McpStartupFailure;

  constructor(serverId: string, reason: McpStartupFailure, message: string) {
    super(message);
    this.name = 'McpStartupError';
    this.serverId = serverId;
    this.reason = reason;
  }
}

export type McpToolCallResult =
  | { ok: true; serverId: string; tool: string; result: Record<string, unknown> }
  | {
      ok: false;
      serverId: string;
      tool: string;
      reason: McpDenyReason | 'tool_timeout' | 'rpc_error' | 'transport_closed' | 'tool_error' | 'invalid_result' | 'tool_not_offered';
      code?: number;
      detail?: string;
    };

export interface McpProcessOutcome {
  serverId: string;
  signal: NodeJS.Signals | 'none';
  outcome: 'exited' | 'killed' | 'spawn_failed';
  alive: boolean;
  elapsedMs: number;
}

interface SpawnedProcess {
  child: ChildProcess;
  client: StdioJsonRpcClient;
  spawnError: Error | null;
}

function spawnStdioProcess(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  onStderr: (line: string) => void,
  launcher?: ProcessLauncher | null,
  identity?: RunIdentity | null,
): SpawnedProcess {
  // Per-run MCP-процессы исполняются под той же идентичностью, что и движок (issue #51):
  // иначе сервер остался бы под service UID и читал бы чужие данные рана.
  const launch = launcher && identity ? launcher.wrap(identity, command, args) : { command, args };
  const child = spawn(launch.command, launch.args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const holder: SpawnedProcess = { child, client: undefined as unknown as StdioJsonRpcClient, spawnError: null };
  child.once('error', (err) => {
    holder.spawnError = err;
  });
  holder.client = new StdioJsonRpcClient(child, { onStderr });
  return holder;
}

/** Команда и argv дочернего процесса в логах не публикуются — только приватный ref. */
function commandRef(command: string, args: readonly string[]): string {
  return `cmd-${createHash('sha256').update([command, ...args].join('')).digest('hex').slice(0, 8)}`;
}

function handshakeFailureReason(failure: StdioRpcError): McpStartupFailure {
  if (failure.reason === 'timeout') return 'handshake_timeout';
  // Процесс умер, не ответив на initialize: это отказ старта, а не «сервер закрыл транспорт».
  if (failure.reason === 'transport_closed' && !failure.exited) return 'transport_closed';
  return 'handshake_failed';
}

interface McpServerSessionDeps {
  scoped: ScopedServer;
  env: Record<string, string>;
  cwd: string;
  log: McpLogger;
  killGraceMs: number;
  readinessTimeoutMs: number;
  toolTimeoutMs: number;
  launcher?: ProcessLauncher | null;
  identity?: RunIdentity | null;
}

/** Один объявленный MCP-сервер рана: спавн, handshake, readiness, вызовы, гашение. */
export class McpServerSession {
  readonly serverId: string;
  readonly pid: number | null;
  readonly commandRef: string;
  private readonly deps: McpServerSessionDeps;
  private readonly process: SpawnedProcess;
  private closed = false;
  negotiatedProtocolVersion: string | null = null;
  serverInfo: { name: string; version: string } | null = null;
  offeredTools: string[] = [];
  readyTools: string[] = [];

  private constructor(deps: McpServerSessionDeps, spawned: SpawnedProcess) {
    this.deps = deps;
    this.process = spawned;
    this.serverId = deps.scoped.serverId;
    this.pid = spawned.child.pid ?? null;
    this.commandRef = commandRef(deps.scoped.spec.command, deps.scoped.spec.args ?? []);
  }

  static async start(deps: McpServerSessionDeps): Promise<McpServerSession> {
    const spec = deps.scoped.spec;
    deps.log('info', 'mcp.server_starting', {
      serverId: deps.scoped.serverId,
      transport: spec.transport,
      commandRef: commandRef(spec.command, spec.args ?? []),
      declaredTools: spec.allowedTools.length,
      bindingRef: deps.scoped.binding?.ref ?? null,
    });
    const spawned = spawnStdioProcess(
      spec.command,
      spec.args ?? [],
      deps.env,
      deps.cwd,
      (line) => deps.log('warn', 'mcp.server_stderr', { serverId: deps.scoped.serverId, line }),
      deps.launcher ?? null,
      deps.identity ?? null,
    );
    const session = new McpServerSession(deps, spawned);
    await session.handshake();
    return session;
  }

  private async handshake(): Promise<void> {
    const spec = this.deps.scoped.spec;
    const scoped = this.deps.scoped;
    this.deps.log('info', 'mcp.server_spawned', { serverId: this.serverId, commandRef: this.commandRef, pid: this.pid ?? -1 });

    if (this.process.spawnError) {
      this.deps.log('error', 'mcp.server_start_failed', {
        serverId: this.serverId,
        reason: 'spawn_failed',
        detail: this.process.spawnError.message,
      });
      throw new McpStartupError(this.serverId, 'spawn_failed', `mcp server "${this.serverId}" could not be spawned: ${this.process.spawnError.message}`);
    }

    let result: unknown;
    try {
      result = await this.process.client.request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { roots: { listChanged: false } },
          clientInfo: { name: MCP_CLIENT_NAME, version: '1.0.0' },
        },
        this.deps.readinessTimeoutMs,
      );
    } catch (err) {
      const failure = err instanceof StdioRpcError ? err : new StdioRpcError('rpc_error', String(err));
      const reason = this.process.spawnError ? 'spawn_failed' : handshakeFailureReason(failure);
      this.deps.log('error', 'mcp.server_start_failed', {
        serverId: this.serverId,
        reason,
        code: failure.code ?? -1,
        detail: failure.message,
      });
      await this.close(`start_failed_${reason}`);
      throw new McpStartupError(this.serverId, reason, failure.message);
    }

    const record = asRecord(result);
    const serverInfo = asRecord(record['serverInfo']);
    const capabilities = asRecord(record['capabilities']);
    this.negotiatedProtocolVersion = typeof record['protocolVersion'] === 'string' ? record['protocolVersion'] : null;
    this.serverInfo = {
      name: typeof serverInfo['name'] === 'string' ? serverInfo['name'] : 'unknown',
      version: typeof serverInfo['version'] === 'string' ? serverInfo['version'] : 'unknown',
    };

    if (!capabilities['tools']) {
      const detail = 'server did not declare the tools capability';
      this.deps.log('error', 'mcp.server_start_failed', { serverId: this.serverId, reason: 'readiness_failed', detail });
      await this.close('start_failed_readiness_failed');
      throw new McpStartupError(this.serverId, 'readiness_failed', `mcp server "${this.serverId}": ${detail}`);
    }

    let tools: string[] = [];
    try {
      const listed = await this.process.client.request('tools/list', {}, this.deps.readinessTimeoutMs);
      const entries = asRecord(listed)['tools'];
      tools = (Array.isArray(entries) ? entries : [])
        .map((entry) => {
          const name = asRecord(entry)['name'];
          return typeof name === 'string' ? name : '';
        })
        .filter((name) => name.length > 0);
    } catch (err) {
      const failure = err instanceof StdioRpcError ? err : new StdioRpcError('rpc_error', String(err));
      const reason = handshakeFailureReason(failure);
      this.deps.log('error', 'mcp.server_start_failed', { serverId: this.serverId, reason, code: failure.code ?? -1, detail: failure.message });
      await this.close(`start_failed_${reason}`);
      throw new McpStartupError(this.serverId, reason, failure.message);
    }

    this.offeredTools = tools;
    this.readyTools = spec.allowedTools.filter((tool) => tools.includes(tool));
    if (this.readyTools.length === 0) {
      const detail = `server offers none of the tools declared for this run (offered=${tools.length}, declared=${spec.allowedTools.length})`;
      this.deps.log('error', 'mcp.server_start_failed', { serverId: this.serverId, reason: 'readiness_failed', detail });
      await this.close('start_failed_readiness_failed');
      throw new McpStartupError(this.serverId, 'readiness_failed', `mcp server "${this.serverId}": ${detail}`);
    }

    try {
      this.process.client.notify('notifications/initialized');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log('error', 'mcp.server_start_failed', { serverId: this.serverId, reason: 'transport_closed', detail: message });
      await this.close('start_failed_transport_closed');
      throw new McpStartupError(this.serverId, 'transport_closed', message);
    }

    const notOffered = spec.allowedTools.filter((tool) => !tools.includes(tool));
    this.deps.log('info', 'mcp.server_ready', {
      serverId: this.serverId,
      protocolVersion: this.negotiatedProtocolVersion ?? 'unknown',
      protocolVersionSupported: this.negotiatedProtocolVersion === null ? false : MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(this.negotiatedProtocolVersion),
      serverName: this.serverInfo.name,
      serverVersion: this.serverInfo.version,
      offeredTools: this.offeredTools.length,
      scopedTools: this.readyTools.length,
      tools: this.readyTools.join(','),
      bindingRef: scoped.binding?.ref ?? null,
      bindingScope: scoped.binding?.scope ?? null,
      commandRef: this.commandRef,
      pid: this.pid ?? -1,
      isolation:
        this.deps.identity && this.deps.launcher
          ? `per_run_unix_identity uid=${this.deps.identity.uid}`
          : 'same_service_uid_not_os_isolated',
    });
    if (notOffered.length > 0) {
      this.deps.log('warn', 'mcp.server_tool_missing', { serverId: this.serverId, tools: notOffered.join(',') });
    }
  }

  /** Инструменты, которые ран реально увидит: пересечение объявленного и предложенного. */
  tools(): string[] {
    return [...this.readyTools];
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (this.closed) return { ok: false, serverId: this.serverId, tool, reason: 'transport_closed', detail: 'mcp server session is closed' };
    if (!this.readyTools.includes(tool)) {
      return { ok: false, serverId: this.serverId, tool, reason: 'tool_not_offered', detail: `server does not offer "${tool}" in this run` };
    }
    try {
      const result = await this.process.client.request('tools/call', { name: tool, arguments: args }, this.deps.toolTimeoutMs);
      const record = asRecord(result);
      if (record['isError'] === true) {
        return { ok: false, serverId: this.serverId, tool, reason: 'tool_error', detail: textOf(record['content']) || 'mcp server reported a tool error' };
      }
      const parsed = parseToolResult(record);
      if (!parsed) return { ok: false, serverId: this.serverId, tool, reason: 'invalid_result', detail: 'tool result carried no structured payload' };
      return { ok: true, serverId: this.serverId, tool, result: parsed };
    } catch (err) {
      const failure = err instanceof StdioRpcError ? err : new StdioRpcError('rpc_error', String(err));
      if (failure.reason === 'timeout') {
        // Fail-closed: сервер, зависший на инструменте, в этом ране больше не используется.
        this.deps.log('error', 'mcp.tool_timeout', {
          serverId: this.serverId,
          tool,
          timeoutMs: this.deps.toolTimeoutMs,
          action: 'server_session_terminated',
        });
        await this.close('tool_timeout');
        return { ok: false, serverId: this.serverId, tool, reason: 'tool_timeout', detail: failure.message };
      }
      return {
        ok: false,
        serverId: this.serverId,
        tool,
        reason: failure.reason === 'transport_closed' ? 'transport_closed' : 'rpc_error',
        ...(failure.code !== null ? { code: failure.code } : {}),
        detail: failure.message,
      };
    }
  }

  /** Гашение процесса: SIGTERM → grace → SIGKILL, с проверкой, что процесс мёртв. */
  async close(reason: string): Promise<McpProcessOutcome> {
    if (this.closed) return { serverId: this.serverId, signal: 'none', outcome: 'exited', alive: false, elapsedMs: 0 };
    this.closed = true;
    const pid = this.process.child.pid ?? null;
    const startedAt = Date.now();
    killProcessTree(pid, pid, 'SIGTERM');
    let outcome: McpProcessOutcome['outcome'] = 'exited';
    let signal: NodeJS.Signals | 'none' = 'SIGTERM';
    const dead = await waitForProcessDeath(pid, pid, this.deps.killGraceMs);
    if (!dead) {
      killProcessTree(pid, pid, 'SIGKILL');
      outcome = 'killed';
      signal = 'SIGKILL';
      await waitForProcessDeath(pid, pid, this.deps.killGraceMs);
    }
    this.process.client.dispose();
    const alive = isProcessAlive(pid);
    const record: McpProcessOutcome = { serverId: this.serverId, signal, outcome, alive, elapsedMs: Date.now() - startedAt };
    this.deps.log(outcome === 'killed' ? 'warn' : 'info', 'mcp.server_cleanup', {
      serverId: this.serverId,
      reason,
      signal,
      outcome,
      alive,
      elapsedMs: record.elapsedMs,
      pid: pid ?? -1,
    });
    return record;
  }
}

/**
 * Вызов инструмента рана: приёмка хоста (scoped bindings) → stdio-сессия сервера →
 * лог результата с квитанцией эффекта. Один путь и для broker'а через мост, и для
 * прямых вызовов control plane — дубля обработки тут намеренно нет.
 */
export async function callScopedTool(
  deps: McpRunSessionDeps,
  servers: readonly McpServerSession[],
  serverId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const decision = deps.scope.authorizeTool(serverId, tool);
  if (!decision.allowed) {
    deps.log('warn', 'mcp.tool_denied', { serverId, tool, reason: decision.reason });
    return { ok: false, serverId, tool, reason: decision.reason };
  }
  const session = servers.find((entry) => entry.serverId === serverId);
  if (!session) {
    deps.log('warn', 'mcp.tool_denied', { serverId, tool, reason: 'unknown_server' });
    return { ok: false, serverId, tool, reason: 'unknown_server' };
  }
  deps.log('info', 'mcp.tool_invoked', {
    serverId,
    tool,
    bindingRef: decision.binding?.ref ?? null,
    bindingScope: decision.binding?.scope ?? null,
    userTaskId: deps.spec.userTaskId,
  });
  const result = await session.callTool(tool, args);
  if (result.ok) {
    const outcome = asRecord(result.result['outcome']);
    const receipt = asRecord(outcome['effectReceipt']);
    deps.log('info', 'mcp.tool_result', {
      serverId,
      tool,
      outcome: typeof outcome['kind'] === 'string' ? outcome['kind'] : 'unknown',
      effectReceiptId: typeof receipt['receiptId'] === 'string' ? receipt['receiptId'] : null,
      bindingRef: typeof receipt['bindingRef'] === 'string' ? receipt['bindingRef'] : decision.binding?.ref ?? null,
    });
  } else {
    deps.log('warn', 'mcp.tool_failed', { serverId, tool, reason: result.reason, detail: result.detail ?? null });
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const entry of content) {
    const item = asRecord(entry);
    if (item['type'] === 'text' && typeof item['text'] === 'string') parts.push(item['text']);
  }
  return parts.join('\n');
}

function parseToolResult(record: Record<string, unknown>): Record<string, unknown> | null {
  const structured = record['structuredContent'];
  if (structured !== undefined && structured !== null) return asRecord(structured);
  const text = textOf(record['content']);
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface EngineMcpConfig {
  runId: string;
  serverIds: string[];
  /** Точка входа для движка: локальный stdio proxy. Значений credential binding'ов здесь нет. */
  broker: { command: string; args: string[] };
  /**
   * Координаты локального моста для broker'а. Это НЕ изоляционная граница: broker спавнится
   * движком из того же пользователя и того же workspace, поэтому run token виден движку.
   * Сдерживает приёмку не он, а host-side scoped bindings (инструмент и binding выбирает хост).
   */
  bridge: { url: string; runToken: string };
}

export interface McpRunSessionDeps {
  spec: RunSpec;
  scope: McpRunScope;
  log: McpLogger;
  registry?: CapabilityRegistry;
  /** Токен рана для unix-socket моста; только в памяти и в env дочерних процессов. */
  bridgeToken: string;
  /** Каталог для unix-сокета (владелец — ран, 0700). */
  bridgeDir?: string;
  killGraceMs?: number;
  brokerCommand?: { command: string; args: string[] };
  caller?: McpBridgeCaller;
  /** Идентичность рана (issue #51): MCP-серверы исполняются под ней, а не под service UID. */
  launcher?: ProcessLauncher | null;
  identity?: RunIdentity | null;
  /** run-scoped HOME/config/cache/tmp рана: сервер пишет только внутрь своей среды. */
  runEnv?: Record<string, string>;
}

/**
 * Сессия MCP рана: bridge + объявленные stdio-серверы (+ broker для движка).
 * Старт fail-closed: любой отказ (spawn/handshake/readiness/binding/unknown capability)
 * валит старт рана типизированной ошибкой, причина уходит в лог рана.
 */
export class McpRunSession {
  readonly bridgeUrl: string;
  readonly servers: McpServerSession[];
  private readonly deps: McpRunSessionDeps;
  private readonly bridge: McpBridgeServer;
  private disposed = false;

  private constructor(deps: McpRunSessionDeps, bridge: McpBridgeServer, servers: McpServerSession[]) {
    this.deps = deps;
    this.bridge = bridge;
    this.servers = servers;
    this.bridgeUrl = bridge.url;
  }

  static async start(deps: McpRunSessionDeps): Promise<McpRunSession> {
    const startedAt = Date.now();
    const declared = deps.scope.toolView();
    const registry = deps.registry;
    for (const tool of declared) {
      if (registry && !registry.has(tool.name)) {
        deps.log('error', 'mcp.server_start_failed', {
          serverId: tool.serverId,
          reason: 'capability_unknown',
          detail: `tool "${tool.name}" is declared for this run but is not registered in the host capability registry`,
        });
        throw new McpStartupError(tool.serverId, 'capability_unknown', `tool "${tool.name}" (server "${tool.serverId}") is not registered on this host`);
      }
    }

    // Сессии серверов наполняются ниже, но мост должен существовать до их спавна:
    // дочерние процессы подключаются к нему сразу (hello + capability/invoke).
    const servers: McpServerSession[] = [];
    // Сокет моста — внутри чистой среды рана, когда граница объявлена. Слишком длинный путь
    // для unix-сокета — отказ старта, а не уход сокета в общий tmpdir хоста.
    const socketPath = bridgeSocketPath(deps.bridgeDir ?? deps.spec.cwd, deps.spec.runId, { scoped: Boolean(deps.identity) });
    if (!socketPath) {
      const limit = BRIDGE_SOCKET_PATH_LIMIT;
      deps.log('error', 'mcp.bridge_socket_unavailable', {
        runId: deps.spec.runId,
        reason: 'path_too_long',
        limit,
        bridgeDir: deps.bridgeDir ?? deps.spec.cwd,
      });
      throw new McpStartupError(
        deps.scope.servers[0]?.serverId ?? 'bridge',
        'socket_path_too_long',
        `the run clean room path is longer than the unix-socket limit (${limit}); the bridge socket cannot live outside the run boundary`,
      );
    }
    const bridge = await McpBridgeServer.listen({
      socketPath,
      runToken: deps.bridgeToken,
      runId: deps.spec.runId,
      scope: deps.scope,
      registry: registry ?? null,
      log: deps.log,
      caller: deps.caller ?? {
        principalId: `${MCP_CLIENT_NAME}:run:${deps.spec.runId}`,
        profileId: deps.spec.profileId,
        userTaskId: deps.spec.userTaskId,
        runId: deps.spec.runId,
        operationId: deps.spec.operationId,
      },
      bindingValue: async (serverId: string) => {
        const scoped = deps.scope.server(serverId);
        if (!scoped || !scoped.binding) return undefined;
        return deps.scope.bindingValue(scoped).catch(() => undefined);
      },
      callTool: async (request: McpBridgeCallRequest): Promise<McpBridgeCallResult> => {
        const result = await callScopedTool(deps, servers, request.serverId, request.tool, request.arguments);
        return result.ok
          ? { ok: true, serverId: request.serverId, tool: request.tool, result: result.result }
          : { ok: false, serverId: request.serverId, tool: request.tool, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
      },
    });
    deps.log('info', 'mcp.bridge_ready', {
      runId: deps.spec.runId,
      serverCount: deps.scope.size,
      scopedTools: declared.length,
      socketPath,
    });

    const killGraceMs = deps.killGraceMs ?? DEFAULT_MCP_KILL_GRACE_MS;
    try {
      for (const scoped of deps.scope.servers) {
        const env: Record<string, string> = { ...(deps.runEnv ?? {}) };
        for (const name of scoped.spec.envAllowlist ?? []) {
          const value = process.env[name];
          if (value !== undefined) env[name] = value;
        }
        env['MCP_BRIDGE_URL'] = bridge.url;
        env['MCP_BRIDGE_TOKEN'] = deps.bridgeToken;
        env['MCP_RUN_ID'] = deps.spec.runId;
        env['MCP_SERVER_ID'] = scoped.serverId;
        env['MCP_ALLOWED_TOOLS'] = scoped.spec.allowedTools.join(',');
        servers.push(
          await McpServerSession.start({
            scoped,
            env,
            cwd: deps.spec.cwd,
            log: deps.log,
            killGraceMs,
            readinessTimeoutMs: scoped.spec.readinessTimeoutMs ?? DEFAULT_MCP_READINESS_TIMEOUT_MS,
            toolTimeoutMs: scoped.spec.toolTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS,
            launcher: deps.launcher ?? null,
            identity: deps.identity ?? null,
          }),
        );
      }
    } catch (err) {
      for (const server of servers) await server.close('sibling_start_failed');
      await bridge.close();
      throw err;
    }

    const session = new McpRunSession(deps, bridge, servers);
    deps.log('info', 'mcp.session_ready', {
      runId: deps.spec.runId,
      servers: servers.length,
      scopedTools: session.toolView().length,
      bindings: new Set(deps.scope.servers.map((entry) => entry.binding?.ref ?? 'none')).size,
      elapsedMs: Date.now() - startedAt,
    });
    return session;
  }

  /**
   * Конфиг для движка: команды + координаты локального моста. Значений credential binding'ов
   * здесь нет и быть не может — дочерние процессы получают только ref/scope.
   */
  engineConfig(): EngineMcpConfig {
    const broker = this.deps.brokerCommand ?? defaultBrokerCommand();
    return {
      runId: this.deps.spec.runId,
      serverIds: this.servers.map((server) => server.serverId),
      broker: { command: broker.command, args: [...broker.args] },
      bridge: { url: this.bridgeUrl, runToken: this.deps.bridgeToken },
    };
  }

  toolView(): ScopedToolView[] {
    const view: ScopedToolView[] = [];
    for (const server of this.servers) {
      const binding = this.deps.scope.server(server.serverId)?.binding;
      for (const tool of server.tools()) {
        view.push({ serverId: server.serverId, name: tool, bindingRef: binding?.ref ?? null, bindingScope: binding?.scope ?? null });
      }
    }
    return view;
  }

  async callTool(serverId: string, tool: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    return callScopedTool(this.deps, this.servers, serverId, tool, args);
  }

  async dispose(reason: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const server of this.servers) await server.close(reason);
    await this.bridge.close();
    this.deps.log('info', 'mcp.session_cleanup', { runId: this.deps.spec.runId, reason, servers: this.servers.length });
  }
}

function defaultBrokerCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [mcpFixturePath(MCP_FIXTURES.broker)],
  };
}

export const MCP_FIXTURES = {
  broker: 'run-mcp-broker.mjs',
  domainServer: 'stdio-domain-server.mjs',
  engineClient: 'mcp-engine-client.mjs',
} as const;

export function mcpFixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

export { RPC_ERROR_CODES };
