import { performanceNow } from '../../copc/performance';
import type {
  StreamingLevelRange,
  StreamingSelectionMetrics,
  StreamingSchedulingDiagnostics,
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
  effectiveScreenSpaceErrorMin?: number;
  effectiveScreenSpaceErrorMax?: number;
  refinedNodeCount: number;
  keptNodeCount: number;
  frontierNodeCount: number;
  frontierPointCount: number;
  acceptedRefinementCount: number;
  refinementRejectedByNodeBudgetCount: number;
  refinementRejectedByPointBudgetCount: number;
  refinementDeferredByIncompleteHierarchyCount: number;
  minimumFrontierExceedsNodeBudget: boolean;
  minimumFrontierExceedsPointBudget: boolean;
  centerWeightMin?: number;
  centerWeightMax?: number;
  refinementCenterWeightMin?: number;
  refinementCenterWeightMax?: number;
  schedulingCenterWeightMin?: number;
  schedulingCenterWeightMax?: number;
  detailBiasMin?: number;
  detailBiasMax?: number;
  candidatesWithNonZeroInfluenceCount?: number;
  acceptedGazeInfluencedRefinementCount?: number;
  influenceClampCount?: number;
  acceptedRefinementPriorityMin?: number;
  acceptedRefinementPriorityMax?: number;
  refinementPriorityMin?: number;
  refinementPriorityMax?: number;
  schedulingPriorityMin?: number;
  schedulingPriorityMax?: number;
  candidatesWithCenterBoostCount?: number;
  hysteresisHoldCount?: number;
  refineDecisionCount?: number;
  collapseDecisionCount?: number;
  visibleLevelRange?: StreamingLevelRange;
  cameraDirection?: ViewVector3;
  maxConcurrentNodeLoads?: number;
  queuedNodeCount?: number;
  activeNodeCount?: number;
  queuedHighPriorityNodeCount?: number;
  activeHighPriorityNodeCount?: number;
  completedNodeCount?: number;
  cancelledNodeCount?: number;
  peakActiveNodeCount?: number;
  completedSchedulingPriorityMin?: number;
  completedSchedulingPriorityMax?: number;
  pendingSchedulingPriorityMin?: number;
  pendingSchedulingPriorityMax?: number;
  firstHighPriorityNodeStartLatencyMs?: number;
  firstHighPriorityNodeReadyLatencyMs?: number;
  loadedNodeCount: number;
  loadedPointCount: number;
  rangeFetchDurationMs: number;
  rangeFetchBytes: number;
  decodeDurationMs: number;
  /** Rust fused decode/CRS/ECEF preparation time, excluding decode. */
  pointPreparationDurationMs: number;
  crsTransformDurationMs: number;
  geographicToCartesianDurationMs: number;
  /** Cesium wrapping of prepared ECEF values, without geographic conversion. */
  worldToCartesianDurationMs: number;
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
    frontierNodeCount: 0,
    frontierPointCount: 0,
    acceptedRefinementCount: 0,
    refinementRejectedByNodeBudgetCount: 0,
    refinementRejectedByPointBudgetCount: 0,
    refinementDeferredByIncompleteHierarchyCount: 0,
    minimumFrontierExceedsNodeBudget: false,
    minimumFrontierExceedsPointBudget: false,
    loadedNodeCount: 0,
    loadedPointCount: 0,
    rangeFetchDurationMs: 0,
    rangeFetchBytes: 0,
    decodeDurationMs: 0,
    pointPreparationDurationMs: 0,
    crsTransformDurationMs: 0,
    geographicToCartesianDurationMs: 0,
    worldToCartesianDurationMs: 0,
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
  private schedulingCancellationCount = 0;
  private currentSchedulerCancelledNodeCount = 0;

  beginUpdate(): void {
    this.snapshot = emptySnapshot();
    this.snapshot.configuredPointBudget = this.configuredPointBudget;
    this.updateStartedAt = performanceNow();
    this.schedulingCancellationCount = 0;
    this.currentSchedulerCancelledNodeCount = 0;
  }

  setConfiguredPointBudget(pointBudget: number): void {
    this.configuredPointBudget = Math.max(0, pointBudget);
    this.snapshot.configuredPointBudget = this.configuredPointBudget;
  }

  /** Clear measurements for a released source while retaining its budget. */
  reset(): void {
    this.snapshot = emptySnapshot();
    this.snapshot.configuredPointBudget = this.configuredPointBudget;
    this.updateStartedAt = 0;
    this.schedulingCancellationCount = 0;
    this.currentSchedulerCancelledNodeCount = 0;
  }

  setSchedulingDiagnostics(diagnostics: StreamingSchedulingDiagnostics): void {
    this.snapshot.maxConcurrentNodeLoads = diagnostics.maxConcurrentNodeLoads;
    this.snapshot.queuedNodeCount = diagnostics.queuedNodeCount;
    this.snapshot.activeNodeCount = diagnostics.activeNodeCount;
    this.snapshot.queuedHighPriorityNodeCount = diagnostics.queuedHighPriorityNodeCount;
    this.snapshot.activeHighPriorityNodeCount = diagnostics.activeHighPriorityNodeCount;
    this.snapshot.completedNodeCount = diagnostics.completedNodeCount;
    this.currentSchedulerCancelledNodeCount = diagnostics.cancelledNodeCount;
    this.snapshot.cancelledNodeCount = this.schedulingCancellationCount
      + this.currentSchedulerCancelledNodeCount;
    this.snapshot.peakActiveNodeCount = diagnostics.peakActiveNodeCount;
    this.snapshot.completedSchedulingPriorityMin = diagnostics.completedSchedulingPriorityMin;
    this.snapshot.completedSchedulingPriorityMax = diagnostics.completedSchedulingPriorityMax;
    this.snapshot.pendingSchedulingPriorityMin = diagnostics.pendingSchedulingPriorityMin;
    this.snapshot.pendingSchedulingPriorityMax = diagnostics.pendingSchedulingPriorityMax;
  }

  /** Preserve cancellations reported by a superseded scheduler. */
  recordSchedulingCancellations(count: number): void {
    if (!Number.isFinite(count) || count <= 0) {
      return;
    }

    this.schedulingCancellationCount += Math.floor(count);
    this.snapshot.cancelledNodeCount = this.schedulingCancellationCount
      + this.currentSchedulerCancelledNodeCount;
  }

  recordFirstHighPriorityNodeReady(): void {
    if (this.snapshot.firstHighPriorityNodeReadyLatencyMs !== undefined) {
      return;
    }

    this.snapshot.firstHighPriorityNodeReadyLatencyMs = Math.max(
      0,
      performanceNow() - this.updateStartedAt,
    );
  }

  recordFirstHighPriorityNodeStart(): void {
    if (this.snapshot.firstHighPriorityNodeStartLatencyMs !== undefined) {
      return;
    }

    this.snapshot.firstHighPriorityNodeStartLatencyMs = Math.max(
      0,
      performanceNow() - this.updateStartedAt,
    );
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
    this.snapshot.effectiveScreenSpaceErrorMin = metrics.effectiveScreenSpaceErrorMin;
    this.snapshot.effectiveScreenSpaceErrorMax = metrics.effectiveScreenSpaceErrorMax;
    this.snapshot.refinedNodeCount = metrics.refinedNodeCount;
    this.snapshot.keptNodeCount = metrics.keptNodeCount;
    this.snapshot.frontierNodeCount = metrics.frontierNodeCount ?? 0;
    this.snapshot.frontierPointCount = metrics.frontierPointCount ?? 0;
    this.snapshot.acceptedRefinementCount = metrics.acceptedRefinementCount ?? 0;
    this.snapshot.refinementRejectedByNodeBudgetCount = metrics.refinementRejectedByNodeBudgetCount ?? 0;
    this.snapshot.refinementRejectedByPointBudgetCount = metrics.refinementRejectedByPointBudgetCount ?? 0;
    this.snapshot.refinementDeferredByIncompleteHierarchyCount = metrics.refinementDeferredByIncompleteHierarchyCount ?? 0;
    this.snapshot.minimumFrontierExceedsNodeBudget = metrics.minimumFrontierExceedsNodeBudget ?? false;
    this.snapshot.minimumFrontierExceedsPointBudget = metrics.minimumFrontierExceedsPointBudget ?? false;
    this.snapshot.centerWeightMin = metrics.centerWeightMin;
    this.snapshot.centerWeightMax = metrics.centerWeightMax;
    this.snapshot.refinementCenterWeightMin = metrics.refinementCenterWeightMin;
    this.snapshot.refinementCenterWeightMax = metrics.refinementCenterWeightMax;
    this.snapshot.schedulingCenterWeightMin = metrics.schedulingCenterWeightMin;
    this.snapshot.schedulingCenterWeightMax = metrics.schedulingCenterWeightMax;
    this.snapshot.detailBiasMin = metrics.detailBiasMin;
    this.snapshot.detailBiasMax = metrics.detailBiasMax;
    this.snapshot.candidatesWithNonZeroInfluenceCount =
      metrics.candidatesWithNonZeroInfluenceCount ?? 0;
    this.snapshot.acceptedGazeInfluencedRefinementCount =
      metrics.acceptedGazeInfluencedRefinementCount ?? 0;
    this.snapshot.influenceClampCount = metrics.influenceClampCount ?? 0;
    this.snapshot.acceptedRefinementPriorityMin = metrics.acceptedRefinementPriorityMin;
    this.snapshot.acceptedRefinementPriorityMax = metrics.acceptedRefinementPriorityMax;
    this.snapshot.refinementPriorityMin = metrics.refinementPriorityMin;
    this.snapshot.refinementPriorityMax = metrics.refinementPriorityMax;
    this.snapshot.schedulingPriorityMin = metrics.schedulingPriorityMin;
    this.snapshot.schedulingPriorityMax = metrics.schedulingPriorityMax;
    this.snapshot.candidatesWithCenterBoostCount = metrics.candidatesWithCenterBoostCount ?? 0;
    this.snapshot.hysteresisHoldCount = metrics.hysteresisHoldCount ?? 0;
    this.snapshot.refineDecisionCount = metrics.refineDecisionCount ?? 0;
    this.snapshot.collapseDecisionCount = metrics.collapseDecisionCount ?? 0;
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
      | 'pointPreparationDurationMs'
      | 'crsTransformDurationMs'
      | 'geographicToCartesianDurationMs'
      | 'worldToCartesianDurationMs'
      | 'pointStylePreparationDurationMs'
      | 'pointCollectionCreationDurationMs'
      | 'pointAddDurationMs'
      | 'rendererPreparationDurationMs'
      | 'nodeRemovalDurationMs'
    >,
    durationMs: number,
    blocksMainThread = false,
    bytes = 0,
  ): void {
    this.snapshot[stage] += durationMs;
    if (stage === 'rangeFetchDurationMs' && Number.isFinite(bytes) && bytes > 0) {
      this.snapshot.rangeFetchBytes += Math.floor(bytes);
    }
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
