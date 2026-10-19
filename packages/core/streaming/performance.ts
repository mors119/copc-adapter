import { performanceNow } from '../copc/performance';
import type {
  StreamingLevelRange,
  StreamingSelectionMetrics,
  StreamingSchedulingDiagnostics,
  ViewVector3,
} from './types';

/**
 * Measurements for the most recent streaming view update.
 *
 * Time values are milliseconds, range fetch bytes are transferred bytes, and
 * GPU frame time is not measured here.
 */
export type StreamingPerformanceSnapshot = {
  /** Total elapsed time of the most recent core update. */
  updateDurationMs: number;
  /** Time spent selecting hierarchy nodes, in milliseconds. */
  nodeSelectionMs: number;
  /** Number of selected hierarchy nodes. */
  selectedNodeCount: number;
  /** Estimated points represented by the selected frontier. */
  estimatedSelectedPointCount: number;
  /** Configured point-workload budget. */
  configuredPointBudget: number;
  /** Estimated points in the minimum coverage frontier before budget handling. */
  candidateSelectedPointCount: number;
  /** Estimated points in the frontier returned after budget handling. */
  activeRenderedPointCount: number;
  /** Selected nodes deferred by budgets or incomplete hierarchy. */
  deferredNodeCount: number;
  /** Estimated points represented by deferred nodes. */
  deferredPointCount: number;
  /** Nodes dropped because the minimum frontier exceeded a budget. */
  budgetDeferDropCount: number;
  /** Active selected point cost divided by configured budget, as a percentage. */
  budgetUtilizationPercent: number;
  /** Hierarchy candidates before culling. */
  candidatesBeforeCulling: number;
  /** Candidates rejected by frustum culling. */
  frustumCulledCount: number;
  /** Maximum screen-space error threshold in pixels. */
  maxScreenSpaceError: number;
  /** Minimum measured raw screen-space error in pixels. */
  screenSpaceErrorMin?: number;
  /** Maximum measured raw screen-space error in pixels. */
  screenSpaceErrorMax?: number;
  /** Minimum screen-space error after refinement influence, in pixels. */
  effectiveScreenSpaceErrorMin?: number;
  /** Maximum screen-space error after refinement influence, in pixels. */
  effectiveScreenSpaceErrorMax?: number;
  /** Nodes refined to children. */
  refinedNodeCount: number;
  /** Nodes retained in the selected frontier. */
  keptNodeCount: number;
  /** Node count in the coverage-preserving frontier. */
  frontierNodeCount: number;
  /** Estimated point count in the coverage-preserving frontier. */
  frontierPointCount: number;
  /** Refinements accepted after hierarchy and workload checks. */
  acceptedRefinementCount: number;
  /** Refinements rejected by the node-count budget. */
  refinementRejectedByNodeBudgetCount: number;
  /** Refinements rejected by the estimated point budget. */
  refinementRejectedByPointBudgetCount: number;
  /** Refinements deferred until query-relevant child topology is known. */
  refinementDeferredByIncompleteHierarchyCount: number;
  /** Whether the minimum coverage frontier exceeds the node budget. */
  minimumFrontierExceedsNodeBudget: boolean;
  /** Whether the minimum coverage frontier exceeds the point budget. */
  minimumFrontierExceedsPointBudget: boolean;
  /** Active refinement algorithm used by the latest selection. */
  refinementAlgorithm?: NonNullable<StreamingSelectionMetrics['refinementAlgorithm']>;
  /** Whether the latest selection used a manual focus lens. */
  refinementFocusEnabled?: boolean;
  /** Whether current-view camera motion lookahead was enabled. */
  motionLookaheadEnabled?: boolean;
  /** Accepted angular movement samples since camera motion history was reset. */
  motionSampledMovementCount?: number;
  /** Horizontal camera angular velocity used by the most recently recorded selection, in degrees/second. */
  motionHorizontalAngularVelocityDegreesPerSecond?: number;
  /** Vertical camera angular velocity used by the most recently recorded selection, in degrees/second. */
  motionVerticalAngularVelocityDegreesPerSecond?: number;
  /** Fixed lookahead horizon used by the most recently recorded selection, in milliseconds. */
  motionHorizonMilliseconds?: number;
  /** Predicted horizontal displacement used by the most recently recorded selection, in degrees. */
  motionPredictedHorizontalDisplacementDegrees?: number;
  /** Predicted vertical displacement used by the most recently recorded selection, in degrees. */
  motionPredictedVerticalDisplacementDegrees?: number;
  /** Visible candidate nodes receiving nonzero motion relevance in the most recently recorded selection. */
  motionCandidateCount?: number;
  /** Motion relevance range among visible candidates in the most recently recorded selection, in [0, 1]. */
  motionWeightMin?: number;
  motionWeightMax?: number;
  /** Accepted refinements whose decision or budget winner changed with motion relevance. */
  motionInfluencedRefinementCount?: number;
  /** Lowest conservative screen-centre influence weight, in [0, 1]. */
  centerWeightMin?: number;
  /** Highest conservative screen-centre influence weight, in [0, 1]. */
  centerWeightMax?: number;
  /** Lowest refinement-specific centre influence weight, in [0, 1]. */
  refinementCenterWeightMin?: number;
  /** Highest refinement-specific centre influence weight, in [0, 1]. */
  refinementCenterWeightMax?: number;
  /** Lowest scheduling-only centre influence weight, in [0, 1]. */
  schedulingCenterWeightMin?: number;
  /** Highest scheduling-only centre influence weight, in [0, 1]. */
  schedulingCenterWeightMax?: number;
  /** Lowest bounded detail multiplier applied to refinement scores. */
  detailBiasMin?: number;
  /** Highest bounded detail multiplier applied to refinement scores. */
  detailBiasMax?: number;
  /** Candidates with nonzero screen-centre influence. */
  candidatesWithNonZeroInfluenceCount?: number;
  /** Accepted refinements influenced by screen-centre weighting. */
  acceptedGazeInfluencedRefinementCount?: number;
  /** Candidates whose projected volume received manual focus relevance. */
  focusCandidateCount?: number;
  /** Manual focus relevance range observed, in [0, 1]. */
  focusWeightMin?: number;
  focusWeightMax?: number;
  /** Accepted replacements affected by manual focus relevance. */
  focusInfluencedRefinementCount?: number;
  /** Candidate influence values clamped to their safe bounds. */
  influenceClampCount?: number;
  /** Lowest score among accepted refinement candidates. */
  acceptedRefinementPriorityMin?: number;
  /** Highest score among accepted refinement candidates. */
  acceptedRefinementPriorityMax?: number;
  /** Lowest bounded refinement score among candidates. */
  refinementPriorityMin?: number;
  /** Highest bounded refinement score among candidates. */
  refinementPriorityMax?: number;
  /** Lowest node scheduling score observed. */
  schedulingPriorityMin?: number;
  /** Highest node scheduling score observed. */
  schedulingPriorityMax?: number;
  /** Candidates receiving a scheduling centre boost. */
  candidatesWithCenterBoostCount?: number;
  /** Selection decisions held by screen-space error hysteresis. */
  hysteresisHoldCount?: number;
  /** Refinement decisions made. */
  refineDecisionCount?: number;
  /** Collapse decisions made. */
  collapseDecisionCount?: number;
  /** Minimum and maximum visible hierarchy levels, when known. */
  visibleLevelRange?: StreamingLevelRange;
  /** Current camera direction in the shared WGS84 ECEF frame. */
  cameraDirection?: ViewVector3;
  /** Maximum simultaneous range/decode/preparation operations. */
  maxConcurrentNodeLoads?: number;
  /** Node loads waiting for a scheduler slot. */
  queuedNodeCount?: number;
  /** Node loads currently active. */
  activeNodeCount?: number;
  /** Queued loads classified as high priority. */
  queuedHighPriorityNodeCount?: number;
  /** Active loads classified as high priority. */
  activeHighPriorityNodeCount?: number;
  /** Node loads completed by the current scheduler. */
  completedNodeCount?: number;
  /** Node loads cancelled by the current and superseded schedulers. */
  cancelledNodeCount?: number;
  /** Peak simultaneous active node loads. */
  peakActiveNodeCount?: number;
  /** Lowest scheduling score among completed jobs. */
  completedSchedulingPriorityMin?: number;
  /** Highest scheduling score among completed jobs. */
  completedSchedulingPriorityMax?: number;
  /** Lowest scheduling score among pending jobs. */
  pendingSchedulingPriorityMin?: number;
  /** Highest scheduling score among pending jobs. */
  pendingSchedulingPriorityMax?: number;
  /** Time from update start until the first high-priority node began loading. */
  firstHighPriorityNodeStartLatencyMs?: number;
  /** Time from update start until the first high-priority node was ready. */
  firstHighPriorityNodeReadyLatencyMs?: number;
  /** Number of unique nodes whose point buffers were loaded. */
  loadedNodeCount: number;
  /** Number of points returned by completed node loads. */
  loadedPointCount: number;
  /** Cumulative byte-range fetch duration in milliseconds. */
  rangeFetchDurationMs: number;
  /** Bytes returned by range requests during the update. */
  rangeFetchBytes: number;
  /** Cumulative LAZ decode duration in milliseconds. */
  decodeDurationMs: number;
  /** Rust fused decode/CRS/ECEF preparation time, excluding decode. */
  pointPreparationDurationMs: number;
  /** CRS transform time in milliseconds, when measured separately. */
  crsTransformDurationMs: number;
  /** Renderer-side geographic-to-Cartesian conversion time in milliseconds. */
  geographicToCartesianDurationMs: number;
  /** Renderer time to wrap prepared ECEF values as engine Cartesian objects, in milliseconds. */
  worldToCartesianDurationMs: number;
  /** Time spent resolving point colors in milliseconds. */
  pointStylePreparationDurationMs: number;
  /** Time spent creating Cesium point collections in milliseconds. */
  pointCollectionCreationDurationMs: number;
  /** Time spent adding Cesium point primitives in milliseconds. */
  pointAddDurationMs: number;
  /** Total renderer-side node preparation time in milliseconds. */
  rendererPreparationDurationMs: number;
  /** Time spent removing renderer nodes in milliseconds. */
  nodeRemovalDurationMs: number;
  /** Longest measured synchronous main-thread section in milliseconds. */
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
    refinementAlgorithm: 'foveated',
    refinementFocusEnabled: false,
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
    this.snapshot.refinementAlgorithm = metrics.refinementAlgorithm ?? 'foveated';
    this.snapshot.refinementFocusEnabled = metrics.refinementFocusEnabled ?? false;
    this.snapshot.motionLookaheadEnabled = metrics.motionLookaheadEnabled ?? false;
    this.snapshot.motionHorizontalAngularVelocityDegreesPerSecond =
      metrics.motionHorizontalAngularVelocityDegreesPerSecond ?? 0;
    this.snapshot.motionVerticalAngularVelocityDegreesPerSecond =
      metrics.motionVerticalAngularVelocityDegreesPerSecond ?? 0;
    this.snapshot.motionHorizonMilliseconds = metrics.motionHorizonMilliseconds ?? 0;
    this.snapshot.motionPredictedHorizontalDisplacementDegrees =
      metrics.motionPredictedHorizontalDisplacementDegrees ?? 0;
    this.snapshot.motionPredictedVerticalDisplacementDegrees =
      metrics.motionPredictedVerticalDisplacementDegrees ?? 0;
    this.snapshot.motionCandidateCount = metrics.motionCandidateCount ?? 0;
    this.snapshot.motionWeightMin = metrics.motionWeightMin ?? 0;
    this.snapshot.motionWeightMax = metrics.motionWeightMax ?? 0;
    this.snapshot.motionInfluencedRefinementCount =
      metrics.motionInfluencedRefinementCount ?? 0;
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
    this.snapshot.focusCandidateCount = metrics.focusCandidateCount ?? 0;
    this.snapshot.focusWeightMin = metrics.focusWeightMin;
    this.snapshot.focusWeightMax = metrics.focusWeightMax;
    this.snapshot.focusInfluencedRefinementCount =
      metrics.focusInfluencedRefinementCount ?? 0;
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
