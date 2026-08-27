import { performanceNow } from '../../copc/performance';

export type StreamingPerformanceSnapshot = {
  updateDurationMs: number;
  nodeSelectionMs: number;
  selectedNodeCount: number;
  estimatedSelectedPointCount: number;
  loadedNodeCount: number;
  loadedPointCount: number;
  rangeFetchDurationMs: number;
  decodeDurationMs: number;
  crsTransformDurationMs: number;
  geographicToCartesianDurationMs: number;
  pointStylePreparationDurationMs: number;
  pointCollectionCreationDurationMs: number;
  pointAddDurationMs: number;
  longestMainThreadBlockingSectionMs: number;
};

function emptySnapshot(): StreamingPerformanceSnapshot {
  return {
    updateDurationMs: 0,
    nodeSelectionMs: 0,
    selectedNodeCount: 0,
    estimatedSelectedPointCount: 0,
    loadedNodeCount: 0,
    loadedPointCount: 0,
    rangeFetchDurationMs: 0,
    decodeDurationMs: 0,
    crsTransformDurationMs: 0,
    geographicToCartesianDurationMs: 0,
    pointStylePreparationDurationMs: 0,
    pointCollectionCreationDurationMs: 0,
    pointAddDurationMs: 0,
    longestMainThreadBlockingSectionMs: 0,
  };
}

/** Lightweight per-update timings used by the debug panel and benchmarks. */
export class StreamingPerformanceRecorder {
  private snapshot = emptySnapshot();
  private updateStartedAt = 0;

  beginUpdate(): void {
    this.snapshot = emptySnapshot();
    this.updateStartedAt = performanceNow();
  }

  setSelection(selectedNodeCount: number, estimatedSelectedPointCount: number, durationMs: number): void {
    this.snapshot.selectedNodeCount = selectedNodeCount;
    this.snapshot.estimatedSelectedPointCount = estimatedSelectedPointCount;
    this.snapshot.nodeSelectionMs = durationMs;
    this.snapshot.longestMainThreadBlockingSectionMs = Math.max(
      this.snapshot.longestMainThreadBlockingSectionMs,
      durationMs,
    );
  }

  recordLoadedNode(pointCount: number): void {
    this.snapshot.loadedNodeCount += 1;
    this.snapshot.loadedPointCount += pointCount;
  }

  recordStage(
    stage: keyof Pick<
      StreamingPerformanceSnapshot,
      | 'rangeFetchDurationMs'
      | 'decodeDurationMs'
      | 'crsTransformDurationMs'
      | 'geographicToCartesianDurationMs'
      | 'pointStylePreparationDurationMs'
      | 'pointCollectionCreationDurationMs'
      | 'pointAddDurationMs'
    >,
    durationMs: number,
    blocksMainThread = false,
  ): void {
    this.snapshot[stage] += durationMs;
    if (blocksMainThread) {
      this.snapshot.longestMainThreadBlockingSectionMs = Math.max(
        this.snapshot.longestMainThreadBlockingSectionMs,
        durationMs,
      );
    }
  }

  finishUpdate(): void {
    this.snapshot.updateDurationMs = performanceNow() - this.updateStartedAt;
  }

  getSnapshot(): StreamingPerformanceSnapshot {
    return { ...this.snapshot };
  }
}
