export type FaultPoint = 'preflight' | 'isolation' | 'mcp' | 'spawn' | 'heartbeat' | 'finalization' | 'export' | 'log_sink' | 'recovery';

export const FAULT_POINTS: readonly FaultPoint[] = ['preflight', 'isolation', 'mcp', 'spawn', 'heartbeat', 'finalization', 'export', 'log_sink', 'recovery'];

export interface FaultContext {
  point: FaultPoint;
  runId?: string;
}

export interface FaultSpec {
  kind: 'throw' | 'connection_lost' | 'custom';
  once?: boolean;
  count?: number;
  error?: Error;
  fn?: (ctx: FaultContext) => void | Promise<void>;
}

export class FaultInjectedError extends Error {
  readonly code = 'FAULT_INJECTED' as const;
  readonly point: FaultPoint;

  constructor(point: FaultPoint) {
    super(`fault injected at "${point}"`);
    this.name = 'FaultInjectedError';
    this.point = point;
  }
}

export class FaultRegistry {
  private readonly faults = new Map<FaultPoint, FaultSpec>();

  inject(point: FaultPoint, spec: FaultSpec = { kind: 'throw' }): void {
    this.faults.set(point, { ...spec });
  }

  clear(point?: FaultPoint): void {
    if (point) this.faults.delete(point);
    else this.faults.clear();
  }

  has(point: FaultPoint): boolean {
    return this.faults.has(point);
  }

  take(point: FaultPoint): FaultSpec | null {
    const spec = this.faults.get(point);
    if (!spec) return null;
    if (spec.count !== undefined) {
      if (spec.count <= 0) {
        this.faults.delete(point);
        return null;
      }
      spec.count -= 1;
      if (spec.count === 0) this.faults.delete(point);
      return spec;
    }
    if (spec.once) {
      this.faults.delete(point);
      return spec;
    }
    return spec;
  }
}
