import type { ProcessLauncher } from '../../isolation/launcher.js';
import type { RunIdentity } from '../../isolation/contract.js';
import type { EngineStartContext } from './engine-adapter.js';

/**
 * Команда запуска движка. Когда у рана есть своя Unix-идентичность, движок оборачивается
 * лаунчером (setpriv/runuser) и стартует без дополнительных групп Runner'а. Без
 * идентичности — прямой запуск (одиночная установка без настроенной границы).
 */
export function launchCommand(
  ctx: EngineStartContext,
  binary: string,
  argv: string[],
): { command: string; args: string[] } {
  if (ctx.launcher && ctx.identity) return ctx.launcher.wrap(ctx.identity, binary, argv);
  return { command: binary, args: argv };
}

export function hasRunIdentity(ctx: EngineStartContext): boolean {
  return Boolean(ctx.launcher && ctx.identity);
}

export type { ProcessLauncher, RunIdentity };
