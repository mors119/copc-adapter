export type CopcPerformanceStage = 'rangeFetch' | 'decode';

export type CopcPerformanceEvent = {
  stage: CopcPerformanceStage;
  durationMs: number;
  nodeKey?: string;
};

export type CopcPerformanceObserver = (event: CopcPerformanceEvent) => void;

export function performanceNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
