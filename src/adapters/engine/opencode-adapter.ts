import { spawn } from 'node:child_process';
import { EngineStartupError } from '../../contracts/validate.js';
import type { RunSpec } from '../../contracts/run-spec.js';
import type { EngineAdapter, EngineHandle, EngineStartContext } from './engine-adapter.js';
import { findOnPath, handleForChild, isExecutableFile } from './process-tree.js';

export interface OpenCodeAdapterOptions {
  binary?: string;
  argv?: string[];
}

function defaultArgv(spec: RunSpec): string[] {
  const prompt = spec.input?.inlinePrompt;
  if (!prompt) {
    throw new EngineStartupError('opencode run requires a host-resolved input.inlinePrompt');
  }
  return ['run', prompt];
}

export class OpenCodeAdapter implements EngineAdapter {
  readonly name = 'opencode';
  private readonly options: OpenCodeAdapterOptions;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.options = options;
  }

  resolveBinary(): string | null {
    if (this.options.binary) return isExecutableFile(this.options.binary) ? this.options.binary : null;
    return findOnPath('opencode');
  }

  isAvailable(): boolean {
    return this.resolveBinary() !== null;
  }

  async start(ctx: EngineStartContext): Promise<EngineHandle> {
    const binary = this.resolveBinary();
    if (!binary) {
      throw new EngineStartupError('opencode binary is not available on this host');
    }
    const argv = this.options.argv ?? defaultArgv(ctx.spec);
    const child = spawn(binary, argv, {
      cwd: ctx.cwd,
      env: ctx.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return handleForChild(child, { onLog: ctx.onLog, onExit: ctx.onExit });
  }
}
