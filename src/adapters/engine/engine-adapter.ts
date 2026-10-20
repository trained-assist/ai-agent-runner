import type { RunSpec } from '../../contracts/run-spec.js';
import type { ProcessLauncher } from '../../isolation/launcher.js';
import type { RunIdentity } from '../../isolation/contract.js';

export type EngineLogStream = 'stdout' | 'stderr';

export interface EngineStartContext {
  spec: RunSpec;
  cwd: string;
  env: Record<string, string>;
  /**
   * Значения секретов окружения рана (credential binding'и, токены MCP, ключ модели).
   * Движок не должен оставлять их в персистентных артефактах рана: транскрипт сессии
   * уезжает в архив профиля, а рабочие файлы — в образ профиля.
   */
  secrets?: readonly string[];
  onLog: (stream: EngineLogStream, line: string) => void;
  /** Completed user-facing OpenCode message emitted before a tool-call step. */
  onAssistantMessage?: (message: { sessionId: string; messageId: string; text: string }) => void;
  /** A native OpenCode question that pauses headless execution for a user answer. */
  onAssistantQuestion?: (question: {
    sessionId: string;
    requestId: string;
    questions: Array<{ header: string; question: string; multiple: boolean; options: Array<{ label: string; description: string }> }>;
    toolCallId: string | null;
  }) => void;
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
