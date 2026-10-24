import type {
  CopcCesiumLayer,
  CopcCesiumPointStyle,
  CopcCesiumPointStyleUpdate,
  CopcPointInspection,
  CopcSourceProbeResult,
  RefinementAlgorithm,
  RefinementFocus,
} from "@frillab/copc-adapter/cesium";
import {
  formatUiNumber,
  mountSegmentedControl,
  mountSlider,
  type UiSegmentOption,
} from "../../shared/ui-controls";
import {
  createDiagnosticsRefreshLoop,
  createDiagnosticsViewModel,
  displaySourceLabel,
  formatDiagnosticBytes,
  supportsLongTaskObservation,
  type PlaygroundBrowserMeasurements,
  type PlaygroundDiagnosticsContext,
  type PlaygroundLayerDiagnostics,
} from "./diagnostics";
import {
  workbenchBackendOptions,
  workbenchRendererOptions,
} from "../../shared/workbench-config";
import {
  generateIntegrationCode,
  isPotentiallySensitiveSource,
  PLAYGROUND_INSTALL_COMMANDS,
  type IntegrationCodeConfig,
  type IntegrationCodeOptions,
} from "./integrationCode";
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
} from "./rendererRuntime";
import {
  defaultPlaygroundRefinementConfig,
  refinementAlgorithmOptions,
  type PlaygroundFocusMode,
  type PlaygroundRefinementConfig,
} from "./refinementConfig";
import {
  defaultPlaygroundUrlConfig,
  readPlaygroundUrlConfig,
  writePlaygroundUrlConfig,
  type PlaygroundUrlConfig,
} from "./playgroundUrlConfig";
import {
  cacheBytesToMib,
  cacheMibToBytes,
  clonePlaygroundConfig,
  hasConstructorChanges,
  normalizeClassificationFilter,
  parseClassificationCodes,
  validatePlaygroundConfig,
} from "./playgroundConfig";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("The Playground application root is missing.");

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
        <div class="source-actions">
          <button id="probe-source" type="button">Probe source</button>
          <button class="source-load" id="load-remote" type="button" disabled>Load source</button>
        </div>
        <p class="source-probe ui-status" id="source-probe" role="status" aria-live="polite">Choose a source to check browser access, HTTP Range, and COPC metadata.</p>
        <dl class="source-probe-details" id="source-probe-details" aria-label="Source probe details" hidden>
          <div><dt>Reachable</dt><dd id="probe-reachable">Unknown</dd></div>
          <div><dt>HTTP status</dt><dd id="probe-http-status">Unavailable</dd></div>
          <div><dt>Range response status</dt><dd id="probe-partial-status">Unavailable</dd></div>
          <div><dt>CORS readable</dt><dd id="probe-cors">Unknown</dd></div>
          <div><dt>HTTP Range</dt><dd id="probe-range">Unknown</dd></div>
          <div><dt>COPC</dt><dd id="probe-copc">Unknown</dd></div>
          <div><dt>Point format</dt><dd id="probe-point-format">Unavailable</dd></div>
          <div><dt>Resource size</dt><dd id="probe-resource-size">Unavailable</dd></div>
          <div><dt>Validation</dt><dd id="probe-validation">Unavailable</dd></div>
        </dl>
        <p class="source-probe-warning" id="source-probe-warning" role="status" aria-live="polite" hidden></p>
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
        <section class="metadata-summary" id="metadata-summary" aria-label="Loaded dataset metadata" hidden>
          <h2>Loaded dataset</h2>
          <dl>
            <div><dt>Total points</dt><dd id="metadata-point-count">Not available</dd></div>
            <div><dt>Point format</dt><dd id="metadata-point-format">Not available</dd></div>
            <div><dt>Bounds</dt><dd id="metadata-bounds">Not available</dd></div>
            <div><dt>CRS metadata</dt><dd id="metadata-crs">Not available</dd></div>
            <div><dt>Active backend</dt><dd id="metadata-backend">Not available</dd></div>
            <div><dt>Active renderer</dt><dd id="metadata-renderer">Not available</dd></div>
          </dl>
        </section>
      </aside>

      <section class="viewer-column" aria-labelledby="viewer-heading">
        <div class="viewer-toolbar">
          <div class="viewer-title"><span class="eyebrow">VIEWPORT</span><h2 id="viewer-heading">Cesium</h2></div>
          <div class="camera-controls"><span class="control-label">Camera</span><div id="camera-control"></div></div>
        </div>
        <div class="viewer-frame" id="viewer-frame">
          <div id="cesium-container" role="region" aria-label="Interactive Cesium point cloud viewport"></div>
          <div class="focus-guide" id="focus-guide" hidden><button class="focus-guide-handle" id="focus-guide-handle" type="button" aria-label="Move focus lens"><span aria-hidden="true"></span></button></div>
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
        <p class="config-state" id="config-state" role="status" aria-live="polite">No layer is active. Settings apply when a source is loaded.</p>
        <section class="config-section" aria-labelledby="appearance-heading">
          <div class="section-heading"><div><span class="eyebrow">DISPLAY</span><h2 id="appearance-heading">Appearance</h2></div></div>
          <span class="control-label">Color mode</span>
          <div id="color-mode" aria-label="Color mode"></div>
          <p class="control-hint">Fixed uses one color; RGB reads stored color channels; Elevation maps height; Intensity and Classification use LAS attributes. The adapter applies its documented fallback when an attribute is unavailable.</p>
          <div class="slider-control" id="point-size-control"></div>
          <label class="ui-field" for="point-size-value">Point size in pixels
            <input id="point-size-value" type="number" min="0.01" step="0.01" inputmode="decimal">
          </label>
          <p class="control-hint" id="point-size-slider-help" hidden></p>
          <p class="control-hint">Cesium applies color changes to the active layer. Three.js uses Apply for constructor changes.</p>
          <section class="classification-controls" aria-labelledby="classification-heading">
            <h3 id="classification-heading">Classification filter <span class="active-filter" id="classification-active">No filter</span></h3>
            <label class="focus-checkbox" for="classification-include-enabled"><input id="classification-include-enabled" type="checkbox"> Use include list</label>
            <label class="ui-field" for="classification-include">Include codes (0–255)
              <input id="classification-include" type="text" inputmode="numeric" placeholder="e.g. 2, 6">
            </label>
            <label class="focus-checkbox" for="classification-exclude-enabled"><input id="classification-exclude-enabled" type="checkbox"> Use exclude list</label>
            <label class="ui-field" for="classification-exclude">Exclude codes (0–255)
              <input id="classification-exclude" type="text" inputmode="numeric" placeholder="e.g. 7, 18">
            </label>
            <div class="classification-actions">
              <button id="apply-classification" type="button" disabled>Apply filter</button>
              <button id="clear-classification" type="button" disabled>Clear filter</button>
            </div>
            <p class="control-hint" id="classification-help">An empty include list hides all points. Classification styling is available only on an active Cesium layer.</p>
            <p class="control-error" id="classification-error" role="status" aria-live="polite" hidden></p>
          </section>
          <p class="control-error" id="style-error" role="status" aria-live="polite" hidden></p>
        </section>
        <section class="config-section" aria-labelledby="streaming-heading">
          <div class="section-heading"><div><span class="eyebrow">STREAM</span><h2 id="streaming-heading">Streaming</h2></div></div>
          <div class="slider-control" id="max-nodes-control"></div>
          <div class="slider-control" id="max-points-control"></div>
          <label class="ui-field" for="max-nodes-value">Max nodes
            <input id="max-nodes-value" type="number" min="1" step="1" inputmode="numeric">
          </label>
          <label class="ui-field" for="max-points-value">Max rendered points
            <input id="max-points-value" type="number" min="1" step="1" inputmode="numeric">
          </label>
          <p class="control-hint">Estimated active-view point workload; this is not an exact GPU memory limit.</p>
          <label class="ui-field" for="cache-budget-mib">Point cache budget (MiB)
            <input id="cache-budget-mib" type="number" min="0" step="0.25" inputmode="decimal">
          </label>
          <p class="control-hint">Budget for decoded point buffers retained in CPU memory.</p>
          <label class="ui-field" for="max-depth-value">Max refinement depth
            <input id="max-depth-value" type="number" min="0" step="1" inputmode="numeric">
          </label>
          <label class="ui-field" for="max-sse-value">Max screen-space error (pixels)
            <input id="max-sse-value" type="number" min="0.01" step="0.1" inputmode="decimal">
          </label>
          <label class="ui-field" for="max-distance-value">Max render distance (metres)
            <input id="max-distance-value" type="number" min="0.01" step="1" inputmode="decimal">
          </label>
          <p class="control-hint">Max nodes limits active frontier pressure; max depth caps hierarchy refinement. Lower screen-space error generally requests finer LoD, and render distance limits far visibility.</p>
          <p class="control-hint" id="streaming-slider-help">Sliders are quick adjustments; numeric fields accept any valid package value. Constructor settings stay pending until applied.</p>
        </section>
        <section class="config-section focus-section" aria-labelledby="focus-heading">
          <div class="section-heading"><div><span class="eyebrow">REFINE</span><h2 id="focus-heading">Focus Lens</h2></div></div>
          <label class="ui-field" for="refinement-algorithm">Refinement algorithm
            <select id="refinement-algorithm"></select>
          </label>
          <label class="ui-field" for="focus-mode">Focus mode
            <select id="focus-mode">
              <option value="auto-center">Auto center</option>
              <option value="center-boost">Center boost</option>
              <option value="follow-pointer">Follow pointer</option>
              <option value="pinned">Pinned</option>
            </select>
          </label>
          <p class="control-hint">Algorithm changes apply by reloading the layer. Focus changes update the active layer.</p>
          <label class="focus-checkbox" for="focus-enabled"><input id="focus-enabled" type="checkbox"> Focus enabled</label>
          <div class="focus-position-controls" id="focus-position-controls">
            <label for="focus-x">X (0–1) <input id="focus-x" type="number" min="0" max="1" step="0.01" inputmode="decimal"></label>
            <label for="focus-y">Y (0–1) <input id="focus-y" type="number" min="0" max="1" step="0.01" inputmode="decimal"></label>
            <button id="focus-reset" type="button">Reset center</button>
          </div>
          <div class="slider-control" id="focus-radius-control"></div>
          <div class="slider-control" id="focus-bias-control"></div>
          <label class="focus-checkbox" for="focus-show-guide"><input id="focus-show-guide" type="checkbox"> Show guide</label>
          <p class="control-hint" id="focus-help">Focus prioritizes LoD refinement near this screen-space region; it does not crop the point cloud.</p>
          <p class="focus-config-warning" id="focus-config-warning" role="status" aria-live="polite" hidden></p>
        </section>
        <section class="package-card" aria-label="Installed adapter package">
          <span class="package-mark" aria-hidden="true">↗</span>
          <div><strong>Adapter package</strong><span><code>@frillab/copc-adapter</code> v${__ADAPTER_VERSION__}</span><span id="package-source">${__ADAPTER_SOURCE__}</span></div>
        </section>
        <div class="config-actions">
          <button class="source-load" id="apply-changes" type="button" disabled>Apply changes</button>
          <button id="reset-defaults" type="button">Reset to defaults</button>
        </div>
        <p class="control-error" id="config-validation" role="status" aria-live="polite" hidden></p>
      </aside>
    </main>

    <section class="below-viewer" aria-label="Source and point details">
      <section class="diagnostics-card diagnostics-dashboard" aria-labelledby="diagnostics-heading">
        <div class="diagnostics-title-row">
          <div><span class="eyebrow">LIVE</span><h2 id="diagnostics-heading">Streaming diagnostics</h2></div>
          <span class="summary-state" id="diagnostic-summary">Waiting for a source</span>
        </div>
        <p class="diagnostic-context" id="diagnostic-context">Load a source to see active configuration and measurements.</p>
        <div class="diagnostic-summary-grid" aria-label="Live diagnostic summary">
          <div class="diagnostic-tile"><span>Rendered</span><strong id="diagnostic-points">Not available</strong><small>points</small></div>
          <div class="diagnostic-tile"><span>Nodes</span><strong id="diagnostic-nodes">Not available</strong><small><span id="diagnostic-selected">Not available</span> selected</small></div>
          <div class="diagnostic-tile"><span>Range</span><strong id="diagnostic-range-bytes">Not available</strong><small id="diagnostic-range-requests">Not available</small></div>
          <div class="diagnostic-tile"><span>Decode</span><strong id="diagnostic-decode">Not available</strong><small>latest update</small></div>
          <div class="diagnostic-tile"><span>CPU cache</span><strong id="diagnostic-cache-bytes">Not available</strong><small id="diagnostic-cache-entries">Not available entries</small></div>
          <div class="diagnostic-tile"><span>Worker</span><strong id="diagnostic-worker">Not available</strong><small id="diagnostic-worker-note">Rust / WASM</small></div>
          <div class="diagnostic-tile"><span>Observed render interval</span><strong id="diagnostic-render-interval">Not available</strong><small id="diagnostic-render-cadence">Not available</small></div>
        </div>
        <p class="diagnostic-note">Refreshes every 500 ms. Adapter timings and Range bytes describe the latest view update. Render interval is the time between renders, not render cost; Cesium on-demand rendering and browser throttling can increase it. Load and Long Task values are Playground browser observations.</p>
        <details class="diagnostic-details">
          <summary>Detailed counters and measurements</summary>
          <dl class="diagnostics-list">
            <div><dt>Layer status</dt><dd id="diagnostic-status">Not available</dd></div>
            <div><dt>Source host and resource size</dt><dd id="diagnostic-source">Not available</dd></div>
            <div><dt>HTTP Range probe</dt><dd id="diagnostic-range">Not available</dd></div>
            <div><dt>COPC metadata probe</dt><dd id="diagnostic-copc">Not available</dd></div>
            <div><dt>Dataset point count</dt><dd id="diagnostic-metadata-points">Not available</dd></div>
            <div><dt>Selected point estimate</dt><dd id="diagnostic-selected-point-cost">Not available</dd></div>
            <div><dt>Rendered nodes</dt><dd id="diagnostic-rendered-nodes">Not available</dd></div>
            <div><dt>Selected nodes</dt><dd id="diagnostic-selected-nodes">Not available</dd></div>
            <div><dt>Visible levels</dt><dd id="diagnostic-lod">Not available</dd></div>
            <div><dt>Streaming updates</dt><dd id="diagnostic-update-count">Not available</dd></div>
            <div><dt>Range request count</dt><dd id="diagnostic-range-requests-details">Not available</dd></div>
            <div><dt>Hierarchy requests</dt><dd id="diagnostic-hierarchy-requests">Not available</dd></div>
            <div><dt>Hierarchy bytes</dt><dd id="diagnostic-hierarchy-bytes">Not available</dd></div>
            <div><dt>Hierarchy page cache</dt><dd id="diagnostic-hierarchy-cache">Not available</dd></div>
            <div><dt>Coverage transitions</dt><dd id="diagnostic-transition">Not available</dd></div>
            <div><dt>Source probe status</dt><dd id="diagnostic-source-status">Not available</dd></div>
            <div><dt>Update duration (latest update)</dt><dd id="diagnostic-update-duration">Not available</dd></div>
            <div><dt>Node selection (latest update)</dt><dd id="diagnostic-selection-duration">Not available</dd></div>
            <div><dt>Range duration (latest update)</dt><dd id="diagnostic-range-duration">Not available</dd></div>
            <div><dt>Decode duration (latest update)</dt><dd id="diagnostic-decode-duration">Not available</dd></div>
            <div><dt>Point preparation (latest update)</dt><dd id="diagnostic-preparation-duration">Not available</dd></div>
            <div><dt>CRS transform (latest update)</dt><dd id="diagnostic-crs-duration">Not available</dd></div>
            <div><dt>Renderer preparation (latest update)</dt><dd id="diagnostic-renderer-duration">Not available</dd></div>
            <div><dt>Configured point budget</dt><dd id="diagnostic-budget">Not available</dd></div>
            <div><dt>Active max SSE</dt><dd id="diagnostic-sse">Not available</dd></div>
            <div><dt>Accepted / rejected refinements</dt><dd id="diagnostic-refinements">Not available</dd></div>
            <div><dt>Cache budget</dt><dd id="diagnostic-cache-budget">Not available</dd></div>
            <div><dt>Cache hits / misses</dt><dd id="diagnostic-cache-hits">Not available</dd></div>
            <div><dt>Cache evictions / bytes evicted</dt><dd id="diagnostic-cache-evictions">Not available</dd></div>
            <div><dt>Worker jobs</dt><dd id="diagnostic-worker-details">Not available</dd></div>
            <div><dt>Refinement algorithm</dt><dd id="diagnostic-algorithm">Not available</dd></div>
            <div><dt>Focus lens</dt><dd id="diagnostic-focus">Not available</dd></div>
            <div><dt>Focus candidates</dt><dd id="diagnostic-focus-candidates">Not available</dd></div>
            <div><dt>Focus-influenced refinements</dt><dd id="diagnostic-focus-refinements">Not available</dd></div>
            <div><dt>Approximate observed render cadence</dt><dd id="diagnostic-detailed-cadence">Not available</dd></div>
            <div><dt>Load initiated → adapter load complete</dt><dd id="diagnostic-load-time">Not available</dd></div>
            <div><dt>First points observed</dt><dd id="diagnostic-first-visible">Not available</dd></div>
            <div><dt>Longest observed browser Long Task</dt><dd id="diagnostic-long-task">Not available</dd></div>
            <div><dt>HTTP validation</dt><dd id="diagnostic-validation">Unknown</dd></div>
          </dl>
        </details>
        <p class="diagnostic-warning" id="diagnostic-warning" hidden></p>
      </section>
      <section class="point-card" aria-labelledby="point-heading">
        <div class="section-heading"><div><span class="eyebrow">INSPECT</span><h2 id="point-heading">Selected point</h2></div></div>
        <p id="point-empty">Click a point in the viewport to inspect its available attributes.</p>
        <dl id="point-attributes" class="point-attributes" hidden></dl>
      </section>
      <details class="code-card generated-code-card" open>
        <summary><span>Generated code</span><span class="summary-state">Public API · v${__ADAPTER_VERSION__}</span></summary>
        <p class="generated-code-intro">Copy a runnable starting point for the last successfully applied Playground settings.</p>
        <div class="generated-code-toolbar">
          <div class="code-mode-control" role="group" aria-label="Code detail">
            <button id="code-mode-minimal" type="button" aria-pressed="true">Minimal</button>
            <button id="code-mode-explicit" type="button" aria-pressed="false">Explicit</button>
          </div>
          <button id="copy-code" type="button">Copy code</button>
        </div>
        <label class="share-option" id="exact-source-option" for="include-exact-source">
          <input id="include-exact-source" type="checkbox" checked>
          Include the active source URL in code
        </label>
        <p class="source-privacy-warning" id="source-code-warning" role="status" aria-live="polite" hidden></p>
        <pre><code id="integration-example"></code></pre>
        <div class="install-guidance">
          <span>Install for this renderer</span>
          <code id="install-command"></code>
          <button id="copy-install" type="button">Copy install command</button>
        </div>
        <div class="share-toolbar">
          <label class="share-option" id="share-source-option" for="include-share-source">
            <input id="include-share-source" type="checkbox">
            Include source URL in share link
          </label>
          <button id="copy-share-link" type="button">Copy share link</button>
        </div>
        <p class="source-privacy-warning" id="source-share-warning" role="status" aria-live="polite" hidden></p>
        <p class="share-status" id="share-status" role="status" aria-live="polite"></p>
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

const viewport = byId<HTMLDivElement>("cesium-container");
const sourceStatus = byId<HTMLElement>("source-status");
const sourceProbe = byId<HTMLElement>("source-probe");
const remoteSelect = byId<HTMLSelectElement>("remote-source");
const customUrlInput = byId<HTMLInputElement>("custom-url");
const probeSourceButton = byId<HTMLButtonElement>("probe-source");
const remoteLoadButton = byId<HTMLButtonElement>("load-remote");
const fileInput = byId<HTMLInputElement>("copc-file");
const rendererHeading = byId<HTMLHeadingElement>("viewer-heading");
const rendererBadge = byId<HTMLElement>("renderer-badge");
const viewerCaption = byId<HTMLElement>("viewer-caption");
const statusFooter = byId<HTMLElement>("footer-status");
const viewerFrame = byId<HTMLDivElement>("viewer-frame");
const focusGuide = byId<HTMLDivElement>("focus-guide");
const focusGuideHandle = byId<HTMLButtonElement>("focus-guide-handle");
const algorithmSelect = byId<HTMLSelectElement>("refinement-algorithm");
const focusModeSelect = byId<HTMLSelectElement>("focus-mode");
const focusEnabledInput = byId<HTMLInputElement>("focus-enabled");
const focusShowGuideInput = byId<HTMLInputElement>("focus-show-guide");
const focusXInput = byId<HTMLInputElement>("focus-x");
const focusYInput = byId<HTMLInputElement>("focus-y");
const focusPositionControls = byId<HTMLDivElement>("focus-position-controls");
const focusConfigWarning = byId<HTMLElement>("focus-config-warning");
const codeElement = byId<HTMLElement>("integration-example");
const codeModeMinimalButton = byId<HTMLButtonElement>("code-mode-minimal");
const codeModeExplicitButton = byId<HTMLButtonElement>("code-mode-explicit");
const exactSourceOption = byId<HTMLLabelElement>("exact-source-option");
const exactSourceInput = byId<HTMLInputElement>("include-exact-source");
const sourceCodeWarning = byId<HTMLElement>("source-code-warning");
const shareSourceInput = byId<HTMLInputElement>("include-share-source");
const shareSourceOption = byId<HTMLLabelElement>("share-source-option");
const sourceShareWarning = byId<HTMLElement>("source-share-warning");
const shareStatus = byId<HTMLElement>("share-status");
const copyCodeButton = byId<HTMLButtonElement>("copy-code");
const copyInstallButton = byId<HTMLButtonElement>("copy-install");
const copyShareButton = byId<HTMLButtonElement>("copy-share-link");
const installCommand = byId<HTMLElement>("install-command");
const configState = byId<HTMLElement>("config-state");
const applyChangesButton = byId<HTMLButtonElement>("apply-changes");
const configValidation = byId<HTMLElement>("config-validation");
const classificationIncludeInput = byId<HTMLInputElement>("classification-include");
const classificationExcludeInput = byId<HTMLInputElement>("classification-exclude");
const classificationActive = byId<HTMLElement>("classification-active");
const classificationError = byId<HTMLElement>("classification-error");
const styleError = byId<HTMLElement>("style-error");
const applyClassificationButton = byId<HTMLButtonElement>("apply-classification");
const clearClassificationButton = byId<HTMLButtonElement>("clear-classification");
const metadataSummary = byId<HTMLElement>("metadata-summary");
const probeDetails = byId<HTMLElement>("source-probe-details");
const probeWarning = byId<HTMLElement>("source-probe-warning");
const parsedUrlConfig = readPlaygroundUrlConfig(
  new URLSearchParams(window.location.search),
);
const shareSourceFromUrl = parsedUrlConfig.sourceUrl;
if (parsedUrlConfig.warning) shareStatus.textContent = parsedUrlConfig.warning;
let pendingConfig: IntegrationCodeConfig = {
  ...clonePlaygroundConfig(parsedUrlConfig.config),
  refinementConfig: {
    ...parsedUrlConfig.refinementConfig,
    center: { ...parsedUrlConfig.refinementConfig.center },
  },
};
// The focus controls build one synchronous edit before committing it back to the
// canonical pending configuration through updatePendingConfig/applyFocusSettings.
let refinementConfig: PlaygroundRefinementConfig = pendingConfig.refinementConfig;
let codeMode: "minimal" | "explicit" = "minimal";
let followPointerCenter = { ...pendingConfig.refinementConfig.center };
let focusDragPointerId: number | undefined;
let focusDragOffset = { x: 0, y: 0 };
let pendingDragCenter: { x: number; y: number } | undefined;
let dragFocusFrame: number | undefined;
let dragFocusTimer: number | undefined;
let lastDragFocusUpdateAt = 0;
let pointerFocusCanvas: HTMLCanvasElement | undefined;
let pendingPointerCenter: { x: number; y: number } | undefined;
let pointerFocusFrame: number | undefined;
let pointerFocusTimer: number | undefined;
let lastPointerFocusUpdateAt = 0;
let lastAppliedFocusCenter: { x: number; y: number } | undefined;
let focusConfigSyncTimer: number | undefined;
let sourceSelectionGeneration = 0;
let probeGeneration = 0;
let probeController: AbortController | undefined;
let loadGeneration = 0;
let activeLoadPending = false;
let appliedSource: PlaygroundSource | undefined;
let activeSourceName = "";
let activeRuntime: PlaygroundRuntime | undefined;
let activeRuntimeHost: HTMLDivElement | undefined;
let pendingRuntime: PlaygroundRuntime | undefined;
let pendingRuntimeHost: HTMLDivElement | undefined;
let activeRuntimeReady = false;
let activeDiagnosticsContext: PlaygroundDiagnosticsContext | undefined;
let browserMeasurements: PlaygroundBrowserMeasurements = {};
let loadInitiatedAt: number | undefined;
let diagnosticsRefreshCleanup: (() => void) | undefined;
let longTaskObserver: PerformanceObserver | undefined;
const defaultIntegrationConfig: IntegrationCodeConfig = {
  ...defaultPlaygroundUrlConfig,
  refinementConfig: {
    ...defaultPlaygroundRefinementConfig,
    center: { ...defaultPlaygroundRefinementConfig.center },
  },
};
let appliedConfig: IntegrationCodeConfig | undefined;
let activeProbeResult: CopcSourceProbeResult | undefined;
let currentProbeSourceUrl: string | undefined;
let currentProbeGeneration: number | undefined;
let currentProbeResult: CopcSourceProbeResult | undefined;
let activePointFormat: number | undefined;
let cameraInteractionVersion = 0;
let layerFactory: CesiumLayerFactory | undefined;

function captureWorkbenchConfig(): IntegrationCodeConfig {
  return {
    ...clonePlaygroundConfig(pendingConfig),
    refinementConfig: {
      ...pendingConfig.refinementConfig,
      center: { ...pendingConfig.refinementConfig.center },
    },
  };
}

function cancelPendingApplyForEdit(): void {
  if (!activeLoadPending || !activeRuntimeReady) return;
  loadGeneration += 1;
  releasePendingRuntime();
  activeLoadPending = false;
  updateRemoteLoadState();
  setStatus(`Loaded ${activeSourceName}`, "ready");
}

function updatePendingConfig(
  update: Partial<IntegrationCodeConfig>,
  syncUrl = true,
): void {
  cancelPendingApplyForEdit();
  pendingConfig = {
    ...pendingConfig,
    ...update,
    ...(update.refinementConfig === undefined
      ? {}
      : { refinementAlgorithm: update.refinementConfig.algorithm }),
    ...(update.classificationFilter === undefined
      ? {}
      : { classificationFilter: normalizeClassificationFilter(update.classificationFilter) }),
    ...(update.refinementConfig === undefined
      ? {}
      : {
          refinementConfig: {
            ...update.refinementConfig,
            center: { ...update.refinementConfig.center },
          },
        }),
  };
  refinementConfig = pendingConfig.refinementConfig;
  if (syncUrl) writePendingUrlConfig();
  syncPendingControls();
  updateApplyState();
  updateIntegrationExample();
}

for (const option of refinementAlgorithmOptions) {
  algorithmSelect.add(new Option(option.label, option.value));
}
algorithmSelect.value = pendingConfig.refinementConfig.algorithm;
focusModeSelect.value = pendingConfig.refinementConfig.focusMode;
focusEnabledInput.checked = pendingConfig.refinementConfig.focusEnabled;
focusShowGuideInput.checked = pendingConfig.refinementConfig.showGuide;
focusXInput.value = String(pendingConfig.refinementConfig.center.x);
focusYInput.value = String(pendingConfig.refinementConfig.center.y);
if (parsedUrlConfig.warning) {
  focusConfigWarning.textContent = parsedUrlConfig.warning;
  focusConfigWarning.hidden = false;
}

for (const eventName of ["pointerdown", "wheel", "keydown", "touchstart"]) {
  viewport.addEventListener(
    eventName,
    () => {
      cameraInteractionVersion += 1;
    },
    { passive: true },
  );
}

type PlaygroundTestCameraView = PlaygroundCameraState;

declare global {
  interface Window {
    __COPC_PLAYGROUND_TEST__?: {
      useCameraResetLayerMock(): void;
      delayNextLoad(): void;
      delayNextZoom(): void;
      failNextLoad(): void;
      failNextStyle(): void;
      releaseDelayedLoad(): void;
      releaseDelayedZoom(): void;
      getMockDestroyCount(): number;
      getMockZoomCount(): number;
      setCameraView(view: PlaygroundTestCameraView): void;
      getCameraView(): PlaygroundTestCameraView;
      getMockLoadCount(): number;
      getMockStyleUpdateCount(): number;
      getAppliedConfig(): IntegrationCodeConfig | undefined;
      getPendingConfig(): IntegrationCodeConfig;
      getPickablePointScreenPosition(): { x: number; y: number } | undefined;
      getMockLayerCreateCount(): number;
      getMockRefinementAlgorithm(): RefinementAlgorithm | undefined;
      getMockFocusUpdateCount(): number;
      getMockRefinementFocus(): RefinementFocus | undefined;
      getSnapshot(): PlaygroundSnapshot | undefined;
      getCameraInputsEnabled(): boolean | undefined;
      generateIntegrationCode(options: IntegrationCodeOptions): string;
      readUrlConfig(query: string): ReturnType<typeof readPlaygroundUrlConfig>;
      writeUrlConfig(
        config: PlaygroundUrlConfig,
        refinement: PlaygroundRefinementConfig,
        sourceUrl?: string,
      ): string;
    };
  }
}

if (import.meta.env.DEV) {
  let mockLoadCount = 0;
  let mockDestroyCount = 0;
  let mockZoomCount = 0;
  let mockLayerCreateCount = 0;
  let mockRefinementAlgorithm: RefinementAlgorithm | undefined;
  let mockFocusUpdateCount = 0;
  let mockRefinementFocus: RefinementFocus | undefined;
  let delayNextMockLoad = false;
  let delayNextMockZoom = false;
  let failNextMockLoad = false;
  let failNextMockStyle = false;
  let mockStyleUpdateCount = 0;
  let releaseMockLoad: (() => void) | undefined;
  let releaseMockZoom: (() => void) | undefined;
  window.__COPC_PLAYGROUND_TEST__ = {
    useCameraResetLayerMock(): void {
      layerFactory = (options) => {
        mockLayerCreateCount += 1;
        mockRefinementAlgorithm = options.streaming?.refinementAlgorithm;
        mockRefinementFocus = undefined;
        let mockStyle: CopcCesiumPointStyle = {
          colorMode: options.colorMode ?? "fixed",
        };
        return {
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
              await new Promise<void>((resolve) => {
                releaseMockLoad = resolve;
              });
            }
            if (failNextMockLoad) {
              failNextMockLoad = false;
              throw new Error("Injected mock load failure");
            }
          },
          destroy(): void {
            mockDestroyCount += 1;
          },
          setRefinementFocus(focus: RefinementFocus | undefined): void {
            mockFocusUpdateCount += 1;
            mockRefinementFocus = focus
              ? {
                  ...focus,
                  center: { ...focus.center },
                }
              : undefined;
          },
          async zoomTo(): Promise<boolean> {
            mockZoomCount += 1;
            activeRuntime?.setCameraState({
              longitude: -12,
              latitude: 24,
              height: 19_000_000,
              heading: 0,
              pitch: -90,
              roll: 0,
            });
            if (delayNextMockZoom) {
              delayNextMockZoom = false;
              await new Promise<void>((resolve) => {
                releaseMockZoom = resolve;
              });
            }
            return true;
          },
          getSelectedPoint(): undefined {
            return undefined;
          },
          getSnapshot(): ReturnType<CopcCesiumLayer["getSnapshot"]> {
            return {
              lifecycle: "ready",
              renderedPointCount: 0,
              renderedNodeKeys: [],
              selectedNodeKeys: [],
              performance: {
                visibleLevelRange: undefined,
                refinementAlgorithm: mockRefinementAlgorithm ?? "foveated",
                refinementFocusEnabled: mockRefinementFocus !== undefined,
                focusCandidateCount: mockRefinementFocus ? 2 : 0,
                focusInfluencedRefinementCount: mockRefinementFocus ? 1 : 0,
              },
            } as unknown as ReturnType<CopcCesiumLayer["getSnapshot"]>;
          },
          getMetadata(): undefined {
            return undefined;
          },
          getStyle(): CopcCesiumPointStyle {
            return structuredClone(mockStyle);
          },
          setStyle(update: CopcCesiumPointStyleUpdate): void {
            mockStyleUpdateCount += 1;
            if (failNextMockStyle) {
              failNextMockStyle = false;
              throw new Error("Injected mock style failure");
            }
            mockStyle = {
              ...mockStyle,
              ...(update.colorMode === undefined ? {} : { colorMode: update.colorMode }),
              ...(update.classificationFilter === undefined
                ? {}
                : update.classificationFilter === null
                  ? { classificationFilter: undefined }
                  : { classificationFilter: update.classificationFilter }),
            };
            if (mockStyle.classificationFilter === undefined) delete mockStyle.classificationFilter;
          },
          getHierarchyDiagnostics(): undefined {
            return undefined;
          },
          getPointCacheDiagnostics() {
            return {
              cacheByteBudget: 0,
              currentCacheBytes: 0,
              cachedNodeCount: 0,
              hits: 0,
              misses: 0,
              evictionCount: 0,
              bytesEvicted: 0,
              largestCachedEntryBytes: 0,
              prefetchUsefulHitCount: 0,
              prefetchEvictedUnusedCount: 0,
            };
          },
          get boundingSphere(): undefined {
            return undefined;
          },
        } as unknown as ReturnType<CesiumLayerFactory>;
      };
    },
    delayNextLoad(): void {
      delayNextMockLoad = true;
    },
    delayNextZoom(): void {
      delayNextMockZoom = true;
    },
    failNextLoad(): void {
      failNextMockLoad = true;
    },
    failNextStyle(): void {
      failNextMockStyle = true;
    },
    releaseDelayedLoad(): void {
      releaseMockLoad?.();
      releaseMockLoad = undefined;
    },
    releaseDelayedZoom(): void {
      releaseMockZoom?.();
      releaseMockZoom = undefined;
    },
    getMockLoadCount: () => mockLoadCount,
    getMockStyleUpdateCount: () => mockStyleUpdateCount,
    getAppliedConfig: () => appliedConfig ? structuredClone(appliedConfig) : undefined,
    getPendingConfig: () => structuredClone(pendingConfig),
    getMockLayerCreateCount: () => mockLayerCreateCount,
    getMockRefinementAlgorithm: () => mockRefinementAlgorithm,
    getMockFocusUpdateCount: () => mockFocusUpdateCount,
    getMockRefinementFocus: () => mockRefinementFocus,
    getMockDestroyCount: () => mockDestroyCount,
    getMockZoomCount: () => mockZoomCount,
    setCameraView(view): void {
      activeRuntime?.setCameraState(view);
    },
    getCameraView(): PlaygroundTestCameraView {
      return (
        activeRuntime?.getCameraState() ?? {
          longitude: 0,
          latitude: 0,
          height: 0,
          heading: 0,
          pitch: 0,
          roll: 0,
        }
      );
    },
    getPickablePointScreenPosition(): { x: number; y: number } | undefined {
      return activeRuntime?.getPickablePointScreenPosition();
    },
    getSnapshot(): PlaygroundSnapshot | undefined {
      return activeRuntime?.getSnapshot();
    },
    getCameraInputsEnabled(): boolean | undefined {
      return activeRuntime?.getCameraInputsEnabled();
    },
    generateIntegrationCode,
    readUrlConfig(query) {
      return readPlaygroundUrlConfig(new URLSearchParams(query));
    },
    writeUrlConfig(config, refinement, sourceUrl) {
      return writePlaygroundUrlConfig(config, refinement, sourceUrl).toString();
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
      return "remote source";
    }
  });
  return message;
};

const setStatus = (
  text: string,
  state: "unknown" | "loading" | "ready" | "error",
): void => {
  sourceStatus.textContent = text;
  sourceStatus.dataset.status = state;
  byId("diagnostic-status").textContent =
    state === "ready"
      ? "Ready"
      : state === "loading"
        ? "Loading"
        : state === "error"
          ? "Error"
          : "Waiting";
  byId("diagnostic-summary").textContent = text;
  statusFooter.textContent = `${state === "ready" ? "Ready" : state === "loading" ? "Loading" : state === "error" ? "Error" : "Ready"} · ${text}`;
  byId("hud-state").textContent =
    state === "ready"
      ? "Streaming"
      : state === "loading"
        ? "Loading"
        : state === "error"
          ? "Error"
          : "Waiting";
  byId("hud-dot").classList.toggle("muted", state !== "ready");
};

const knownRgbFormats = new Set([2, 3, 5, 7, 8, 10]);
const colorControl = mountSegmentedControl<PlaygroundColorMode>(
  byId("color-mode"),
  {
    label: "Color mode",
    value: pendingConfig.colorMode,
    className: "color-segments",
    choices: [],
    onChange: (value) => {
      const activeCesium =
        activeRuntimeReady &&
        !activeLoadPending &&
        activeRuntime?.renderer === "cesium" &&
        appliedConfig?.renderer === "cesium" &&
        pendingConfig.renderer === "cesium";
      if (activeCesium && !applyCesiumStyle({ colorMode: value })) {
        colorControl.setValue(appliedConfig?.colorMode ?? pendingConfig.colorMode);
        return;
      }
      if (!activeCesium || activeLoadPending) {
        updatePendingConfig({ colorMode: value });
      }
      byId("point-empty").textContent =
        "Click a point in the viewport to inspect its available attributes.";
    },
  },
);

const updateColorChoices = (pointFormat?: number): void => {
  const formatKnown = pointFormat !== undefined;
  const rgbSupported =
    formatKnown && knownRgbFormats.has(pointFormat & 0x3f);
  const choices: readonly UiSegmentOption<PlaygroundColorMode>[] = [
    { value: "fixed", label: "Fixed" },
    { value: "elevation", label: "Elevation" },
    { value: "intensity", label: "Intensity" },
    { value: "classification", label: "Classification" },
    {
      value: "rgb",
      label: "RGB",
      disabled: formatKnown && !rgbSupported,
      title: rgbSupported
        ? undefined
        : formatKnown
          ? "This dataset format does not advertise RGB channels."
          : undefined,
    },
  ];
  colorControl.setOptions(choices);
  if (formatKnown && !rgbSupported && pendingConfig.colorMode === "rgb") {
    colorControl.setValue("elevation");
  }
};
updateColorChoices();

const rendererControl = mountSegmentedControl<PlaygroundRenderer>(
  byId("renderer-control"),
  {
    label: "Renderer",
    value: pendingConfig.renderer,
    choices: workbenchRendererOptions,
    onChange: (value) => {
      updatePendingConfig({ renderer: value });
      syncRendererLabels();
    },
  },
);

const backendControl = mountSegmentedControl<PlaygroundBackend>(
  byId("backend-control"),
  {
    label: "COPC backend",
    value: pendingConfig.backend,
    choices: workbenchBackendOptions,
    onChange: (value) => {
      updatePendingConfig({ backend: value });
      syncRendererLabels();
    },
  },
);

const cameraControl = mountSegmentedControl<PlaygroundCameraView>(
  byId("camera-control"),
  {
    label: "Camera view",
    value: "overview",
    choices: [
      { value: "overview", label: "Overview" },
      { value: "near", label: "Near" },
      { value: "far", label: "Far" },
    ],
    onChange: (value) => {
      void activeRuntime?.setCameraView(value);
    },
  },
);

const sliders = [
  mountSlider(byId("point-size-control"), {
    id: "point-size",
    label: "Point size",
    min: 1,
    max: 10,
    step: 1,
    value: pendingConfig.pointSize,
    formatValue: (value) => `${formatUiNumber(value)} px`,
    onCommit(value) {
      byId<HTMLInputElement>("point-size-value").value = String(value);
      updatePendingConfig({ pointSize: value });
    },
  }),
  mountSlider(byId("max-nodes-control"), {
    id: "max-nodes",
    label: "Max selected nodes",
    min: 1,
    max: 48,
    step: 1,
    value: pendingConfig.maxNodes,
    formatValue: formatUiNumber,
    onCommit(value) {
      byId<HTMLInputElement>("max-nodes-value").value = String(value);
      updatePendingConfig({ maxNodes: value });
    },
  }),
  mountSlider(byId("max-points-control"), {
    id: "max-points",
    label: "Max rendered points",
    min: 50_000,
    max: 1_000_000,
    step: 50_000,
    value: pendingConfig.maxRenderedPoints,
    formatValue: (value) => formatUiNumber(value),
    onCommit(value) {
      byId<HTMLInputElement>("max-points-value").value = String(value);
      updatePendingConfig({ maxRenderedPoints: value });
    },
  }),
];

const focusRadiusSlider = mountSlider(byId("focus-radius-control"), {
  id: "focus-radius",
  label: "Radius",
  min: 1,
  max: 100,
  step: 0.01,
  value: refinementConfig.radius * 100,
  formatValue: (value) =>
    `${formatUiNumber(value)}% of the shorter viewport side`,
  onCommit(value) {
    refinementConfig = { ...refinementConfig, radius: value / 100 };
    applyFocusSettings();
  },
});
const focusBiasSlider = mountSlider(byId("focus-bias-control"), {
  id: "focus-bias",
  label: "Detail bias",
  min: 1,
  max: 2,
  step: 0.01,
  value: refinementConfig.detailBias,
  formatValue: (value) => `${formatUiNumber(value, 2)}×`,
  onCommit(value) {
    refinementConfig = { ...refinementConfig, detailBias: value };
    applyFocusSettings();
  },
});
sliders.push(focusRadiusSlider, focusBiasSlider);

const invalidNumericInputs = new Map<string, string>();

function syncPendingControls(): void {
  rendererControl.setValue(pendingConfig.renderer);
  backendControl.setValue(pendingConfig.backend);
  colorControl.setValue(pendingConfig.colorMode);
  sliders[0]?.setValue(pendingConfig.pointSize);
  sliders[1]?.setValue(pendingConfig.maxNodes);
  sliders[2]?.setValue(pendingConfig.maxRenderedPoints);
  const pointSizeOutOfSliderRange = pendingConfig.pointSize < 1 || pendingConfig.pointSize > 10;
  const maxNodesOutOfSliderRange = pendingConfig.maxNodes < 1 || pendingConfig.maxNodes > 48;
  const maxPointsOutOfSliderRange = pendingConfig.maxRenderedPoints < 50_000 || pendingConfig.maxRenderedPoints > 1_000_000;
  sliders[0]?.setDisabled(pointSizeOutOfSliderRange);
  sliders[1]?.setDisabled(maxNodesOutOfSliderRange);
  sliders[2]?.setDisabled(maxPointsOutOfSliderRange);
  const pointSizeSliderHelp = byId<HTMLElement>("point-size-slider-help");
  pointSizeSliderHelp.hidden = !pointSizeOutOfSliderRange;
  pointSizeSliderHelp.textContent = pointSizeOutOfSliderRange
    ? `The ${formatUiNumber(pendingConfig.pointSize)} px value is outside the quick-slider range. Adjust it with the numeric field.`
    : "";
  const streamingSliderHelp = byId<HTMLElement>("streaming-slider-help");
  const outOfRangeSettings = [
    ...(maxNodesOutOfSliderRange ? ["Max nodes"] : []),
    ...(maxPointsOutOfSliderRange ? ["Max rendered points"] : []),
  ];
  streamingSliderHelp.textContent = outOfRangeSettings.length > 0
    ? `${outOfRangeSettings.join(" and ")} is outside the quick-slider range. Adjust it with the numeric field. Constructor settings stay pending until applied.`
    : "Sliders are quick adjustments; numeric fields accept any valid package value. Constructor settings stay pending until applied.";
  for (const id of ["point-size-value", "max-nodes-value", "max-points-value", "cache-budget-mib", "max-depth-value", "max-sse-value", "max-distance-value"]) {
    invalidNumericInputs.delete(id);
    byId<HTMLInputElement>(id).removeAttribute("aria-invalid");
  }
  byId<HTMLInputElement>("point-size-value").value = String(pendingConfig.pointSize);
  byId<HTMLInputElement>("max-nodes-value").value = String(pendingConfig.maxNodes);
  byId<HTMLInputElement>("max-points-value").value = String(pendingConfig.maxRenderedPoints);
  byId<HTMLInputElement>("cache-budget-mib").value = String(
    cacheBytesToMib(pendingConfig.maxPointCacheBytes),
  );
  byId<HTMLInputElement>("max-depth-value").value = String(pendingConfig.maxDepth);
  byId<HTMLInputElement>("max-sse-value").value = String(
    pendingConfig.maxScreenSpaceError,
  );
  byId<HTMLInputElement>("max-distance-value").value = String(
    pendingConfig.maxRenderDistanceMeters,
  );
  algorithmSelect.value = pendingConfig.refinementConfig.algorithm;
  refinementConfig = pendingConfig.refinementConfig;
  updateFocusControls();
  updateClassificationControls();
}

function updateApplyState(): void {
  const configErrors = validatePlaygroundConfig(pendingConfig);
  const errors = [...invalidNumericInputs.values(), ...configErrors];
  configValidation.textContent = [...new Set(errors)].join(" ");
  configValidation.hidden = errors.length === 0;
  const hasPendingConstructorChanges =
    appliedConfig !== undefined &&
    hasConstructorChanges(pendingConfig, appliedConfig);
  applyChangesButton.disabled =
    !activeRuntimeReady ||
    appliedSource === undefined ||
    !hasPendingConstructorChanges ||
    errors.length > 0 ||
    activeLoadPending;
  byId<HTMLButtonElement>("reset-defaults").disabled = activeLoadPending;
  if (!activeRuntimeReady || !appliedConfig) {
    configState.textContent =
      "No layer is active. Settings apply when a source is loaded.";
  } else if (activeLoadPending) {
    configState.textContent = "Applying settings; the active layer remains available until replacement succeeds.";
  } else if (hasPendingConstructorChanges) {
    configState.textContent = "Pending settings differ from the active layer. Apply changes to replace the layer.";
  } else {
    configState.textContent = "Active layer matches the constructor settings.";
  }
  updateClassificationControls();
  updateRemoteLoadState();
}

function bindNumericInput(
  id: string,
  label: string,
  update: (value: number) => Partial<IntegrationCodeConfig>,
  validate: (value: number) => boolean,
): void {
  const input = byId<HTMLInputElement>(id);
  input.addEventListener("change", () => {
    const value = Number(input.value);
    if (input.value.trim() === "" || !validate(value)) {
      const message = `${label} must be a valid finite value within the package contract.`;
      invalidNumericInputs.set(id, message);
      input.setAttribute("aria-invalid", "true");
      updateApplyState();
      return;
    }
    invalidNumericInputs.delete(id);
    input.removeAttribute("aria-invalid");
    updatePendingConfig(update(value));
  });
}

bindNumericInput(
  "point-size-value",
  "Point size",
  (pointSize) => ({ pointSize }),
  (value) => Number.isFinite(value) && value > 0,
);
bindNumericInput(
  "max-nodes-value",
  "Max nodes",
  (maxNodes) => ({ maxNodes }),
  (value) => Number.isSafeInteger(value) && value > 0,
);
bindNumericInput(
  "max-points-value",
  "Max rendered points",
  (maxRenderedPoints) => ({ maxRenderedPoints }),
  (value) => Number.isSafeInteger(value) && value > 0,
);
bindNumericInput(
  "cache-budget-mib",
  "Cache budget",
  (value) => ({ maxPointCacheBytes: cacheMibToBytes(value) }),
  (value) => {
    try {
      cacheMibToBytes(value);
      return true;
    } catch {
      return false;
    }
  },
);
bindNumericInput(
  "max-depth-value",
  "Max depth",
  (maxDepth) => ({ maxDepth }),
  (value) => Number.isSafeInteger(value) && value >= 0,
);
bindNumericInput(
  "max-sse-value",
  "Max screen-space error",
  (maxScreenSpaceError) => ({ maxScreenSpaceError }),
  (value) => Number.isFinite(value) && value > 0,
);
bindNumericInput(
  "max-distance-value",
  "Max render distance",
  (maxRenderDistanceMeters) => ({ maxRenderDistanceMeters }),
  (value) => Number.isFinite(value) && value > 0,
);

function sameClassificationFilter(
  left: IntegrationCodeConfig["classificationFilter"],
  right: IntegrationCodeConfig["classificationFilter"],
): boolean {
  return JSON.stringify(normalizeClassificationFilter(left)) ===
    JSON.stringify(normalizeClassificationFilter(right));
}

function applyCesiumStyle(
  update: import("@frillab/copc-adapter/cesium").CopcCesiumPointStyleUpdate,
): boolean {
  const runtime = activeRuntime;
  if (
    !runtime ||
    runtime.renderer !== "cesium" ||
    !runtime.setStyle ||
    !runtime.getStyle ||
    !activeRuntimeReady ||
    activeLoadPending ||
    !appliedConfig
  ) {
    styleError.textContent = "Runtime styling requires an active Cesium layer.";
    styleError.hidden = false;
    return false;
  }
  try {
    runtime.setStyle(update);
    const style = runtime.getStyle();
    if (
      (update.colorMode !== undefined && style.colorMode !== update.colorMode) ||
      (update.classificationFilter === null &&
        style.classificationFilter !== undefined) ||
      (update.classificationFilter !== undefined &&
        update.classificationFilter !== null &&
        !sameClassificationFilter(
          style.classificationFilter,
          update.classificationFilter,
        ))
    ) {
      throw new Error("The Cesium layer did not confirm the requested style.");
    }
    const classificationFilter = normalizeClassificationFilter(
      style.classificationFilter,
    );
    appliedConfig = {
      ...appliedConfig,
      colorMode: style.colorMode,
      classificationFilter,
    };
    pendingConfig = {
      ...pendingConfig,
      colorMode: style.colorMode,
      classificationFilter,
    };
    if (activeDiagnosticsContext) {
      activeDiagnosticsContext = {
        ...activeDiagnosticsContext,
        config: appliedConfig,
      };
    }
    styleError.hidden = true;
    styleError.textContent = "";
    writePendingUrlConfig();
    syncPendingControls();
    updateApplyState();
    updateIntegrationExample();
    refreshSnapshot();
    return true;
  } catch (error) {
    styleError.textContent = `Style was not applied. ${safeErrorText(error)} The active style and generated code are unchanged.`;
    styleError.hidden = false;
    return false;
  }
}

function updateClassificationControls(): void {
  const activeCesium =
    activeRuntimeReady &&
    !activeLoadPending &&
    activeRuntime?.renderer === "cesium";
  const includeEnabled = pendingConfig.classificationFilter?.include !== undefined;
  const excludeEnabled = pendingConfig.classificationFilter?.exclude !== undefined;
  const includeCheckbox = byId<HTMLInputElement>("classification-include-enabled");
  const excludeCheckbox = byId<HTMLInputElement>("classification-exclude-enabled");
  includeCheckbox.checked = includeEnabled;
  excludeCheckbox.checked = excludeEnabled;
  classificationIncludeInput.disabled = !activeCesium || !includeEnabled;
  classificationExcludeInput.disabled = !activeCesium || !excludeEnabled;
  includeCheckbox.disabled = !activeCesium;
  excludeCheckbox.disabled = !activeCesium;
  classificationIncludeInput.value = includeEnabled
    ? pendingConfig.classificationFilter!.include!.join(", ")
    : "";
  classificationExcludeInput.value = excludeEnabled
    ? pendingConfig.classificationFilter!.exclude!.join(", ")
    : "";
  applyClassificationButton.disabled =
    !activeCesium ||
    sameClassificationFilter(
      pendingConfig.classificationFilter,
      appliedConfig?.classificationFilter,
    );
  clearClassificationButton.disabled =
    !activeCesium || appliedConfig?.classificationFilter === undefined;
  const activeFilter = appliedConfig?.classificationFilter;
  classificationActive.textContent = activeFilter
    ? [
        activeFilter.include === undefined
          ? undefined
          : `Include [${activeFilter.include.join(", ")}]`,
        activeFilter.exclude === undefined
          ? undefined
          : `Exclude [${activeFilter.exclude.join(", ")}]`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "No filter";
  byId("classification-help").textContent = activeCesium
    ? "Cesium applies the filter to retained point buffers. An empty include list hides all points; clear removes the filter."
    : "Classification filters require an active Cesium layer. Clear a Cesium filter before applying Three.js.";
}

function readClassificationForm(): IntegrationCodeConfig["classificationFilter"] {
  const includeEnabled = byId<HTMLInputElement>("classification-include-enabled").checked;
  const excludeEnabled = byId<HTMLInputElement>("classification-exclude-enabled").checked;
  if (!includeEnabled && !excludeEnabled) return undefined;
  return {
    ...(includeEnabled
      ? { include: parseClassificationCodes(classificationIncludeInput.value) }
      : {}),
    ...(excludeEnabled
      ? { exclude: parseClassificationCodes(classificationExcludeInput.value) }
      : {}),
  };
}

byId<HTMLInputElement>("classification-include-enabled").addEventListener("change", () => {
  classificationIncludeInput.disabled = !byId<HTMLInputElement>("classification-include-enabled").checked;
  try {
    updatePendingConfig({ classificationFilter: readClassificationForm() });
    classificationError.hidden = true;
  } catch (error) {
    classificationError.textContent = error instanceof Error ? error.message : String(error);
    classificationError.hidden = false;
  }
});
byId<HTMLInputElement>("classification-exclude-enabled").addEventListener("change", () => {
  classificationExcludeInput.disabled = !byId<HTMLInputElement>("classification-exclude-enabled").checked;
  try {
    updatePendingConfig({ classificationFilter: readClassificationForm() });
    classificationError.hidden = true;
  } catch (error) {
    classificationError.textContent = error instanceof Error ? error.message : String(error);
    classificationError.hidden = false;
  }
});
classificationIncludeInput.addEventListener("change", () => {
  try {
    updatePendingConfig({ classificationFilter: readClassificationForm() });
    classificationError.hidden = true;
  } catch (error) {
    classificationError.textContent = error instanceof Error ? error.message : String(error);
    classificationError.hidden = false;
  }
});
classificationExcludeInput.addEventListener("change", () => {
  try {
    updatePendingConfig({ classificationFilter: readClassificationForm() });
    classificationError.hidden = true;
  } catch (error) {
    classificationError.textContent = error instanceof Error ? error.message : String(error);
    classificationError.hidden = false;
  }
});
applyClassificationButton.addEventListener("click", () => {
  try {
    const filter = readClassificationForm();
    if (applyCesiumStyle({ classificationFilter: filter ?? null })) {
      classificationError.hidden = true;
    }
  } catch (error) {
    classificationError.textContent = error instanceof Error ? error.message : String(error);
    classificationError.hidden = false;
  }
});
clearClassificationButton.addEventListener("click", () => {
  if (applyCesiumStyle({ classificationFilter: null })) {
    classificationError.hidden = true;
  }
});

syncPendingControls();

function effectiveRefinementFocus(
  center = pendingConfig.refinementConfig.focusMode === "follow-pointer"
    ? followPointerCenter
    : pendingConfig.refinementConfig.center,
  activeRenderer = activeRuntime?.renderer ?? pendingConfig.renderer,
  config = pendingConfig.refinementConfig,
): RefinementFocus | undefined {
  if (
    activeRenderer !== "cesium" ||
    !config.focusEnabled ||
    config.focusMode === "auto-center"
  )
    return undefined;
  return {
    type: "screen-circle",
    center: { x: center.x, y: center.y },
    radius: config.radius,
    detailBias: config.detailBias,
  };
}

function syncSourcePrivacyControls(): void {
  const source = appliedSource;
  const hasSource = source !== undefined;
  const isLocalFile =
    typeof File !== "undefined" && source instanceof File;
  const sensitive =
    typeof source === "string" && isPotentiallySensitiveSource(source);

  exactSourceOption.hidden = !hasSource || isLocalFile;
  exactSourceInput.disabled = !hasSource || isLocalFile;
  if (!hasSource || isLocalFile) exactSourceInput.checked = false;
  sourceCodeWarning.hidden = !sensitive;
  sourceCodeWarning.textContent = sensitive
    ? exactSourceInput.checked
      ? "This URL contains credentials, query parameters, or a fragment. The visible snippet includes it; copying requires confirmation."
      : "This URL may contain credentials or tokens. The snippet uses a placeholder; enable the checkbox above to reveal and copy the exact URL."
    : "";

  shareSourceOption.hidden = !hasSource;
  shareSourceInput.disabled = !hasSource || isLocalFile || sensitive;
  if (shareSourceInput.disabled) shareSourceInput.checked = false;
  sourceShareWarning.hidden = !hasSource || (!isLocalFile && !sensitive);
  sourceShareWarning.textContent = isLocalFile
    ? "A local File cannot be serialized into a share link; the link will contain settings only."
    : sensitive
      ? "This URL may contain credentials or tokens, so it cannot be included in a share link."
      : "";
}

function updateIntegrationExample(): void {
  const config = appliedConfig ?? defaultIntegrationConfig;
  const focusConfig = config.refinementConfig;
  const focus = effectiveRefinementFocus(
    focusConfig.center,
    config.renderer,
    focusConfig,
  );
  codeElement.textContent = generateIntegrationCode({
    config,
    source: appliedSource,
    includeExactSource: exactSourceInput.checked,
    mode: codeMode,
    adapterVersion: __ADAPTER_VERSION__,
    ...(focus ? { refinementFocus: focus } : {}),
  });
  installCommand.textContent = PLAYGROUND_INSTALL_COMMANDS[config.renderer];
  codeModeMinimalButton.setAttribute(
    "aria-pressed",
    String(codeMode === "minimal"),
  );
  codeModeExplicitButton.setAttribute(
    "aria-pressed",
    String(codeMode === "explicit"),
  );
  syncSourcePrivacyControls();
}

function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  return copied
    ? Promise.resolve()
    : Promise.reject(new Error("Clipboard access is unavailable."));
}

async function copyWithFeedback(
  button: HTMLButtonElement,
  content: string,
  successMessage: string,
): Promise<void> {
  try {
    await copyTextToClipboard(content);
    button.textContent = "Copied";
    shareStatus.textContent = successMessage;
  } catch {
    button.textContent = "Copy failed";
    shareStatus.textContent =
      "Copy failed. Select the visible text and copy it manually.";
  }
  window.setTimeout(() => {
    if (!disposed) {
      button.textContent =
        button === copyCodeButton
          ? "Copy code"
          : button === copyInstallButton
            ? "Copy install command"
            : "Copy share link";
    }
  }, 1800);
}

function createShareUrl(): string {
  const config = appliedConfig
    ? {
        ...clonePlaygroundConfig(appliedConfig),
        refinementConfig: {
          ...appliedConfig.refinementConfig,
          center: { ...appliedConfig.refinementConfig.center },
        },
      }
    : captureWorkbenchConfig();
  const sourceUrl =
    shareSourceInput.checked && typeof appliedSource === "string"
      ? appliedSource
      : undefined;
  const params = writePlaygroundUrlConfig(
    config,
    config.refinementConfig,
    sourceUrl,
  );
  const url = new URL(window.location.href);
  url.search = params.toString();
  url.hash = "";
  return url.toString();
}

function updateFocusControls(): void {
  const focusRenderer = activeRuntimeReady
    ? activeRuntime?.renderer ?? pendingConfig.renderer
    : pendingConfig.renderer;
  refinementConfig = pendingConfig.refinementConfig;
  algorithmSelect.value = refinementConfig.algorithm;
  focusModeSelect.value = refinementConfig.focusMode;
  focusEnabledInput.checked = refinementConfig.focusEnabled;
  focusShowGuideInput.checked = refinementConfig.showGuide;
  focusEnabledInput.disabled =
    focusRenderer !== "cesium" || refinementConfig.focusMode === "auto-center";
  focusShowGuideInput.disabled = focusRenderer !== "cesium";
  focusModeSelect.disabled = focusRenderer !== "cesium";
  focusRadiusSlider.setDisabled(
    focusRenderer !== "cesium" || refinementConfig.focusMode === "auto-center",
  );
  focusBiasSlider.setDisabled(
    focusRenderer !== "cesium" || refinementConfig.focusMode === "auto-center",
  );
  focusRadiusSlider.setValue(refinementConfig.radius * 100);
  focusBiasSlider.setValue(refinementConfig.detailBias);

  const positionEditable =
    focusRenderer === "cesium" &&
    refinementConfig.focusMode !== "auto-center" &&
    refinementConfig.focusMode !== "follow-pointer";
  focusPositionControls.hidden = !positionEditable;
  focusXInput.disabled = !positionEditable;
  focusYInput.disabled = !positionEditable;
  focusXInput.value = String(refinementConfig.center.x);
  focusYInput.value = String(refinementConfig.center.y);
  byId<HTMLButtonElement>("focus-reset").disabled = !positionEditable;

  const focusAvailable = focusRenderer === "cesium";
  byId<HTMLElement>("focus-help").textContent = focusAvailable
    ? "Focus prioritizes LoD refinement near this screen-space region; it does not crop the point cloud."
    : "Focus Lens controls require the Cesium renderer. The refinement algorithm applies to both renderers.";
  focusGuide.hidden =
    !focusAvailable ||
    !refinementConfig.showGuide ||
    refinementConfig.focusMode === "auto-center";
  focusGuide.classList.toggle("is-inactive", !refinementConfig.focusEnabled);
  focusGuide.classList.toggle(
    "is-pointer-mode",
    refinementConfig.focusMode === "follow-pointer",
  );
  focusGuideHandle.tabIndex =
    focusGuide.hidden || refinementConfig.focusMode === "follow-pointer"
      ? -1
      : 0;
  focusGuideHandle.setAttribute(
    "aria-label",
    `Move focus lens, X ${refinementConfig.center.x.toFixed(2)}, Y ${refinementConfig.center.y.toFixed(2)}`,
  );
  updateFocusGuidePosition();
}

function writePendingUrlConfig(): void {
  const currentParams = new URLSearchParams(window.location.search);
  const currentSourceUrl = currentParams.get("sourceUrl");
  const sharedSource =
    currentSourceUrl && !isPotentiallySensitiveSource(currentSourceUrl)
      ? currentSourceUrl
      : undefined;
  const params = writePlaygroundUrlConfig(
    captureWorkbenchConfig(),
    pendingConfig.refinementConfig,
    sharedSource,
  );
  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState(window.history.state, "", nextUrl);
  focusConfigWarning.hidden = true;
}

function removeSharedSourceParam(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("sourceUrl")) return;
  params.delete("sourceUrl");
  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState(window.history.state, "", nextUrl);
}

function applyFocusSettings(syncUrl = true, cancelReplacement = true): void {
  if (cancelReplacement) cancelPendingApplyForEdit();
  pendingConfig = {
    ...pendingConfig,
    refinementConfig: {
      ...refinementConfig,
      center: { ...refinementConfig.center },
    },
  };
  updateFocusControls();
  const focus = effectiveRefinementFocus(
    refinementConfig.focusMode === "follow-pointer"
      ? followPointerCenter
      : refinementConfig.center,
    activeRuntime?.renderer ?? pendingConfig.renderer,
    refinementConfig,
  );
  if (activeRuntime?.renderer === "cesium" && activeRuntimeReady && !activeLoadPending) {
    try {
      activeRuntime.setRefinementFocus(focus);
      if (appliedConfig) {
        appliedConfig = {
          ...appliedConfig,
          refinementConfig: {
            ...refinementConfig,
            algorithm: appliedConfig.refinementConfig.algorithm,
            center: { ...refinementConfig.center },
          },
        };
      }
    } catch (error) {
      styleError.textContent = `Focus settings were not applied. ${safeErrorText(error)}`;
      styleError.hidden = false;
      return;
    }
  }
  lastAppliedFocusCenter = focus?.center;
  if (syncUrl) writePendingUrlConfig();
  updateApplyState();
  updateIntegrationExample();
  refreshSnapshot();
}

function setFocusMode(mode: PlaygroundFocusMode): void {
  const previousMode = refinementConfig.focusMode;
  if (
    previousMode === "follow-pointer" &&
    mode !== "follow-pointer" &&
    mode !== "center-boost"
  ) {
    refinementConfig = {
      ...refinementConfig,
      center: { ...followPointerCenter },
    };
  }
  if (mode === "center-boost") {
    refinementConfig = { ...refinementConfig, center: { x: 0.5, y: 0.5 } };
  }
  refinementConfig = {
    ...refinementConfig,
    focusMode: mode,
    focusEnabled: mode === "auto-center" ? false : true,
  };
  if (mode === "follow-pointer")
    followPointerCenter = { ...refinementConfig.center };
  applyFocusSettings();
}

function setFocusCenter(
  center: { x: number; y: number },
  syncUrl = true,
): void {
  const bounded = {
    x: Math.min(1, Math.max(0, center.x)),
    y: Math.min(1, Math.max(0, center.y)),
  };
  if (refinementConfig.focusMode === "center-boost") {
    refinementConfig = { ...refinementConfig, focusMode: "pinned" };
  }
  refinementConfig = { ...refinementConfig, center: bounded };
  followPointerCenter = { ...bounded };
  applyFocusSettings(syncUrl);
}

function updateFocusGuidePosition(): void {
  const canvas = activeRuntime?.getFocusCanvas();
  if (!canvas || focusGuide.hidden) return;
  const canvasRect = canvas.getBoundingClientRect();
  const frameRect = viewerFrame.getBoundingClientRect();
  if (canvasRect.width <= 0 || canvasRect.height <= 0) return;
  const diameter =
    refinementConfig.radius * 2 * Math.min(canvasRect.width, canvasRect.height);
  const center =
    refinementConfig.focusMode === "follow-pointer"
      ? followPointerCenter
      : refinementConfig.center;
  focusGuide.style.width = `${diameter}px`;
  focusGuide.style.height = `${diameter}px`;
  focusGuide.style.left = `${canvasRect.left - frameRect.left + center.x * canvasRect.width}px`;
  focusGuide.style.top = `${canvasRect.top - frameRect.top + center.y * canvasRect.height}px`;
}

function unbindPointerFocus(): void {
  if (pointerFocusCanvas)
    pointerFocusCanvas.removeEventListener(
      "pointermove",
      onFocusCanvasPointerMove,
    );
  pointerFocusCanvas = undefined;
  if (pointerFocusFrame !== undefined) cancelAnimationFrame(pointerFocusFrame);
  if (pointerFocusTimer !== undefined) window.clearTimeout(pointerFocusTimer);
  pointerFocusFrame = undefined;
  pointerFocusTimer = undefined;
  pendingPointerCenter = undefined;
}

function flushFollowPointerUpdate(): void {
  pointerFocusFrame = undefined;
  if (
    !pendingPointerCenter ||
    activeRuntime?.renderer !== "cesium" ||
    refinementConfig.focusMode !== "follow-pointer" ||
    !refinementConfig.focusEnabled
  )
    return;
  const now = performance.now();
  const interval = 33;
  if (now - lastPointerFocusUpdateAt < interval) {
    pointerFocusTimer = window.setTimeout(
      () => {
        pointerFocusTimer = undefined;
        if (pointerFocusFrame === undefined)
          pointerFocusFrame = requestAnimationFrame(flushFollowPointerUpdate);
      },
      interval - (now - lastPointerFocusUpdateAt),
    );
    return;
  }
  const center = pendingPointerCenter;
  pendingPointerCenter = undefined;
  const previous = lastAppliedFocusCenter;
  if (
    previous &&
    Math.abs(center.x - previous.x) < 0.005 &&
    Math.abs(center.y - previous.y) < 0.005
  )
    return;
  followPointerCenter = center;
  lastPointerFocusUpdateAt = now;
  applyFocusSettings(false, false);
}

function onFocusCanvasPointerMove(event: PointerEvent): void {
  if (!pointerFocusCanvas || refinementConfig.focusMode !== "follow-pointer")
    return;
  const rect = pointerFocusCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const center = {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
  followPointerCenter = center;
  updateFocusGuidePosition();
  if (!refinementConfig.focusEnabled) return;
  pendingPointerCenter = center;
  if (pointerFocusFrame === undefined && pointerFocusTimer === undefined) {
    pointerFocusFrame = requestAnimationFrame(flushFollowPointerUpdate);
  }
}

function bindPointerFocus(runtime: PlaygroundRuntime): void {
  unbindPointerFocus();
  const canvas = runtime.getFocusCanvas();
  if (!canvas) return;
  pointerFocusCanvas = canvas;
  canvas.addEventListener("pointermove", onFocusCanvasPointerMove, {
    passive: true,
  });
}

function finishFocusDrag(): void {
  if (focusDragPointerId === undefined) return;
  if (pendingDragCenter) flushDragFocusUpdate(true);
  focusDragPointerId = undefined;
  activeRuntime?.setFocusDragging(false);
  if (dragFocusFrame !== undefined) cancelAnimationFrame(dragFocusFrame);
  if (dragFocusTimer !== undefined) window.clearTimeout(dragFocusTimer);
  dragFocusFrame = undefined;
  dragFocusTimer = undefined;
  pendingDragCenter = undefined;
  if (focusConfigSyncTimer !== undefined)
    window.clearTimeout(focusConfigSyncTimer);
  focusConfigSyncTimer = undefined;
  writePendingUrlConfig();
}

function onFocusGuidePointerDown(event: PointerEvent): void {
  if (
    focusGuide.hidden ||
    refinementConfig.focusMode === "follow-pointer" ||
    activeRuntime?.renderer !== "cesium"
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  if (refinementConfig.focusMode === "center-boost") {
    refinementConfig = { ...refinementConfig, focusMode: "pinned" };
    updateFocusControls();
  }
  const canvas = activeRuntime?.getFocusCanvas();
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const center = {
    x: rect.left + refinementConfig.center.x * rect.width,
    y: rect.top + refinementConfig.center.y * rect.height,
  };
  focusDragOffset = {
    x: event.clientX - center.x,
    y: event.clientY - center.y,
  };
  focusDragPointerId = event.pointerId;
  focusGuideHandle.setPointerCapture(event.pointerId);
  activeRuntime?.setFocusDragging(true);
}

function onFocusGuidePointerMove(event: PointerEvent): void {
  if (focusDragPointerId !== event.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  const canvas = activeRuntime?.getFocusCanvas();
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const center = {
    x: (event.clientX - focusDragOffset.x - rect.left) / rect.width,
    y: (event.clientY - focusDragOffset.y - rect.top) / rect.height,
  };
  pendingDragCenter = {
    x: Math.min(1, Math.max(0, center.x)),
    y: Math.min(1, Math.max(0, center.y)),
  };
  if (dragFocusFrame === undefined && dragFocusTimer === undefined) {
    dragFocusFrame = requestAnimationFrame(() => flushDragFocusUpdate());
  }
}

function flushDragFocusUpdate(force = false): void {
  dragFocusFrame = undefined;
  if (!pendingDragCenter || focusDragPointerId === undefined) return;
  const now = performance.now();
  const interval = 33;
  if (!force && now - lastDragFocusUpdateAt < interval) {
    dragFocusTimer = window.setTimeout(
      () => {
        dragFocusTimer = undefined;
        if (dragFocusFrame === undefined)
          dragFocusFrame = requestAnimationFrame(() => flushDragFocusUpdate());
      },
      interval - (now - lastDragFocusUpdateAt),
    );
    return;
  }
  const center = pendingDragCenter;
  pendingDragCenter = undefined;
  const previous = refinementConfig.center;
  if (
    !force &&
    Math.abs(center.x - previous.x) < 0.005 &&
    Math.abs(center.y - previous.y) < 0.005
  )
    return;
  lastDragFocusUpdateAt = now;
  setFocusCenter(center, false);
  if (focusConfigSyncTimer !== undefined)
    window.clearTimeout(focusConfigSyncTimer);
  focusConfigSyncTimer = window.setTimeout(() => {
    focusConfigSyncTimer = undefined;
    writePendingUrlConfig();
  }, 300);
}

function onFocusGuideKeyDown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 0.05 : 0.01;
  const center = { ...refinementConfig.center };
  if (event.key === "ArrowLeft") center.x -= step;
  else if (event.key === "ArrowRight") center.x += step;
  else if (event.key === "ArrowUp") center.y -= step;
  else if (event.key === "ArrowDown") center.y += step;
  else if (event.key === "Home") {
    center.x = 0.5;
    center.y = 0.5;
  } else return;
  event.preventDefault();
  setFocusCenter(center);
}

focusGuideHandle.addEventListener("pointerdown", onFocusGuidePointerDown);
focusGuideHandle.addEventListener("pointermove", onFocusGuidePointerMove);
focusGuideHandle.addEventListener("pointerup", finishFocusDrag);
focusGuideHandle.addEventListener("pointercancel", finishFocusDrag);
focusGuideHandle.addEventListener("lostpointercapture", finishFocusDrag);
focusGuideHandle.addEventListener("keydown", onFocusGuideKeyDown);
const focusResizeObserver = new ResizeObserver(updateFocusGuidePosition);
focusResizeObserver.observe(viewerFrame);

function syncRendererLabels(): void {
  const activeRenderer = activeRuntime?.renderer ?? pendingConfig.renderer;
  const label = activeRenderer === "cesium" ? "Cesium" : "Three.js";
  rendererHeading.textContent = label;
  rendererBadge.textContent = label;
  viewport.setAttribute(
    "aria-label",
    `Interactive ${label} point cloud viewport`,
  );
  updateIntegrationExample();
  updateFocusControls();
  if (activeRuntime)
    viewerCaption.textContent = `${label} renders the selected COPC data in this browser.`;
}
syncRendererLabels();

const renderPoint = (point: CopcPointInspection | undefined): void => {
  const empty = byId<HTMLElement>("point-empty");
  const attributes = byId<HTMLDListElement>("point-attributes");
  if (!point) {
    empty.hidden = false;
    attributes.hidden = true;
    attributes.replaceChildren();
    return;
  }
  const rows: Array<[string, string]> = [
    ["Longitude", `${point.longitude.toFixed(7)}°`],
    ["Latitude", `${point.latitude.toFixed(7)}°`],
    ["Height", `${formatUiNumber(point.height, 3)} m`],
  ];
  if (point.classification !== undefined)
    rows.push([
      "Classification",
      point.classificationLabel ?? String(point.classification),
    ]);
  if (point.intensity !== undefined)
    rows.push(["Intensity", formatUiNumber(point.intensity)]);
  if (point.rgb !== undefined)
    rows.push([
      "RGB",
      `(${point.rgb.red}, ${point.rgb.green}, ${point.rgb.blue})`,
    ]);
  attributes.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = value;
      return [term, description];
    }),
  );
  empty.hidden = true;
  attributes.hidden = false;
};

const updateSnapshot = (snapshot: PlaygroundSnapshot | undefined): void => {
  byId("hud-points").textContent = formatUiNumber(
    snapshot?.renderedPoints ?? 0,
  );
  byId("hud-nodes").textContent = formatUiNumber(
    snapshot?.renderedNodes ?? 0,
  );
};

const renderDiagnosticsDashboard = (
  diagnostics: PlaygroundLayerDiagnostics | undefined,
): void => {
  const context = activeDiagnosticsContext;
  if (!context) {
    byId("diagnostic-context").textContent =
      "Load a source to see active configuration and measurements.";
    byId("diagnostic-summary").textContent = "Waiting for a source";
    const unavailableIds = [
      "diagnostic-status",
      "diagnostic-source",
      "diagnostic-range",
      "diagnostic-copc",
      "diagnostic-validation",
      "diagnostic-source-status",
      "diagnostic-metadata-points",
      "diagnostic-points",
      "diagnostic-nodes",
      "diagnostic-selected",
      "diagnostic-selected-point-cost",
      "diagnostic-rendered-nodes",
      "diagnostic-selected-nodes",
      "diagnostic-lod",
      "diagnostic-update-count",
      "diagnostic-range-bytes",
      "diagnostic-range-requests",
      "diagnostic-range-requests-details",
      "diagnostic-hierarchy-requests",
      "diagnostic-hierarchy-bytes",
      "diagnostic-hierarchy-cache",
      "diagnostic-transition",
      "diagnostic-decode",
      "diagnostic-update-duration",
      "diagnostic-selection-duration",
      "diagnostic-range-duration",
      "diagnostic-decode-duration",
      "diagnostic-preparation-duration",
      "diagnostic-crs-duration",
      "diagnostic-renderer-duration",
      "diagnostic-budget",
      "diagnostic-sse",
      "diagnostic-refinements",
      "diagnostic-cache-bytes",
      "diagnostic-cache-entries",
      "diagnostic-cache-budget",
      "diagnostic-cache-hits",
      "diagnostic-cache-evictions",
      "diagnostic-worker",
      "diagnostic-worker-note",
      "diagnostic-worker-details",
      "diagnostic-render-interval",
      "diagnostic-render-cadence",
      "diagnostic-detailed-cadence",
      "diagnostic-load-time",
      "diagnostic-first-visible",
      "diagnostic-long-task",
      "diagnostic-algorithm",
      "diagnostic-focus",
      "diagnostic-focus-candidates",
      "diagnostic-focus-refinements",
    ];
    for (const id of unavailableIds) byId(id).textContent = "Not available";
    return;
  }
  const model = createDiagnosticsViewModel(
    diagnostics,
    context,
    browserMeasurements,
  );
  const values: Record<string, string> = {
    "diagnostic-context": model.context,
    "diagnostic-status": model.lifecycle,
    "diagnostic-source": `${model.sourceLabel} · ${model.sourceSize}`,
    "diagnostic-source-status": model.sourceStatus,
    "diagnostic-metadata-points": model.metadataPointCount,
    "diagnostic-points": model.renderedPoints,
    "diagnostic-nodes": model.renderedNodes,
    "diagnostic-selected": model.selectedNodes,
    "diagnostic-selected-point-cost": model.selectedPointCost,
    "diagnostic-rendered-nodes": model.renderedNodes,
    "diagnostic-selected-nodes": model.selectedNodes,
    "diagnostic-lod": model.visibleLevels,
    "diagnostic-update-count": model.updateCount,
    "diagnostic-range-bytes": model.rangeBytesLatestUpdate,
    "diagnostic-range-requests": model.rangeRequests,
    "diagnostic-range-requests-details": model.rangeRequests,
    "diagnostic-hierarchy-requests": model.hierarchyRequests,
    "diagnostic-hierarchy-bytes": model.hierarchyBytes,
    "diagnostic-hierarchy-cache": model.hierarchyCache,
    "diagnostic-transition": model.transitionSummary,
    "diagnostic-decode": model.decodeDuration,
    "diagnostic-update-duration": model.updateDuration,
    "diagnostic-selection-duration": model.selectionDuration,
    "diagnostic-range-duration": model.rangeDuration,
    "diagnostic-decode-duration": model.decodeDuration,
    "diagnostic-preparation-duration": model.preparationDuration,
    "diagnostic-crs-duration": model.crsDuration,
    "diagnostic-renderer-duration": model.rendererDuration,
    "diagnostic-budget": model.configuredBudget,
    "diagnostic-sse": model.maxScreenSpaceError,
    "diagnostic-refinements": `${model.acceptedRefinements} accepted · ${model.rejectedRefinements} rejected`,
    "diagnostic-cache-bytes": model.cacheBytes,
    "diagnostic-cache-entries": `${model.cacheEntries} entries`,
    "diagnostic-cache-budget": model.cacheBudget,
    "diagnostic-cache-hits": `${model.cacheHits} hits · ${model.cacheMisses} misses`,
    "diagnostic-cache-evictions": `${model.cacheEvictions} · ${model.cacheBytesEvicted}`,
    "diagnostic-worker": model.workerSummary,
    "diagnostic-worker-note":
      context.config.backend === "rust"
        ? "worker pool diagnostics"
        : "copc-js backend",
    "diagnostic-worker-details": model.workerDetails,
    "diagnostic-render-interval": model.renderInterval,
    "diagnostic-render-cadence": model.approximateRenderCadence,
    "diagnostic-detailed-cadence": model.approximateRenderCadence,
    "diagnostic-load-time": model.loadElapsed,
    "diagnostic-first-visible": model.firstVisiblePoints,
    "diagnostic-long-task": model.longestLongTask,
    "diagnostic-algorithm": model.refinementAlgorithm,
    "diagnostic-focus": model.focusState,
    "diagnostic-focus-candidates": model.focusCandidates,
    "diagnostic-focus-refinements": model.focusRefinements,
  };
  for (const [id, value] of Object.entries(values))
    byId(id).textContent = value;
};

const refreshSnapshot = (): void => {
  if (!activeRuntime) {
    updateSnapshot(undefined);
    renderDiagnosticsDashboard(undefined);
    return;
  }
  try {
    const runtime = activeRuntime;
    const diagnostics = runtime.getDiagnostics();
    updateSnapshot(diagnostics.snapshot);
    browserMeasurements = {
      ...browserMeasurements,
      renderIntervalMs: runtime.getLatestRenderIntervalMs(),
      ...(browserMeasurements.firstVisiblePointsMs === undefined &&
      diagnostics.snapshot.renderedPoints > 0 &&
      loadInitiatedAt !== undefined
        ? { firstVisiblePointsMs: performance.now() - loadInitiatedAt }
        : {}),
    };
    renderDiagnosticsDashboard(diagnostics);
  } catch {
    updateSnapshot(undefined);
    renderDiagnosticsDashboard(undefined);
  }
};

const observeBrowserLongTasks = (
  runtime: PlaygroundRuntime,
): void => {
  longTaskObserver?.disconnect();
  longTaskObserver = undefined;
  browserMeasurements = {
    ...browserMeasurements,
    longestLongTaskMs: undefined,
  };
  const observerConstructor =
    typeof PerformanceObserver === "undefined" ? undefined : PerformanceObserver;
  if (!supportsLongTaskObservation(observerConstructor))
    return;
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => {
      if (activeRuntime !== runtime) return;
      const longest = list
        .getEntries()
        .reduce((maximum, entry) => Math.max(maximum, entry.duration), 0);
      if (longest > 0) {
        browserMeasurements = {
          ...browserMeasurements,
          longestLongTaskMs: Math.max(
            browserMeasurements.longestLongTaskMs ?? 0,
            longest,
          ),
        };
        renderDiagnosticsDashboard(runtime.getDiagnostics());
      }
    });
    observer.observe({ type: "longtask", buffered: false });
    longTaskObserver = observer;
  } catch {
    observer?.disconnect();
    longTaskObserver = undefined;
  }
};

algorithmSelect.addEventListener("change", () => {
  const selected = refinementAlgorithmOptions.find(
    (option) => option.value === algorithmSelect.value,
  );
  if (!selected) return;
  refinementConfig = { ...refinementConfig, algorithm: selected.value };
  updatePendingConfig({ refinementConfig });
});

focusModeSelect.addEventListener("change", () => {
  setFocusMode(focusModeSelect.value as PlaygroundFocusMode);
});
focusEnabledInput.addEventListener("change", () => {
  refinementConfig = {
    ...refinementConfig,
    focusEnabled: focusEnabledInput.checked,
  };
  applyFocusSettings();
});
focusShowGuideInput.addEventListener("change", () => {
  refinementConfig = {
    ...refinementConfig,
    showGuide: focusShowGuideInput.checked,
  };
  updatePendingConfig({ refinementConfig });
  if (appliedConfig) {
    appliedConfig = {
      ...appliedConfig,
      refinementConfig: { ...appliedConfig.refinementConfig, showGuide: refinementConfig.showGuide },
    };
    updateIntegrationExample();
  }
});
focusXInput.addEventListener("change", () => {
  const x = Number(focusXInput.value);
  if (!Number.isFinite(x) || x < 0 || x > 1) {
    focusXInput.value = String(refinementConfig.center.x);
    return;
  }
  setFocusCenter({ ...refinementConfig.center, x });
});
focusYInput.addEventListener("change", () => {
  const y = Number(focusYInput.value);
  if (!Number.isFinite(y) || y < 0 || y > 1) {
    focusYInput.value = String(refinementConfig.center.y);
    return;
  }
  setFocusCenter({ ...refinementConfig.center, y });
});
byId<HTMLButtonElement>("focus-reset").addEventListener("click", () => {
  if (refinementConfig.focusMode === "follow-pointer") {
    refinementConfig = { ...refinementConfig, focusMode: "pinned" };
  }
  refinementConfig = { ...refinementConfig, center: { x: 0.5, y: 0.5 } };
  followPointerCenter = { x: 0.5, y: 0.5 };
  applyFocusSettings();
});

updateFocusControls();
updateIntegrationExample();

function describeProbeTruth(value: boolean | "unknown", positive: string, negative: string): string {
  return value === true ? positive : value === false ? negative : "Unknown";
}

function describeValidationLevel(value: string): string {
  return value === "strict"
    ? "Strict response validation"
    : value === "compatibility-limited"
      ? "Compatibility-limited"
      : value;
}

const showProbe = (result: CopcSourceProbeResult): void => {
  const warnings = safeErrorText(result.warnings.join(" "));
  probeDetails.hidden = false;
  byId("probe-reachable").textContent = result.reachable ? "Yes" : "No";
  byId("probe-http-status").textContent = result.status === undefined ? "Unavailable" : String(result.status);
  byId("probe-partial-status").textContent = result.partialStatus === undefined ? "Unavailable" : String(result.partialStatus);
  byId("probe-cors").textContent = describeProbeTruth(result.corsReadable, "Readable", "Not readable");
  byId("probe-range").textContent = describeProbeTruth(result.rangeSupported, "Supported", "Unsupported");
  byId("probe-copc").textContent = describeProbeTruth(result.copcDetected, "Detected", "Not detected");
  byId("probe-point-format").textContent = result.pointFormat === undefined ? "Unavailable" : String(result.pointFormat & 0x3f);
  byId("probe-resource-size").textContent = result.contentLength === undefined ? "Unavailable" : formatDiagnosticBytes(result.contentLength);
  byId("probe-validation").textContent = describeValidationLevel(result.validationLevel);
  probeWarning.textContent = warnings;
  probeWarning.hidden = warnings.length === 0;
  sourceProbe.textContent = "Probe complete. Review the checks below before loading this source.";
};

function probeFailureReason(result: CopcSourceProbeResult): string | undefined {
  if (result.status !== undefined && result.status >= 400) return `The source returned HTTP ${result.status}. Check the URL and access permissions.`;
  if (result.partialStatus !== undefined && result.partialStatus >= 400) return `The Range request returned HTTP ${result.partialStatus}. Check the host's Range and access configuration.`;
  if (result.corsReadable === false) return "The browser could not read this response because of its CORS policy. The host must allow this page's origin.";
  if (result.rangeSupported === false) return "The host did not provide a usable byte-range response. Configure HTTP Range support without weakening response validation.";
  if (result.validationLevel === "incompatible") return "The source did not satisfy the package's byte-range validation. Check the host's Range and Content-Range responses.";
  if (result.copcDetected === false) return "The readable response does not contain COPC metadata. Choose a COPC LAZ resource.";
  return undefined;
}

const getFilePointFormat = async (file: File): Promise<number | undefined> => {
  if (file.size <= 104) return undefined;
  const header = new Uint8Array(await file.slice(104, 105).arrayBuffer());
  return header.length === 1 ? header[0] & 0x3f : undefined;
};

function clearRuntimeObservations(): void {
  diagnosticsRefreshCleanup?.();
  diagnosticsRefreshCleanup = undefined;
  longTaskObserver?.disconnect();
  longTaskObserver = undefined;
  activeDiagnosticsContext = undefined;
  browserMeasurements = {};
  loadInitiatedAt = undefined;
  updateSnapshot(undefined);
  renderDiagnosticsDashboard(undefined);
}

function destroyActiveRuntime(clearDiagnostics = true): void {
  activeRuntimeReady = false;
  unbindPointerFocus();
  if (focusDragPointerId !== undefined) {
    const pointerId = focusDragPointerId;
    focusDragPointerId = undefined;
    if (focusGuideHandle.hasPointerCapture(pointerId)) focusGuideHandle.releasePointerCapture(pointerId);
    activeRuntime?.setFocusDragging(false);
  }
  if (dragFocusFrame !== undefined) cancelAnimationFrame(dragFocusFrame);
  if (dragFocusTimer !== undefined) window.clearTimeout(dragFocusTimer);
  dragFocusFrame = undefined;
  dragFocusTimer = undefined;
  pendingDragCenter = undefined;
  if (focusConfigSyncTimer !== undefined) window.clearTimeout(focusConfigSyncTimer);
  focusConfigSyncTimer = undefined;
  activeRuntime?.destroy();
  activeRuntime = undefined;
  activeRuntimeHost?.remove();
  activeRuntimeHost = undefined;
  if (clearDiagnostics) clearRuntimeObservations();
  updateFocusGuidePosition();
}

function disposeCandidate(runtime: PlaygroundRuntime | undefined, host: HTMLDivElement): void {
  runtime?.destroy();
  host.remove();
}

function releasePendingRuntime(): void {
  const runtime = pendingRuntime;
  const host = pendingRuntimeHost;
  pendingRuntime = undefined;
  pendingRuntimeHost = undefined;
  if (host) disposeCandidate(runtime, host);
}

function renderLoadedMetadata(): void {
  const metadata = activeRuntime?.getMetadata();
  metadataSummary.hidden = appliedSource === undefined;
  byId("metadata-point-count").textContent = metadata && Number.isFinite(metadata.pointCount)
    ? new Intl.NumberFormat("en-US").format(metadata.pointCount)
    : "Not available";
  byId("metadata-point-format").textContent = activePointFormat === undefined
    ? "Not available"
    : String(activePointFormat & 0x3f);
  byId("metadata-bounds").textContent = metadata?.bounds
    ? `X ${metadata.bounds.minX}–${metadata.bounds.maxX}; Y ${metadata.bounds.minY}–${metadata.bounds.maxY}; Z ${metadata.bounds.minZ}–${metadata.bounds.maxZ} (source CRS units)`
    : "Not available";
  byId("metadata-crs").textContent = metadata?.wkt?.trim()
    ? "WKT provided by source"
    : metadata
      ? "Not provided by source"
      : "Not available";
  byId("metadata-backend").textContent = appliedConfig?.backend ?? "Not available";
  byId("metadata-renderer").textContent = appliedConfig?.renderer === "three" ? "Three.js" : appliedConfig?.renderer === "cesium" ? "Cesium" : "Not available";
}

function selectedRemoteSource(): { url: string; name: string } | undefined {
  if (remoteSelect.value === "custom") {
    try {
      const parsed = new URL(customUrlInput.value.trim());
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
      return { url: parsed.href, name: "Custom URL" };
    } catch {
      return undefined;
    }
  }
  if (remoteSelect.value === "chicago") {
    return { url: "https://data.pointcloud.org/chicago-downtown/chicago-downtown.copc.laz", name: "Chicago Downtown" };
  }
  return { url: "https://data.pointcloud.org/autzen/autzen-classified.copc.laz", name: "Autzen Stadium" };
}

function updateRemoteLoadState(): void {
  const selected = selectedRemoteSource();
  const invalidConfiguration =
    validatePlaygroundConfig(pendingConfig).length > 0 ||
    invalidNumericInputs.size > 0;
  const hasMatchingProbe = selected !== undefined &&
    currentProbeResult !== undefined &&
    currentProbeSourceUrl === selected.url &&
    currentProbeGeneration === sourceSelectionGeneration;
  remoteLoadButton.disabled = activeLoadPending || invalidConfiguration || !hasMatchingProbe || !!(hasMatchingProbe && probeFailureReason(currentProbeResult!));
}

const loadSource = async (
  source: PlaygroundSource,
  sourceName: string,
  options: {
    preserveCamera?: boolean;
    selectionGeneration: number;
    probeResult?: CopcSourceProbeResult;
    initiatedAt?: number;
    config?: IntegrationCodeConfig;
  },
): Promise<void> => {
  const requestGeneration = ++loadGeneration;
  releasePendingRuntime();
  const current = () => !disposed && requestGeneration === loadGeneration && options.selectionGeneration === sourceSelectionGeneration;
  if (!current()) return;
  const loadStartedAt = options.initiatedAt ?? performance.now();
  let loadConfig = clonePlaygroundConfig(options.config ?? captureWorkbenchConfig());
  const configurationErrors = [
    ...validatePlaygroundConfig(loadConfig),
    ...invalidNumericInputs.values(),
  ];
  if (configurationErrors.length > 0) {
    setStatus(`Settings must be corrected before loading: ${[...new Set(configurationErrors)].join(" ")}`, "error");
    return;
  }
  const priorRuntime = activeRuntime;
  const priorCamera = options.preserveCamera && priorRuntime?.renderer === loadConfig.renderer
    ? priorRuntime.getCameraState()
    : undefined;
  const capturedInteractionVersion = cameraInteractionVersion;
  const probeResult = options.probeResult;
  const host = document.createElement("div");
  host.className = "runtime-host";
  host.setAttribute("aria-hidden", "true");
  host.style.visibility = "hidden";
  viewport.append(host);
  pendingRuntimeHost = host;
  activeLoadPending = true;
  updateRemoteLoadState();
  updateApplyState();
  setStatus(`Loading ${sourceName}…`, "loading");
  let candidate: PlaygroundRuntime | undefined;
  let candidateDisposed = false;
  const disposeLocalCandidate = (): void => {
    if (candidateDisposed) return;
    candidateDisposed = true;
    disposeCandidate(candidate, host);
  };
  try {
    const pointFormat = source instanceof File ? await getFilePointFormat(source) : probeResult?.pointFormat;
    const rgbUnsupported = pointFormat !== undefined && !knownRgbFormats.has(pointFormat & 0x3f);
    if (rgbUnsupported && loadConfig.colorMode === "rgb") {
      loadConfig = { ...loadConfig, colorMode: "elevation" };
    }
    if (!current()) {
      disposeLocalCandidate();
      return;
    }
    const created = await createPlaygroundRuntime(
      {
        renderer: loadConfig.renderer,
        backend: loadConfig.backend,
        source,
        sourceName,
        colorMode: loadConfig.colorMode,
        pointSize: loadConfig.pointSize,
        maxNodes: loadConfig.maxNodes,
        maxDepth: loadConfig.maxDepth,
        maxScreenSpaceError: loadConfig.maxScreenSpaceError,
        maxRenderDistanceMeters: loadConfig.maxRenderDistanceMeters,
        maxRenderedPoints: loadConfig.maxRenderedPoints,
        maxPointCacheBytes: loadConfig.maxPointCacheBytes,
        refinementAlgorithm: loadConfig.refinementAlgorithm,
        ...(loadConfig.classificationFilter === undefined ? {} : { classificationFilter: loadConfig.classificationFilter }),
        container: host,
        onPointPicked: (point) => { if (activeRuntime === candidate) renderPoint(point); },
        isCurrent: current,
        onLayerLoadStart: () => {},
        onLayerLoadComplete: () => {},
        onError: (message) => { if (candidate && activeRuntime === candidate) setStatus(safeErrorText(message), "error"); },
      },
      layerFactory,
    );
    if (!created) {
      disposeLocalCandidate();
      return;
    }
    candidate = created;
    if (!current()) {
      disposeLocalCandidate();
      return;
    }
    pendingRuntime = candidate;
    pendingRuntimeHost = host;
    const focus = effectiveRefinementFocus(
      loadConfig.refinementConfig.center,
      loadConfig.renderer,
      loadConfig.refinementConfig,
    );
    let committedFocus = focus;
    candidate.setRefinementFocus(focus);
    await candidate.ready;
    if (!current()) {
      disposeLocalCandidate();
      return;
    }

    let committedConfig: IntegrationCodeConfig = {
      ...loadConfig,
      refinementConfig: { ...loadConfig.refinementConfig, center: { ...loadConfig.refinementConfig.center } },
    };
    if (candidate.renderer === "cesium" && pendingConfig.renderer === "cesium") {
      const styleUpdate: CopcCesiumPointStyleUpdate = {};
      if (pendingConfig.colorMode !== loadConfig.colorMode && !(rgbUnsupported && pendingConfig.colorMode === "rgb")) {
        styleUpdate.colorMode = pendingConfig.colorMode;
      }
      if (!sameClassificationFilter(pendingConfig.classificationFilter, loadConfig.classificationFilter)) {
        styleUpdate.classificationFilter = pendingConfig.classificationFilter ?? null;
      }
      if (Object.keys(styleUpdate).length > 0) candidate.setStyle?.(styleUpdate);
      const actualStyle = candidate.getStyle?.();
      if (actualStyle) {
        committedConfig = {
          ...committedConfig,
          colorMode: actualStyle.colorMode,
          classificationFilter: normalizeClassificationFilter(actualStyle.classificationFilter),
        };
      }
      const pendingFocusCenter = pendingConfig.refinementConfig.focusMode === "follow-pointer"
        ? followPointerCenter
        : pendingConfig.refinementConfig.center;
      const pendingFocus = effectiveRefinementFocus(
          pendingFocusCenter,
          "cesium",
          pendingConfig.refinementConfig,
        );
      if (
        JSON.stringify(pendingConfig.refinementConfig) !== JSON.stringify(loadConfig.refinementConfig) ||
        JSON.stringify(pendingFocusCenter) !== JSON.stringify(loadConfig.refinementConfig.center)
      ) {
        candidate.setRefinementFocus(pendingFocus);
        committedFocus = pendingFocus;
        committedConfig = {
          ...committedConfig,
          refinementConfig: {
            ...pendingConfig.refinementConfig,
            algorithm: loadConfig.refinementConfig.algorithm,
            center: { ...pendingConfig.refinementConfig.center },
          },
        };
      }
    }

    const cameraToRestore = priorRuntime?.renderer === candidate.renderer
      ? capturedInteractionVersion === cameraInteractionVersion
        ? priorCamera
        : priorRuntime.getCameraState()
      : undefined;
    const shouldAutoZoom =
      cameraToRestore === undefined &&
      capturedInteractionVersion === cameraInteractionVersion;
    destroyActiveRuntime(true);
    host.style.visibility = "visible";
    host.removeAttribute("aria-hidden");
    activeRuntime = candidate;
    activeRuntimeHost = host;
    candidateDisposed = true;
    pendingRuntime = undefined;
    pendingRuntimeHost = undefined;
    activeRuntimeReady = true;
    activeSourceName = sourceName;
    appliedSource = source;
    activeProbeResult = probeResult;
    activePointFormat = pointFormat;
    if (rgbUnsupported && pendingConfig.colorMode === "rgb") {
      pendingConfig = { ...pendingConfig, colorMode: "elevation" };
    }
    appliedConfig = committedConfig;
    activeDiagnosticsContext = {
      sourceLabel: displaySourceLabel(sourceName, typeof source === "string" ? source : undefined),
      renderer: loadConfig.renderer,
      config: appliedConfig,
      sourceKind: source instanceof File ? "local" : "http",
      ...(source instanceof File ? { sourceSizeBytes: source.size } : probeResult?.contentLength === undefined ? {} : { sourceSizeBytes: probeResult.contentLength }),
      ...(probeResult?.status === undefined ? {} : { sourceHttpStatus: probeResult.status }),
      ...(probeResult?.partialStatus === undefined ? {} : { sourcePartialHttpStatus: probeResult.partialStatus }),
      ...(probeResult ? { corsReadable: probeResult.corsReadable, rangeSupported: probeResult.rangeSupported, copcDetected: probeResult.copcDetected } : {}),
    };
    if (probeResult) {
      byId("diagnostic-range").textContent = describeProbeTruth(probeResult.rangeSupported, "Supported", "Unsupported");
      byId("diagnostic-copc").textContent = describeProbeTruth(probeResult.copcDetected, "Detected", "Not detected");
      byId("diagnostic-validation").textContent = describeValidationLevel(probeResult.validationLevel);
      const warning = byId<HTMLElement>("diagnostic-warning");
      warning.textContent = safeErrorText(probeResult.warnings.join(" "));
      warning.hidden = probeResult.warnings.length === 0;
    } else {
      byId("diagnostic-range").textContent = "Not applicable (local file)";
      byId("diagnostic-copc").textContent = "COPC loaded from local file";
      byId("diagnostic-validation").textContent = "Not applicable (local file)";
      byId<HTMLElement>("diagnostic-warning").hidden = true;
    }
    loadInitiatedAt = loadStartedAt;
    browserMeasurements = { loadElapsedMs: performance.now() - loadStartedAt };
    if (cameraToRestore) candidate.setCameraState(cameraToRestore);
    if (typeof source === "string") {
      exactSourceInput.checked = !isPotentiallySensitiveSource(source);
      shareSourceInput.checked = false;
    } else {
      exactSourceInput.checked = false;
      shareSourceInput.checked = false;
    }
    updateColorChoices(activePointFormat);
    observeBrowserLongTasks(candidate);
    bindPointerFocus(candidate);
    lastAppliedFocusCenter = committedFocus?.center;
    diagnosticsRefreshCleanup = createDiagnosticsRefreshLoop(
      () => activeRuntime,
      (currentRuntime) => {
        if (currentRuntime) refreshSnapshot();
        else { updateSnapshot(undefined); renderDiagnosticsDashboard(undefined); }
      },
    );
    activeLoadPending = false;
    updateRemoteLoadState();
    renderPoint(undefined);
    renderLoadedMetadata();
    syncPendingControls();
    updateApplyState();
    updateIntegrationExample();
    setStatus(`Loaded ${sourceName}`, "ready");
    viewerCaption.textContent = `${loadConfig.renderer === "cesium" ? "Cesium" : "Three.js"} streams visible COPC nodes as the camera moves.`;
    refreshSnapshot();
    if (shouldAutoZoom && candidate.renderer === "cesium" && candidate.zoomTo) {
      void candidate.zoomTo().catch((error: unknown) => {
        if (activeRuntime !== candidate) return;
        setStatus(
          `Loaded ${sourceName}, but camera positioning failed: ${safeErrorText(error)}`,
          "error",
        );
      });
    }
  } catch (error) {
    disposeLocalCandidate();
    if (!current()) return;
    if (pendingRuntime === candidate) {
      pendingRuntime = undefined;
      pendingRuntimeHost = undefined;
    }
    activeLoadPending = false;
    updateRemoteLoadState();
    updateApplyState();
    const reason = safeErrorText(error);
    const browserHint = typeof source === "string"
      ? " Check host CORS and Range support; browser network errors can hide the cause."
      : "";
    setStatus(
      activeRuntime
        ? `Could not load ${sourceName}: ${reason}${browserHint} The previous layer is still active.`
        : `Could not load ${sourceName}: ${reason}${browserHint}`,
      "error",
    );
  }
};

function resetProbeState(message: string): void {
  currentProbeResult = undefined;
  currentProbeSourceUrl = undefined;
  currentProbeGeneration = undefined;
  probeDetails.hidden = true;
  probeWarning.hidden = true;
  probeWarning.textContent = "";
  remoteLoadButton.disabled = true;
  sourceProbe.textContent = message;
}

function invalidateSourceSelection(message = "Source changed. Probe it before loading."): number {
  sourceSelectionGeneration += 1;
  probeGeneration += 1;
  probeController?.abort();
  probeController = undefined;
  loadGeneration += 1;
  releasePendingRuntime();
  activeLoadPending = false;
  probeSourceButton.disabled = false;
  resetProbeState(message);
  if (activeRuntimeReady) setStatus(`Loaded ${activeSourceName}`, "ready");
  else setStatus("Waiting for a source", "unknown");
  updateApplyState();
  return sourceSelectionGeneration;
}

remoteSelect.addEventListener("change", () => {
  invalidateSourceSelection();
  customUrlInput.disabled = remoteSelect.value !== "custom";
  removeSharedSourceParam();
});
customUrlInput.disabled = remoteSelect.value !== "custom";
if (shareSourceFromUrl) {
  remoteSelect.value = "custom";
  customUrlInput.disabled = false;
  customUrlInput.value = shareSourceFromUrl;
  resetProbeState("A safe source URL was restored. Probe it before loading.");
}
customUrlInput.addEventListener("input", () => {
  if (remoteSelect.value === "custom") {
    invalidateSourceSelection();
    removeSharedSourceParam();
  }
});

probeSourceButton.addEventListener("click", async () => {
  const selected = selectedRemoteSource();
  if (!selected) {
    resetProbeState("Enter a valid absolute HTTP or HTTPS URL.");
    return;
  }
  const selection = sourceSelectionGeneration;
  const request = ++probeGeneration;
  probeController?.abort();
  const controller = new AbortController();
  probeController = controller;
  currentProbeResult = undefined;
  currentProbeSourceUrl = undefined;
  currentProbeGeneration = undefined;
  remoteLoadButton.disabled = true;
  probeSourceButton.disabled = true;
  sourceProbe.textContent = "Checking browser access, HTTP Range, and COPC metadata…";
  probeDetails.hidden = true;
  probeWarning.hidden = true;
  try {
    const { probeCopcSource } = await import("@frillab/copc-adapter/cesium");
    const result = await probeCopcSource(selected.url, { signal: controller.signal });
    if (selection !== sourceSelectionGeneration || request !== probeGeneration) return;
    currentProbeResult = result;
    currentProbeSourceUrl = selected.url;
    currentProbeGeneration = selection;
    showProbe(result);
    const failure = probeFailureReason(result);
    if (failure) sourceProbe.textContent = `Probe found an incompatible source. ${failure}`;
    else if (!result.reachable) {
      sourceProbe.textContent = "The browser exposed no HTTP response, so compatibility is unknown. This may be a CORS, network, or host access issue. Retry Probe, or choose Load for an explicit attempt using the package's normal response validation.";
    } else if (result.corsReadable !== true || result.rangeSupported !== true || result.copcDetected !== true) {
      sourceProbe.textContent = "Probe completed with unknown checks. Review the warnings; Load remains an explicit attempt and may still fail.";
    }
    updateRemoteLoadState();
    if (!failure && !activeRuntimeReady) {
      setStatus(
        result.reachable && result.corsReadable === true && result.rangeSupported === true && result.copcDetected === true
          ? "Source probe is ready to load."
          : "Probe checks are unknown; loading is an explicit attempt.",
        "unknown",
      );
    }
  } catch (error) {
    if (selection !== sourceSelectionGeneration || request !== probeGeneration) return;
    const message = safeErrorText(error);
    resetProbeState(`The browser could not complete the probe. CORS or a network error may hide the cause. Check the URL and host policy, then retry. Details: ${message}`);
    if (!activeRuntimeReady) setStatus("Probe failed; no source was loaded.", "error");
  } finally {
    if (probeController === controller) {
      probeController = undefined;
      probeSourceButton.disabled = false;
    }
  }
});

remoteLoadButton.addEventListener("click", () => {
  const selected = selectedRemoteSource();
  const probe = currentProbeResult;
  if (!selected || !probe || currentProbeSourceUrl !== selected.url || currentProbeGeneration !== sourceSelectionGeneration) {
    sourceProbe.textContent = "This source has no current probe result. Probe it before loading.";
    remoteLoadButton.disabled = true;
    return;
  }
  const failure = probeFailureReason(probe);
  if (failure) {
    sourceProbe.textContent = `This source cannot be loaded from the probe result. ${failure}`;
    remoteLoadButton.disabled = true;
    return;
  }
  void loadSource(selected.url, selected.name, {
    selectionGeneration: sourceSelectionGeneration,
    probeResult: probe,
    initiatedAt: performance.now(),
  });
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  fileInput.value = "";
  removeSharedSourceParam();
  const selectionGeneration = invalidateSourceSelection("Local file selected. HTTP CORS and Range checks do not apply.");
  await loadSource(file, file.name, { selectionGeneration, initiatedAt: performance.now() });
});

applyChangesButton.addEventListener("click", () => {
  if (!appliedSource || !appliedConfig || validatePlaygroundConfig(pendingConfig).length > 0 || invalidNumericInputs.size > 0) return;
  void loadSource(appliedSource, activeSourceName, {
    selectionGeneration: sourceSelectionGeneration,
    preserveCamera: true,
    initiatedAt: performance.now(),
    config: captureWorkbenchConfig(),
    probeResult: activeProbeResult,
  });
});

byId<HTMLButtonElement>("reset-defaults").addEventListener("click", () => {
  const resetConfig: IntegrationCodeConfig = {
    ...defaultIntegrationConfig,
    classificationFilter: undefined,
    refinementConfig: { ...defaultIntegrationConfig.refinementConfig, center: { ...defaultIntegrationConfig.refinementConfig.center } },
  };
  invalidNumericInputs.clear();
  updatePendingConfig(resetConfig);
  for (const input of document.querySelectorAll<HTMLInputElement>("input[aria-invalid='true']")) input.removeAttribute("aria-invalid");
  styleError.hidden = true;
  classificationError.hidden = true;
  if (activeRuntime?.renderer === "cesium" && activeRuntimeReady && !activeLoadPending) {
    applyCesiumStyle({ colorMode: resetConfig.colorMode, classificationFilter: null });
    if (appliedConfig) {
      appliedConfig = {
        ...appliedConfig,
        refinementConfig: {
          ...resetConfig.refinementConfig,
          algorithm: appliedConfig.refinementConfig.algorithm,
        },
      };
      activeRuntime.setRefinementFocus(undefined);
      updateIntegrationExample();
    }
  }
  updateApplyState();
  writePendingUrlConfig();
});

codeModeMinimalButton.addEventListener("click", () => {
  codeMode = "minimal";
  updateIntegrationExample();
});
codeModeExplicitButton.addEventListener("click", () => {
  codeMode = "explicit";
  updateIntegrationExample();
});
exactSourceInput.addEventListener("change", updateIntegrationExample);
shareSourceInput.addEventListener("change", () => {
  shareStatus.textContent = shareSourceInput.checked
    ? "The active source URL will be included in the copied share link."
    : "The copied share link will contain settings only.";
});
copyCodeButton.addEventListener("click", async () => {
  const sensitiveSource =
    typeof appliedSource === "string" &&
    isPotentiallySensitiveSource(appliedSource) &&
    exactSourceInput.checked;
  if (
    sensitiveSource &&
    !window.confirm(
      "The visible code contains a URL that may include credentials or tokens. Copy it anyway?",
    )
  ) {
    shareStatus.textContent =
      "Copy cancelled. Switch to the placeholder source to copy without the exact URL.";
    return;
  }
  await copyWithFeedback(
    copyCodeButton,
    codeElement.textContent ?? "",
    "Generated code copied.",
  );
});
copyInstallButton.addEventListener("click", async () => {
  await copyWithFeedback(
    copyInstallButton,
    installCommand.textContent ?? "",
    "Install command copied.",
  );
});
copyShareButton.addEventListener("click", async () => {
  await copyWithFeedback(
    copyShareButton,
    createShareUrl(),
    "Share link copied.",
  );
});

let disposed = false;
const destroyPlayground = (): void => {
  if (disposed) return;
  disposed = true;
  sourceSelectionGeneration += 1;
  probeGeneration += 1;
  probeController?.abort();
  probeController = undefined;
  loadGeneration += 1;
  releasePendingRuntime();
  destroyActiveRuntime();
  focusResizeObserver.disconnect();
  for (const slider of sliders) slider.destroy();
  colorControl.destroy();
  rendererControl.destroy();
  backendControl.destroy();
  cameraControl.destroy();
};
window.addEventListener("pagehide", destroyPlayground, { once: true });
