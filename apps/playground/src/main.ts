import * as Cesium from 'cesium';
import { CopcCesiumLayer } from '@frillab/copc-adapter/cesium';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('The Playground application root is missing.');
}

app.innerHTML = `
  <div class="playground-shell">
    <header class="topbar">
      <a class="brand" href="${import.meta.env.BASE_URL}" aria-label="COPC Adapter Playground home">
        <span class="brand-mark" aria-hidden="true">C</span>
        <span class="brand-copy"><strong>COPC Adapter</strong><small>PLAYGROUND</small></span>
      </a>
      <div class="topbar-center"><span class="live-dot" aria-hidden="true"></span> Application scaffold</div>
      <a class="docs-link" href="https://mors119.github.io/copc-adapter/">Documentation <span aria-hidden="true">↗</span></a>
    </header>

    <main class="workbench" aria-label="COPC Adapter Playground">
      <aside class="side-panel source-panel" aria-labelledby="source-heading">
        <div class="panel-heading">
          <div><span class="eyebrow">01 / DATA</span><h1 id="source-heading">Source</h1></div>
          <span class="step-icon" aria-hidden="true">↗</span>
        </div>
        <p class="panel-intro">Connect a browser-readable COPC resource to begin exploring.</p>
        <div class="source-empty" role="status" aria-live="polite">
          <span class="source-symbol" aria-hidden="true">＋</span>
          <strong>Ready for a source</strong>
          <span>Source probing and loading controls are coming in a follow-up.</span>
        </div>
        <div class="small-note"><span class="note-icon" aria-hidden="true">i</span><span>Sources stay in your browser. The Playground does not upload or store data.</span></div>
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
        <p class="viewer-caption">The application owns this Cesium Viewer. Adapter layer controls will attach here in a later update.</p>
      </section>

      <aside class="side-panel config-panel" aria-label="Configuration areas">
        <section class="config-section" aria-labelledby="appearance-heading">
          <div class="panel-heading compact"><div><span class="eyebrow">03 / DISPLAY</span><h2 id="appearance-heading">Appearance</h2></div><span class="section-number">01</span></div>
          <p class="section-placeholder">Color mode, point size, and render budget.</p>
          <div class="placeholder-line" aria-hidden="true"><span></span><span></span></div>
        </section>
        <section class="config-section" aria-labelledby="streaming-heading">
          <div class="panel-heading compact"><div><span class="eyebrow">04 / PERFORMANCE</span><h2 id="streaming-heading">Streaming</h2></div><span class="section-number">02</span></div>
          <p class="section-placeholder">Backend, level of detail, and cache limits.</p>
          <div class="placeholder-line" aria-hidden="true"><span></span><span></span></div>
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
        <pre aria-label="Generated integration code placeholder"><code>Choose a source and configuration to generate an integration snippet.</code></pre>
      </section>
    </footer>
    <div class="statusbar"><span>Scaffold <span class="status-divider">/</span> No source loaded</span><span>Static · Client-side</span></div>
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

viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#111d25');
viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0b1118');
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-12, 24, 19_000_000),
});

let destroyed = false;
const destroyViewer = (): void => {
  if (destroyed) return;
  destroyed = true;
  if (!viewer.isDestroyed()) viewer.destroy();
};

window.addEventListener('pagehide', destroyViewer, { once: true });
