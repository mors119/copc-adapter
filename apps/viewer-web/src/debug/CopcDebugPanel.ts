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
  streamingUpdateCount: string;
  candidatesBeforeCulling: string;
  frustumCulledCount: string;
  visibleLevelRange: string;
  cameraDirection: string;
  error?: string;
};

const numberFormatter = new Intl.NumberFormat('en-US');

function formatNumber(value: number): string {
  return numberFormatter.format(value);
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
    streamingUpdateCount: formatNumber(snapshot.streamingUpdateCount),
    candidatesBeforeCulling: formatNumber(snapshot.performance?.candidatesBeforeCulling ?? 0),
    frustumCulledCount: formatNumber(snapshot.performance?.frustumCulledCount ?? 0),
    visibleLevelRange: snapshot.performance?.visibleLevelRange
      ? `${snapshot.performance.visibleLevelRange.min}–${snapshot.performance.visibleLevelRange.max}`
      : '—',
    cameraDirection: formatVector(snapshot.performance?.cameraDirection),
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
      <div><dt>Stream updates</dt><dd data-field="streamingUpdateCount"></dd></div>
      <div><dt>Before culling</dt><dd data-field="candidatesBeforeCulling"></dd></div>
      <div><dt>Frustum culled</dt><dd data-field="frustumCulledCount"></dd></div>
      <div><dt>Visible levels</dt><dd data-field="visibleLevelRange"></dd></div>
    </dl>
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
