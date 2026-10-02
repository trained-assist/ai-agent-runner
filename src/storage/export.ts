import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSafeId } from '../contracts/validate.js';
import { writeFileAtomic } from '../runner/util.js';
import { ArtifactStore } from './artifact-store.js';
import type { ArtifactManifest } from './manifest.js';
import { StorageError } from './errors.js';
import {
  RUN_EXPORT_SCHEMA_VERSION,
  artifactNameFor,
  mimeForName,
  parseRunExportManifest,
  validateRunExportManifest,
  type CleanupDecision,
  type CleanupDecisionKind,
  type ExportContext,
  type ExportEntry,
  type ExportTotals,
  type RunExportManifest,
} from './export-manifest.js';
import { isRegularFile, resolveExistingInsideRoot } from './local-paths.js';

export interface PlannedOutput {
  /** Относительный путь внутри workspace ранда. */
  path: string;
  name?: string;
  mime?: string;
}

export interface RunExportStoreOptions {
  rootDir: string;
  artifacts: ArtifactStore;
  now?: () => Date;
  /** Удалять локальную копию после подтверждённого сохранения в object storage. */
  pruneLocalCopies?: boolean;
}

const NO_CLEANUP: CleanupDecision = { decision: 'nothing_to_prune', reason: 'no local copy was removed', retained: [] };

function assertId(value: unknown, field: string): string {
  if (!isSafeId(value)) throw new StorageError('ARTIFACT_EXPORT_INVALID', `invalid ${field}: expected an id matching [A-Za-z0-9][A-Za-z0-9._:-]*`);
  return value;
}

function computeTotals(entries: ExportEntry[]): ExportTotals {
  let exported = 0;
  let failed = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.status === 'exported') {
      exported += 1;
      bytes += entry.size;
    } else {
      failed += 1;
    }
  }
  return { planned: entries.length, exported, failed, bytes };
}

/**
 * Хранилище закоммиченных манифестов экспорта рана: `runs/<runId>/export/v<N>.json`
 * плюс указатель `latest.json`. Версии с терминальным статусом неизменяемы —
 * повторный commit пишет следующую версию, а не переписывает предыдущую.
 */
export class RunExportStore {
  readonly rootDir: string;
  readonly artifacts: ArtifactStore;
  readonly pruneLocalCopies: boolean;
  private readonly now: () => Date;

  constructor(options: RunExportStoreOptions) {
    if (typeof options.rootDir !== 'string' || options.rootDir.length === 0) {
      throw new StorageError('ARTIFACT_EXPORT_INVALID', 'run export store requires a data root directory');
    }
    this.rootDir = options.rootDir;
    this.artifacts = options.artifacts;
    this.now = options.now ?? (() => new Date());
    this.pruneLocalCopies = options.pruneLocalCopies ?? true;
  }

  exportDir(runId: string): string {
    return join(this.rootDir, 'runs', assertId(runId, 'runId'), 'export');
  }

  versionPath(runId: string, version: number): string {
    if (!Number.isInteger(version) || version < 1) {
      throw new StorageError('ARTIFACT_EXPORT_INVALID', `invalid export version: ${String(version)}`);
    }
    return join(this.exportDir(runId), `v${version}.json`);
  }

  latestPath(runId: string): string {
    return join(this.exportDir(runId), 'latest.json');
  }

  read(runId: string): RunExportManifest | null {
    const path = this.latestPath(runId);
    if (!existsSync(path)) return null;
    return parseRunExportManifest(readFileSync(path, 'utf8'), path);
  }

  readVersion(runId: string, version: number): RunExportManifest | null {
    const path = this.versionPath(runId, version);
    if (!existsSync(path)) return null;
    return parseRunExportManifest(readFileSync(path, 'utf8'), path);
  }

  versions(runId: string): number[] {
    const dir = this.exportDir(runId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((entry) => /^v\d+\.json$/.test(entry))
      .map((entry) => Number(entry.slice(1, -'.json'.length)))
      .filter((version) => Number.isInteger(version) && version > 0)
      .sort((a, b) => a - b);
  }

  /**
   * Открывает попытку экспорта: новая версия со статусом in_progress. Предыдущие
   * записи переносятся, чтобы прогресс после рестарта был виден, а не потерян.
   */
  begin(ctx: ExportContext, plan: PlannedOutput[]): RunExportManifest {
    const previous = this.read(ctx.runId);
    const at = this.now().toISOString();
    const entries = plan.map((output) => {
      const carried = previous?.entries.find((entry) => entry.sourcePath === output.path);
      if (carried && carried.status === 'exported') return { ...carried };
      const name = output.name ?? artifactNameFor(output.path);
      return {
        sourcePath: output.path,
        name,
        mime: output.mime ?? mimeForName(name),
        size: 0,
        sha256: null,
        artifactId: null,
        status: 'missing' as const,
        reason: 'not exported yet',
        localCopyRetained: true,
      };
    });
    const manifest: RunExportManifest = {
      schemaVersion: RUN_EXPORT_SCHEMA_VERSION,
      runId: ctx.runId,
      userTaskId: ctx.userTaskId,
      profileId: ctx.profileId,
      ownerGeneration: ctx.ownerGeneration,
      version: (previous?.version ?? 0) + 1,
      attempts: (previous?.attempts ?? 0) + 1,
      status: 'in_progress',
      partial: false,
      createdByRun: ctx.runId,
      entries,
      totals: computeTotals(entries),
      cleanup: NO_CLEANUP,
      startedAt: previous?.startedAt ?? at,
      updatedAt: at,
      committedAt: null,
    };
    return this.writeInProgress(manifest);
  }

  /** Запись прогресса по конкретному выходу; статус in_progress, поэтому версия переписывается. */
  record(ctx: ExportContext, sourcePath: string, patch: Partial<Omit<ExportEntry, 'sourcePath'>>): RunExportManifest {
    const current = this.requireDraft(ctx, sourcePath);
    const entries = current.entries.map((entry) => (entry.sourcePath === sourcePath ? { ...entry, ...patch } : entry));
    return this.writeInProgress({ ...current, entries, totals: computeTotals(entries) });
  }

  recordExported(ctx: ExportContext, sourcePath: string, manifest: ArtifactManifest): RunExportManifest {
    return this.record(ctx, sourcePath, {
      name: manifest.name,
      mime: manifest.mime,
      size: manifest.size,
      sha256: manifest.sha256,
      artifactId: manifest.artifactId,
      status: 'exported',
      reason: null,
      localCopyRetained: false,
    });
  }

  recordMissing(ctx: ExportContext, sourcePath: string, reason: string): RunExportManifest {
    return this.record(ctx, sourcePath, {
      status: 'missing',
      reason,
      localCopyRetained: true,
    });
  }

  recordFailure(ctx: ExportContext, sourcePath: string, reason: string): RunExportManifest {
    return this.record(ctx, sourcePath, {
      status: 'failed',
      reason,
      localCopyRetained: true,
    });
  }

  /**
   * Коммит манифеста экспорта. Локальные копии удаляются ТОЛЬКО здесь и только для
   * записей, чьё сохранение подтверждено чтением из object storage.
   */
  async commit(ctx: ExportContext, options: { prune?: boolean; cwd?: string } = {}): Promise<RunExportManifest> {
    const current = this.read(ctx.runId);
    if (!current) throw new StorageError('ARTIFACT_EXPORT_INVALID', `no export draft for run ${ctx.runId}`);
    if (current.status !== 'in_progress') {
      throw new StorageError('ARTIFACT_EXPORT_INVALID', `export of run ${ctx.runId} is already committed as "${current.status}" (version ${current.version})`);
    }
    const verified = current.entries.filter((entry) => entry.status === 'exported' && entry.artifactId !== null);
    const entries = verified.map((entry) => ({ ...entry }));
    const unverified = current.entries.filter((entry) => !(entry.status === 'exported' && entry.artifactId !== null));

    const shouldPrune = options.prune ?? this.pruneLocalCopies;
    const cwd = options.cwd ?? '';
    const pruned: string[] = [];
    for (const entry of entries) {
      if (!shouldPrune) break;
      // единственная копия удаляется только после подтверждённого чтения из хранилища
      const check = await this.artifacts.commit(ctx.runId, entry.artifactId as string);
      if (check.status === 'verified') {
        pruned.push(entry.sourcePath);
        removeFile(this.workspaceFile(cwd, entry.sourcePath));
      }
    }

    const keptEntries = entries.map((entry) => ({
      ...entry,
      localCopyRetained: !pruned.includes(entry.sourcePath),
    }));
    const allEntries = [...keptEntries, ...unverified];
    // любая не удалённая копия объявляется в retained: клиент видит, что осталось на диске
    const retained = allEntries.filter((entry) => entry.localCopyRetained).map((entry) => entry.sourcePath);

    let decision: CleanupDecisionKind = 'nothing_to_prune';
    let reason = 'no local copy was removed';
    if (unverified.length > 0) {
      decision = 'retained_sole_copy';
      reason = `${unverified.length} of ${allEntries.length} outputs are not durably stored; their local copy is the only copy and was kept`;
    } else if (pruned.length > 0) {
      decision = 'pruned';
      reason = `${pruned.length} local copies removed after a verified read-back from ${this.artifacts.blob.backend}`;
    } else if (retained.length > 0) {
      decision = 'retained_sole_copy';
      reason = 'local copies were kept on purpose: pruning is switched off for this store';
    }

    const at = this.now().toISOString();
    const totals = computeTotals(allEntries);
    const failed = totals.failed;
    const status = failed === 0 ? 'complete' : totals.exported === 0 ? 'failed' : 'partial';
    const manifest: RunExportManifest = {
      ...current,
      version: current.version + 1,
      status,
      partial: status === 'partial' || status === 'failed',
      entries: allEntries,
      totals,
      cleanup: { decision, reason, retained },
      updatedAt: at,
      committedAt: at,
    };
    return this.writeCommitted(manifest);
  }

  /**
   * Абсолютный путь локального файла выхода. Корень берётся из `spec.cwd` самого рана,
   * а не угадывается по соглашению об именах: иначе экспорт читал бы не тот каталог.
   */
  workspaceFile(cwd: string, sourcePath: string): string {
    return resolveExistingInsideRoot(cwd, sourcePath, 'spec.outputs[].path');
  }

  localCopyExists(cwd: string, sourcePath: string): boolean {
    try {
      return isRegularFile(this.workspaceFile(cwd, sourcePath));
    } catch {
      return false;
    }
  }

  private requireDraft(ctx: ExportContext, sourcePath: string): RunExportManifest {
    const current = this.read(ctx.runId);
    if (!current) throw new StorageError('ARTIFACT_EXPORT_INVALID', `no export draft for run ${ctx.runId}`);
    if (current.status !== 'in_progress') {
      throw new StorageError('ARTIFACT_EXPORT_INVALID', `export of run ${ctx.runId} is already committed as "${current.status}"`);
    }
    if (!current.entries.some((entry) => entry.sourcePath === sourcePath)) {
      throw new StorageError('ARTIFACT_EXPORT_INVALID', `output "${sourcePath}" is not declared in the export plan of run ${ctx.runId}`);
    }
    return current;
  }

  private writeInProgress(manifest: RunExportManifest): RunExportManifest {
    return this.write(manifest, this.versionPath(manifest.runId, manifest.version), true);
  }

  private writeCommitted(manifest: RunExportManifest): RunExportManifest {
    return this.write(manifest, this.versionPath(manifest.runId, manifest.version), false);
  }

  private write(manifest: RunExportManifest, path: string, mutable: boolean): RunExportManifest {
    const validated = validateRunExportManifest(manifest);
    if (!validated.ok) {
      throw new StorageError('ARTIFACT_EXPORT_INVALID', `refusing to persist an invalid run export manifest: ${validated.errors.join('; ')}`);
    }
    if (!mutable && existsSync(path)) {
      throw new StorageError('ARTIFACT_EXPORT_INVALID', `committed export version ${manifest.version} of run ${manifest.runId} already exists and is immutable`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, `${JSON.stringify(validated.value, null, 2)}\n`);
    writeFileAtomic(this.latestPath(manifest.runId), `${JSON.stringify(validated.value, null, 2)}\n`);
    return validated.value;
  }
}

function removeFile(path: string): void {
  rmSync(path, { force: true });
}