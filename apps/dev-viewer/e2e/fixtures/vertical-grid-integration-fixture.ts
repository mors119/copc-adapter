import * as Cesium from "cesium";
import {
  CopcJsBackend,
  CopcCesiumLayer,
  RustCopcBackend,
  RustCrsTransformer,
  VerticalTransformError,
  createCopcPointFieldSelection,
  loadGtxGeoidGrid,
  transformPointBufferToPreparedPointData,
  type CopcCesiumLayerSnapshot,
  type CopcPointInspection,
  type GtxGeoidGrid,
} from "@frillab/copc-adapter/cesium";
import {
  applyPreparedPointVerticalGrid,
  createPointTransformer,
  createProjectPointTransformer,
} from "../../../../packages/adapter/core/coordinates/transform/createPointTransformer";

type LayerOptions = {
  id: string;
  source: string;
  backend?: "copc-js" | "rust";
  gridId?: string;
  heightOffsetMeters?: number;
  workers?: boolean;
};

type LayerRecord = {
  layer: CopcCesiumLayer;
  errorMessages: string[];
  ownerIds: Set<string>;
  preexistingOwnerIds: ReadonlySet<string>;
  startedAt: number;
  firstVisibleAt?: number;
};

type GridShape = { width: number; height: number };

type LayerState = {
  snapshot: Pick<
    CopcCesiumLayerSnapshot,
    | "lifecycle"
    | "backend"
    | "renderedPointCount"
    | "renderedNodeKeys"
    | "selectedNodeKeys"
    | "streamingUpdateCount"
    | "pointCache"
    | "rangeRequests"
    | "worker"
    | "transition"
    | "performance"
  >;
  selectedPoint?: CopcPointInspection;
  boundingSphere?: { x: number; y: number; z: number; radius: number };
  errors: string[];
  ownerIds: string[];
  camera: { longitude: number; latitude: number; height: number; pitch: number };
  viewDistance?: { effectiveDistanceMeters: number; maxRenderDistanceMeters: number };
  hierarchy?: ReturnType<CopcCesiumLayer["getHierarchyDiagnostics"]>;
  selection?: { candidatesBeforeCulling: number; frustumCulledCount: number; selectedNodeCount: number };
  cameraTargetScreen?: { x: number; y: number };
  timings?: { firstVisibleMs?: number; elapsedMs: number };
}

type VerticalGridIntegration = {
  createGrid(
    metres: number,
    outsideCoverage?: boolean,
    sourceVerticalCrs?: string,
    shape?: GridShape,
  ): Promise<string>;
  transformWkt2Control(input: {
    wkt: string;
    point: { x: number; y: number; z: number };
    gridId: string;
  }): Promise<{
    geographic: { longitude: number; latitude: number; height: number };
    projected: { x: number; y: number; z: number };
    rustGeographic: [number, number, number];
  }>;
  getGridInfo(id: string): {
    width: number;
    height: number;
    encodedByteLength: number;
    decodedByteLength: number;
    loadDurationMs: number;
  };
  releaseGrid(id: string): void;
  createLayer(options: LayerOptions): Promise<{ error?: string; code?: string }>;
  getState(id: string): LayerState;
  getScreenPoint(id: string): { x: number; y: number } | undefined;
  getLastCanvasClick(): { clientX: number; clientY: number; offsetX: number; offsetY: number } | undefined;
  setShow(id: string, show: boolean): void;
  setRefinementFocus(id: string, enabled: boolean): void;
  zoomTo(id: string): Promise<boolean>;
  setCamera(
    longitude: number,
    latitude: number,
    altitude: number,
    pitchRadians?: number,
  ): void;
  reload(id: string): Promise<void>;
  destroyLayer(id: string): void;
  missingGridError(): Promise<string | undefined>;
  cancelWorkerQueue(source: string): Promise<{
    supported: boolean;
    workerCount?: number;
    submittedCount?: number;
    cancelledCount?: number;
    peakQueuedCount?: number;
  }>;
  compareBackends(
    source: string,
    gridId: string,
    workers?: boolean,
  ): Promise<{
    pointCount: number;
    comparedPoints: number;
    maxHeightDifferenceMeters: number;
    maxEcefDifferenceMeters: number;
    sourceCoordinatesEqual: boolean;
    worker?: { workerCount: number; completedCount: number };
  }>;
  expectedWorld(point: CopcPointInspection): { x: number; y: number; z: number };
  dispose(): void;
};

type IntegrationWindow = Window & {
  __VERTICAL_GRID_INTEGRATION__?: VerticalGridIntegration;
};

const viewer = new Cesium.Viewer("viewer", {
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  baseLayer: false,
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
});
viewer.scene.globe.show = false;
viewer.scene.requestRenderMode = false;
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(-123, 44, 16_000),
  orientation: {
    heading: 0,
    pitch: -Cesium.Math.PI_OVER_TWO,
    roll: 0,
  },
});

const layers = new Map<string, LayerRecord>();
const grids = new Map<string, GtxGeoidGrid>();
const gridLoadDurationMs = new Map<string, number>();
let cameraChangedEventCount = 0;
let cameraMoveEndEventCount = 0;
let postRenderFrameCount = 0;
let lastCameraChangedAtMs: number | undefined;
let lastCameraMoveEndAtMs: number | undefined;
let nextGridId = 0;
let lastCanvasClick:
  | { clientX: number; clientY: number; offsetX: number; offsetY: number }
  | undefined;
viewer.scene.canvas.addEventListener("click", (event) => {
  if (!(event instanceof MouseEvent)) return;
  lastCanvasClick = {
    clientX: event.clientX,
    clientY: event.clientY,
    offsetX: event.offsetX,
    offsetY: event.offsetY,
  };
});
viewer.camera.changed.addEventListener(() => {
  cameraChangedEventCount += 1;
  lastCameraChangedAtMs = performance.now();
});
viewer.camera.moveEnd.addEventListener(() => {
  cameraMoveEndEventCount += 1;
  lastCameraMoveEndAtMs = performance.now();
});
viewer.scene.postRender.addEventListener(() => {
  postRenderFrameCount += 1;
  const now = performance.now();
  for (const record of layers.values()) {
    if (
      record.firstVisibleAt === undefined &&
      record.layer.getSnapshot().renderedPointCount > 0
    ) {
      record.firstVisibleAt = now;
    }
  }
});

function encodeGtx(
  metres: number,
  outsideCoverage: boolean,
  shape?: GridShape,
): ArrayBuffer {
  const width = shape?.width ?? 4;
  const height = shape?.height ?? 4;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 2 ||
    height < 2
  ) {
    throw new Error("Synthetic benchmark grid dimensions must be integers of at least 2");
  }
  const global = shape !== undefined;
  const bytes = new ArrayBuffer(40 + width * height * 4);
  const header = new DataView(bytes);
  header.setFloat64(0, outsideCoverage ? -1 : global ? -90 : 42, false);
  header.setFloat64(8, outsideCoverage ? -1 : global ? -180 : -125, false);
  header.setFloat64(16, global ? 180 / (height - 1) : 1, false);
  header.setFloat64(
    24,
    global ? (width === 361 ? 360 / (width - 1) : 360 / width) : 1,
    false,
  );
  header.setInt32(32, height, false);
  header.setInt32(36, width, false);
  for (let index = 0; index < width * height; index += 1) {
    header.setFloat32(40 + index * 4, metres, false);
  }
  return bytes;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function collectPointOwners(
  collection: Cesium.PrimitiveCollection,
  owners: Set<string>,
): void {
  for (let index = 0; index < collection.length; index += 1) {
    const primitive = collection.get(index);
    if (primitive instanceof Cesium.PointPrimitiveCollection) {
      for (let pointIndex = 0; pointIndex < primitive.length; pointIndex += 1) {
        const id = primitive.get(pointIndex).id;
        if (
          id !== null &&
          typeof id === "object" &&
          "ownerId" in id &&
          typeof id.ownerId === "string"
        ) {
          owners.add(id.ownerId);
        }
      }
    } else if (primitive instanceof Cesium.PrimitiveCollection) {
      collectPointOwners(primitive, owners);
    }
  }
}

function findVisiblePointScreenPosition(
  collection: Cesium.PrimitiveCollection,
  ownerIds: ReadonlySet<string>,
  selectedNodeKeys: ReadonlySet<string>,
): { x: number; y: number } | undefined {
  const canvas = viewer.scene.canvas;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  for (let index = 0; index < collection.length; index += 1) {
    const primitive = collection.get(index);
    if (primitive instanceof Cesium.PointPrimitiveCollection) {
      for (let pointIndex = 0; pointIndex < primitive.length; pointIndex += 1) {
        const point = primitive.get(pointIndex);
        const id = point.id;
        if (
          !point.show ||
          id === null ||
          typeof id !== "object" ||
          !("ownerId" in id) ||
          typeof id.ownerId !== "string" ||
          !ownerIds.has(id.ownerId) ||
          !("nodeKey" in id) ||
          typeof id.nodeKey !== "string" ||
          !selectedNodeKeys.has(id.nodeKey)
        ) {
          continue;
        }
        const position = Cesium.SceneTransforms.worldToWindowCoordinates(
          viewer.scene,
          point.position,
        );
        if (
          position &&
          position.x >= 220 &&
          position.x < width - 1 &&
          position.y >= 10 &&
          position.y < height - 50
        ) {
          return { x: position.x, y: position.y };
        }
      }
    } else if (primitive instanceof Cesium.PrimitiveCollection) {
      const nested = findVisiblePointScreenPosition(
        primitive,
        ownerIds,
        selectedNodeKeys,
      );
      if (nested) return nested;
    }
  }
  return undefined;
}

function refreshLayerPointOwners(record: LayerRecord): void {
  const currentOwners = new Set<string>();
  collectPointOwners(viewer.scene.primitives, currentOwners);
  for (const ownerId of currentOwners) {
    if (!record.preexistingOwnerIds.has(ownerId)) {
      record.ownerIds.add(ownerId);
    }
  }
}

function requireLayer(id: string): LayerRecord {
  const record = layers.get(id);
  if (!record) throw new Error(`Unknown vertical-grid layer: ${id}`);
  return record;
}

const integrationWindow = window as IntegrationWindow;
integrationWindow.__VERTICAL_GRID_INTEGRATION__ = {
  async createGrid(
    metres,
    outsideCoverage = false,
    sourceVerticalCrs = "EPSG:6360",
    shape,
  ) {
    const bytes = encodeGtx(metres, outsideCoverage, shape);
    const expectedSha256 = await sha256(bytes);
    const loadStartedAt = performance.now();
    const grid = await loadGtxGeoidGrid(bytes, {
      gridId: `browser-synthetic-${metres}-${outsideCoverage ? "outside" : "covered"}`,
      sourceVerticalCrs,
      targetVerticalCrs: "EPSG:4979",
      horizontalCrs: "EPSG:4326",
      referenceEllipsoid: "WGS84",
      sha256: expectedSha256,
      valueUnit: "metre",
      valueConvention: "ellipsoidal-minus-orthometric",
      noDataValue: null,
    });
    nextGridId += 1;
    const gridId = `grid-${nextGridId}`;
    grids.set(gridId, grid);
    gridLoadDurationMs.set(gridId, performance.now() - loadStartedAt);
    return gridId;
  },
  async transformWkt2Control({ wkt, point, gridId }) {
    const verticalGrid = grids.get(gridId);
    if (!verticalGrid) throw new Error(`Unknown vertical grid: ${gridId}`);
    const metadata = {
      pointCount: 1,
      wkt,
      bounds: {
        minX: point.x,
        minY: point.y,
        maxX: point.x,
        maxY: point.y,
        minZ: point.z,
        maxZ: point.z,
      },
      cube: {
        minX: point.x,
        minY: point.y,
        maxX: point.x,
        maxY: point.y,
        minZ: point.z,
        maxZ: point.z,
      },
    };
    const geographic = createPointTransformer(metadata, 0, verticalGrid)(point);
    const rustTransformer = await RustCrsTransformer.fromMetadata(metadata);
    try {
      const rust = rustTransformer.transform(
        new Float64Array([point.x, point.y, point.z]),
      );
      return {
        geographic,
        projected: createProjectPointTransformer(metadata, 0, verticalGrid)(geographic),
        rustGeographic: [
          rust.geographicCoordinates[0],
          rust.geographicCoordinates[1],
          rust.geographicCoordinates[2],
        ],
      };
    } finally {
      rustTransformer.dispose();
    }
  },
  getGridInfo(id) {
    const grid = grids.get(id);
    const loadDurationMs = gridLoadDurationMs.get(id);
    if (!grid || loadDurationMs === undefined) {
      throw new Error(`Unknown vertical grid: ${id}`);
    }
    return {
      width: grid.width,
      height: grid.height,
      encodedByteLength: grid.encodedByteLength,
      decodedByteLength: grid.decodedByteLength,
      loadDurationMs,
    };
  },
  releaseGrid(id) {
    grids.delete(id);
    gridLoadDurationMs.delete(id);
  },
  async createLayer(options) {
    if (layers.has(options.id)) {
      throw new Error(`Vertical-grid layer ${options.id} already exists`);
    }
    const ownersBefore = new Set<string>();
    collectPointOwners(viewer.scene.primitives, ownersBefore);
    const originalWorker = globalThis.Worker;
    if (options.workers === false) {
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        value: undefined,
      });
    }
    const startedAt = performance.now();
    const record: LayerRecord = {
      startedAt,
      layer: new CopcCesiumLayer({
        url: options.source,
        // This fixture asserts exact source-Z conversion across grid paths.
        // Other browser coverage exercises the default compact E layout.
        coordinateCacheLayout: "A",
        backend: options.backend ?? "copc-js",
        ...(options.gridId
          ? { verticalTransform: grids.get(options.gridId) }
          : {}),
        ...(options.heightOffsetMeters === undefined
          ? {}
          : { heightOffsetMeters: options.heightOffsetMeters }),
        maxRenderedPoints: 250_000,
        maxPointCacheBytes: 64 * 1024 * 1024,
        maxConcurrentRangeRequests: 4,
        streaming: {
          maxNodes: 24,
          maxDepth: 6,
          maxScreenSpaceError: 12,
          maxRenderDistanceMeters: 25_000,
        },
      }),
      errorMessages: [],
      ownerIds: new Set(),
      preexistingOwnerIds: ownersBefore,
    };
    layers.set(options.id, record);
    record.layer.error.addEventListener((event) => {
      record.errorMessages.push(
        event.error instanceof Error ? event.error.message : String(event.error),
      );
    });
    try {
      await record.layer.load();
      record.layer.attachTo(viewer);
      await record.layer.zoomTo(
        new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 2_500),
      );
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
          -123.06875,
          44.04034,
          3_500,
        ),
        orientation: {
          heading: 0,
          pitch: -Cesium.Math.PI_OVER_FOUR,
          roll: 0,
        },
      });
      viewer.camera.moveEnd.raiseEvent();
    } catch (error) {
      const transformError = error instanceof VerticalTransformError ? error : undefined;
      return {
        error: error instanceof Error ? error.message : String(error),
        ...(transformError ? { code: transformError.code } : {}),
      };
    } finally {
      if (options.workers === false) {
        Object.defineProperty(globalThis, "Worker", {
          configurable: true,
          value: originalWorker,
        });
      }
    }
    refreshLayerPointOwners(record);
    return {};
  },
  getState(id) {
    const record = requireLayer(id);
    refreshLayerPointOwners(record);
    const snapshot = record.layer.getSnapshot();
    const sphere = record.layer.boundingSphere;
    return {
      snapshot: {
        lifecycle: snapshot.lifecycle,
        backend: snapshot.backend,
        renderedPointCount: snapshot.renderedPointCount,
        renderedNodeKeys: [...snapshot.renderedNodeKeys],
        selectedNodeKeys: [...snapshot.selectedNodeKeys],
        streamingUpdateCount: snapshot.streamingUpdateCount,
        pointCache: snapshot.pointCache,
        rangeRequests: snapshot.rangeRequests,
        transition: snapshot.transition,
        performance: snapshot.performance,
        ...(snapshot.worker ? { worker: snapshot.worker } : {}),
      },
      ...(record.layer.getSelectedPoint()
        ? { selectedPoint: record.layer.getSelectedPoint() }
        : {}),
      ...(sphere
        ? {
            boundingSphere: {
              x: sphere.center.x,
              y: sphere.center.y,
              z: sphere.center.z,
              radius: sphere.radius,
            },
          }
        : {}),
      timings: {
        elapsedMs: performance.now() - record.startedAt,
        ...(record.firstVisibleAt === undefined
          ? {}
          : { firstVisibleMs: record.firstVisibleAt - record.startedAt }),
      },
      errors: [...record.errorMessages],
      ownerIds: [...record.ownerIds],
      camera: {
        longitude: Cesium.Math.toDegrees(viewer.camera.positionCartographic.longitude),
        latitude: Cesium.Math.toDegrees(viewer.camera.positionCartographic.latitude),
        height: viewer.camera.positionCartographic.height,
        pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
        heading: Cesium.Math.toDegrees(viewer.camera.heading),
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
      },
      cameraEvents: {
        changedCount: cameraChangedEventCount,
        moveEndCount: cameraMoveEndEventCount,
        postRenderFrameCount,
        ...(lastCameraChangedAtMs === undefined
          ? {}
          : { lastChangedAtMs: lastCameraChangedAtMs }),
        ...(lastCameraMoveEndAtMs === undefined
          ? {}
          : { lastMoveEndAtMs: lastCameraMoveEndAtMs }),
      },
      ...(snapshot.viewDistance
        ? {
            viewDistance: {
              effectiveDistanceMeters: snapshot.viewDistance.effectiveDistanceMeters,
              maxRenderDistanceMeters: snapshot.viewDistance.maxRenderDistanceMeters,
            },
          }
        : {}),
      hierarchy: record.layer.getHierarchyDiagnostics(),
      selection: {
        candidatesBeforeCulling: snapshot.performance.candidatesBeforeCulling,
        frustumCulledCount: snapshot.performance.frustumCulledCount,
        selectedNodeCount: snapshot.performance.selectedNodeCount,
      },
      ...(sphere
        ? {
            cameraTargetScreen: (() => {
              const point = Cesium.SceneTransforms.worldToWindowCoordinates(
                viewer.scene,
                sphere.center,
              );
              return point ? { x: point.x, y: point.y } : undefined;
            })(),
          }
        : {}),
    };
  },
  getScreenPoint(id) {
    const record = requireLayer(id);
    refreshLayerPointOwners(record);
    const selectedNodeKeys = new Set(
      record.layer.getSnapshot().selectedNodeKeys,
    );
    return findVisiblePointScreenPosition(
      viewer.scene.primitives,
      record.ownerIds,
      selectedNodeKeys,
    );
  },
  getLastCanvasClick() {
    return lastCanvasClick;
  },
  setShow(id, show) {
    requireLayer(id).layer.show = show;
  },
  setRefinementFocus(id, enabled) {
    requireLayer(id).layer.setRefinementFocus(
      enabled
        ? {
            type: "screen-circle",
            center: { x: 0.5, y: 0.5 },
            radius: 1,
            detailBias: 1.5,
          }
        : undefined,
    );
  },
  async zoomTo(id) {
    return requireLayer(id).layer.zoomTo(
      new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 1_500),
    );
  },
  setCamera(longitude, latitude, altitude, pitchRadians) {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude),
      orientation: {
        heading: 0,
        pitch: pitchRadians ?? -Cesium.Math.PI_OVER_TWO,
        roll: 0,
      },
    });
    viewer.camera.moveEnd.raiseEvent();
  },
  async reload(id) {
    await requireLayer(id).layer.reload();
  },
  destroyLayer(id) {
    const record = layers.get(id);
    if (!record) return;
    record.layer.destroy();
    layers.delete(id);
  },
  async missingGridError() {
    try {
      await loadGtxGeoidGrid(undefined as never, {
        gridId: "missing-grid-browser-check",
        sourceVerticalCrs: "EPSG:6360",
        targetVerticalCrs: "EPSG:4979",
        horizontalCrs: "EPSG:4326",
        referenceEllipsoid: "WGS84",
        sha256: "0".repeat(64),
        valueUnit: "metre",
        valueConvention: "ellipsoidal-minus-orthometric",
        noDataValue: null,
      });
      return undefined;
    } catch (error) {
      return error instanceof VerticalTransformError ? error.code : String(error);
    }
  },
  async cancelWorkerQueue(source) {
    const opened = await new RustCopcBackend().open(source);
    try {
      const nodes = new Map<string, import("../../../../packages/adapter/core/copc/hierarchy/types").CopcHierarchyNode>();
      const pages = [opened.getRootHierarchyPage()];
      const visited = new Set<string>();
      while (pages.length > 0 && nodes.size < 2 && visited.size < 64) {
        const page = pages.shift()!;
        if (visited.has(page.key)) continue;
        visited.add(page.key);
        const subtree = await opened.loadHierarchyPage(page);
        for (const node of subtree.nodes) {
          if (node.pointDataLength > 0) nodes.set(node.key, node);
        }
        pages.push(...subtree.pages);
      }
      const node = nodes.values().next().value;
      const getWorkerDiagnostics = opened.getWorkerDiagnostics;
      const loadPreparedPointData = opened.loadPreparedPointData;
      const cancelPendingPointJobs = opened.cancelPendingPointJobs;
      if (
        typeof getWorkerDiagnostics !== "function" ||
        typeof loadPreparedPointData !== "function" ||
        typeof cancelPendingPointJobs !== "function"
      ) {
        return { supported: false };
      }
      const diagnostics = () => getWorkerDiagnostics.call(opened);
      const initial = diagnostics();
      if (!node || !initial) return { supported: false };
      const fields = createCopcPointFieldSelection(["position"]);
      const jobs = Array.from({ length: initial.workerCount * 3 + 4 }, () =>
        loadPreparedPointData.call(opened, node, fields).catch(() => undefined),
      );
      const deadline = performance.now() + 30_000;
      let current = diagnostics();
      while (
        current &&
        current.queuedCount === 0 &&
        current.completedCount + current.failedCount < current.submittedCount + jobs.length &&
        performance.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        current = diagnostics();
      }
      cancelPendingPointJobs.call(opened);
      await Promise.all(jobs);
      const final = diagnostics();
      return {
        supported: true,
        workerCount: final?.workerCount,
        submittedCount: final?.submittedCount,
        cancelledCount: final?.cancelledCount,
        peakQueuedCount: final?.peakQueuedCount,
      };
    } finally {
      opened.destroy?.();
    }
  },
  async compareBackends(source, gridId, workers = true) {
    const verticalGrid = grids.get(gridId);
    if (!verticalGrid) throw new Error(`Unknown vertical grid ${gridId}`);
    const javascriptSource = await new CopcJsBackend().open(source);
    const originalWorker = globalThis.Worker;
    let rustSource;
    try {
      if (!workers) {
        Object.defineProperty(globalThis, "Worker", {
          configurable: true,
          value: undefined,
        });
      }
      rustSource = await new RustCopcBackend().open(source, {
        heightOffsetMeters: 7.5,
      });
    } finally {
      if (!workers) {
        Object.defineProperty(globalThis, "Worker", {
          configurable: true,
          value: originalWorker,
        });
      }
    }
    try {
      const queue = [javascriptSource.getRootHierarchyPage()];
      let node;
      const visited = new Set<string>();
      while (queue.length > 0 && !node && visited.size < 64) {
        const page = queue.shift()!;
        if (visited.has(page.key)) continue;
        visited.add(page.key);
        const subtree = await javascriptSource.loadHierarchyPage(page);
        node = subtree.nodes.find(
          (candidate) => candidate.pointCount > 0 && candidate.pointDataLength > 0,
        );
        if (!node) queue.push(...subtree.pages);
      }
      if (!node) throw new Error("Synthetic COPC has no point-data hierarchy node");
      const fields = createCopcPointFieldSelection(["position"]);
      const javascriptBuffer = await javascriptSource.loadPointDataBuffer!(node, fields);
      const javascriptPrepared = transformPointBufferToPreparedPointData(
        javascriptSource.getMetadata(),
        javascriptBuffer,
        7.5,
        verticalGrid,
      );
      const rustPrepared = applyPreparedPointVerticalGrid(
        await rustSource.loadPreparedPointData!(node, fields),
        verticalGrid,
      );
      const comparedPoints = Math.min(32, javascriptPrepared.pointCount, rustPrepared.pointCount);
      let maxHeightDifferenceMeters = 0;
      let maxEcefDifferenceMeters = 0;
      let sourceCoordinatesEqual = true;
      for (let index = 0; index < comparedPoints; index += 1) {
        const offset = index * 3;
        sourceCoordinatesEqual &&=
          javascriptPrepared.source.coordinates[offset] === rustPrepared.source.coordinates[offset] &&
          javascriptPrepared.source.coordinates[offset + 1] === rustPrepared.source.coordinates[offset + 1] &&
          javascriptPrepared.source.coordinates[offset + 2] === rustPrepared.source.coordinates[offset + 2];
        maxHeightDifferenceMeters = Math.max(
          maxHeightDifferenceMeters,
          Math.abs(
            javascriptPrepared.geographic.coordinates[offset + 2] -
              rustPrepared.geographic.coordinates[offset + 2],
          ),
        );
        maxEcefDifferenceMeters = Math.max(
          maxEcefDifferenceMeters,
          Math.hypot(
            javascriptPrepared.world.coordinates[offset] -
              rustPrepared.world.coordinates[offset],
            javascriptPrepared.world.coordinates[offset + 1] -
              rustPrepared.world.coordinates[offset + 1],
            javascriptPrepared.world.coordinates[offset + 2] -
              rustPrepared.world.coordinates[offset + 2],
          ),
        );
      }
      const worker = rustSource.getWorkerDiagnostics?.();
      return {
        pointCount: javascriptPrepared.pointCount,
        comparedPoints,
        maxHeightDifferenceMeters,
        maxEcefDifferenceMeters,
        sourceCoordinatesEqual,
        ...(worker
          ? {
              worker: {
                workerCount: worker.workerCount,
                completedCount: worker.completedCount,
              },
            }
          : {}),
      };
    } finally {
      javascriptSource.destroy?.();
      rustSource.destroy?.();
    }
  },
  expectedWorld(point) {
    const world = Cesium.Cartesian3.fromDegrees(
      point.longitude,
      point.latitude,
      point.height,
    );
    return { x: world.x, y: world.y, z: world.z };
  },
  dispose() {
    for (const record of layers.values()) record.layer.destroy();
    layers.clear();
    grids.clear();
    gridLoadDurationMs.clear();
    if (!viewer.isDestroyed()) viewer.destroy();
  },
};
