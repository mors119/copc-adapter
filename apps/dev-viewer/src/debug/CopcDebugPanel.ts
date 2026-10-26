import type {
  CopcCesiumLayerSnapshot,
  CopcCrsIdentityDiagnostic,
  CopcCrsUnitDiagnostic,
  CopcMetadata,
  RangeValidationPolicy,
} from "@frillab/copc-adapter";
import type { CopcThreeLayerSnapshot } from "@frillab/copc-adapter/three";
import type {
  CopcHierarchyDiagnostics,
  CopcSourceProbeResult,
  ProbeTruth,
} from "@frillab/copc-adapter";
import {
  mountDiagnosticSections,
  type DiagnosticSectionDefinition,
  type DiagnosticSectionsController,
} from "../../../shared/diagnostics/DiagnosticSections.ts";

export type CopcDebugPanelState = {
  snapshot: CopcCesiumLayerSnapshot | CopcThreeLayerSnapshot;
  metadata?: CopcMetadata;
  hierarchy?: CopcHierarchyDiagnostics;
  sourceProbe?: CopcSourceProbeResult;
  safeSourceProbeLabel?: string;
  safeSourceProbeWarnings?: string;
  snapshotIsAvailable?: boolean;
  configuredRangeValidation: RangeValidationPolicy;
  sourceProbePolicy?: RangeValidationPolicy;
  rangeValidationApplicable: boolean;
  lastError?: string;
};

export type CopcDebugPanelView = {
  datasetName: string;
  datasetUrl: string;
  status: string;
  statusTone: "loading" | "ready" | "error" | "inactive";
  pointCount: string;
  sourceCrsWkt: string;
  horizontalCrs: string;
  horizontalUnits: string;
  horizontalAxisOrder: string;
  verticalCrs: string;
  verticalUnits: string;
  verticalHeightKind: string;
  sourceWktSupport: string;
  crsReasons: string;
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

function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? "—" : formatNumber(value);
}

function formatOptionalBytes(value: number | undefined): string {
  return value === undefined ? "—" : formatBytes(value);
}

function formatOptionalCoordinate(value: number | undefined): string {
  return value === undefined ? "—" : formatCoordinate(value);
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
  const liveMotion = snapshot.performance?.motionLive;
  const hasSnapshot = state.snapshotIsAvailable ?? true;
  const rangeRequests =
    "rangeRequests" in snapshot ? snapshot.rangeRequests : undefined;
  const status = !hasSnapshot
    ? "Not loaded"
    : lastError
    ? "Error"
    : snapshot.lifecycle === "ready"
      ? "Ready"
      : snapshot.lifecycle === "loading"
        ? "Loading"
        : snapshot.lifecycle.charAt(0).toUpperCase() +
          snapshot.lifecycle.slice(1);
  const statusTone = !hasSnapshot
    ? "inactive"
    : lastError
    ? "error"
    : snapshot.lifecycle === "ready"
      ? "ready"
      : snapshot.lifecycle === "loading"
        ? "loading"
        : "inactive";
  const crs = metadata?.crsDiagnostic;
  const formatIdentity = (identity: CopcCrsIdentityDiagnostic | undefined): string => {
    if (!identity) return "Unknown";
    const code = identity.authority && identity.code
      ? `${identity.authority}:${identity.code}`
      : undefined;
    return [code, identity.name].filter(Boolean).join(" · ");
  };
  const formatUnits = (unit: CopcCrsUnitDiagnostic): string =>
    unit.name === undefined
      ? "Unknown"
      : `${unit.name}${unit.toSi === undefined ? "" : ` · ${formatCoordinate(unit.toSi)} ${unit.kind === "angular" ? "radians" : "metres"} per unit`}`;

  return {
    datasetName: getDatasetName(snapshot.datasetUrl),
    datasetUrl: snapshot.datasetUrl,
    refinementAlgorithm:
      snapshot.performance?.refinementAlgorithm ?? "—",
    motionLiveEnabled:
      liveMotion?.enabled === undefined
        ? snapshot.performance?.motionLookaheadEnabled === undefined
          ? "—"
          : snapshot.performance.motionLookaheadEnabled ? "on" : "off"
        : liveMotion.enabled ? "on" : "off",
    motionLiveState: liveMotion?.state ?? "—",
    motionLiveMovementSamples: formatOptionalNumber(
      liveMotion?.acceptedMovementSampleCount ??
        snapshot.performance?.motionSampledMovementCount,
    ),
    motionLiveAngularVelocity: liveMotion
      ? `${formatCoordinate(liveMotion.horizontalAngularVelocityDegreesPerSecond)}°/s horizontal · ${formatCoordinate(liveMotion.verticalAngularVelocityDegreesPerSecond)}°/s vertical`
      : "—",
    motionLivePrediction: liveMotion
      ? `${formatCoordinate(liveMotion.predictedHorizontalDisplacementDegrees)}° horizontal · ${formatCoordinate(liveMotion.predictedVerticalDisplacementDegrees)}° vertical (${liveMotion.horizonMilliseconds} ms)`
      : "—",
    motionLiveActivity: formatOptionalCoordinate(liveMotion?.activity),
    motionLiveAge:
      liveMotion?.millisecondsSinceLastAcceptedMovement === undefined
        ? liveMotion ? "no accepted movement sample" : "—"
        : `${formatCoordinate(liveMotion.millisecondsSinceLastAcceptedMovement)} ms`,
    motionSelectionPrediction:
      snapshot.performance?.motionPredictedHorizontalDisplacementDegrees === undefined ||
      snapshot.performance.motionPredictedVerticalDisplacementDegrees === undefined
        ? "—"
        : `${formatCoordinate(snapshot.performance.motionPredictedHorizontalDisplacementDegrees)}° horizontal · ${formatCoordinate(snapshot.performance.motionPredictedVerticalDisplacementDegrees)}° vertical`,
    motionSelectionCandidates: formatOptionalNumber(
      snapshot.performance?.motionCandidateCount,
    ),
    motionSelectionWeights: formatPriorityRange(
      snapshot.performance?.motionWeightMin,
      snapshot.performance?.motionWeightMax,
    ),
    motionSelectionInfluence:
      snapshot.performance?.motionInfluencedRefinementCount === undefined
        ? "—"
        : snapshot.performance.motionInfluencedRefinementCount > 0
          ? `${formatNumber(snapshot.performance.motionInfluencedRefinementCount)} accepted refinement${snapshot.performance.motionInfluencedRefinementCount === 1 ? "" : "s"} influenced`
          : snapshot.performance.motionCandidateCount === undefined
            ? "—"
            : snapshot.performance.motionCandidateCount > 0
              ? "weighted candidates; no accepted refinement changed"
              : "no motion-weighted candidates",
    rangeFetchBytes: formatOptionalBytes(snapshot.performance?.rangeFetchBytes),
    configuredRangeValidation: state.configuredRangeValidation,
    sourceProbePolicy: sourceProbe
      ? (state.sourceProbePolicy ?? "—")
      : state.rangeValidationApplicable
        ? "—"
        : "not applicable · local File",
    sourceProbeSource: sourceProbe
      ? (state.safeSourceProbeLabel ?? "Source checked")
      : "—",
    sourceProbeValidationLevel:
      sourceProbe?.validationLevel ??
      (state.rangeValidationApplicable ? "—" : "not applicable · local File"),
    rangeValidationScope: state.rangeValidationApplicable
      ? "HTTP/HTTPS source"
      : "Not applicable · local File",
    status,
    statusTone,
    pointCount: metadata ? formatNumber(metadata.pointCount) : "—",
    sourceCrsWkt: metadata
      ? metadata.wkt?.trim()
        ? "WKT provided by source"
        : "WKT not provided by source"
      : "—",
    horizontalCrs: formatIdentity(crs?.horizontal.identity),
    horizontalUnits: formatUnits(crs?.horizontal.units ?? { kind: "unknown", certainty: "unknown" }),
    horizontalAxisOrder: crs?.horizontal.axisOrder.order ?? "Unknown",
    verticalCrs: formatIdentity(crs?.vertical.identity),
    verticalUnits: formatUnits(crs?.vertical.units ?? { kind: "unknown", certainty: "unknown" }),
    verticalHeightKind: crs
      ? `${crs.vertical.heightKind.value} (${crs.vertical.heightKind.certainty})`
      : "Unknown",
    sourceWktSupport: crs
      ? `${crs.wkt.format} · metadata ${crs.wkt.metadataSupport} · transforms backend-dependent`
      : "Unknown",
    crsReasons: crs?.reasons.map((reason) => `${reason.code}: ${reason.message}`).join(" ") || "None",
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
    selectedNodeCount: hasSnapshot
      ? formatNumber(snapshot.selectedNodeKeys.length)
      : "—",
    selectedNodeKeys:
      snapshot.selectedNodeKeys.length > 0
        ? snapshot.selectedNodeKeys.join(", ")
        : "—",
    renderedNodeCount: hasSnapshot
      ? formatNumber(snapshot.renderedNodeKeys.length)
      : "—",
    renderedNodeKeys:
      snapshot.renderedNodeKeys.length > 0
        ? snapshot.renderedNodeKeys.join(", ")
        : "—",
    renderedPointCount: hasSnapshot
      ? formatNumber(snapshot.renderedPointCount)
      : "—",
    hierarchyRequests: formatOptionalNumber(hierarchy?.pageRequests),
    hierarchyCacheHits: formatOptionalNumber(hierarchy?.pageCacheHits),
    hierarchyLoadedPages: formatOptionalNumber(hierarchy?.loadedPageCount),
    hierarchyLoadedEntries: formatOptionalNumber(hierarchy?.loadedEntryCount),
    hierarchyPageConcurrency:
      hierarchy === undefined
        ? "—"
        : `${formatNumber(hierarchy.activePageLoads)} active / ${formatNumber(hierarchy.peakActivePageLoads)} peak`,
    hierarchySourceDuration:
      hierarchy?.sourceOpenDurationMs === undefined
        ? "—"
        : `${formatCoordinate(hierarchy.sourceOpenDurationMs)} ms`,
    hierarchyMetadataDuration:
      hierarchy?.metadataLoadDurationMs === undefined
        ? "—"
        : `${formatCoordinate(hierarchy.metadataLoadDurationMs)} ms`,
    hierarchyRootDuration:
      hierarchy?.rootHierarchyLoadDurationMs === undefined
        ? "—"
        : `${formatCoordinate(hierarchy.rootHierarchyLoadDurationMs)} ms`,
    hierarchyQueryDuration:
      hierarchy?.lastQueryDurationMs === undefined
        ? "—"
        : `${formatCoordinate(hierarchy.lastQueryDurationMs)} ms`,
    viewDistance: snapshot.viewDistance
      ? `${
          snapshot.viewDistance.visibleFootprintMeters === undefined
            ? "fallback"
            : `${formatCoordinate(snapshot.viewDistance.visibleFootprintMeters)} m`
        } / ${formatCoordinate(snapshot.viewDistance.effectiveDistanceMeters)} m / ${formatCoordinate(snapshot.viewDistance.maxRenderDistanceMeters)} m cap · ${snapshot.viewDistance.transition}${snapshot.viewDistance.clampedToMaxRenderDistance ? " · capped" : ""} · overscan ${formatCoordinate(snapshot.viewDistance.overscanFactor)}× · expand ${formatNumber(snapshot.viewDistance.expansionCount)} / shrink ${formatNumber(snapshot.viewDistance.shrinkCount)} / hold ${formatNumber(snapshot.viewDistance.hysteresisHoldCount)} / fallback ${formatNumber(snapshot.viewDistance.fallbackCount)}`
      : "—",
    activeReplacementGroups: formatOptionalNumber(
      snapshot.transition?.activeReplacementGroupCount,
    ),
    coarseNodesRetained: formatOptionalNumber(
      snapshot.transition?.coarseNodesRetainedForCoverageCount,
    ),
    refinementReplacementCommits: formatOptionalNumber(
      snapshot.transition?.refinementReplacementCommitCount,
    ),
    configuredPointBudget: formatOptionalNumber(
      snapshot.performance?.configuredPointBudget,
    ),
    candidateSelectedPointCount: formatOptionalNumber(
      snapshot.performance?.candidateSelectedPointCount,
    ),
    deferredNodeCount: formatOptionalNumber(
      snapshot.performance?.deferredNodeCount,
    ),
    deferredPointCount: formatOptionalNumber(
      snapshot.performance?.deferredPointCount,
    ),
    budgetUtilization:
      snapshot.performance?.budgetUtilizationPercent === undefined
        ? "—"
        : `${formatCoordinate(snapshot.performance.budgetUtilizationPercent)}%`,
    budgetDeferDropCount: formatOptionalNumber(
      snapshot.performance?.budgetDeferDropCount,
    ),
    maxConcurrentNodeLoads: formatOptionalNumber(
      snapshot.performance?.maxConcurrentNodeLoads,
    ),
    queuedNodeCount: formatOptionalNumber(snapshot.performance?.queuedNodeCount),
    activeNodeCount: formatOptionalNumber(snapshot.performance?.activeNodeCount),
    completedNodeCount: formatOptionalNumber(
      snapshot.performance?.completedNodeCount,
    ),
    cancelledNodeCount: formatOptionalNumber(
      snapshot.performance?.cancelledNodeCount,
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
    peakActiveNodeCount: formatOptionalNumber(
      snapshot.performance?.peakActiveNodeCount,
    ),
    firstHighPriorityNodeReadyLatency:
      snapshot.performance?.firstHighPriorityNodeReadyLatencyMs === undefined
        ? "—"
        : `${formatCoordinate(snapshot.performance.firstHighPriorityNodeReadyLatencyMs)} ms`,
    firstHighPriorityNodeStartLatency:
      snapshot.performance?.firstHighPriorityNodeStartLatencyMs === undefined
        ? "—"
        : `${formatCoordinate(snapshot.performance.firstHighPriorityNodeStartLatencyMs)} ms`,
    highPriorityQueuedActive:
      snapshot.performance?.queuedHighPriorityNodeCount === undefined ||
      snapshot.performance.activeHighPriorityNodeCount === undefined
        ? "—"
        : `${formatNumber(snapshot.performance.queuedHighPriorityNodeCount)} / ${formatNumber(snapshot.performance.activeHighPriorityNodeCount)}`,
    completedPendingSchedulingPriority: `${formatPriorityRange(
      snapshot.performance?.completedSchedulingPriorityMin,
      snapshot.performance?.completedSchedulingPriorityMax,
    )} / ${formatPriorityRange(
      snapshot.performance?.pendingSchedulingPriorityMin,
      snapshot.performance?.pendingSchedulingPriorityMax,
    )}`,
    streamingUpdateCount: hasSnapshot
      ? formatNumber(snapshot.streamingUpdateCount)
      : "—",
    candidatesBeforeCulling: formatOptionalNumber(
      snapshot.performance?.candidatesBeforeCulling,
    ),
    frustumCulledCount: formatOptionalNumber(
      snapshot.performance?.frustumCulledCount,
    ),
    maxScreenSpaceError:
      snapshot.performance?.maxScreenSpaceError === undefined
        ? "—"
        : `${formatCoordinate(snapshot.performance.maxScreenSpaceError)} px`,
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
    influenceCandidates: formatOptionalNumber(
      snapshot.performance?.candidatesWithNonZeroInfluenceCount,
    ),
    gazeInfluencedRefinements: formatOptionalNumber(
      snapshot.performance?.acceptedGazeInfluencedRefinementCount,
    ),
    refinedNodeCount: formatOptionalNumber(snapshot.performance?.refinedNodeCount),
    keptNodeCount: formatOptionalNumber(snapshot.performance?.keptNodeCount),
    frontierNodeCount: formatOptionalNumber(
      snapshot.performance?.frontierNodeCount,
    ),
    frontierPointCount: formatOptionalNumber(
      snapshot.performance?.frontierPointCount,
    ),
    acceptedRefinementCount: formatOptionalNumber(
      snapshot.performance?.acceptedRefinementCount,
    ),
    refinementRejectedByBudget:
      snapshot.performance?.refinementRejectedByNodeBudgetCount === undefined &&
      snapshot.performance?.refinementRejectedByPointBudgetCount === undefined
        ? "—"
        : `${formatOptionalNumber(snapshot.performance.refinementRejectedByNodeBudgetCount)} node · ${formatOptionalNumber(snapshot.performance.refinementRejectedByPointBudgetCount)} point`,
    refinementRejectedByNodeBudget: formatOptionalNumber(
      snapshot.performance?.refinementRejectedByNodeBudgetCount,
    ),
    refinementRejectedByPointBudget: formatOptionalNumber(
      snapshot.performance?.refinementRejectedByPointBudgetCount,
    ),
    refinementDeferredByIncompleteHierarchyCount: formatOptionalNumber(
      snapshot.performance?.refinementDeferredByIncompleteHierarchyCount,
    ),
    impossibleMinimumFrontier:
      snapshot.performance?.minimumFrontierExceedsNodeBudget === undefined &&
      snapshot.performance?.minimumFrontierExceedsPointBudget === undefined
        ? "—"
        : snapshot.performance?.minimumFrontierExceedsNodeBudget === true ||
            snapshot.performance?.minimumFrontierExceedsPointBudget === true
          ? "yes"
          : "no",
    visibleLevelRange: snapshot.performance?.visibleLevelRange
      ? `${snapshot.performance.visibleLevelRange.min}–${snapshot.performance.visibleLevelRange.max}`
      : "—",
    cameraDirection: formatVector(snapshot.performance?.cameraDirection),
    pointCacheBudget: formatOptionalBytes(snapshot.pointCache?.cacheByteBudget),
    pointCacheBytes: formatOptionalBytes(snapshot.pointCache?.currentCacheBytes),
    cachedNodeCount: formatOptionalNumber(snapshot.pointCache?.cachedNodeCount),
    cacheHits: formatOptionalNumber(snapshot.pointCache?.hits),
    cacheMisses: formatOptionalNumber(snapshot.pointCache?.misses),
    cacheEvictionCount: formatOptionalNumber(
      snapshot.pointCache?.evictionCount,
    ),
    cacheBytesEvicted: formatOptionalBytes(snapshot.pointCache?.bytesEvicted),
    largestCachedEntryBytes: formatOptionalBytes(
      snapshot.pointCache?.largestCachedEntryBytes,
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
      sourceProbe
        ? state.safeSourceProbeWarnings ??
          ([...new Set(sourceProbe.warnings)].join(" ") || "—")
        : "—",
    error: lastError,
  };
}

export type CopcDebugPanel = {
  refresh(): void;
  setPollingEnabled(enabled: boolean): void;
  destroy(): void;
};

export type CopcDebugPanelTargets = {
  readonly source: HTMLElement;
  readonly health: HTMLElement;
  readonly data: HTMLElement;
};

export const COPC_DEBUG_SOURCE_SECTIONS = [
  {
    id: "source-current",
    title: "Current source",
    initiallyOpen: true,
    fields: [
      { key: "datasetName", label: "Source name" },
      { key: "datasetUrl", label: "Source label" },
      { key: "pointCount", label: "Point count" },
      { key: "sourceCrsWkt", label: "Coordinate reference metadata" },
      { key: "sourceWktSupport", label: "WKT syntax support" },
      { key: "horizontalCrs", label: "Horizontal CRS" },
      { key: "horizontalUnits", label: "Horizontal units" },
      { key: "horizontalAxisOrder", label: "Horizontal axis order" },
      { key: "verticalCrs", label: "Vertical CRS" },
      { key: "verticalUnits", label: "Vertical units" },
      { key: "verticalHeightKind", label: "Source height kind" },
      { key: "crsReasons", label: "CRS diagnostic reasons" },
      { key: "bounds", label: "Bounds" },
      { key: "scale", label: "Scale" },
      { key: "offset", label: "Offset" },
    ],
  },
  {
    id: "source-probe",
    title: "Range, CORS, and format validation",
    fields: [
      { key: "configuredRangeValidation", label: "Configured HTTP Range policy" },
      { key: "rangeValidationScope", label: "Policy scope" },
      { key: "sourceProbePolicy", label: "Probe policy" },
      { key: "sourceProbeSource", label: "Last probe source" },
      { key: "sourceProbeValidationLevel", label: "Probe validation level" },
      { key: "sourceReachable", label: "Reachability" },
      { key: "sourceRange", label: "Range support" },
      { key: "sourceCopc", label: "COPC detected" },
      { key: "sourcePointFormat", label: "Point format" },
      { key: "sourceCors", label: "Browser readability (CORS)" },
      { key: "sourceWarnings", label: "Warnings" },
    ],
  },
] satisfies readonly DiagnosticSectionDefinition[];

export const COPC_DEBUG_HEALTH_SECTIONS = [
  {
    id: "health-runtime",
    title: "Runtime status",
    initiallyOpen: true,
    fields: [
      { key: "status", label: "Lifecycle" },
      { key: "renderedPointCount", label: "Rendered points" },
      { key: "renderedNodeCount", label: "Rendered nodes" },
      { key: "selectedNodeCount", label: "Selected nodes" },
      { key: "streamingUpdateCount", label: "Streaming updates" },
      { key: "rangeFetchBytes", label: "Range bytes, latest update" },
      { key: "error", label: "Last error" },
    ],
  },
  {
    id: "health-range",
    title: "HTTP Range activity",
    fields: [
      { key: "rangeRequestsRequested", label: "Requested" },
      { key: "rangeRequestsActive", label: "Active" },
      { key: "rangeRequestsCompleted", label: "Completed" },
      { key: "rangeRequestsFailed", label: "Failed" },
      { key: "rangeRequestsAbortedSuperseded", label: "Aborted by view changes" },
      { key: "rangeRequestsAbortedLifecycle", label: "Aborted by lifecycle" },
    ],
  },
  {
    id: "health-cache",
    title: "Decoded CPU point cache",
    description: "Typed-array bytes only; Cesium/WebGL memory is not measured.",
    fields: [
      { key: "pointCacheBudget", label: "Byte budget" },
      { key: "pointCacheBytes", label: "Cached bytes" },
      { key: "cachedNodeCount", label: "Cached nodes" },
      { key: "cacheHits", label: "Hits" },
      { key: "cacheMisses", label: "Misses" },
      { key: "cacheEvictionCount", label: "Evictions" },
      { key: "cacheBytesEvicted", label: "Bytes evicted" },
      { key: "largestCachedEntryBytes", label: "Largest entry" },
    ],
  },
  {
    id: "health-worker",
    title: "Rust decode workers",
    fields: [
      { key: "workerConcurrency", label: "Concurrency" },
      { key: "workerQueue", label: "Queue" },
    ],
  },
] satisfies readonly DiagnosticSectionDefinition[];

export const COPC_DEBUG_DATA_SECTIONS = [
  {
    id: "data-hierarchy",
    title: "Hierarchy",
    initiallyOpen: true,
    fields: [
      { key: "hierarchyRequests", label: "Page requests" },
      { key: "hierarchyCacheHits", label: "Page cache hits" },
      { key: "hierarchyLoadedPages", label: "Loaded pages" },
      { key: "hierarchyLoadedEntries", label: "Loaded entries" },
      { key: "hierarchyPageConcurrency", label: "Page loads active / peak" },
      { key: "hierarchySourceDuration", label: "Source open" },
      { key: "hierarchyMetadataDuration", label: "Metadata load" },
      { key: "hierarchyRootDuration", label: "Root hierarchy load" },
      { key: "hierarchyQueryDuration", label: "Last query" },
    ],
  },
  {
    id: "data-view",
    title: "View and level of detail",
    fields: [
      { key: "viewDistance", label: "View need / active distance / cap" },
      { key: "visibleLevelRange", label: "Visible levels" },
      { key: "cameraDirection", label: "Camera direction (ECEF)" },
    ],
  },
  {
    id: "data-coverage",
    title: "Coverage transitions",
    fields: [
      { key: "activeReplacementGroups", label: "Active replacement groups" },
      { key: "coarseNodesRetained", label: "Coarse nodes retained" },
      { key: "refinementReplacementCommits", label: "Refinement replacement commits" },
    ],
  },
  {
    id: "data-scheduler",
    title: "Priority streaming scheduler",
    fields: [
      { key: "maxConcurrentNodeLoads", label: "Load slots" },
      { key: "queuedNodeCount", label: "Queued nodes" },
      { key: "activeNodeCount", label: "Active nodes" },
      { key: "completedNodeCount", label: "Completed nodes" },
      { key: "cancelledNodeCount", label: "Cancelled nodes" },
      { key: "peakActiveNodeCount", label: "Peak active nodes" },
      { key: "highPriorityQueuedActive", label: "High-priority queued / active" },
      { key: "completedPendingSchedulingPriority", label: "Completed / pending priority" },
      { key: "firstHighPriorityNodeStartLatency", label: "First priority start" },
      { key: "firstHighPriorityNodeReadyLatency", label: "First priority ready" },
    ],
  },
  {
    id: "data-refinement",
    title: "Refinement and budget",
    fields: [
      { key: "refinementAlgorithm", label: "Active refinement algorithm" },
      { key: "configuredPointBudget", label: "Configured point budget" },
      { key: "candidateSelectedPointCount", label: "Candidate selected points" },
      { key: "deferredNodeCount", label: "Deferred nodes" },
      { key: "deferredPointCount", label: "Deferred points" },
      { key: "budgetUtilization", label: "Budget utilization" },
      { key: "budgetDeferDropCount", label: "Budget drops" },
      { key: "refinedNodeCount", label: "Refined nodes" },
      { key: "keptNodeCount", label: "Kept nodes" },
      { key: "frontierNodeCount", label: "Frontier nodes" },
      { key: "frontierPointCount", label: "Frontier points" },
      { key: "acceptedRefinementCount", label: "Accepted refinements" },
      { key: "refinementRejectedByBudget", label: "Rejected refinements" },
      { key: "refinementRejectedByNodeBudget", label: "Rejected by node budget" },
      { key: "refinementRejectedByPointBudget", label: "Rejected by point budget" },
      { key: "refinementDeferredByIncompleteHierarchyCount", label: "Deferred by incomplete hierarchy" },
      { key: "impossibleMinimumFrontier", label: "Minimum frontier over budget" },
    ],
  },
  {
    id: "data-refinement-detail",
    title: "Screen-space and influence detail",
    fields: [
      { key: "candidatesBeforeCulling", label: "Candidates before culling" },
      { key: "frustumCulledCount", label: "Frustum culled" },
      { key: "maxScreenSpaceError", label: "SSE threshold" },
      { key: "representativeScreenSpaceError", label: "Observed SSE" },
      { key: "effectiveScreenSpaceError", label: "Effective SSE" },
      { key: "refinementCenterWeight", label: "Refinement centre weight" },
      { key: "schedulingCenterWeight", label: "Scheduling centre weight" },
      { key: "refinementPriority", label: "Refinement priority" },
      { key: "schedulingPriority", label: "Scheduling priority" },
      { key: "detailBias", label: "Detail bias" },
      { key: "influenceCandidates", label: "Influenced candidates" },
      { key: "gazeInfluencedRefinements", label: "Gaze-influenced refinements" },
    ],
  },
  {
    id: "data-motion",
    title: "Motion Lookahead",
    description: "Live values follow camera movement. Prediction and refinement effects describe the most recent selection update.",
    fields: [
      { key: "motionLiveEnabled", label: "Live enabled" },
      { key: "motionLiveState", label: "Live state" },
      { key: "motionLiveMovementSamples", label: "Accepted movement samples" },
      { key: "motionLiveAngularVelocity", label: "Angular velocity" },
      { key: "motionLivePrediction", label: "Predicted displacement" },
      { key: "motionLiveActivity", label: "Live activity" },
      { key: "motionLiveAge", label: "Time since movement" },
      { key: "motionSelectionPrediction", label: "Selection prediction" },
      { key: "motionSelectionCandidates", label: "Weighted candidates" },
      { key: "motionSelectionWeights", label: "Weight range" },
      { key: "motionSelectionInfluence", label: "Refinement influence" },
    ],
  },
  {
    id: "data-node-structure",
    title: "Active node structure",
    fields: [
      {
        key: "selectedNodeKeys",
        label: "Selected node keys",
        valueClassName: "copc-debug-panel__nodes",
      },
      {
        key: "renderedNodeKeys",
        label: "Rendered node keys",
        valueClassName: "copc-debug-panel__nodes",
      },
    ],
  },
] satisfies readonly DiagnosticSectionDefinition[];

export function createCopcDebugPanel(
  targets: CopcDebugPanelTargets,
  getState: () => CopcDebugPanelState,
): CopcDebugPanel {
  const sourcePanel = mountDiagnosticSections(targets.source, COPC_DEBUG_SOURCE_SECTIONS, {
    className: "copc-debug-panel__groups",
    sectionClassName: "copc-debug-panel__section workbench-diagnostic-section",
  });
  const healthPanel = mountDiagnosticSections(targets.health, COPC_DEBUG_HEALTH_SECTIONS, {
    className: "copc-debug-panel__groups",
    sectionClassName: "copc-debug-panel__section workbench-diagnostic-section",
  });
  const dataPanel = mountDiagnosticSections(targets.data, COPC_DEBUG_DATA_SECTIONS, {
    className: "copc-debug-panel__groups",
    sectionClassName: "copc-debug-panel__section workbench-diagnostic-section",
  });
  const debugPanels: readonly DiagnosticSectionsController[] = [
    sourcePanel,
    healthPanel,
    dataPanel,
  ];
  const statusPanel = targets.health.closest<HTMLElement>(".copc-debug-panel");

  const update = (): void => {
    let state: CopcDebugPanelState;
    try {
      state = getState();
    } catch {
      return;
    }
    const view = buildCopcDebugPanelView(state);
    sourcePanel.update(view);
    healthPanel.update(view);
    dataPanel.update(view);
    if (statusPanel) statusPanel.dataset.status = view.statusTone;
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

  update();
  return {
    refresh: update,
    setPollingEnabled,
    destroy(): void {
      setPollingEnabled(false);
      for (const panel of debugPanels) panel.destroy();
    },
  };
}
