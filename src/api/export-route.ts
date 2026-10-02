import { createHash } from 'node:crypto';
import type { AgentApi } from './service.js';
import type { RunExportStore } from '../storage/export.js';
import type { RunExportManifest } from '../storage/export-manifest.js';
import { createShareLink, type ShareTokenIssuer } from '../storage/share.js';
import type { KeyRegistry, Principal } from './auth.js';
import { ApiError } from './errors.js';

export const EXPORT_TOKEN_PARAM = 't';

export interface ExportRouteDeps {
  service: AgentApi;
  exports: RunExportStore;
  keys: KeyRegistry;
  tokens?: ShareTokenIssuer;
  /** База для ссылок вида share; без неё ссылка не выдаётся, а не выдаётся неверная. */
  baseUrl?: string;
}

export interface ExportView {
  runId: string;
  userTaskId: string;
  profileId: string;
  version: number;
  attempts: number;
  status: RunExportManifest['status'];
  partial: boolean;
  createdByRun: string;
  totals: RunExportManifest['totals'];
  cleanup: RunExportManifest['cleanup'];
  startedAt: string;
  updatedAt: string;
  committedAt: string | null;
  versions: number[];
  artifacts: ExportArtifactView[];
}

export interface ExportArtifactView {
  artifactId: string | null;
  sourcePath: string;
  name: string;
  mime: string;
  size: number;
  sha256: string | null;
  status: RunExportManifest['entries'][number]['status'];
  reason: string | null;
  localCopyRetained: boolean;
  /** Короткоживущая ссылка без профиля; null, если ссылка не выдаётся этой сборкой. */
  shareUrl: string | null;
  shareExpiresAt: string | null;
}

/**
 * Представление манифеста экспорта для клиента. Ссылки выдаются на артефакты,
 * которые действительно экспортированы: подтверждать клиенту нечего.
 */
export async function buildExportView(deps: ExportRouteDeps, principal: Principal, runId: string, ttlSeconds?: number): Promise<ExportView> {
  const manifest = deps.exports.read(runId);
  if (!manifest) {
    throw new ApiError('NOT_FOUND', `run ${runId} declares no exported artifacts`);
  }
  const artifacts: ExportArtifactView[] = [];
  for (const entry of manifest.entries) {
    let shareUrl: string | null = null;
    let shareExpiresAt: string | null = null;
    if (entry.status === 'exported' && entry.artifactId !== null) {
      const artifactManifest = deps.exports.artifacts.getManifest(runId, entry.artifactId);
      if (artifactManifest) {
        try {
          const link = await createShareLink({ blob: deps.exports.artifacts.blob, ...(deps.tokens ? { tokens: deps.tokens } : {}), ...(deps.baseUrl !== undefined ? { baseUrl: deps.baseUrl } : {}) }, artifactManifest, ttlSeconds !== undefined ? { ttlSeconds } : {});
          shareUrl = link.url;
          shareExpiresAt = link.expiresAt;
        } catch {
          // ссылка не выдаётся этой сборкой — клиент получает артефакт по API-ключу
          shareUrl = null;
          shareExpiresAt = null;
        }
      }
    }
    artifacts.push({
      artifactId: entry.artifactId,
      sourcePath: entry.sourcePath,
      name: entry.name,
      mime: entry.mime,
      size: entry.size,
      sha256: entry.sha256,
      status: entry.status,
      reason: entry.reason,
      localCopyRetained: entry.localCopyRetained,
      shareUrl,
      shareExpiresAt,
    });
  }
  return {
    runId: manifest.runId,
    userTaskId: manifest.userTaskId,
    profileId: manifest.profileId,
    version: manifest.version,
    attempts: manifest.attempts,
    status: manifest.status,
    partial: manifest.partial,
    createdByRun: manifest.createdByRun,
    totals: manifest.totals,
    cleanup: manifest.cleanup,
    startedAt: manifest.startedAt,
    updatedAt: manifest.updatedAt,
    committedAt: manifest.committedAt,
    versions: deps.exports.versions(runId),
    artifacts,
  };
}

/**
 * GET /v1/runs/{id}/export — прогресс и ошибки экспорта доступны клиенту.
 * POST /v1/runs/{id}/export — повторный commit; движок не запускается заново.
 */
export async function handleExportAction(
  deps: ExportRouteDeps,
  principal: Principal,
  runId: string,
  method: string,
  body: unknown,
): Promise<{ status: number; view: ExportView }> {
  if (method === 'GET') {
    return { status: 200, view: await buildExportView(deps, principal, runId) };
  }
  if (method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 'run export supports GET and POST only');
  const requestedTtl = readShareTtl(body);
  // повторный commit идёт по тому же пути, что и финализация: без запуска движка
  const manifest = await deps.service.runner.recommitExport(runId);
  if (!manifest) throw new ApiError('NOT_FOUND', `run ${runId} declares no exported artifacts to commit`);
  return { status: 200, view: await buildExportView(deps, principal, runId, requestedTtl) };
}

function readShareTtl(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'shareTtlSeconds') throw new ApiError('INVALID_REQUEST', `unknown field "${key}" in the export request body`);
  }
  const ttl = record['shareTtlSeconds'];
  if (ttl === undefined) return undefined;
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl <= 0 || ttl > 86_400) {
    throw new ApiError('INVALID_REQUEST', 'shareTtlSeconds: expected integer in [1, 86400]');
  }
  return ttl;
}

/** Диагностический отпечаток манифеста: удобно для логов и для сверки версий. */
export function exportFingerprint(manifest: RunExportManifest): string {
  return createHash('sha256')
    .update(`${manifest.runId}:${manifest.version}:${manifest.status}:${manifest.totals.exported}:${manifest.totals.failed}`)
    .digest('hex')
    .slice(0, 16);
}