import * as Cesium from 'cesium';
import {
  CopcCesiumLayer,
  probeCopcSource,
  type CopcColorMode,
  type CopcCesiumLayerOptions,
} from '@frillab/copc-adapter/cesium';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('The Playground application root is missing.');
}

app.innerHTML = `
  <div class="playground-shell">
    <header class="topbar">
      <a class="brand" href="${import.meta.env.BASE_URL}" aria-label="COPC Adapter Playground home">
        <span class="brand-copy"><strong>COPC Adapter</strong><small>PLAYGROUND</small></span>
      </a>
      <div class="topbar-center"><span class="live-dot" aria-hidden="true"></span> Local COPC ready</div>
      <a class="docs-link" href="https://mors119.github.io/copc-adapter/">Documentation <span aria-hidden="true">↗</span></a>
    </header>

    <main class="workbench" aria-label="COPC Adapter Playground">
      <aside class="side-panel source-panel" aria-labelledby="source-heading">
        <div class="panel-heading">
          <div><span class="eyebrow">01 / DATA</span><h1 id="source-heading">Source</h1></div>
          <span class="step-icon" aria-hidden="true">↗</span>
        </div>
        <p class="panel-intro">Choose a public COPC source, enter a URL, or open a local file. Point data streams directly to your browser.</p>
        <label class="ui-field" for="remote-source">Public dataset<select id="remote-source"><option value="autzen">Autzen Stadium · Oregon</option><option value="chicago">Chicago Downtown</option><option value="custom">Custom URL</option></select></label>
        <label class="ui-field" for="custom-url">COPC URL<input id="custom-url" type="url" placeholder="https://host.example/area.copc.laz" autocomplete="url" spellcheck="false"></label>
        <button class="source-load" id="load-remote" type="button">Probe and load source</button>
        <p class="source-probe" id="source-probe" role="status" aria-live="polite">Remote sources are requested directly. The host must allow CORS and HTTP Range.</p>
        <div class="source-separator" aria-hidden="true"><span>or choose a local file</span></div>
        <label class="file-picker" for="copc-file">
          <span class="source-symbol" aria-hidden="true">＋</span>
          <strong>Choose a COPC file</strong>
          <span>Browse for a .copc.laz file</span>
          <input id="copc-file" type="file" accept=".copc.laz,.laz,.copc,application/octet-stream">
        </label>
        <p class="source-status" id="source-status" role="status" aria-live="polite">Waiting for a source</p>
        <div class="small-note"><span class="note-icon" aria-hidden="true">i</span><span>Local file bytes stay in your browser. Ordinary LAS/LAZ files without COPC hierarchy are unsupported.</span></div>
      </aside>

      <section class="viewer-column" aria-labelledby="viewer-heading">
        <div class="viewer-toolbar">
          <div class="viewer-title"><span class="eyebrow">02 / SCENE</span><h2 id="viewer-heading">Cesium Viewer</h2></div>
          <span class="viewer-ready"><span class="live-dot" aria-hidden="true"></span> Viewer ready</span>
        </div>
        <div class="viewer-frame">
          <div id="cesium-container" role="region" aria-label="Interactive Cesium globe viewport"></div>
          <div class="scene-overlay" aria-hidden="true"><span class="scene-coordinate">WGS 84 · 3D</span></div>
        </div>
        <p class="viewer-caption">The Playground owns this Cesium Viewer. COPC point data is read as the view refines.</p>
      </section>

      <aside class="side-panel config-panel" aria-label="Configuration areas">
        <section class="config-section" aria-labelledby="appearance-heading">
          <div class="panel-heading compact"><div><span class="eyebrow">03 / DISPLAY</span><h2 id="appearance-heading">Appearance</h2></div><span class="section-number">01</span></div>
          <label class="ui-field">Color mode<select id="color-mode"><option value="rgb">RGB</option><option value="elevation">Elevation</option><option value="intensity">Intensity</option><option value="classification">Classification</option></select></label>
          <label class="ui-field"><span class="ui-slider-heading"><span>Point size</span><output id="point-size-value">3 px</output></span><input id="point-size" type="range" min="1" max="10" step="1" value="3"></label>
        </section>
        <section class="config-section" aria-labelledby="streaming-heading">
          <div class="panel-heading compact"><div><span class="eyebrow">04 / PERFORMANCE</span><h2 id="streaming-heading">Streaming</h2></div><span class="section-number">02</span></div>
          <label class="ui-field"><span class="ui-slider-heading"><span>Max selected nodes</span><output id="max-nodes-value">24</output></span><input id="max-nodes" type="range" min="1" max="48" step="1" value="24"></label>
          <label class="ui-field"><span class="ui-slider-heading"><span>Max rendered points</span><output id="max-points-value">250,000</output></span><input id="max-points" type="range" min="50000" max="1000000" step="50000" value="250000"></label>
        </section>
        <div class="api-card" role="status">
          <span class="api-card-icon" aria-hidden="true">⌘</span>
          <div><strong>Public package connected</strong><span>Built from <code>@frillab/copc-adapter/cesium</code></span></div>
          <span class="check-mark" aria-label="Ready">✓</span>
        </div>
      </aside>
    </main>

    <footer class="bottom-area">
      <section class="bottom-card diagnostics-card" aria-labelledby="diagnostics-heading">
        <div class="bottom-title"><span class="eyebrow">05 / OBSERVABILITY</span><h2 id="diagnostics-heading">Diagnostics</h2></div>
        <p>Network, hierarchy, rendering, cache, and Worker measurements will appear here.</p>
        <div class="diagnostic-empty"><span class="live-dot muted" aria-hidden="true"></span> Waiting for a source</div>
      </section>
      <section class="bottom-card code-card" aria-labelledby="code-heading">
        <div class="bottom-title"><span class="eyebrow">06 / INTEGRATION</span><h2 id="code-heading">Generated code</h2></div>
          <pre aria-label="Generated integration code"><code>const layer = new CopcCesiumLayer({ url: file });
await layer.load();
layer.attachTo(viewer);</code></pre>
      </section>
    </footer>
    <div class="statusbar"><span>Ready <span class="status-divider">/</span> No source loaded</span><span>Static · Client-side</span></div>
  </div>
`;

const viewerElement = document.querySelector<HTMLDivElement>('#cesium-container');
if (!viewerElement) {
  throw new Error('The Cesium viewport element is missing.');
}

const adapterPackageReady = typeof CopcCesiumLayer === 'function';
const packageStatus = document.querySelector<HTMLElement>('.api-card');
if (!adapterPackageReady && packageStatus) {
  packageStatus.setAttribute('aria-label', 'Public package could not be loaded');
}

const viewer = new Cesium.Viewer(viewerElement, {
  animation: false,
  baseLayer: false,
  baseLayerPicker: false,
  fullscreenButton: false,
  geocoder: false,
  homeButton: false,
  infoBox: false,
  navigationHelpButton: false,
  sceneModePicker: false,
  selectionIndicator: false,
  timeline: false,
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
});

const fileInput = document.querySelector<HTMLInputElement>('#copc-file');
const sourceStatus = document.querySelector<HTMLElement>('#source-status');
let activeLayer: CopcCesiumLayer | undefined;
let layerFactory = (options: CopcCesiumLayerOptions): CopcCesiumLayer => new CopcCesiumLayer(options);
let activeSource: string | File | undefined;
let activeSourceName = '';
let pointSize = 3;
let maxNodes = 24;
let maxRenderedPoints = 250_000;
let colorMode: CopcColorMode = 'rgb';
let sourceGeneration = 0;
let invalidateSourceRequest = (): number => ++sourceGeneration;

type CameraPose = {
  destination: Cesium.Cartesian3;
  direction: Cesium.Cartesian3;
  up: Cesium.Cartesian3;
};

const captureCameraPose = (): CameraPose => ({
  destination: Cesium.Cartesian3.clone(viewer.camera.positionWC),
  direction: Cesium.Cartesian3.clone(viewer.camera.directionWC),
  up: Cesium.Cartesian3.clone(viewer.camera.upWC),
});

const restoreCameraPose = (pose: CameraPose): void => {
  if (viewer.isDestroyed()) return;
  viewer.camera.setView({
    destination: pose.destination,
    orientation: { direction: pose.direction, up: pose.up },
  });
};

type PlaygroundTestCameraView = {
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
};

declare global {
  interface Window {
    __COPC_PLAYGROUND_TEST__?: {
      useCameraResetLayerMock(): void;
      setCameraView(view: PlaygroundTestCameraView): void;
      getCameraView(): PlaygroundTestCameraView;
      getMockLoadCount(): number;
    };
  }
}

if (import.meta.env.DEV) {
  let mockLoadCount = 0;
  window.__COPC_PLAYGROUND_TEST__ = {
    useCameraResetLayerMock(): void {
      layerFactory = () => ({
        attachTo(): void {},
        async load(): Promise<void> {
          mockLoadCount += 1;
          viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(-122.2, 44.1, 5000),
            orientation: {
              heading: Cesium.Math.toRadians(20),
              pitch: Cesium.Math.toRadians(-40),
              roll: 0,
            },
          });
        },
        destroy(): void {},
        setStyle(): void {},
      } as unknown as CopcCesiumLayer);
    },
    setCameraView(view): void {
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(view.longitude, view.latitude, view.height),
        orientation: {
          heading: Cesium.Math.toRadians(view.heading),
          pitch: Cesium.Math.toRadians(view.pitch),
          roll: Cesium.Math.toRadians(view.roll),
        },
      });
    },
    getCameraView(): PlaygroundTestCameraView {
      const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
      return {
        longitude: Cesium.Math.toDegrees(cartographic.longitude),
        latitude: Cesium.Math.toDegrees(cartographic.latitude),
        height: cartographic.height,
        heading: Cesium.Math.toDegrees(viewer.camera.heading),
        pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
        roll: Cesium.Math.toDegrees(viewer.camera.roll),
      };
    },
    getMockLoadCount: () => mockLoadCount,
  };
}

const loadSource = async (
  source: string | File,
  sourceName: string,
  options: { preserveCamera?: boolean; generation?: number } = {},
): Promise<void> => {
  const generation = options.generation ?? invalidateSourceRequest();
  if (generation !== sourceGeneration) return;
  const cameraPose = options.preserveCamera ? captureCameraPose() : undefined;
  activeSource = source;
  activeSourceName = sourceName;
  activeLayer?.destroy();
  const layer = layerFactory({
    url: source,
    pointSize,
    colorMode,
    maxRenderedPoints,
    streaming: { maxNodes },
  });
  activeLayer = layer;
  layer.attachTo(viewer);
  if (sourceStatus) sourceStatus.textContent = `Loading ${sourceName}…`;
  try {
    await layer.load();
    if (generation !== sourceGeneration || activeLayer !== layer) return;
    if (cameraPose) restoreCameraPose(cameraPose);
    if (sourceStatus) sourceStatus.textContent = `Loaded ${sourceName}`;
  } catch (error) {
    if (generation === sourceGeneration && activeLayer === layer && sourceStatus) {
      if (cameraPose) restoreCameraPose(cameraPose);
      const message = error instanceof Error ? error.message : String(error);
      sourceStatus.textContent = /fetch|cors|range|http/i.test(message)
        ? `${message} Check that the host permits browser CORS requests and HTTP Range.`
        : message;
    }
  }
};

fileInput?.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file || !sourceStatus) return;
  fileInput.value = '';
  await loadSource(file, file.name);
});

const remoteSelect = document.querySelector<HTMLSelectElement>('#remote-source');
const customUrlInput = document.querySelector<HTMLInputElement>('#custom-url');
const sourceProbe = document.querySelector<HTMLElement>('#source-probe');
const remoteLoadButton = document.querySelector<HTMLButtonElement>('#load-remote');
invalidateSourceRequest = () => {
  const probeWasPending = Boolean(remoteLoadButton?.disabled);
  const generation = ++sourceGeneration;
  if (remoteLoadButton && remoteSelect) {
    remoteLoadButton.disabled = false;
    remoteLoadButton.textContent = remoteSelect.value === 'custom' ? 'Probe and load URL' : 'Probe and load source';
  }
  if (probeWasPending && sourceProbe) {
    sourceProbe.textContent = 'Source selection changed. Run the probe again to load it.';
  }
  return generation;
};
remoteSelect?.addEventListener('change', () => {
  invalidateSourceRequest();
  const isCustom = remoteSelect.value === 'custom';
  if (customUrlInput) customUrlInput.disabled = !isCustom;
});
if (customUrlInput) customUrlInput.disabled = true;
customUrlInput?.addEventListener('input', () => {
  if (remoteSelect?.value === 'custom') invalidateSourceRequest();
});
remoteLoadButton?.addEventListener('click', async () => {
  if (!remoteSelect || !sourceProbe || !remoteLoadButton || !sourceStatus) return;
  const generation = invalidateSourceRequest();
  let sourceUrl: string;
  let sourceName: string;
  if (remoteSelect.value === 'custom') {
    try {
      const parsed = new URL(customUrlInput?.value.trim() ?? '');
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
      sourceUrl = parsed.href;
      sourceName = parsed.pathname.split('/').filter(Boolean).at(-1) || parsed.host;
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
  try {
    const probe = await probeCopcSource(sourceUrl);
    if (generation !== sourceGeneration) return;
    if (probe.corsReadable !== true || probe.rangeSupported !== true) {
      sourceProbe.textContent = probe.warnings.join(' ') || 'This server did not provide a readable HTTP Range response. Check CORS and Range support.';
      return;
    }
    if (probe.copcDetected === false) {
      sourceProbe.textContent = 'The response is readable but does not contain COPC metadata.';
      return;
    }
    sourceProbe.textContent = `CORS readable · HTTP Range supported · COPC ${probe.copcDetected === true ? 'detected' : 'not confirmed'}`;
    await loadSource(sourceUrl, sourceName, { generation });
  } catch (error) {
    if (generation === sourceGeneration) {
      sourceProbe.textContent = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (generation === sourceGeneration) {
      remoteLoadButton.disabled = false;
      remoteLoadButton.textContent = remoteSelect.value === 'custom' ? 'Probe and load URL' : 'Probe and load source';
    }
  }
});

document.querySelector<HTMLSelectElement>('#color-mode')?.addEventListener('change', (event) => {
  colorMode = (event.currentTarget as HTMLSelectElement).value as CopcColorMode;
  try {
    activeLayer?.setStyle({ colorMode });
  } catch (error) {
    if (sourceStatus) sourceStatus.textContent = error instanceof Error ? error.message : String(error);
  }
});

const reloadWhenReady = (): void => {
  if (activeSource !== undefined) {
    void loadSource(activeSource, activeSourceName, { preserveCamera: true });
  }
};
document.querySelector<HTMLInputElement>('#point-size')?.addEventListener('input', (event) => {
  pointSize = Number((event.currentTarget as HTMLInputElement).value);
  document.querySelector<HTMLOutputElement>('#point-size-value')!.value = `${pointSize} px`;
});
document.querySelector<HTMLInputElement>('#point-size')?.addEventListener('change', reloadWhenReady);
document.querySelector<HTMLInputElement>('#max-nodes')?.addEventListener('input', (event) => {
  maxNodes = Number((event.currentTarget as HTMLInputElement).value);
  document.querySelector<HTMLOutputElement>('#max-nodes-value')!.value = String(maxNodes);
});
document.querySelector<HTMLInputElement>('#max-nodes')?.addEventListener('change', reloadWhenReady);
document.querySelector<HTMLInputElement>('#max-points')?.addEventListener('input', (event) => {
  maxRenderedPoints = Number((event.currentTarget as HTMLInputElement).value);
  document.querySelector<HTMLOutputElement>('#max-points-value')!.value = new Intl.NumberFormat().format(maxRenderedPoints);
});
document.querySelector<HTMLInputElement>('#max-points')?.addEventListener('change', reloadWhenReady);

viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#111d25');
viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0b1118');
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-12, 24, 19_000_000),
});

let destroyed = false;
const destroyViewer = (): void => {
  if (destroyed) return;
  destroyed = true;
  activeLayer?.destroy();
  if (!viewer.isDestroyed()) viewer.destroy();
};

window.addEventListener('pagehide', destroyViewer, { once: true });
