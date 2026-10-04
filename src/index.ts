/**
 * Публичная поверхность пакета. Раньше отсюда экспортировались модули жизненного цикла Run
 * (runner, движки, изоляция, storage, workspace, release, mcp, faults). После serverless-
 * переработки (epic #74) агента запускает внешний воркер, а API не хранит состояние, поэтому
 * всё это удалено: в пакете остались контракты, stateless-ядро API и адаптер воркера.
 */
export * from './contracts/index.js';
export * from './redact.js';
export * from './adapters/external-worker-adapter.js';
export * from './api/index.js';
