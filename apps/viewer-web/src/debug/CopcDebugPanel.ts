import type {
  CopcCesiumLayerSnapshot,
  CopcMetadata,
} from '../index';
import type { CopcSourceProbeResult, ProbeTruth } from '../copc/sourceProbe';

export type CopcDebugPanelState = {
  snapshot: CopcCesiumLayerSnapshot;
  metadata?: CopcMetadata;
  sourceProbe?: CopcSourceProbeResult;
  lastError?: string;
};

export type CopcDebugPanelView = {
  datasetName: string;
  datasetUrl: string;
  status: string;
  statusTone: 'loading' | 'ready' | 'error' | 'inactive';
  pointCount: string;
  bounds: string;
  scale: string;
  offset: string;
  selectedNodeCount: string;
  selectedNodeKeys: string;
  renderedNodeCount: string;
  renderedPointCount: string;
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
};

const numberFormatter = new Intl.NumberFormat('en-US');

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
    : '—';
}

function formatVector(vector?: { x: number; y: number; z: number }): string {
  if (!vector) {
    return '—';
  }

  return [vector.x, vector.y, vector.z].map(formatCoordinate).join(', ');
}

function formatProbeTruth(value: ProbeTruth, label: string): string {
  const mark = value === true ? '✓' : value === false ? '✕' : '?';
  return `${mark} ${label}`;
}

function getDatasetName(datasetUrl: string): string {
  const withoutQuery = datasetUrl.split(/[?#]/, 1)[0];
  const encodedName = withoutQuery.split('/').filter(Boolean).at(-1);

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
  const { snapshot, metadata, sourceProbe, lastError } = state;
  const status = lastError
    ? 'Error'
    : snapshot.lifecycle === 'ready'
      ? 'Ready'
      : snapshot.lifecycle === 'loading'
        ? 'Loading'
        : snapshot.lifecycle.charAt(0).toUpperCase() + snapshot.lifecycle.slice(1);
  const statusTone = lastError
    ? 'error'
    : snapshot.lifecycle === 'ready'
      ? 'ready'
      : snapshot.lifecycle === 'loading'
        ? 'loading'
        : 'inactive';

  return {
    datasetName: getDatasetName(snapshot.datasetUrl),
    datasetUrl: snapshot.datasetUrl,
    status,
    statusTone,
    pointCount: metadata ? formatNumber(metadata.pointCount) : '—',
    bounds: metadata
      ? [
          metadata.bounds.minX,
          metadata.bounds.minY,
          metadata.bounds.minZ,
          metadata.bounds.maxX,
          metadata.bounds.maxY,
          metadata.bounds.maxZ,
        ].map(formatCoordinate).join(', ')
      : '—',
    scale: formatVector(metadata?.scale),
    offset: formatVector(metadata?.offset),
    selectedNodeCount: formatNumber(snapshot.selectedNodeKeys.length),
    selectedNodeKeys: snapshot.selectedNodeKeys.length > 0
      ? snapshot.selectedNodeKeys.join(', ')
      : '—',
    renderedNodeCount: formatNumber(snapshot.renderedNodeKeys.length),
    renderedPointCount: formatNumber(snapshot.renderedPointCount),
    configuredPointBudget: formatNumber(snapshot.performance?.configuredPointBudget ?? 0),
    candidateSelectedPointCount: formatNumber(snapshot.performance?.candidateSelectedPointCount ?? 0),
    activeRenderedPointCount: formatNumber(snapshot.performance?.activeRenderedPointCount ?? snapshot.renderedPointCount),
    deferredNodeCount: formatNumber(snapshot.performance?.deferredNodeCount ?? 0),
    deferredPointCount: formatNumber(snapshot.performance?.deferredPointCount ?? 0),
    budgetUtilization: `${formatCoordinate(snapshot.performance?.budgetUtilizationPercent ?? 0)}%`,
    budgetDeferDropCount: formatNumber(snapshot.performance?.budgetDeferDropCount ?? 0),
    maxConcurrentNodeLoads: formatNumber(snapshot.performance?.maxConcurrentNodeLoads ?? 0),
    queuedNodeCount: formatNumber(snapshot.performance?.queuedNodeCount ?? 0),
    activeNodeCount: formatNumber(snapshot.performance?.activeNodeCount ?? 0),
    completedNodeCount: formatNumber(snapshot.performance?.completedNodeCount ?? 0),
    cancelledNodeCount: formatNumber(snapshot.performance?.cancelledNodeCount ?? 0),
    peakActiveNodeCount: formatNumber(snapshot.performance?.peakActiveNodeCount ?? 0),
    firstHighPriorityNodeReadyLatency:
      snapshot.performance?.firstHighPriorityNodeReadyLatencyMs === undefined
        ? '—'
        : `${formatCoordinate(snapshot.performance.firstHighPriorityNodeReadyLatencyMs)} ms`,
    firstHighPriorityNodeStartLatency:
      snapshot.performance?.firstHighPriorityNodeStartLatencyMs === undefined
        ? '—'
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
    candidatesBeforeCulling: formatNumber(snapshot.performance?.candidatesBeforeCulling ?? 0),
    frustumCulledCount: formatNumber(snapshot.performance?.frustumCulledCount ?? 0),
    maxScreenSpaceError: `${formatCoordinate(snapshot.performance?.maxScreenSpaceError ?? 0)} px`,
    representativeScreenSpaceError:
      snapshot.performance?.screenSpaceErrorMin !== undefined
      && snapshot.performance?.screenSpaceErrorMax !== undefined
        ? `${formatCoordinate(snapshot.performance.screenSpaceErrorMin)}–${formatCoordinate(snapshot.performance.screenSpaceErrorMax)} px`
        : '—',
    effectiveScreenSpaceError:
      snapshot.performance?.effectiveScreenSpaceErrorMin !== undefined
      && snapshot.performance?.effectiveScreenSpaceErrorMax !== undefined
        ? `${formatCoordinate(snapshot.performance.effectiveScreenSpaceErrorMin)}–${formatCoordinate(snapshot.performance.effectiveScreenSpaceErrorMax)} px`
        : '—',
    refinementCenterWeight:
      snapshot.performance?.refinementCenterWeightMin !== undefined
      && snapshot.performance?.refinementCenterWeightMax !== undefined
        ? `${formatCoordinate(snapshot.performance.refinementCenterWeightMin)}–${formatCoordinate(snapshot.performance.refinementCenterWeightMax)}`
        : '—',
    schedulingCenterWeight:
      snapshot.performance?.schedulingCenterWeightMin !== undefined
      && snapshot.performance?.schedulingCenterWeightMax !== undefined
        ? `${formatCoordinate(snapshot.performance.schedulingCenterWeightMin)}–${formatCoordinate(snapshot.performance.schedulingCenterWeightMax)}`
        : '—',
    refinementPriority:
      snapshot.performance?.refinementPriorityMin !== undefined
      && snapshot.performance?.refinementPriorityMax !== undefined
        ? `${formatCoordinate(snapshot.performance.refinementPriorityMin)}–${formatCoordinate(snapshot.performance.refinementPriorityMax)}`
        : '—',
    schedulingPriority:
      snapshot.performance?.schedulingPriorityMin !== undefined
      && snapshot.performance?.schedulingPriorityMax !== undefined
        ? `${formatCoordinate(snapshot.performance.schedulingPriorityMin)}–${formatCoordinate(snapshot.performance.schedulingPriorityMax)}`
        : '—',
    detailBias:
      snapshot.performance?.detailBiasMin !== undefined
      && snapshot.performance?.detailBiasMax !== undefined
        ? `${formatCoordinate(snapshot.performance.detailBiasMin)}–${formatCoordinate(snapshot.performance.detailBiasMax)}×`
        : '—',
    influenceCandidates: formatNumber(
      snapshot.performance?.candidatesWithNonZeroInfluenceCount ?? 0,
    ),
    gazeInfluencedRefinements: formatNumber(
      snapshot.performance?.acceptedGazeInfluencedRefinementCount ?? 0,
    ),
    refinedNodeCount: formatNumber(snapshot.performance?.refinedNodeCount ?? 0),
    keptNodeCount: formatNumber(snapshot.performance?.keptNodeCount ?? 0),
    frontierNodeCount: formatNumber(snapshot.performance?.frontierNodeCount ?? 0),
    frontierPointCount: formatNumber(snapshot.performance?.frontierPointCount ?? 0),
    acceptedRefinementCount: formatNumber(snapshot.performance?.acceptedRefinementCount ?? 0),
    refinementRejectedByBudget: formatNumber(
      (snapshot.performance?.refinementRejectedByNodeBudgetCount ?? 0)
      + (snapshot.performance?.refinementRejectedByPointBudgetCount ?? 0),
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
      snapshot.performance?.minimumFrontierExceedsNodeBudget
      || snapshot.performance?.minimumFrontierExceedsPointBudget
        ? 'yes'
        : 'no',
    visibleLevelRange: snapshot.performance?.visibleLevelRange
      ? `${snapshot.performance.visibleLevelRange.min}–${snapshot.performance.visibleLevelRange.max}`
      : '—',
    cameraDirection: formatVector(snapshot.performance?.cameraDirection),
    pointCacheBudget: formatBytes(snapshot.pointCache?.cacheByteBudget ?? 0),
    pointCacheBytes: formatBytes(snapshot.pointCache?.currentCacheBytes ?? 0),
    cachedNodeCount: formatNumber(snapshot.pointCache?.cachedNodeCount ?? 0),
    cacheHits: formatNumber(snapshot.pointCache?.hits ?? 0),
    cacheMisses: formatNumber(snapshot.pointCache?.misses ?? 0),
    cacheEvictionCount: formatNumber(snapshot.pointCache?.evictionCount ?? 0),
    cacheBytesEvicted: formatBytes(snapshot.pointCache?.bytesEvicted ?? 0),
    largestCachedEntryBytes: formatBytes(snapshot.pointCache?.largestCachedEntryBytes ?? 0),
    workerConcurrency: snapshot.worker
      ? `${formatNumber(snapshot.worker.activeCount)} / ${formatNumber(snapshot.worker.workerCount)} active`
      : '—',
    workerQueue: snapshot.worker
      ? `${formatNumber(snapshot.worker.queuedCount)} queued (peak ${formatNumber(snapshot.worker.peakQueuedCount)})`
      : '—',
    sourceReachable: sourceProbe
      ? formatProbeTruth(sourceProbe.reachable, 'Reachable')
      : '—',
    sourceRange: sourceProbe
      ? formatProbeTruth(sourceProbe.rangeSupported, 'HTTP Range / 206')
      : '—',
    sourceCopc: sourceProbe
      ? formatProbeTruth(sourceProbe.copcDetected, 'COPC detected')
      : '—',
    sourcePointFormat: sourceProbe?.pointFormat === undefined
      ? '—'
      : `PDRF ${sourceProbe.pointFormat}`,
    sourceCors: sourceProbe
      ? formatProbeTruth(sourceProbe.corsReadable, 'Browser response readable')
      : '—',
    sourceWarnings: sourceProbe && sourceProbe.warnings.length > 0
      ? sourceProbe.warnings.join(' ')
      : '—',
    error: lastError,
  };
}

export type CopcDebugPanel = {
  destroy(): void;
  hide(): void;
  show(): void;
};

export function createCopcDebugPanel(
  getState: () => CopcDebugPanelState,
): CopcDebugPanel {
  const panel = document.createElement('aside');
  panel.className = 'copc-debug-panel';
  panel.setAttribute('aria-label', 'COPC runtime debug panel');
  panel.innerHTML = `
    <header class="copc-debug-panel__header">
      <div>
        <div class="copc-debug-panel__eyebrow">COPC runtime</div>
        <strong data-field="datasetName"></strong>
      </div>
      <button type="button" data-action="hide" title="Hide panel (Shift+D)">Hide</button>
    </header>
    <div class="copc-debug-panel__url" data-field="datasetUrl"></div>
    <div class="copc-debug-panel__status" data-field="status"></div>
    <details open>
      <summary>Source</summary>
      <dl>
        <div><dt>Reachability</dt><dd data-field="sourceReachable"></dd></div>
        <div><dt>Range</dt><dd data-field="sourceRange"></dd></div>
        <div><dt>Format</dt><dd data-field="sourceCopc"></dd></div>
        <div><dt>Point format</dt><dd data-field="sourcePointFormat"></dd></div>
        <div><dt>CORS</dt><dd data-field="sourceCors"></dd></div>
      </dl>
      <p class="copc-debug-panel__source-warning" data-field="sourceWarnings"></p>
    </details>
    <dl>
      <div><dt>Points</dt><dd data-field="pointCount"></dd></div>
      <div><dt>Selected nodes</dt><dd data-field="selectedNodeCount"></dd></div>
      <div><dt>Rendered nodes</dt><dd data-field="renderedNodeCount"></dd></div>
      <div><dt>Rendered points</dt><dd data-field="renderedPointCount"></dd></div>
      <div><dt>Point budget</dt><dd data-field="configuredPointBudget"></dd></div>
      <div><dt>Candidate points</dt><dd data-field="candidateSelectedPointCount"></dd></div>
      <div><dt>Active points</dt><dd data-field="activeRenderedPointCount"></dd></div>
      <div><dt>Budget utilization</dt><dd data-field="budgetUtilization"></dd></div>
      <div><dt>Deferred nodes</dt><dd data-field="deferredNodeCount"></dd></div>
      <div><dt>Deferred points</dt><dd data-field="deferredPointCount"></dd></div>
      <div><dt>Budget drops</dt><dd data-field="budgetDeferDropCount"></dd></div>
      <div><dt>Stream updates</dt><dd data-field="streamingUpdateCount"></dd></div>
      <div><dt>Before culling</dt><dd data-field="candidatesBeforeCulling"></dd></div>
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
      <div><dt>Nodes refined</dt><dd data-field="refinedNodeCount"></dd></div>
      <div><dt>Nodes kept</dt><dd data-field="keptNodeCount"></dd></div>
      <div><dt>Frontier nodes</dt><dd data-field="frontierNodeCount"></dd></div>
      <div><dt>Frontier points</dt><dd data-field="frontierPointCount"></dd></div>
      <div><dt>Refinements accepted</dt><dd data-field="acceptedRefinementCount"></dd></div>
      <div><dt>Refinements rejected</dt><dd data-field="refinementRejectedByBudget"></dd></div>
      <div><dt>Rejected by node budget</dt><dd data-field="refinementRejectedByNodeBudget"></dd></div>
      <div><dt>Rejected by point budget</dt><dd data-field="refinementRejectedByPointBudget"></dd></div>
      <div><dt>Hierarchy deferred</dt><dd data-field="refinementDeferredByIncompleteHierarchyCount"></dd></div>
      <div><dt>Minimum frontier over budget</dt><dd data-field="impossibleMinimumFrontier"></dd></div>
      <div><dt>Visible levels</dt><dd data-field="visibleLevelRange"></dd></div>
    </dl>
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
    <details open>
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
    <div class="copc-debug-panel__error" data-field="error" role="alert" hidden></div>
  `;
  document.body.append(panel);

  const fields = new Map<string, HTMLElement>();
  panel.querySelectorAll<HTMLElement>('[data-field]').forEach((element) => {
    fields.set(element.dataset.field ?? '', element);
  });

  const update = (): void => {
    const view = buildCopcDebugPanelView(getState());

    for (const [field, element] of fields) {
      const value = view[field as keyof CopcDebugPanelView];
      element.textContent = typeof value === 'string' ? value : '';
    }

    panel.dataset.status = view.statusTone;
    const errorElement = fields.get('error');
    if (errorElement) {
      errorElement.hidden = !view.error;
    }
  };
  const hide = (): void => {
    panel.hidden = true;
  };
  const show = (): void => {
    panel.hidden = false;
    update();
  };
  const handleShortcut = (event: KeyboardEvent): void => {
    if (event.shiftKey && event.key.toLowerCase() === 'd') {
      panel.hidden ? show() : hide();
    }
  };

  panel.querySelector('[data-action="hide"]')?.addEventListener('click', hide);
  window.addEventListener('keydown', handleShortcut);
  update();
  const updateTimer = window.setInterval(update, 250);

  return {
    destroy(): void {
      window.clearInterval(updateTimer);
      window.removeEventListener('keydown', handleShortcut);
      panel.remove();
    },
    hide,
    show,
  };
}
