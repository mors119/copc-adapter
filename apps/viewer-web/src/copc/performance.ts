export type CopcPerformanceStage = 'rangeFetch' | 'decode';

export type CopcPerformanceEvent = {
  stage: CopcPerformanceStage;
  durationMs: number;
  nodeKey?: string;
  /** Bytes returned by the range read, when the source can report them. */
  bytes?: number;
  /** False for decode work completed away from the UI thread. */
  blocksMainThread?: boolean;
};

export type CopcPerformanceObserver = (event: CopcPerformanceEvent) => void;

export function performanceNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
