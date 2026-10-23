import type {
  CopcCesiumLayer,
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
  workbenchBackendOptions,
  workbenchRendererOptions,
  type WorkbenchLayerConfig,
} from "../../shared/workbench-config";
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
  readPlaygroundRefinementConfig,
  refinementAlgorithmOptions,
  writePlaygroundRefinementConfig,
  type PlaygroundFocusMode,
  type PlaygroundRefinementConfig,
} from "./refinementConfig";
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
          <div><dt>Refinement algorithm</dt><dd id="diagnostic-algorithm">Foveated</dd></div>
          <div><dt>Focus lens</dt><dd id="diagnostic-focus">Inactive</dd></div>
          <div><dt>Focus candidates</dt><dd id="diagnostic-focus-candidates">0</dd></div>
          <div><dt>Focus-influenced refinements</dt><dd id="diagnostic-focus-refinements">0</dd></div>
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

const viewport = byId<HTMLDivElement>("cesium-container");
const sourceStatus = byId<HTMLElement>("source-status");
const sourceProbe = byId<HTMLElement>("source-probe");
const remoteSelect = byId<HTMLSelectElement>("remote-source");
const customUrlInput = byId<HTMLInputElement>("custom-url");
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

let renderer: PlaygroundRenderer = "cesium";
let backend: PlaygroundBackend = "copc-js";
let colorMode: PlaygroundColorMode = "elevation";
let pointSize = 3;
let maxNodes = 24;
let maxRenderedPoints = 250_000;
const parsedRefinementConfig = readPlaygroundRefinementConfig(
  new URLSearchParams(window.location.search),
);
let refinementConfig: PlaygroundRefinementConfig =
  parsedRefinementConfig.config;
let followPointerCenter = { ...refinementConfig.center };
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
let sourceGeneration = 0;
let activeLoadPending = false;
let activeSource: PlaygroundSource | undefined;
let activeSourceName = "";
let activeRuntime: PlaygroundRuntime | undefined;
let activeRuntimeReady = false;
type AppliedPlaygroundConfig = WorkbenchLayerConfig & {
  readonly renderer: PlaygroundRenderer;
  readonly refinementConfig: PlaygroundRefinementConfig;
};
const defaultIntegrationConfig: AppliedPlaygroundConfig = {
  renderer: "cesium",
  backend: "copc-js",
  colorMode: "elevation",
  pointSize: 3,
  maxNodes: 24,
  maxRenderedPoints: 250_000,
  refinementAlgorithm: "foveated",
  refinementConfig: {
    ...defaultPlaygroundRefinementConfig,
    center: { ...defaultPlaygroundRefinementConfig.center },
  },
};
let appliedConfig: AppliedPlaygroundConfig | undefined;
let activeProbeResult: CopcSourceProbeResult | undefined;
let cameraInteractionVersion = 0;
let layerFactory: CesiumLayerFactory | undefined;
let refreshTimer: number | undefined;

function captureWorkbenchConfig(): AppliedPlaygroundConfig {
  return {
    renderer,
    backend,
    colorMode,
    pointSize,
    maxNodes,
    maxRenderedPoints,
    refinementAlgorithm: refinementConfig.algorithm,
    refinementConfig: {
      ...refinementConfig,
      center: { ...refinementConfig.center },
    },
  };
}

for (const option of refinementAlgorithmOptions) {
  algorithmSelect.add(new Option(option.label, option.value));
}
algorithmSelect.value = refinementConfig.algorithm;
focusModeSelect.value = refinementConfig.focusMode;
focusEnabledInput.checked = refinementConfig.focusEnabled;
focusShowGuideInput.checked = refinementConfig.showGuide;
focusXInput.value = String(refinementConfig.center.x);
focusYInput.value = String(refinementConfig.center.y);
if (parsedRefinementConfig.warning) {
  focusConfigWarning.textContent = parsedRefinementConfig.warning;
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
      failNextLoad(): void;
      releaseDelayedLoad(): void;
      getMockDestroyCount(): number;
      getMockZoomCount(): number;
      setCameraView(view: PlaygroundTestCameraView): void;
      getCameraView(): PlaygroundTestCameraView;
      getMockLoadCount(): number;
      getPickablePointScreenPosition(): { x: number; y: number } | undefined;
      getMockLayerCreateCount(): number;
      getMockRefinementAlgorithm(): RefinementAlgorithm | undefined;
      getMockFocusUpdateCount(): number;
      getMockRefinementFocus(): RefinementFocus | undefined;
      getSnapshot(): PlaygroundSnapshot | undefined;
      getCameraInputsEnabled(): boolean | undefined;
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
  let failNextMockLoad = false;
  let releaseMockLoad: (() => void) | undefined;
  window.__COPC_PLAYGROUND_TEST__ = {
    useCameraResetLayerMock(): void {
      layerFactory = (options) => {
        mockLayerCreateCount += 1;
        mockRefinementAlgorithm = options.streaming?.refinementAlgorithm;
        mockRefinementFocus = undefined;
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
          zoomTo(): Promise<boolean> {
            mockZoomCount += 1;
            activeRuntime?.setCameraState({
              longitude: -12,
              latitude: 24,
              height: 19_000_000,
              heading: 0,
              pitch: -90,
              roll: 0,
            });
            return Promise.resolve(true);
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
          get boundingSphere(): undefined {
            return undefined;
          },
        } as unknown as ReturnType<CesiumLayerFactory>;
      };
    },
    delayNextLoad(): void {
      delayNextMockLoad = true;
    },
    failNextLoad(): void {
      failNextMockLoad = true;
    },
    releaseDelayedLoad(): void {
      releaseMockLoad?.();
      releaseMockLoad = undefined;
    },
    getMockLoadCount: () => mockLoadCount,
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
    value: colorMode,
    className: "color-segments",
    choices: [],
    onChange: (value) => {
      colorMode = value;
      byId("point-empty").textContent =
        "Click a point in the viewport to inspect its available attributes.";
      reloadActiveSource();
    },
  },
);

const updateColorChoices = (pointFormat?: number): void => {
  const rgbSupported =
    pointFormat !== undefined && knownRgbFormats.has(pointFormat & 0x3f);
  const choices: readonly UiSegmentOption<PlaygroundColorMode>[] = [
    { value: "elevation", label: "Elevation" },
    { value: "intensity", label: "Intensity" },
    { value: "classification", label: "Classification" },
    {
      value: "rgb",
      label: "RGB",
      disabled: !rgbSupported,
      title: rgbSupported
        ? undefined
        : "This dataset format does not advertise RGB channels.",
    },
  ];
  colorControl.setOptions(choices);
  if (colorMode === "rgb" && !rgbSupported) {
    colorMode = "elevation";
    colorControl.setValue(colorMode);
  }
};
updateColorChoices();

const rendererControl = mountSegmentedControl<PlaygroundRenderer>(
  byId("renderer-control"),
  {
    label: "Renderer",
    value: renderer,
    choices: workbenchRendererOptions,
    onChange: (value) => {
      renderer = value;
      syncRendererLabels();
      reloadActiveSource();
    },
  },
);

const backendControl = mountSegmentedControl<PlaygroundBackend>(
  byId("backend-control"),
  {
    label: "COPC backend",
    value: backend,
    choices: workbenchBackendOptions,
    onChange: (value) => {
      backend = value;
      syncRendererLabels();
      reloadActiveSource();
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
    value: pointSize,
    formatValue: (value) => `${formatUiNumber(value)} px`,
    onCommit(value) {
      pointSize = value;
      reloadActiveSource();
    },
  }),
  mountSlider(byId("max-nodes-control"), {
    id: "max-nodes",
    label: "Max selected nodes",
    min: 1,
    max: 48,
    step: 1,
    value: maxNodes,
    formatValue: formatUiNumber,
    onCommit(value) {
      maxNodes = value;
      reloadActiveSource();
    },
  }),
  mountSlider(byId("max-points-control"), {
    id: "max-points",
    label: "Max rendered points",
    min: 50_000,
    max: 1_000_000,
    step: 50_000,
    value: maxRenderedPoints,
    formatValue: (value) => formatUiNumber(value),
    onCommit(value) {
      maxRenderedPoints = value;
      reloadActiveSource();
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

function effectiveRefinementFocus(
  center = refinementConfig.focusMode === "follow-pointer"
    ? followPointerCenter
    : refinementConfig.center,
  activeRenderer = renderer,
  config = refinementConfig,
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
  const config = appliedConfig ?? defaultIntegrationConfig;
  const focusConfig = config.refinementConfig;
  const algorithmLine = `streaming: { maxNodes: ${config.maxNodes}, refinementAlgorithm: '${config.refinementAlgorithm}' },`;
  const focus = effectiveRefinementFocus(
    focusConfig.center,
    config.renderer,
    focusConfig,
  );
  const modeComment =
    focusConfig.focusMode === "follow-pointer"
      ? "// Playground focus mode: follow-pointer. Update center from this canvas’s normalized pointer coordinates."
      : focusConfig.focusMode === "pinned"
        ? "// Playground focus mode: pinned."
        : focusConfig.focusMode === "center-boost"
          ? "// Playground focus mode: center-boost."
          : "// Playground focus mode: auto-center; no manual focus is active.";
  const focusLine = focus
    ? `${modeComment}\nlayer.setRefinementFocus({ type: 'screen-circle', center: { x: ${focus.center.x.toFixed(4)}, y: ${focus.center.y.toFixed(4)} }, radius: ${focus.radius.toFixed(4)}, detailBias: ${focus.detailBias.toFixed(2)} });`
    : `${modeComment}\n// Focus Lens is disabled in the Playground.`;
  byId<HTMLElement>("integration-example").textContent =
    config.renderer === "cesium"
      ? `const layer = new CopcCesiumLayer({ url: copcUrl, backend: '${config.backend}',\n  ${algorithmLine}\n});\nawait layer.load();\nlayer.attachTo(viewer);\n${focusLine}`
      : `const layer = new CopcThreeLayer({ url: copcUrl, backend: '${config.backend}',\n  ${algorithmLine}\n});\nlayer.attachTo({ scene, camera, renderer });\nawait layer.load();\n${modeComment}`;
}

function updateFocusControls(): void {
  algorithmSelect.value = refinementConfig.algorithm;
  focusModeSelect.value = refinementConfig.focusMode;
  focusEnabledInput.checked = refinementConfig.focusEnabled;
  focusShowGuideInput.checked = refinementConfig.showGuide;
  focusEnabledInput.disabled =
    renderer !== "cesium" || refinementConfig.focusMode === "auto-center";
  focusShowGuideInput.disabled = renderer !== "cesium";
  focusModeSelect.disabled = renderer !== "cesium";
  focusRadiusSlider.setDisabled(
    renderer !== "cesium" || refinementConfig.focusMode === "auto-center",
  );
  focusBiasSlider.setDisabled(
    renderer !== "cesium" || refinementConfig.focusMode === "auto-center",
  );
  focusRadiusSlider.setValue(refinementConfig.radius * 100);
  focusBiasSlider.setValue(refinementConfig.detailBias);

  const positionEditable =
    renderer === "cesium" &&
    refinementConfig.focusMode !== "auto-center" &&
    refinementConfig.focusMode !== "follow-pointer";
  focusPositionControls.hidden = !positionEditable;
  focusXInput.disabled = !positionEditable;
  focusYInput.disabled = !positionEditable;
  focusXInput.value = String(refinementConfig.center.x);
  focusYInput.value = String(refinementConfig.center.y);
  byId<HTMLButtonElement>("focus-reset").disabled = !positionEditable;

  const focusAvailable = renderer === "cesium";
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

function writeRefinementUrl(): void {
  const params = writePlaygroundRefinementConfig(
    new URLSearchParams(window.location.search),
    refinementConfig,
  );
  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState(window.history.state, "", nextUrl);
  focusConfigWarning.hidden = true;
}

function applyFocusSettings(syncUrl = true): void {
  updateFocusControls();
  const focus = effectiveRefinementFocus();
  activeRuntime?.setRefinementFocus(focus);
  lastAppliedFocusCenter = focus?.center;
  if (activeRuntime && activeRuntimeReady && appliedConfig) {
    appliedConfig = {
      ...appliedConfig,
      refinementConfig: {
        ...refinementConfig,
        center: { ...refinementConfig.center },
      },
    };
  }
  if (syncUrl) writeRefinementUrl();
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
    renderer !== "cesium" ||
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
  applyFocusSettings(false);
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
  writeRefinementUrl();
}

function onFocusGuidePointerDown(event: PointerEvent): void {
  if (
    focusGuide.hidden ||
    refinementConfig.focusMode === "follow-pointer" ||
    renderer !== "cesium"
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
    writeRefinementUrl();
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
  const label = renderer === "cesium" ? "Cesium" : "Three.js";
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
  const points = snapshot?.renderedPoints ?? 0;
  const nodes = snapshot?.renderedNodes ?? 0;
  const selected = snapshot?.selectedNodes ?? 0;
  byId("hud-points").textContent = formatUiNumber(points);
  byId("hud-nodes").textContent = formatUiNumber(nodes);
  byId("diagnostic-points").textContent = formatUiNumber(points);
  byId("diagnostic-nodes").textContent = formatUiNumber(nodes);
  byId("diagnostic-selected").textContent = formatUiNumber(selected);
  const range = snapshot?.visibleLevelRange;
  byId("diagnostic-lod").textContent = range
    ? `${range.min}–${range.max}`
    : "—";
  const selectedAlgorithm =
    snapshot?.refinementAlgorithm ?? refinementConfig.algorithm;
  byId("diagnostic-algorithm").textContent =
    selectedAlgorithm === "screen-projection"
      ? "Screen projection (legacy)"
      : "Foveated";
  byId("diagnostic-focus").textContent = snapshot?.refinementFocusEnabled
    ? "Active"
    : "Inactive";
  byId("diagnostic-focus-candidates").textContent = formatUiNumber(
    snapshot?.focusCandidateCount ?? 0,
  );
  byId("diagnostic-focus-refinements").textContent = formatUiNumber(
    snapshot?.focusInfluencedRefinementCount ?? 0,
  );
};

const refreshSnapshot = (): void => {
  if (!activeRuntime) {
    updateSnapshot(undefined);
    return;
  }
  try {
    updateSnapshot(activeRuntime.getSnapshot());
  } catch {
    updateSnapshot(undefined);
  }
};

algorithmSelect.addEventListener("change", () => {
  const selected = refinementAlgorithmOptions.find(
    (option) => option.value === algorithmSelect.value,
  );
  if (!selected) return;
  refinementConfig = { ...refinementConfig, algorithm: selected.value };
  updateFocusControls();
  writeRefinementUrl();
  updateIntegrationExample();
  refreshSnapshot();
  reloadActiveSource();
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
  updateFocusControls();
  writeRefinementUrl();
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

const showProbe = (result: CopcSourceProbeResult): void => {
  updateColorChoices(result.pointFormat);
  byId("diagnostic-range").textContent =
    result.rangeSupported === true
      ? "Supported"
      : result.rangeSupported === false
        ? "Unavailable"
        : "Unknown";
  byId("diagnostic-copc").textContent =
    result.copcDetected === true
      ? "Detected"
      : result.copcDetected === false
        ? "Not detected"
        : "Not confirmed";
  byId("diagnostic-validation").textContent =
    result.validationLevel === "strict"
      ? "Strict response validation"
      : result.validationLevel === "compatibility-limited"
        ? "Compatibility-limited"
        : result.validationLevel;
  const warning = byId<HTMLElement>("diagnostic-warning");
  warning.textContent = result.warnings.join(" ");
  warning.hidden = result.warnings.length === 0;
  sourceProbe.textContent =
    result.warnings.length > 0
      ? `${result.corsReadable === true ? "CORS readable" : "CORS unavailable"} · ${result.rangeSupported === true ? "HTTP Range supported" : "HTTP Range unavailable"}. ${result.warnings.join(" ")}`
      : `CORS readable · HTTP Range supported · COPC ${result.copcDetected === true ? "detected" : "not confirmed"}`;
};

const getFilePointFormat = async (file: File): Promise<number | undefined> => {
  if (file.size <= 104) return undefined;
  const header = new Uint8Array(await file.slice(104, 105).arrayBuffer());
  return header.length === 1 ? header[0] : undefined;
};

const destroyRuntime = (): void => {
  activeRuntimeReady = false;
  unbindPointerFocus();
  if (focusDragPointerId !== undefined) {
    const pointerId = focusDragPointerId;
    focusDragPointerId = undefined;
    if (focusGuideHandle.hasPointerCapture(pointerId))
      focusGuideHandle.releasePointerCapture(pointerId);
    activeRuntime?.setFocusDragging(false);
  }
  if (dragFocusFrame !== undefined) cancelAnimationFrame(dragFocusFrame);
  if (dragFocusTimer !== undefined) window.clearTimeout(dragFocusTimer);
  dragFocusFrame = undefined;
  dragFocusTimer = undefined;
  pendingDragCenter = undefined;
  if (focusConfigSyncTimer !== undefined)
    window.clearTimeout(focusConfigSyncTimer);
  focusConfigSyncTimer = undefined;
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  refreshTimer = undefined;
  activeRuntime?.destroy();
  activeRuntime = undefined;
  viewport.replaceChildren();
  updateSnapshot(undefined);
  updateFocusGuidePosition();
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
  const priorCamera =
    options.preserveCamera && priorRuntime?.renderer === renderer
      ? priorRuntime.getCameraState()
      : undefined;
  const capturedInteractionVersion = cameraInteractionVersion;
  activeSource = source;
  activeSourceName = sourceName;
  if (source instanceof File) activeProbeResult = undefined;
  else if (options.probeResult) activeProbeResult = options.probeResult;
  const probeResult = options.probeResult ?? activeProbeResult;
  destroyRuntime();
  renderPoint(undefined);
  activeLoadPending = true;
  setStatus(`Loading ${sourceName}…`, "loading");
  if (probeResult) {
    byId("diagnostic-range").textContent =
      probeResult.rangeSupported === true
        ? "Supported"
        : probeResult.rangeSupported === false
          ? "Unavailable"
          : "Unknown";
    byId("diagnostic-copc").textContent =
      probeResult.copcDetected === true
        ? "Detected"
        : probeResult.copcDetected === false
          ? "Not detected"
          : "Not confirmed";
    byId("diagnostic-validation").textContent =
      probeResult.validationLevel === "strict"
        ? "Strict response validation"
        : probeResult.validationLevel === "compatibility-limited"
          ? "Compatibility-limited"
          : probeResult.validationLevel;
  } else {
    byId("diagnostic-range").textContent =
      typeof source === "string" ? "Checking" : "Not applicable (local file)";
    byId("diagnostic-copc").textContent =
      typeof source === "string" ? "Checking" : "Checked while loading";
    byId("diagnostic-validation").textContent =
      typeof source === "string" ? "Checking" : "Local byte source";
  }
  let runtime: PlaygroundRuntime | undefined;
  try {
    if (source instanceof File) {
      updateColorChoices(await getFilePointFormat(source));
    }
    if (generation !== sourceGeneration) return;
    const loadConfig = captureWorkbenchConfig();
    const createdRuntime = await createPlaygroundRuntime(
      {
        renderer: loadConfig.renderer,
        backend: loadConfig.backend,
        source,
        sourceName,
        colorMode: loadConfig.colorMode,
        pointSize: loadConfig.pointSize,
        maxNodes: loadConfig.maxNodes,
        maxRenderedPoints: loadConfig.maxRenderedPoints,
        refinementAlgorithm: loadConfig.refinementAlgorithm,
        container: viewport,
        onPointPicked: renderPoint,
        isCurrent: () => generation === sourceGeneration,
        canAutoZoom: () =>
          capturedInteractionVersion === cameraInteractionVersion,
        onError: (message) => {
          if (runtime && activeRuntime === runtime)
            setStatus(safeErrorText(message), "error");
        },
      },
      layerFactory,
    );
    if (!createdRuntime) return;
    runtime = createdRuntime;
    activeRuntime = createdRuntime;
    bindPointerFocus(createdRuntime);
    const initialFocus = effectiveRefinementFocus();
    createdRuntime.setRefinementFocus(initialFocus);
    lastAppliedFocusCenter = initialFocus?.center;
    updateFocusControls();
    refreshTimer = window.setInterval(refreshSnapshot, 500);
    await createdRuntime.ready;
    if (generation !== sourceGeneration || activeRuntime !== createdRuntime) {
      if (activeRuntime === createdRuntime) {
        destroyRuntime();
        activeLoadPending = false;
        if (sourceStatus.textContent === `Loading ${sourceName}…`) {
          setStatus(
            "Source selection changed. Choose a source and load it.",
            "unknown",
          );
        }
      }
      return;
    }
    activeLoadPending = false;
    if (
      priorCamera &&
      capturedInteractionVersion === cameraInteractionVersion
    ) {
      createdRuntime.setCameraState(priorCamera);
    }
    appliedConfig = {
      ...loadConfig,
      refinementConfig: {
        ...refinementConfig,
        center: { ...refinementConfig.center },
      },
    };
    activeRuntimeReady = true;
    updateIntegrationExample();
    setStatus(`Loaded ${sourceName}`, "ready");
    viewerCaption.textContent = `${renderer === "cesium" ? "Cesium" : "Three.js"} streams visible COPC nodes as the camera moves.`;
    refreshSnapshot();
  } catch (error) {
    if (generation !== sourceGeneration) {
      if (runtime && activeRuntime === runtime) {
        destroyRuntime();
        activeLoadPending = false;
        if (sourceStatus.textContent === `Loading ${sourceName}…`) {
          setStatus(
            "Source selection changed. Choose a source and load it.",
            "unknown",
          );
        }
      }
      return;
    }
    activeLoadPending = false;
    destroyRuntime();
    setStatus(safeErrorText(error), "error");
    byId("hud-state").textContent = "Error";
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
    if (sourceStatus.textContent.startsWith("Loading ")) {
      setStatus(
        "Source selection changed. Choose a source and load it.",
        "unknown",
      );
    }
  }
  remoteLoadButton.disabled = false;
  remoteLoadButton.textContent =
    remoteSelect.value === "custom"
      ? "Probe and load URL"
      : "Probe and load source";
  if (probeWasPending)
    sourceProbe.textContent =
      "Source selection changed. Run the probe again to load it.";
  return generation;
};

remoteSelect.addEventListener("change", () => {
  invalidateSourceRequest();
  customUrlInput.disabled = remoteSelect.value !== "custom";
});
customUrlInput.disabled = true;
customUrlInput.addEventListener("input", () => {
  if (remoteSelect.value === "custom") invalidateSourceRequest();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  fileInput.value = "";
  sourceProbe.textContent =
    "Local files are read directly by the browser; HTTP CORS and Range checks do not apply.";
  const generation = invalidateSourceRequest();
  await loadSource(file, file.name, { generation });
});

remoteLoadButton.addEventListener("click", async () => {
  const generation = invalidateSourceRequest();
  let sourceUrl: string;
  let sourceName: string;
  if (remoteSelect.value === "custom") {
    try {
      const parsed = new URL(customUrlInput.value.trim());
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
        throw new Error();
      sourceUrl = parsed.href;
      sourceName = "Custom URL";
    } catch {
      sourceProbe.textContent = "Enter a valid absolute HTTP or HTTPS URL.";
      return;
    }
  } else if (remoteSelect.value === "chicago") {
    sourceUrl =
      "https://data.pointcloud.org/chicago-downtown/chicago-downtown.copc.laz";
    sourceName = "Chicago Downtown";
  } else {
    sourceUrl = "https://data.pointcloud.org/autzen/autzen-classified.copc.laz";
    sourceName = "Autzen Stadium";
  }

  remoteLoadButton.disabled = true;
  remoteLoadButton.textContent = "Checking source…";
  sourceProbe.textContent =
    "Checking browser access, HTTP Range, and COPC metadata…";
  byId("diagnostic-range").textContent = "Checking";
  byId("diagnostic-copc").textContent = "Checking";
  byId("diagnostic-validation").textContent = "Checking";
  try {
    const { probeCopcSource } = await import("@frillab/copc-adapter/cesium");
    const probe = await probeCopcSource(sourceUrl);
    if (generation !== sourceGeneration) return;
    showProbe(probe);
    if (probe.corsReadable !== true || probe.rangeSupported !== true) {
      sourceProbe.textContent = `${sourceProbe.textContent} Check that the host permits browser CORS and HTTP Range.`;
      setStatus(
        "Source cannot be loaded with browser CORS and HTTP Range.",
        "error",
      );
      return;
    }
    if (probe.copcDetected === false) {
      sourceProbe.textContent =
        "The response is readable but does not contain COPC metadata.";
      setStatus(
        "The selected source does not contain readable COPC metadata.",
        "error",
      );
      return;
    }
    await loadSource(sourceUrl, sourceName, { generation, probeResult: probe });
  } catch (error) {
    if (generation === sourceGeneration) {
      const message = safeErrorText(error);
      sourceProbe.textContent = message;
      setStatus(message, "error");
    }
  } finally {
    if (generation === sourceGeneration) {
      remoteLoadButton.disabled = false;
      remoteLoadButton.textContent =
        remoteSelect.value === "custom"
          ? "Probe and load URL"
          : "Probe and load source";
    }
  }
});

let disposed = false;
const destroyPlayground = (): void => {
  if (disposed) return;
  disposed = true;
  ++sourceGeneration;
  destroyRuntime();
  focusResizeObserver.disconnect();
  for (const slider of sliders) slider.destroy();
  colorControl.destroy();
  rendererControl.destroy();
  backendControl.destroy();
  cameraControl.destroy();
};
window.addEventListener("pagehide", destroyPlayground, { once: true });
