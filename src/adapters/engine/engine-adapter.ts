import type { RunSpec } from '../../contracts/run-spec.js';
import type { ProcessLauncher } from '../../isolation/launcher.js';
import type { RunIdentity } from '../../isolation/contract.js';

export type EngineLogStream = 'stdout' | 'stderr';

export interface EngineStartContext {
  spec: RunSpec;
  cwd: string;
  env: Record<string, string>;
  onLog: (stream: EngineLogStream, line: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
  /**
   * Идентичичность рана (issue #51). Присутствует только когда хост поднял границу:
   * движок обязан стартовать под ней, а не под service UID Runner'а.
   */
  identity?: RunIdentity;
  /** Лаунчер переключения идентичности (setpriv/runuser). */
  launcher?: ProcessLauncher;
}

export interface EngineHandle {
  readonly pid: number | null;
  readonly pgid: number | null;
  killTree: (signal?: NodeJS.Signals) => void;
  dispose: () => void;
}

export interface EngineAdapter {
  readonly name: string;
  start: (ctx: EngineStartContext) => Promise<EngineHandle>;
}
