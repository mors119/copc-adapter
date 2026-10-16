/** Pipeline stage measured by a backend performance observer. */
export type CopcPerformanceStage =
  /** HTTP or random-access byte-range read. */
  | 'rangeFetch'
  /** LAZ point-record decoding. */
  | 'decode'
  /** CRS transformation and renderer-neutral point preparation. */
  | 'pointPreparation';

/** One completed backend measurement; it does not include renderer or GPU frame time. */
export type CopcPerformanceEvent = {
  /** Operation measured. */
  stage: CopcPerformanceStage;
  /** Elapsed wall-clock duration in milliseconds. */
  durationMs: number;
  /** Hierarchy key for node-scoped decode/preparation work, when available. */
  nodeKey?: string;
  /** Bytes returned by the range read, when the source can report them. */
  bytes?: number;
  /** False for decode work completed away from the UI thread. */
  blocksMainThread?: boolean;
};

/** Receives completed source-side COPC performance measurements. */
export type CopcPerformanceObserver = (event: CopcPerformanceEvent) => void;

/** Return a monotonic high-resolution timestamp where available. */
export function performanceNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
