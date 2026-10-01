import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunSpec } from '../contracts/run-spec.js';
import { writeFileAtomic } from '../runner/util.js';

export const API_STORE_SCHEMA_VERSION = 1 as const;

export interface AdmissionRecord {
  schemaVersion: typeof API_STORE_SCHEMA_VERSION;
  requestId: string;
  userTaskId: string;
  principalId: string;
  jobId: string;
  idempotencyKey: string;
  payloadHash: string;
  runId: string;
  operationId: string;
  ownerGeneration: number;
  spec: RunSpec;
  createdAt: string;
}

interface StoreFile {
  schemaVersion: number;
  admissions: AdmissionRecord[];
}

export class ApiStore {
  readonly apiDir: string;
  private readonly admissionsPath: string;
  private readonly byIdempotency = new Map<string, AdmissionRecord>();
  private readonly byRun = new Map<string, AdmissionRecord>();
  private readonly byTask = new Map<string, AdmissionRecord[]>();

  constructor(rootDir: string) {
    this.apiDir = join(rootDir, 'api');
    this.admissionsPath = join(this.apiDir, 'admissions.json');
  }

  init(): void {
    if (!existsSync(this.admissionsPath)) return;
    const parsed = JSON.parse(readFileSync(this.admissionsPath, 'utf8')) as StoreFile;
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.admissions)) {
      throw new Error('api store: admissions file is malformed');
    }
    if (parsed.schemaVersion !== API_STORE_SCHEMA_VERSION) {
      throw new Error(`api store: unsupported schemaVersion ${String(parsed.schemaVersion)}`);
    }
    for (const record of parsed.admissions) this.index(record);
  }

  getByAdmission(principalId: string, idempotencyKey: string): AdmissionRecord | null {
    return this.byIdempotency.get(admissionIndexKey(principalId, idempotencyKey)) ?? null;
  }

  getByRun(runId: string): AdmissionRecord | null {
    return this.byRun.get(runId) ?? null;
  }

  attempts(principalId: string, userTaskId: string): AdmissionRecord[] {
    const list = this.byTask.get(taskIndexKey(principalId, userTaskId)) ?? [];
    return [...list].sort((a, b) => a.ownerGeneration - b.ownerGeneration);
  }

  currentAttempt(principalId: string, userTaskId: string): AdmissionRecord | null {
    const attempts = this.attempts(principalId, userTaskId);
    return attempts.length > 0 ? attempts[attempts.length - 1]! : null;
  }

  listAll(): AdmissionRecord[] {
    return [...this.byIdempotency.values()];
  }

  put(record: AdmissionRecord): void {
    this.index(record);
    this.persist();
  }

  private index(record: AdmissionRecord): void {
    this.byIdempotency.set(admissionIndexKey(record.principalId, record.idempotencyKey), record);
    this.byRun.set(record.runId, record);
    const taskKey = taskIndexKey(record.principalId, record.userTaskId);
    const list = this.byTask.get(taskKey);
    if (list) {
      const existing = list.findIndex((entry) => entry.runId === record.runId);
      if (existing >= 0) list[existing] = record;
      else list.push(record);
    } else {
      this.byTask.set(taskKey, [record]);
    }
  }

  private persist(): void {
    const file: StoreFile = {
      schemaVersion: API_STORE_SCHEMA_VERSION,
      admissions: [...this.byIdempotency.values()],
    };
    writeFileAtomic(this.admissionsPath, `${JSON.stringify(file, null, 2)}\n`);
  }
}

function admissionIndexKey(principalId: string, idempotencyKey: string): string {
  return `${principalId}\u0000${idempotencyKey}`;
}

function taskIndexKey(principalId: string, userTaskId: string): string {
  return `${principalId}\u0000${userTaskId}`;
}
