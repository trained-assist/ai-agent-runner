/**
 * Индекс модуля постоянного пользовательского workspace.
 *
 * Экспорт из `src/index.ts` намеренно НЕ добавлен: общий баррел runner'а — зона
 * интегратора, и параллельная правка того же файла была бы конфликтом двух потоков.
 * Интегратор подключает модуль точечным импортом (см. docs/workspace-module-hooks.md).
 */

export * from './contract.js';
export * from './policy.js';
export * from './ports.js';
export * from './journal.js';
export * from './tree.js';
export * from './service.js';
export { createLocalGitPort, candidateRefFor, CANDIDATE_REF_PREFIX, DEFAULT_BRANCH, DEFAULT_GIT_TIMEOUT_MS } from './git/local-git.js';
export { createGitHubRepositoryAdmin, GITHUB_API_BASE, GITHUB_API_VERSION } from './git/github-admin.js';
