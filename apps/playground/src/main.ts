import type {
  CopcCesiumLayer,
  CopcPointInspection,
  CopcSourceProbeResult,
} from '@frillab/copc-adapter/cesium';
import {
  formatUiNumber,
  mountSegmentedControl,
  mountSlider,
  type UiSegmentOption,
} from '../../shared/ui-controls';
import {
  createPlaygroundRuntime,
  type CesiumLayerFactory,
  type PlaygroundBackend,
  type PlaygroundCameraState,
  type PlaygroundCameraView,
  type PlaygroundColorMode,
  type PlaygroundRenderer,
  type PlaygroundRuntime,
  type PlaygroundSnapshot,
  type PlaygroundSource,
} from './rendererRuntime';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('The Playground application root is missing.');

app.innerHTML = `
  <div class="playground-shell">
    <header class="topbar">
      <a class="brand" href="${import.meta.env.BASE_URL}" aria-label="COPC Adapter Playground home">
        <span class="brand-mark" aria-hidden="true">C</span>
        <span class="brand-copy"><strong>COPC Adapter</strong><small>PLAYGROUND</small></span>
      </a>
      <span class="topbar-center"><span class="live-dot" aria-hidden="true"></span> Browser point cloud demo</span>
      <a class="docs-link" href="https://mors119.github.io/copc-adapter/">Documentation <span aria-hidden="true">↗</span></a>
    </header>

    <main class="workbench" aria-label="COPC Adapter Playground">
      <aside class="side-panel source-panel" aria-labelledby="source-heading">
        <div class="panel-heading"><div><span class="eyebrow">SOURCE</span><h1 id="source-heading">Load a point cloud</h1></div></div>
        <p class="panel-intro">Stream a public COPC dataset, provide a browser-readable URL, or choose a local file.</p>
        <label class="ui-field" for="remote-source">Source
          <select id="remote-source">
            <option value="autzen">Autzen Stadium · Oregon</option>
            <option value="chicago">Chicago Downtown</option>
            <option value="custom">Custom URL</option>
          </select>
        </label>
        <label class="ui-field" for="custom-url">COPC URL
          <input id="custom-url" type="url" placeholder="https://host.example/area.copc.laz" autocomplete="url" spellcheck="false" aria-describedby="url-help">
        </label>
        <p class="field-help" id="url-help">The host must allow browser CORS and HTTP Range requests. The URL is requested directly.</p>
        <button class="source-load" id="load-remote" type="button">Probe and load source</button>
        <p class="source-probe ui-status" id="source-probe" role="status" aria-live="polite">Choose a source to check browser access, HTTP Range, and COPC metadata.</p>
        <details class="source-help ui-disclosure">
          <summary>About supported sources</summary>
          <p>HTTP sources must support byte ranges and browser CORS. Local files stay in this browser. Ordinary LAS/LAZ files without COPC hierarchy are unsupported.</p>
        </details>
        <div class="source-separator"><span>or open a local file</span></div>
        <label class="file-picker" for="copc-file">
          <span class="source-symbol" aria-hidden="true">＋</span>
          <strong>Choose a COPC file</strong>
          <span>.copc.laz files are read locally and are not uploaded</span>
          <input id="copc-file" type="file" accept=".copc.laz,.laz,.copc,application/octet-stream">
        </label>
        <p class="source-status ui-status" id="source-status" data-status="unknown" role="status" aria-live="polite">Waiting for a source</p>
      </aside>

      <section class="viewer-column" aria-labelledby="viewer-heading">
        <div class="viewer-toolbar">
          <div class="viewer-title"><span class="eyebrow">VIEWPORT</span><h2 id="viewer-heading">Cesium</h2></div>
          <div class="camera-controls"><span class="control-label">Camera</span><div id="camera-control"></div></div>
        </div>
        <div class="viewer-frame">
          <div id="cesium-container" role="region" aria-label="Interactive Cesium point cloud viewport"></div>
          <div class="scene-overlay"><span class="scene-coordinate">POINT CLOUD · 3D</span></div>
          <div class="stream-hud" id="stream-hud" aria-live="polite">
            <span class="hud-status"><i class="live-dot muted" id="hud-dot" aria-hidden="true"></i><span id="hud-state">Waiting</span></span>
            <span><b id="hud-points">0</b> points</span>
            <span><b id="hud-nodes">0</b> nodes</span>
          </div>
        </div>
        <div class="viewer-footer"><p class="viewer-caption" id="viewer-caption">Select a source to start streaming.</p><span class="renderer-badge" id="renderer-badge">Cesium</span></div>
      </section>

      <aside class="side-panel config-panel" aria-label="Point cloud controls">
        <section class="config-section" aria-labelledby="renderer-heading">
          <div class="section-heading"><div><span class="eyebrow">RENDER</span><h2 id="renderer-heading">Renderer</h2></div></div>
          <div id="renderer-control"></div>
          <label class="control-label backend-label">Backend</label>
          <div id="backend-control"></div>
        </section>
        <section class="config-section" aria-labelledby="appearance-heading">
          <div class="section-heading"><div><span class="eyebrow">DISPLAY</span><h2 id="appearance-heading">Appearance</h2></div></div>
          <span class="control-label">Color mode</span>
          <div id="color-mode" aria-label="Color mode"></div>
          <div class="slider-control" id="point-size-control"></div>
          <p class="control-hint">Slider changes apply when released.</p>
        </section>
        <section class="config-section" aria-labelledby="streaming-heading">
          <div class="section-heading"><div><span class="eyebrow">STREAM</span><h2 id="streaming-heading">Streaming</h2></div></div>
          <div class="slider-control" id="max-nodes-control"></div>
          <div class="slider-control" id="max-points-control"></div>
          <p class="control-hint">Values preview while dragging and apply on release.</p>
        </section>
        <section class="package-card" aria-label="Installed adapter package">
          <span class="package-mark" aria-hidden="true">↗</span>
          <div><strong>Adapter package</strong><span><code>@frillab/copc-adapter</code> v${__ADAPTER_VERSION__}</span><span id="package-source">${__ADAPTER_SOURCE__}</span></div>
        </section>
      </aside>
    </main>

    <section class="below-viewer" aria-label="Source and point details">
      <details class="diagnostics-card" open>
        <summary><span>Diagnostics</span><span class="summary-state" id="diagnostic-summary">Waiting for a source</span></summary>
        <dl class="diagnostics-list">
          <div><dt>Status</dt><dd id="diagnostic-status">Waiting</dd></div>
          <div><dt>HTTP Range</dt><dd id="diagnostic-range">Not checked</dd></div>
          <div><dt>COPC metadata</dt><dd id="diagnostic-copc">Not checked</dd></div>
          <div><dt>Rendered points</dt><dd id="diagnostic-points">0</dd></div>
          <div><dt>Rendered nodes</dt><dd id="diagnostic-nodes">0</dd></div>
          <div><dt>Selected nodes</dt><dd id="diagnostic-selected">0</dd></div>
          <div><dt>Visible LoD</dt><dd id="diagnostic-lod">—</dd></div>
          <div><dt>Validation</dt><dd id="diagnostic-validation">Unknown</dd></div>
        </dl>
        <p class="diagnostic-warning" id="diagnostic-warning" hidden></p>
      </details>
      <section class="point-card" aria-labelledby="point-heading">
        <div class="section-heading"><div><span class="eyebrow">INSPECT</span><h2 id="point-heading">Selected point</h2></div></div>
        <p id="point-empty">Click a point in the viewport to inspect its available attributes.</p>
        <dl id="point-attributes" class="point-attributes" hidden></dl>
      </section>
      <details class="code-card">
        <summary>Use the public API</summary>
        <pre><code id="integration-example">const layer = new CopcCesiumLayer({ url: copcUrl });
await layer.load();
layer.attachTo(viewer);</code></pre>
      </details>
    </section>
    <footer class="statusbar"><span id="footer-status">Ready · No source loaded</span><span>Client-side · No upload</span></footer>
  </div>
`;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing Playground element #${id}.`);
  return element as T;
};

const viewport = byId<HTMLDivElement>('cesium-container');
const sourceStatus = byId<HTMLElement>('source-status');
const sourceProbe = byId<HTMLElement>('source-probe');
const remoteSelect = byId<HTMLSelectElement>('remote-source');
const customUrlInput = byId<HTMLInputElement>('custom-url');
const remoteLoadButton = byId<HTMLButtonElement>('load-remote');
const fileInput = byId<HTMLInputElement>('copc-file');
const rendererHeading = byId<HTMLHeadingElement>('viewer-heading');
const rendererBadge = byId<HTMLElement>('renderer-badge');
const viewerCaption = byId<HTMLElement>('viewer-caption');
const statusFooter = byId<HTMLElement>('footer-status');

let renderer: PlaygroundRenderer = 'cesium';
let backend: PlaygroundBackend = 'copc-js';
let colorMode: PlaygroundColorMode = 'elevation';
let pointSize = 3;
let maxNodes = 24;
let maxRenderedPoints = 250_000;
let sourceGeneration = 0;
let activeLoadPending = false;
let activeSource: PlaygroundSource | undefined;
let activeSourceName = '';
let activeRuntime: PlaygroundRuntime | undefined;
let activeProbeResult: CopcSourceProbeResult | undefined;
let cameraInteractionVersion = 0;
let layerFactory: CesiumLayerFactory | undefined;
let refreshTimer: number | undefined;

for (const eventName of ['pointerdown', 'wheel', 'keydown', 'touchstart']) {
  viewport.addEventListener(eventName, () => { cameraInteractionVersion += 1; }, { passive: true });
}

type PlaygroundTestCameraView = PlaygroundCameraState;

declare global {
  interface Window {
    __COPC_PLAYGROUND_TEST__?: {
      useCameraResetLayerMock(): void;
      delayNextLoad(): void;
      releaseDelayedLoad(): void;
      getMockDestroyCount(): number;
      setCameraView(view: PlaygroundTestCameraView): void;
      getCameraView(): PlaygroundTestCameraView;
      getMockLoadCount(): number;
      getPickablePointScreenPosition(): { x: number; y: number } | undefined;
    };
  }
}

if (import.meta.env.DEV) {
  let mockLoadCount = 0;
  let mockDestroyCount = 0;
  let delayNextMockLoad = false;
  let releaseMockLoad: (() => void) | undefined;
  window.__COPC_PLAYGROUND_TEST__ = {
    useCameraResetLayerMock(): void {
      layerFactory = (() => ({
        attachTo(): void {},
        async load(): Promise<void> {
          mockLoadCount += 1;
          await Promise.resolve();
          activeRuntime?.setCameraState({
            longitude: -122.2,
            latitude: 44.1,
            height: 5000,
            heading: 20,
            pitch: -40,
            roll: 0,
          });
          if (delayNextMockLoad) {
            delayNextMockLoad = false;
            await new Promise<void>((resolve) => { releaseMockLoad = resolve; });
          }
        },
        destroy(): void { mockDestroyCount += 1; },
        zoomTo(): Promise<boolean> { return Promise.resolve(true); },
        getSelectedPoint(): undefined { return undefined; },
        getSnapshot(): ReturnType<CopcCesiumLayer['getSnapshot']> {
          return {
            lifecycle: 'ready',
            renderedPointCount: 0,
            renderedNodeKeys: [],
            selectedNodeKeys: [],
            performance: { visibleLevelRange: undefined },
          } as unknown as ReturnType<CopcCesiumLayer['getSnapshot']>;
        },
        get boundingSphere(): undefined { return undefined; },
      }) as unknown as ReturnType<CesiumLayerFactory>);
    },
    delayNextLoad(): void { delayNextMockLoad = true; },
    releaseDelayedLoad(): void { releaseMockLoad?.(); releaseMockLoad = undefined; },
    getMockLoadCount: () => mockLoadCount,
    getMockDestroyCount: () => mockDestroyCount,
    setCameraView(view): void { activeRuntime?.setCameraState(view); },
    getCameraView(): PlaygroundTestCameraView {
      return activeRuntime?.getCameraState() ?? {
        longitude: 0, latitude: 0, height: 0, heading: 0, pitch: 0, roll: 0,
      };
    },
    getPickablePointScreenPosition(): { x: number; y: number } | undefined {
      return activeRuntime?.getPickablePointScreenPosition();
    },
  };
}

const safeErrorText = (error: unknown): string => {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/https?:\/\/[^\s)]+/giu, (value) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch {
      return 'remote source';
    }
  });
  return message;
};

const setStatus = (text: string, state: 'unknown' | 'loading' | 'ready' | 'error'): void => {
  sourceStatus.textContent = text;
  sourceStatus.dataset.status = state;
  byId('diagnostic-status').textContent = state === 'ready'
    ? 'Ready'
    : state === 'loading' ? 'Loading' : state === 'error' ? 'Error' : 'Waiting';
  byId('diagnostic-summary').textContent = text;
  statusFooter.textContent = `${state === 'ready' ? 'Ready' : state === 'loading' ? 'Loading' : state === 'error' ? 'Error' : 'Ready'} · ${text}`;
  byId('hud-state').textContent = state === 'ready' ? 'Streaming' : state === 'loading' ? 'Loading' : state === 'error' ? 'Error' : 'Waiting';
  byId('hud-dot').classList.toggle('muted', state !== 'ready');
};

const knownRgbFormats = new Set([2, 3, 5, 7, 8, 10]);
const colorControl = mountSegmentedControl<PlaygroundColorMode>(byId('color-mode'), {
  label: 'Color mode',
  value: colorMode,
  className: 'color-segments',
  choices: [],
  onChange: (value) => {
    colorMode = value;
    byId('point-empty').textContent = 'Click a point in the viewport to inspect its available attributes.';
    reloadActiveSource();
  },
});

const updateColorChoices = (pointFormat?: number): void => {
  const rgbSupported = pointFormat !== undefined && knownRgbFormats.has(pointFormat & 0x3f);
  const choices: readonly UiSegmentOption<PlaygroundColorMode>[] = [
    { value: 'elevation', label: 'Elevation' },
    { value: 'intensity', label: 'Intensity' },
    { value: 'classification', label: 'Classification' },
    { value: 'rgb', label: 'RGB', disabled: !rgbSupported, title: rgbSupported ? undefined : 'This dataset format does not advertise RGB channels.' },
  ];
  colorControl.setOptions(choices);
  if (colorMode === 'rgb' && !rgbSupported) {
    colorMode = 'elevation';
    colorControl.setValue(colorMode);
  }
};
updateColorChoices();

const rendererControl = mountSegmentedControl<PlaygroundRenderer>(byId('renderer-control'), {
  label: 'Renderer',
  value: renderer,
  choices: [
    { value: 'cesium', label: 'Cesium' },
    { value: 'three', label: 'Three.js' },
  ],
  onChange: (value) => {
    renderer = value;
    syncRendererLabels();
    reloadActiveSource();
  },
});

const backendControl = mountSegmentedControl<PlaygroundBackend>(byId('backend-control'), {
  label: 'COPC backend',
  value: backend,
  choices: [
    { value: 'copc-js', label: 'JavaScript' },
    { value: 'rust', label: 'Rust / WASM' },
  ],
  onChange: (value) => {
    backend = value;
    reloadActiveSource();
  },
});

const cameraControl = mountSegmentedControl<PlaygroundCameraView>(byId('camera-control'), {
  label: 'Camera view',
  value: 'overview',
  choices: [
    { value: 'overview', label: 'Overview' },
    { value: 'near', label: 'Near' },
    { value: 'far', label: 'Far' },
  ],
  onChange: (value) => { void activeRuntime?.setCameraView(value); },
});

const sliders = [
  mountSlider(byId('point-size-control'), {
    id: 'point-size', label: 'Point size', min: 1, max: 10, step: 1, value: pointSize,
    formatValue: (value) => `${formatUiNumber(value)} px`,
    onCommit(value) { pointSize = value; reloadActiveSource(); },
  }),
  mountSlider(byId('max-nodes-control'), {
    id: 'max-nodes', label: 'Max selected nodes', min: 1, max: 48, step: 1, value: maxNodes,
    formatValue: formatUiNumber,
    onCommit(value) { maxNodes = value; reloadActiveSource(); },
  }),
  mountSlider(byId('max-points-control'), {
    id: 'max-points', label: 'Max rendered points', min: 50_000, max: 1_000_000, step: 50_000, value: maxRenderedPoints,
    formatValue: (value) => formatUiNumber(value),
    onCommit(value) { maxRenderedPoints = value; reloadActiveSource(); },
  }),
];

function syncRendererLabels(): void {
  const label = renderer === 'cesium' ? 'Cesium' : 'Three.js';
  rendererHeading.textContent = label;
  rendererBadge.textContent = label;
  viewport.setAttribute('aria-label', `Interactive ${label} point cloud viewport`);
  byId<HTMLElement>('integration-example').textContent = renderer === 'cesium'
    ? `const layer = new CopcCesiumLayer({ url: copcUrl, backend: '${backend}' });\nawait layer.load();\nlayer.attachTo(viewer);`
    : `const layer = new CopcThreeLayer({ url: copcUrl, backend: '${backend}' });\nlayer.attachTo({ scene, camera, renderer });\nawait layer.load();`;
  if (activeRuntime) viewerCaption.textContent = `${label} renders the selected COPC data in this browser.`;
}
syncRendererLabels();

const renderPoint = (point: CopcPointInspection | undefined): void => {
  const empty = byId<HTMLElement>('point-empty');
  const attributes = byId<HTMLDListElement>('point-attributes');
  if (!point) {
    empty.hidden = false;
    attributes.hidden = true;
    attributes.replaceChildren();
    return;
  }
  const rows: Array<[string, string]> = [
    ['Longitude', `${point.longitude.toFixed(7)}°`],
    ['Latitude', `${point.latitude.toFixed(7)}°`],
    ['Height', `${formatUiNumber(point.height, 3)} m`],
  ];
  if (point.classification !== undefined) rows.push(['Classification', point.classificationLabel ?? String(point.classification)]);
  if (point.intensity !== undefined) rows.push(['Intensity', formatUiNumber(point.intensity)]);
  if (point.rgb !== undefined) rows.push(['RGB', `(${point.rgb.red}, ${point.rgb.green}, ${point.rgb.blue})`]);
  attributes.replaceChildren(...rows.flatMap(([label, value]) => {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    return [term, description];
  }));
  empty.hidden = true;
  attributes.hidden = false;
};

const updateSnapshot = (snapshot: PlaygroundSnapshot | undefined): void => {
  const points = snapshot?.renderedPoints ?? 0;
  const nodes = snapshot?.renderedNodes ?? 0;
  const selected = snapshot?.selectedNodes ?? 0;
  byId('hud-points').textContent = formatUiNumber(points);
  byId('hud-nodes').textContent = formatUiNumber(nodes);
  byId('diagnostic-points').textContent = formatUiNumber(points);
  byId('diagnostic-nodes').textContent = formatUiNumber(nodes);
  byId('diagnostic-selected').textContent = formatUiNumber(selected);
  const range = snapshot?.visibleLevelRange;
  byId('diagnostic-lod').textContent = range ? `${range.min}–${range.max}` : '—';
};

const refreshSnapshot = (): void => {
  if (!activeRuntime) return;
  try { updateSnapshot(activeRuntime.getSnapshot()); } catch { updateSnapshot(undefined); }
};

const showProbe = (result: CopcSourceProbeResult): void => {
  updateColorChoices(result.pointFormat);
  byId('diagnostic-range').textContent = result.rangeSupported === true ? 'Supported' : result.rangeSupported === false ? 'Unavailable' : 'Unknown';
  byId('diagnostic-copc').textContent = result.copcDetected === true ? 'Detected' : result.copcDetected === false ? 'Not detected' : 'Not confirmed';
  byId('diagnostic-validation').textContent = result.validationLevel === 'strict'
    ? 'Strict response validation'
    : result.validationLevel === 'compatibility-limited' ? 'Compatibility-limited' : result.validationLevel;
  const warning = byId<HTMLElement>('diagnostic-warning');
  warning.textContent = result.warnings.join(' ');
  warning.hidden = result.warnings.length === 0;
  sourceProbe.textContent = result.warnings.length > 0
    ? `${result.corsReadable === true ? 'CORS readable' : 'CORS unavailable'} · ${result.rangeSupported === true ? 'HTTP Range supported' : 'HTTP Range unavailable'}. ${result.warnings.join(' ')}`
    : `CORS readable · HTTP Range supported · COPC ${result.copcDetected === true ? 'detected' : 'not confirmed'}`;
};

const getFilePointFormat = async (file: File): Promise<number | undefined> => {
  if (file.size <= 104) return undefined;
  const header = new Uint8Array(await file.slice(104, 105).arrayBuffer());
  return header.length === 1 ? header[0] : undefined;
};

const destroyRuntime = (): void => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  refreshTimer = undefined;
  activeRuntime?.destroy();
  activeRuntime = undefined;
  viewport.replaceChildren();
  updateSnapshot(undefined);
};

const loadSource = async (
  source: PlaygroundSource,
  sourceName: string,
  options: {
    preserveCamera?: boolean;
    generation?: number;
    probeResult?: CopcSourceProbeResult;
  } = {},
): Promise<void> => {
  const generation = options.generation ?? ++sourceGeneration;
  if (generation !== sourceGeneration) return;
  const priorRuntime = activeRuntime;
  const priorCamera = options.preserveCamera && priorRuntime?.renderer === renderer
    ? priorRuntime.getCameraState() : undefined;
  const capturedInteractionVersion = cameraInteractionVersion;
  activeSource = source;
  activeSourceName = sourceName;
  if (source instanceof File) activeProbeResult = undefined;
  else if (options.probeResult) activeProbeResult = options.probeResult;
  const probeResult = options.probeResult ?? activeProbeResult;
  destroyRuntime();
  renderPoint(undefined);
  activeLoadPending = true;
  setStatus(`Loading ${sourceName}…`, 'loading');
  if (probeResult) {
    byId('diagnostic-range').textContent = probeResult.rangeSupported === true
      ? 'Supported' : probeResult.rangeSupported === false ? 'Unavailable' : 'Unknown';
    byId('diagnostic-copc').textContent = probeResult.copcDetected === true
      ? 'Detected' : probeResult.copcDetected === false ? 'Not detected' : 'Not confirmed';
    byId('diagnostic-validation').textContent = probeResult.validationLevel === 'strict'
      ? 'Strict response validation'
      : probeResult.validationLevel === 'compatibility-limited' ? 'Compatibility-limited' : probeResult.validationLevel;
  } else {
    byId('diagnostic-range').textContent = typeof source === 'string'
      ? 'Checking' : 'Not applicable (local file)';
    byId('diagnostic-copc').textContent = typeof source === 'string' ? 'Checking' : 'Checked while loading';
    byId('diagnostic-validation').textContent = typeof source === 'string' ? 'Checking' : 'Local byte source';
  }
  let runtime: PlaygroundRuntime | undefined;
  try {
    if (source instanceof File) {
      updateColorChoices(await getFilePointFormat(source));
    }
    if (generation !== sourceGeneration) return;
    const createdRuntime = await createPlaygroundRuntime({
      renderer,
      backend,
      source,
      sourceName,
      colorMode,
      pointSize,
      maxNodes,
      maxRenderedPoints,
      container: viewport,
      onPointPicked: renderPoint,
      isCurrent: () => generation === sourceGeneration,
      onError: (message) => {
        if (runtime && activeRuntime === runtime) setStatus(safeErrorText(message), 'error');
      },
    }, layerFactory);
    if (!createdRuntime) return;
    runtime = createdRuntime;
    activeRuntime = createdRuntime;
    refreshTimer = window.setInterval(refreshSnapshot, 500);
    await createdRuntime.ready;
    if (generation !== sourceGeneration || activeRuntime !== createdRuntime) {
      if (activeRuntime === createdRuntime) {
        destroyRuntime();
        activeLoadPending = false;
        if (sourceStatus.textContent === `Loading ${sourceName}…`) {
          setStatus('Source selection changed. Choose a source and load it.', 'unknown');
        }
      }
      return;
    }
    activeLoadPending = false;
    if (priorCamera && capturedInteractionVersion === cameraInteractionVersion) {
      createdRuntime.setCameraState(priorCamera);
    }
    setStatus(`Loaded ${sourceName}`, 'ready');
    viewerCaption.textContent = `${renderer === 'cesium' ? 'Cesium' : 'Three.js'} streams visible COPC nodes as the camera moves.`;
    refreshSnapshot();
  } catch (error) {
    if (generation !== sourceGeneration) {
      if (runtime && activeRuntime === runtime) {
        destroyRuntime();
        activeLoadPending = false;
        if (sourceStatus.textContent === `Loading ${sourceName}…`) {
          setStatus('Source selection changed. Choose a source and load it.', 'unknown');
        }
      }
      return;
    }
    activeLoadPending = false;
    destroyRuntime();
    setStatus(safeErrorText(error), 'error');
    byId('hud-state').textContent = 'Error';
  }
};

function reloadActiveSource(): void {
  if (activeSource !== undefined) {
    void loadSource(activeSource, activeSourceName, { preserveCamera: true });
  }
}

const invalidateSourceRequest = (): number => {
  const probeWasPending = remoteLoadButton.disabled;
  const generation = ++sourceGeneration;
  if (activeLoadPending) {
    if (activeRuntime) destroyRuntime();
    activeLoadPending = false;
    if (sourceStatus.textContent.startsWith('Loading ')) {
      setStatus('Source selection changed. Choose a source and load it.', 'unknown');
    }
  }
  remoteLoadButton.disabled = false;
  remoteLoadButton.textContent = remoteSelect.value === 'custom' ? 'Probe and load URL' : 'Probe and load source';
  if (probeWasPending) sourceProbe.textContent = 'Source selection changed. Run the probe again to load it.';
  return generation;
};

remoteSelect.addEventListener('change', () => {
  invalidateSourceRequest();
  customUrlInput.disabled = remoteSelect.value !== 'custom';
});
customUrlInput.disabled = true;
customUrlInput.addEventListener('input', () => {
  if (remoteSelect.value === 'custom') invalidateSourceRequest();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  fileInput.value = '';
  sourceProbe.textContent = 'Local files are read directly by the browser; HTTP CORS and Range checks do not apply.';
  const generation = invalidateSourceRequest();
  await loadSource(file, file.name, { generation });
});

remoteLoadButton.addEventListener('click', async () => {
  const generation = invalidateSourceRequest();
  let sourceUrl: string;
  let sourceName: string;
  if (remoteSelect.value === 'custom') {
    try {
      const parsed = new URL(customUrlInput.value.trim());
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
      sourceUrl = parsed.href;
      sourceName = 'Custom URL';
    } catch {
      sourceProbe.textContent = 'Enter a valid absolute HTTP or HTTPS URL.';
      return;
    }
  } else if (remoteSelect.value === 'chicago') {
    sourceUrl = 'https://data.pointcloud.org/chicago-downtown/chicago-downtown.copc.laz';
    sourceName = 'Chicago Downtown';
  } else {
    sourceUrl = 'https://data.pointcloud.org/autzen/autzen-classified.copc.laz';
    sourceName = 'Autzen Stadium';
  }

  remoteLoadButton.disabled = true;
  remoteLoadButton.textContent = 'Checking source…';
  sourceProbe.textContent = 'Checking browser access, HTTP Range, and COPC metadata…';
  byId('diagnostic-range').textContent = 'Checking';
  byId('diagnostic-copc').textContent = 'Checking';
  byId('diagnostic-validation').textContent = 'Checking';
  try {
    const { probeCopcSource } = await import('@frillab/copc-adapter/cesium');
    const probe = await probeCopcSource(sourceUrl);
    if (generation !== sourceGeneration) return;
    showProbe(probe);
    if (probe.corsReadable !== true || probe.rangeSupported !== true) {
      sourceProbe.textContent = `${sourceProbe.textContent} Check that the host permits browser CORS and HTTP Range.`;
      setStatus('Source cannot be loaded with browser CORS and HTTP Range.', 'error');
      return;
    }
    if (probe.copcDetected === false) {
      sourceProbe.textContent = 'The response is readable but does not contain COPC metadata.';
      setStatus('The selected source does not contain readable COPC metadata.', 'error');
      return;
    }
    await loadSource(sourceUrl, sourceName, { generation, probeResult: probe });
  } catch (error) {
    if (generation === sourceGeneration) {
      const message = safeErrorText(error);
      sourceProbe.textContent = message;
      setStatus(message, 'error');
    }
  } finally {
    if (generation === sourceGeneration) {
      remoteLoadButton.disabled = false;
      remoteLoadButton.textContent = remoteSelect.value === 'custom' ? 'Probe and load URL' : 'Probe and load source';
    }
  }
});

let disposed = false;
const destroyPlayground = (): void => {
  if (disposed) return;
  disposed = true;
  ++sourceGeneration;
  destroyRuntime();
  for (const slider of sliders) slider.destroy();
  colorControl.destroy();
  rendererControl.destroy();
  backendControl.destroy();
  cameraControl.destroy();
};
window.addEventListener('pagehide', destroyPlayground, { once: true });
