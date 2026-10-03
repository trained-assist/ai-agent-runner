import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateRunnerEvent, type RunnerEvent } from '../contracts/events.js';
import type { RunResult } from '../contracts/result.js';
import { redactRepositoryToken, type RunSpec } from '../contracts/run-spec.js';
import { isSafeId } from '../contracts/validate.js';
import { writeFileAtomic } from './util.js';
import type { RunState } from './state-machine.js';
import type { CleanRoomPaths, RunIdentity } from '../isolation/contract.js';

export const PERSISTED_STATE_SCHEMA_VERSION = 1 as const;

export interface PersistedExit {
  code: number | null;
  signal: string | null;
  observed: boolean;
  at: string;
}

/**
 * Живые процессы MCP рана (P13). Пишутся в state.json, чтобы перезапуск воркера мог
 * погасить осиротевшие per-run MCP-процессы, а не оставить их работать вхолостую.
 */
export interface PersistedMcpState {
  serverPids: Array<{ serverId: string; pid: number }>;
}

export interface PersistedRunState {
  schemaVersion: typeof PERSISTED_STATE_SCHEMA_VERSION;
  runId: string;
  jobId: string;
  operationId: string;
  userTaskId: string;
  profileId: string;
  ownerGeneration: number;
  state: RunState;
  sequence: number;
  connectionLost: boolean;
  orphanedPid: number | null;
  pid: number | null;
  pgid: number | null;
  startedAt: string | null;
  cancelRequested: 'cancel' | 'timeout' | null;
  workerCrashed: boolean;
  exit: PersistedExit | null;
  spec: RunSpec;
  finalized: boolean;
  result: RunResult | null;
  fencing: { rejected: number };
  mcp: PersistedMcpState | null;
  /**
   * Граница Agent clean room (issue #51). Пишется в state.json, поэтому аренда идентичности
   * переживает рестарт воркера: recover() дочищает слот, не переиспользуя его до
   * проверенного удаления каталогов рана.
   */
  cleanRoom: {
    identity: RunIdentity;
    paths: CleanRoomPaths;
    status: 'active' | 'sweeping' | 'released' | 'blocked';
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface OperationEntry {
  runId: string;
  specHash: string;
  createdAt: string;
}

export class RunStore {
  readonly rootDir: string;
  readonly runsDir: string;
  private readonly operationsPath: string;
  private readonly operations = new Map<string, OperationEntry>();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.runsDir = join(rootDir, 'runs');
    this.operationsPath = join(rootDir, 'operations.json');
  }

  init(): void {
    mkdirSync(this.runsDir, { recursive: true });
    if (existsSync(this.operationsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.operationsPath, 'utf8')) as Record<string, OperationEntry>;
        for (const [key, value] of Object.entries(parsed)) this.operations.set(key, value);
      } catch {
        // a torn operations index only loses dedup for unacknowledged operations
      }
    }
  }

  runDir(runId: string): string {
    if (!isSafeId(runId)) throw new Error(`unsafe runId: ${runId}`);
    return join(this.runsDir, runId);
  }

  statePath(runId: string): string {
    return join(this.runDir(runId), 'state.json');
  }

  resultPath(runId: string): string {
    return join(this.runDir(runId), 'result.json');
  }

  logPath(runId: string): string {
    return join(this.runDir(runId), 'events.jsonl');
  }

  relLogPath(runId: string): string {
    return `runs/${runId}/events.jsonl`;
  }

  saveState(state: PersistedRunState): void {
    // repository.token никогда не пишется на диск: секрет живёт только в памяти процесса до clone
    const persisted = { ...state, spec: redactRepositoryToken(state.spec) };
    writeFileAtomic(this.statePath(state.runId), `${JSON.stringify(persisted, null, 2)}\n`);
  }

  loadState(runId: string): PersistedRunState | null {
    const path = this.statePath(runId);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedRunState;
      return parsed.schemaVersion === PERSISTED_STATE_SCHEMA_VERSION ? parsed : null;
    } catch {
      return null;
    }
  }

  saveResult(runId: string, result: RunResult): void {
    writeFileAtomic(this.resultPath(runId), `${JSON.stringify(result, null, 2)}\n`);
  }

  listRunIds(): string[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafeId(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  readEvents(runId: string): RunnerEvent[] {
    const path = this.logPath(runId);
    if (!existsSync(path)) return [];
    const events: RunnerEvent[] = [];
    const content = readFileSync(path, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        const validated = validateRunnerEvent(parsed);
        if (validated.ok) events.push(validated.value);
      } catch {
        // torn trailing line after a crash is expected; state.json remains authoritative
      }
    }
    return events;
  }

  getOperation(operationId: string): OperationEntry | null {
    return this.operations.get(operationId) ?? null;
  }

  setOperation(operationId: string, entry: OperationEntry): void {
    this.operations.set(operationId, entry);
    const asRecord: Record<string, OperationEntry> = {};
    for (const [key, value] of this.operations) asRecord[key] = value;
    writeFileAtomic(this.operationsPath, `${JSON.stringify(asRecord, null, 2)}\n`);
  }
}
