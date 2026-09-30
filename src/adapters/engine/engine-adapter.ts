import type { RunSpec } from '../../contracts/run-spec.js';

export type EngineLogStream = 'stdout' | 'stderr';

export interface EngineStartContext {
  spec: RunSpec;
  cwd: string;
  env: Record<string, string>;
  onLog: (stream: EngineLogStream, line: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
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
