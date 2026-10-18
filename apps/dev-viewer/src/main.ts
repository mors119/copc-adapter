import './style.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import * as Cesium from 'cesium';
import {
  CopcCesiumLayer,
  probeCopcSource,
  type CopcBackendName,
  type CopcColorMode,
  type CopcCesiumPointStyle,
  type CopcCesiumPointStyleUpdate,
  type CopcHierarchyDiagnostics,
  type CopcMetadata,
  type CopcPointInspection,
  type CopcSourceProbeResult,
} from '@frillab/copc-adapter';
import type { CopcCesiumLayerSnapshot } from '@frillab/copc-adapter';
import {
  mountSegmentedControl,
  mountSlider,
} from '../../shared/ui-controls';
import type { CopcThreeLayerSnapshot } from '@frillab/copc-adapter/three';
import { BatchedGeometryPointRenderer } from '@frillab/copc-adapter/cesium';
import { createCesiumViewer } from './createViewer';
import { createCopcDebugPanel } from './debug/CopcDebugPanel';
import { createCopcPointInspector } from './debug/CopcPointInspector';
import {
  runSyntheticRendererPerformanceBenchmark,
  type RendererBenchmarkKind,
} from './rendererPerformanceBenchmark';
import type { CpuPointPickProbe } from '../../../packages/cesium/render/BatchedGeometryPointRenderer';
import {
  runCpuBatchedPickingProbe,
  runCpuBatchedPickingStress,
} from './experimental/cpuBatchedPickingProbe';
import { createDevThreeViewer, type DevThreeViewer } from './threeViewer';

const cesiumRuntimeVersion = (Cesium as typeof Cesium & { VERSION: string }).VERSION;

const DEFAULT_COPC_URL = '/samples/autzen.copc.laz';
const CAMERA_PRESET_HEIGHTS = {
  overview: 5_000,
  far: 10_000,
  near: 300,
} as const;

type CameraPreset = keyof typeof CAMERA_PRESET_HEIGHTS;

function getCopcUrl(): string {
  return new URLSearchParams(window.location.search).get('source')
    ?? DEFAULT_COPC_URL;
}

function* getPointPrimitiveCollections(
  collection: Cesium.PrimitiveCollection,
): Generator<Cesium.PointPrimitiveCollection> {
  for (let index = 0; index < collection.length; index += 1) {
    const primitive = collection.get(index);
    if (primitive instanceof Cesium.PointPrimitiveCollection) {
      yield primitive;
    } else if (primitive instanceof Cesium.PrimitiveCollection) {
      yield* getPointPrimitiveCollections(primitive);
    }
  }
}

type CopcDebugState = {
  cesiumVersion: string;
  viewerReady: boolean;
  layerLoaded: boolean;
  datasetUrl: string;
  metadataPointCount?: number;
  renderedPointCount: number;
  scenePointCollectionCount: number;
  renderedNodeKeys: string[];
  selectedNodeKeys: string[];
  transition: ReturnType<CopcCesiumLayer['getSnapshot']>['transition'];
  viewDistance: ReturnType<CopcCesiumLayer['getSnapshot']>['viewDistance'];
  streamingUpdateCount: number;
  cameraMoveEventCount: number;
  cameraPitchDegrees: number;
  minRenderedHeight?: number;
  maxRenderedHeight?: number;
  renderedColorCount: number;
  lastError?: string;
  backend: CopcBackendName | 'custom';
  performance: ReturnType<CopcCesiumLayer['getSnapshot']>['performance'];
  pointCache: ReturnType<CopcCesiumLayer['getSnapshot']>['pointCache'];
  rangeRequests: ReturnType<CopcCesiumLayer['getSnapshot']>['rangeRequests'];
  hierarchy: ReturnType<CopcCesiumLayer['getHierarchyDiagnostics']>;
  worker?: ReturnType<CopcCesiumLayer['getSnapshot']>['worker'];
  longestMainThreadTaskMs: number;
  cesiumFrameDurationMs: number;
  selectedPoint?: ReturnType<CopcCesiumLayer['getSelectedPoint']>;
};

function isDebugPanelEnabled(): boolean {
  const value = new URLSearchParams(window.location.search).get('debugPanel');

  return value === null || !['0', 'false', 'off'].includes(value.toLowerCase());
}

type CopcDebugAdapter = {
  getState(): CopcDebugState;
  getStyle(): CopcCesiumPointStyle;
  setStyle(update: CopcCesiumPointStyleUpdate): void;
  getLastError(): string | undefined;
  setCameraHeight(height: number): void;
  setCameraPreset(preset: CameraPreset): void;
  setCameraPitch(pitchDegrees: number): void;
  setCameraHeading(headingDegrees: number): void;
  setCameraView(view: {
    longitudeDegrees: number;
    latitudeDegrees: number;
    heightMeters: number;
    headingDegrees: number;
    pitchDegrees: number;
  }): void;
  setGlobeVisible(visible: boolean): void;
  recordError(error: unknown): void;
  probeSource(source: string): Promise<CopcSourceProbeResult>;
  runSyntheticRendererPerformanceBenchmark(
    renderer?: RendererBenchmarkKind,
  ): ReturnType<typeof runSyntheticRendererPerformanceBenchmark>;
  probePublicBatchPick(): { picked: boolean; pickedNodeKey?: string; pointIndex?: number };
  probePublicBatchCpuPick(offsetPx?: number, clickTolerancePx?: number):
    | (CpuPointPickProbe & { targetPointIndex?: number; targetWorldPosition?: [number, number, number] })
    | { picked: false };
  runCpuBatchedPickingProbe(): Promise<Record<string, unknown>>;
  runCpuBatchedPickingStress(): Promise<Record<string, unknown>>;
  setPublicBatchVisibility(show: boolean): void;
  clearPublicBatchNodes(): number;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
  destroy(): void;
};

type RendererName = 'cesium' | 'three';

type DevViewerSettings = {
  renderer: RendererName;
  backend: CopcBackendName;
  colorMode: CopcColorMode;
  pointSize: number;
  maxNodes: number;
  maxRenderedPoints: number;
  maxDepth: number;
  maxScreenSpaceError: number;
  cameraRenderDistance: number;
  maxRenderDistance: number;
};

type ViewerSession = {
  renderer: RendererName;
  ready: Promise<void>;
  getSnapshot(): CopcCesiumLayerSnapshot | CopcThreeLayerSnapshot;
  getMetadata(): CopcMetadata | undefined;
  getHierarchyDiagnostics(): CopcHierarchyDiagnostics | undefined;
  getSelectedPoint(): CopcPointInspection | undefined;
  setCameraPreset(preset: CameraPreset): void;
  setCameraRenderDistance(distance: number): void;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
  getStyle(): CopcCesiumPointStyle;
  setStyle(update: CopcCesiumPointStyleUpdate): void;
  destroy(): void;
};

declare global {
  interface Window {
    __COPC_DEV_VIEWER__?: {
      getSnapshot(): CopcCesiumLayerSnapshot | CopcThreeLayerSnapshot | undefined;
      getSelectedPoint(): CopcPointInspection | undefined;
      getPickablePointScreenPosition(): { x: number; y: number } | undefined;
      getConfiguration(): Readonly<DevViewerSettings>;
    };
  }
}

function getRenderedPointDiagnostics(viewer: Cesium.Viewer): {
  minRenderedHeight?: number;
  maxRenderedHeight?: number;
  renderedColorCount: number;
} {
  let minRenderedHeight = Number.POSITIVE_INFINITY;
  let maxRenderedHeight = Number.NEGATIVE_INFINITY;
  const colors = new Set<string>();

  for (const collection of getPointPrimitiveCollections(viewer.scene.primitives)) {
    const stride = Math.max(1, Math.floor(collection.length / 256));

    for (let pointIndex = 0; pointIndex < collection.length; pointIndex += stride) {
      const point = collection.get(pointIndex);
      const height = Cesium.Cartographic.fromCartesian(point.position).height;

      minRenderedHeight = Math.min(minRenderedHeight, height);
      maxRenderedHeight = Math.max(maxRenderedHeight, height);
      colors.add([
        point.color.red.toFixed(3),
        point.color.green.toFixed(3),
        point.color.blue.toFixed(3),
      ].join(','));
    }
  }

  return {
    minRenderedHeight: Number.isFinite(minRenderedHeight)
      ? minRenderedHeight
      : undefined,
    maxRenderedHeight: Number.isFinite(maxRenderedHeight)
      ? maxRenderedHeight
      : undefined,
    renderedColorCount: colors.size,
  };
}

declare global {
  interface Window {
    __COPC_DEBUG__?: CopcDebugAdapter;
  }
}

function installDebugAdapter(
  viewer: Cesium.Viewer,
  layer: CopcCesiumLayer,
  exposeGlobally: boolean,
  researchRenderer?: BatchedGeometryPointRenderer,
): CopcDebugAdapter {
  let cameraMoveEventCount = 0;
  let lastError: string | undefined;
  let longestMainThreadTaskMs = 0;
  let cesiumFrameDurationMs = 0;
  let cesiumFrameStartedAt = 0;
  let performanceObserver: PerformanceObserver | undefined;
  let destroyed = false;

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      performanceObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longestMainThreadTaskMs = Math.max(longestMainThreadTaskMs, entry.duration);
        }
      });
      performanceObserver.observe({ type: 'longtask', buffered: true });
    } catch {
      // Long Task API is optional in browsers and test environments.
    }
  }

  const onPreRender = (): void => {
    cesiumFrameStartedAt = performance.now();
  };
  const onPostRender = (): void => {
    if (cesiumFrameStartedAt > 0) {
      cesiumFrameDurationMs = performance.now() - cesiumFrameStartedAt;
    }
  };
  viewer.scene.preRender.addEventListener(onPreRender);
  viewer.scene.postRender.addEventListener(onPostRender);

  const onMoveEnd = (): void => {
    cameraMoveEventCount += 1;
  };
  viewer.camera.moveEnd.addEventListener(onMoveEnd);

  const recordError = (error: unknown): void => {
    lastError = error instanceof Error ? error.message : String(error);
  };

  const onWindowError = (event: ErrorEvent): void => {
    recordError(event.error ?? event.message);
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    recordError(event.reason);
  };
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);

  const adapter: CopcDebugAdapter = {
    getStyle(): CopcCesiumPointStyle {
      return layer.getStyle();
    },
    setStyle(update: CopcCesiumPointStyleUpdate): void {
      layer.setStyle(update);
    },
    getState(): CopcDebugState {
      const snapshot = layer.getSnapshot();
      const pointDiagnostics = getRenderedPointDiagnostics(viewer);

      return {
        cesiumVersion: cesiumRuntimeVersion,
        viewerReady: !viewer.isDestroyed(),
        layerLoaded: snapshot.lifecycle === 'ready',
        datasetUrl: snapshot.datasetUrl,
        metadataPointCount: layer.getMetadata()?.pointCount,
        renderedPointCount: snapshot.renderedPointCount,
        scenePointCollectionCount: getScenePointCollectionCount(viewer),
        renderedNodeKeys: snapshot.renderedNodeKeys,
        selectedNodeKeys: snapshot.selectedNodeKeys,
        transition: snapshot.transition,
        viewDistance: snapshot.viewDistance,
        streamingUpdateCount: snapshot.streamingUpdateCount,
        cameraMoveEventCount,
        cameraPitchDegrees: Cesium.Math.toDegrees(viewer.camera.pitch),
        ...pointDiagnostics,
        backend: snapshot.backend,
        performance: snapshot.performance,
        pointCache: snapshot.pointCache,
        rangeRequests: snapshot.rangeRequests,
        hierarchy: layer.getHierarchyDiagnostics(),
        worker: snapshot.worker,
        longestMainThreadTaskMs,
        cesiumFrameDurationMs,
        selectedPoint: layer.getSelectedPoint(),
        lastError,
      };
    },
    getLastError(): string | undefined {
      return lastError;
    },
    setCameraHeight(height: number): void {
      moveCameraToHeight(viewer, height);
    },
    setCameraPreset(preset: CameraPreset): void {
      moveCameraToHeight(viewer, CAMERA_PRESET_HEIGHTS[preset]);
    },
    setCameraPitch(pitchDegrees: number): void {
      viewer.camera.setView({
        orientation: {
          heading: viewer.camera.heading,
          pitch: Cesium.Math.toRadians(pitchDegrees),
          roll: viewer.camera.roll,
        },
      });
      viewer.camera.moveEnd.raiseEvent();
    },
    setCameraHeading(headingDegrees: number): void {
      viewer.camera.setView({
        orientation: {
          heading: Cesium.Math.toRadians(headingDegrees),
          pitch: viewer.camera.pitch,
          roll: viewer.camera.roll,
        },
      });
      viewer.camera.moveEnd.raiseEvent();
    },
    setCameraView(view): void {
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
          view.longitudeDegrees,
          view.latitudeDegrees,
          view.heightMeters,
        ),
        orientation: {
          heading: Cesium.Math.toRadians(view.headingDegrees),
          pitch: Cesium.Math.toRadians(view.pitchDegrees),
          roll: 0,
        },
      });
      viewer.camera.moveEnd.raiseEvent();
    },
    setGlobeVisible(visible: boolean): void {
      viewer.scene.globe.show = visible;
    },
    recordError,
    probeSource: probeCopcSource,
    runSyntheticRendererPerformanceBenchmark: (renderer = 'point-primitive') => runSyntheticRendererPerformanceBenchmark({
      viewer,
      pointCounts: [10_000, 50_000, 100_000],
      repetitions: 5,
      warmups: 2,
      renderer,
    }),
    probePublicBatchPick: () => {
      const nodeKey = researchRenderer?.getRenderedNodeKeys()[0];
      return nodeKey && researchRenderer
        ? researchRenderer.probePick(viewer.scene, nodeKey)
        : { picked: false };
    },
    probePublicBatchCpuPick: (offsetPx = 0, clickTolerancePx = 1.5) => {
      const nodeKey = researchRenderer?.getRenderedNodeKeys()[0];
      if (!nodeKey || !researchRenderer) return { picked: false };
      const target = researchRenderer.probePick(viewer.scene, nodeKey);
      if (!target.picked || !target.screenPosition) return { picked: false };
      const probePosition = new Cesium.Cartesian2(
        target.screenPosition.x + offsetPx,
        target.screenPosition.y,
      );
      const probe = researchRenderer.probeCpuPointPick(viewer.scene, probePosition, clickTolerancePx);
      return {
        ...probe,
        targetPointIndex: target.targetSourcePointIndex,
        targetWorldPosition: target.worldPosition,
      };
    },
    runCpuBatchedPickingProbe: () => researchRenderer
      ? runCpuBatchedPickingProbe(viewer, researchRenderer)
      : Promise.resolve({ skipped: true, reason: 'public-batched-renderer-not-active' }),
    runCpuBatchedPickingStress: () => researchRenderer
      ? runCpuBatchedPickingStress(viewer, researchRenderer)
      : Promise.resolve({ skipped: true, reason: 'public-batched-renderer-not-active' }),
    setPublicBatchVisibility: (show) => researchRenderer?.setShow(show),
    clearPublicBatchNodes: () => {
      researchRenderer?.clear();
      return researchRenderer?.getRenderedNodeKeys().length ?? -1;
    },
    getPickablePointScreenPosition(): { x: number; y: number } | undefined {
      if (researchRenderer) {
        for (const nodeKey of researchRenderer.getRenderedNodeKeys()) {
          const candidate = researchRenderer.probePick(viewer.scene, nodeKey);
          if (!candidate.picked || !candidate.screenPosition
            || candidate.screenPosition.x < 380
            || candidate.screenPosition.x > viewer.scene.canvas.clientWidth - 4
            || candidate.screenPosition.y < 4
            || candidate.screenPosition.y > viewer.scene.canvas.clientHeight - 4) {
            continue;
          }
          const position = new Cesium.Cartesian2(
            candidate.screenPosition.x,
            candidate.screenPosition.y,
          );
          const picked = viewer.scene.pick(position, 1, 1);
          const resolved = researchRenderer.resolvePointPick(viewer.scene, position, picked);
          if (resolved?.nodeKey === nodeKey
            && resolved.pointIndex === candidate.targetSourcePointIndex) {
            return candidate.screenPosition;
          }
        }
        return undefined;
      }
      for (const collection of getPointPrimitiveCollections(viewer.scene.primitives)) {
        for (let pointIndex = 0; pointIndex < collection.length; pointIndex += 1) {
          const position = Cesium.SceneTransforms.worldToWindowCoordinates(
            viewer.scene,
            collection.get(pointIndex).position,
          );
          if (
            position
            && position.x >= 380
            && position.x <= viewer.scene.canvas.clientWidth - 4
            && position.y >= 4
            && position.y <= viewer.scene.canvas.clientHeight - 4
          ) {
            return { x: position.x, y: position.y };
          }
        }
      }
      return undefined;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      performanceObserver?.disconnect();
      viewer.scene.preRender.removeEventListener(onPreRender);
      viewer.scene.postRender.removeEventListener(onPostRender);
      viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      if (window.__COPC_DEBUG__ === adapter) delete window.__COPC_DEBUG__;
    },
  };

  if (exposeGlobally) {
    window.__COPC_DEBUG__ = adapter;
  }

  return adapter;
}

function getSelectedBackend(): CopcBackendName {
  return new URLSearchParams(window.location.search).get('backend') === 'rust'
    ? 'rust'
    : 'copc-js';
}

function getLayerOptions(
  source: string | File = getCopcUrl(),
  settings?: DevViewerSettings,
): ConstructorParameters<typeof CopcCesiumLayer>[0] {
  const params = new URLSearchParams(window.location.search);
  const copcUrl = source;
  const heightOffsetParam = params.get('heightOffsetMeters');
  const requestedHeightOffset = heightOffsetParam === null
    ? undefined
    : Number(heightOffsetParam);
  const heightOffsetMeters = Number.isFinite(requestedHeightOffset)
    ? requestedHeightOffset
    : undefined;
  const requestedBudget = Number(params.get('budget'));
  const maxRenderedPoints = Number.isSafeInteger(requestedBudget) && requestedBudget > 0
    ? requestedBudget
    : undefined;
  const cacheBytesParam = params.get('cacheBytes');
  const requestedCacheBytes = cacheBytesParam === null ? undefined : Number(cacheBytesParam);
  const maxPointCacheBytes = requestedCacheBytes !== undefined
    && Number.isSafeInteger(requestedCacheBytes)
    && requestedCacheBytes >= 0
    ? requestedCacheBytes
    : undefined;

  const scenario = params.get('scenario');
  if (['issue61', 'issue59', 'issue68', 'issue128'].includes(scenario ?? '')) {
    const issue128 = scenario === 'issue128';
    const requestedDistance = Number(params.get('distance'));
    const maxRenderDistanceMeters = issue128
      && Number.isFinite(requestedDistance)
      && requestedDistance > 0
      ? requestedDistance
      : issue128 ? 100 : 20_000;
    return {
      url: copcUrl,
      colorMode: 'elevation',
      backend: params.get('backend') === 'copc-js' ? 'copc-js' : 'rust',
      pointSize: 2,
      debug: true,
      ...(maxRenderedPoints === undefined ? {} : { maxRenderedPoints }),
      ...(maxPointCacheBytes === undefined ? {} : { maxPointCacheBytes }),
      ...(heightOffsetMeters === undefined ? {} : { heightOffsetMeters }),
      streaming: {
        maxNodes: issue128 ? 16 : 32,
        maxDepth: issue128 ? 4 : 6,
        maxScreenSpaceError: 8,
        maxRenderDistanceMeters,
      },
    };
  }

  return {
    url: copcUrl,
    colorMode: settings?.colorMode ?? 'rgb',
    backend: settings?.backend ?? getSelectedBackend(),
    debug: true,
    ...(settings ? {
      pointSize: settings.pointSize,
      maxRenderedPoints: settings.maxRenderedPoints,
      streaming: {
        maxNodes: settings.maxNodes,
        maxDepth: settings.maxDepth,
        maxScreenSpaceError: settings.maxScreenSpaceError,
        maxRenderDistanceMeters: settings.maxRenderDistance,
      },
    } : {}),
    ...(heightOffsetMeters === undefined ? {} : { heightOffsetMeters }),
  };
}

function getScenePointCollectionCount(viewer: Cesium.Viewer): number {
  let count = 0;

  for (const _collection of getPointPrimitiveCollections(viewer.scene.primitives)) {
    count += 1;
  }

  return count;
}

function moveCameraToHeight(viewer: Cesium.Viewer, height: number): void {
  const position = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromRadians(
      position.longitude,
      position.latitude,
      height,
    ),
  });
  viewer.camera.moveEnd.raiseEvent();
}

const AUTZEN_REMOTE_URL = 'https://data.pointcloud.org/autzen/autzen-classified.copc.laz';
const CHICAGO_REMOTE_URL = 'https://data.pointcloud.org/chicago-downtown/chicago-downtown.copc.laz';

function getElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Dev Viewer is missing required element: ${selector}`);
  return element;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/([?&][^=\s]+)=([^&\s]+)/g, '$1=[redacted]');
}

function getSourceLabel(source: string | File): string {
  if (source instanceof File) return source.name;
  try {
    const url = new URL(source, window.location.href);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return source;
  }
}

function createCesiumSession(
  container: HTMLElement,
  source: string | File,
  settings: DevViewerSettings,
  onError: (error: unknown) => void,
): ViewerSession {
  const params = new URLSearchParams(window.location.search);
  const usePublicBatchedRenderer = params.get('renderer') === 'public-batched';
  const testHighDpiRendering = params.get('testDpr') === '1';
  const viewer = createCesiumViewer(container, {
    scene3DOnly: usePublicBatchedRenderer,
    ...(testHighDpiRendering ? { useBrowserRecommendedResolution: false } : {}),
  });
  const researchRenderer = usePublicBatchedRenderer
    ? new BatchedGeometryPointRenderer()
    : undefined;
  const layer = new CopcCesiumLayer({
    ...getLayerOptions(source, settings),
    ...(researchRenderer ? { renderer: researchRenderer } : {}),
  });
  const debugAdapter = installDebugAdapter(viewer, layer, import.meta.env.DEV, researchRenderer);
  const ready = layer.load().then(() => {
    layer.attachTo(viewer);
    return layer.getSnapshot();
  }).catch((error: unknown) => {
    debugAdapter.recordError(error);
    onError(error);
    throw error;
  });

  return {
    renderer: 'cesium',
    ready: ready.then(() => undefined),
    getSnapshot: () => layer.getSnapshot(),
    getMetadata: () => layer.getMetadata(),
    getHierarchyDiagnostics: () => layer.getHierarchyDiagnostics(),
    getSelectedPoint: () => layer.getSelectedPoint(),
    setCameraPreset(preset) {
      debugAdapter.setCameraPreset(preset);
    },
    setCameraRenderDistance(distance) {
      moveCameraToHeight(viewer, distance);
    },
    getPickablePointScreenPosition: () => debugAdapter.getPickablePointScreenPosition(),
    getStyle: () => layer.getStyle(),
    setStyle: (update) => layer.setStyle(update),
    destroy() {
      debugAdapter.destroy();
      layer.destroy();
      if (!viewer.isDestroyed()) viewer.destroy();
    },
  };
}

function createThreeSession(
  container: HTMLElement,
  source: string | File,
  sourceName: string,
  settings: DevViewerSettings,
  onError: (error: unknown) => void,
  onStyleChange: () => void,
): ViewerSession {
  const viewer: DevThreeViewer = createDevThreeViewer({
    container,
    source,
    sourceName,
    backend: settings.backend,
    colorMode: settings.colorMode,
    pointSize: settings.pointSize,
    maxRenderedPoints: settings.maxRenderedPoints,
    streaming: {
      maxNodes: settings.maxNodes,
      maxDepth: settings.maxDepth,
      maxScreenSpaceError: settings.maxScreenSpaceError,
      maxRenderDistanceMeters: settings.maxRenderDistance,
    },
    onPointPicked: () => undefined,
    onError,
  });
  return {
    renderer: 'three',
    ready: viewer.ready,
    getSnapshot: () => viewer.getSnapshot(),
    getMetadata: () => viewer.getMetadata(),
    getHierarchyDiagnostics: () => viewer.getHierarchyDiagnostics(),
    getSelectedPoint: () => viewer.getSelectedPoint(),
    setCameraPreset(preset) {
      viewer.setCameraPreset(preset);
    },
    setCameraRenderDistance(distance) {
      viewer.setCameraDistance(distance);
    },
    getPickablePointScreenPosition: () => viewer.getPickablePointScreenPosition(),
    getStyle: () => ({ colorMode: settings.colorMode }),
    setStyle(update) {
      if (update.colorMode) settings.colorMode = update.colorMode;
      onStyleChange();
    },
    destroy: () => viewer.destroy(),
  };
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const initialOptions = getLayerOptions();
  const initialStreaming = initialOptions.streaming;
  const initialScenario = params.get('scenario');
  const settings: DevViewerSettings = {
    renderer: params.get('renderer') === 'three' ? 'three' : 'cesium',
    backend: getSelectedBackend(),
    colorMode: ['issue61', 'issue59', 'issue68', 'issue128'].includes(initialScenario ?? '')
      ? 'elevation'
      : 'rgb',
    pointSize: initialScenario ? 2 : 3,
    maxNodes: initialStreaming?.maxNodes ?? 24,
    maxRenderedPoints: initialOptions.maxRenderedPoints
      ?? initialStreaming?.maxRenderedPoints
      ?? 250_000,
    maxDepth: initialStreaming?.maxDepth ?? 6,
    maxScreenSpaceError: initialStreaming?.maxScreenSpaceError ?? 8,
    cameraRenderDistance: /chicago/i.test(getCopcUrl()) ? 14_000 : 5_000,
    maxRenderDistance: initialStreaming?.maxRenderDistanceMeters ?? 12_000,
  };
  let selectedSource: string | File = getCopcUrl();
  let activeSession: ViewerSession | undefined;
  let activeDebugAdapter: CopcDebugAdapter | undefined;
  let sourceProbe: CopcSourceProbeResult | undefined;
  let lastSnapshot: CopcCesiumLayerSnapshot | CopcThreeLayerSnapshot | undefined;
  let lastError: string | undefined;
  let generation = 0;
  let updateTimer: number | undefined;
  let disposed = false;
  let syncColorControl: (value: CopcColorMode) => void = () => {};
  const container = getElement<HTMLElement>('#cesium-container');
  const status = getElement<HTMLElement>('#source-status');
  const loadButton = getElement<HTMLButtonElement>('#load-source');
  const packageVersion = getElement<HTMLElement>('#package-version');
  packageVersion.textContent = `v${__COPC_ADAPTER_VERSION__} · workspace package`;

  const updateStatus = (message: string, tone: 'loading' | 'ready' | 'error' | 'inactive'): void => {
    status.textContent = message;
    status.dataset.status = tone;
    getElement<HTMLElement>('.dev-stream-hud').dataset.status = tone;
    const state = getElement<HTMLElement>('#stream-state');
    state.textContent = tone === 'ready' ? 'Ready' : tone === 'error' ? 'Error' : message;
  };

  const updateHud = (): void => {
    const snapshot = activeSession?.getSnapshot();
    if (!snapshot) return;
    getElement<HTMLElement>('#stream-points').textContent = String(snapshot.renderedPointCount);
    getElement<HTMLElement>('#stream-nodes').textContent = String(snapshot.renderedNodeKeys.length);
    getElement<HTMLElement>('#stream-selected').textContent = String(snapshot.selectedNodeKeys.length);
    const range = sourceProbe?.rangeSupported;
    getElement<HTMLElement>('#stream-range').textContent = range === true
      ? 'HTTP Range · supported'
      : range === false ? 'HTTP Range · unavailable' : 'HTTP Range · checking';
  };

  const setActiveError = (error: unknown): void => {
    lastError = safeErrorMessage(error);
    updateStatus(lastError, 'error');
  };

  async function startSession(progressMessage = 'Loading configured source…'): Promise<void> {
    const currentGeneration = ++generation;
    activeDebugAdapter?.destroy();
    activeDebugAdapter = undefined;
    if (activeSession) {
      lastSnapshot = activeSession.getSnapshot();
      activeSession.destroy();
      activeSession = undefined;
    }
    sourceProbe = undefined;
    lastError = undefined;
    updateStatus(progressMessage, 'loading');
    loadButton.disabled = true;
    const source = selectedSource;
    const sourceName = getSourceLabel(source);

    if (typeof source === 'string') {
      void probeCopcSource(source).then((result) => {
        if (currentGeneration !== generation || disposed) return;
        sourceProbe = result;
        updateHud();
      }).catch((error: unknown) => {
        if (currentGeneration === generation) sourceProbe = undefined;
        console.warn('COPC source probe did not complete:', safeErrorMessage(error));
      });
    }

    try {
      const reportError = (error: unknown): void => {
        if (currentGeneration === generation && !disposed) setActiveError(error);
      };
      const session = settings.renderer === 'cesium'
        ? createCesiumSession(container, source, settings, reportError)
        : createThreeSession(
          container,
          source,
          sourceName,
          settings,
          reportError,
          () => { void startSession('Applying point style…'); },
        );
      activeSession = session;
      activeDebugAdapter = window.__COPC_DEBUG__;
      window.__COPC_DEV_VIEWER__ = {
        getSnapshot: () => activeSession?.getSnapshot(),
        getSelectedPoint: () => activeSession?.getSelectedPoint(),
        getPickablePointScreenPosition: () => activeSession?.getPickablePointScreenPosition(),
        getConfiguration: () => ({ ...settings }),
      };
      updateHud();
      await session.ready;
      if (currentGeneration !== generation || disposed) {
        session.destroy();
        return;
      }
      lastSnapshot = session.getSnapshot();
      updateStatus(`Ready · ${sourceName}`, 'ready');
      updateHud();
      if (settings.renderer === 'cesium') {
        console.log('COPC Metadata:', session.getMetadata());
        console.log('COPC Layer Snapshot:', session.getSnapshot());
      }
    } catch (error) {
      if (currentGeneration === generation && !disposed) {
        if (activeSession) lastSnapshot = activeSession.getSnapshot();
        activeSession?.destroy();
        activeSession = undefined;
        activeDebugAdapter?.destroy();
        activeDebugAdapter = undefined;
        setActiveError(error);
      }
    } finally {
      if (currentGeneration === generation) loadButton.disabled = false;
    }
  }

  const activeSnapshot = (): CopcCesiumLayerSnapshot | CopcThreeLayerSnapshot => {
    const snapshot = activeSession?.getSnapshot() ?? lastSnapshot;
    if (!snapshot) throw new Error('COPC layer has not initialized yet.');
    return snapshot;
  };
  const setStyle = (update: CopcCesiumPointStyleUpdate): void => {
    if (update.colorMode) settings.colorMode = update.colorMode;
    syncColorControl(settings.colorMode);
    if (activeSession?.renderer === 'cesium') activeSession.setStyle(update);
    else void startSession('Applying point style…');
  };

  // startSession assigns the active session before its first await, so the
  // diagnostics panel can safely bind to the loading snapshot immediately.
  void startSession();
  const debugPanel = isDebugPanelEnabled()
    ? createCopcDebugPanel(() => ({
        snapshot: activeSnapshot(),
        metadata: activeSession?.getMetadata(),
        hierarchy: activeSession?.getHierarchyDiagnostics(),
        sourceProbe,
        activeColorMode: activeSession?.getStyle().colorMode ?? settings.colorMode,
        lastError: lastError ?? activeDebugAdapter?.getLastError(),
      }), {
        setCameraPreset: (preset) => activeSession?.setCameraPreset(preset),
        setStyle,
      })
    : undefined;
  const pointInspector = createCopcPointInspector(() => activeSession?.getSelectedPoint());

  const mountedControls: Array<{ destroy(): void }> = [];
  const rendererControl = mountSegmentedControl(getElement('#renderer-control'), {
    label: 'Renderer',
    value: settings.renderer,
    choices: [
      { value: 'cesium', label: 'Cesium' },
      { value: 'three', label: 'Three.js' },
    ],
    onChange(value) {
      settings.renderer = value;
      void startSession(`Switching to ${value === 'cesium' ? 'Cesium' : 'Three.js'}…`);
    },
  });
  mountedControls.push(rendererControl);
  const backendControl = mountSegmentedControl(getElement('#backend-control'), {
    label: 'Backend',
    value: settings.backend,
    choices: [
      { value: 'copc-js', label: 'JavaScript' },
      { value: 'rust', label: 'Rust / WASM' },
    ],
    onChange(value) {
      settings.backend = value;
      void startSession(`Switching to ${value === 'rust' ? 'Rust / WASM' : 'JavaScript'}…`);
    },
  });
  mountedControls.push(backendControl);
  const cameraControl = mountSegmentedControl(getElement('#camera-control'), {
    label: 'Camera view',
    value: 'overview',
    choices: [
      { value: 'overview', label: 'Overview' },
      { value: 'far', label: 'Far' },
      { value: 'near', label: 'Near' },
    ],
    onChange(value) {
      activeSession?.setCameraPreset(value);
    },
  });
  mountedControls.push(cameraControl);
  const colorControl = mountSegmentedControl(getElement('#color-control'), {
    label: 'Point color mode',
    value: settings.colorMode,
    choices: [
      { value: 'rgb', label: 'RGB' },
      { value: 'elevation', label: 'Elevation' },
      { value: 'intensity', label: 'Intensity' },
      { value: 'classification', label: 'Class' },
    ],
    onChange(value) {
      setStyle({ colorMode: value });
    },
  });
  syncColorControl = (value) => colorControl.setValue(value);
  mountedControls.push(colorControl);
  const pointSizeSlider = mountSlider(getElement('#point-size-control'), {
    id: 'dev-point-size', label: 'Point size', min: 1, max: 12, step: 0.5,
    value: settings.pointSize, formatValue: (value) => `${value} px`,
    onCommit(value) {
      settings.pointSize = value;
      void startSession('Applying point size…');
    },
  });
  mountedControls.push(pointSizeSlider);
  const nodesSlider = mountSlider(getElement('#max-nodes-control'), {
    id: 'dev-max-nodes', label: 'Max selected nodes', min: 4, max: 64, step: 4,
    value: settings.maxNodes,
    onCommit(value) {
      settings.maxNodes = value;
      void startSession('Applying node limit…');
    },
  });
  mountedControls.push(nodesSlider);
  const pointsSlider = mountSlider(getElement('#max-points-control'), {
    id: 'dev-max-points', label: 'Max rendered points', min: 50_000, max: 1_000_000, step: 50_000,
    value: Math.min(1_000_000, settings.maxRenderedPoints),
    onCommit(value) {
      settings.maxRenderedPoints = value;
      void startSession('Applying point budget…');
    },
  });
  mountedControls.push(pointsSlider);

  const sourceSelect = getElement<HTMLSelectElement>('#source-selection');
  const customUrl = getElement<HTMLInputElement>('#custom-source-url');
  const fileInput = getElement<HTMLInputElement>('#local-source-file');
  const initialUrl = typeof selectedSource === 'string' ? selectedSource : '';
  const sourcePresets = new Map([
    ['local-autzen', DEFAULT_COPC_URL],
    ['autzen-remote', AUTZEN_REMOTE_URL],
    ['chicago-remote', CHICAGO_REMOTE_URL],
  ]);
  const initialPreset = [...sourcePresets].find(([, source]) => source === initialUrl)?.[0];
  sourceSelect.value = initialPreset ?? 'custom';
  customUrl.disabled = sourceSelect.value !== 'custom';
  if (sourceSelect.value === 'custom') customUrl.value = initialUrl;
  sourceSelect.addEventListener('change', () => {
    const isCustom = sourceSelect.value === 'custom';
    customUrl.disabled = !isCustom;
    fileInput.value = '';
    if (!isCustom) {
      selectedSource = sourcePresets.get(sourceSelect.value) ?? DEFAULT_COPC_URL;
    }
  });
  customUrl.addEventListener('input', () => {
    if (sourceSelect.value === 'custom') selectedSource = customUrl.value.trim();
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) {
      selectedSource = file;
      sourceSelect.value = 'local-autzen';
      customUrl.disabled = true;
      void startSession(`Loading local file · ${file.name}…`);
    }
  });
  loadButton.addEventListener('click', () => {
    if (sourceSelect.value === 'custom') selectedSource = customUrl.value.trim();
    if (typeof selectedSource === 'string' && selectedSource.length === 0) {
      setActiveError(new Error('Enter a COPC URL before loading.'));
      return;
    }
    void startSession('Probing and loading source…');
  });

  const advancedInputs = {
    maxDepth: getElement<HTMLInputElement>('#max-depth'),
    maxScreenSpaceError: getElement<HTMLInputElement>('#max-sse'),
    cameraRenderDistance: getElement<HTMLInputElement>('#camera-render-distance'),
    maxRenderDistance: getElement<HTMLInputElement>('#max-render-distance'),
  };
  const syncAdvancedInputs = (): void => {
    advancedInputs.maxDepth.value = String(settings.maxDepth);
    advancedInputs.maxScreenSpaceError.value = String(settings.maxScreenSpaceError);
    advancedInputs.cameraRenderDistance.value = String(settings.cameraRenderDistance);
    advancedInputs.maxRenderDistance.value = String(settings.maxRenderDistance);
  };
  syncAdvancedInputs();
  getElement<HTMLButtonElement>('#apply-advanced').addEventListener('click', () => {
    const values = Object.fromEntries(Object.entries(advancedInputs).map(([key, input]) => [key, Number(input.value)])) as Record<keyof typeof advancedInputs, number>;
    if (Object.values(values).some((value) => !Number.isFinite(value) || value <= 0)
      || !Number.isSafeInteger(values.maxDepth)
      || values.maxDepth > 24
      || values.maxScreenSpaceError > 128) {
      setActiveError(new Error('Advanced values must be positive and within the displayed depth/SSE limits.'));
      return;
    }
    Object.assign(settings, values);
    void startSession('Applying advanced streaming settings…').then(() => {
      activeSession?.setCameraRenderDistance(settings.cameraRenderDistance);
    });
  });
  getElement<HTMLButtonElement>('#reload-renderer').addEventListener('click', () => {
    void startSession('Reloading renderer…');
  });

  updateTimer = window.setInterval(() => {
    if (activeSession) lastSnapshot = activeSession.getSnapshot();
    updateHud();
  }, 250);
  window.addEventListener('pagehide', () => {
    disposed = true;
    generation += 1;
    if (updateTimer !== undefined) window.clearInterval(updateTimer);
    debugPanel?.destroy();
    pointInspector.destroy();
    mountedControls.forEach((control) => control.destroy());
    activeDebugAdapter?.destroy();
    activeSession?.destroy();
    delete window.__COPC_DEV_VIEWER__;
  }, { once: true });
}

main().catch((error) => {
  console.error('Failed to load COPC:', error);
});
