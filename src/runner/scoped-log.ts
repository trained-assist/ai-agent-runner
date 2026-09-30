import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunnerEvent } from '../contracts/events.js';
import type { FaultRegistry } from '../faults/registry.js';

export type LogSink = (filePath: string, line: string) => void;

export const fileLogSink: LogSink = (filePath, line) => {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, line, 'utf8');
};

export class ScopedEventLog {
  private dropped = 0;

  constructor(
    private readonly sink: LogSink = fileLogSink,
    private readonly faults?: FaultRegistry,
  ) {}

  get droppedCount(): number {
    return this.dropped;
  }

  append(filePath: string, event: RunnerEvent): void {
    if (this.faults?.take('log_sink')) {
      this.dropped += 1;
      return;
    }
    try {
      this.sink(filePath, `${JSON.stringify(event)}\n`);
    } catch {
      this.dropped += 1;
    }
  }
}
