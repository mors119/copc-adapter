import "cesium/Build/Cesium/Widgets/widgets.css";

import * as Cesium from "cesium";
import {
  CopcCesiumLayer,
  type CopcCesiumLayerSnapshot,
} from "@frillab/copc-adapter";

export type CameraView = {
  longitudeDegrees: number;
  latitudeDegrees: number;
  heightMeters: number;
  headingDegrees: number;
  pitchDegrees: number;
};

export type LifecycleState = {
  snapshot: CopcCesiumLayerSnapshot;
  metadataPointCount?: number;
  hierarchy?: ReturnType<CopcCesiumLayer["getHierarchyDiagnostics"]>;
  viewerDestroyed: boolean;
  scenePrimitiveCount: number;
  pointCollectionCount: number;
  canvasCount: number;
  cameraMoveEndListeners: number;
  cameraChangedListeners: number;
  longestMainThreadTaskMs: number;
  longTaskCount: number;
  cesiumFrameDurationMs: number;
};

export type LifecycleFixture = {
  cesiumVersion: string;
  source: string;
  createLayer(cacheBudgetBytes?: number): void;
  load(): Promise<void>;
  attach(): void;
  detach(): void;
  setCameraView(view: CameraView): void;
  unload(): void;
  reload(): Promise<void>;
  destroy(): void;
  getState(): LifecycleState;
};

declare global {
  interface Window {
  __COPC_SOAK_FIXTURE__?: LifecycleFixture;
  }
}

function countPointCollections(
  collection: Cesium.PrimitiveCollection,
): number {
  let count = 0;
  for (let index = 0; index < collection.length; index += 1) {
    const primitive = collection.get(index);
    if (primitive instanceof Cesium.PointPrimitiveCollection) {
      count += 1;
    } else if (primitive instanceof Cesium.PrimitiveCollection) {
      count += countPointCollections(primitive);
    }
  }
  return count;
}

const params = new URLSearchParams(window.location.search);
const cesiumVersion = (Cesium as typeof Cesium & { VERSION: string }).VERSION;
const source = params.get("source") ?? "/samples/autzen.copc.laz";
const cacheBytesParam = params.get("cacheBytes");
const cacheBytesValue =
  cacheBytesParam === null ? undefined : Number(cacheBytesParam);
const maxPointCacheBytes =
  cacheBytesValue !== undefined &&
  Number.isSafeInteger(cacheBytesValue) &&
  cacheBytesValue >= 0
    ? cacheBytesValue
    : undefined;
const viewer = new Cesium.Viewer("viewer", {
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
});

let layer: CopcCesiumLayer | undefined;
let longestMainThreadTaskMs = 0;
let longTaskCount = 0;
let frameStartedAt = 0;
let cesiumFrameDurationMs = 0;

if (typeof PerformanceObserver !== "undefined") {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longestMainThreadTaskMs = Math.max(
          longestMainThreadTaskMs,
          entry.duration,
        );
        longTaskCount += 1;
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // Long Task API is optional in browser engines.
  }
}

viewer.scene.preRender.addEventListener(() => {
  frameStartedAt = performance.now();
});
viewer.scene.postRender.addEventListener(() => {
  if (frameStartedAt > 0) {
    cesiumFrameDurationMs = performance.now() - frameStartedAt;
  }
});

function requireLayer(): CopcCesiumLayer {
  if (!layer) throw new Error("Create the COPC layer before using it");
  return layer;
}

window.__COPC_SOAK_FIXTURE__ = {
  cesiumVersion,
  source,
  createLayer(cacheBudgetBytes?: number): void {
    if (layer && layer.getSnapshot().lifecycle !== "destroyed") {
      throw new Error("Destroy the current layer before creating another");
    }
    const configuredCacheBudgetBytes = cacheBudgetBytes ?? maxPointCacheBytes;
    layer = new CopcCesiumLayer({
      url: source,
      backend: "rust",
      colorMode: "elevation",
      pointSize: 2,
      maxRenderedPoints: 250_000,
      ...(configuredCacheBudgetBytes === undefined
        ? {}
        : { maxPointCacheBytes: configuredCacheBudgetBytes }),
      maxConcurrentRangeRequests: 4,
      streaming: {
        maxNodes: 32,
        maxDepth: 6,
        maxScreenSpaceError: 8,
        maxRenderDistanceMeters: 20_000,
        motionLookahead: true,
      },
    });
  },
  load: () => requireLayer().load(),
  attach: () => requireLayer().attachTo(viewer),
  detach: () => requireLayer().detachFrom(),
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
  unload: () => requireLayer().unload(),
  reload: () => requireLayer().reload(),
  destroy: () => requireLayer().destroy(),
  getState(): LifecycleState {
    const activeLayer = requireLayer();
    const snapshot = activeLayer.getSnapshot();
    return {
      snapshot,
      metadataPointCount: activeLayer.getMetadata()?.pointCount,
      hierarchy: activeLayer.getHierarchyDiagnostics(),
      viewerDestroyed: viewer.isDestroyed(),
      scenePrimitiveCount: viewer.scene.primitives.length,
      pointCollectionCount: countPointCollections(viewer.scene.primitives),
      canvasCount: document.querySelectorAll("#viewer canvas").length,
      cameraMoveEndListeners: viewer.camera.moveEnd.numberOfListeners,
      cameraChangedListeners: viewer.camera.changed?.numberOfListeners ?? 0,
      longestMainThreadTaskMs,
      longTaskCount,
      cesiumFrameDurationMs,
    };
  },
};
