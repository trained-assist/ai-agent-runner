/**
 * Ветки рана: каждый ран публикует свой результат в отдельную ветку.
 *
 * Решение владельца 04.10.2026: ран не пишет прямо в основную ветку. Ветка рана — это
 * единица результата: в ней лежит всё, что ран сделал, её видно целиком, и merge — одно
 * системное действие без «грязного» состояния основной ветки.
 *
 * Имя ветки генерирует API, а не воркер: только API знает `runId`, поэтому имя уникально,
 * трассируемо до рана и не может столкнуться с ветками самого пользователя. Формат
 * согласован с внешним воркером (`agent-run/<runId>`, ai-agent-runner PR #75).
 *
 * Три уровня адреса, как в контракте внешнего воркера:
 * - файл — `…/blob/<commit>/<path>`;
 * - ветка рана целиком — `…/tree/<branch>`;
 * - куда мержить — `…/compare/<base>...<branch>`.
 */

import { WorkspaceError } from './contract.js';

export const RUN_BRANCH_PREFIX = 'agent-run';
export const SYNC_BRANCH_PREFIX = 'profile-sync';

const SAFE_BRANCH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `agent-run/<runId>` — имя ветки рана. `runId` обязан быть безопасным для git-ссылки. */
export function runBranchName(runId: string, prefix = RUN_BRANCH_PREFIX): string {
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 200 || !SAFE_BRANCH_SEGMENT.test(runId)) {
    throw new WorkspaceError('WORKSPACE_INVALID', `runId "${String(runId)}" cannot be a git branch segment`);
  }
  return `${prefix}/${runId}`;
}

/** Ветка host-синхронизации (publish без рана): тоже отдельная, а не основная. */
export function syncBranchName(publicationId: string, prefix = SYNC_BRANCH_PREFIX): string {
  if (typeof publicationId !== 'string' || publicationId.length === 0 || publicationId.length > 200 || !SAFE_BRANCH_SEGMENT.test(publicationId)) {
    throw new WorkspaceError('WORKSPACE_INVALID', `publicationId "${String(publicationId)}" cannot be a git branch segment`);
  }
  return `${prefix}/${publicationId}`;
}

export function isWorkspaceBranch(ref: string): boolean {
  return ref.startsWith(`refs/heads/${RUN_BRANCH_PREFIX}/`) || ref.startsWith(`refs/heads/${SYNC_BRANCH_PREFIX}/`);
}

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** Ссылка на файл в ветке рана: воркер/хост коммитит, мы только адресуем. */
export function artifactUrl(repository: string, commit: string, path: string): string {
  return `https://github.com/${repository}/blob/${commit}/${path}`;
}

/** Страница ветки: отсюда видно весь результат и GitHub сам предлагает merge/PR. */
export function branchUrl(repository: string, branch: string): string {
  return `https://github.com/${repository}/tree/${branch}`;
}

/** Ссылка на сравнение ветки с базой — место, где результат мержится. */
export function mergeUrl(repository: string, branch: string, baseRef: string | null): string {
  return baseRef ? `https://github.com/${repository}/compare/${baseRef}...${branch}` : branchUrl(repository, branch);
}
