import "./style.css";
import "cesium/Build/Cesium/Widgets/widgets.css";

import * as Cesium from "cesium";
import {
  CopcCesiumLayer,
  probeCopcSource,
  type CopcBackendName,
  CopcJsBackend,
  type CopcJsBackendOptions,
  type CopcCesiumPointStyle,
  type CopcCesiumPointStyleUpdate,
  type CopcCesiumClippingVolume,
  type CopcHierarchyDiagnostics,
  type CopcMetadata,
  type CopcPointInspection,
  type CopcSourceProbeResult,
  type RangeValidationPolicy,
  type TerrainHeightAlignmentEstimate,
  type TerrainHeightAlignmentBatchEstimate,
  type TerrainHeightAlignmentBatchOptions,
  type TerrainHeightAlignmentGroundCandidate,
  type TerrainHeightAlignmentOptions,
} from "@frillab/copc-adapter";
import type { CopcCesiumLayerSnapshot } from "@frillab/copc-adapter";
import type { CopcThreeLayerSnapshot } from "@frillab/copc-adapter/three";
import { loadGtxGeoidGrid, loadNgaEgm2008Grid } from "@frillab/copc-adapter";
import type {
  CopcBackendSelection,
  CopcPointDecoder,
  RefinementFocus,
} from "@frillab/copc-adapter/cesium";
import {
  BatchedGeometryPointRenderer,
  PointPrimitiveRenderer,
} from "@frillab/copc-adapter/cesium";
import { createCesiumViewer } from "./createViewer";
import { createCopcDebugPanel } from "./debug/CopcDebugPanel";
import {
  runSyntheticRendererLayoutComparisonBenchmark,
  runSyntheticRendererPerformanceBenchmark,
  runSyntheticEllipsoidalHeightOffsetBenchmark,
  runSyntheticThreeCacheLayoutBenchmark,
  type EllipsoidalHeightOffsetBenchmark,
  type RendererBenchmarkKind,
} from "./rendererPerformanceBenchmark";
import type { CpuPointPickProbe } from "../../../packages/adapter/cesium/render/BatchedGeometryPointRenderer";
import {
  runCpuBatchedPickingProbe,
  runCpuBatchedPickingStress,
} from "./experimental/cpuBatchedPickingProbe";
import {
  createDevThreeViewer,
  type DevThreeCameraState,
  type DevThreeViewer,
} from "./threeViewer";
import type { DevTerrainFixtureProvider } from "./devTerrainFixture";
import type {
  TilesPipelineDiagnostics,
  TilesViewerCameraState,
} from "./tilesViewerTypes";
import { mountDevViewerControls } from "./devViewerControls";
import {
  mountWorkbenchLayout,
  mountWorkbenchRightTabs,
  type WorkbenchTab,
} from "../../shared/workbench/WorkbenchLayout.ts";
import { mountIntegrationCodePanel } from "../../shared/codegen/IntegrationCodePanel.ts";
import {
  mountTerrainAlignmentControl,
  type TerrainAlignmentControl,
} from "../../shared/workbench/TerrainAlignmentControl.ts";
import {
  mountFollowCursorTracker,
  type NormalizedScreenPosition,
} from "../../shared/workbench/followCursor.ts";
import {
  mountPointPopover,
  type PointScreenPosition,
} from "../../shared/inspection/PointPopover.ts";
import { mountDiagnosticSections } from "../../shared/diagnostics/DiagnosticSections.ts";
import {
  createNgaEgm2008ResourceRegistry,
  createPointVerticalReferenceContext,
} from "../../shared/workbench/verticalGridResource.ts";
import {
  getCurrentTerrainAlignmentResidual,
  getVerticalTransformIdentity,
} from "../../shared/workbench/terrainAlignmentProvenance.ts";
import {
  generateAppliedWorkbenchIntegrationCode,
  isPotentiallySensitiveSource,
} from "../../shared/codegen/integrationCode.ts";
import {
  applySchemaRuntimeOperations,
  buildSchemaApplicationPlan,
  configuredLayerLoadsIntensity,
  materializeWorkbenchConstructorOptions,
  createWorkbenchConfigurationState,
  getChangedWorkbenchOptionIds,
  resolveSchemaBackendSelection,
  serializeWorkbenchConfiguration,
} from "../../shared/config/index.ts";
import {
  WORKSPACE_CURRENT_CAPABILITIES,
  WORKSPACE_CURRENT_MANIFEST,
} from "../../shared/schema/index.ts";
import {
  commitRuntimeColorMode,
  getCesiumTerrainProviderUrl,
  getSafeSourceLabel,
  getSafeTerrainSourceLabel,
  getTilesUnsupportedFilteringError,
  hasUnappliedSettings,
  isRangeValidationPolicy,
  isRefinementAlgorithm,
  needsSessionRecreation,
  restoreDevViewerShareConfiguration,
  sourceSupportsHttpRange,
  toWorkbenchOptionValues,
  getTilesVerticalGrid,
  validateDevViewerConfig,
  type CameraPreset,
  type CesiumPointRendererVariant,
  type DevViewerConfig,
  type RenderingEngine,
  type RenderingPipeline,
} from "./devViewerConfig";

const cesiumRuntimeVersion = (Cesium as typeof Cesium & { VERSION: string })
  .VERSION;

const DEFAULT_COPC_URL = "/samples/autzen.copc.laz";
const verticalGridResources = createNgaEgm2008ResourceRegistry(
  loadNgaEgm2008Grid,
  loadGtxGeoidGrid,
);
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

function tabUsesDiagnostics(tab: WorkbenchTab): boolean {
  return tab === "health" || tab === "data";
}

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
  setOpacity(opacity: number | undefined): void;
  setRefinementFocus(focus: RefinementFocus | undefined): void;
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
    cacheLayout?: "A" | "E",
    pointCounts?: readonly number[],
  ): ReturnType<typeof runSyntheticRendererPerformanceBenchmark>;
  runSyntheticRendererLayoutComparisonBenchmark(
    renderer?: RendererBenchmarkKind,
    pointCount?: number,
  ): ReturnType<typeof runSyntheticRendererLayoutComparisonBenchmark>;
  runSyntheticEllipsoidalHeightOffsetBenchmark(
    pointCount?: number,
  ): EllipsoidalHeightOffsetBenchmark;
  setTerrainFixtureHeight(heightMeters: number): void;
  runSyntheticThreeCacheLayoutBenchmark(): ReturnType<
    typeof runSyntheticThreeCacheLayoutBenchmark
  >;
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
  getRenderedPointScreenPosition(pointIndex: number):
    | { x: number; y: number }
    | undefined;
  estimateTerrainHeightAlignmentBatch?(
    candidates: readonly TerrainHeightAlignmentGroundCandidate[],
    options?: TerrainHeightAlignmentBatchOptions,
  ): Promise<TerrainHeightAlignmentBatchEstimate>;
  isTerrainHeightAlignmentBatchEstimateCurrent?(
    estimate: TerrainHeightAlignmentBatchEstimate,
  ): boolean;
  destroy(): void;
};

type ViewerSession = {
  renderer: RenderingEngine;
  pipeline: RenderingPipeline;
  ready: Promise<void>;
  debugAdapter?: CopcDebugAdapter;
  getSnapshot(): CopcCesiumLayerSnapshot | CopcThreeLayerSnapshot | undefined;
  getTilesDiagnostics?(): TilesPipelineDiagnostics;
  getTilesetUrl?(): string;
  getMetadata(): CopcMetadata | undefined;
  getHierarchyDiagnostics(): CopcHierarchyDiagnostics | undefined;
  getSelectedPoint(): CopcPointInspection | undefined;
  terrainSourceStatus: string;
  terrainProviderAvailable: boolean;
  estimateTerrainHeightAlignment?(
    anchor: CopcPointInspection,
    options?: TerrainHeightAlignmentOptions,
  ): Promise<TerrainHeightAlignmentEstimate>;
  isTerrainHeightAlignmentEstimateCurrent?(
    estimate: TerrainHeightAlignmentEstimate,
  ): boolean;
  estimateTerrainHeightAlignmentBatch?(
    candidates: readonly TerrainHeightAlignmentGroundCandidate[],
    options?: TerrainHeightAlignmentBatchOptions,
  ): Promise<TerrainHeightAlignmentBatchEstimate>;
  isTerrainHeightAlignmentBatchEstimateCurrent?(
    estimate: TerrainHeightAlignmentBatchEstimate,
  ): boolean;
  setCameraPreset(preset: CameraPreset): void;
  setCameraRenderDistance(distance: number): void;
  getCameraState(): ViewerCameraState;
  setCameraState(state: ViewerCameraState): void;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
  getStyle(): CopcCesiumPointStyle;
  setStyle?(update: CopcCesiumPointStyleUpdate): void;
  setOpacity(opacity: number | undefined): void;
  setClippingVolume?(volume: CopcCesiumClippingVolume | undefined): void;
  setRefinementFocus?(focus: RefinementFocus | undefined): void;
  getFocusCanvas?(): HTMLCanvasElement | undefined;
  destroy(): void;
};

type ApplyTraceStage =
  | "apply-input"
  | "approval-validity-checked"
  | "approval-rejected"
  | "session-replacement-started"
  | "source-probe-started"
  | "source-probe-completed"
  | "candidate-mount-created"
  | "session-create-started"
  | "session-created"
  | "session-ready-wait-started"
  | "session-ready"
  | "candidate-mount-visible"
  | "first-visible-node"
  | "first-visible-post-render"
  | "view-settled"
  | "old-session-disposal-started"
  | "old-session-disposed"
  | "status-ready"
  | "apply-error";

type ApplyTrace = {
  startedAt: number;
  events: Array<{ stage: ApplyTraceStage; elapsedMs: number }>;
};

function recordApplyTrace(
  trace: ApplyTrace | undefined,
  stage: ApplyTraceStage,
): void {
  if (!trace) return;
  trace.events.push({
    stage,
    elapsedMs: performance.now() - trace.startedAt,
  });
}

declare global {
  interface Window {
    __COPC_DEV_VIEWER__?: {
      getSnapshot():
        | CopcCesiumLayerSnapshot
        | CopcThreeLayerSnapshot
        | undefined;
      getSelectedPoint(): CopcPointInspection | undefined;
      getPickablePointScreenPosition(): { x: number; y: number } | undefined;
      estimateTerrainHeightAlignmentBatch?(
        candidates: readonly TerrainHeightAlignmentGroundCandidate[],
        options?: TerrainHeightAlignmentBatchOptions,
      ): Promise<TerrainHeightAlignmentBatchEstimate>;
      isTerrainHeightAlignmentBatchEstimateCurrent?(
        estimate: TerrainHeightAlignmentBatchEstimate,
      ): boolean;
      getConfiguration(): Omit<Readonly<DevViewerConfig>, "source" | "terrainUrl"> & {
        source: string;
        terrainSource: string;
      };
      getPendingConfiguration(): Omit<Readonly<DevViewerConfig>, "source" | "terrainUrl"> & {
        source: string;
        terrainSource: string;
      };
      getLastApplyTrace(): Array<{
        stage: ApplyTraceStage;
        elapsedMs: number;
      }>;
      getTilesDiagnostics(): TilesPipelineDiagnostics | undefined;
      getTilesetUrl(): string | undefined;
      getCameraState(): ViewerCameraState | undefined;
    };
    __COPC_TEST_TERRAIN_HEIGHT__?: number;
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
  devTerrainProvider?: DevTerrainFixtureProvider,
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
    setOpacity(opacity: number | undefined): void {
      layer.setOpacity(opacity);
    },
    setRefinementFocus(focus: RefinementFocus | undefined): void {
      layer.setRefinementFocus(focus);
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
    runSyntheticRendererPerformanceBenchmark: (
      renderer = "point-primitive",
      cacheLayout = "A",
      pointCounts,
    ) =>
      runSyntheticRendererPerformanceBenchmark({
        viewer,
        cacheLayout,
        pointCounts: pointCounts ?? [10_000, 50_000, 100_000],
        repetitions: 5,
        warmups: 2,
        renderer,
      }),
    runSyntheticRendererLayoutComparisonBenchmark: (
      renderer = "point-primitive",
      pointCount = 100_000,
    ) =>
      runSyntheticRendererLayoutComparisonBenchmark({
        viewer,
        renderer,
        pointCount,
        repetitions: 5,
        warmups: 2,
      }),
    runSyntheticEllipsoidalHeightOffsetBenchmark: (pointCount = 100_000) =>
      runSyntheticEllipsoidalHeightOffsetBenchmark({
        pointCount,
        repetitions: 5,
        warmups: 2,
      }),
    setTerrainFixtureHeight(heightMeters): void {
      if (!Number.isFinite(heightMeters)) {
        throw new RangeError("Terrain fixture height must be finite");
      }
      if (!devTerrainProvider) {
        throw new Error("The controlled Terrain fixture is not active");
      }
      window.__COPC_TEST_TERRAIN_HEIGHT__ = heightMeters;
      devTerrainProvider.setHeightMeters(heightMeters);
    },
    getRenderedPointScreenPosition(pointIndex):
      | { x: number; y: number }
      | undefined {
      if (!Number.isSafeInteger(pointIndex) || pointIndex < 0) return undefined;
      let renderedPointIndex = 0;
      for (const collection of getPointPrimitiveCollections(
        viewer.scene.primitives,
      )) {
        for (let index = 0; index < collection.length; index += 1) {
          if (renderedPointIndex === pointIndex) {
            const position = Cesium.SceneTransforms.worldToWindowCoordinates(
              viewer.scene,
              collection.get(index).position,
            );
            return position ? { x: position.x, y: position.y } : undefined;
          }
          renderedPointIndex += 1;
        }
      }
      return undefined;
    },
    runSyntheticThreeCacheLayoutBenchmark: () =>
      runSyntheticThreeCacheLayoutBenchmark(),
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
          ".dev-panel:not([hidden]), .dev-panel-toggle, .workbench-global-header, .workbench-statusbar",
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
            candidate.screenPosition.x < 4 ||
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
            position.x >= 4 &&
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
  applicationPlan?: ReturnType<typeof buildSchemaApplicationPlan>,
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
  const plan = config
    ? applicationPlan ?? buildSchemaApplicationPlan(
        {
          ...toWorkbenchOptionValues(config),
          "source.url": source,
          "renderer.engine": "cesium",
        },
        {
          manifest: WORKSPACE_CURRENT_MANIFEST,
          renderer: "cesium",
          runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
        },
        undefined,
        undefined,
        verticalGridResources.hostValidators,
      )
    : undefined;
  const workbenchOptions = plan
    ? materializeWorkbenchConstructorOptions(plan) as
    | Partial<ConstructorParameters<typeof CopcCesiumLayer>[0]>
    | undefined
    : undefined;
  const streamingOptions =
    workbenchOptions?.streaming ?? {
      maxNodes: issueScenario ? (issue128 ? 16 : 32) : 24,
      maxDepth: issueScenario ? (issue128 ? 4 : 6) : 6,
      maxScreenSpaceError: 8,
      maxRenderDistanceMeters: issueScenario ? scenarioMaxDistance : 12_000,
      refinementAlgorithm,
      ...(motionLookahead === undefined ? {} : { motionLookahead }),
    };
  return {
    url: source,
    ...(workbenchOptions ?? {
      colorMode: issueScenario ? "elevation" : "rgb",
      backend: issueScenario
        ? params.get("backend") === "copc-js"
          ? "copc-js"
          : "rust"
        : getSelectedBackend(),
      pointSize: issueScenario ? 2 : 3,
      rangeValidation,
      ...(issueScenario && maxRenderedPoints !== undefined
        ? { maxRenderedPoints }
        : {}),
    }),
    debug: true,
    ...(issueScenario && maxPointCacheBytes !== undefined
      ? { maxPointCacheBytes }
      : {}),
    ...(heightOffsetMeters === undefined ? {} : { heightOffsetMeters }),
    streaming: {
      ...streamingOptions,
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

function actionableAttributeLoadingError(error: unknown): string {
  const message = safeErrorMessage(error);
  return /not requested.*source availability was not checked/iu.test(message)
    ? message + " No field was fetched. Set Standard attribute loading to All or select the field under Additional standard fields, then Apply Settings to reload."
    : message;
}

function projectCesiumPoint(
  viewer: Cesium.Viewer,
  point: CopcPointInspection,
): PointScreenPosition | undefined {
  const cartesian = point.world &&
    [point.world.x, point.world.y, point.world.z].every(Number.isFinite)
    ? new Cesium.Cartesian3(point.world.x, point.world.y, point.world.z)
    : Number.isFinite(point.longitude) &&
        Number.isFinite(point.latitude) &&
        Number.isFinite(point.height)
      ? Cesium.Cartesian3.fromDegrees(
          point.longitude,
          point.latitude,
          point.height,
        )
      : undefined;
  if (!cartesian) return undefined;
  const canvas = viewer.scene.canvas;
  const bounds = canvas.getBoundingClientRect();
  const position = Cesium.SceneTransforms.worldToWindowCoordinates(
    viewer.scene,
    cartesian,
  );
  if (
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    position.x < 0 ||
    position.y < 0 ||
    position.x > canvas.clientWidth ||
    position.y > canvas.clientHeight
  ) return undefined;
  return { x: bounds.left + position.x, y: bounds.top + position.y };
}

function createWorkbenchBackend(
  applicationPlan: ReturnType<typeof buildSchemaApplicationPlan>,
): CopcBackendSelection | undefined {
  return resolveSchemaBackendSelection(
    applicationPlan,
    ({ extraDimensions }) =>
      new CopcJsBackend({
        extraDimensions: extraDimensions as CopcJsBackendOptions["extraDimensions"],
      }),
  ) as CopcBackendSelection | undefined;
}

async function createCesiumSession(
  container: HTMLElement,
  config: DevViewerConfig,
  onError: (error: unknown) => void,
  onPointPicked: (
    point: CopcPointInspection | undefined,
    position?: PointScreenPosition,
  ) => void,
  onPointPositionChanged: (position: PointScreenPosition | undefined) => void,
  applyTrace?: ApplyTrace,
): Promise<ViewerSession> {
  const applicationPlan = buildSchemaApplicationPlan(
    {
      ...toWorkbenchOptionValues(config),
      "source.url": config.source,
      "renderer.engine": "cesium",
    },
    {
      manifest: WORKSPACE_CURRENT_MANIFEST,
      renderer: "cesium",
      runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
    },
    undefined,
    undefined,
    verticalGridResources.hostValidators,
  );
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
  let devTerrainFixtureProvider: DevTerrainFixtureProvider | undefined;
  let terrainSourceStatus =
    "WGS84 ellipsoid only · imagery may still be shown; no terrain elevations are available.";
  const testTerrainFixture = params.get("terrainFixtureHeight");
  if (import.meta.env.DEV && testTerrainFixture !== null) {
    const configuredHeight = Number(testTerrainFixture);
    const height = Number.isFinite(window.__COPC_TEST_TERRAIN_HEIGHT__)
      ? window.__COPC_TEST_TERRAIN_HEIGHT__!
      : configuredHeight;
    if (Number.isFinite(height)) {
      const { createDevTerrainFixture } = await import("./devTerrainFixture");
      devTerrainFixtureProvider = createDevTerrainFixture(height);
      terrainProvider = devTerrainFixtureProvider;
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
  const terrainProviderAvailable =
    !(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) &&
    viewer.terrainProvider.availability !== undefined;
  let selectedPoint: CopcPointInspection | undefined;
  const onPostRender = (): void => {
    if (selectedPoint)
      onPointPositionChanged(projectCesiumPoint(viewer, selectedPoint));
  };
  const onCameraChanged = (): void => {
    if (selectedPoint)
      onPointPositionChanged(projectCesiumPoint(viewer, selectedPoint));
  };
  viewer.scene.postRender.addEventListener(onPostRender);
  viewer.camera.changed.addEventListener(onCameraChanged);
  const researchRenderer = usePublicBatchedRenderer
    ? new BatchedGeometryPointRenderer()
    : undefined;
  const backend = createWorkbenchBackend(applicationPlan);
  const layer = new CopcCesiumLayer({
    ...getLayerOptions(config.source, config, applicationPlan),
    ...(backend === undefined ? {} : { backend }),
    renderer: researchRenderer ?? new PointPrimitiveRenderer(),
    onPointPicked: (point) => {
      selectedPoint = point;
      onPointPicked(point, point ? projectCesiumPoint(viewer, point) : undefined);
    },
    ...(ellipsoidalTerrainFixture
      ? {
          backend: ellipsoidalTerrainFixture.backend,
          decoder: ellipsoidalTerrainFixture.decoder,
        }
      : {}),
  });
  const removeApplyTraceListeners: Array<() => void> = [];
  if (applyTrace) {
    let firstViewSettledRecorded = false;
    removeApplyTraceListeners.push(
      layer.firstVisible.addEventListener(() => {
        recordApplyTrace(applyTrace, "first-visible-node");
        let removePostRender: (() => void) | undefined;
        const onFirstVisibleFrame = (): void => {
          removePostRender?.();
          removePostRender = undefined;
          recordApplyTrace(applyTrace, "first-visible-post-render");
        };
        removePostRender = viewer.scene.postRender.addEventListener(
          onFirstVisibleFrame,
        );
        removeApplyTraceListeners.push(() => removePostRender?.());
      }),
      layer.viewSettled.addEventListener(() => {
        if (!firstViewSettledRecorded) {
          firstViewSettledRecorded = true;
          recordApplyTrace(applyTrace, "view-settled");
        }
      }),
    );
  }
  await applySchemaRuntimeOperations(layer, applicationPlan.runtimeOperations);
  const debugAdapter = installDebugAdapter(
    viewer,
    layer,
    researchRenderer,
    config.rangeValidation,
    devTerrainFixtureProvider,
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
    pipeline: "direct",
    terrainSourceStatus,
    terrainProviderAvailable,
    ready: ready.then(() => undefined),
    debugAdapter,
    getSnapshot: () => layer.getSnapshot(),
    getMetadata: () => layer.getMetadata(),
    getHierarchyDiagnostics: () => layer.getHierarchyDiagnostics(),
    getSelectedPoint: () => layer.getSelectedPoint(),
    estimateTerrainHeightAlignmentBatch: (candidates, options = {}) =>
      layer.estimateTerrainHeightAlignmentBatch(candidates, {
        ...options,
        terrainSourceId: config.terrainUrl.trim()
          ? getSafeTerrainSourceLabel(config.terrainUrl, window.location.href)
          : undefined,
      }),
    isTerrainHeightAlignmentBatchEstimateCurrent: (estimate) =>
      layer.isTerrainHeightAlignmentBatchEstimateCurrent(estimate),
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
    setRefinementFocus: (focus) => layer.setRefinementFocus(focus),
    getFocusCanvas: () => viewer.isDestroyed() ? undefined : viewer.scene.canvas,
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
    setOpacity: (opacity) => layer.setOpacity(opacity),
    setClippingVolume: (volume) => layer.setClippingVolume(volume),
    destroy() {
      if (selectedPoint) {
        selectedPoint = undefined;
        onPointPicked(undefined);
        onPointPositionChanged(undefined);
      }
      viewer.scene.postRender.removeEventListener(onPostRender);
      viewer.camera.changed.removeEventListener(onCameraChanged);
      for (const removeListener of removeApplyTraceListeners) {
        removeListener();
      }
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
  onPointPicked: (
    point: CopcPointInspection | undefined,
    position?: PointScreenPosition,
  ) => void,
  onPointPositionChanged: (position: PointScreenPosition | undefined) => void,
): ViewerSession {
  const applicationPlan = buildSchemaApplicationPlan(
    {
      ...toWorkbenchOptionValues(config),
      "source.url": config.source,
      "renderer.engine": "three",
    },
    {
      manifest: WORKSPACE_CURRENT_MANIFEST,
      renderer: "three",
      runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
    },
    undefined,
    undefined,
    verticalGridResources.hostValidators,
  );
  const backend = createWorkbenchBackend(applicationPlan);
  const layerOptions = {
    ...materializeWorkbenchConstructorOptions(applicationPlan),
    ...(backend === undefined ? {} : { backend }),
  } as unknown as import("@frillab/copc-adapter/three").CopcThreeLayerOptions;
  const viewer: DevThreeViewer = createDevThreeViewer({
    container,
    sourceName: getSafeSourceLabel(config.source, window.location.href),
    layerOptions,
    runtimeOperations: applicationPlan.runtimeOperations,
    cameraRenderDistance: config.cameraRenderDistance,
    onPointPicked,
    onPointPositionChanged,
    onError,
  });
  return {
    renderer: "three",
    pipeline: "direct",
    terrainSourceStatus:
      "Three.js renderer · the dev-viewer Cesium Terrain provider is not used.",
    terrainProviderAvailable: false,
    ready: viewer.ready,
    getSnapshot: () => viewer.getSnapshot(),
    getMetadata: () => viewer.getMetadata(),
    getHierarchyDiagnostics: () => viewer.getHierarchyDiagnostics(),
    getSelectedPoint: () => viewer.getSelectedPoint(),
    setOpacity: (opacity) => viewer.setOpacity(opacity),
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

async function createTilesPipelineSession(
  container: HTMLElement,
  config: DevViewerConfig,
  signal: AbortSignal,
  isCurrent: () => boolean,
  onDiagnostics: (diagnostics: TilesPipelineDiagnostics) => void,
  onError: (error: unknown) => void,
): Promise<ViewerSession> {
  const { createTilesViewerSession } = await import("./tilesViewer");
  const verticalGrid = getTilesVerticalGrid(
    config,
    verticalGridResources.isLoadedGrid,
  );
  const viewer = await createTilesViewerSession({
    container,
    source: config.source,
    backend: config.backend,
    rangeValidation: config.rangeValidation,
    heightOffsetMeters: config.heightOffsetMeters,
    verticalGrid,
    renderer: config.renderer,
    signal,
    isCurrent,
    onDiagnostics,
    onError,
  });
  return {
    renderer: config.renderer,
    pipeline: "tiles",
    ready: Promise.resolve(),
    getSnapshot: () => undefined,
    getTilesDiagnostics: viewer.getDiagnostics,
    getTilesetUrl: viewer.getTilesetUrl,
    getMetadata: () => viewer.metadata,
    getHierarchyDiagnostics: () => undefined,
    getSelectedPoint: () => undefined,
    terrainSourceStatus: "3D Tiles are not Cesium Terrain samples; Terrain alignment is unavailable in Tiles mode.",
    terrainProviderAvailable: false,
    setCameraPreset: (preset) => viewer.setCameraPreset(preset),
    setCameraRenderDistance: (distance) => viewer.setCameraDistance(distance),
    getCameraState: () => viewer.getCameraState() as ViewerCameraState,
    setCameraState: (state) => viewer.setCameraState(state as TilesViewerCameraState),
    getPickablePointScreenPosition: () => undefined,
    getStyle: () => ({ colorMode: config.colorMode }),
    setStyle: () => undefined,
    setOpacity: () => undefined,
    destroy: () => viewer.destroy(),
  };
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const initialOptions = getLayerOptions();
  const initialStreaming = initialOptions.streaming;
  const initialSource = getCopcUrl();
  const requestedEngine = params.get("renderer");
  const requestedPipeline = params.get("pipeline");
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
  if (requestedPipeline !== null && requestedPipeline !== "direct" && requestedPipeline !== "tiles") {
    reportStartupIssue("pipeline", 'Unknown rendering pipeline; choose "direct" or "tiles".');
  }
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

  const baseInitialConfig: DevViewerConfig = {
    renderer,
    pipeline: requestedPipeline === "tiles" ? "tiles" : "direct",
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
    // The Dev Viewer schema exposes the five modes with complete Workbench
    // controls. Dimension mode also needs a user-supplied range and ramp, so
    // keep that new public API mode out of this host's legacy initial config.
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
  const restoredInitialConfig = restoreDevViewerShareConfiguration(
    params,
    baseInitialConfig,
  );
  const activeInitialConfig = restoredInitialConfig.config;
  const shareConfigurationWarnings = restoredInitialConfig.warnings.map(
    (warning) => "Shared configuration: " + warning,
  );
  let activeConfig = { ...activeInitialConfig };
  let pendingConfig = { ...activeConfig };
  let appliedCodeRevision = 0;
  let appliedCodeAt: number | undefined;
  let lastAppliedCodeValues: Readonly<Record<string, unknown>> | undefined;
  let workbenchControls: ReturnType<typeof mountDevViewerControls> | undefined;
  let terrainAlignmentControl: TerrainAlignmentControl | undefined;
  let activeSession: ViewerSession | undefined;
  let followCursorEnabled = false;
  let followCursorFocus: RefinementFocus | undefined;
  let lastFollowCursorPosition: NormalizedScreenPosition | undefined;
  let activeMount: HTMLElement | undefined;
  let stagedSession: ViewerSession | undefined;
  let stagedMount: HTMLElement | undefined;
  let activeDebugAdapter: CopcDebugAdapter | undefined;
  let tilesDiagnostics: TilesPipelineDiagnostics | undefined;
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

  const readFocusValue = (value: unknown): RefinementFocus | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const focus = value as Partial<RefinementFocus>;
    if (
      focus.type !== "screen-circle" ||
      typeof focus.center !== "object" || focus.center === null ||
      !Number.isFinite(focus.center.x) || focus.center.x < 0 || focus.center.x > 1 ||
      !Number.isFinite(focus.center.y) || focus.center.y < 0 || focus.center.y > 1 ||
      typeof focus.radius !== "number" || !Number.isFinite(focus.radius) || focus.radius <= 0 || focus.radius > 1 ||
      typeof focus.detailBias !== "number" || !Number.isFinite(focus.detailBias) || focus.detailBias < 1 || focus.detailBias > 2
    ) return undefined;
    return focus as RefinementFocus;
  };
  const setLiveFocus = (focus: RefinementFocus | undefined): boolean => {
    if (activeSession?.renderer !== "cesium" || activeSession.pipeline !== "direct" ||
      !activeSession.setRefinementFocus) return false;
    try {
      activeSession.setRefinementFocus(focus);
      return true;
    } catch (error) {
      followCursorEnabled = false;
      followCursorTracker.setEnabled(false);
      setActiveError(error);
      return false;
    }
  };
  const followCursorTracker = mountFollowCursorTracker({
    getTarget: () => activeSession?.renderer === "cesium" && activeSession.pipeline === "direct"
      ? activeSession.getFocusCanvas?.()
      : undefined,
    onPosition(position) {
      lastFollowCursorPosition = position;
      if (!followCursorEnabled || !followCursorFocus) return;
      setLiveFocus({ ...followCursorFocus, center: position });
    },
  });
  const isFollowCursorAvailable = (): boolean =>
    pendingConfig.renderer === "cesium" &&
    pendingConfig.pipeline === "direct" &&
    activeSession?.renderer === "cesium" &&
    activeSession.pipeline === "direct" &&
    typeof activeSession.setRefinementFocus === "function";
  const setFollowCursor = (enabled: boolean, rawFocus: unknown): void => {
    const suppliedFocus = readFocusValue(rawFocus);
    if (suppliedFocus) followCursorFocus = suppliedFocus;
    else if (rawFocus === undefined) followCursorFocus = undefined;
    const focus = suppliedFocus ?? (rawFocus === undefined ? undefined : followCursorFocus);
    const canFollow = isFollowCursorAvailable();
    followCursorEnabled = enabled && canFollow && focus !== undefined;
    followCursorTracker.setEnabled(followCursorEnabled);
    let applied = false;
    if (followCursorEnabled && focus) {
      applied = setLiveFocus({ ...focus, center: lastFollowCursorPosition ?? focus.center });
    } else if (!followCursorEnabled) {
      applied = setLiveFocus(focus);
    }
    if (applied) {
      const schemaOptionValues = { ...(activeConfig.schemaOptionValues ?? {}) };
      if (focus) schemaOptionValues["streaming.refinementFocus"] = focus;
      else delete schemaOptionValues["streaming.refinementFocus"];
      activeConfig = { ...activeConfig, schemaOptionValues };
      refreshIntegrationCode();
    } else {
      refreshIntegrationCode();
    }
  };
  let lastApplyTrace: ApplyTrace | undefined;

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
  const inspectorPanel = getElement<HTMLElement>("#inspector-panel");
  const controlsToggle = getElement<HTMLButtonElement>("#controls-toggle");
  const inspectorToggle = getElement<HTMLButtonElement>("#inspector-toggle");
  const devWorkbench = getElement<HTMLElement>(".dev-workbench");
  const viewportPanel = getElement<HTMLElement>("#viewport-panel");
  const workbenchStatus = document.createElement("footer");
  workbenchStatus.id = "workbench-status";
  workbenchStatus.textContent = "Loading configured source…";
  const loadButton = getElement<HTMLButtonElement>("#load-source");
  const applySettingsButton = getElement<HTMLButtonElement>("#apply-settings");
  const reloadCurrentSourceButton = getElement<HTMLButtonElement>(
    "#reload-current-source",
  );
  const configurationState = getElement<HTMLElement>("#configuration-state");
  const configurationErrorElement = getElement<HTMLElement>(
    "#configuration-error",
  );
  const terrainUrlInput = getElement<HTMLInputElement>("#terrain-url");
  terrainUrlInput.value = activeConfig.terrainUrl;
  let inspectorExpanded = isDebugPanelEnabled();
  let setInspectorPolling: ((enabled: boolean) => void) | undefined;
  let selectedRightTab: WorkbenchTab = "code";
  let approvedTerrainAlignmentProvenance: {
    readonly source: string | File;
    readonly terrainUrl: string;
    readonly verticalTransformIdentity: symbol | undefined;
    readonly finalHeightOffsetMeters: number;
    readonly residualMeters: number;
  } | undefined;
  container.remove();
  viewportPanel.append(container);
  const pointPopover = mountPointPopover(viewportPanel);
  const workbenchLayout = mountWorkbenchLayout({
    root: devWorkbench,
    provenance: `local ${__COPC_ADAPTER_VERSION__} / Dev Viewer`,
    provenanceId: "package-version",
    leftPanel: controlsPanel,
    viewport: viewportPanel,
    rightPanel: inspectorPanel,
    status: workbenchStatus,
    leftLabel: "Configuration",
    rightLabel: "COPC runtime debug panel",
    leftToggle: controlsToggle,
    rightToggle: inspectorToggle,
    rightToggleLabel: "Inspector",
    keyboardShortcut: { panel: "right", key: "d", shift: true },
    rightExpandedInitially: inspectorExpanded,
    onRightExpandedChange(expanded) {
      inspectorExpanded = expanded;
      setInspectorPolling?.(
        expanded && (selectedRightTab === "health" || selectedRightTab === "data"),
      );
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
  let pointVerticalReferenceKey: string | undefined;
  const updatePointVerticalReferenceContext = (): void => {
    if (!activeSession) {
      if (pointVerticalReferenceKey !== "unavailable") {
        pointVerticalReferenceKey = "unavailable";
        pointPopover.setVerticalReferenceContext(undefined);
      }
      return;
    }
    const values = toWorkbenchOptionValues(activeConfig);
    const terrainResidual = activeConfig.renderer === "cesium"
      ? getCurrentTerrainAlignmentResidual(
          approvedTerrainAlignmentProvenance,
          {
            source: activeConfig.source,
            terrainUrl: activeConfig.terrainUrl,
            verticalTransformIdentity: getVerticalTransformIdentity(
              values["coordinates.verticalTransform"],
            ),
            heightOffsetMeters: activeConfig.heightOffsetMeters,
          },
          sameSource,
        )
      : undefined;
    const reference = createPointVerticalReferenceContext(
      activeSession.getMetadata(),
      values["coordinates.verticalTransform"],
      activeConfig.heightOffsetMeters,
      terrainResidual,
    );
    const key = JSON.stringify(reference);
    if (key === pointVerticalReferenceKey) return;
    pointVerticalReferenceKey = key;
    pointPopover.setVerticalReferenceContext(reference);
  };
  const inspectorTabsTarget = getElement<HTMLElement>("#inspector-content");
  const codePanel = document.createElement("section");
  codePanel.className = "dev-code-panel";
  const integrationCodePanel = mountIntegrationCodePanel({
    target: codePanel,
    summary: "Local workspace source · v" + __COPC_ADAPTER_VERSION__ + " · unpublished",
    intro: "Generated against the current local workspace package. A published npm release may expose a different API.",
    installLabel: "Package source",
    onStateChange: () => refreshIntegrationCode(),
    createShareLink: (includeSource) => createWorkbenchShareLink(includeSource),
  });
  const integrationValues = (config: DevViewerConfig): Record<string, unknown> => {
    const values = toWorkbenchOptionValues(config);
    values["source.url"] = config.source;
    values["renderer.engine"] = config.renderer;
    values["adapter.backend"] = config.backend;
    values["rendering.colorMode"] = config.colorMode;
    values["rendering.pointSize"] = config.pointSize;
    values["streaming.maxNodes"] = config.maxNodes;
    values["performance.maxRenderedPoints"] = config.maxRenderedPoints;
    values["streaming.maxDepth"] = config.maxDepth;
    values["streaming.maxScreenSpaceError"] = config.maxScreenSpaceError;
    values["streaming.maxRenderDistanceMeters"] = config.maxRenderDistance;
    values["streaming.refinementAlgorithm"] = config.refinementAlgorithm;
    values["streaming.motionLookahead"] = config.motionLookahead;
    values["source.rangeValidation"] = config.rangeValidation;
    if (config.renderer === "cesium") {
      values["rendering.cesiumPointRenderer"] = config.cesiumRenderer;
      values["coordinates.heightOffsetMeters"] = config.heightOffsetMeters;
    }
    return values;
  };
  const createWorkbenchShareLink = (includeSource: boolean): string => {
    const values = integrationValues(activeConfig);
    const context = {
      manifest: WORKSPACE_CURRENT_MANIFEST,
      renderer: activeConfig.renderer,
      runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
    } as const;
    const state = createWorkbenchConfigurationState(values, values);
    const params = serializeWorkbenchConfiguration(
      state,
      context,
      "applied",
      undefined,
      verticalGridResources.hostValidators,
    );
    if (
      includeSource &&
      typeof activeConfig.source === "string" &&
      !isPotentiallySensitiveSource(activeConfig.source)
    ) {
      params.set("source", activeConfig.source);
    }
    if (params.toString().length > 8192) {
      throw new RangeError("Share state exceeds the 8192-character limit.");
    }
    const url = new URL(window.location.href);
    url.search = params.toString();
    url.hash = "";
    return url.toString();
  };
  const refreshIntegrationCode = (): void => {
    if (activeConfig.pipeline === "tiles") {
      integrationCodePanel.setTerrainAlignmentRecipeAvailable(false);
      integrationCodePanel.setContent({
        code: "// No public integration snippet is available for this experimental pipeline.",
        warnings: [
          "This demonstration uses the unpublished local @frillab/copc-tiles workspace. npm installation and public Playground support are not included. Share links preserve Adapter settings and return to Direct COPC mode.",
        ],
      });
      return;
    }
    integrationCodePanel.setTerrainAlignmentRecipeAvailable(
      activeConfig.renderer === "cesium" &&
        WORKSPACE_CURRENT_CAPABILITIES.includes("cesium.terrain-alignment"),
    );
    if (!sameSource(lastIntegrationCodeSource, activeConfig.source)) {
      lastIntegrationCodeSource = activeConfig.source;
      integrationCodePanel.setSourcePrivacySelection(
        activeConfig.source,
        typeof activeConfig.source === "string" &&
          !isPotentiallySensitiveSource(activeConfig.source),
      );
      return;
    }
    if (!activeSession) {
      integrationCodePanel.setContent({
        code: "",
        warnings: ["Load a source successfully before copying code for applied settings."],
        source: activeConfig.source,
      });
      return;
    }
    const values = integrationValues(activeConfig);
    const pendingValues = integrationValues(pendingConfig);
    if (
      lastAppliedCodeValues === undefined ||
      getChangedWorkbenchOptionIds(lastAppliedCodeValues, values).length > 0
    ) {
      appliedCodeRevision += 1;
      appliedCodeAt = Date.now();
      lastAppliedCodeValues = createWorkbenchConfigurationState(values, values).applied;
    }
    const appliedState = {
      ...createWorkbenchConfigurationState(pendingValues, values),
      appliedRevision: appliedCodeRevision,
      pendingRevision: appliedCodeRevision,
    };
    const state = integrationCodePanel.getState();
    const terrainResidual = activeConfig.renderer === "cesium"
      ? getCurrentTerrainAlignmentResidual(
          approvedTerrainAlignmentProvenance,
          {
            source: activeConfig.source,
            terrainUrl: activeConfig.terrainUrl,
            verticalTransformIdentity: getVerticalTransformIdentity(
              values["coordinates.verticalTransform"],
            ),
            heightOffsetMeters: activeConfig.heightOffsetMeters,
          },
          sameSource,
        )
      : undefined;
    const approvedTerrainAlignment = terrainResidual === undefined
      ? undefined
      : {
          residualMeters: terrainResidual,
          finalHeightOffsetMeters: activeConfig.heightOffsetMeters,
        };
    try {
      const generated = generateAppliedWorkbenchIntegrationCode({
        state: appliedState,
        ...(appliedCodeAt === undefined ? {} : { appliedAt: appliedCodeAt }),
        includeExactSource: state.includeExactSource,
        includeTerrainAlignmentRecipe: state.includeTerrainAlignmentRecipe,
        ...(approvedTerrainAlignment ? { approvedTerrainAlignment } : {}),
        mode: state.mode,
        manifest: WORKSPACE_CURRENT_MANIFEST,
        runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
        adapterVersion: __COPC_ADAPTER_VERSION__,
        packageOriginLabel: "current local workspace source; unpublished",
        hostValidators: verticalGridResources.hostValidators,
      });
      const warnings = [...shareConfigurationWarnings, ...generated.warnings];
      if (followCursorEnabled) {
        warnings.push(
          "Follow Cursor is a Dev Viewer host interaction. The generated snippet uses the configured static Focus Lens center and does not install continuous pointer tracking.",
        );
      }
      if (activeConfig.renderer === "cesium" && activeConfig.terrainUrl.trim()) {
        warnings.push(
          "Dev Viewer Terrain is configured on the Cesium viewer, not on the adapter layer. Configure the equivalent Cesium Terrain provider separately in your application.",
        );
      }
      integrationCodePanel.setContent({
        code: generated.code,
        warnings,
        source: activeConfig.source,
        sensitiveSourceIncluded: typeof activeConfig.source === "string" &&
          isPotentiallySensitiveSource(activeConfig.source) && state.includeExactSource,
        appliedStatus: {
          revision: generated.appliedRevision,
          pendingChanges: generated.pendingChanges || isLoading ||
            hasUnappliedSettings(activeConfig, pendingConfig) ||
            (workbenchControls?.getValidationErrors().length ?? 0) > 0,
          ...(generated.appliedAt === undefined ? {} : { appliedAt: generated.appliedAt }),
        },
      });
    } catch (error) {
      integrationCodePanel.setContent({
        code: "",
        warnings: [safeErrorMessage(error)],
        source: activeConfig.source,
      });
    }
  };
  let lastIntegrationCodeSource = activeConfig.source;
  integrationCodePanel.setSourcePrivacySelection(
    activeConfig.source,
    typeof activeConfig.source === "string" &&
      !isPotentiallySensitiveSource(activeConfig.source),
  );
  const sourcePanel = document.createElement("section");
  const healthPanel = document.createElement("section");
  healthPanel.id = "inspector-health";
  const dataPanel = document.createElement("section");
  dataPanel.className = "dev-data-panel";
  const rightTabs = mountWorkbenchRightTabs({
    target: inspectorTabsTarget,
    tabs: [
      { tab: "code", label: "Code", panel: codePanel },
      { tab: "source", label: "Source", panel: sourcePanel },
      { tab: "health", label: "Health", panel: healthPanel },
      { tab: "data", label: "Data", panel: dataPanel },
    ],
    onChange(tab) {
      selectedRightTab = tab;
      setInspectorPolling?.(
        inspectorExpanded && (tab === "health" || tab === "data"),
      );
    },
  });
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
    workbenchStatus.textContent = message;
    workbenchStatus.dataset.status = tone;
  };
  const updateConfigurationState = (): void => {
    const dirty = hasUnappliedSettings(activeConfig, pendingConfig);
    const schemaValidationErrors = workbenchControls?.getValidationErrors() ?? [];
    const tilesFilteringError = pendingConfig.pipeline === "tiles"
      ? getTilesUnsupportedFilteringError(pendingConfig)
      : undefined;
    const selectedSourceDiffers = !sameSource(
      activeConfig.source,
      pendingConfig.source,
    );
    configurationState.textContent = tilesFilteringError
      ? "Filtering settings are unsupported by 3D Tiles"
      : dirty
        ? "Settings not applied"
        : selectedSourceDiffers
          ? "Settings applied · selected source differs"
          : "Settings applied";
    configurationState.dataset.dirty = String(dirty);
    configurationErrorElement.textContent = configurationError ?? tilesFilteringError ?? "";
    configurationErrorElement.hidden = !configurationError && !tilesFilteringError;
    applySettingsButton.disabled =
      isLoading ||
      startupIssues.size > 0 ||
      schemaValidationErrors.length > 0 ||
      Boolean(tilesFilteringError) ||
      (!dirty && !configurationError);
    loadButton.disabled =
      isLoading || startupIssues.size > 0 || schemaValidationErrors.length > 0 ||
      Boolean(tilesFilteringError);
    reloadCurrentSourceButton.disabled = isLoading || !activeSession;
    controlsPanel
      .querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")
      .forEach((control) => {
        control.disabled = isLoading;
      });
    const tilesStylesDisabled =
      activeConfig.pipeline === "tiles" || pendingConfig.pipeline === "tiles";
    const styleSection = controlsPanel.querySelector<HTMLElement>(
      '.schema-control-section[data-section="style"]',
    );
    styleSection?.setAttribute("aria-disabled", String(tilesStylesDisabled));
    styleSection
      ?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
        "input, select, button",
      )
      .forEach((control) => {
        control.disabled = isLoading || tilesStylesDisabled;
      });
    const tilesFilteringDisabled =
      activeConfig.pipeline === "tiles" || pendingConfig.pipeline === "tiles";
    const filteringSection = controlsPanel.querySelector<HTMLElement>(
      '.schema-control-section[data-section="filtering"]',
    );
    filteringSection?.setAttribute("aria-disabled", String(tilesFilteringDisabled));
    filteringSection
      ?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
        "input, select, button",
      )
      .forEach((control) => {
        control.disabled = isLoading || tilesFilteringDisabled;
      });
    workbenchControls?.refreshVerticalGridAvailability();
    controlsPanel
      .querySelectorAll<HTMLButtonElement>(".ui-segmented button")
      .forEach((control) => {
        const section = control.closest<HTMLElement>(".schema-control-section");
        control.disabled = isLoading ||
          (tilesStylesDisabled && section?.dataset.section === "style") ||
          (tilesFilteringDisabled && section?.dataset.section === "filtering");
      });
    workbenchControls?.refreshFocusCursorAvailability();
    terrainAlignmentControl?.update();
    refreshIntegrationCode();
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
    const snapshot = activeSession?.pipeline === "tiles"
      ? undefined
      : activeSession?.getSnapshot() ?? lastSnapshot;
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
    { source: sourcePanel, health: healthPanel, data: dataPanel },
    () => {
      const appliedValues = toWorkbenchOptionValues(activeConfig);
      const terrainResidual = activeConfig.renderer === "cesium"
        ? getCurrentTerrainAlignmentResidual(
            approvedTerrainAlignmentProvenance,
            {
              source: activeConfig.source,
              terrainUrl: activeConfig.terrainUrl,
              verticalTransformIdentity: getVerticalTransformIdentity(
                appliedValues["coordinates.verticalTransform"],
              ),
              heightOffsetMeters: activeConfig.heightOffsetMeters,
            },
            sameSource,
          )
        : undefined;
      return {
      snapshot: activeSnapshot(),
      snapshotIsAvailable: activeSession
        ? activeSession.pipeline === "direct"
        : lastSnapshot !== undefined,
      metadata: activeSession?.getMetadata(),
      verticalGrid: appliedValues["coordinates.verticalTransform"],
      heightOffsetMeters: activeConfig.renderer === "cesium"
        ? activeConfig.heightOffsetMeters
        : undefined,
      terrainResidualMeters: terrainResidual,
      hierarchy: activeSession?.getHierarchyDiagnostics(),
      sourceProbe,
      safeSourceProbeLabel: sourceProbe
        ? getSafeSourceLabel(sourceProbe.source, window.location.href)
        : undefined,
      safeSourceProbeWarnings: sourceProbe
        ? safeErrorMessage(sourceProbe.warnings.join(" ")).trim() || "—"
        : undefined,
      sourceProbePolicy,
      configuredRangeValidation: activeConfig.rangeValidation,
      rangeValidationApplicable: sourceSupportsHttpRange(
        activeConfig.source,
        window.location.href,
      ),
      lastError:
        lastError ??
        (activeDebugAdapter?.getLastError()
          ? safeErrorMessage(activeDebugAdapter.getLastError())
          : undefined),
      };
    },
  );
  const tilesDiagnosticsTarget = document.createElement("div");
  healthPanel.append(tilesDiagnosticsTarget);
  const tilesDiagnosticsPanel = mountDiagnosticSections(
    tilesDiagnosticsTarget,
    [{
      id: "health-tiles-pipeline",
      title: "Experimental 3D Tiles pipeline",
      description: "Live counters come from the Adapter Core source, Tiles resource server, and active renderer. Unsupported conservative bounds stop before content GLBs are requested.",
      initiallyOpen: true,
      fields: [
        { key: "tilesActivePipeline", label: "Active pipeline" },
        { key: "tilesAttemptStatus", label: "Tiles attempt status" },
        { key: "tilesSourceCrs", label: "Source CRS" },
        { key: "tilesBounds", label: "Conservative bounds" },
        { key: "tilesBoundsReason", label: "Bounds reason" },
        { key: "tilesHierarchy", label: "Scanned hierarchy" },
        { key: "tilesRequested", label: "Content GLB requests" },
        { key: "tilesLoaded", label: "Loaded tiles" },
        { key: "tilesVisible", label: "Visible tiles" },
        { key: "tilesRenderedPoints", label: "Visible points" },
        { key: "tilesResourceBytes", label: "Resource bytes served" },
        { key: "tilesGlbBytes", label: "Generated GLB bytes served" },
        { key: "tilesSourceGeneration", label: "Adapter source generation" },
        { key: "tilesError", label: "Tiles pipeline error" },
      ],
    }],
    { className: "copc-debug-panel__groups", sectionClassName: "copc-debug-panel__section workbench-diagnostic-section" },
  );
  const updateTilesDiagnosticsPanel = (): void => {
    const value = tilesDiagnostics;
    tilesDiagnosticsPanel.update({
      tilesActivePipeline: activeConfig.pipeline === "tiles" ? "3D Tiles (Experimental)" : "Direct COPC",
      tilesAttemptStatus: value?.status ?? "No 3D Tiles attempt in this session",
      tilesSourceCrs: value?.sourceCrs,
      tilesBounds: value?.boundsSupport,
      tilesBoundsReason: value?.boundsReason,
      tilesHierarchy: value
        ? `${value.hierarchyNodes} nodes · ${value.hierarchyPages} pages · ${value.hierarchyPageBytes.toLocaleString()} bytes`
        : undefined,
      tilesRequested: value?.requestedTiles.toLocaleString(),
      tilesLoaded: value?.loadedTiles.toLocaleString(),
      tilesVisible: value?.visibleTiles.toLocaleString(),
      tilesRenderedPoints: value?.renderedPoints.toLocaleString(),
      tilesResourceBytes: value?.resourceBytes.toLocaleString(),
      tilesGlbBytes: value?.glbBytes.toLocaleString(),
      tilesSourceGeneration: value?.sourceGeneration?.toString(),
      tilesError: value?.error,
    });
  };
  updateTilesDiagnosticsPanel();
  setInspectorPolling = (enabled) => debugPanel.setPollingEnabled(enabled);
  debugPanel.setPollingEnabled(
    inspectorExpanded && tabUsesDiagnostics(selectedRightTab),
  );
  const status = document.createElement("p");
  status.id = "source-status";
  status.className = "dev-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Loading configured source…";
  sourcePanel.prepend(status);

  const setActiveError = (error: unknown): void => {
    lastError = actionableAttributeLoadingError(error);
    showConfigurationError(lastError);
    updateStatus(lastError, "error");
    refreshIntegrationCode();
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
    applyTrace?: ApplyTrace,
  ): Promise<void> {
    const currentGeneration = ++generation;
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
    const tilesFilteringError = config.pipeline === "tiles"
      ? getTilesUnsupportedFilteringError(config)
      : undefined;
    if (tilesFilteringError) {
      if (!activeSession) {
        updateStatus(
          "Configuration ready · switch to Direct COPC or clear unsupported filter settings.",
          "inactive",
        );
      }
      updateConfigurationState();
      return;
    }
    const schemaValidationErrors = workbenchControls?.getValidationErrors() ?? [];
    if (schemaValidationErrors.length > 0) {
      const message = schemaValidationErrors.join(" ");
      showConfigurationError(message);
      updateStatus(message, "error");
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
      activeConfig.pipeline !== config.pipeline ||
      activeConfig.pipeline === "tiles" ||
      config.pipeline === "tiles" ||
      !sameSource(activeConfig.source, config.source) ||
      needsSessionRecreation(
        activeConfig,
        config,
        Boolean(activeSession),
        sourceSupportsHttpRange(config.source, window.location.href),
        verticalGridResources.hostValidators,
      );
    if (applyTrace) {
      recordApplyTrace(applyTrace, "session-replacement-started");
    }
    const previousCamera = activeSession?.getCameraState();
    const previousPending = { ...pendingConfig };
    let candidateMount: HTMLElement | undefined;
    let candidateSession: ViewerSession | undefined;
    let candidateProbe: CopcSourceProbeResult | undefined;

    if (!recreate) {
      try {
        const session = activeSession;
        if (!session) throw new Error("The active viewer session is unavailable.");
        const runtimePlan = buildSchemaApplicationPlan(
          {
            ...toWorkbenchOptionValues(config),
            "source.url": config.source,
            "renderer.engine": config.renderer,
          },
          {
            manifest: WORKSPACE_CURRENT_MANIFEST,
            renderer: config.renderer,
            runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
          },
          toWorkbenchOptionValues(activeConfig),
        undefined,
        verticalGridResources.hostValidators,
        );
        await applySchemaRuntimeOperations(session, runtimePlan.runtimeOperations);
        activeConfig = { ...config };
        refreshIntegrationCode();
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
        recordApplyTrace(applyTrace, "source-probe-started");
        sourceProbePolicy = config.rangeValidation;
        sourceProbe = undefined;
        debugPanel.refresh();
        candidateProbe = await probeCopcSource(config.source, {
          rangeValidation: config.rangeValidation,
          signal: controller.signal,
        });
        recordApplyTrace(applyTrace, "source-probe-completed");
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
      recordApplyTrace(applyTrace, "candidate-mount-created");
      const reportCandidateError = (error: unknown): void => {
        if (currentGeneration !== generation || disposed) return;
        lastError = safeErrorMessage(error);
        if (config.pipeline === "tiles" && tilesDiagnostics) {
          tilesDiagnostics = Object.freeze({
            ...tilesDiagnostics,
            status: "error",
            error: lastError,
          });
          updateTilesDiagnosticsPanel();
        }
        updateStatus(lastError, "error");
        debugPanel.refresh();
      };
      const handlePointPicked = (
        point: CopcPointInspection | undefined,
        position?: PointScreenPosition,
      ): void => {
        if (!candidateSession || activeSession !== candidateSession) return;
        updatePointVerticalReferenceContext();
        pointPopover.setSelection(point, position);
        terrainAlignmentControl?.update();
      };
      const handlePointPositionChanged = (
        position: PointScreenPosition | undefined,
      ): void => {
        if (!candidateSession || activeSession !== candidateSession) return;
        pointPopover.updatePosition(position);
      };
      recordApplyTrace(applyTrace, "session-create-started");
      candidateSession = config.pipeline === "tiles"
        ? await createTilesPipelineSession(
            candidateMount,
            config,
            controller.signal,
            () => !disposed && (
              (candidateSession !== undefined && activeSession === candidateSession) ||
              currentGeneration === generation
            ),
            (value) => {
              if (currentGeneration !== generation || disposed) return;
              tilesDiagnostics = value;
              updateTilesDiagnosticsPanel();
            },
            reportCandidateError,
          )
        : config.renderer === "cesium"
          ? await createCesiumSession(
              candidateMount,
              config,
              reportCandidateError,
              handlePointPicked,
              handlePointPositionChanged,
              applyTrace,
            )
          : createThreeSession(
              candidateMount,
              config,
              reportCandidateError,
              handlePointPicked,
              handlePointPositionChanged,
            );
      recordApplyTrace(applyTrace, "session-created");
      stagedSession = candidateSession;
      recordApplyTrace(applyTrace, "session-ready-wait-started");
      await candidateSession.ready;
      recordApplyTrace(applyTrace, "session-ready");
      if (currentGeneration !== generation || disposed) {
        candidateSession.destroy();
        candidateMount.remove();
        return;
      }

      if (
        previousCamera &&
        activeConfig.pipeline === config.pipeline &&
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
      recordApplyTrace(applyTrace, "candidate-mount-visible");
      pointPopover.clear();
      recordApplyTrace(applyTrace, "old-session-disposal-started");
      activeDebugAdapter?.destroy();
      activeSession?.destroy();
      recordApplyTrace(applyTrace, "old-session-disposed");
      activeMount?.remove();
      activeSession = candidateSession;
      activeMount = candidateMount;
      stagedSession = undefined;
      stagedMount = undefined;
      activeDebugAdapter = candidateSession.debugAdapter;
      activeDebugAdapter?.activate();
      activeConfig = { ...config };
      lastFollowCursorPosition = undefined;
      tilesDiagnostics = candidateSession.getTilesDiagnostics?.();
      updateTilesDiagnosticsPanel();
      workbenchControls?.updateContext();
      if (candidateSession.renderer === "cesium" && candidateSession.pipeline === "direct") {
        followCursorTracker.refreshTarget();
        if (followCursorEnabled && followCursorFocus) {
          setLiveFocus(followCursorFocus);
        }
      } else {
        followCursorEnabled = false;
        followCursorTracker.setEnabled(false);
      }
      updatePointVerticalReferenceContext();
      const appliedValues = toWorkbenchOptionValues(config);
      const appliedExtraDimensions = appliedValues["attributes.extraDimensions"];
      const intensityDecoded = configuredLayerLoadsIntensity(appliedValues, {
        manifest: WORKSPACE_CURRENT_MANIFEST,
        renderer: config.renderer,
        runtimeCapabilities: WORKSPACE_CURRENT_CAPABILITIES,
      });
      workbenchControls?.setNumericDimensionMetadata(
        candidateSession.getMetadata(),
        Array.isArray(appliedExtraDimensions)
          ? appliedExtraDimensions.filter((name): name is string => typeof name === "string")
          : appliedExtraDimensions === "*" ? ["*"] : [],
        intensityDecoded,
      );
      refreshIntegrationCode();
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
        (config.pipeline === "tiles" ? "Ready · 3D Tiles (Experimental) · " : "Ready · ") +
          getSafeSourceLabel(config.source, window.location.href),
        "ready",
      );
      recordApplyTrace(applyTrace, "status-ready");
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
      controller.abort();
      recordApplyTrace(applyTrace, "apply-error");
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

  workbenchControls = mountDevViewerControls({
    initialConfig: pendingConfig,
    loadVerticalGrid: verticalGridResources.loadFile,
    verticalGridHostValidators: verticalGridResources.hostValidators,
    canLoadVerticalGrid: () => !isLoading && !verticalGridResources.isLoadedGrid(
      toWorkbenchOptionValues(activeConfig)["coordinates.verticalTransform"],
    ),
    isVerticalGridApplied: (value) =>
      toWorkbenchOptionValues(activeConfig)["coordinates.verticalTransform"] === value,
    getFollowCursorEnabled: () => followCursorEnabled,
    isFollowCursorAvailable,
    isBusy: () => isLoading,
    onFollowCursorChange: setFollowCursor,
    getSelectedPointEcef: () => {
      const world = activeSession?.getSelectedPoint()?.world;
      return world?.coordinateSystem === "wgs84-ecef-meters"
        ? [world.x, world.y, world.z]
        : undefined;
    },
    onValidationChange() {
      updateConfigurationState();
    },
    renderAction(action) {
      if (action.id !== "coordinates.terrainAlignment") return undefined;
      const actionTarget = document.createElement("div");
      const control = mountTerrainAlignmentControl({
        target: actionTarget,
        getState: () => ({
          contextKey: `${generation}:${activeConfig.renderer}`,
          renderer: activeSession?.renderer ?? pendingConfig.renderer,
          apiAvailable: WORKSPACE_CURRENT_CAPABILITIES.includes("cesium.terrain-alignment") &&
            activeSession?.renderer === "cesium" &&
            typeof activeSession.estimateTerrainHeightAlignment === "function",
          apiUnavailableReason: "The verified local workspace package exposes Terrain alignment only in Cesium mode.",
          batchAvailable: typeof activeSession?.estimateTerrainHeightAlignmentBatch === "function",
          providerAvailable: activeSession?.terrainProviderAvailable === true,
          providerStatus: activeSession?.terrainSourceStatus ??
            (activeConfig.terrainUrl.trim()
              ? "Terrain source is not active yet. Apply Settings to load it."
              : "WGS84 ellipsoid only · imagery may still be shown; no terrain elevations are available."),
          selectedPoint: activeSession?.renderer === "cesium"
            ? activeSession.getSelectedPoint()
            : undefined,
          heightOffsetMeters: activeConfig.heightOffsetMeters,
          applying: isLoading,
        }),
        estimate: async (candidates, signal) => {
          const session = activeSession;
          if (!session || session.renderer !== "cesium") {
            throw new Error("Load a Cesium source before estimating Terrain alignment.");
          }
          if (candidates.length >= 2) {
            if (!session.estimateTerrainHeightAlignmentBatch) {
              throw new Error("The active package does not expose the Terrain batch API.");
            }
            return session.estimateTerrainHeightAlignmentBatch(candidates, {
              maxAnchors: 8,
              signal,
            });
          }
          const candidate = candidates[0];
          if (!candidate || !session.estimateTerrainHeightAlignment) {
            throw new Error("The active package does not expose the single-anchor Terrain API.");
          }
          return session.estimateTerrainHeightAlignment(candidate.anchor, {
            groundConfirmed: candidate.groundConfirmed,
            signal,
          });
        },
        isEstimateCurrent: (estimate) => {
          const session = activeSession;
          if (!session || session.renderer !== "cesium") return false;
          if (estimate.coverage) {
            return session.isTerrainHeightAlignmentBatchEstimateCurrent?.(
              estimate as unknown as TerrainHeightAlignmentBatchEstimate,
            ) ?? false;
          }
          return session.isTerrainHeightAlignmentEstimateCurrent?.(
            estimate as unknown as TerrainHeightAlignmentEstimate,
          ) ?? false;
        },
        apply: async (finalHeightOffsetMeters, estimate) => {
          if (!Number.isFinite(finalHeightOffsetMeters)) return false;
          const previousActiveConfig = activeConfig;
          const approvedProvenance = {
            source: activeConfig.source,
            terrainUrl: activeConfig.terrainUrl,
            finalHeightOffsetMeters,
            residualMeters: estimate.medianResidualMeters ?? estimate.proposedOffsetMeters ?? 0,
          };
          const applyTrace: ApplyTrace = { startedAt: performance.now(), events: [] };
          lastApplyTrace = applyTrace;
          recordApplyTrace(applyTrace, "apply-input");
          await runSession(
            { ...activeConfig, heightOffsetMeters: finalHeightOffsetMeters },
            "alignment",
            applyTrace,
          );
          const applied = activeConfig !== previousActiveConfig &&
            activeConfig.renderer === "cesium" &&
            sameSource(activeConfig.source, approvedProvenance.source) &&
            activeConfig.terrainUrl === approvedProvenance.terrainUrl &&
            activeConfig.heightOffsetMeters === finalHeightOffsetMeters;
          if (applied) {
            approvedTerrainAlignmentProvenance = {
              ...approvedProvenance,
              verticalTransformIdentity: getVerticalTransformIdentity(
                toWorkbenchOptionValues(activeConfig)["coordinates.verticalTransform"],
              ),
            };
            updatePointVerticalReferenceContext();
            debugPanel.refresh();
            refreshIntegrationCode();
          }
          return applied;
        },
      });
      terrainAlignmentControl = control;
      return {
        element: actionTarget,
        destroy() {
          control.destroy();
          if (terrainAlignmentControl === control) terrainAlignmentControl = undefined;
        },
      };
    },
    sourcePresets: new Map<string, string>([
      ["wgs84-demo", "/samples/demo-wgs84.copc.laz"],
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
      workbenchControls?.updateContext();
      updateConfigurationState();
      return cameraRenderDistance;
    },
    onPipelineSelected(value) {
      resolveStartupIssue("pipeline");
      pendingConfig = { ...pendingConfig, pipeline: value };
      workbenchControls?.updateContext();
      if (
        value === "direct" &&
        !activeSession &&
        startupIssues.size === 0 &&
        !configurationError
      ) {
        updateStatus("Configuration ready · load the selected source.", "inactive");
      }
      updateConfigurationState();
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
    onColorModeSelected(value, dimension) {
      const pendingSchemaOptionValues = {
        ...(pendingConfig.schemaOptionValues ?? {}),
        ...(value === "dimension" && dimension
          ? { "style.dimension": dimension }
          : {}),
      };
      pendingConfig = {
        ...pendingConfig,
        colorMode: value,
        schemaOptionValues: pendingSchemaOptionValues,
      };
      if (activeSession?.renderer === "cesium") {
        try {
          if (!activeSession.setStyle) {
            throw new TypeError("The active Cesium layer does not support runtime style updates.");
          }
          if (activeSession.pipeline === "tiles") {
            throw new TypeError("Color styling is unavailable while 3D Tiles is selected. Switch to Direct COPC to change colors.");
          }
          activeSession.setStyle({
            colorMode: value,
            ...(value === "dimension" && dimension ? { dimension } : {}),
          });
          activeConfig = commitRuntimeColorMode(activeConfig, value, dimension);
          refreshIntegrationCode();
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
    const source = workbenchControls?.getSelectedSource();
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
    estimateTerrainHeightAlignmentBatch: (candidates, options) => {
      const estimate = activeSession?.estimateTerrainHeightAlignmentBatch?.(
        candidates,
        options,
      );
      return estimate ?? Promise.reject(new Error("No active Cesium session"));
    },
    isTerrainHeightAlignmentBatchEstimateCurrent: (estimate) =>
      activeSession?.isTerrainHeightAlignmentBatchEstimateCurrent?.(estimate) ?? false,
    getPickablePointScreenPosition: () =>
      activeSession?.getPickablePointScreenPosition(),
    getConfiguration: () => publicConfig(activeConfig),
    getPendingConfiguration: () => publicConfig(pendingConfig),
    getLastApplyTrace: () => lastApplyTrace?.events.map((event) => ({ ...event })) ?? [],
    getTilesDiagnostics: () => activeSession?.getTilesDiagnostics?.() ?? tilesDiagnostics,
    getTilesetUrl: () => activeSession?.getTilesetUrl?.(),
    getCameraState: () => activeSession?.getCameraState(),
  };

  window.addEventListener(
    "pagehide",
    () => {
      disposed = true;
      generation += 1;
      followCursorTracker.destroy();
      probeAbortController?.abort();
      debugPanel.destroy();
      tilesDiagnosticsPanel.destroy();
      integrationCodePanel.destroy();
      rightTabs.destroy();
      workbenchControls?.destroy();
      activeDebugAdapter?.destroy();
      stagedSession?.destroy();
      activeSession?.destroy();
      pointPopover.destroy();
      workbenchLayout.destroy();
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
