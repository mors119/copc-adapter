import type { WorkbenchLayerConfig, WorkbenchRenderer } from "../../shared/workbench-config";

/** Public adapter default from docs/API.md; keep aligned with the package contract. */
export const DEFAULT_WORKBENCH_MAX_DEPTH = 6;

export type PlaygroundPerformanceDiagnostics = {
  readonly updateDurationMs?: number;
  readonly nodeSelectionMs?: number;
  readonly selectedNodeCount?: number;
  readonly estimatedSelectedPointCount?: number;
  readonly configuredPointBudget?: number;
  readonly frontierPointCount?: number;
  readonly maxScreenSpaceError?: number;
  readonly acceptedRefinementCount?: number;
  readonly refinementRejectedByNodeBudgetCount?: number;
  readonly refinementRejectedByPointBudgetCount?: number;
  readonly rangeFetchDurationMs?: number;
  readonly rangeFetchBytes?: number;
  readonly decodeDurationMs?: number;
  readonly pointPreparationDurationMs?: number;
  readonly crsTransformDurationMs?: number;
  readonly rendererPreparationDurationMs?: number;
  readonly visibleLevelRange?: { readonly min: number; readonly max: number };
  readonly refinementAlgorithm?: string;
  readonly refinementFocusEnabled?: boolean;
  readonly focusCandidateCount?: number;
  readonly focusInfluencedRefinementCount?: number;
};

export type PlaygroundSnapshot = {
  readonly lifecycle: string;
  readonly renderedPoints: number;
  readonly renderedNodes: number;
  readonly selectedNodes: number;
  readonly selectedNodeKeys?: readonly string[];
  readonly streamingUpdateCount?: number;
  readonly backend?: string;
  readonly visibleLevelRange?: { readonly min: number; readonly max: number };
  readonly refinementAlgorithm?: string;
  readonly refinementFocusEnabled?: boolean;
  readonly focusCandidateCount?: number;
  readonly focusWeightMin?: number;
  readonly focusWeightMax?: number;
  readonly focusInfluencedRefinementCount?: number;
  readonly performance?: PlaygroundPerformanceDiagnostics;
};

export type PlaygroundLayerDiagnostics = {
  readonly snapshot: PlaygroundSnapshot;
  readonly metadataPointCount?: number;
  readonly transition?: {
    readonly activeReplacementGroupCount: number;
    readonly replacementGroupsWaitingCount: number;
    readonly refinementReplacementCommitCount: number;
    readonly collapseReplacementCommitCount: number;
    readonly staleReplacementCancellationCount: number;
    readonly coarseNodesRetainedForCoverageCount: number;
  };
  readonly hierarchy?: {
    readonly pageRequests: number;
    readonly pageCacheHits: number;
    readonly hierarchyBytesFetched: number;
    readonly loadedPageCount: number;
    readonly activePageLoads: number;
    readonly peakActivePageLoads: number;
    readonly lastQueryDurationMs: number;
    readonly loadedEntryCount: number;
  };
  readonly pointCache?: {
    readonly cacheByteBudget: number;
    readonly currentCacheBytes: number;
    readonly cachedNodeCount: number;
    readonly hits: number;
    readonly misses: number;
    readonly evictionCount: number;
    readonly bytesEvicted: number;
  };
  readonly rangeRequests?: {
    readonly requested: number;
    readonly active: number;
    readonly completed: number;
    readonly failed: number;
    readonly abortedSuperseded: number;
    readonly abortedLifecycle: number;
  };
  readonly worker?: {
    readonly workerCount: number;
    readonly activeCount: number;
    readonly queuedCount: number;
    readonly peakActiveCount: number;
    readonly peakQueuedCount: number;
    readonly submittedCount: number;
    readonly completedCount: number;
    readonly cancelledCount: number;
    readonly failedCount: number;
  };
};

export type PlaygroundBrowserMeasurements = {
  readonly loadElapsedMs?: number;
  readonly firstVisiblePointsMs?: number;
  readonly renderIntervalMs?: number;
  readonly longestLongTaskMs?: number;
};

export type PlaygroundDiagnosticsContext = {
  readonly sourceLabel: string;
  readonly renderer: WorkbenchRenderer;
  readonly config: WorkbenchLayerConfig;
  readonly sourceKind: "http" | "local" | "none";
  readonly sourceSizeBytes?: number;
  readonly sourceHttpStatus?: number;
  readonly sourcePartialHttpStatus?: number;
  readonly corsReadable?: boolean | "unknown";
  readonly rangeSupported?: boolean | "unknown";
  readonly copcDetected?: boolean | "unknown";
};

export type DiagnosticsViewModel = {
  readonly sourceLabel: string;
  readonly context: string;
  readonly lifecycle: string;
  readonly renderedPoints: string;
  readonly renderedNodes: string;
  readonly selectedNodes: string;
  readonly selectedPointCost: string;
  readonly metadataPointCount: string;
  readonly visibleLevels: string;
  readonly updateCount: string;
  readonly sourceStatus: string;
  readonly sourceSize: string;
  readonly rangeRequests: string;
  readonly rangeBytesLatestUpdate: string;
  readonly hierarchyRequests: string;
  readonly hierarchyBytes: string;
  readonly hierarchyCache: string;
  readonly transitionSummary: string;
  readonly updateDuration: string;
  readonly selectionDuration: string;
  readonly rangeDuration: string;
  readonly decodeDuration: string;
  readonly preparationDuration: string;
  readonly crsDuration: string;
  readonly rendererDuration: string;
  readonly configuredBudget: string;
  readonly maxScreenSpaceError: string;
  readonly acceptedRefinements: string;
  readonly rejectedRefinements: string;
  readonly cacheBytes: string;
  readonly cacheBudget: string;
  readonly cacheEntries: string;
  readonly cacheHits: string;
  readonly cacheMisses: string;
  readonly cacheEvictions: string;
  readonly cacheBytesEvicted: string;
  readonly workerSummary: string;
  readonly workerDetails: string;
  readonly renderInterval: string;
  readonly approximateRenderCadence: string;
  readonly loadElapsed: string;
  readonly firstVisiblePoints: string;
  readonly longestLongTask: string;
  readonly refinementAlgorithm: string;
  readonly focusState: string;
  readonly focusCandidates: string;
  readonly focusRefinements: string;
};

const UNAVAILABLE = "Not available";

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function formatDiagnosticCount(value: number | undefined): string {
  const finite = finiteNumber(value);
  return finite === undefined
    ? UNAVAILABLE
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(finite);
}

export function formatDiagnosticBytes(value: number | undefined): string {
  if (value === Number.POSITIVE_INFINITY) return "No byte limit";
  const finite = finiteNumber(value);
  if (finite === undefined) return UNAVAILABLE;
  if (finite < 1024) return `${Math.floor(finite)} B`;

  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = finite;
  let unitIndex = -1;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const precision = amount >= 100 ? 0 : 1;
  return `${amount.toFixed(precision)} ${units[unitIndex]}`;
}

export function formatDiagnosticDuration(value: number | undefined): string {
  const finite = finiteNumber(value);
  if (finite === undefined) return UNAVAILABLE;
  return finite >= 1000
    ? `${(finite / 1000).toFixed(2)} s`
    : `${finite.toFixed(1)} ms`;
}

export function formatOptionalBoolean(value: boolean | undefined): string {
  return value === undefined ? UNAVAILABLE : value ? "Yes" : "No";
}

export function displaySourceLabel(sourceName: string, sourceUrl?: string): string {
  if (!sourceUrl) return sourceName;
  try {
    const host = new URL(sourceUrl).host;
    return host ? `${sourceName} · ${host}` : sourceName;
  } catch {
    return sourceName;
  }
}

export function supportsLongTaskObservation(
  observer: typeof PerformanceObserver | undefined,
): boolean {
  return observer?.supportedEntryTypes?.includes("longtask") === true;
}

function formattedOptionalCount(value: number | undefined): string {
  return formatDiagnosticCount(value);
}

function formatApproximateRenderCadence(intervalMs: number | undefined): string {
  const interval = finiteNumber(intervalMs);
  if (interval === undefined || interval === 0) return UNAVAILABLE;
  const framesPerSecond = 1000 / interval;
  const displayRate =
    framesPerSecond >= 10
      ? formatDiagnosticCount(framesPerSecond)
      : framesPerSecond >= 0.1
        ? framesPerSecond.toFixed(1)
        : "<0.1";
  return `~${displayRate} FPS`;
}

export function createDiagnosticsViewModel(
  diagnostics: PlaygroundLayerDiagnostics | undefined,
  context: PlaygroundDiagnosticsContext,
  browser: PlaygroundBrowserMeasurements,
): DiagnosticsViewModel {
  const snapshot = diagnostics?.snapshot;
  const performance = snapshot?.performance;
  const workerApplies = context.config.backend === "rust";
  const workerSummary = !workerApplies
    ? "Not applicable for this backend"
    : diagnostics?.worker
      ? `${formatDiagnosticCount(diagnostics.worker.activeCount)} active / ${formatDiagnosticCount(diagnostics.worker.queuedCount)} queued`
      : "Unavailable in this environment";
  const workerDetails = diagnostics?.worker
    ? `${formatDiagnosticCount(diagnostics.worker.workerCount)} configured · peak ${formatDiagnosticCount(diagnostics.worker.peakActiveCount)} active / ${formatDiagnosticCount(diagnostics.worker.peakQueuedCount)} queued · ${formatDiagnosticCount(diagnostics.worker.submittedCount)} submitted · ${formatDiagnosticCount(diagnostics.worker.completedCount)} completed · ${formatDiagnosticCount(diagnostics.worker.cancelledCount)} cancelled · ${formatDiagnosticCount(diagnostics.worker.failedCount)} failed`
    : workerSummary;
  const hierarchy = diagnostics?.hierarchy;
  const transition = diagnostics?.transition;
  const cache = diagnostics?.pointCache;
  const levels = snapshot?.visibleLevelRange;
  const renderInterval = finiteNumber(browser.renderIntervalMs);
  const effectiveMaxDepth =
    context.config.maxDepth ?? DEFAULT_WORKBENCH_MAX_DEPTH;
  const rejectedRefinements =
    finiteNumber(performance?.refinementRejectedByNodeBudgetCount) === undefined &&
    finiteNumber(performance?.refinementRejectedByPointBudgetCount) === undefined
      ? UNAVAILABLE
      : `${formatDiagnosticCount(performance?.refinementRejectedByNodeBudgetCount)} node · ${formatDiagnosticCount(performance?.refinementRejectedByPointBudgetCount)} point`;
  const sse =
    context.config.maxScreenSpaceError ?? performance?.maxScreenSpaceError;
  const selectedAlgorithm = snapshot?.refinementAlgorithm;
  const rangeStatus =
    context.rangeSupported === true
      ? "supported"
      : context.rangeSupported === false
        ? "unavailable"
        : "not confirmed";
  const corsStatus =
    context.corsReadable === true
      ? "readable"
      : context.corsReadable === false
        ? "unavailable"
        : "not confirmed";
  const copcStatus =
    context.copcDetected === true
      ? "detected"
      : context.copcDetected === false
        ? "not detected"
        : "not confirmed";
  const sourceStatus =
    context.sourceKind === "http"
      ? `HTTP ${context.sourceHttpStatus === undefined ? "—" : formatDiagnosticCount(context.sourceHttpStatus)} · CORS ${corsStatus} · Range ${rangeStatus} (${context.sourcePartialHttpStatus === undefined ? "—" : formatDiagnosticCount(context.sourcePartialHttpStatus)}) · COPC ${copcStatus}`
      : context.sourceKind === "local"
        ? "Local file"
        : "No source loaded";

  return {
    sourceLabel: context.sourceLabel,
    context: `${context.sourceLabel} · ${context.renderer === "cesium" ? "Cesium" : "Three.js"} · ${context.config.backend === "rust" ? "Rust / WASM" : "copc-js"} · ${context.config.colorMode} · budget ${formattedOptionalCount(context.config.maxRenderedPoints)} points · maxNodes ${formattedOptionalCount(context.config.maxNodes)} · maxDepth ${formatDiagnosticCount(effectiveMaxDepth)} · SSE ${sse === undefined ? UNAVAILABLE : `${formatDiagnosticCount(sse)} px`}`,
    lifecycle: snapshot?.lifecycle ?? UNAVAILABLE,
    renderedPoints: formatDiagnosticCount(snapshot?.renderedPoints),
    renderedNodes: formatDiagnosticCount(snapshot?.renderedNodes),
    selectedNodes: formatDiagnosticCount(snapshot?.selectedNodes),
    selectedPointCost: formatDiagnosticCount(
      performance?.estimatedSelectedPointCount ?? performance?.frontierPointCount,
    ),
    metadataPointCount: formatDiagnosticCount(diagnostics?.metadataPointCount),
    visibleLevels: levels
      ? `${formatDiagnosticCount(levels.min)}–${formatDiagnosticCount(levels.max)}`
      : UNAVAILABLE,
    updateCount: formatDiagnosticCount(snapshot?.streamingUpdateCount),
    sourceStatus,
    sourceSize: formatDiagnosticBytes(context.sourceSizeBytes),
    rangeRequests: diagnostics?.rangeRequests
      ? `${formatDiagnosticCount(diagnostics.rangeRequests.requested)} total · ${formatDiagnosticCount(diagnostics.rangeRequests.active)} active`
      : UNAVAILABLE,
    rangeBytesLatestUpdate: formatDiagnosticBytes(performance?.rangeFetchBytes),
    hierarchyRequests: hierarchy
      ? `${formatDiagnosticCount(hierarchy.pageRequests)} total · ${formatDiagnosticCount(hierarchy.activePageLoads)} active`
      : UNAVAILABLE,
    hierarchyBytes: formatDiagnosticBytes(hierarchy?.hierarchyBytesFetched),
    hierarchyCache: hierarchy
      ? `${formatDiagnosticCount(hierarchy.pageCacheHits)} hits · ${formatDiagnosticCount(hierarchy.loadedPageCount)} loaded pages`
      : UNAVAILABLE,
    transitionSummary: transition
      ? `${formatDiagnosticCount(transition.activeReplacementGroupCount)} active / ${formatDiagnosticCount(transition.replacementGroupsWaitingCount)} waiting · ${formatDiagnosticCount(transition.coarseNodesRetainedForCoverageCount)} coarse retained · ${formatDiagnosticCount(transition.refinementReplacementCommitCount)} refined / ${formatDiagnosticCount(transition.collapseReplacementCommitCount)} collapsed · ${formatDiagnosticCount(transition.staleReplacementCancellationCount)} stale cancelled`
      : UNAVAILABLE,
    updateDuration: formatDiagnosticDuration(performance?.updateDurationMs),
    selectionDuration: formatDiagnosticDuration(performance?.nodeSelectionMs),
    rangeDuration: formatDiagnosticDuration(performance?.rangeFetchDurationMs),
    decodeDuration: formatDiagnosticDuration(performance?.decodeDurationMs),
    preparationDuration: formatDiagnosticDuration(performance?.pointPreparationDurationMs),
    crsDuration:
      context.config.backend === "rust" &&
      (performance?.crsTransformDurationMs ?? 0) === 0 &&
      (performance?.pointPreparationDurationMs ?? 0) > 0
        ? "Included in point preparation"
        : formatDiagnosticDuration(performance?.crsTransformDurationMs),
    rendererDuration: formatDiagnosticDuration(performance?.rendererPreparationDurationMs),
    configuredBudget: formatDiagnosticCount(
      performance?.configuredPointBudget ?? context.config.maxRenderedPoints,
    ),
    maxScreenSpaceError: sse === undefined ? UNAVAILABLE : `${formatDiagnosticCount(sse)} px`,
    acceptedRefinements: formatDiagnosticCount(performance?.acceptedRefinementCount),
    rejectedRefinements,
    cacheBytes: formatDiagnosticBytes(cache?.currentCacheBytes),
    cacheBudget: formatDiagnosticBytes(cache?.cacheByteBudget),
    cacheEntries: formatDiagnosticCount(cache?.cachedNodeCount),
    cacheHits: formatDiagnosticCount(cache?.hits),
    cacheMisses: formatDiagnosticCount(cache?.misses),
    cacheEvictions: formatDiagnosticCount(cache?.evictionCount),
    cacheBytesEvicted: formatDiagnosticBytes(cache?.bytesEvicted),
    workerSummary,
    workerDetails,
    renderInterval: formatDiagnosticDuration(renderInterval),
    approximateRenderCadence: formatApproximateRenderCadence(renderInterval),
    loadElapsed: formatDiagnosticDuration(browser.loadElapsedMs),
    firstVisiblePoints: formatDiagnosticDuration(browser.firstVisiblePointsMs),
    longestLongTask: formatDiagnosticDuration(browser.longestLongTaskMs),
    refinementAlgorithm:
      selectedAlgorithm === "foveated"
        ? "Foveated"
        : selectedAlgorithm === "screen-projection"
          ? "Screen projection (legacy)"
          : selectedAlgorithm ?? UNAVAILABLE,
    focusState: formatOptionalBoolean(snapshot?.refinementFocusEnabled),
    focusCandidates: formatDiagnosticCount(snapshot?.focusCandidateCount),
    focusRefinements: formatDiagnosticCount(snapshot?.focusInfluencedRefinementCount),
  };
}

export type DiagnosticsIntervalScheduler = (
  callback: () => void,
  intervalMs: number,
) => number;
export type DiagnosticsIntervalCanceller = (handle: number) => void;

/** Polls the current diagnostics source and returns an idempotent cleanup function. */
export function createDiagnosticsRefreshLoop<T>(
  readCurrent: () => T,
  render: (value: T) => void,
  schedule: DiagnosticsIntervalScheduler = (callback, intervalMs) =>
    globalThis.setInterval(callback, intervalMs) as unknown as number,
  cancel: DiagnosticsIntervalCanceller = (handle) =>
    globalThis.clearInterval(handle),
  intervalMs = 500,
): () => void {
  let disposed = false;
  const handle = schedule(() => {
    if (!disposed) render(readCurrent());
  }, intervalMs);
  return () => {
    if (disposed) return;
    disposed = true;
    cancel(handle);
  };
}
