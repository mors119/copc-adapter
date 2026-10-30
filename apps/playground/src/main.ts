import type {
  CopcCesiumLayer,
  CopcCesiumPointStyle,
  CopcCesiumPointStyleUpdate,
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
  NPM_0_6_CAPABILITIES,
  NPM_0_6_MANIFEST,
  getOptionDefinition,
} from "../../shared/schema/index.ts";
import {
  createWorkbenchConfigurationState,
  getChangedWorkbenchOptionIds,
  normalizeWorkbenchOptionValues,
  transitionRendererOptionValues,
} from "../../shared/config/index.ts";
import { mountSchemaOptionPanel } from "../../shared/workbench/SchemaOptionPanel.ts";
import { renderSharedSpecialControl } from "../../shared/workbench/specialControls.ts";
import {
  mountWorkbenchLayout,
  mountWorkbenchRightTabs,
} from "../../shared/workbench/WorkbenchLayout.ts";
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
  generateIntegrationCode,
  generateIntegrationCodeResult,
  isPotentiallySensitiveSource,
  PLAYGROUND_INSTALL_COMMANDS,
  type IntegrationCodeConfig,
  type IntegrationCodeOptions,
} from "./integrationCode";
import { mountIntegrationCodePanel } from "../../shared/codegen/IntegrationCodePanel.ts";
import {
  mountDiagnosticSections,
  type DiagnosticSectionDefinition,
} from "../../shared/diagnostics/DiagnosticSections.ts";
import { mountPointPopover } from "../../shared/inspection/PointPopover.ts";
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
  clonePlaygroundConfig,
  hasConstructorChanges,
  normalizeClassificationFilter,
  parseClassificationCodes,
  validatePlaygroundConfig,
} from "./playgroundConfig";
import "./style.css";
import "../../shared/workbench/workbench.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("The Playground application root is missing.");

const PLAYGROUND_HEALTH_SECTIONS = [
  {
    id: "playground-health-runtime",
    title: "Runtime status",
    initiallyOpen: true,
    fields: [
      { key: "lifecycle", label: "Layer lifecycle", id: "diagnostic-status" },
      { key: "renderedPoints", label: "Rendered points", id: "diagnostic-points" },
      { key: "renderedNodes", label: "Rendered nodes", id: "diagnostic-nodes" },
      { key: "selectedNodes", label: "Selected nodes", id: "diagnostic-selected" },
      { key: "updateCount", label: "Streaming updates", id: "diagnostic-update-count" },
    ],
  },
  {
    id: "playground-health-range",
    title: "HTTP Range activity",
    fields: [
      { key: "rangeRequests", label: "Range requests", id: "diagnostic-range-requests" },
      { key: "rangeBytes", label: "Transferred bytes, latest update", id: "diagnostic-range-bytes" },
      { key: "rangeDuration", label: "Range duration, latest update", id: "diagnostic-range-duration" },
    ],
  },
  {
    id: "playground-health-processing",
    title: "Processing and browser timings",
    fields: [
      { key: "updateDuration", label: "Update duration, latest update", id: "diagnostic-update-duration" },
      { key: "selectionDuration", label: "Node selection, latest update", id: "diagnostic-selection-duration" },
      { key: "decodeDuration", label: "Decode duration, latest update", id: "diagnostic-decode-duration" },
      { key: "preparationDuration", label: "Point preparation", id: "diagnostic-preparation-duration" },
      { key: "crsDuration", label: "CRS transform", id: "diagnostic-crs-duration" },
      { key: "rendererDuration", label: "Renderer preparation", id: "diagnostic-renderer-duration" },
      { key: "renderInterval", label: "Observed render interval", id: "diagnostic-render-interval" },
      { key: "renderCadence", label: "Approximate observed render cadence", id: "diagnostic-render-cadence" },
      { key: "loadElapsed", label: "Load initiated to adapter completion", id: "diagnostic-load-time" },
      { key: "firstVisible", label: "First points observed", id: "diagnostic-first-visible" },
      { key: "longestLongTask", label: "Longest observed browser Long Task", id: "diagnostic-long-task" },
    ],
  },
  {
    id: "playground-health-resources",
    title: "Cache and workers",
    fields: [
      { key: "cacheBytes", label: "CPU cache bytes", id: "diagnostic-cache-bytes" },
      { key: "cacheBudget", label: "CPU cache budget", id: "diagnostic-cache-budget" },
      { key: "cacheEntries", label: "Cached nodes", id: "diagnostic-cache-entries" },
      { key: "cacheActivity", label: "Cache hits, misses, evictions", id: "diagnostic-cache-hits" },
      { key: "cacheEvictions", label: "Evicted bytes", id: "diagnostic-cache-evictions" },
      { key: "workerSummary", label: "Worker state", id: "diagnostic-worker" },
      { key: "workerDetails", label: "Worker jobs", id: "diagnostic-worker-details" },
    ],
  },
] satisfies readonly DiagnosticSectionDefinition[];

const PLAYGROUND_DATA_SECTIONS = [
  {
    id: "playground-data-hierarchy",
    title: "Hierarchy and coverage",
    initiallyOpen: true,
    fields: [
      { key: "selectedPointCost", label: "Estimated selected points", id: "diagnostic-selected-point-cost" },
      { key: "visibleLevels", label: "Visible levels", id: "diagnostic-lod" },
      { key: "hierarchyRequests", label: "Hierarchy requests", id: "diagnostic-hierarchy-requests" },
      { key: "hierarchyBytes", label: "Hierarchy bytes", id: "diagnostic-hierarchy-bytes" },
      { key: "hierarchyCache", label: "Hierarchy page cache", id: "diagnostic-hierarchy-cache" },
      { key: "transitionSummary", label: "Coverage transitions", id: "diagnostic-transition" },
    ],
  },
  {
    id: "playground-data-refinement",
    title: "Refinement and budget",
    fields: [
      { key: "configuredBudget", label: "Configured point budget", id: "diagnostic-budget" },
      { key: "maxScreenSpaceError", label: "Active maximum screen-space error", id: "diagnostic-sse" },
      { key: "acceptedRefinements", label: "Accepted refinements", id: "diagnostic-accepted-refinements" },
      { key: "rejectedRefinements", label: "Rejected by node / point budget", id: "diagnostic-refinements" },
      { key: "refinementAlgorithm", label: "Refinement algorithm", id: "diagnostic-algorithm" },
      { key: "focusState", label: "Focus Lens", id: "diagnostic-focus" },
      { key: "focusCandidates", label: "Focus candidates", id: "diagnostic-focus-candidates" },
      { key: "focusRefinements", label: "Focus-influenced refinements", id: "diagnostic-focus-refinements" },
    ],
  },
] satisfies readonly DiagnosticSectionDefinition[];

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
      <aside class="side-panel source-panel" id="source-panel" aria-labelledby="source-heading">
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
            <div><dt>CRS units</dt><dd id="metadata-crs-units">Not available</dd></div>
            <div><dt>CRS diagnostic</dt><dd id="metadata-crs-diagnostic">Not available</dd></div>
            <div><dt>Active backend</dt><dd id="metadata-backend">Not available</dd></div>
            <div><dt>Active renderer</dt><dd id="metadata-renderer">Not available</dd></div>
          </dl>
        </section>
      </aside>

      <section class="viewer-column" id="viewer-column" aria-labelledby="viewer-heading">
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

      <aside class="side-panel config-panel" id="config-panel" aria-label="Point cloud controls">
        <div id="shared-schema-controls" class="schema-controls" aria-label="Adapter configuration options"></div>
        <p class="config-state" id="config-state" role="status" aria-live="polite">No layer is active. Settings apply when a source is loaded.</p>
        <section class="config-section classification-controls" aria-labelledby="classification-heading">
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
          <p class="control-error" id="style-error" role="status" aria-live="polite" hidden></p>
        </section>
        <section class="config-section focus-section" aria-labelledby="focus-heading">
          <div class="section-heading"><div><span class="eyebrow">REFINE</span><h2 id="focus-heading">Focus Lens</h2></div></div>
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
        <div class="config-actions">
          <button class="source-load" id="apply-changes" type="button" disabled>Apply changes</button>
          <button id="reset-defaults" type="button">Reset to defaults</button>
        </div>
        <p class="control-error" id="config-validation" role="status" aria-live="polite" hidden></p>
      </aside>
    </main>

    <section class="below-viewer" id="below-viewer" aria-label="Source and point details">
      <section class="diagnostics-card diagnostics-dashboard" aria-label="Runtime health">
        <div class="diagnostics-title-row">
          <div><span class="eyebrow">LIVE</span><h2>Runtime health</h2></div>
          <span class="summary-state" id="diagnostic-summary" aria-live="polite">Waiting for a source</span>
        </div>
        <p class="diagnostic-context" id="diagnostic-context">Load a source to see active configuration and measurements.</p>
        <div id="diagnostic-health-content"></div>
      </section>
      <div id="generated-code-card-mount"></div>
    </section>
    <footer class="statusbar"><span id="footer-status">Ready · No source loaded</span><span>Client-side · No upload</span></footer>
  </div>
`;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing Playground element #${id}.`);
  return element as T;
};

const integrationCodePanel = mountIntegrationCodePanel({
  target: byId<HTMLElement>("generated-code-card-mount"),
  summary: "Public API · v" + __ADAPTER_VERSION__,
  intro: "Copy a runnable starting point for the last successfully applied Playground settings.",
  createShareLink: (includeSource) => createShareUrl(includeSource),
  onStateChange: () => updateIntegrationExample(),
});

const playgroundShell = app.querySelector<HTMLElement>(".playground-shell")!;
const oldWorkbench = app.querySelector<HTMLElement>(".workbench")!;
const belowViewer = byId<HTMLElement>("below-viewer");
const sourcePanel = byId<HTMLElement>("source-panel");
const viewerColumn = byId<HTMLElement>("viewer-column");
const configPanel = byId<HTMLElement>("config-panel");
const workbenchLeft = document.createElement("aside");
workbenchLeft.id = "workbench-controls";
const workbenchRight = document.createElement("aside");
workbenchRight.id = "workbench-details";
workbenchRight.setAttribute("aria-label", "Workbench details");
const codeTabPanel = document.createElement("section");
const sourceTabPanel = document.createElement("section");
const healthTabPanel = document.createElement("section");
const dataTabPanel = document.createElement("section");
const generatedCodeCard = belowViewer.querySelector<HTMLElement>(".generated-code-card")!;
const diagnosticCard = belowViewer.querySelector<HTMLElement>(".diagnostics-dashboard")!;
const dataDiagnosticsCard = document.createElement("section");
dataDiagnosticsCard.className = "diagnostics-card";
dataDiagnosticsCard.setAttribute("aria-label", "Dataset and streaming analysis");
codeTabPanel.append(generatedCodeCard);
sourceTabPanel.append(
  byId("source-status"),
  byId("source-probe"),
  byId("source-probe-details"),
  byId("source-probe-warning"),
  byId("metadata-summary"),
);
workbenchLeft.append(sourcePanel, configPanel);
healthTabPanel.append(diagnosticCard);
dataTabPanel.append(dataDiagnosticsCard);
const healthDiagnostics = mountDiagnosticSections(
  diagnosticCard.querySelector<HTMLElement>("#diagnostic-health-content")!,
  PLAYGROUND_HEALTH_SECTIONS,
  { sectionClassName: "diagnostic-details" },
);
const dataDiagnostics = mountDiagnosticSections(
  dataDiagnosticsCard,
  PLAYGROUND_DATA_SECTIONS,
  { sectionClassName: "diagnostic-details" },
);
const rightTabs = mountWorkbenchRightTabs({
  target: workbenchRight,
  tabs: [
    { tab: "code", label: "Code", panel: codeTabPanel },
    { tab: "source", label: "Source", panel: sourceTabPanel },
    { tab: "health", label: "Health", panel: healthTabPanel },
    { tab: "data", label: "Data", panel: dataTabPanel },
  ],
});
const workbenchStatus = byId<HTMLElement>("footer-status").closest<HTMLElement>("footer")!;
const workbenchLayout = mountWorkbenchLayout({
  root: playgroundShell,
  provenance: `${__ADAPTER_SOURCE__} ${__ADAPTER_VERSION__} / Playground`,
  provenanceId: "package-source",
  leftPanel: workbenchLeft,
  viewport: viewerColumn,
  rightPanel: workbenchRight,
  status: workbenchStatus,
  leftLabel: "Configuration",
  rightLabel: "Workbench details",
});
oldWorkbench.remove();
belowViewer.remove();

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
const pointPopover = mountPointPopover(viewerFrame);
const focusGuide = byId<HTMLDivElement>("focus-guide");
const focusGuideHandle = byId<HTMLButtonElement>("focus-guide-handle");
const focusModeSelect = byId<HTMLSelectElement>("focus-mode");
const focusEnabledInput = byId<HTMLInputElement>("focus-enabled");
const focusShowGuideInput = byId<HTMLInputElement>("focus-show-guide");
const focusXInput = byId<HTMLInputElement>("focus-x");
const focusYInput = byId<HTMLInputElement>("focus-y");
const focusPositionControls = byId<HTMLDivElement>("focus-position-controls");
const focusConfigWarning = byId<HTMLElement>("focus-config-warning");
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
if (parsedUrlConfig.warning) integrationCodePanel.setStatus(parsedUrlConfig.warning);
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
let appliedCodeRevision = 0;
let appliedCodeAt: number | undefined;
let lastAppliedCodeValues: Readonly<Record<string, unknown>> | undefined;
let activeProbeResult: CopcSourceProbeResult | undefined;
let currentProbeSourceUrl: string | undefined;
let currentProbeGeneration: number | undefined;
let currentProbeResult: CopcSourceProbeResult | undefined;
let activePointFormat: number | undefined;
let cameraInteractionVersion = 0;
let layerFactory: CesiumLayerFactory | undefined;
let schemaPanel: ReturnType<typeof mountSchemaOptionPanel> | undefined;
const inactiveRendererOptionValues = new Map<
  string,
  { readonly value: unknown; readonly schemaOnly: boolean }
>();

function playgroundOptionValues(
  config: IntegrationCodeConfig,
): Record<string, unknown> {
  return normalizeWorkbenchOptionValues({
    ...(config as unknown as Readonly<Record<string, unknown>>),
    ...(config.schemaOptionValues ?? {}),
  });
}

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
      getMockLayerSettings(): {
        readonly rangeValidation?: string;
        readonly streaming?: {
          readonly motionLookahead?: boolean;
          readonly predictivePrefetch?: boolean;
        };
      } | undefined;
      getMockBackendExtraDimensions(): unknown;
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
  let mockLayerSettings:
    | {
        rangeValidation?: string;
        streaming?: {
          motionLookahead?: boolean;
          predictivePrefetch?: boolean;
        };
      }
    | undefined;
  let mockBackendExtraDimensions: unknown;
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
        mockLayerSettings = {
          rangeValidation: options.rangeValidation,
          streaming: {
            motionLookahead: options.streaming?.motionLookahead,
            predictivePrefetch: options.streaming?.predictivePrefetch,
          },
        };
        const configuredBackend = options.backend;
        mockBackendExtraDimensions =
          typeof configuredBackend === "object" && configuredBackend !== null
            ? (configuredBackend as unknown as { extraDimensions?: unknown }).extraDimensions
            : undefined;
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
    getMockLayerSettings: () =>
      mockLayerSettings ? structuredClone(mockLayerSettings) : undefined,
    getMockBackendExtraDimensions: () => mockBackendExtraDimensions,
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
  schemaPanel?.setChoices("rendering.colorMode", choices);
  if (formatKnown && !rgbSupported && pendingConfig.colorMode === "rgb") {
    updatePendingConfig({ colorMode: "elevation" });
  }
};

function handleSchemaOptionChange(optionId: string, value: unknown): void {
  if (optionId === "renderer.engine") {
    const renderer = value as PlaygroundRenderer;
    const schemaOptionValues = { ...(pendingConfig.schemaOptionValues ?? {}) };
    const optionValues = {
      ...playgroundOptionValues(pendingConfig),
      "renderer.engine": renderer,
    };
    transitionRendererOptionValues(
      optionValues,
      schemaOptionValues,
      pendingConfig.renderer,
      renderer,
      inactiveRendererOptionValues,
      {
        support: {
          manifest: NPM_0_6_MANIFEST,
          runtimeCapabilities: NPM_0_6_CAPABILITIES,
        },
      },
    );
    updatePendingConfig({ renderer, schemaOptionValues });
    syncRendererLabels();
    if (
      renderer === "cesium" &&
      activeRuntimeReady &&
      !activeLoadPending &&
      activeRuntime?.renderer === "cesium" &&
      appliedConfig &&
      pendingConfig.colorMode !== appliedConfig.colorMode
    ) {
      if (!applyCesiumStyle({ colorMode: pendingConfig.colorMode })) {
        pendingConfig = { ...pendingConfig, colorMode: appliedConfig.colorMode };
        schemaPanel?.update({
          values: playgroundOptionValues(pendingConfig),
          context: { renderer: pendingConfig.renderer },
        });
        writePendingUrlConfig();
        updateApplyState();
        updateIntegrationExample();
      }
    }
    return;
  }
  if (optionId === "adapter.backend") {
    updatePendingConfig({ backend: value as PlaygroundBackend });
    syncRendererLabels();
    return;
  }
  if (optionId === "rendering.colorMode") {
    const colorMode = value as PlaygroundColorMode;
    const activeCesium =
      activeRuntimeReady &&
      !activeLoadPending &&
      activeRuntime?.renderer === "cesium" &&
      appliedConfig?.renderer === "cesium" &&
      pendingConfig.renderer === "cesium";
    if (activeCesium && !applyCesiumStyle({ colorMode })) {
      schemaPanel?.update({ values: playgroundOptionValues(pendingConfig) });
      return;
    }
    if (!activeCesium || activeLoadPending) updatePendingConfig({ colorMode });
    return;
  }
  if (optionId === "streaming.refinementAlgorithm") {
    updatePendingConfig({
      refinementAlgorithm: value as PlaygroundUrlConfig["refinementAlgorithm"],
    });
    return;
  }

  const definition = getOptionDefinition(optionId);
  const stateField = definition?.statePath.split(".").at(-1);
  if (stateField && Object.hasOwn(pendingConfig, stateField)) {
    updatePendingConfig({ [stateField]: value } as Partial<IntegrationCodeConfig>);
    return;
  }
  updatePendingConfig({
    schemaOptionValues: {
      ...(pendingConfig.schemaOptionValues ?? {}),
      [optionId]: value,
    },
  });
}

schemaPanel = mountSchemaOptionPanel({
  target: byId("shared-schema-controls"),
  context: {
    manifest: NPM_0_6_MANIFEST,
    renderer: pendingConfig.renderer,
    runtimeCapabilities: NPM_0_6_CAPABILITIES,
  },
  values: playgroundOptionValues(pendingConfig),
  excludeOptionIds: [
    "source.url",
    "style.classificationFilter",
    "streaming.refinementFocus",
    "rendering.cesiumPointRenderer",
    "coordinates.verticalTransform",
  ],
  renderSpecialControl: renderSharedSpecialControl,
  onChange: handleSchemaOptionChange,
  onValidationChange() {
    updateApplyState();
    updateRemoteLoadState();
    updateIntegrationExample();
  },
});
updateColorChoices();

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

const invalidNumericInputs = new Map<string, string>();

function syncPendingControls(): void {
  schemaPanel?.update({
    values: playgroundOptionValues(pendingConfig),
    context: { renderer: pendingConfig.renderer },
  });
  refinementConfig = pendingConfig.refinementConfig;
  updateFocusControls();
  updateClassificationControls();
}

function updateApplyState(): void {
  const configErrors = validatePlaygroundConfig(pendingConfig);
  const errors = [
    ...invalidNumericInputs.values(),
    ...configErrors,
    ...(schemaPanel?.getValidationErrors() ?? []),
  ];
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
  updateIntegrationExample();
}

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
      ...(update.colorMode === undefined
        ? {}
        : { colorMode: style.colorMode }),
      ...(update.classificationFilter === undefined
        ? {}
        : { classificationFilter }),
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
    updateIntegrationExample();
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

function updateIntegrationExample(): void {
  const config = appliedConfig;
  if (!config || !activeRuntimeReady || appliedSource === undefined) {
    integrationCodePanel.setContent({
      code: "",
      warnings: ["Load a source successfully before copying code for applied settings."],
      source: appliedSource,
    });
    return;
  }
  const valuesForCode = (sourceConfig: IntegrationCodeConfig): Record<string, unknown> => {
    const values = playgroundOptionValues(sourceConfig);
    values["source.url"] = appliedSource;
    const focus = effectiveRefinementFocus(
      sourceConfig.refinementConfig.center,
      sourceConfig.renderer,
      sourceConfig.refinementConfig,
    );
    if (focus) values["streaming.refinementFocus"] = focus;
    else delete values["streaming.refinementFocus"];
    return values;
  };
  const appliedValues = valuesForCode(config);
  if (
    lastAppliedCodeValues === undefined ||
    getChangedWorkbenchOptionIds(lastAppliedCodeValues, appliedValues).length > 0
  ) {
    appliedCodeRevision += 1;
    appliedCodeAt = Date.now();
    lastAppliedCodeValues = createWorkbenchConfigurationState(
      appliedValues,
      appliedValues,
    ).applied;
  }
  const pendingValues = valuesForCode(pendingConfig);
  const appliedState = {
    ...createWorkbenchConfigurationState(pendingValues, appliedValues),
    appliedRevision: appliedCodeRevision,
    pendingRevision: appliedCodeRevision,
  };
  const panelState = integrationCodePanel.getState();
  try {
    const generated = generateIntegrationCodeResult({
      config,
      includeExactSource: panelState.includeExactSource,
      mode: panelState.mode,
      adapterVersion: __ADAPTER_VERSION__,
      appliedState,
      ...(appliedCodeAt === undefined ? {} : { appliedAt: appliedCodeAt }),
    });
    const appliedStatus = "appliedRevision" in generated
      ? {
          revision: generated.appliedRevision,
          pendingChanges: generated.pendingChanges || activeLoadPending ||
            invalidNumericInputs.size > 0 ||
            (schemaPanel?.getValidationErrors().length ?? 0) > 0,
          ...(generated.appliedAt === undefined ? {} : { appliedAt: generated.appliedAt }),
        }
      : undefined;
    integrationCodePanel.setContent({
      code: generated.code,
      warnings: generated.warnings,
      source: appliedSource,
      sensitiveSourceIncluded: typeof appliedSource === "string" &&
        isPotentiallySensitiveSource(appliedSource) && panelState.includeExactSource,
      installCommand: PLAYGROUND_INSTALL_COMMANDS[config.renderer],
      ...(appliedStatus ? { appliedStatus } : {}),
    });
  } catch (error) {
    integrationCodePanel.setContent({
      code: "",
      warnings: [error instanceof Error ? error.message : "Integration code could not be generated."],
      source: appliedSource,
      installCommand: PLAYGROUND_INSTALL_COMMANDS[config.renderer],
    });
  }
}

function createShareUrl(includeSource = integrationCodePanel.getState().includeShareSource): string {
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
    includeSource && typeof appliedSource === "string"
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
  const summary = byId<HTMLElement>("diagnostic-summary");
  const contextElement = byId<HTMLElement>("diagnostic-context");
  if (!context) {
    contextElement.textContent =
      "Load a source to see active configuration and measurements.";
    summary.textContent = "Waiting for a source";
    healthDiagnostics.update({});
    dataDiagnostics.update({});
    return;
  }

  const model = createDiagnosticsViewModel(
    diagnostics,
    context,
    browserMeasurements,
  );
  contextElement.textContent = model.context;
  summary.textContent = model.lifecycle;
  healthDiagnostics.update({
    lifecycle: model.lifecycle,
    renderedPoints: model.renderedPoints,
    renderedNodes: model.renderedNodes,
    selectedNodes: model.selectedNodes,
    updateCount: model.updateCount,
    rangeRequests: model.rangeRequests,
    rangeBytes: model.rangeBytesLatestUpdate,
    rangeDuration: model.rangeDuration,
    updateDuration: model.updateDuration,
    selectionDuration: model.selectionDuration,
    decodeDuration: model.decodeDuration,
    preparationDuration: model.preparationDuration,
    crsDuration: model.crsDuration,
    rendererDuration: model.rendererDuration,
    renderInterval: model.renderInterval,
    renderCadence: model.approximateRenderCadence,
    loadElapsed: model.loadElapsed,
    firstVisible: model.firstVisiblePoints,
    longestLongTask: model.longestLongTask,
    cacheBytes: model.cacheBytes,
    cacheBudget: model.cacheBudget,
    cacheEntries: model.cacheEntries,
    cacheActivity: `${model.cacheHits} hits · ${model.cacheMisses} misses · ${model.cacheEvictions} evictions`,
    cacheEvictions: model.cacheBytesEvicted,
    workerSummary: model.workerSummary,
    workerDetails: model.workerDetails,
  });

  dataDiagnostics.update({
    selectedPointCost: model.selectedPointCost,
    visibleLevels: model.visibleLevels,
    hierarchyRequests: model.hierarchyRequests,
    hierarchyBytes: model.hierarchyBytes,
    hierarchyCache: model.hierarchyCache,
    transitionSummary: model.transitionSummary,
    configuredBudget: model.configuredBudget,
    maxScreenSpaceError: model.maxScreenSpaceError,
    acceptedRefinements: model.acceptedRefinements,
    refinementAlgorithm: model.refinementAlgorithm,
    focusState: model.focusState,
    focusCandidates: model.focusCandidates,
    focusRefinements: model.focusRefinements,
  });
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
  pointPopover.clear();
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

type PlaygroundCrsMetadataView = {
  readonly wkt: { readonly format: string; readonly metadataSupport: string };
  readonly horizontal: {
    readonly units: { readonly name?: string; readonly kind: string };
    readonly identity?: {
      readonly authority?: string;
      readonly code?: string;
      readonly name: string;
    };
  };
  readonly vertical: {
    readonly units: { readonly name?: string; readonly kind: string };
    readonly heightKind: { readonly value: string; readonly certainty: string };
  };
  readonly reasons: readonly { readonly code: string; readonly message: string }[];
};

function renderLoadedMetadata(): void {
  const metadata = activeRuntime?.getMetadata();
  // Pages intentionally pins its released package; this structural view lets
  // the UI show the optional workspace diagnostic after that release includes it.
  const crsDiagnostic = metadata
    ? (metadata as typeof metadata & { crsDiagnostic?: PlaygroundCrsMetadataView })
        .crsDiagnostic
    : undefined;
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
    ? crsDiagnostic
      ? [
          crsDiagnostic.horizontal.identity?.authority && crsDiagnostic.horizontal.identity.code
            ? `${crsDiagnostic.horizontal.identity.authority}:${crsDiagnostic.horizontal.identity.code}`
            : crsDiagnostic.horizontal.identity?.name ?? "Horizontal CRS unknown",
          `height ${crsDiagnostic.vertical.heightKind.value} (${crsDiagnostic.vertical.heightKind.certainty})`,
          `${crsDiagnostic.wkt.format} metadata ${crsDiagnostic.wkt.metadataSupport}`,
        ].join(" · ")
      : "WKT provided by source"
    : metadata
      ? "Not provided by source"
      : "Not available";
  byId("metadata-crs-units").textContent = crsDiagnostic
    ? `Horizontal ${crsDiagnostic.horizontal.units.name ?? "unknown"} (${crsDiagnostic.horizontal.units.kind}); vertical ${crsDiagnostic.vertical.units.name ?? "unknown"} (${crsDiagnostic.vertical.units.kind})`
    : "Not available";
  byId("metadata-crs-diagnostic").textContent = crsDiagnostic
    ? crsDiagnostic.reasons.length > 0
      ? crsDiagnostic.reasons.map((reason) => `${reason.code}: ${reason.message}`).join(" ")
      : "No CRS metadata issues reported. Transform support is backend-dependent."
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
    invalidNumericInputs.size > 0 ||
    (schemaPanel?.getValidationErrors().length ?? 0) > 0;
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
    ...(schemaPanel?.getValidationErrors() ?? []),
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
        schemaOptionValues: loadConfig.schemaOptionValues,
        ...(loadConfig.classificationFilter === undefined ? {} : { classificationFilter: loadConfig.classificationFilter }),
        container: host,
        onPointPicked: (point) => {
          if (activeRuntime === candidate) pointPopover.setSelection(point);
        },
        onPointPositionChanged: (position) => {
          if (activeRuntime === candidate)
            pointPopover.updatePosition(position);
        },
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
    loadInitiatedAt = loadStartedAt;
    browserMeasurements = { loadElapsedMs: performance.now() - loadStartedAt };
    if (cameraToRestore) candidate.setCameraState(cameraToRestore);
    integrationCodePanel.setSourcePrivacySelection(
      source,
      typeof source === "string" && !isPotentiallySensitiveSource(source),
    );
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
    schemaOptionValues: {},
    classificationFilter: undefined,
    refinementConfig: { ...defaultIntegrationConfig.refinementConfig, center: { ...defaultIntegrationConfig.refinementConfig.center } },
  };
  invalidNumericInputs.clear();
  inactiveRendererOptionValues.clear();
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
        },
      };
      activeRuntime.setRefinementFocus(undefined);
      updateIntegrationExample();
    }
  }
  updateApplyState();
  writePendingUrlConfig();
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
  pointPopover.destroy();
  focusResizeObserver.disconnect();
  focusRadiusSlider.destroy();
  focusBiasSlider.destroy();
  schemaPanel?.destroy();
  integrationCodePanel.destroy();
  rightTabs.destroy();
  workbenchLayout.destroy();
  cameraControl.destroy();
};
window.addEventListener("pagehide", destroyPlayground, { once: true });
