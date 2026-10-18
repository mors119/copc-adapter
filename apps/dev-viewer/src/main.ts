import './style.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import * as Cesium from 'cesium';
import {
  CopcCesiumLayer,
  probeCopcSource,
  type CopcBackendName,
  type CopcCesiumPointStyle,
  type CopcCesiumPointStyleUpdate,
  type CopcSourceProbeResult,
} from '@frillab/copc-adapter';
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
};

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

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longestMainThreadTaskMs = Math.max(longestMainThreadTaskMs, entry.duration);
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      // Long Task API is optional in browsers and test environments.
    }
  }

  viewer.scene.preRender.addEventListener(() => {
    cesiumFrameStartedAt = performance.now();
  });
  viewer.scene.postRender.addEventListener(() => {
    if (cesiumFrameStartedAt > 0) {
      cesiumFrameDurationMs = performance.now() - cesiumFrameStartedAt;
    }
  });

  viewer.camera.moveEnd.addEventListener(() => {
    cameraMoveEventCount += 1;
  });

  const recordError = (error: unknown): void => {
    lastError = error instanceof Error ? error.message : String(error);
  };

  window.addEventListener('error', (event) => {
    recordError(event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    recordError(event.reason);
  });

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
          const picked = viewer.scene.pick(position);
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

function getLayerOptions(): ConstructorParameters<typeof CopcCesiumLayer>[0] {
  const params = new URLSearchParams(window.location.search);
  const copcUrl = getCopcUrl();
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
    colorMode: 'rgb',
    backend: getSelectedBackend(),
    debug: true,
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

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const usePublicBatchedRenderer = params.get('renderer') === 'public-batched';
  const testHighDpiRendering = params.get('testDpr') === '1';
  const viewer = createCesiumViewer('cesium-container', {
    scene3DOnly: usePublicBatchedRenderer,
    ...(testHighDpiRendering ? { useBrowserRecommendedResolution: false } : {}),
  });
  const researchRenderer = usePublicBatchedRenderer
    ? new BatchedGeometryPointRenderer()
    : undefined;
  const layer = new CopcCesiumLayer({
    ...getLayerOptions(),
    ...(researchRenderer ? { renderer: researchRenderer } : {}),
  });
  const debugAdapter = installDebugAdapter(viewer, layer, import.meta.env.DEV, researchRenderer);
  let sourceProbe: CopcSourceProbeResult | undefined;
  if (isDebugPanelEnabled()) {
    void probeCopcSource(getCopcUrl()).then((result) => {
      sourceProbe = result;
    });
  }
  const debugPanel = isDebugPanelEnabled()
    ? createCopcDebugPanel(() => ({
        snapshot: layer.getSnapshot(),
        metadata: layer.getMetadata(),
        hierarchy: layer.getHierarchyDiagnostics(),
        sourceProbe,
        activeColorMode: layer.getStyle().colorMode,
        lastError: debugAdapter.getLastError(),
      }), {
        setCameraPreset: (preset) => debugAdapter.setCameraPreset(preset),
        setStyle: (update) => layer.setStyle(update),
      })
    : undefined;
  const pointInspector = createCopcPointInspector(() => layer.getSelectedPoint());

  window.addEventListener('pagehide', () => {
    debugPanel?.destroy();
    pointInspector.destroy();
  }, { once: true });

  try {
    await layer.load();
    layer.attachTo(viewer);

    console.log('COPC Metadata:', layer.getMetadata());
    console.log('COPC Layer Snapshot:', layer.getSnapshot());
  } catch (error) {
    debugAdapter.recordError(error);
    throw error;
  }
}

main().catch((error) => {
  console.error('Failed to load COPC:', error);
});
