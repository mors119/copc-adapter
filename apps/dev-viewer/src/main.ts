import "./style.css";
import "cesium/Build/Cesium/Widgets/widgets.css";

import * as Cesium from "cesium";
import {
  CopcCesiumLayer,
  probeCopcSource,
  type CopcBackendName,
  type CopcCesiumPointStyle,
  type CopcCesiumPointStyleUpdate,
  type CopcHierarchyDiagnostics,
  type CopcMetadata,
  type CopcPointInspection,
  type CopcSourceProbeResult,
  type RangeValidationPolicy,
  type TerrainHeightAlignmentEstimate,
  type TerrainHeightAlignmentOptions,
} from "@frillab/copc-adapter";
import type { CopcCesiumLayerSnapshot } from "@frillab/copc-adapter";
import type { CopcThreeLayerSnapshot } from "@frillab/copc-adapter/three";
import type {
  CopcBackendSelection,
  CopcPointDecoder,
} from "@frillab/copc-adapter/cesium";
import {
  BatchedGeometryPointRenderer,
  PointPrimitiveRenderer,
} from "@frillab/copc-adapter/cesium";
import { createCesiumViewer } from "./createViewer";
import { createCopcDebugPanel } from "./debug/CopcDebugPanel";
import {
  runSyntheticRendererPerformanceBenchmark,
  type RendererBenchmarkKind,
} from "./rendererPerformanceBenchmark";
import type { CpuPointPickProbe } from "../../../packages/cesium/render/BatchedGeometryPointRenderer";
import {
  runCpuBatchedPickingProbe,
  runCpuBatchedPickingStress,
} from "./experimental/cpuBatchedPickingProbe";
import {
  createDevThreeViewer,
  type DevThreeCameraState,
  type DevThreeViewer,
} from "./threeViewer";
import { mountWorkbenchPanels } from "./workbenchPanels";
import { mountDevViewerControls } from "./devViewerControls";
import {
  getCesiumTerrainProviderUrl,
  getSafeSourceLabel,
  getSafeTerrainSourceLabel,
  hasUnappliedSettings,
  isRangeValidationPolicy,
  isRefinementAlgorithm,
  needsSessionRecreation,
  sourceSupportsHttpRange,
  validateDevViewerConfig,
  type CameraPreset,
  type CesiumPointRendererVariant,
  type DevViewerConfig,
  type RenderingEngine,
} from "./devViewerConfig";

const cesiumRuntimeVersion = (Cesium as typeof Cesium & { VERSION: string })
  .VERSION;

const DEFAULT_COPC_URL = "/samples/autzen.copc.laz";
const CAMERA_PRESET_HEIGHTS = {
  overview: 5_000,
  far: 10_000,
  near: 300,
} as const;

type ViewerCameraState =
  | {
      engine: "cesium";
      longitudeDegrees: number;
      latitudeDegrees: number;
      heightMeters: number;
      headingDegrees: number;
      pitchDegrees: number;
      rollDegrees: number;
    }
  | { engine: "three"; state: DevThreeCameraState };

function getCopcUrl(): string {
  return (
    new URLSearchParams(window.location.search).get("source") ??
    DEFAULT_COPC_URL
  );
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
  transition: ReturnType<CopcCesiumLayer["getSnapshot"]>["transition"];
  viewDistance: ReturnType<CopcCesiumLayer["getSnapshot"]>["viewDistance"];
  streamingUpdateCount: number;
  cameraMoveEventCount: number;
  cameraPitchDegrees: number;
  cameraHeadingDegrees: number;
  cameraBasis: {
    position: { x: number; y: number; z: number };
    direction: { x: number; y: number; z: number };
    right: { x: number; y: number; z: number };
    up: { x: number; y: number; z: number };
  };
  minRenderedHeight?: number;
  maxRenderedHeight?: number;
  renderedColorCount: number;
  lastError?: string;
  backend: CopcBackendName | "custom";
  performance: ReturnType<CopcCesiumLayer["getSnapshot"]>["performance"];
  pointCache: ReturnType<CopcCesiumLayer["getSnapshot"]>["pointCache"];
  rangeRequests: ReturnType<CopcCesiumLayer["getSnapshot"]>["rangeRequests"];
  predictivePrefetch?: ReturnType<
    CopcCesiumLayer["getSnapshot"]
  >["predictivePrefetch"];
  hierarchy: ReturnType<CopcCesiumLayer["getHierarchyDiagnostics"]>;
  worker?: ReturnType<CopcCesiumLayer["getSnapshot"]>["worker"];
  longestMainThreadTaskMs: number;
  cesiumFrameDurationMs: number;
  selectedPoint?: ReturnType<CopcCesiumLayer["getSelectedPoint"]>;
};

function isDebugPanelEnabled(): boolean {
  const value = new URLSearchParams(window.location.search).get("debugPanel");

  return value === null || !["0", "false", "off"].includes(value.toLowerCase());
}

type CopcDebugAdapter = {
  activate(): void;
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
  probePublicBatchPick(): {
    picked: boolean;
    pickedNodeKey?: string;
    pointIndex?: number;
  };
  probePublicBatchCpuPick(
    offsetPx?: number,
    clickTolerancePx?: number,
  ):
    | (CpuPointPickProbe & {
        targetPointIndex?: number;
        targetWorldPosition?: [number, number, number];
      })
    | { picked: false };
  runCpuBatchedPickingProbe(): Promise<Record<string, unknown>>;
  runCpuBatchedPickingStress(): Promise<Record<string, unknown>>;
  setPublicBatchVisibility(show: boolean): void;
  clearPublicBatchNodes(): number;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
  destroy(): void;
};

type ViewerSession = {
  renderer: RenderingEngine;
  ready: Promise<void>;
  debugAdapter?: CopcDebugAdapter;
  getSnapshot(): CopcCesiumLayerSnapshot | CopcThreeLayerSnapshot;
  getMetadata(): CopcMetadata | undefined;
  getHierarchyDiagnostics(): CopcHierarchyDiagnostics | undefined;
  getSelectedPoint(): CopcPointInspection | undefined;
  terrainSourceStatus: string;
  estimateTerrainHeightAlignment?(
    anchor: CopcPointInspection,
    options?: TerrainHeightAlignmentOptions,
  ): Promise<TerrainHeightAlignmentEstimate>;
  isTerrainHeightAlignmentEstimateCurrent?(
    estimate: TerrainHeightAlignmentEstimate,
  ): boolean;
  setCameraPreset(preset: CameraPreset): void;
  setCameraRenderDistance(distance: number): void;
  getCameraState(): ViewerCameraState;
  setCameraState(state: ViewerCameraState): void;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
  getStyle(): CopcCesiumPointStyle;
  setStyle?(update: CopcCesiumPointStyleUpdate): void;
  destroy(): void;
};

declare global {
  interface Window {
    __COPC_DEV_VIEWER__?: {
      getSnapshot():
        | CopcCesiumLayerSnapshot
        | CopcThreeLayerSnapshot
        | undefined;
      getSelectedPoint(): CopcPointInspection | undefined;
      getPickablePointScreenPosition(): { x: number; y: number } | undefined;
      getConfiguration(): Omit<Readonly<DevViewerConfig>, "source" | "terrainUrl"> & {
        source: string;
        terrainSource: string;
      };
      getPendingConfiguration(): Omit<Readonly<DevViewerConfig>, "source" | "terrainUrl"> & {
        source: string;
        terrainSource: string;
      };
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

  for (const collection of getPointPrimitiveCollections(
    viewer.scene.primitives,
  )) {
    const stride = Math.max(1, Math.floor(collection.length / 256));

    for (
      let pointIndex = 0;
      pointIndex < collection.length;
      pointIndex += stride
    ) {
      const point = collection.get(pointIndex);
      const height = Cesium.Cartographic.fromCartesian(point.position).height;

      minRenderedHeight = Math.min(minRenderedHeight, height);
      maxRenderedHeight = Math.max(maxRenderedHeight, height);
      colors.add(
        [
          point.color.red.toFixed(3),
          point.color.green.toFixed(3),
          point.color.blue.toFixed(3),
        ].join(","),
      );
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
  researchRenderer?: BatchedGeometryPointRenderer,
  rangeValidation: RangeValidationPolicy = "head-fallback",
): CopcDebugAdapter {
  let cameraMoveEventCount = 0;
  let lastError: string | undefined;
  let longestMainThreadTaskMs = 0;
  let cesiumFrameDurationMs = 0;
  let cesiumFrameStartedAt = 0;
  let performanceObserver: PerformanceObserver | undefined;
  let destroyed = false;
  let listenersRegistered = false;

  if (typeof PerformanceObserver !== "undefined") {
    try {
      performanceObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longestMainThreadTaskMs = Math.max(
            longestMainThreadTaskMs,
            entry.duration,
          );
        }
      });
      performanceObserver.observe({ type: "longtask", buffered: true });
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
    lastError = safeErrorMessage(error);
  };

  const onWindowError = (event: ErrorEvent): void => {
    recordError(event.error ?? event.message);
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    recordError(event.reason);
  };
  const adapter: CopcDebugAdapter = {
    activate(): void {
      if (destroyed || listenersRegistered) return;
      listenersRegistered = true;
      if (import.meta.env.DEV) {
        window.addEventListener("error", onWindowError);
        window.addEventListener("unhandledrejection", onUnhandledRejection);
      }
    },
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
        layerLoaded: snapshot.lifecycle === "ready",
        datasetUrl: getSafeSourceLabel(
          snapshot.datasetUrl,
          window.location.href,
        ),
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
        cameraHeadingDegrees: Cesium.Math.toDegrees(viewer.camera.heading),
        cameraBasis: {
          position: {
            x: viewer.camera.positionWC.x,
            y: viewer.camera.positionWC.y,
            z: viewer.camera.positionWC.z,
          },
          direction: {
            x: viewer.camera.directionWC.x,
            y: viewer.camera.directionWC.y,
            z: viewer.camera.directionWC.z,
          },
          right: {
            x: viewer.camera.rightWC.x,
            y: viewer.camera.rightWC.y,
            z: viewer.camera.rightWC.z,
          },
          up: {
            x: viewer.camera.upWC.x,
            y: viewer.camera.upWC.y,
            z: viewer.camera.upWC.z,
          },
        },
        ...pointDiagnostics,
        backend: snapshot.backend,
        performance: snapshot.performance,
        pointCache: snapshot.pointCache,
        rangeRequests: snapshot.rangeRequests,
        predictivePrefetch: snapshot.predictivePrefetch,
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
    probeSource: (source) => probeCopcSource(source, { rangeValidation }),
    runSyntheticRendererPerformanceBenchmark: (renderer = "point-primitive") =>
      runSyntheticRendererPerformanceBenchmark({
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
      const probe = researchRenderer.probeCpuPointPick(
        viewer.scene,
        probePosition,
        clickTolerancePx,
      );
      return {
        ...probe,
        targetPointIndex: target.targetSourcePointIndex,
        targetWorldPosition: target.worldPosition,
      };
    },
    runCpuBatchedPickingProbe: () =>
      researchRenderer
        ? runCpuBatchedPickingProbe(viewer, researchRenderer)
        : Promise.resolve({
            skipped: true,
            reason: "public-batched-renderer-not-active",
          }),
    runCpuBatchedPickingStress: () =>
      researchRenderer
        ? runCpuBatchedPickingStress(viewer, researchRenderer)
        : Promise.resolve({
            skipped: true,
            reason: "public-batched-renderer-not-active",
          }),
    setPublicBatchVisibility: (show) => researchRenderer?.setShow(show),
    clearPublicBatchNodes: () => {
      researchRenderer?.clear();
      return researchRenderer?.getRenderedNodeKeys().length ?? -1;
    },
    getPickablePointScreenPosition(): { x: number; y: number } | undefined {
      const canvasBounds = viewer.scene.canvas.getBoundingClientRect();
      const blockingBounds = [
        ...document.querySelectorAll<HTMLElement>(
          ".dev-panel:not([hidden]), .dev-panel-toggle",
        ),
      ].map((element) => element.getBoundingClientRect());
      const isObscured = (position: { x: number; y: number }): boolean => {
        const x = canvasBounds.left + position.x;
        const y = canvasBounds.top + position.y;
        return blockingBounds.some(
          (bounds) =>
            x >= bounds.left &&
            x <= bounds.right &&
            y >= bounds.top &&
            y <= bounds.bottom,
        );
      };

      if (researchRenderer) {
        for (const nodeKey of researchRenderer.getRenderedNodeKeys()) {
          const candidate = researchRenderer.probePick(viewer.scene, nodeKey);
          if (
            !candidate.picked ||
            !candidate.screenPosition ||
            candidate.screenPosition.x < 380 ||
            candidate.screenPosition.x > viewer.scene.canvas.clientWidth - 4 ||
            candidate.screenPosition.y < 4 ||
            candidate.screenPosition.y > viewer.scene.canvas.clientHeight - 4 ||
            isObscured(candidate.screenPosition)
          ) {
            continue;
          }
          const position = new Cesium.Cartesian2(
            candidate.screenPosition.x,
            candidate.screenPosition.y,
          );
          const picked = viewer.scene.pick(position, 1, 1);
          const resolved = researchRenderer.resolvePointPick(
            viewer.scene,
            position,
            picked,
          );
          if (
            resolved?.nodeKey === nodeKey &&
            resolved.pointIndex === candidate.targetSourcePointIndex
          ) {
            return candidate.screenPosition;
          }
        }
        return undefined;
      }
      for (const collection of getPointPrimitiveCollections(
        viewer.scene.primitives,
      )) {
        for (
          let pointIndex = 0;
          pointIndex < collection.length;
          pointIndex += 1
        ) {
          const position = Cesium.SceneTransforms.worldToWindowCoordinates(
            viewer.scene,
            collection.get(pointIndex).position,
          );
          if (
            position &&
            position.x >= 380 &&
            position.x <= viewer.scene.canvas.clientWidth - 4 &&
            position.y >= 4 &&
            position.y <= viewer.scene.canvas.clientHeight - 4 &&
            !isObscured(position)
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
      if (listenersRegistered) {
        window.removeEventListener("error", onWindowError);
        window.removeEventListener("unhandledrejection", onUnhandledRejection);
      }
      if (window.__COPC_DEBUG__ === adapter) delete window.__COPC_DEBUG__;
    },
  };

  return adapter;
}

function getSelectedBackend(): CopcBackendName {
  return new URLSearchParams(window.location.search).get("backend") === "rust"
    ? "rust"
    : "copc-js";
}

function getLayerOptions(
  source: string | File = getCopcUrl(),
  config?: DevViewerConfig,
): ConstructorParameters<typeof CopcCesiumLayer>[0] {
  const params = new URLSearchParams(window.location.search);
  const heightOffsetParam = params.get("heightOffsetMeters");
  const requestedHeightOffset =
    heightOffsetParam === null ? undefined : Number(heightOffsetParam);
  const heightOffsetMeters = config?.heightOffsetMeters ??
    (Number.isFinite(requestedHeightOffset) ? requestedHeightOffset : undefined);
  const requestedBudget = Number(params.get("budget"));
  const maxRenderedPoints =
    Number.isSafeInteger(requestedBudget) && requestedBudget > 0
      ? requestedBudget
      : undefined;
  const cacheBytesParam = params.get("cacheBytes");
  const requestedCacheBytes =
    cacheBytesParam === null ? undefined : Number(cacheBytesParam);
  const maxPointCacheBytes =
    requestedCacheBytes !== undefined &&
    Number.isSafeInteger(requestedCacheBytes) &&
    requestedCacheBytes >= 0
      ? requestedCacheBytes
      : undefined;

  const scenario = params.get("scenario");
  const issueScenario = ["issue61", "issue59", "issue68", "issue128"].includes(
    scenario ?? "",
  );
  const issue128 = scenario === "issue128";
  const requestedDistance = Number(params.get("distance"));
  const scenarioMaxDistance = issue128
    ? Number.isFinite(requestedDistance) && requestedDistance > 0
      ? requestedDistance
      : 100
    : 20_000;
  const motionLookahead =
    config?.motionLookahead ??
    (issueScenario ? params.get("motionLookahead") !== "false" : undefined);
  const predictivePrefetch = issueScenario && params.get("prefetch") === "true";
  const requestedRefinementAlgorithm = params.get("refinementAlgorithm");
  const requestedRangeValidation = params.get("rangeValidation");
  const refinementAlgorithm = isRefinementAlgorithm(
    requestedRefinementAlgorithm,
  )
    ? requestedRefinementAlgorithm
    : "foveated";
  const rangeValidation = isRangeValidationPolicy(requestedRangeValidation)
    ? requestedRangeValidation
    : "head-fallback";
  return {
    url: source,
    colorMode: config?.colorMode ?? (issueScenario ? "elevation" : "rgb"),
    backend:
      config?.backend ??
      (issueScenario
        ? params.get("backend") === "copc-js"
          ? "copc-js"
          : "rust"
        : getSelectedBackend()),
    pointSize: config?.pointSize ?? (issueScenario ? 2 : 3),
    rangeValidation: config?.rangeValidation ?? rangeValidation,
    debug: true,
    ...(config
      ? { maxRenderedPoints: config.maxRenderedPoints }
      : issueScenario && maxRenderedPoints !== undefined
        ? { maxRenderedPoints }
        : {}),
    ...(issueScenario && maxPointCacheBytes !== undefined
      ? { maxPointCacheBytes }
      : {}),
    ...(heightOffsetMeters === undefined ? {} : { heightOffsetMeters }),
    streaming: {
      maxNodes: config?.maxNodes ?? (issueScenario ? (issue128 ? 16 : 32) : 24),
      maxDepth: config?.maxDepth ?? (issueScenario ? (issue128 ? 4 : 6) : 6),
      maxScreenSpaceError: config?.maxScreenSpaceError ?? 8,
      maxRenderDistanceMeters:
        config?.maxRenderDistance ??
        (issueScenario ? scenarioMaxDistance : 12_000),
      refinementAlgorithm: config?.refinementAlgorithm ?? refinementAlgorithm,
      ...(motionLookahead === undefined ? {} : { motionLookahead }),
      ...(predictivePrefetch ? { predictivePrefetch: true } : {}),
    },
  };
}

function getScenePointCollectionCount(viewer: Cesium.Viewer): number {
  let count = 0;

  for (const _collection of getPointPrimitiveCollections(
    viewer.scene.primitives,
  )) {
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

const AUTZEN_REMOTE_URL =
  "https://data.pointcloud.org/autzen/autzen-classified.copc.laz";
const CHICAGO_REMOTE_URL =
  "https://data.pointcloud.org/chicago-downtown/chicago-downtown.copc.laz";

function getElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element)
    throw new Error(`Dev Viewer is missing required element: ${selector}`);
  return element;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&][^=\s]+)=([^&\s]+)/g, "$1=[redacted]");
}

async function createCesiumSession(
  container: HTMLElement,
  config: DevViewerConfig,
  onError: (error: unknown) => void,
  onPointPicked: (point: CopcPointInspection | undefined) => void,
): Promise<ViewerSession> {
  const params = new URLSearchParams(window.location.search);
  const usePublicBatchedRenderer = config.cesiumRenderer === "batched-geometry";
  const testHighDpiRendering = params.get("testDpr") === "1";
  let ellipsoidalTerrainFixture:
    | { backend: CopcBackendSelection; decoder: CopcPointDecoder }
    | undefined;
  if (
    import.meta.env.DEV &&
    params.get("terrainEllipsoidalFixture") === "1"
  ) {
    const { createDevEllipsoidalTerrainFixture } = await import(
      "./devEllipsoidalTerrainFixture"
    );
    ellipsoidalTerrainFixture = createDevEllipsoidalTerrainFixture();
  }
  let terrainProvider: Cesium.TerrainProvider | undefined;
  let terrainSourceStatus =
    "WGS84 ellipsoid only · imagery may still be shown; no terrain elevations are available.";
  const testTerrainFixture = params.get("terrainFixtureHeight");
  if (import.meta.env.DEV && testTerrainFixture !== null) {
    const height = Number(testTerrainFixture);
    if (Number.isFinite(height)) {
      const { createDevTerrainFixture } = await import("./devTerrainFixture");
      terrainProvider = createDevTerrainFixture(height);
      terrainSourceStatus = "Deterministic browser-test Terrain fixture.";
    }
  } else if (config.terrainUrl.trim()) {
    try {
      terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(
        getCesiumTerrainProviderUrl(config.terrainUrl, window.location.href),
      );
      terrainSourceStatus =
        "Real Cesium Terrain · " +
        getSafeTerrainSourceLabel(config.terrainUrl, window.location.href);
    } catch {
      terrainSourceStatus =
        "Terrain unavailable · using the WGS84 ellipsoid; imagery may still be shown.";
    }
  }
  const viewer = createCesiumViewer(container, {
    scene3DOnly: usePublicBatchedRenderer,
    ...(testHighDpiRendering ? { useBrowserRecommendedResolution: false } : {}),
    ...(terrainProvider ? { terrainProvider } : {}),
  });
  const researchRenderer = usePublicBatchedRenderer
    ? new BatchedGeometryPointRenderer()
    : undefined;
  const layer = new CopcCesiumLayer({
    ...getLayerOptions(config.source, config),
    renderer: researchRenderer ?? new PointPrimitiveRenderer(),
    onPointPicked,
    ...(ellipsoidalTerrainFixture
      ? {
          backend: ellipsoidalTerrainFixture.backend,
          decoder: ellipsoidalTerrainFixture.decoder,
        }
      : {}),
  });
  const debugAdapter = installDebugAdapter(
    viewer,
    layer,
    researchRenderer,
    config.rangeValidation,
  );
  const ready = layer
    .load()
    .then(() => {
      layer.attachTo(viewer);
      return layer.getSnapshot();
    })
    .catch((error: unknown) => {
      debugAdapter.recordError(error);
      onError(error);
      throw error;
    });

  return {
    renderer: "cesium",
    terrainSourceStatus,
    ready: ready.then(() => undefined),
    debugAdapter,
    getSnapshot: () => layer.getSnapshot(),
    getMetadata: () => layer.getMetadata(),
    getHierarchyDiagnostics: () => layer.getHierarchyDiagnostics(),
    getSelectedPoint: () => layer.getSelectedPoint(),
    estimateTerrainHeightAlignment: (anchor, options = {}) =>
      layer.estimateTerrainHeightAlignment(anchor, {
        ...options,
        terrainSourceId: config.terrainUrl.trim()
          ? getSafeTerrainSourceLabel(config.terrainUrl, window.location.href)
          : undefined,
      }),
    isTerrainHeightAlignmentEstimateCurrent: (estimate) =>
      layer.isTerrainHeightAlignmentEstimateCurrent(estimate),
    setCameraPreset(preset) {
      debugAdapter.setCameraPreset(preset);
    },
    setCameraRenderDistance(distance) {
      moveCameraToHeight(viewer, distance);
    },
    getCameraState(): ViewerCameraState {
      const position = viewer.camera.positionCartographic;
      return {
        engine: "cesium",
        longitudeDegrees: Cesium.Math.toDegrees(position.longitude),
        latitudeDegrees: Cesium.Math.toDegrees(position.latitude),
        heightMeters: position.height,
        headingDegrees: Cesium.Math.toDegrees(viewer.camera.heading),
        pitchDegrees: Cesium.Math.toDegrees(viewer.camera.pitch),
        rollDegrees: Cesium.Math.toDegrees(viewer.camera.roll),
      };
    },
    setCameraState(state) {
      if (state.engine !== "cesium") return;
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
          state.longitudeDegrees,
          state.latitudeDegrees,
          state.heightMeters,
        ),
        orientation: {
          heading: Cesium.Math.toRadians(state.headingDegrees),
          pitch: Cesium.Math.toRadians(state.pitchDegrees),
          roll: Cesium.Math.toRadians(state.rollDegrees),
        },
      });
      viewer.camera.moveEnd.raiseEvent();
    },
    getPickablePointScreenPosition: () =>
      debugAdapter.getPickablePointScreenPosition(),
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
  config: DevViewerConfig,
  onError: (error: unknown) => void,
): ViewerSession {
  const viewer: DevThreeViewer = createDevThreeViewer({
    container,
    source: config.source,
    sourceName: getSafeSourceLabel(config.source, window.location.href),
    backend: config.backend,
    colorMode: config.colorMode,
    pointSize: config.pointSize,
    maxRenderedPoints: config.maxRenderedPoints,
    cameraRenderDistance: config.cameraRenderDistance,
    rangeValidation: config.rangeValidation,
    streaming: {
      maxNodes: config.maxNodes,
      maxDepth: config.maxDepth,
      maxScreenSpaceError: config.maxScreenSpaceError,
      maxRenderDistanceMeters: config.maxRenderDistance,
      refinementAlgorithm: config.refinementAlgorithm,
      motionLookahead: config.motionLookahead,
    },
    onPointPicked: () => undefined,
    onError,
  });
  return {
    renderer: "three",
    terrainSourceStatus:
      "Three.js renderer · the dev-viewer Cesium Terrain provider is not used.",
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
    getCameraState(): ViewerCameraState {
      return { engine: "three", state: viewer.getCameraState() };
    },
    setCameraState(state) {
      if (state.engine === "three") viewer.setCameraState(state.state);
    },
    getPickablePointScreenPosition: () =>
      viewer.getPickablePointScreenPosition(),
    getStyle: () => ({ colorMode: config.colorMode }),
    destroy: () => viewer.destroy(),
  };
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const initialOptions = getLayerOptions();
  const initialStreaming = initialOptions.streaming;
  const initialSource = getCopcUrl();
  const requestedEngine = params.get("renderer");
  const renderer: RenderingEngine =
    requestedEngine === "three" ? "three" : "cesium";
  const requestedCesiumRenderer = params.get("cesiumRenderer");
  const publicBatchedQuery = requestedEngine === "public-batched";
  const cesiumRenderer: CesiumPointRendererVariant =
    requestedCesiumRenderer === "batched-geometry" ||
    (requestedCesiumRenderer === null && publicBatchedQuery)
      ? "batched-geometry"
      : "point-primitive";
  const startupIssues = new Map<string, string>();
  const reportStartupIssue = (key: string, message: string): void => {
    startupIssues.set(key, message);
  };
  if (
    requestedEngine !== null &&
    requestedEngine !== "cesium" &&
    requestedEngine !== "three" &&
    requestedEngine !== "public-batched"
  ) {
    reportStartupIssue(
      "renderer",
      'Unknown rendering engine selection; choose "cesium" or "three".',
    );
  }
  const requestedBackend = params.get("backend");
  if (
    requestedBackend !== null &&
    requestedBackend !== "copc-js" &&
    requestedBackend !== "rust"
  ) {
    reportStartupIssue(
      "backend",
      'Unknown backend selection; choose "copc-js" or "rust".',
    );
  }
  const requestedRefinementAlgorithm = params.get("refinementAlgorithm");
  if (
    requestedRefinementAlgorithm !== null &&
    !isRefinementAlgorithm(requestedRefinementAlgorithm)
  ) {
    reportStartupIssue(
      "refinementAlgorithm",
      'Unknown refinement algorithm; choose "foveated" or "screen-projection", then apply settings.',
    );
  }
  const requestedRangeValidation = params.get("rangeValidation");
  if (
    requestedRangeValidation !== null &&
    !isRangeValidationPolicy(requestedRangeValidation)
  ) {
    reportStartupIssue(
      "rangeValidation",
      'Unknown HTTP Range validation policy; choose "head-fallback" or "strict", then apply settings.',
    );
  }
  if (
    requestedCesiumRenderer !== null &&
    requestedCesiumRenderer !== "point-primitive" &&
    requestedCesiumRenderer !== "batched-geometry"
  ) {
    reportStartupIssue(
      "cesiumRenderer",
      'Unknown Cesium point renderer; choose "point-primitive" or "batched-geometry".',
    );
  }

  const getThreePresetBase = (source: string | File): number => {
    const label = getSafeSourceLabel(source, window.location.href);
    return /chicago/i.test(label)
      ? 14_000
      : /autzen/i.test(label)
        ? 1_500
        : 3_000;
  };
  const presetDistance = (
    engine: RenderingEngine,
    source: string | File,
    preset: CameraPreset,
  ): number => {
    if (engine === "cesium") return CAMERA_PRESET_HEIGHTS[preset];
    const base = getThreePresetBase(source);
    return preset === "near"
      ? base * 0.55
      : preset === "far"
        ? base * 2.5
        : base;
  };
  const requestedCameraPreset = params.get("cameraPreset");
  const validCameraPreset =
    requestedCameraPreset === "overview" ||
    requestedCameraPreset === "far" ||
    requestedCameraPreset === "near";
  if (requestedCameraPreset !== null && !validCameraPreset) {
    reportStartupIssue(
      "cameraPreset",
      "Unknown camera preset; choose overview, far, or near.",
    );
  }
  const cameraPreset: CameraPreset = validCameraPreset
    ? requestedCameraPreset
    : "overview";
  const defaultCameraDistance =
    renderer === "three"
      ? getThreePresetBase(initialSource)
      : /chicago/i.test(getSafeSourceLabel(initialSource, window.location.href))
        ? 14_000
        : 5_000;
  const useEllipsoidalTerrainSourceFixture =
    import.meta.env.DEV &&
    params.get("terrainEllipsoidalFixture") === "1";
  const configuredSource = useEllipsoidalTerrainSourceFixture
    ? new File(["test fixture"], "ellipsoidal-terrain-fixture.copc.laz")
    : initialSource;
  const cameraDistanceParam = params.get("cameraDistance");
  const requestedCameraDistance =
    cameraDistanceParam === null ? undefined : Number(cameraDistanceParam);
  if (
    requestedCameraDistance !== undefined &&
    (!Number.isFinite(requestedCameraDistance) || requestedCameraDistance <= 0)
  ) {
    reportStartupIssue(
      "cameraDistance",
      "cameraDistance must be a positive number of metres.",
    );
  }

  const activeInitialConfig: DevViewerConfig = {
    renderer,
    cesiumRenderer,
    backend:
      initialOptions.backend === "rust" || initialOptions.backend === "copc-js"
        ? initialOptions.backend
        : getSelectedBackend(),
    refinementAlgorithm:
      initialOptions.streaming?.refinementAlgorithm ?? "foveated",
    motionLookahead: initialOptions.streaming?.motionLookahead ?? true,
    rangeValidation: initialOptions.rangeValidation ?? "head-fallback",
    source: configuredSource,
    colorMode: initialOptions.colorMode ?? "rgb",
    pointSize: initialOptions.pointSize ?? 3,
    maxNodes: initialStreaming?.maxNodes ?? 24,
    maxRenderedPoints:
      initialOptions.maxRenderedPoints ??
      initialStreaming?.maxRenderedPoints ??
      250_000,
    maxDepth: initialStreaming?.maxDepth ?? 6,
    maxScreenSpaceError: initialStreaming?.maxScreenSpaceError ?? 8,
    cameraPreset,
    cameraRenderDistance:
      requestedCameraDistance ??
      (requestedCameraPreset
        ? presetDistance(renderer, initialSource, cameraPreset)
        : defaultCameraDistance),
    maxRenderDistance: initialStreaming?.maxRenderDistanceMeters ?? 12_000,
    heightOffsetMeters: initialOptions.heightOffsetMeters ?? 0,
    terrainUrl: "",
  };
  let activeConfig = { ...activeInitialConfig };
  let pendingConfig = { ...activeConfig };
  let activeSession: ViewerSession | undefined;
  let activeMount: HTMLElement | undefined;
  let stagedSession: ViewerSession | undefined;
  let stagedMount: HTMLElement | undefined;
  let activeDebugAdapter: CopcDebugAdapter | undefined;
  let sourceProbe: CopcSourceProbeResult | undefined;
  let sourceProbePolicy: RangeValidationPolicy | undefined;
  let lastSnapshot:
    | CopcCesiumLayerSnapshot
    | CopcThreeLayerSnapshot
    | undefined;
  let lastError: string | undefined;
  let configurationError = startupIssues.values().next().value as
    | string
    | undefined;
  let generation = 0;
  let isLoading = false;
  let probeAbortController: AbortController | undefined;
  let disposed = false;

  const getPendingDebugState = (): CopcDebugState => ({
    cesiumVersion: cesiumRuntimeVersion,
    viewerReady: false,
    layerLoaded: false,
    datasetUrl: getSafeSourceLabel(activeConfig.source, window.location.href),
    renderedPointCount: 0,
    scenePointCollectionCount: 0,
    renderedNodeKeys: [],
    selectedNodeKeys: [],
    transition: {} as CopcDebugState["transition"],
    viewDistance: undefined,
    streamingUpdateCount: 0,
    cameraMoveEventCount: 0,
    cameraPitchDegrees: 0,
    cameraHeadingDegrees: 0,
    cameraBasis: {
      position: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      right: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
    },
    renderedColorCount: 0,
    backend: activeConfig.backend,
    performance: {} as CopcDebugState["performance"],
    pointCache: {} as CopcDebugState["pointCache"],
    rangeRequests: {} as CopcDebugState["rangeRequests"],
    hierarchy: {} as CopcDebugState["hierarchy"],
    longestMainThreadTaskMs: 0,
    cesiumFrameDurationMs: 0,
  });

  const debugAdapterProxy = new Proxy({} as CopcDebugAdapter, {
    get(_target, property) {
      if (property === "getState") {
        return () => activeDebugAdapter?.getState() ?? getPendingDebugState();
      }
      if (property === "probeSource") {
        return (source: string) =>
          probeCopcSource(source, {
            rangeValidation: activeConfig.rangeValidation,
          });
      }
      if (!activeDebugAdapter) {
        return () => {
          throw new Error(
            "The Cesium debug adapter is available after a Cesium session loads.",
          );
        };
      }
      const value = Reflect.get(
        activeDebugAdapter,
        property,
        activeDebugAdapter,
      ) as unknown;
      return typeof value === "function"
        ? value.bind(activeDebugAdapter)
        : value;
    },
  });
  if (import.meta.env.DEV || import.meta.env.MODE === "benchmark") {
    window.__COPC_DEBUG__ = debugAdapterProxy;
  }

  const container = getElement<HTMLElement>("#cesium-container");
  const controlsPanel = getElement<HTMLElement>("#controls-panel");
  const loadButton = getElement<HTMLButtonElement>("#load-source");
  const applySettingsButton = getElement<HTMLButtonElement>("#apply-settings");
  const reloadCurrentSourceButton = getElement<HTMLButtonElement>(
    "#reload-current-source",
  );
  const configurationState = getElement<HTMLElement>("#configuration-state");
  const configurationErrorElement = getElement<HTMLElement>(
    "#configuration-error",
  );
  const packageVersion = getElement<HTMLElement>("#package-version");
  const cesiumRendererGroup = getElement<HTMLElement>(
    "#cesium-point-renderer-group",
  );
  const terrainUrlInput = getElement<HTMLInputElement>("#terrain-url");
  const terrainSourceStatus = getElement<HTMLElement>("#terrain-source-status");
  const groundConfirmation = getElement<HTMLInputElement>("#ground-confirmation");
  const estimateTerrainButton = getElement<HTMLButtonElement>("#estimate-terrain");
  const cancelTerrainButton = getElement<HTMLButtonElement>("#cancel-terrain-estimate");
  const applyTerrainButton = getElement<HTMLButtonElement>("#apply-terrain-estimate");
  const terrainPreview = getElement<HTMLElement>("#terrain-estimate-preview");
  terrainUrlInput.value = activeConfig.terrainUrl;
  let terrainEstimate: TerrainHeightAlignmentEstimate | undefined;
  let terrainEstimateAbortController: AbortController | undefined;
  let terrainEstimateInFlight = false;
  packageVersion.textContent =
    "v" + __COPC_ADAPTER_VERSION__ + " · workspace package";
  let inspectorExpanded = isDebugPanelEnabled();
  let setInspectorPolling: ((enabled: boolean) => void) | undefined;

  const panelLayout = mountWorkbenchPanels({
    controls: {
      panel: getElement<HTMLElement>("#controls-panel"),
      toggle: getElement<HTMLButtonElement>("#controls-toggle"),
      label: "Controls",
      expandedInitially: true,
    },
    inspector: {
      panel: getElement<HTMLElement>("#inspector-panel"),
      toggle: getElement<HTMLButtonElement>("#inspector-toggle"),
      label: "Inspector",
      expandedInitially: inspectorExpanded,
      onExpandedChange(expanded) {
        inspectorExpanded = expanded;
        setInspectorPolling?.(expanded);
      },
    },
  });

  const sameSource = (left: string | File, right: string | File): boolean => {
    if (typeof left === "string" || typeof right === "string") {
      return (
        typeof left === "string" && typeof right === "string" && left === right
      );
    }
    return left === right;
  };
  const publicConfig = (config: DevViewerConfig) => {
    const { terrainUrl, ...safeConfig } = config;
    return {
      ...safeConfig,
      source: getSafeSourceLabel(config.source, window.location.href),
      terrainSource: getSafeTerrainSourceLabel(
        terrainUrl,
        window.location.href,
      ),
    };
  };
  const updateStatus = (
    message: string,
    tone: "loading" | "ready" | "error" | "inactive",
  ): void => {
    status.textContent = message;
    status.dataset.status = tone;
  };
  const updateTerrainAlignmentUi = (): void => {
    const selectedPoint = activeSession?.renderer === "cesium"
      ? activeSession.getSelectedPoint()
      : undefined;
    const estimateIsCurrent =
      terrainEstimate !== undefined &&
      activeSession?.isTerrainHeightAlignmentEstimateCurrent?.(terrainEstimate) === true;
    terrainSourceStatus.textContent =
      activeSession?.terrainSourceStatus ??
      (activeConfig.terrainUrl.trim()
        ? "Terrain source is not active yet. Apply Settings to load it."
        : "WGS84 ellipsoid only · imagery may still be shown; no terrain elevations are available.");
    estimateTerrainButton.disabled =
      isLoading ||
      terrainEstimateInFlight ||
      !selectedPoint ||
      activeSession?.renderer !== "cesium" ||
      !activeSession?.estimateTerrainHeightAlignment;
    cancelTerrainButton.disabled = !terrainEstimateInFlight;
    applyTerrainButton.disabled =
      isLoading ||
      terrainEstimateInFlight ||
      !terrainEstimate?.actionable ||
      terrainEstimate.status !== "ready" ||
      !estimateIsCurrent;

    if (!terrainEstimate) {
      terrainPreview.textContent = selectedPoint
        ? [
            "Selected COPC point (no Terrain request yet)",
            `Node / index: ${selectedPoint.nodeKey} / ${selectedPoint.pointIndex}`,
            `Classification: ${selectedPoint.classificationLabel ?? selectedPoint.classification ?? "not available"}`,
            `Source XYZ: ${selectedPoint.source ? `${selectedPoint.source.x}, ${selectedPoint.source.y}, ${selectedPoint.source.z}` : "not available"}`,
            `Displayed COPC height value (reference subject to validation): ${Number.isFinite(selectedPoint.height) ? `${selectedPoint.height.toFixed(3)} m` : "invalid"}`,
            "Confirm that this is a ground point before estimating.",
          ].join("\n")
        : "Select a point from the loaded COPC layer to begin.";
      return;
    }

    const estimateAnchor = terrainEstimate.anchor;
    const lines = [
      `Estimate status: ${terrainEstimate.status}${estimateIsCurrent ? " (current)" : " (stale; estimate again)"}`,
      `COPC source: ${terrainEstimate.sourceId ?? "not identified"}`,
      `Anchor: ${estimateAnchor ? `${estimateAnchor.longitudeDegrees.toFixed(7)}°, ${estimateAnchor.latitudeDegrees.toFixed(7)}° · ${estimateAnchor.nodeKey}/${estimateAnchor.pointIndex}` : "not selected"}`,
      `Source XYZ: ${estimateAnchor?.source ? `${estimateAnchor.source.x}, ${estimateAnchor.source.y}, ${estimateAnchor.source.z}` : "not available"}`,
      `Current displayed COPC height: ${estimateAnchor && Number.isFinite(estimateAnchor.displayedHeightMeters) ? `${estimateAnchor.displayedHeightMeters.toFixed(3)} m` : "invalid or unavailable"}`,
      `Sampled Terrain height: ${terrainEstimate.terrainHeightMeters === undefined ? "unavailable" : `${terrainEstimate.terrainHeightMeters.toFixed(3)} m`}`,
      `Proposed adjustment (Terrain − COPC): ${terrainEstimate.proposedOffsetMeters === undefined ? "unavailable" : `${terrainEstimate.proposedOffsetMeters.toFixed(3)} m`}`,
      `Existing manual heightOffsetMeters: ${terrainEstimate.existingHeightOffsetMeters.toFixed(3)} m`,
      `Effective offset after approval: ${terrainEstimate.effectiveProposedHeightOffsetMeters === undefined ? "unavailable" : `${terrainEstimate.effectiveProposedHeightOffsetMeters.toFixed(3)} m`}`,
      `Vertical reference: ${terrainEstimate.verticalReference.sourceVerticalCrs ?? "not declared"} → ${terrainEstimate.verticalReference.displayHeightReference} (${terrainEstimate.verticalReference.conversion})`,
      `Terrain provider: ${terrainEstimate.terrainProvider?.type ?? "not available"}${terrainEstimate.terrainSourceId ? ` · ${terrainEstimate.terrainSourceId}` : ""}`,
      `Sampling: ${terrainEstimate.terrainSamplingCalls} call${terrainEstimate.terrainSamplingCalls === 1 ? "" : "s"}${terrainEstimate.samplingDurationMs === undefined ? "" : ` · ${terrainEstimate.samplingDurationMs.toFixed(1)} ms`}`,
      ...(terrainEstimate.rejectionReason ? [`Unavailable: ${terrainEstimate.rejectionReason}`] : []),
      ...terrainEstimate.warnings.map((warning) => `Warning: ${warning}`),
    ];
    terrainPreview.textContent = lines.join("\n");
  };
  const updateConfigurationState = (): void => {
    const dirty = hasUnappliedSettings(activeConfig, pendingConfig);
    const selectedSourceDiffers = !sameSource(
      activeConfig.source,
      pendingConfig.source,
    );
    configurationState.textContent = dirty
      ? "Settings not applied"
      : selectedSourceDiffers
        ? "Settings applied · selected source differs"
        : "Settings applied";
    configurationState.dataset.dirty = String(dirty);
    configurationErrorElement.textContent = configurationError ?? "";
    configurationErrorElement.hidden = !configurationError;
    applySettingsButton.disabled =
      isLoading || startupIssues.size > 0 || (!dirty && !configurationError);
    loadButton.disabled = isLoading || startupIssues.size > 0;
    reloadCurrentSourceButton.disabled = isLoading || !activeSession;
    controlsPanel
      .querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")
      .forEach((control) => {
        control.disabled = isLoading;
      });
    controlsPanel
      .querySelectorAll<HTMLButtonElement>(".ui-segmented button")
      .forEach((control) => {
        control.disabled = isLoading;
      });
    cesiumRendererGroup.hidden =
      activeConfig.renderer !== "cesium" && pendingConfig.renderer !== "cesium";
    updateTerrainAlignmentUi();
  };
  const showConfigurationError = (message: string): void => {
    configurationError = message;
    lastError = message;
    updateConfigurationState();
  };
  const resolveStartupIssue = (key: string): void => {
    if (!startupIssues.delete(key)) return;
    configurationError = startupIssues.values().next().value as
      | string
      | undefined;
    if (!configurationError) {
      lastError = undefined;
      if (!activeSession)
        updateStatus(
          "Configuration ready · load the selected source.",
          "inactive",
        );
    }
    updateConfigurationState();
  };
  const activeSnapshot = ():
    | CopcCesiumLayerSnapshot
    | CopcThreeLayerSnapshot => {
    const snapshot = activeSession?.getSnapshot() ?? lastSnapshot;
    if (!snapshot) {
      // The inspector only reads these fields until a real session exists.
      return {
        lifecycle: "idle",
        datasetUrl: getSafeSourceLabel(
          activeConfig.source,
          window.location.href,
        ),
        renderedNodeKeys: [],
        selectedNodeKeys: [],
        renderedPointCount: 0,
        streamingUpdateCount: 0,
      } as unknown as CopcCesiumLayerSnapshot;
    }
    return {
      ...snapshot,
      datasetUrl: getSafeSourceLabel(activeConfig.source, window.location.href),
    };
  };

  const debugPanel = createCopcDebugPanel(
    getElement<HTMLElement>("#inspector-content"),
    () => ({
      snapshot: activeSnapshot(),
      metadata: activeSession?.getMetadata(),
      hierarchy: activeSession?.getHierarchyDiagnostics(),
      sourceProbe,
      sourceProbePolicy,
      activeColorMode: activeConfig.colorMode,
      configuredRangeValidation: activeConfig.rangeValidation,
      rangeValidationApplicable: sourceSupportsHttpRange(
        activeConfig.source,
        window.location.href,
      ),
      selectedPoint: activeSession?.getSelectedPoint(),
      lastError:
        lastError ??
        (activeDebugAdapter?.getLastError()
          ? safeErrorMessage(activeDebugAdapter.getLastError())
          : undefined),
    }),
  );
  setInspectorPolling = (enabled) => debugPanel.setPollingEnabled(enabled);
  debugPanel.setPollingEnabled(inspectorExpanded);
  const status = getElement<HTMLElement>("#source-status");

  const setActiveError = (error: unknown): void => {
    lastError = safeErrorMessage(error);
    showConfigurationError(lastError);
    updateStatus(lastError, "error");
    debugPanel.refresh();
  };
  const reportProbeFailure = (
    result: CopcSourceProbeResult,
    policy: RangeValidationPolicy,
  ): Error => {
    if (result.reachable !== true || result.corsReadable !== true) {
      return new Error(
        "The browser could not read this HTTP source. Check the host, network access, and CORS response headers. See Source diagnostics for probe details.",
      );
    }
    if (result.rangeSupported !== true) {
      return new Error(
        'HTTP Range validation failed under "' +
          policy +
          '" policy (probe level: ' +
          result.validationLevel +
          "). The source was not loaded; see Source diagnostics for warnings.",
      );
    }
    if (result.copcDetected === false) {
      return new Error(
        "The readable HTTP source did not contain COPC metadata in the inspected prefix. Check the selected URL and see Source diagnostics.",
      );
    }
    return new Error(
      "The HTTP source probe could not establish a usable COPC source. See Source diagnostics for details.",
    );
  };

  async function runSession(
    config: DevViewerConfig,
    purpose: "apply" | "alignment" | "load" | "reload",
  ): Promise<void> {
    const currentGeneration = ++generation;
    terrainEstimateAbortController?.abort();
    terrainEstimateAbortController = undefined;
    terrainEstimateInFlight = false;
    terrainEstimate = undefined;
    isLoading = false;
    probeAbortController?.abort();
    probeAbortController = undefined;
    if (stagedSession) stagedSession.destroy();
    stagedSession = undefined;
    stagedMount?.remove();
    stagedMount = undefined;

    const validationError = validateDevViewerConfig(config);
    if (validationError) {
      showConfigurationError(validationError);
      updateStatus(validationError, "error");
      return;
    }
    if (typeof config.source === "string") {
      const trimmedSource = config.source.trim();
      if (!trimmedSource) {
        const message = "Enter a COPC URL before loading.";
        showConfigurationError(message);
        updateStatus(message, "error");
        return;
      }
      try {
        const sourceUrl = new URL(trimmedSource, window.location.href);
        if (sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") {
          throw new Error("unsupported protocol");
        }
      } catch {
        const message = "Enter a valid HTTP or HTTPS COPC URL.";
        showConfigurationError(message);
        updateStatus(message, "error");
        return;
      }
    }

    const recreate =
      purpose === "reload" ||
      !sameSource(activeConfig.source, config.source) ||
      needsSessionRecreation(
        activeConfig,
        config,
        Boolean(activeSession),
        sourceSupportsHttpRange(config.source, window.location.href),
      );
    const previousCamera = activeSession?.getCameraState();
    const previousPending = { ...pendingConfig };
    let candidateMount: HTMLElement | undefined;
    let candidateSession: ViewerSession | undefined;
    let candidateProbe: CopcSourceProbeResult | undefined;

    if (!recreate) {
      try {
        if (
          activeSession?.renderer === "cesium" &&
          activeConfig.colorMode !== config.colorMode
        ) {
          activeSession.setStyle?.({ colorMode: config.colorMode });
        }
        activeConfig = { ...config };
        if (purpose === "load") {
          pendingConfig = { ...config };
        } else if (purpose === "apply") {
          pendingConfig = { ...config, source: previousPending.source };
        } else if (purpose === "alignment") {
          pendingConfig = {
            ...previousPending,
            heightOffsetMeters: config.heightOffsetMeters,
          };
        } else {
          pendingConfig = previousPending;
        }
        configurationError = undefined;
        lastError = undefined;
        updateConfigurationState();
        debugPanel.refresh();
      } catch (error) {
        setActiveError(error);
      }
      return;
    }

    isLoading = true;
    configurationError = undefined;
    lastError = undefined;
    updateStatus("Checking source and preparing viewer…", "loading");
    updateConfigurationState();
    const controller = new AbortController();
    probeAbortController = controller;

    try {
      if (
        sourceSupportsHttpRange(config.source, window.location.href) &&
        typeof config.source === "string"
      ) {
        sourceProbePolicy = config.rangeValidation;
        sourceProbe = undefined;
        debugPanel.refresh();
        candidateProbe = await probeCopcSource(config.source, {
          rangeValidation: config.rangeValidation,
          signal: controller.signal,
        });
        if (currentGeneration !== generation || disposed) return;
        sourceProbe = candidateProbe;
        sourceProbePolicy = config.rangeValidation;
        debugPanel.refresh();
        if (
          candidateProbe.reachable !== true ||
          candidateProbe.corsReadable !== true ||
          candidateProbe.rangeSupported !== true ||
          candidateProbe.copcDetected === false
        ) {
          throw reportProbeFailure(candidateProbe, config.rangeValidation);
        }
      } else {
        sourceProbe = undefined;
        sourceProbePolicy = config.rangeValidation;
        debugPanel.refresh();
      }

      candidateMount = document.createElement("div");
      candidateMount.className = "dev-session-mount";
      candidateMount.style.visibility = "hidden";
      container.append(candidateMount);
      stagedMount = candidateMount;
      const reportCandidateError = (error: unknown): void => {
        if (currentGeneration !== generation || disposed) return;
        lastError = safeErrorMessage(error);
        updateStatus(lastError, "error");
        debugPanel.refresh();
      };
      candidateSession =
        config.renderer === "cesium"
          ? await createCesiumSession(
              candidateMount,
              config,
              reportCandidateError,
              () => {
                if (activeSession !== candidateSession) return;
                terrainEstimateAbortController?.abort();
                terrainEstimate = undefined;
                groundConfirmation.checked = false;
                updateTerrainAlignmentUi();
              },
            )
          : createThreeSession(candidateMount, config, reportCandidateError);
      stagedSession = candidateSession;
      await candidateSession.ready;
      if (currentGeneration !== generation || disposed) {
        candidateSession.destroy();
        candidateMount.remove();
        return;
      }

      if (
        previousCamera &&
        previousCamera.engine === candidateSession.renderer &&
        sameSource(activeConfig.source, config.source)
      ) {
        candidateSession.setCameraState(previousCamera);
      } else if (
        previousCamera &&
        previousCamera.engine !== candidateSession.renderer
      ) {
        candidateSession.setCameraRenderDistance(config.cameraRenderDistance);
      }

      candidateMount.style.visibility = "visible";
      activeDebugAdapter?.destroy();
      activeSession?.destroy();
      activeMount?.remove();
      activeSession = candidateSession;
      activeMount = candidateMount;
      stagedSession = undefined;
      stagedMount = undefined;
      activeDebugAdapter = candidateSession.debugAdapter;
      activeDebugAdapter?.activate();
      activeConfig = { ...config };
      if (purpose === "load") {
        pendingConfig = { ...config };
      } else if (purpose === "apply") {
        pendingConfig = { ...config, source: previousPending.source };
      } else if (purpose === "alignment") {
        pendingConfig = {
          ...previousPending,
          heightOffsetMeters: config.heightOffsetMeters,
        };
      } else {
        pendingConfig = previousPending;
      }
      lastSnapshot = candidateSession.getSnapshot();
      sourceProbe = candidateProbe;
      sourceProbePolicy = config.rangeValidation;
      configurationError = undefined;
      lastError = undefined;
      updateStatus(
        "Ready · " + getSafeSourceLabel(config.source, window.location.href),
        "ready",
      );
      debugPanel.refresh();
    } catch (error) {
      if (currentGeneration !== generation || disposed) {
        candidateSession?.destroy();
        candidateMount?.remove();
        return;
      }
      candidateSession?.destroy();
      candidateMount?.remove();
      if (stagedSession === candidateSession) stagedSession = undefined;
      if (stagedMount === candidateMount) stagedMount = undefined;
      lastError = safeErrorMessage(error);
      configurationError = lastError;
      updateStatus(lastError, "error");
      debugPanel.refresh();
    } finally {
      if (currentGeneration === generation && !disposed) {
        isLoading = false;
        probeAbortController = undefined;
        updateConfigurationState();
      }
    }
  }

  terrainUrlInput.addEventListener("input", () => {
    pendingConfig = { ...pendingConfig, terrainUrl: terrainUrlInput.value.trim() };
    updateConfigurationState();
  });
  groundConfirmation.addEventListener("change", updateTerrainAlignmentUi);
  estimateTerrainButton.addEventListener("click", () => {
    const session = activeSession;
    const anchor = session?.getSelectedPoint();
    if (
      !session ||
      session.renderer !== "cesium" ||
      !anchor ||
      !session.estimateTerrainHeightAlignment ||
      terrainEstimateInFlight
    ) {
      return;
    }
    const controller = new AbortController();
    terrainEstimateAbortController = controller;
    terrainEstimate = undefined;
    terrainEstimateInFlight = true;
    updateTerrainAlignmentUi();
    void session
      .estimateTerrainHeightAlignment(anchor, {
        groundConfirmed: groundConfirmation.checked,
        signal: controller.signal,
      })
      .then((estimate) => {
        if (
          activeSession !== session ||
          terrainEstimateAbortController !== controller ||
          disposed
        ) {
          return;
        }
        const currentAnchor = session.getSelectedPoint();
        const sameAnchor =
          currentAnchor !== undefined &&
          currentAnchor.ownerId === anchor.ownerId &&
          currentAnchor.nodeKey === anchor.nodeKey &&
          currentAnchor.pointIndex === anchor.pointIndex;
        if (
          sameAnchor &&
          (session.isTerrainHeightAlignmentEstimateCurrent?.(estimate) ||
            estimate.status === "cancelled")
        ) {
          terrainEstimate = estimate;
        }
      })
      .catch(() => {
        if (terrainEstimateAbortController === controller) {
          terrainPreview.textContent =
            "Terrain estimate failed. Check that the selected point and active Terrain provider are still available.";
        }
      })
      .finally(() => {
        if (terrainEstimateAbortController === controller) {
          terrainEstimateAbortController = undefined;
          terrainEstimateInFlight = false;
          updateTerrainAlignmentUi();
        }
      });
  });
  cancelTerrainButton.addEventListener("click", () => {
    if (!terrainEstimateAbortController) return;
    terrainEstimateAbortController.abort();
    terrainPreview.textContent =
      "Cancellation requested. Cesium may finish the current tile request before returning a cancelled result.";
    updateTerrainAlignmentUi();
  });
  applyTerrainButton.addEventListener("click", () => {
    const estimate = terrainEstimate;
    const session = activeSession;
    if (
      !estimate?.actionable ||
      estimate.status !== "ready" ||
      !session?.isTerrainHeightAlignmentEstimateCurrent?.(estimate) ||
      !Number.isFinite(estimate.effectiveProposedHeightOffsetMeters)
    ) {
      updateTerrainAlignmentUi();
      return;
    }
    const effectiveOffset = estimate.effectiveProposedHeightOffsetMeters!;
    terrainEstimate = undefined;
    void runSession(
      { ...activeConfig, heightOffsetMeters: effectiveOffset },
      "alignment",
    );
  });

  const workbenchControls = mountDevViewerControls({
    initialConfig: pendingConfig,
    sourcePresets: new Map<string, string>([
      ["local-autzen", DEFAULT_COPC_URL],
      ["autzen-remote", AUTZEN_REMOTE_URL],
      ["chicago-remote", CHICAGO_REMOTE_URL],
    ]),
    onEngineSelected(value) {
      resolveStartupIssue("renderer");
      const cameraRenderDistance = presetDistance(
        value,
        pendingConfig.source,
        pendingConfig.cameraPreset,
      );
      pendingConfig = {
        ...pendingConfig,
        renderer: value,
        cameraRenderDistance,
      };
      updateConfigurationState();
      return cameraRenderDistance;
    },
    onCesiumRendererSelected(value) {
      resolveStartupIssue("cesiumRenderer");
      pendingConfig = { ...pendingConfig, cesiumRenderer: value };
      updateConfigurationState();
    },
    onBackendSelected(value) {
      resolveStartupIssue("backend");
      pendingConfig = { ...pendingConfig, backend: value };
      updateConfigurationState();
    },
    onCameraPresetSelected(value) {
      resolveStartupIssue("cameraPreset");
      resolveStartupIssue("cameraDistance");
      const nextDistance = presetDistance(
        activeSession?.renderer ?? activeConfig.renderer,
        activeConfig.source,
        value,
      );
      activeSession?.setCameraPreset(value);
      activeConfig = {
        ...activeConfig,
        cameraPreset: value,
        cameraRenderDistance: nextDistance,
      };
      pendingConfig = {
        ...pendingConfig,
        cameraPreset: value,
        cameraRenderDistance: nextDistance,
      };
      updateConfigurationState();
      return nextDistance;
    },
    onColorModeSelected(value) {
      pendingConfig = { ...pendingConfig, colorMode: value };
      if (activeSession?.renderer === "cesium") {
        try {
          activeSession.setStyle?.({ colorMode: value });
          activeConfig = { ...activeConfig, colorMode: value };
          lastError = undefined;
          configurationError = undefined;
        } catch (error) {
          setActiveError(error);
        }
      }
      updateConfigurationState();
      debugPanel.refresh();
    },
    onRefinementAlgorithmSelected(value) {
      resolveStartupIssue("refinementAlgorithm");
      pendingConfig = { ...pendingConfig, refinementAlgorithm: value };
      updateConfigurationState();
    },
    onMotionLookaheadSelected(enabled) {
      pendingConfig = { ...pendingConfig, motionLookahead: enabled };
      updateConfigurationState();
    },
    onRangeValidationSelected(value) {
      resolveStartupIssue("rangeValidation");
      pendingConfig = { ...pendingConfig, rangeValidation: value };
      updateConfigurationState();
    },
    onPendingConfigChange(update) {
      pendingConfig = { ...pendingConfig, ...update };
      updateConfigurationState();
    },
    onCameraDistanceSelected(distance) {
      activeSession?.setCameraRenderDistance(distance);
      activeConfig = { ...activeConfig, cameraRenderDistance: distance };
      pendingConfig = { ...pendingConfig, cameraRenderDistance: distance };
      resolveStartupIssue("cameraDistance");
      configurationError = undefined;
      updateConfigurationState();
    },
    onInvalidCameraDistance() {
      showConfigurationError(
        "Camera distance must be a positive number of metres.",
      );
    },
    getCameraDistance: () => activeConfig.cameraRenderDistance,
  });

  loadButton.addEventListener("click", () => {
    const source = workbenchControls.getSelectedSource();
    if (source === undefined) {
      setActiveError(new Error("Choose a local COPC file before loading."));
      return;
    }
    pendingConfig = { ...pendingConfig, source };
    void runSession({ ...pendingConfig }, "load");
  });
  applySettingsButton.addEventListener("click", () => {
    const configForCurrentSource: DevViewerConfig = {
      ...pendingConfig,
      source: activeConfig.source,
    };
    void runSession(configForCurrentSource, "apply");
  });
  reloadCurrentSourceButton.addEventListener("click", () => {
    void runSession({ ...activeConfig }, "reload");
  });

  window.__COPC_DEV_VIEWER__ = {
    getSnapshot: () => {
      const snapshot = activeSession?.getSnapshot();
      return snapshot
        ? {
            ...snapshot,
            datasetUrl: getSafeSourceLabel(
              activeConfig.source,
              window.location.href,
            ),
          }
        : undefined;
    },
    getSelectedPoint: () => activeSession?.getSelectedPoint(),
    getPickablePointScreenPosition: () =>
      activeSession?.getPickablePointScreenPosition(),
    getConfiguration: () => publicConfig(activeConfig),
    getPendingConfiguration: () => publicConfig(pendingConfig),
  };

  window.addEventListener(
    "pagehide",
    () => {
      disposed = true;
      generation += 1;
      probeAbortController?.abort();
      debugPanel.destroy();
      panelLayout.destroy();
      workbenchControls.destroy();
      activeDebugAdapter?.destroy();
      stagedSession?.destroy();
      activeSession?.destroy();
      stagedMount?.remove();
      activeMount?.remove();
      delete window.__COPC_DEV_VIEWER__;
      if (window.__COPC_DEBUG__ === debugAdapterProxy)
        delete window.__COPC_DEBUG__;
    },
    { once: true },
  );

  if (startupIssues.size > 0) {
    updateStatus(
      configurationError ?? "Configuration needs attention.",
      "error",
    );
  } else {
    void runSession({ ...activeConfig }, "load");
  }
  updateConfigurationState();
}
main().catch((error) => {
  console.error("Failed to load COPC:", safeErrorMessage(error));
});
