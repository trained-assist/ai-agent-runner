export type RunState = 'queued' | 'starting' | 'running' | 'finalizing' | 'succeeded' | 'failed' | 'cancelled';

export const RUN_STATES: readonly RunState[] = ['queued', 'starting', 'running', 'finalizing', 'succeeded', 'failed', 'cancelled'];

export const TERMINAL_STATES: readonly RunState[] = ['succeeded', 'failed', 'cancelled'];

const ALLOWED: Record<RunState, readonly RunState[]> = {
  queued: ['starting', 'failed', 'cancelled'],
  starting: ['running', 'finalizing', 'failed', 'cancelled'],
  running: ['finalizing'],
  finalizing: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isTerminalState(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: RunState, to: RunState): boolean {
  return ALLOWED[from].includes(to);
}
