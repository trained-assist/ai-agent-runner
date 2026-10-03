import {
  ErrorCollector,
  checkArray,
  checkKeys,
  checkObject,
  checkPositiveInt,
  checkSafeId,
  checkString,
  isEnvName,
  isRecord,
  isUtcTimestamp,
  type ValidationResult,
} from './validate.js';
import { isSafeRelativePath } from '../storage/local-paths.js';
import { isRegionId } from '../release/placement.js';
import { isIsolationMode, type IsolationMode } from '../isolation/contract.js';

export const RUN_SPEC_CONTRACT_VERSION = 1 as const;

export interface EngineModelSettings {
  model?: string;
  temperature?: number;
}

export interface EngineSpec {
  name: string;
  adapterVersion: string;
  modelSettings?: EngineModelSettings;
}

export interface InputRef {
  ref: string;
  version?: string;
}

export interface InputSpec {
  refs?: InputRef[];
  inlinePrompt?: string;
}

export interface CredentialBinding {
  ref: string;
  scope: string;
  expiresAt?: string;
  status?: 'active' | 'missing' | 'expired';
}

/**
 * Agent-local MCP: локальный stdio process/proxy, который runner поднимает на ран
 * (TASK-ROUTER-AND-MCP §5). `allowedTools` — приёмка хоста: инструмент вне списка
 * отказывается до похода в сервер, даже если дочерний процесс его запросит.
 * `bindingRef` обязан быть объявлен в `credentialBindings` рана; значение binding'а
 * остаётся в процессе хоста и в дочерний процесс не передаётся.
 */
export interface McpServerSpec {
  serverId: string;
  transport: 'stdio';
  command: string;
  args?: string[];
  envAllowlist?: string[];
  bindingRef?: string;
  allowedTools: string[];
  readinessTimeoutMs?: number;
  toolTimeoutMs?: number;
}

export interface McpSpec {
  servers: McpServerSpec[];
}

export const MCP_MAX_SERVERS = 8;
export const MCP_TIMEOUT_MAX_MS = 120_000;
export const MCP_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface BudgetSpec {
  correlationRef: string;
  approved: boolean;
  reason?: string;
}

export interface RegionConstraints {
  allowedRegions?: string[];
  /**
   * Где должны оставаться данные рана (`sandbox-ru`, `sandbox-eu`, …) или `none`, если
   * требования к резидентности нет. Решение о хранении утверждается отдельно (P30): пока
   * оно не принято, такой ран отказывается с DATA_RESIDENCY_UNDECIDED, а не угадывает регион.
   */
  dataResidency?: string;
}

export interface RepositorySpec {
  fullName: string;
  token?: string;
}

export const REPOSITORY_TOKEN_MAX_LENGTH = 500;

const REPOSITORY_FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

export function isFullRepositoryName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && REPOSITORY_FULL_NAME.test(value);
}

export interface RunLimits {
  timeoutMs: number;
  maxOutputBytes?: number;
  maxLogBytes?: number;
}

export interface ResultPolicy {
  destinationRef?: string;
  retentionPolicy?: string;
}

/**
 * Объявленные выходы рана: относительные пути внутри `cwd`, которые после завершения
 * исполнения уезжают в object storage и попадают в закоммиченный манифест экспорта.
 * Путь проверяется на выход из workspace при экспорте, а не при приёме запроса.
 */
export interface OutputSpec {
  path: string;
  name?: string;
  mime?: string;
}

export interface RunSpec {
  contractVersion: typeof RUN_SPEC_CONTRACT_VERSION;
  jobId: string;
  runId: string;
  operationId: string;
  userTaskId: string;
  profileId: string;
  conversationId: string;
  ownerGeneration: number;
  engine: EngineSpec;
  cwd: string;
  envAllowlist: string[];
  limits: RunLimits;
  deadline?: string;
  input?: InputSpec;
  isolation?: { mode: IsolationMode };
  regionConstraints?: RegionConstraints;
  credentialBindings?: CredentialBinding[];
  mcp?: McpSpec;
  budget?: BudgetSpec;
  result?: ResultPolicy;
  outputs?: OutputSpec[];
  traceId?: string;
  repository?: RepositorySpec;
}

const TOP_LEVEL_KEYS = [
  'contractVersion',
  'jobId',
  'runId',
  'operationId',
  'userTaskId',
  'profileId',
  'conversationId',
  'ownerGeneration',
  'engine',
  'cwd',
  'envAllowlist',
  'limits',
  'deadline',
  'input',
  'isolation',
  'regionConstraints',
  'credentialBindings',
  'mcp',
  'budget',
  'result',
  'outputs',
  'traceId',
  'repository',
] as const;

const TOP_LEVEL_REQUIRED = [
  'contractVersion',
  'jobId',
  'runId',
  'operationId',
  'userTaskId',
  'profileId',
  'conversationId',
  'ownerGeneration',
  'engine',
  'cwd',
  'envAllowlist',
  'limits',
] as const;

function validateEngine(value: unknown, path: string, collector: ErrorCollector): EngineSpec | undefined {
  if (!checkObject(value, path, collector)) return undefined;
  checkKeys(value, ['name', 'adapterVersion', 'modelSettings'], ['name', 'adapterVersion'], path, collector);
  const engine: EngineSpec = { name: '', adapterVersion: '' };
  checkString(value['name'], `${path}.name`, collector, 100);
  if (typeof value['name'] === 'string') engine.name = value['name'];
  checkString(value['adapterVersion'], `${path}.adapterVersion`, collector, 100);
  if (typeof value['adapterVersion'] === 'string') engine.adapterVersion = value['adapterVersion'];
  if (value['modelSettings'] !== undefined) {
    const ms = value['modelSettings'];
    if (!checkObject(ms, `${path}.modelSettings`, collector)) return engine;
    checkKeys(ms, ['model', 'temperature'], [], `${path}.modelSettings`, collector);
    const modelSettings: EngineModelSettings = {};
    if (ms['model'] !== undefined) {
      checkString(ms['model'], `${path}.modelSettings.model`, collector, 200);
      if (typeof ms['model'] === 'string') modelSettings.model = ms['model'];
    }
    if (ms['temperature'] !== undefined) {
      const t = ms['temperature'];
      if (typeof t !== 'number' || Number.isNaN(t) || t < 0 || t > 2) {
        collector.push(`${path}.modelSettings.temperature: expected number in [0, 2]`);
      } else {
        modelSettings.temperature = t;
      }
    }
    engine.modelSettings = modelSettings;
  }
  return engine;
}

function validateLimits(value: unknown, path: string, collector: ErrorCollector): RunLimits | undefined {
  if (!checkObject(value, path, collector)) return undefined;
  checkKeys(value, ['timeoutMs', 'maxOutputBytes', 'maxLogBytes'], ['timeoutMs'], path, collector);
  const limits: RunLimits = { timeoutMs: 0 };
  checkPositiveInt(value['timeoutMs'], `${path}.timeoutMs`, collector);
  if (typeof value['timeoutMs'] === 'number') limits.timeoutMs = value['timeoutMs'];
  for (const key of ['maxOutputBytes', 'maxLogBytes'] as const) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      collector.push(`${path}.${key}: expected positive integer`);
    } else {
      limits[key] = v;
    }
  }
  return limits;
}

function validateEnvAllowlist(value: unknown, path: string, collector: ErrorCollector): string[] {
  if (!checkArray(value, path, collector)) return [];
  if (value.length > 200) collector.push(`${path}: too many entries`);
  const names: string[] = [];
  value.forEach((entry, i) => {
    if (!isEnvName(entry)) {
      collector.push(`${path}[${i}]: expected environment variable NAME (no values, no "NAME=value")`);
      return;
    }
    names.push(entry);
  });
  return names;
}

function validateInput(value: unknown, path: string, collector: ErrorCollector): InputSpec | undefined {
  if (!checkObject(value, path, collector)) return undefined;
  checkKeys(value, ['refs', 'inlinePrompt'], [], path, collector);
  const input: InputSpec = {};
  if (value['refs'] !== undefined) {
    const refs = value['refs'];
    if (checkArray(refs, `${path}.refs`, collector)) {
      input.refs = refs.map((entry, i) => {
        const refPath = `${path}.refs[${i}]`;
        if (!checkObject(entry, refPath, collector)) return { ref: '' };
        checkKeys(entry, ['ref', 'version'], ['ref'], refPath, collector);
        const ref: InputRef = { ref: '' };
        checkString(entry['ref'], `${refPath}.ref`, collector, 500);
        if (typeof entry['ref'] === 'string') ref.ref = entry['ref'];
        if (entry['version'] !== undefined) {
          checkString(entry['version'], `${refPath}.version`, collector, 200);
          if (typeof entry['version'] === 'string') ref.version = entry['version'];
        }
        return ref;
      });
    }
  }
  if (value['inlinePrompt'] !== undefined) {
    checkString(value['inlinePrompt'], `${path}.inlinePrompt`, collector, 100_000);
    if (typeof value['inlinePrompt'] === 'string') input.inlinePrompt = value['inlinePrompt'];
  }
  return input;
}

function validateOutputs(value: unknown, path: string, collector: ErrorCollector): OutputSpec[] | undefined {
  if (!checkArray(value, path, collector)) return undefined;
  if (value.length > 100) {
    collector.push(`${path}: too many entries`);
    return undefined;
  }
  const seen = new Set<string>();
  return value.map((entry, i) => {
    const entryPath = `${path}[${i}]`;
    const output: OutputSpec = { path: '' };
    if (!checkObject(entry, entryPath, collector)) return output;
    checkKeys(entry, ['path', 'name', 'mime'], ['path'], entryPath, collector);
    if (typeof entry['path'] === 'string') output.path = entry['path'];
    if (output.path.length > 0 && !isSafeRelativePath(output.path)) {
      collector.push(`${entryPath}.path: expected a relative path inside the run workspace without "..", "." or a leading "/"`);
    }
    if (seen.has(output.path)) collector.push(`${entryPath}.path: duplicate output path "${output.path}"`);
    seen.add(output.path);
    if (entry['name'] !== undefined) {
      checkString(entry['name'], `${entryPath}.name`, collector, 200);
      if (typeof entry['name'] === 'string') {
        if (entry['name'].includes('/') || entry['name'].includes('\\')) {
          collector.push(`${entryPath}.name: a file name must not contain path separators`);
        }
        output.name = entry['name'];
      }
    }
    if (entry['mime'] !== undefined) {
      checkString(entry['mime'], `${entryPath}.mime`, collector, 100);
      if (typeof entry['mime'] === 'string') output.mime = entry['mime'];
    }
    return output;
  });
}

function validateRepository(value: unknown, path: string, collector: ErrorCollector): RepositorySpec | undefined {
  if (!checkObject(value, path, collector)) return undefined;
  checkKeys(value, ['fullName', 'token'], ['fullName'], path, collector);
  const repository: RepositorySpec = { fullName: '' };
  checkString(value['fullName'], `${path}.fullName`, collector, 200);
  if (typeof value['fullName'] === 'string' && !isFullRepositoryName(value['fullName'])) {
    collector.push(`${path}.fullName: expected "owner/name" (letters, digits, ".", "_", "-")`);
  }
  if (typeof value['fullName'] === 'string') repository.fullName = value['fullName'];
  if (value['token'] !== undefined) {
    checkString(value['token'], `${path}.token`, collector, REPOSITORY_TOKEN_MAX_LENGTH);
    if (typeof value['token'] === 'string' && value['token'].length > 0 && value['token'].length <= REPOSITORY_TOKEN_MAX_LENGTH) {
      repository.token = value['token'];
    }
  }
  return repository;
}

function validateCredentialBindings(value: unknown, path: string, collector: ErrorCollector): CredentialBinding[] | undefined {
  if (!checkArray(value, path, collector)) return undefined;
  return value.map((entry, i) => {
    const entryPath = `${path}[${i}]`;
    const binding: CredentialBinding = { ref: '', scope: '' };
    if (!checkObject(entry, entryPath, collector)) return binding;
    checkKeys(entry, ['ref', 'scope', 'expiresAt', 'status'], ['ref', 'scope'], entryPath, collector);
    checkString(entry['ref'], `${entryPath}.ref`, collector, 300);
    if (typeof entry['ref'] === 'string') binding.ref = entry['ref'];
    checkString(entry['scope'], `${entryPath}.scope`, collector, 300);
    if (typeof entry['scope'] === 'string') binding.scope = entry['scope'];
    if (entry['expiresAt'] !== undefined) {
      if (!isUtcTimestamp(entry['expiresAt'])) collector.push(`${entryPath}.expiresAt: expected UTC ISO timestamp`);
      else binding.expiresAt = entry['expiresAt'];
    }
    if (entry['status'] !== undefined) {
      if (entry['status'] !== 'active' && entry['status'] !== 'missing' && entry['status'] !== 'expired') {
        collector.push(`${entryPath}.status: expected active | missing | expired`);
      } else {
        binding.status = entry['status'];
      }
    }
    return binding;
  });
}

function validateMcpTimeout(value: unknown, path: string, collector: ErrorCollector): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MCP_TIMEOUT_MAX_MS) {
    collector.push(`${path}: expected an integer in [1, ${MCP_TIMEOUT_MAX_MS}]`);
    return undefined;
  }
  return value;
}

function validateMcpServer(value: unknown, path: string, collector: ErrorCollector): McpServerSpec | undefined {
  if (!checkObject(value, path, collector)) return undefined;
  checkKeys(
    value,
    ['serverId', 'transport', 'command', 'args', 'envAllowlist', 'bindingRef', 'allowedTools', 'readinessTimeoutMs', 'toolTimeoutMs'],
    ['serverId', 'transport', 'command', 'allowedTools'],
    path,
    collector,
  );
  const server: McpServerSpec = { serverId: '', transport: 'stdio', command: '', allowedTools: [] };

  checkSafeId(value['serverId'], `${path}.serverId`, collector);
  if (typeof value['serverId'] === 'string') server.serverId = value['serverId'];

  if (value['transport'] !== 'stdio') {
    collector.push(`${path}.transport: expected "stdio" (remote domain services are shared services, not per-run processes)`);
  }

  checkString(value['command'], `${path}.command`, collector, 512);
  if (typeof value['command'] === 'string') server.command = value['command'];

  if (value['args'] !== undefined) {
    const args = value['args'];
    if (checkArray(args, `${path}.args`, collector)) {
      if (args.length > 32) collector.push(`${path}.args: too many entries`);
      const parsed: string[] = [];
      args.forEach((entry, i) => {
        checkString(entry, `${path}.args[${i}]`, collector, 512);
        if (typeof entry === 'string') parsed.push(entry);
      });
      server.args = parsed;
    }
  }

  if (value['envAllowlist'] !== undefined) {
    const names = value['envAllowlist'];
    if (checkArray(names, `${path}.envAllowlist`, collector)) {
      if (names.length > 50) collector.push(`${path}.envAllowlist: too many entries`);
      const parsed: string[] = [];
      names.forEach((entry, i) => {
        if (!isEnvName(entry)) {
          collector.push(`${path}.envAllowlist[${i}]: expected environment variable NAME (no values)`);
          return;
        }
        parsed.push(entry);
      });
      server.envAllowlist = parsed;
    }
  }

  if (value['bindingRef'] !== undefined) {
    checkString(value['bindingRef'], `${path}.bindingRef`, collector, 300);
    if (typeof value['bindingRef'] === 'string') server.bindingRef = value['bindingRef'];
  }

  const allowedTools = value['allowedTools'];
  if (checkArray(allowedTools, `${path}.allowedTools`, collector)) {
    if (allowedTools.length === 0) collector.push(`${path}.allowedTools: at least one tool is required (a server without tools would be spawned for nothing)`);
    if (allowedTools.length > 50) collector.push(`${path}.allowedTools: too many entries`);
    const seen = new Set<string>();
    const parsed: string[] = [];
    allowedTools.forEach((entry, i) => {
      if (typeof entry !== 'string' || entry.length === 0 || entry.length > 200 || !MCP_TOOL_NAME.test(entry)) {
        collector.push(`${path}.allowedTools[${i}]: expected a tool name (letters, digits, "_", "-", ".")`);
        return;
      }
      if (seen.has(entry)) collector.push(`${path}.allowedTools[${i}]: duplicate tool "${entry}"`);
      seen.add(entry);
      parsed.push(entry);
    });
    server.allowedTools = parsed;
  }

  for (const key of ['readinessTimeoutMs', 'toolTimeoutMs'] as const) {
    if (value[key] === undefined) continue;
    const timeout = validateMcpTimeout(value[key], `${path}.${key}`, collector);
    if (timeout !== undefined) server[key] = timeout;
  }

  return server;
}

function validateMcp(value: unknown, path: string, collector: ErrorCollector): McpSpec | undefined {
  if (!checkObject(value, path, collector)) return undefined;
  checkKeys(value, ['servers'], ['servers'], path, collector);
  const servers = value['servers'];
  if (!checkArray(servers, `${path}.servers`, collector)) return undefined;
  if (servers.length === 0) {
    collector.push(`${path}.servers: expected at least one server`);
    return undefined;
  }
  if (servers.length > MCP_MAX_SERVERS) collector.push(`${path}.servers: at most ${MCP_MAX_SERVERS} servers per run`);
  const parsed: McpServerSpec[] = [];
  const seen = new Set<string>();
  const toolOwner = new Map<string, string>();
  servers.forEach((entry, i) => {
    const server = validateMcpServer(entry, `${path}.servers[${i}]`, collector);
    if (!server) return;
    if (server.serverId === '') return;
    if (seen.has(server.serverId)) collector.push(`${path}.servers: duplicate serverId "${server.serverId}"`);
    seen.add(server.serverId);
    // Имена MCP-инструментов образуют одно плоское пространство имён у клиента рана:
    // один инструмент = один server, иначе вызов неоднозначен.
    for (const tool of server.allowedTools) {
      const owner = toolOwner.get(tool);
      if (owner !== undefined) {
        collector.push(`${path}.servers[${i}].allowedTools: tool "${tool}" is already declared by server "${owner}"`);
      } else {
        toolOwner.set(tool, server.serverId);
      }
    }
    parsed.push(server);
  });
  return { servers: parsed };
}

function validateBudget(value: unknown, path: string, collector: ErrorCollector): BudgetSpec | undefined {
  if (!checkObject(value, path, collector)) return undefined;
  checkKeys(value, ['correlationRef', 'approved', 'reason'], ['correlationRef', 'approved'], path, collector);
  const budget: BudgetSpec = { correlationRef: '', approved: false };
  checkString(value['correlationRef'], `${path}.correlationRef`, collector, 300);
  if (typeof value['correlationRef'] === 'string') budget.correlationRef = value['correlationRef'];
  if (typeof value['approved'] !== 'boolean') collector.push(`${path}.approved: expected boolean`);
  else budget.approved = value['approved'];
  if (value['reason'] !== undefined) {
    checkString(value['reason'], `${path}.reason`, collector, 300);
    if (typeof value['reason'] === 'string') budget.reason = value['reason'];
  }
  return budget;
}

export function validateRunSpec(input: unknown): ValidationResult<RunSpec> {
  const collector = new ErrorCollector();
  if (!checkObject(input, 'spec', collector)) return collector.finish(undefined as never);
  checkKeys(input, TOP_LEVEL_KEYS, TOP_LEVEL_REQUIRED, 'spec', collector);

  if (input['contractVersion'] !== RUN_SPEC_CONTRACT_VERSION) {
    collector.push(`spec.contractVersion: expected ${RUN_SPEC_CONTRACT_VERSION}`);
  }

  for (const key of ['jobId', 'runId', 'operationId'] as const) {
    if (key in input) checkSafeId(input[key], `spec.${key}`, collector);
  }
  for (const key of ['userTaskId', 'profileId', 'conversationId'] as const) {
    if (key in input) checkString(input[key], `spec.${key}`, collector, 200);
  }

  if ('ownerGeneration' in input) {
    const gen = input['ownerGeneration'];
    if (typeof gen !== 'number' || !Number.isInteger(gen) || gen < 0) {
      collector.push('spec.ownerGeneration: expected non-negative integer');
    }
  }

  const engine = 'engine' in input ? validateEngine(input['engine'], 'spec.engine', collector) : undefined;

  if ('cwd' in input) {
    const cwd = input['cwd'];
    if (typeof cwd !== 'string' || cwd.length === 0) {
      collector.push('spec.cwd: expected non-empty string');
    } else if (!(cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd))) {
      collector.push('spec.cwd: expected absolute path');
    }
  }

  const envAllowlist = 'envAllowlist' in input ? validateEnvAllowlist(input['envAllowlist'], 'spec.envAllowlist', collector) : [];
  const limits = 'limits' in input ? validateLimits(input['limits'], 'spec.limits', collector) : undefined;

  if ('deadline' in input && input['deadline'] !== undefined && !isUtcTimestamp(input['deadline'])) {
    collector.push('spec.deadline: expected UTC ISO timestamp');
  }
  if ('traceId' in input && input['traceId'] !== undefined) {
    checkString(input['traceId'], 'spec.traceId', collector, 200);
  }

  let inputSpec: InputSpec | undefined;
  if ('input' in input && input['input'] !== undefined) inputSpec = validateInput(input['input'], 'spec.input', collector);

  let isolation: { mode: IsolationMode } | undefined;
  if ('isolation' in input && input['isolation'] !== undefined) {
    const iso = input['isolation'];
    if (checkObject(iso, 'spec.isolation', collector)) {
      checkKeys(iso, ['mode'], ['mode'], 'spec.isolation', collector);
      checkString(iso['mode'], 'spec.isolation.mode', collector, 100);
      if (typeof iso['mode'] === 'string' && !isIsolationMode(iso['mode'])) {
        collector.push('spec.isolation.mode: expected per_run_unix_identity | none');
      } else if (typeof iso['mode'] === 'string') {
        isolation = { mode: iso['mode'] as IsolationMode };
      }
    }
  }

  let regionConstraints: RegionConstraints | undefined;
  if ('regionConstraints' in input && input['regionConstraints'] !== undefined) {
    const rc = input['regionConstraints'];
    if (checkObject(rc, 'spec.regionConstraints', collector)) {
      checkKeys(rc, ['allowedRegions', 'dataResidency'], [], 'spec.regionConstraints', collector);
      if (rc['allowedRegions'] !== undefined) {
        const list = rc['allowedRegions'];
        if (checkArray(list, 'spec.regionConstraints.allowedRegions', collector)) {
          const allowed: string[] = [];
          list.forEach((entry, i) => {
            checkString(entry, `spec.regionConstraints.allowedRegions[${i}]`, collector, 50);
            if (typeof entry === 'string') allowed.push(entry);
          });
          regionConstraints = { ...(regionConstraints ?? {}), allowedRegions: allowed };
        }
      }
      if (rc['dataResidency'] !== undefined) {
        const residency = rc['dataResidency'];
        checkString(residency, 'spec.regionConstraints.dataResidency', collector, 50);
        if (typeof residency === 'string' && residency !== 'none' && !isRegionId(residency)) {
          collector.push('spec.regionConstraints.dataResidency: expected a region id like "sandbox-ru" or "none"');
        }
        if (typeof residency === 'string') regionConstraints = { ...(regionConstraints ?? {}), dataResidency: residency };
      }
    }
  }

  const credentialBindings =
    'credentialBindings' in input && input['credentialBindings'] !== undefined
      ? validateCredentialBindings(input['credentialBindings'], 'spec.credentialBindings', collector)
      : undefined;

  let mcp: McpSpec | undefined;
  if ('mcp' in input && input['mcp'] !== undefined) {
    mcp = validateMcp(input['mcp'], 'spec.mcp', collector);
    // Статическая половина scoped bindings: MCP-сервер ранa не может ссылаться на binding,
    // который ран не объявил. Вторую половину (scope/права) проверяет McpRunScope в рантайме.
    if (mcp && credentialBindings) {
      const declared = new Set(credentialBindings.filter((binding) => binding.ref !== '').map((binding) => binding.ref));
      mcp.servers.forEach((server, i) => {
        if (!server.bindingRef) return;
        if (!declared.has(server.bindingRef)) {
          collector.push(`spec.mcp.servers[${i}].bindingRef: "${server.bindingRef}" is not declared in spec.credentialBindings`);
        }
      });
    }
  }

  const budget = 'budget' in input && input['budget'] !== undefined ? validateBudget(input['budget'], 'spec.budget', collector) : undefined;

  let result: ResultPolicy | undefined;
  if ('result' in input && input['result'] !== undefined) {
    const res = input['result'];
    if (checkObject(res, 'spec.result', collector)) {
      checkKeys(res, ['destinationRef', 'retentionPolicy'], [], 'spec.result', collector);
      const policy: ResultPolicy = {};
      if (res['destinationRef'] !== undefined) {
        checkString(res['destinationRef'], 'spec.result.destinationRef', collector, 300);
        if (typeof res['destinationRef'] === 'string') policy.destinationRef = res['destinationRef'];
      }
      if (res['retentionPolicy'] !== undefined) {
        checkString(res['retentionPolicy'], 'spec.result.retentionPolicy', collector, 100);
        if (typeof res['retentionPolicy'] === 'string') policy.retentionPolicy = res['retentionPolicy'];
      }
      result = policy;
    }
  }

  let outputs: OutputSpec[] | undefined;
  if ('outputs' in input && input['outputs'] !== undefined) {
    outputs = validateOutputs(input['outputs'], 'spec.outputs', collector);
  }

  let repository: RepositorySpec | undefined;
  if ('repository' in input && input['repository'] !== undefined && input['repository'] !== null) {
    const repo = input['repository'];
    // пустая группа ({} или null) = дефолтная репозиторий-контекст (см. runner/repository)
    if (!(isRecord(repo) && Object.keys(repo).length === 0)) {
      repository = validateRepository(repo, 'spec.repository', collector);
    }
  }

  if (!collector.ok) return collector.finish(undefined as never);

  const spec: RunSpec = {
    contractVersion: RUN_SPEC_CONTRACT_VERSION,
    jobId: input['jobId'] as string,
    runId: input['runId'] as string,
    operationId: input['operationId'] as string,
    userTaskId: input['userTaskId'] as string,
    profileId: input['profileId'] as string,
    conversationId: input['conversationId'] as string,
    ownerGeneration: input['ownerGeneration'] as number,
    engine: engine as EngineSpec,
    cwd: input['cwd'] as string,
    envAllowlist,
    limits: limits as RunLimits,
  };
  if (input['deadline'] !== undefined) spec.deadline = input['deadline'] as string;
  if (inputSpec !== undefined) spec.input = inputSpec;
  if (isolation !== undefined) spec.isolation = isolation;
  if (regionConstraints !== undefined) spec.regionConstraints = regionConstraints;
  if (credentialBindings !== undefined) spec.credentialBindings = credentialBindings;
  if (mcp !== undefined) spec.mcp = mcp;
  if (budget !== undefined) spec.budget = budget;
  if (result !== undefined) spec.result = result;
  if (outputs !== undefined) spec.outputs = outputs;
  if (input['traceId'] !== undefined) spec.traceId = input['traceId'] as string;
  if (repository !== undefined) spec.repository = repository;

  return collector.finish(spec);
}

/**
 * Возвращает копию value без repository.token: токен не должен попадать в хэши
 * (specHash/payloadHash), state-файлы и admissions store — «на диске секретов нет».
 */
export function redactRepositoryToken<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const repository = record['repository'];
  if (repository === null || typeof repository !== 'object' || Array.isArray(repository)) return value;
  if (!('token' in repository)) return value;
  const cleanedRepository = { ...(repository as Record<string, unknown>) };
  delete cleanedRepository['token'];
  return { ...record, repository: cleanedRepository } as T;
}

/**
 * Вычищает repository.token из живой структуры после попытки clone
 * (и из admission-записи после передачи токена в runner).
 */
export function stripRepositoryToken(spec: { repository?: RepositorySpec }): void {
  const repository = spec.repository;
  if (repository && 'token' in repository) delete repository.token;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}
