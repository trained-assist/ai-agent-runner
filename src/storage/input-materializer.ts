import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InputRef } from '../contracts/run-spec.js';
import { writeFileAtomic } from '../runner/util.js';
import type { ArtifactStore } from './artifact-store.js';
import { sha256Hex } from './blob-store.js';
import { isStorageError, type StorageErrorCode } from './errors.js';
import { isSafeRelativePath, resolveInsideRoot } from './local-paths.js';
import type { WorkspaceSnapshot, WorkspaceSnapshotStore } from './workspace-snapshot.js';

/**
 * Материализация входов рана (issue #52, шаг 1).
 *
 * Байты между ранами лежат в долговечном хранилище, а снимок workspace — указатель на них
 * (`{ path, artifactId, sha256, size }`). Раскладка та же, что у экспорта: план проверяется
 * целиком, байты кладутся в staging и сверяются ПОСЛЕ записи на диск, и только потом
 * переносятся на место. Поэтому «checksum mismatch → отказ, ничего не пишется» выполняется
 * буквально: несовпадение на любом файле не оставляет в workspace рана ни одного байта
 * материализованного входа.
 *
 * Ставка «всё или ничего»: если хотя бы один ref не материализовался, не пишется ни один —
 * и ран получает отказ с причиной (см. `MaterializeReceipt`). Метод не бросает по входам:
 * любой отказ приезжает receipt'ом, чтобы «отказ» и «успех» читались одним способом.
 */
export const INPUTS_DIR = '.inputs';
/** Staging внутри каталога входов: его же эта стадия и снимает. */
const STAGING_DIR = '.staging';

export interface InputMaterializeLimits {
  /** Сколько ref со снимком допускается в одном ране. */
  refs: number;
  /** Сколько файлов допускается из одного снимка. */
  filesPerRef: number;
  /** Потолок на один файл. */
  fileBytes: number;
  /** Потолок на суммарный объём входов рана. */
  totalBytes: number;
}

export const DEFAULT_INPUT_LIMITS: InputMaterializeLimits = {
  refs: 32,
  filesPerRef: 256,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
};

export type MaterializeStatus =
  /** Файл(ы) сверены и лежат в workspace рана. */
  | 'materialized'
  /** Отказ без надежды на самоисцеление: чужой владелец, неизвестный/незакоммиченный снимок, битый дайджест. */
  | 'refused'
  /** Не удалось прочитать байты: хранилище недоступно, чтение оборвалось. Повтор имеет смысл. */
  | 'unavailable';

export type MaterializeOutcome = MaterializeStatus | 'nothing_to_materialize';

export interface MaterializeEntry {
  ref: string;
  snapshotId: string;
  status: MaterializeStatus;
  code: StorageErrorCode | null;
  files: number;
  bytes: number;
  reason: string | null;
  /** Относительные пути внутри workspace рана (без содержимого). */
  paths: string[];
}

export interface MaterializeReceipt {
  runId: string;
  profileId: string;
  /** Сколько ref объявлено входом рана (включая ref без снимка). */
  declared: number;
  /** Сколько ref запрашивали снимок. */
  requested: number;
  files: number;
  bytes: number;
  entries: MaterializeEntry[];
  status: MaterializeOutcome;
  reason: string | null;
}

export interface MaterializeTarget {
  runId: string;
  profileId: string;
  cwd: string;
}

export interface InputMaterializerOptions {
  snapshots: WorkspaceSnapshotStore;
  artifacts: ArtifactStore;
  limits?: Partial<InputMaterializeLimits>;
}

interface PlannedFile {
  /** Источник байт: артефакт берётся только из рана, породившего снимок. */
  sourceRunId: string;
  artifactId: string;
  path: string;
  sha256: string;
  size: number;
  /** Путь внутри staging. */
  stagedPath: string;
  /** Путь внутри workspace рана. */
  relativePath: string;
}

interface PlannedRef {
  ref: string;
  snapshotId: string;
  files: PlannedFile[];
  bytes: number;
}

class Refusal extends Error {
  readonly code: StorageErrorCode;
  readonly status: Exclude<MaterializeStatus, 'materialized'>;

  constructor(code: StorageErrorCode, message: string, status: Exclude<MaterializeStatus, 'materialized'>) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
    this.status = status;
  }
}

function refused(code: StorageErrorCode, message: string): Refusal {
  return new Refusal(code, message, 'refused');
}

function unavailable(code: StorageErrorCode, message: string): Refusal {
  return new Refusal(code, message, 'unavailable');
}

function asRefusal(err: unknown): Refusal {
  return err instanceof Refusal ? err : refused('MATERIALIZE_REF_INVALID', err instanceof Error ? err.message : String(err));
}

/**
 * Отказ хранилища переводится в статус ref'а: расхождение дайджеста лечится только
 * пересозданием байт, а «не прочитал»/`«не успел» — повторяемо. Смешивать их в один код
 * нельзя: клиент должен знать, есть ли смысл повторять попытку.
 */
function refusalFromStorageError(err: unknown, context: string): Refusal {
  if (isStorageError(err, 'BLOB_SHA_MISMATCH') || isStorageError(err, 'UPLOAD_HASH_MISMATCH')) {
    return refused(
      'MATERIALIZE_BYTES_MISMATCH',
      `${context}: stored bytes do not match the declared sha256 (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const code = isStorageError(err) ? err.code : 'unknown';
  const detail = err instanceof Error ? err.message : String(err);
  return unavailable('MATERIALIZE_REF_UNAVAILABLE', `${context}: durable storage could not be read (${code}): ${detail}`);
}

export class InputMaterializer {
  readonly snapshots: WorkspaceSnapshotStore;
  readonly artifacts: ArtifactStore;
  readonly limits: InputMaterializeLimits;

  constructor(options: InputMaterializerOptions) {
    this.snapshots = options.snapshots;
    this.artifacts = options.artifacts;
    this.limits = { ...DEFAULT_INPUT_LIMITS, ...(options.limits ?? {}) };
  }

  /**
   * Повторяем ли отказ: недоступное хранилище повторяемо, расхождение байт и чужой
   * владелец — нет. Читается по коду, а не по тексту причины.
   */
  static isRetryable(code: StorageErrorCode | null | undefined): boolean {
    return code === undefined || code === null || code === 'MATERIALIZE_REF_UNAVAILABLE';
  }

  stagingRoot(cwd: string): string {
    return join(cwd, INPUTS_DIR, STAGING_DIR);
  }

  /** Путь файла входа в workspace относительно cwd: `.inputs/<snapshotId>/<path>`. */
  relativeTarget(snapshotId: string, path: string): string {
    return `${INPUTS_DIR}/${snapshotId}/${path}`;
  }

  /** Каталог входов рана; null, если материализовывать было нечего. */
  inputsDir(cwd: string): string | null {
    const dir = join(cwd, INPUTS_DIR);
    return existsSync(dir) ? dir : null;
  }

  async materialize(refs: InputRef[], target: MaterializeTarget): Promise<MaterializeReceipt> {
    const requested = refs.filter((ref) => typeof ref.snapshotId === 'string' && ref.snapshotId !== '');
    if (requested.length === 0) {
      return {
        runId: target.runId,
        profileId: target.profileId,
        declared: refs.length,
        requested: 0,
        files: 0,
        bytes: 0,
        entries: [],
        status: 'nothing_to_materialize',
        reason: null,
      };
    }

    const plan: PlannedRef[] = [];
    let totalBytes = 0;
    try {
      if (requested.length > this.limits.refs) {
        throw refused(
          'MATERIALIZE_REF_INVALID',
          `run ${target.runId} requests ${requested.length} snapshot refs, the limit is ${this.limits.refs}`,
        );
      }
      for (const ref of requested) {
        const planned = this.planRef(ref, ref.snapshotId as string, target, totalBytes);
        totalBytes += planned.bytes;
        plan.push(planned);
      }
    } catch (err) {
      return this.failedReceipt(refs, requested, target, asRefusal(err));
    }

    try {
      await this.write(plan, target);
    } catch (err) {
      return this.failedReceipt(refs, requested, target, asRefusal(err));
    }

    return {
      runId: target.runId,
      profileId: target.profileId,
      declared: refs.length,
      requested: requested.length,
      files: plan.reduce((sum, item) => sum + item.files.length, 0),
      bytes: totalBytes,
      entries: plan.map((item) => ({
        ref: item.ref,
        snapshotId: item.snapshotId,
        status: 'materialized' as const,
        code: null,
        files: item.files.length,
        bytes: item.bytes,
        reason: null,
        paths: item.files.map((file) => file.relativePath),
      })),
      status: 'materialized',
      reason: null,
    };
  }

  /**
   * Отказ целиком: ни один ref не материализован, поэтому у всех один статус и одна
   * причина — ран не должен выглядеть так, будто часть входов доехала.
   */
  private failedReceipt(
    refs: InputRef[],
    requested: InputRef[],
    target: MaterializeTarget,
    refusal: Refusal,
  ): MaterializeReceipt {
    return {
      runId: target.runId,
      profileId: target.profileId,
      declared: refs.length,
      requested: requested.length,
      files: 0,
      bytes: 0,
      entries: requested.map((ref) => ({
        ref: ref.ref,
        snapshotId: ref.snapshotId as string,
        status: refusal.status,
        code: refusal.code,
        files: 0,
        bytes: 0,
        reason: refusal.message,
        paths: [],
      })),
      status: refusal.status,
      reason: refusal.message,
    };
  }

  /**
   * Планирование одного ref'а: снимок, владелец, статус, пути и указатели проверяются ДО
   * чтения байт и до любой записи. Владелец берётся из principal'а рана (profileId),
   * поэтому снимок чужого профиля недостижим в принципе, а не по совпадению имён.
   */
  private planRef(ref: InputRef, snapshotId: string, target: MaterializeTarget, alreadyPlannedBytes: number): PlannedRef {
    const snapshot = this.requireSnapshot(snapshotId, target);
    const linked = ref.path === undefined ? snapshot.artifacts : snapshot.artifacts.filter((item) => item.path === ref.path);
    if (linked.length === 0) {
      throw refused(
        'MATERIALIZE_REF_INVALID',
        ref.path === undefined
          ? `snapshot ${snapshotId} carries no materialized artifacts: ref "${ref.ref}" would start without the data it asked for`
          : `snapshot ${snapshotId} has no artifact "${ref.path}" for ref "${ref.ref}"`,
      );
    }
    if (linked.length > this.limits.filesPerRef) {
      throw refused(
        'MATERIALIZE_REF_INVALID',
        `snapshot ${snapshotId} holds ${linked.length} artifacts, the limit per ref is ${this.limits.filesPerRef}`,
      );
    }

    let bytes = 0;
    const files: PlannedFile[] = [];
    for (const item of linked) {
      if (!isSafeRelativePath(item.path)) {
        throw refused('MATERIALIZE_REF_INVALID', `snapshot ${snapshotId} points at an unsafe path "${item.path}"`);
      }
      if (item.size > this.limits.fileBytes) {
        throw refused(
          'MATERIALIZE_REF_INVALID',
          `snapshot ${snapshotId} artifact "${item.path}" is ${item.size} bytes, the limit per file is ${this.limits.fileBytes}`,
        );
      }
      const manifest = this.artifacts.getManifest(snapshot.runId, item.artifactId);
      if (!manifest) {
        throw refused(
          'MATERIALIZE_REF_INVALID',
          `snapshot ${snapshotId} points at artifact ${item.artifactId} of run ${snapshot.runId}, which is not in the artifact store`,
        );
      }
      if (manifest.profileId !== snapshot.profileId) {
        throw refused(
          'MATERIALIZE_REF_FOREIGN',
          `artifact ${item.artifactId} of run ${snapshot.runId} belongs to profile "${manifest.profileId}", the snapshot to "${snapshot.profileId}"`,
        );
      }
      if (manifest.sha256 !== item.sha256 || manifest.size !== item.size) {
        throw refused(
          'MATERIALIZE_REF_INVALID',
          `snapshot ${snapshotId} declares sha256 ${item.sha256.slice(0, 12)}…/${item.size} for "${item.path}", the stored manifest is ${manifest.sha256.slice(0, 12)}…/${manifest.size}`,
        );
      }
      const relativePath = this.relativeTarget(snapshotId, item.path);
      // resolveInsideRoot отвергает `..`, абсолютный путь и symlink наружу — даже если
      // такой путь попал в снимок мимо проверки link'а.
      resolveInsideRoot(target.cwd, relativePath, `input ref "${ref.ref}" path "${item.path}"`);
      bytes += item.size;
      files.push({
        sourceRunId: snapshot.runId,
        artifactId: item.artifactId,
        path: item.path,
        sha256: item.sha256,
        size: item.size,
        stagedPath: join(STAGING_DIR, snapshotId, ...item.path.split('/')),
        relativePath,
      });
    }
    if (alreadyPlannedBytes + bytes > this.limits.totalBytes) {
      throw refused(
        'MATERIALIZE_REF_INVALID',
        `ref "${ref.ref}" would take run ${target.runId} over the ${this.limits.totalBytes} byte limit for snapshot inputs`,
      );
    }
    return { ref: ref.ref, snapshotId, files, bytes };
  }

  private requireSnapshot(snapshotId: string, target: MaterializeTarget): WorkspaceSnapshot {
    let snapshot: WorkspaceSnapshot | null;
    try {
      snapshot = this.snapshots.get(snapshotId);
    } catch (err) {
      throw unavailable(
        'MATERIALIZE_REF_UNAVAILABLE',
        `snapshot ${snapshotId} could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!snapshot) {
      throw refused('MATERIALIZE_REF_INVALID', `snapshot ${snapshotId} does not exist`);
    }
    // Владелец ref'а — principal рана: снимок чужого профиля не материализуется никогда.
    if (snapshot.profileId !== target.profileId) {
      throw refused(
        'MATERIALIZE_REF_FOREIGN',
        `snapshot ${snapshotId} belongs to profile "${snapshot.profileId}", run ${target.runId} belongs to "${target.profileId}"`,
      );
    }
    if (snapshot.status !== 'committed') {
      throw refused(
        'MATERIALIZE_REF_INVALID',
        `snapshot ${snapshotId} is "${snapshot.status}": only a committed snapshot is a released pointer to durable bytes`,
      );
    }
    return snapshot;
  }

  /**
   * Запись входа: байты кладутся в staging, ДАЙДЖЕСТ СВЕРЯЕТСЯ ПО ФАКТУ ЗАПИСИ НА ДИСК,
   * и только после этого всё переносится на место. Отказ на любом файле снимает staging —
   * в workspace рана не остаётся ни одного байта входа.
   */
  private async write(plan: PlannedRef[], target: MaterializeTarget): Promise<void> {
    const staging = this.stagingRoot(target.cwd);
    // Staging никогда не переживает стадию: найденный остаток — от прошлого упавшего рана.
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      for (const item of plan) {
        for (const file of item.files) {
          const bytes = await this.readVerified(file);
          const stagedPath = join(staging, file.stagedPath);
          mkdirSync(dirname(stagedPath), { recursive: true });
          writeFileAtomic(stagedPath, bytes);
          // Сверяется то, что лежит на диске, а не то, что пришло из хранилища: диск —
          // последняя граница, и «записалось» здесь означает «записалось верно».
          const written = readFileSync(stagedPath);
          if (written.length !== file.size || sha256Hex(written) !== file.sha256) {
            throw refused(
              'MATERIALIZE_BYTES_MISMATCH',
              `staged "${file.relativePath}" does not match the declared digest (expected ${file.sha256.slice(0, 12)}…/${file.size}, got ${sha256Hex(written).slice(0, 12)}…/${written.length})`,
            );
          }
        }
      }
      for (const item of plan) {
        for (const file of item.files) {
          const stagedPath = join(staging, file.stagedPath);
          const finalPath = resolveInsideRoot(target.cwd, file.relativePath, `input ref "${item.ref}" path "${file.path}"`);
          mkdirSync(dirname(finalPath), { recursive: true });
          renameSync(stagedPath, finalPath);
        }
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
      // Каталог входов создаёт эта стадия: если после отказа он пуст, «ничего не писалось»
      // должно быть видно и по диску, а не только по счётчикам события.
      try {
        rmdirSync(join(target.cwd, INPUTS_DIR));
      } catch {
        // каталог не пуст (успешная материализация) или уже снят — это не ошибка
      }
    }
  }

  private async readVerified(file: PlannedFile): Promise<Buffer> {
    let read: Awaited<ReturnType<ArtifactStore['read']>>;
    try {
      read = await this.artifacts.read(file.sourceRunId, file.artifactId);
    } catch (err) {
      throw refusalFromStorageError(err, `artifact ${file.artifactId} of run ${file.sourceRunId} ("${file.path}")`);
    }
    if (read.bytes.length !== file.size || sha256Hex(read.bytes) !== file.sha256) {
      throw refused(
        'MATERIALIZE_BYTES_MISMATCH',
        `artifact ${file.artifactId} ("${file.path}") returned ${read.bytes.length} bytes with digest ${sha256Hex(read.bytes).slice(0, 12)}…, the snapshot declares ${file.size} bytes with ${file.sha256.slice(0, 12)}…`,
      );
    }
    return read.bytes;
  }
}