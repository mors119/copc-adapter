import type {
  CopcCesiumLayerSnapshot,
  CopcMetadata,
} from '../index';

export type CopcDebugPanelState = {
  snapshot: CopcCesiumLayerSnapshot;
  metadata?: CopcMetadata;
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
  streamingUpdateCount: string;
  candidatesBeforeCulling: string;
  frustumCulledCount: string;
  maxScreenSpaceError: string;
  representativeScreenSpaceError: string;
  refinedNodeCount: string;
  keptNodeCount: string;
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

function formatVector(vector?: { x: number; y: number; z: number }): string {
  if (!vector) {
    return '—';
  }

  return [vector.x, vector.y, vector.z].map(formatCoordinate).join(', ');
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
  const { snapshot, metadata, lastError } = state;
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
    streamingUpdateCount: formatNumber(snapshot.streamingUpdateCount),
    candidatesBeforeCulling: formatNumber(snapshot.performance?.candidatesBeforeCulling ?? 0),
    frustumCulledCount: formatNumber(snapshot.performance?.frustumCulledCount ?? 0),
    maxScreenSpaceError: `${formatCoordinate(snapshot.performance?.maxScreenSpaceError ?? 0)} px`,
    representativeScreenSpaceError:
      snapshot.performance?.screenSpaceErrorMin !== undefined
      && snapshot.performance?.screenSpaceErrorMax !== undefined
        ? `${formatCoordinate(snapshot.performance.screenSpaceErrorMin)}–${formatCoordinate(snapshot.performance.screenSpaceErrorMax)} px`
        : '—',
    refinedNodeCount: formatNumber(snapshot.performance?.refinedNodeCount ?? 0),
    keptNodeCount: formatNumber(snapshot.performance?.keptNodeCount ?? 0),
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
      <div><dt>Nodes refined</dt><dd data-field="refinedNodeCount"></dd></div>
      <div><dt>Nodes kept</dt><dd data-field="keptNodeCount"></dd></div>
      <div><dt>Visible levels</dt><dd data-field="visibleLevelRange"></dd></div>
    </dl>
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
