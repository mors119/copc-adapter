import { performanceNow } from '../../copc/performance';
import type {
  StreamingLevelRange,
  StreamingSelectionMetrics,
  ViewVector3,
} from './types';

export type StreamingPerformanceSnapshot = {
  updateDurationMs: number;
  nodeSelectionMs: number;
  selectedNodeCount: number;
  estimatedSelectedPointCount: number;
  configuredPointBudget: number;
  candidateSelectedPointCount: number;
  activeRenderedPointCount: number;
  deferredNodeCount: number;
  deferredPointCount: number;
  budgetDeferDropCount: number;
  budgetUtilizationPercent: number;
  candidatesBeforeCulling: number;
  frustumCulledCount: number;
  maxScreenSpaceError: number;
  screenSpaceErrorMin?: number;
  screenSpaceErrorMax?: number;
  refinedNodeCount: number;
  keptNodeCount: number;
  visibleLevelRange?: StreamingLevelRange;
  cameraDirection?: ViewVector3;
  loadedNodeCount: number;
  loadedPointCount: number;
  rangeFetchDurationMs: number;
  decodeDurationMs: number;
  crsTransformDurationMs: number;
  geographicToCartesianDurationMs: number;
  pointStylePreparationDurationMs: number;
  pointCollectionCreationDurationMs: number;
  pointAddDurationMs: number;
  rendererPreparationDurationMs: number;
  nodeRemovalDurationMs: number;
  longestMainThreadBlockingSectionMs: number;
};

function emptySnapshot(): StreamingPerformanceSnapshot {
  return {
    updateDurationMs: 0,
    nodeSelectionMs: 0,
    selectedNodeCount: 0,
    estimatedSelectedPointCount: 0,
    configuredPointBudget: 0,
    candidateSelectedPointCount: 0,
    activeRenderedPointCount: 0,
    deferredNodeCount: 0,
    deferredPointCount: 0,
    budgetDeferDropCount: 0,
    budgetUtilizationPercent: 0,
    candidatesBeforeCulling: 0,
    frustumCulledCount: 0,
    maxScreenSpaceError: 0,
    refinedNodeCount: 0,
    keptNodeCount: 0,
    loadedNodeCount: 0,
    loadedPointCount: 0,
    rangeFetchDurationMs: 0,
    decodeDurationMs: 0,
    crsTransformDurationMs: 0,
    geographicToCartesianDurationMs: 0,
    pointStylePreparationDurationMs: 0,
    pointCollectionCreationDurationMs: 0,
    pointAddDurationMs: 0,
    rendererPreparationDurationMs: 0,
    nodeRemovalDurationMs: 0,
    longestMainThreadBlockingSectionMs: 0,
  };
}

/** Lightweight per-update timings used by the debug panel and benchmarks. */
export class StreamingPerformanceRecorder {
  private snapshot = emptySnapshot();
  private updateStartedAt = 0;
  private configuredPointBudget = 0;

  beginUpdate(): void {
    this.snapshot = emptySnapshot();
    this.snapshot.configuredPointBudget = this.configuredPointBudget;
    this.updateStartedAt = performanceNow();
  }

  setConfiguredPointBudget(pointBudget: number): void {
    this.configuredPointBudget = Math.max(0, pointBudget);
    this.snapshot.configuredPointBudget = this.configuredPointBudget;
  }

  setSelection(
    selectedNodeCount: number,
    estimatedSelectedPointCount: number,
    durationMs: number,
    metrics: StreamingSelectionMetrics & {
      visibleLevelRange?: StreamingLevelRange;
      cameraDirection?: ViewVector3;
    },
  ): void {
    this.snapshot.selectedNodeCount = selectedNodeCount;
    this.snapshot.estimatedSelectedPointCount = estimatedSelectedPointCount;
    this.snapshot.configuredPointBudget = metrics.maxRenderedPoints;
    this.configuredPointBudget = metrics.maxRenderedPoints;
    this.snapshot.candidateSelectedPointCount = metrics.candidateSelectedPointCount;
    this.snapshot.activeRenderedPointCount = metrics.budgetedPointCount;
    this.snapshot.deferredNodeCount = metrics.deferredNodeCount;
    this.snapshot.deferredPointCount = metrics.deferredPointCount;
    this.snapshot.budgetDeferDropCount = metrics.budgetDeferDropCount;
    this.snapshot.budgetUtilizationPercent = metrics.maxRenderedPoints > 0
      ? (metrics.budgetedPointCount / metrics.maxRenderedPoints) * 100
      : 0;
    this.snapshot.nodeSelectionMs = durationMs;
    this.snapshot.candidatesBeforeCulling = metrics.candidatesBeforeCulling;
    this.snapshot.frustumCulledCount = metrics.frustumCulledCount;
    this.snapshot.maxScreenSpaceError = metrics.maxScreenSpaceError;
    this.snapshot.screenSpaceErrorMin = metrics.screenSpaceErrorMin;
    this.snapshot.screenSpaceErrorMax = metrics.screenSpaceErrorMax;
    this.snapshot.refinedNodeCount = metrics.refinedNodeCount;
    this.snapshot.keptNodeCount = metrics.keptNodeCount;
    this.snapshot.visibleLevelRange = metrics.visibleLevelRange;
    this.snapshot.cameraDirection = metrics.cameraDirection;
    this.snapshot.longestMainThreadBlockingSectionMs = Math.max(
      this.snapshot.longestMainThreadBlockingSectionMs,
      durationMs,
    );
  }

  recordLoadedNode(pointCount: number): void {
    this.snapshot.loadedNodeCount += 1;
    this.snapshot.loadedPointCount += pointCount;
  }

  setActiveRenderedPointCount(pointCount: number): void {
    this.snapshot.activeRenderedPointCount = Math.max(0, pointCount);
    this.snapshot.budgetUtilizationPercent = this.snapshot.configuredPointBudget > 0
      ? (this.snapshot.activeRenderedPointCount / this.snapshot.configuredPointBudget) * 100
      : 0;
  }

  recordBudgetDrop(nodeCount = 1, pointCount = 0): void {
    this.snapshot.budgetDeferDropCount += Math.max(0, nodeCount);
    this.snapshot.deferredNodeCount += Math.max(0, nodeCount);
    this.snapshot.deferredPointCount += Math.max(0, pointCount);
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
      | 'rendererPreparationDurationMs'
      | 'nodeRemovalDurationMs'
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
