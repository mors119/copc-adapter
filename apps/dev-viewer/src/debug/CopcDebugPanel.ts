import type {
  CopcCesiumLayerSnapshot,
  CopcColorMode,
  CopcMetadata,
  CopcPointInspection,
  RangeValidationPolicy,
} from "@frillab/copc-adapter";
import type { CopcThreeLayerSnapshot } from "@frillab/copc-adapter/three";
import type {
  CopcHierarchyDiagnostics,
  CopcSourceProbeResult,
  ProbeTruth,
} from "@frillab/copc-adapter";
import { createCopcPointInspector } from "./CopcPointInspector";

export type CopcDebugPanelState = {
  snapshot: CopcCesiumLayerSnapshot | CopcThreeLayerSnapshot;
  metadata?: CopcMetadata;
  hierarchy?: CopcHierarchyDiagnostics;
  sourceProbe?: CopcSourceProbeResult;
  activeColorMode?: CopcColorMode;
  configuredRangeValidation: RangeValidationPolicy;
  sourceProbePolicy?: RangeValidationPolicy;
  rangeValidationApplicable: boolean;
  selectedPoint?: CopcPointInspection;
  lastError?: string;
};

export type CopcDebugPanelView = {
  datasetName: string;
  datasetUrl: string;
  activeColorMode: string;
  status: string;
  statusTone: "loading" | "ready" | "error" | "inactive";
  pointCount: string;
  bounds: string;
  scale: string;
  offset: string;
  selectedNodeCount: string;
  selectedNodeKeys: string;
  renderedNodeCount: string;
  renderedNodeKeys: string;
  renderedPointCount: string;
  hierarchyRequests: string;
  hierarchyCacheHits: string;
  hierarchyLoadedPages: string;
  hierarchyLoadedEntries: string;
  hierarchyPageConcurrency: string;
  hierarchySourceDuration: string;
  hierarchyMetadataDuration: string;
  hierarchyRootDuration: string;
  hierarchyQueryDuration: string;
  viewDistance: string;
  activeReplacementGroups: string;
  coarseNodesRetained: string;
  refinementReplacementCommits: string;
  configuredPointBudget: string;
  candidateSelectedPointCount: string;
  activeRenderedPointCount: string;
  deferredNodeCount: string;
  deferredPointCount: string;
  budgetUtilization: string;
  budgetDeferDropCount: string;
  maxConcurrentNodeLoads: string;
  queuedNodeCount: string;
  activeNodeCount: string;
  completedNodeCount: string;
  cancelledNodeCount: string;
  rangeRequestsRequested: string;
  rangeRequestsActive: string;
  rangeRequestsCompleted: string;
  rangeRequestsFailed: string;
  rangeRequestsAbortedSuperseded: string;
  rangeRequestsAbortedLifecycle: string;
  peakActiveNodeCount: string;
  firstHighPriorityNodeReadyLatency: string;
  firstHighPriorityNodeStartLatency: string;
  highPriorityQueuedActive: string;
  completedPendingSchedulingPriority: string;
  streamingUpdateCount: string;
  candidatesBeforeCulling: string;
  frustumCulledCount: string;
  maxScreenSpaceError: string;
  representativeScreenSpaceError: string;
  effectiveScreenSpaceError: string;
  refinementCenterWeight: string;
  schedulingCenterWeight: string;
  refinementPriority: string;
  schedulingPriority: string;
  detailBias: string;
  influenceCandidates: string;
  gazeInfluencedRefinements: string;
  refinedNodeCount: string;
  keptNodeCount: string;
  frontierNodeCount: string;
  frontierPointCount: string;
  acceptedRefinementCount: string;
  refinementRejectedByBudget: string;
  refinementRejectedByNodeBudget: string;
  refinementRejectedByPointBudget: string;
  refinementDeferredByIncompleteHierarchyCount: string;
  impossibleMinimumFrontier: string;
  visibleLevelRange: string;
  cameraDirection: string;
  pointCacheBudget: string;
  pointCacheBytes: string;
  cachedNodeCount: string;
  cacheHits: string;
  cacheMisses: string;
  cacheEvictionCount: string;
  cacheBytesEvicted: string;
  largestCachedEntryBytes: string;
  workerConcurrency: string;
  workerQueue: string;
  sourceReachable: string;
  sourceRange: string;
  sourceCopc: string;
  sourcePointFormat: string;
  sourceCors: string;
  sourceWarnings: string;
  error?: string;
  refinementAlgorithm: string;
  motionLiveEnabled: string;
  motionLiveState: string;
  motionLiveMovementSamples: string;
  motionLiveAngularVelocity: string;
  motionLivePrediction: string;
  motionLiveActivity: string;
  motionLiveAge: string;
  motionSelectionGeneration: string;
  motionSelectionNodes: string;
  motionSelectionPrediction: string;
  motionSelectionCandidates: string;
  motionSelectionWeights: string;
  motionSelectionInfluence: string;
  rangeFetchBytes: string;
  configuredRangeValidation: string;
  sourceProbePolicy: string;
  sourceProbeSource: string;
  sourceProbeValidationLevel: string;
  rangeValidationScope: string;
};

const numberFormatter = new Intl.NumberFormat("en-US");

function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

function formatBytes(value: number): string {
  return `${formatNumber(value)} B`;
}

function formatCoordinate(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toPrecision(8);
}

function formatPriorityRange(min?: number, max?: number): string {
  return min !== undefined && max !== undefined
    ? `${formatCoordinate(min)}–${formatCoordinate(max)}`
    : "—";
}

function formatVector(vector?: { x: number; y: number; z: number }): string {
  if (!vector) {
    return "—";
  }

  return [vector.x, vector.y, vector.z].map(formatCoordinate).join(", ");
}

function formatProbeTruth(value: ProbeTruth, label: string): string {
  const mark = value === true ? "✓" : value === false ? "✕" : "?";
  return `${mark} ${label}`;
}

function getDatasetName(datasetUrl: string): string {
  const withoutQuery = datasetUrl.split(/[?#]/, 1)[0];
  const encodedName = withoutQuery.split("/").filter(Boolean).at(-1);

  if (!encodedName) {
    return datasetUrl;
  }

  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
}

export function buildCopcDebugPanelView(
  state: CopcDebugPanelState,
): CopcDebugPanelView {
  const { snapshot, metadata, hierarchy, sourceProbe, lastError } = state;
  const liveMotion = snapshot.performance?.motionLive ?? {
    enabled: snapshot.performance?.motionLookaheadEnabled ?? false,
    acceptedMovementSampleCount:
      snapshot.performance?.motionSampledMovementCount ?? 0,
    horizontalAngularVelocityDegreesPerSecond: 0,
    verticalAngularVelocityDegreesPerSecond: 0,
    horizonMilliseconds: snapshot.performance?.motionHorizonMilliseconds ?? 200,
    predictedHorizontalDisplacementDegrees: 0,
    predictedVerticalDisplacementDegrees: 0,
    activity: 0,
    state: snapshot.performance?.motionLookaheadEnabled
      ? ("stationary" as const)
      : ("disabled" as const),
  };
  const rangeRequests =
    "rangeRequests" in snapshot ? snapshot.rangeRequests : undefined;
  const status = lastError
    ? "Error"
    : snapshot.lifecycle === "ready"
      ? "Ready"
      : snapshot.lifecycle === "loading"
        ? "Loading"
        : snapshot.lifecycle.charAt(0).toUpperCase() +
          snapshot.lifecycle.slice(1);
  const statusTone = lastError
    ? "error"
    : snapshot.lifecycle === "ready"
      ? "ready"
      : snapshot.lifecycle === "loading"
        ? "loading"
        : "inactive";

  return {
    datasetName: getDatasetName(snapshot.datasetUrl),
    datasetUrl: snapshot.datasetUrl,
    activeColorMode: state.activeColorMode ?? "fixed",
    refinementAlgorithm:
      snapshot.performance?.refinementAlgorithm ?? "foveated",
    motionLiveEnabled: liveMotion.enabled ? "on" : "off",
    motionLiveState: liveMotion.state,
    motionLiveMovementSamples: formatNumber(
      liveMotion.acceptedMovementSampleCount,
    ),
    motionLiveAngularVelocity: `${formatCoordinate(liveMotion.horizontalAngularVelocityDegreesPerSecond)}°/s horizontal · ${formatCoordinate(liveMotion.verticalAngularVelocityDegreesPerSecond)}°/s vertical`,
    motionLivePrediction: `${formatCoordinate(liveMotion.predictedHorizontalDisplacementDegrees)}° horizontal · ${formatCoordinate(liveMotion.predictedVerticalDisplacementDegrees)}° vertical (${liveMotion.horizonMilliseconds} ms)`,
    motionLiveActivity: formatCoordinate(liveMotion.activity),
    motionLiveAge:
      liveMotion.millisecondsSinceLastAcceptedMovement === undefined
        ? "no accepted movement sample"
        : `${formatCoordinate(liveMotion.millisecondsSinceLastAcceptedMovement)} ms`,
    motionSelectionGeneration: formatNumber(snapshot.streamingUpdateCount),
    motionSelectionNodes: `${formatNumber(snapshot.performance?.selectedNodeCount ?? snapshot.selectedNodeKeys.length)} selected · ${formatNumber(snapshot.renderedNodeKeys.length)} rendered`,
    motionSelectionPrediction: `${formatCoordinate(snapshot.performance?.motionPredictedHorizontalDisplacementDegrees ?? 0)}° horizontal · ${formatCoordinate(snapshot.performance?.motionPredictedVerticalDisplacementDegrees ?? 0)}° vertical`,
    motionSelectionCandidates: formatNumber(
      snapshot.performance?.motionCandidateCount ?? 0,
    ),
    motionSelectionWeights: formatPriorityRange(
      snapshot.performance?.motionWeightMin,
      snapshot.performance?.motionWeightMax,
    ),
    motionSelectionInfluence:
      (snapshot.performance?.motionInfluencedRefinementCount ?? 0) > 0
        ? `${formatNumber(snapshot.performance?.motionInfluencedRefinementCount ?? 0)} accepted refinement${snapshot.performance?.motionInfluencedRefinementCount === 1 ? "" : "s"} influenced`
        : (snapshot.performance?.motionCandidateCount ?? 0) > 0
          ? "weighted candidates; no accepted refinement changed"
          : "no motion-weighted candidates",
    rangeFetchBytes: formatBytes(snapshot.performance?.rangeFetchBytes ?? 0),
    configuredRangeValidation: state.configuredRangeValidation,
    sourceProbePolicy: sourceProbe
      ? (state.sourceProbePolicy ?? "—")
      : state.rangeValidationApplicable
        ? "—"
        : "not applicable · local File",
    sourceProbeSource: sourceProbe?.source ?? "—",
    sourceProbeValidationLevel:
      sourceProbe?.validationLevel ??
      (state.rangeValidationApplicable ? "—" : "not applicable · local File"),
    rangeValidationScope: state.rangeValidationApplicable
      ? "HTTP/HTTPS source"
      : "Not applicable · local File",
    status,
    statusTone,
    pointCount: metadata ? formatNumber(metadata.pointCount) : "—",
    bounds: metadata
      ? [
          metadata.bounds.minX,
          metadata.bounds.minY,
          metadata.bounds.minZ,
          metadata.bounds.maxX,
          metadata.bounds.maxY,
          metadata.bounds.maxZ,
        ]
          .map(formatCoordinate)
          .join(", ")
      : "—",
    scale: formatVector(metadata?.scale),
    offset: formatVector(metadata?.offset),
    selectedNodeCount: formatNumber(snapshot.selectedNodeKeys.length),
    selectedNodeKeys:
      snapshot.selectedNodeKeys.length > 0
        ? snapshot.selectedNodeKeys.join(", ")
        : "—",
    renderedNodeCount: formatNumber(snapshot.renderedNodeKeys.length),
    renderedNodeKeys:
      snapshot.renderedNodeKeys.length > 0
        ? snapshot.renderedNodeKeys.join(", ")
        : "—",
    renderedPointCount: formatNumber(snapshot.renderedPointCount),
    hierarchyRequests: formatNumber(hierarchy?.pageRequests ?? 0),
    hierarchyCacheHits: formatNumber(hierarchy?.pageCacheHits ?? 0),
    hierarchyLoadedPages: formatNumber(hierarchy?.loadedPageCount ?? 0),
    hierarchyLoadedEntries: formatNumber(hierarchy?.loadedEntryCount ?? 0),
    hierarchyPageConcurrency: `${formatNumber(hierarchy?.activePageLoads ?? 0)} active / ${formatNumber(hierarchy?.peakActivePageLoads ?? 0)} peak`,
    hierarchySourceDuration: `${formatCoordinate(hierarchy?.sourceOpenDurationMs ?? 0)} ms`,
    hierarchyMetadataDuration: `${formatCoordinate(hierarchy?.metadataLoadDurationMs ?? 0)} ms`,
    hierarchyRootDuration: `${formatCoordinate(hierarchy?.rootHierarchyLoadDurationMs ?? 0)} ms`,
    hierarchyQueryDuration: `${formatCoordinate(hierarchy?.lastQueryDurationMs ?? 0)} ms`,
    viewDistance: snapshot.viewDistance
      ? `${
          snapshot.viewDistance.visibleFootprintMeters === undefined
            ? "fallback"
            : `${formatCoordinate(snapshot.viewDistance.visibleFootprintMeters)} m`
        } / ${formatCoordinate(snapshot.viewDistance.effectiveDistanceMeters)} m / ${formatCoordinate(snapshot.viewDistance.maxRenderDistanceMeters)} m cap · ${snapshot.viewDistance.transition}${snapshot.viewDistance.clampedToMaxRenderDistance ? " · capped" : ""} · overscan ${formatCoordinate(snapshot.viewDistance.overscanFactor)}× · expand ${formatNumber(snapshot.viewDistance.expansionCount)} / shrink ${formatNumber(snapshot.viewDistance.shrinkCount)} / hold ${formatNumber(snapshot.viewDistance.hysteresisHoldCount)} / fallback ${formatNumber(snapshot.viewDistance.fallbackCount)}`
      : "—",
    activeReplacementGroups: formatNumber(
      snapshot.transition?.activeReplacementGroupCount ?? 0,
    ),
    coarseNodesRetained: formatNumber(
      snapshot.transition?.coarseNodesRetainedForCoverageCount ?? 0,
    ),
    refinementReplacementCommits: formatNumber(
      snapshot.transition?.refinementReplacementCommitCount ?? 0,
    ),
    configuredPointBudget: formatNumber(
      snapshot.performance?.configuredPointBudget ?? 0,
    ),
    candidateSelectedPointCount: formatNumber(
      snapshot.performance?.candidateSelectedPointCount ?? 0,
    ),
    activeRenderedPointCount: formatNumber(
      snapshot.performance?.activeRenderedPointCount ??
        snapshot.renderedPointCount,
    ),
    deferredNodeCount: formatNumber(
      snapshot.performance?.deferredNodeCount ?? 0,
    ),
    deferredPointCount: formatNumber(
      snapshot.performance?.deferredPointCount ?? 0,
    ),
    budgetUtilization: `${formatCoordinate(snapshot.performance?.budgetUtilizationPercent ?? 0)}%`,
    budgetDeferDropCount: formatNumber(
      snapshot.performance?.budgetDeferDropCount ?? 0,
    ),
    maxConcurrentNodeLoads: formatNumber(
      snapshot.performance?.maxConcurrentNodeLoads ?? 0,
    ),
    queuedNodeCount: formatNumber(snapshot.performance?.queuedNodeCount ?? 0),
    activeNodeCount: formatNumber(snapshot.performance?.activeNodeCount ?? 0),
    completedNodeCount: formatNumber(
      snapshot.performance?.completedNodeCount ?? 0,
    ),
    cancelledNodeCount: formatNumber(
      snapshot.performance?.cancelledNodeCount ?? 0,
    ),
    rangeRequestsRequested: rangeRequests
      ? formatNumber(rangeRequests.requested)
      : "—",
    rangeRequestsActive: rangeRequests
      ? formatNumber(rangeRequests.active)
      : "—",
    rangeRequestsCompleted: rangeRequests
      ? formatNumber(rangeRequests.completed)
      : "—",
    rangeRequestsFailed: rangeRequests
      ? formatNumber(rangeRequests.failed)
      : "—",
    rangeRequestsAbortedSuperseded: rangeRequests
      ? formatNumber(rangeRequests.abortedSuperseded)
      : "—",
    rangeRequestsAbortedLifecycle: rangeRequests
      ? formatNumber(rangeRequests.abortedLifecycle)
      : "—",
    peakActiveNodeCount: formatNumber(
      snapshot.performance?.peakActiveNodeCount ?? 0,
    ),
    firstHighPriorityNodeReadyLatency:
      snapshot.performance?.firstHighPriorityNodeReadyLatencyMs === undefined
        ? "—"
        : `${formatCoordinate(snapshot.performance.firstHighPriorityNodeReadyLatencyMs)} ms`,
    firstHighPriorityNodeStartLatency:
      snapshot.performance?.firstHighPriorityNodeStartLatencyMs === undefined
        ? "—"
        : `${formatCoordinate(snapshot.performance.firstHighPriorityNodeStartLatencyMs)} ms`,
    highPriorityQueuedActive: `${formatNumber(snapshot.performance?.queuedHighPriorityNodeCount ?? 0)} / ${formatNumber(snapshot.performance?.activeHighPriorityNodeCount ?? 0)}`,
    completedPendingSchedulingPriority: `${formatPriorityRange(
      snapshot.performance?.completedSchedulingPriorityMin,
      snapshot.performance?.completedSchedulingPriorityMax,
    )} / ${formatPriorityRange(
      snapshot.performance?.pendingSchedulingPriorityMin,
      snapshot.performance?.pendingSchedulingPriorityMax,
    )}`,
    streamingUpdateCount: formatNumber(snapshot.streamingUpdateCount),
    candidatesBeforeCulling: formatNumber(
      snapshot.performance?.candidatesBeforeCulling ?? 0,
    ),
    frustumCulledCount: formatNumber(
      snapshot.performance?.frustumCulledCount ?? 0,
    ),
    maxScreenSpaceError: `${formatCoordinate(snapshot.performance?.maxScreenSpaceError ?? 0)} px`,
    representativeScreenSpaceError:
      snapshot.performance?.screenSpaceErrorMin !== undefined &&
      snapshot.performance?.screenSpaceErrorMax !== undefined
        ? `${formatCoordinate(snapshot.performance.screenSpaceErrorMin)}–${formatCoordinate(snapshot.performance.screenSpaceErrorMax)} px`
        : "—",
    effectiveScreenSpaceError:
      snapshot.performance?.effectiveScreenSpaceErrorMin !== undefined &&
      snapshot.performance?.effectiveScreenSpaceErrorMax !== undefined
        ? `${formatCoordinate(snapshot.performance.effectiveScreenSpaceErrorMin)}–${formatCoordinate(snapshot.performance.effectiveScreenSpaceErrorMax)} px`
        : "—",
    refinementCenterWeight:
      snapshot.performance?.refinementCenterWeightMin !== undefined &&
      snapshot.performance?.refinementCenterWeightMax !== undefined
        ? `${formatCoordinate(snapshot.performance.refinementCenterWeightMin)}–${formatCoordinate(snapshot.performance.refinementCenterWeightMax)}`
        : "—",
    schedulingCenterWeight:
      snapshot.performance?.schedulingCenterWeightMin !== undefined &&
      snapshot.performance?.schedulingCenterWeightMax !== undefined
        ? `${formatCoordinate(snapshot.performance.schedulingCenterWeightMin)}–${formatCoordinate(snapshot.performance.schedulingCenterWeightMax)}`
        : "—",
    refinementPriority:
      snapshot.performance?.refinementPriorityMin !== undefined &&
      snapshot.performance?.refinementPriorityMax !== undefined
        ? `${formatCoordinate(snapshot.performance.refinementPriorityMin)}–${formatCoordinate(snapshot.performance.refinementPriorityMax)}`
        : "—",
    schedulingPriority:
      snapshot.performance?.schedulingPriorityMin !== undefined &&
      snapshot.performance?.schedulingPriorityMax !== undefined
        ? `${formatCoordinate(snapshot.performance.schedulingPriorityMin)}–${formatCoordinate(snapshot.performance.schedulingPriorityMax)}`
        : "—",
    detailBias:
      snapshot.performance?.detailBiasMin !== undefined &&
      snapshot.performance?.detailBiasMax !== undefined
        ? `${formatCoordinate(snapshot.performance.detailBiasMin)}–${formatCoordinate(snapshot.performance.detailBiasMax)}×`
        : "—",
    influenceCandidates: formatNumber(
      snapshot.performance?.candidatesWithNonZeroInfluenceCount ?? 0,
    ),
    gazeInfluencedRefinements: formatNumber(
      snapshot.performance?.acceptedGazeInfluencedRefinementCount ?? 0,
    ),
    refinedNodeCount: formatNumber(snapshot.performance?.refinedNodeCount ?? 0),
    keptNodeCount: formatNumber(snapshot.performance?.keptNodeCount ?? 0),
    frontierNodeCount: formatNumber(
      snapshot.performance?.frontierNodeCount ?? 0,
    ),
    frontierPointCount: formatNumber(
      snapshot.performance?.frontierPointCount ?? 0,
    ),
    acceptedRefinementCount: formatNumber(
      snapshot.performance?.acceptedRefinementCount ?? 0,
    ),
    refinementRejectedByBudget: formatNumber(
      (snapshot.performance?.refinementRejectedByNodeBudgetCount ?? 0) +
        (snapshot.performance?.refinementRejectedByPointBudgetCount ?? 0),
    ),
    refinementRejectedByNodeBudget: formatNumber(
      snapshot.performance?.refinementRejectedByNodeBudgetCount ?? 0,
    ),
    refinementRejectedByPointBudget: formatNumber(
      snapshot.performance?.refinementRejectedByPointBudgetCount ?? 0,
    ),
    refinementDeferredByIncompleteHierarchyCount: formatNumber(
      snapshot.performance?.refinementDeferredByIncompleteHierarchyCount ?? 0,
    ),
    impossibleMinimumFrontier:
      snapshot.performance?.minimumFrontierExceedsNodeBudget ||
      snapshot.performance?.minimumFrontierExceedsPointBudget
        ? "yes"
        : "no",
    visibleLevelRange: snapshot.performance?.visibleLevelRange
      ? `${snapshot.performance.visibleLevelRange.min}–${snapshot.performance.visibleLevelRange.max}`
      : "—",
    cameraDirection: formatVector(snapshot.performance?.cameraDirection),
    pointCacheBudget: formatBytes(snapshot.pointCache?.cacheByteBudget ?? 0),
    pointCacheBytes: formatBytes(snapshot.pointCache?.currentCacheBytes ?? 0),
    cachedNodeCount: formatNumber(snapshot.pointCache?.cachedNodeCount ?? 0),
    cacheHits: formatNumber(snapshot.pointCache?.hits ?? 0),
    cacheMisses: formatNumber(snapshot.pointCache?.misses ?? 0),
    cacheEvictionCount: formatNumber(snapshot.pointCache?.evictionCount ?? 0),
    cacheBytesEvicted: formatBytes(snapshot.pointCache?.bytesEvicted ?? 0),
    largestCachedEntryBytes: formatBytes(
      snapshot.pointCache?.largestCachedEntryBytes ?? 0,
    ),
    workerConcurrency: snapshot.worker
      ? `${formatNumber(snapshot.worker.activeCount)} / ${formatNumber(snapshot.worker.workerCount)} active`
      : "—",
    workerQueue: snapshot.worker
      ? `${formatNumber(snapshot.worker.queuedCount)} queued (peak ${formatNumber(snapshot.worker.peakQueuedCount)})`
      : "—",
    sourceReachable: sourceProbe
      ? formatProbeTruth(sourceProbe.reachable, "Reachable")
      : "—",
    sourceRange: sourceProbe
      ? formatProbeTruth(sourceProbe.rangeSupported, "HTTP Range / 206")
      : "—",
    sourceCopc: sourceProbe
      ? formatProbeTruth(sourceProbe.copcDetected, "COPC detected")
      : "—",
    sourcePointFormat:
      sourceProbe?.pointFormat === undefined
        ? "—"
        : `PDRF ${sourceProbe.pointFormat}`,
    sourceCors: sourceProbe
      ? formatProbeTruth(sourceProbe.corsReadable, "Browser response readable")
      : "—",
    sourceWarnings:
      sourceProbe && sourceProbe.warnings.length > 0
        ? [...new Set(sourceProbe.warnings)].join(" ")
        : "—",
    error: lastError,
  };
}

export type CopcDebugPanel = {
  refresh(): void;
  setPollingEnabled(enabled: boolean): void;
  destroy(): void;
};

export function createCopcDebugPanel(
  target: HTMLElement,
  getState: () => CopcDebugPanelState,
): CopcDebugPanel {
  target.innerHTML = `
    <section class="copc-debug-panel__source-summary" aria-label="Current status and active source" data-workbench-group="source">
      <h3 data-field="datasetName"></h3>
      <code class="copc-debug-panel__url" data-field="datasetUrl"></code>
      <p class="dev-status" id="source-status" role="status" aria-live="polite" data-status="loading">Loading configured source…</p>
    </section>
    <div data-point-inspector data-workbench-group="data"></div>
    <details class="copc-debug-panel__section" open data-workbench-group="health">
      <summary>Streaming metrics</summary>
      <dl>
        <div><dt>Metadata points</dt><dd data-field="pointCount"></dd></div>
        <div><dt>Selected nodes</dt><dd data-field="selectedNodeCount"></dd></div>
        <div><dt>Rendered nodes</dt><dd data-field="renderedNodeCount"></dd></div>
        <div><dt>Rendered points</dt><dd data-field="renderedPointCount"></dd></div>
        <div><dt>Stream updates</dt><dd data-field="streamingUpdateCount"></dd></div>
        <div><dt>Active refinement algorithm</dt><dd data-field="refinementAlgorithm"></dd></div>
        <div><dt>Transferred range bytes</dt><dd data-field="rangeFetchBytes"></dd></div>
        <div><dt>Configured point budget</dt><dd data-field="configuredPointBudget"></dd></div>
        <div><dt>Candidate / active points</dt><dd><span data-field="candidateSelectedPointCount"></span> / <span data-field="activeRenderedPointCount"></span></dd></div>
      </dl>
      <details>
        <summary>HTTP Range requests</summary>
        <dl>
          <div><dt>Requested / active / completed</dt><dd><span data-field="rangeRequestsRequested"></span> / <span data-field="rangeRequestsActive"></span> / <span data-field="rangeRequestsCompleted"></span></dd></div>
          <div><dt>Aborted by view changes</dt><dd data-field="rangeRequestsAbortedSuperseded"></dd></div>
          <div><dt>Aborted by lifecycle</dt><dd data-field="rangeRequestsAbortedLifecycle"></dd></div>
          <div><dt>Failed</dt><dd data-field="rangeRequestsFailed"></dd></div>
        </dl>
      </details>
      <details>
        <summary>Priority streaming scheduler</summary>
        <dl>
          <div><dt>Load slots</dt><dd data-field="maxConcurrentNodeLoads"></dd></div>
          <div><dt>Queued / active</dt><dd><span data-field="queuedNodeCount"></span> / <span data-field="activeNodeCount"></span></dd></div>
          <div><dt>Completed / cancelled</dt><dd><span data-field="completedNodeCount"></span> / <span data-field="cancelledNodeCount"></span></dd></div>
          <div><dt>Peak active</dt><dd data-field="peakActiveNodeCount"></dd></div>
          <div><dt>High-priority queued / active</dt><dd data-field="highPriorityQueuedActive"></dd></div>
          <div><dt>Completed / pending priority</dt><dd data-field="completedPendingSchedulingPriority"></dd></div>
          <div><dt>First priority start</dt><dd data-field="firstHighPriorityNodeStartLatency"></dd></div>
          <div><dt>First priority ready</dt><dd data-field="firstHighPriorityNodeReadyLatency"></dd></div>
        </dl>
      </details>
      <details>
        <summary>Motion Lookahead</summary>
        <dl>
          <div><dt>Live enabled / state</dt><dd><span data-field="motionLiveEnabled"></span> / <span data-field="motionLiveState"></span></dd></div>
          <div><dt>Accepted movement samples</dt><dd data-field="motionLiveMovementSamples"></dd></div>
          <div><dt>Live angular velocity</dt><dd data-field="motionLiveAngularVelocity"></dd></div>
          <div><dt>Live predicted displacement</dt><dd data-field="motionLivePrediction"></dd></div>
          <div><dt>Live activity / time since movement</dt><dd><span data-field="motionLiveActivity"></span> / <span data-field="motionLiveAge"></span></dd></div>
          <div><dt>Last selection update</dt><dd data-field="motionSelectionGeneration"></dd></div>
          <div><dt>Selected / rendered nodes</dt><dd data-field="motionSelectionNodes"></dd></div>
          <div><dt>Selection prediction</dt><dd data-field="motionSelectionPrediction"></dd></div>
          <div><dt>Weighted candidates / weight range</dt><dd><span data-field="motionSelectionCandidates"></span> / <span data-field="motionSelectionWeights"></span></dd></div>
          <div><dt>Refinement influence</dt><dd data-field="motionSelectionInfluence"></dd></div>
        </dl>
        <p>Live values update with the inspector. Selection prediction, candidates, weights, selected count, and accepted refinement effects describe the last selection update; rendered count reflects current renderer state.</p>
      </details>
    </details>
    <details class="copc-debug-panel__section" data-workbench-group="source">
      <summary>Source diagnostics</summary>
      <dl>
        <div><dt>Configured HTTP Range policy</dt><dd data-field="configuredRangeValidation"></dd></div>
        <div><dt>Policy scope</dt><dd data-field="rangeValidationScope"></dd></div>
        <div><dt>Probe policy</dt><dd data-field="sourceProbePolicy"></dd></div>
        <div><dt>Last probe source</dt><dd data-field="sourceProbeSource"></dd></div>
        <div><dt>Probe validation level</dt><dd data-field="sourceProbeValidationLevel"></dd></div>
        <div><dt>Reachability</dt><dd data-field="sourceReachable"></dd></div>
        <div><dt>Range support</dt><dd data-field="sourceRange"></dd></div>
        <div><dt>Format</dt><dd data-field="sourceCopc"></dd></div>
        <div><dt>Point format</dt><dd data-field="sourcePointFormat"></dd></div>
        <div><dt>CORS</dt><dd data-field="sourceCors"></dd></div>
      </dl>
      <p class="copc-debug-panel__source-warning" data-field="sourceWarnings"></p>
    </details>
    <details class="copc-debug-panel__section" data-workbench-group="data">
      <summary>Hierarchy diagnostics</summary>
      <dl>
        <div><dt>Requests / cache hits</dt><dd><span data-field="hierarchyRequests"></span> / <span data-field="hierarchyCacheHits"></span></dd></div>
        <div><dt>Loaded pages / entries</dt><dd><span data-field="hierarchyLoadedPages"></span> / <span data-field="hierarchyLoadedEntries"></span></dd></div>
        <div><dt>Page loads active / peak</dt><dd data-field="hierarchyPageConcurrency"></dd></div>
        <div><dt>Source open</dt><dd data-field="hierarchySourceDuration"></dd></div>
        <div><dt>Metadata load</dt><dd data-field="hierarchyMetadataDuration"></dd></div>
        <div><dt>Root hierarchy load</dt><dd data-field="hierarchyRootDuration"></dd></div>
        <div><dt>Last query</dt><dd data-field="hierarchyQueryDuration"></dd></div>
        <div><dt>View need / active distance / cap</dt><dd data-field="viewDistance"></dd></div>
        <div><dt>Active replacements / coarse retained</dt><dd><span data-field="activeReplacementGroups"></span> / <span data-field="coarseNodesRetained"></span></dd></div>
        <div><dt>Refinement commits</dt><dd data-field="refinementReplacementCommits"></dd></div>
        <div><dt>Refined / kept nodes</dt><dd><span data-field="refinedNodeCount"></span> / <span data-field="keptNodeCount"></span></dd></div>
        <div><dt>Frontier nodes / points</dt><dd><span data-field="frontierNodeCount"></span> / <span data-field="frontierPointCount"></span></dd></div>
        <div><dt>Accepted refinements</dt><dd data-field="acceptedRefinementCount"></dd></div>
        <div><dt>Rejected refinements</dt><dd data-field="refinementRejectedByBudget"></dd></div>
        <div><dt>Rejected by node budget</dt><dd data-field="refinementRejectedByNodeBudget"></dd></div>
        <div><dt>Rejected by point budget</dt><dd data-field="refinementRejectedByPointBudget"></dd></div>
        <div><dt>Deferred by incomplete hierarchy</dt><dd data-field="refinementDeferredByIncompleteHierarchyCount"></dd></div>
        <div><dt>Minimum frontier over budget</dt><dd data-field="impossibleMinimumFrontier"></dd></div>
        <div><dt>Visible levels</dt><dd data-field="visibleLevelRange"></dd></div>
      </dl>
    </details>
    <details class="copc-debug-panel__section" data-workbench-group="health">
      <summary>Cache and Worker diagnostics</summary>
      <details>
        <summary>Decoded CPU point cache</summary>
        <dl>
          <div><dt>Byte budget</dt><dd data-field="pointCacheBudget"></dd></div>
          <div><dt>Cached bytes</dt><dd data-field="pointCacheBytes"></dd></div>
          <div><dt>Cached nodes</dt><dd data-field="cachedNodeCount"></dd></div>
          <div><dt>Hits / misses</dt><dd><span data-field="cacheHits"></span> / <span data-field="cacheMisses"></span></dd></div>
          <div><dt>Evictions</dt><dd data-field="cacheEvictionCount"></dd></div>
          <div><dt>Bytes evicted</dt><dd data-field="cacheBytesEvicted"></dd></div>
          <div><dt>Largest entry</dt><dd data-field="largestCachedEntryBytes"></dd></div>
        </dl>
        <p>Typed-array bytes only; Cesium/WebGL memory is not measured.</p>
      </details>
      <details>
        <summary>Rust decode workers</summary>
        <dl>
          <div><dt>Concurrency</dt><dd data-field="workerConcurrency"></dd></div>
          <div><dt>Queue</dt><dd data-field="workerQueue"></dd></div>
        </dl>
      </details>
    </details>
    <details class="copc-debug-panel__section" data-workbench-group="data">
      <summary>Performance and benchmark diagnostics</summary>
      <dl>
        <div><dt>Deferred nodes / points</dt><dd><span data-field="deferredNodeCount"></span> / <span data-field="deferredPointCount"></span></dd></div>
        <div><dt>Budget utilization</dt><dd data-field="budgetUtilization"></dd></div>
        <div><dt>Budget drops</dt><dd data-field="budgetDeferDropCount"></dd></div>
        <div><dt>Candidates before culling</dt><dd data-field="candidatesBeforeCulling"></dd></div>
        <div><dt>Frustum culled</dt><dd data-field="frustumCulledCount"></dd></div>
        <div><dt>SSE threshold</dt><dd data-field="maxScreenSpaceError"></dd></div>
        <div><dt>SSE observed</dt><dd data-field="representativeScreenSpaceError"></dd></div>
        <div><dt>Effective SSE</dt><dd data-field="effectiveScreenSpaceError"></dd></div>
        <div><dt>Refinement centre weight</dt><dd data-field="refinementCenterWeight"></dd></div>
        <div><dt>Scheduling centre weight</dt><dd data-field="schedulingCenterWeight"></dd></div>
        <div><dt>Refinement priority</dt><dd data-field="refinementPriority"></dd></div>
        <div><dt>Scheduling priority</dt><dd data-field="schedulingPriority"></dd></div>
        <div><dt>Detail bias</dt><dd data-field="detailBias"></dd></div>
        <div><dt>Influenced candidates</dt><dd data-field="influenceCandidates"></dd></div>
        <div><dt>Gaze refinements</dt><dd data-field="gazeInfluencedRefinements"></dd></div>
      </dl>
    </details>
    <details class="copc-debug-panel__section" data-workbench-group="data">
      <summary>Advanced internal debug information</summary>
      <details>
        <summary>Metadata</summary>
        <div class="copc-debug-panel__detail"><span>Bounds</span><code data-field="bounds"></code></div>
        <div class="copc-debug-panel__detail"><span>Scale</span><code data-field="scale"></code></div>
        <div class="copc-debug-panel__detail"><span>Offset</span><code data-field="offset"></code></div>
        <div class="copc-debug-panel__detail"><span>Camera direction (ECEF)</span><code data-field="cameraDirection"></code></div>
      </details>
      <details>
        <summary>Selected node keys</summary>
        <code class="copc-debug-panel__nodes" data-field="selectedNodeKeys"></code>
      </details>
      <details>
        <summary>Rendered node keys</summary>
        <code class="copc-debug-panel__nodes" data-field="renderedNodeKeys"></code>
      </details>
      <div class="copc-debug-panel__error" data-field="error" role="alert" hidden></div>
    </details>
  `;

  const fields = new Map<string, HTMLElement>();
  target.querySelectorAll<HTMLElement>("[data-field]").forEach((element) => {
    fields.set(element.dataset.field ?? "", element);
  });
  const pointInspector = createCopcPointInspector(
    target.querySelector<HTMLElement>("[data-point-inspector]")!,
  );
  const panel = target.closest<HTMLElement>(".copc-debug-panel");

  const update = (): void => {
    let state: CopcDebugPanelState;
    try {
      state = getState();
    } catch {
      return;
    }
    const view = buildCopcDebugPanelView(state);

    for (const [field, element] of fields) {
      const value = view[field as keyof CopcDebugPanelView];
      element.textContent = typeof value === "string" ? value : "";
    }

    if (panel) panel.dataset.status = view.statusTone;
    pointInspector.update(state.selectedPoint);
    const errorElement = fields.get("error");
    if (errorElement) {
      errorElement.hidden = !view.error;
    }
  };
  let updateTimer: number | undefined;
  const setPollingEnabled = (enabled: boolean): void => {
    if (enabled) {
      if (updateTimer !== undefined) return;
      update();
      updateTimer = window.setInterval(update, 250);
      return;
    }
    if (updateTimer === undefined) return;
    window.clearInterval(updateTimer);
    updateTimer = undefined;
  };

  return {
    refresh: update,
    setPollingEnabled,
    destroy(): void {
      setPollingEnabled(false);
      pointInspector.destroy();
    },
  };
}
