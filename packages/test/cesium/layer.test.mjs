import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as Cesium from "cesium";

import { CopcCesiumLayer } from "../../index.ts";
import { PointPrimitiveRenderer } from "../../cesium/render/CopcPointRenderer.ts";
import { BatchedGeometryPointRenderer } from "../../cesium/render/BatchedGeometryPointRenderer.ts";
import { CesiumPointPicker } from "../../cesium/picking/CesiumPointPicker.ts";
import { createCesiumStreamingView } from "../../cesium/view/CesiumViewAdapter.ts";
import { loadGtxGeoidGrid } from "../../core/coordinates/transform/verticalGrid.ts";
import { createExperimentalCompactEStreamingCore } from "../../core/streaming/CopcStreamingCore.ts";
import { isCompactEPointCacheNode } from "../../core/point/compactEPointCache.ts";

test("Cesium layer opacity accepts endpoints and rejects invalid values", () => {
  for (const opacity of [0, 0.25, 0.5, 1]) {
    const layer = new CopcCesiumLayer({
      url: "https://example.test/data.copc.laz",
      opacity,
    });
    layer.setOpacity(opacity);
    layer.destroy();
  }

  for (const opacity of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01]) {
    assert.throws(
      () =>
        new CopcCesiumLayer({
          url: "https://example.test/data.copc.laz",
          opacity,
        }),
      RangeError,
    );
  }
});

test("Cesium clipping constructor options are validated and detached from caller data", () => {
  const clippingVolume = {
    type: "box",
    coordinateSystem: "wgs84-ecef-meters",
    minimum: [-10, -20, -30],
    maximum: [10, 20, 30],
  };
  const layer = new CopcCesiumLayer({
    url: "memory://initial-clipping.copc.laz",
    clippingVolume,
  });
  clippingVolume.minimum[0] = -999;
  assert.deepEqual(layer.getClippingVolume(), {
    type: "box",
    coordinateSystem: "wgs84-ecef-meters",
    minimum: [-10, -20, -30],
    maximum: [10, 20, 30],
  });
  layer.destroy();
});

test("Cesium opacity is rejected when a custom renderer lacks layer support", () => {
  assert.throws(
    () =>
      new CopcCesiumLayer({
        url: "https://example.test/data.copc.laz",
        opacity: 0.5,
        renderer: {},
      }),
    /does not support layer opacity/,
  );
});

test("Cesium point picker refuses to inspect a fully transparent layer", () => {
  let opacity = 0;
  let scenePickCount = 0;
  const picker = new CesiumPointPicker({
    canPick: () => opacity > 0,
    inspectPoint: () => ({}),
    hasNode: () => true,
  });
  const viewer = {
    scene: {
      pick() {
        scenePickCount += 1;
        return {
          id: {
            nodeKey: "node-a",
            pointIndex: 0,
            ownerId: picker.ownerId,
          },
        };
      },
    },
  };

  picker.pick(viewer, new Cesium.Cartesian2(0, 0));
  assert.equal(scenePickCount, 0);
  opacity = 0.25;
  picker.pick(viewer, new Cesium.Cartesian2(0, 0));
  assert.equal(scenePickCount, 1);
});

async function createSyntheticVerticalGrid() {
  const bytes = new ArrayBuffer(40 + 3 * 3 * 4);
  const view = new DataView(bytes);
  view.setFloat64(0, 44.3, false);
  view.setFloat64(8, -122.7, false);
  view.setFloat64(16, 0.2, false);
  view.setFloat64(24, 0.2, false);
  view.setInt32(32, 3, false);
  view.setInt32(36, 3, false);
  Array.from({ length: 9 }, () => 25).forEach((value, index) =>
    view.setFloat32(40 + index * 4, value, false),
  );
  return loadGtxGeoidGrid(bytes, {
    gridId: "layer-test-regional-grid",
    sourceVerticalCrs: "Local orthometric height",
    targetVerticalCrs: "EPSG:4979",
    horizontalCrs: "EPSG:4326",
    referenceEllipsoid: "WGS84",
    sha256: createHash("sha256")
      .update(new Uint8Array(bytes))
      .digest("hex"),
    valueUnit: "metre",
    valueConvention: "ellipsoidal-minus-orthometric",
    noDataValue: null,
  });
}

const WGS84_ORTHOMETRIC_WKT =
  'COMPD_CS["WGS 84 + Local orthometric height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],VERT_CS["Local orthometric height",VERT_DATUM["Local vertical datum",2005],UNIT["metre",1],AXIS["Gravity-related height",UP]]]';

function createEvent() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(listener) {
      listeners.add(listener);
    },
    removeEventListener(listener) {
      listeners.delete(listener);
    },
    raise(...args) {
      for (const listener of listeners) listener(...args);
    },
  };
}

function createFakeViewer() {
  const moveEnd = createEvent();
  const changed = createEvent();
  const removedCollections = [];
  const addedCollections = [];
  let activeBoundingSphereFlight;

  return {
    moveEnd,
    changed,
    removedCollections,
    addedCollections,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    scene: {
      primitives: {
        add(collection) {
          addedCollections.push(collection);
          return collection;
        },
        remove(collection) {
          removedCollections.push(collection);
          return true;
        },
      },
    },
    camera: {
      percentageChanged: 0,
      positionWC: Cesium.Cartesian3.fromDegrees(-122.5, 44.5, 1500),
      moveEnd,
      changed,
      flyTo(options) {
        const flight = activeBoundingSphereFlight;
        activeBoundingSphereFlight = undefined;
        flight?.cancel?.();
        this.positionWC = options.destination;
      },
      flyToBoundingSphere(sphere, options) {
        const previousFlight = activeBoundingSphereFlight;
        activeBoundingSphereFlight = undefined;
        previousFlight?.cancel?.();
        this.lastBoundingSphereFlight = { sphere, options };
        activeBoundingSphereFlight = options;
      },
      cancelFlight() {
        const flight = activeBoundingSphereFlight;
        activeBoundingSphereFlight = undefined;
        flight?.cancel?.();
      },
      completeBoundingSphereFlight() {
        const flight = activeBoundingSphereFlight;
        activeBoundingSphereFlight = undefined;
        flight?.complete?.();
      },
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

function createTerrainSamplingProvider(heightMeters) {
  const tilingScheme = new Cesium.GeographicTilingScheme();
  return {
    tilingScheme,
    availability: {
      computeMaximumLevelAtPosition() {
        return 1;
      },
    },
    requestTileGeometry() {
      return Promise.resolve({
        interpolateHeight() {
          return heightMeters;
        },
      });
    },
  };
}

function setFakeCameraOrientation(viewer, yawDegrees) {
  const yaw = (yawDegrees * Math.PI) / 180;
  viewer.scene.drawingBufferHeight = 900;
  viewer.camera.frustum = {
    fovy: Math.PI / 3,
    aspectRatio: 1,
    near: 1,
    far: 6000,
  };
  viewer.camera.directionWC = new Cesium.Cartesian3(
    Math.sin(yaw),
    0,
    Math.cos(yaw),
  );
  viewer.camera.upWC = new Cesium.Cartesian3(0, 1, 0);
  viewer.camera.rightWC = new Cesium.Cartesian3(
    Math.cos(yaw),
    0,
    -Math.sin(yaw),
  );
}

function getLayerPointCollection(viewer, layerIndex = 0) {
  return viewer.addedCollections[layerIndex].get(0);
}

function createBackend({
  onFields,
  metadata: metadataOverride,
  sourceFields = ["position", "intensity", "classification", "rgb"],
  extraDimensionData,
  extraDimensionMetadata,
  configuredExtraDimensions,
} = {}) {
  const node = {
    key: "0-0-0-0",
    level: 0,
    x: 0,
    y: 0,
    z: 0,
    pointCount: 2,
    pointDataOffset: 100,
    pointDataLength: 20,
  };
  let openCount = 0;
  let destroyCount = 0;
  let pointChunkRequestCount = 0;
  let decodeCount = 0;
  let lastOpenOptions;

  return {
    get openCount() {
      return openCount;
    },
    get destroyCount() {
      return destroyCount;
    },
    get pointChunkRequestCount() {
      return pointChunkRequestCount;
    },
    get decodeCount() {
      return decodeCount;
    },
    get lastOpenOptions() {
      return lastOpenOptions;
    },
    backend: {
      ...(configuredExtraDimensions === undefined
        ? {}
        : { configuredExtraDimensions }),
      async open(source, options) {
        lastOpenOptions = options;
        openCount += 1;
        return {
          source,
          getMetadata() {
            return (
              metadataOverride ?? {
                pointCount: 2,
                bounds: {
                  minX: -123,
                  minY: 44,
                  minZ: 10,
                  maxX: -122,
                  maxY: 45,
                  maxZ: 20,
                },
                cube: {
                  minX: -123,
                  minY: 44,
                  minZ: 10,
                  maxX: -122,
                  maxY: 45,
                  maxZ: 20,
                },
                ...(extraDimensionMetadata === undefined
                  ? {}
                  : { extraDimensions: extraDimensionMetadata }),
              }
            );
          },
          getRootHierarchyPage() {
            return { key: node.key, pageOffset: 0, pageLength: 10 };
          },
          async loadHierarchyPage() {
            return { nodes: [node], pages: [] };
          },
          async loadPointDataView(_node, fields) {
            pointChunkRequestCount += 1;
            onFields?.([...fields]);
            const availableFields = new Set(
              [...fields].filter((field) => sourceFields.includes(field)),
            );
            return {
              pointCount: node.pointCount,
              availableFields,
              getter() {
                return () => 0;
              },
            };
          },
          destroy() {
            destroyCount += 1;
          },
        };
      },
    },
    decoder: {
      async decode(view) {
        decodeCount += 1;
        return {
          pointCount: 2,
          coordinates: new Float64Array([-122.6, 44.4, 12, -122.4, 44.6, 18]),
          attributes: {
            ...(view.availableFields.has("intensity")
              ? { intensity: new Uint16Array([100, 500]) }
              : {}),
            ...(view.availableFields.has("classification")
              ? { classification: new Uint8Array([2, 6]) }
              : {}),
            ...(view.availableFields.has("rgb")
              ? {
                  red: new Uint16Array([255, 128]),
                  green: new Uint16Array([0, 128]),
                  blue: new Uint16Array([0, 255]),
                }
              : {}),
            ...(extraDimensionData === undefined
              ? {}
              : { extraDimensions: extraDimensionData }),
          },
        };
      },
    },
  };
}

async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for Cesium adapter update");
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("CopcCesiumLayer delegates source and streaming work to the shared core", async () => {
  const requestedFields = [];
  const source = createBackend({
    onFields: (fields) => requestedFields.push(fields),
  });
  const layer = new CopcCesiumLayer({
    url: "memory://adapter.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    colorMode: "rgb",
  });
  const viewer = createFakeViewer();

  await layer.load();
  assert.equal(source.openCount, 1);
  assert.equal(source.lastOpenOptions.rangeValidation, undefined);
  assert.equal(layer.getSnapshot().lifecycle, "ready");
  const hierarchy = layer.getHierarchyDiagnostics();
  assert.equal(hierarchy.pageRequests, 1);
  assert.equal(hierarchy.pageCacheHits, 0);
  assert.equal(hierarchy.hierarchyBytesFetched, 10);
  assert.equal(hierarchy.loadedPageCount, 1);
  assert.equal(hierarchy.discoveredPageCount, 1);
  assert.equal(hierarchy.completedPageCount, 1);
  assert.equal(hierarchy.activePageLoads, 0);
  assert.equal(hierarchy.peakActivePageLoads, 1);
  assert.ok(hierarchy.rootHierarchyLoadDurationMs >= 0);
  assert.equal(hierarchy.lastQueryDurationMs, 0);
  assert.equal(hierarchy.loadedEntryCount, 1);

  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  assert.equal(layer.getPointCacheDiagnostics().currentCacheBytes, 82);

  assert.deepEqual(requestedFields, [
    ["position", "intensity", "classification", "rgb"],
  ]);
  assert.deepEqual(layer.getSnapshot().selectedNodeKeys, ["0-0-0-0"]);
  assert.deepEqual(layer.getSnapshot().renderedNodeKeys, ["0-0-0-0"]);
  assert.equal(layer.getSnapshot().streamingUpdateCount, 1);

  layer.destroy();
  assert.equal(source.destroyCount, 1);
  assert.equal(viewer.destroyed, false);
});

test("Cesium attributeLoading defaults to all and required selects initial style fields", async () => {
  const cases = [
    { name: "fixed", options: {}, fields: ["position"], bytes: 64 },
    {
      name: "elevation",
      options: { colorMode: "elevation" },
      fields: ["position"],
      bytes: 64,
    },
    {
      name: "rgb",
      options: { colorMode: "rgb" },
      fields: ["position", "rgb"],
      bytes: 76,
    },
    {
      name: "intensity",
      options: { colorMode: "intensity" },
      fields: ["position", "intensity"],
      bytes: 68,
    },
    {
      name: "classification",
      options: { colorMode: "classification" },
      fields: ["position", "classification"],
      bytes: 66,
    },
    {
      name: "rgb with initial classification filter",
      options: {
        colorMode: "rgb",
        classificationFilter: { include: [2] },
      },
      fields: ["position", "rgb", "classification"],
      bytes: 78,
    },
    {
      name: "rgb with expressly selected classification",
      options: {
        colorMode: "rgb",
        pointFields: new Set(["classification"]),
      },
      fields: ["position", "rgb", "classification"],
      bytes: 78,
    },
  ];

  for (const scenario of cases) {
    const requestedFields = [];
    const source = createBackend({
      onFields: (fields) => requestedFields.push(fields),
    });
    const layer = new CopcCesiumLayer({
      url: `memory://required-fields-${scenario.name}.copc.laz`,
      backend: source.backend,
      decoder: source.decoder,
      attributeLoading: "required",
      ...scenario.options,
    });
    const viewer = createFakeViewer();

    await layer.load();
    layer.attachTo(viewer);
    await waitFor(() => layer.getSnapshot().renderedPointCount > 0);

    assert.deepEqual(requestedFields, [scenario.fields], scenario.name);
    const cache = layer.getPointCacheDiagnostics();
    assert.equal(cache.currentCacheBytes, scenario.bytes, scenario.name);
    assert.equal(cache.cacheByteBudget, 256 * 1024 * 1024, scenario.name);
    assert.equal(source.decodeCount, 1, scenario.name);
    layer.destroy();
  }

  const requestedFields = [];
  const source = createBackend({
    onFields: (fields) => requestedFields.push(fields),
  });
  const layer = new CopcCesiumLayer({
    url: "memory://required-explicit-fields.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    attributeLoading: "required",
    colorMode: "rgb",
    pointFields: new Set(["classification"]),
  });
  const viewer = createFakeViewer();
  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount > 0);
  const requestCount = source.pointChunkRequestCount;
  const decodeCount = source.decodeCount;
  layer.setStyle({ colorMode: "classification" });
  assert.equal(layer.getStyle().colorMode, "classification");
  assert.deepEqual(requestedFields, [
    ["position", "rgb", "classification"],
  ]);
  assert.equal(source.pointChunkRequestCount, requestCount);
  assert.equal(source.decodeCount, decodeCount);
  layer.destroy();

  for (const attributeLoading of [undefined, "all"]) {
    const requestedFields = [];
    const source = createBackend({
      onFields: (fields) => requestedFields.push(fields),
    });
    const layer = new CopcCesiumLayer({
      url: `memory://all-fields-${attributeLoading ?? "omitted"}.copc.laz`,
      backend: source.backend,
      decoder: source.decoder,
      ...(attributeLoading === undefined ? {} : { attributeLoading }),
      colorMode: "rgb",
    });
    const viewer = createFakeViewer();

    await layer.load();
    layer.attachTo(viewer);
    await waitFor(() => layer.getSnapshot().renderedPointCount > 0);

    assert.deepEqual(requestedFields, [
      ["position", "intensity", "classification", "rgb"],
    ]);
    assert.equal(layer.getPointCacheDiagnostics().currentCacheBytes, 82);
    const requestCount = source.pointChunkRequestCount;
    const decodeCount = source.decodeCount;
    layer.setStyle({ colorMode: "classification" });
    assert.equal(source.pointChunkRequestCount, requestCount);
    assert.equal(source.decodeCount, decodeCount);
    layer.destroy();
  }
});

test("required attribute restyling rejects omitted fields without changing style or selection", async () => {
  const source = createBackend();
  const picked = [];
  const layer = new CopcCesiumLayer({
    url: "memory://required-style-transaction.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    attributeLoading: "required",
    colorMode: "rgb",
    onPointPicked: (point) => picked.push(point),
  });
  const viewer = createFakeViewer();
  const nodeKey = "0-0-0-0";

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  const controller = layer.controller;
  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 1, ownerId: controller.pointPicker.ownerId },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  const selectedBefore = layer.getSelectedPoint();
  assert.ok(selectedBefore);

  const requestsBefore = source.pointChunkRequestCount;
  const decodesBefore = source.decodeCount;
  const cacheBefore = layer.getPointCacheDiagnostics();
  const styleBefore = layer.getStyle();
  assert.throws(
    () => layer.setStyle({ colorMode: "intensity" }),
    /intensity was not requested.*source availability was not checked.*attributeLoading: "all"/,
  );
  assert.deepEqual(layer.getStyle(), styleBefore);
  assert.deepEqual(layer.getSelectedPoint(), selectedBefore);
  assert.equal(source.pointChunkRequestCount, requestsBefore);
  assert.equal(source.decodeCount, decodesBefore);
  assert.deepEqual(layer.getPointCacheDiagnostics(), cacheBefore);

  layer.setStyle({ colorMode: "elevation" });
  assert.equal(layer.getStyle().colorMode, "elevation");
  assert.equal(layer.getSelectedPoint().pointIndex, selectedBefore.pointIndex);
  assert.equal(source.pointChunkRequestCount, requestsBefore);
  assert.equal(source.decodeCount, decodesBefore);

  assert.equal(picked.at(-1).pointIndex, 1);
  layer.destroy();
});

test("required mode distinguishes source-missing RGB from an attribute it did not load", async () => {
  const source = createBackend({
    sourceFields: ["position", "intensity", "classification"],
  });
  const layer = new CopcCesiumLayer({
    url: "memory://required-source-missing-rgb.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    attributeLoading: "required",
    colorMode: "rgb",
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  const renderedColor = getLayerPointCollection(viewer).get(0).color;
  assert.deepEqual(
    [renderedColor.red, renderedColor.green, renderedColor.blue],
    [0, 1, 1],
  );
  const requestsBefore = source.pointChunkRequestCount;
  const decodesBefore = source.decodeCount;

  assert.doesNotThrow(() => layer.setStyle({ colorMode: "rgb" }));
  assert.equal(layer.getStyle().colorMode, "rgb");
  assert.equal(source.pointChunkRequestCount, requestsBefore);
  assert.equal(source.decodeCount, decodesBefore);
  layer.destroy();
});

test("Cesium layer point-budget defaults and top-level precedence match Core", () => {
  const omitted = new CopcCesiumLayer({
    url: "memory://public-defaults.copc.laz",
  });
  const explicit = new CopcCesiumLayer({
    url: "memory://public-defaults.copc.laz",
    maxRenderedPoints: 250_000,
  });
  const overridden = new CopcCesiumLayer({
    url: "memory://public-defaults.copc.laz",
    maxRenderedPoints: 120_000,
    streaming: { maxRenderedPoints: 80_000 },
  });

  const effectiveSettings = (layer) => {
    const snapshot = layer.getSnapshot();
    return {
      backend: snapshot.backend,
      configuredPointBudget: snapshot.performance.configuredPointBudget,
      refinementAlgorithm: snapshot.performance.refinementAlgorithm,
      motionLookaheadEnabled: snapshot.performance.motionLookaheadEnabled,
      colorMode: layer.getStyle().colorMode,
    };
  };

  assert.deepEqual(effectiveSettings(omitted), effectiveSettings(explicit));
  assert.equal(effectiveSettings(omitted).configuredPointBudget, 250_000);
  assert.equal(effectiveSettings(omitted).colorMode, "fixed");
  assert.equal(effectiveSettings(overridden).configuredPointBudget, 120_000);
});

test("CopcCesiumLayer validates refinement options and focus values", () => {
  assert.throws(
    () =>
      new CopcCesiumLayer({
        url: "memory://invalid-refinement-algorithm.copc.laz",
        streaming: { refinementAlgorithm: "nearest" },
      }),
    /Unknown refinement algorithm.*foveated.*screen-projection/,
  );

  const layer = new CopcCesiumLayer({ url: "memory://invalid-focus.copc.laz" });
  assert.throws(
    () =>
      layer.setRefinementFocus({
        type: "screen-circle",
        center: { x: Number.NaN, y: 0.5 },
        radius: 0.1,
        detailBias: 2,
      }),
    /center\.x/,
  );
  assert.throws(
    () =>
      layer.setRefinementFocus({
        type: "screen-circle",
        center: { x: 0.5, y: 0.5 },
        radius: 0,
        detailBias: 2,
      }),
    /radius/,
  );
  assert.throws(
    () =>
      layer.setRefinementFocus({
        type: "screen-circle",
        center: { x: 0.5, y: 0.5 },
        radius: 0.1,
        detailBias: 2.1,
      }),
    /detailBias/,
  );
  layer.destroy();
});

test("focus changes reselect a stationary Cesium view without reopening or reloading points", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://runtime-focus.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  const waitForViewSettled = () => {
    let removeListener = () => {};
    let timeout;
    return new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        removeListener();
        reject(new Error("timed out waiting for Cesium view to settle"));
      }, 5000);
      removeListener = layer.viewSettled.addEventListener(
        (viewGeneration, selectedNodeKeys) => {
          clearTimeout(timeout);
          removeListener();
          resolve({ viewGeneration, selectedNodeKeys });
        },
      );
    });
  };
  try {
    await layer.load();
    const initialSettled = waitForViewSettled();
    layer.attachTo(viewer);
    await initialSettled;
    assert.equal(layer.getSnapshot().renderedPointCount, 2);
    assert.equal(
      layer.getSnapshot().performance.refinementAlgorithm,
      "foveated",
    );
    const updatesBeforeFocus = layer.getSnapshot().streamingUpdateCount;
    const focusSettled = waitForViewSettled();

    layer.setRefinementFocus({
      type: "screen-circle",
      center: { x: 0.8, y: 0.5 },
      radius: 0.15,
      detailBias: 2,
    });
    await focusSettled;

    assert.ok(layer.getSnapshot().streamingUpdateCount > updatesBeforeFocus);
    assert.equal(layer.getSnapshot().performance.refinementFocusEnabled, true);
    assert.equal(source.openCount, 1);
    assert.equal(source.pointChunkRequestCount, 1);
    assert.equal(source.decodeCount, 1);
  } finally {
    layer.destroy();
    globalThis.window = originalWindow;
  }
});

test("CopcCesiumLayer forwards an explicit strict HTTP validation policy", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://strict-policy.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    rangeValidation: "strict",
  });

  await layer.load();
  assert.equal(source.lastOpenOptions.rangeValidation, "strict");
  layer.destroy();
});

test("Cesium layers load geographic-WKT metadata with automatic framing before or after attachment", async () => {
  const metadata = {
    pointCount: 2,
    bounds: {
      minX: -123,
      minY: 44,
      minZ: 10,
      maxX: -122,
      maxY: 45,
      maxZ: 20,
    },
    cube: {
      minX: -123,
      minY: 44,
      minZ: 10,
      maxX: -122,
      maxY: 45,
      maxZ: 20,
    },
    wkt: 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
  };

  for (const attachBeforeLoad of [true, false]) {
    const source = createBackend({ metadata: metadata });
    const layer = new CopcCesiumLayer({
      url: `memory://geographic-wkt-${attachBeforeLoad}.copc.laz`,
      backend: source.backend,
      decoder: source.decoder,
    });
    const viewer = createFakeViewer();
    const automaticFlights = [];
    const nativeFlyTo = viewer.camera.flyTo.bind(viewer.camera);
    viewer.camera.flyTo = (options) => {
      automaticFlights.push(options);
      nativeFlyTo(options);
    };

    if (attachBeforeLoad) {
      layer.attachTo(viewer);
    }
    await layer.load();
    if (!attachBeforeLoad) {
      layer.attachTo(viewer);
    }
    await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

    assert.equal(automaticFlights.length, 1);
    assert.ok(Number.isFinite(automaticFlights[0].destination.z));
    assert.ok(layer.boundingSphere);
    layer.destroy();
  }
});

test("Cesium auto framing accepts padded cubes outside regional geoid coverage", async () => {
  const metadata = {
    pointCount: 2,
    bounds: {
      minX: -122.6,
      minY: 44.4,
      minZ: 12,
      maxX: -122.4,
      maxY: 44.6,
      maxZ: 18,
    },
    cube: {
      minX: -124,
      minY: 42,
      minZ: 0,
      maxX: -122.4,
      maxY: 44.6,
      maxZ: 20,
    },
    wkt: WGS84_ORTHOMETRIC_WKT,
  };
  const source = createBackend({ metadata });
  const layer = new CopcCesiumLayer({
    url: "memory://regional-grid-padded-cube.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    verticalTransform: await createSyntheticVerticalGrid(),
  });
  const viewer = createFakeViewer();
  const automaticFlights = [];
  const nativeFlyTo = viewer.camera.flyTo.bind(viewer.camera);
  viewer.camera.flyTo = (options) => {
    automaticFlights.push(options);
    nativeFlyTo(options);
  };

  layer.attachTo(viewer);
  await layer.load();
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

  assert.equal(automaticFlights.length, 1);
  assert.ok(layer.boundingSphere);
  assert.equal(layer.getSnapshot().renderedPointCount, 2);
  layer.destroy();
});

test("Cesium metadata and view events describe real milestones with one public view generation", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://layer-events.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  layer.show = false;
  const viewer = createFakeViewer();
  const events = [];
  let releaseDecode;
  let decodeStartedResolve;
  const decodeStarted = new Promise((resolve) => {
    decodeStartedResolve = resolve;
  });
  const decodeGate = new Promise((resolve) => {
    releaseDecode = resolve;
  });
  const normalDecode = source.decoder.decode.bind(source.decoder);
  source.decoder.decode = async (...args) => {
    decodeStartedResolve();
    await decodeGate;
    return normalDecode(...args);
  };
  layer.metadataReady.addEventListener((metadata, loadGeneration) => {
    events.push(["metadataready", metadata, loadGeneration]);
  });
  layer.loadProgress.addEventListener((queued, active, viewGeneration) => {
    events.push(["progress", queued, active, viewGeneration]);
  });
  layer.firstVisible.addEventListener((loadGeneration, viewGeneration) => {
    events.push(["firstvisible", loadGeneration, viewGeneration]);
  });
  layer.viewSettled.addEventListener((viewGeneration, selectedNodeKeys) => {
    events.push(["viewsettled", viewGeneration, selectedNodeKeys]);
  });
  layer.attachTo(viewer);

  let loadSettled = false;
  const loadPromise = layer.load().then(() => {
    loadSettled = true;
  });
  await decodeStarted;
  assert.equal(viewer.addedCollections[0].show, false);
  assert.equal(events.filter(([type]) => type === "metadataready").length, 1);
  assert.equal(
    loadSettled,
    false,
    "metadata readiness must precede the attached initial view completion",
  );
  releaseDecode();
  await loadPromise;

  const metadataEvent = events.find(([type]) => type === "metadataready");
  const firstVisibleEvent = events.find(([type]) => type === "firstvisible");
  const settledEvent = events.find(([type]) => type === "viewsettled");
  const progressEvents = events.filter(([type]) => type === "progress");
  assert.ok(metadataEvent);
  assert.ok(firstVisibleEvent);
  assert.ok(settledEvent);
  assert.ok(progressEvents.length > 0);
  assert.ok(events.indexOf(metadataEvent) < events.indexOf(progressEvents[0]));
  assert.equal(firstVisibleEvent[1], metadataEvent[2]);
  assert.equal(firstVisibleEvent[2], settledEvent[1]);
  assert.equal(settledEvent[2].includes("0-0-0-0"), true);
  const sourceBounds = layer.boundingSphere;
  const renderedBounds = layer.controller.getSelectionBoundingSphere();
  assert.ok(sourceBounds && renderedBounds);
  assert.ok(sourceBounds.radius > renderedBounds.radius);
  layer.show = true;
  assert.equal(viewer.addedCollections[0].show, true);
  for (let index = 1; index < progressEvents.length; index += 1) {
    assert.notDeepEqual(
      progressEvents[index].slice(1, 3),
      progressEvents[index - 1].slice(1, 3),
    );
    assert.equal(progressEvents[index][3], settledEvent[1]);
  }
  layer.destroy();
});

test("Cesium lifecycle events preserve native listener deduplication and removal behavior", () => {
  const layer = new CopcCesiumLayer({
    url: "memory://cesium-event-listeners.copc.laz",
  });
  const event = layer.metadataReady;
  assert.ok(event instanceof Cesium.Event);
  let calls = 0;
  const scope = {};
  const listener = () => {
    calls += 1;
  };
  const remove = event.addEventListener(listener, scope);
  const removeDuplicate = event.addEventListener(listener, scope);
  assert.equal(event.numberOfListeners, 1);

  event.raiseEvent({ pointCount: 1 }, 1);
  assert.equal(calls, 1);
  remove();
  removeDuplicate();
  assert.equal(event.numberOfListeners, 0);

  event.addEventListener(listener, scope);
  assert.equal(event.removeEventListener(listener, scope), true);
  assert.equal(event.removeEventListener(listener, scope), false);
  assert.equal(event.numberOfListeners, 0);

  event.addEventListener(listener);
  layer.destroy();
  event.raiseEvent({ pointCount: 1 }, 2);
  assert.equal(event.numberOfListeners, 0);
  assert.equal(
    calls,
    1,
    "destroy removes listeners and shuts event delivery down",
  );
});

test("Cesium boundingSphere caches full metadata extent, clones on access, and clears on unload", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://metadata-sphere.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    heightOffsetMeters: 20,
  });
  assert.equal(layer.boundingSphere, undefined);
  await layer.load();
  const first = layer.boundingSphere;
  assert.ok(first instanceof Cesium.BoundingSphere);
  const expected = Cesium.BoundingSphere.clone(first);
  first.radius = 0;
  first.center.x = 123;
  const second = layer.boundingSphere;
  assert.ok(second);
  assert.equal(second.radius, expected.radius);
  assert.equal(second.center.x, expected.center.x);

  layer.unload();
  assert.equal(layer.boundingSphere, undefined);
  await layer.reload();
  assert.ok(layer.boundingSphere instanceof Cesium.BoundingSphere);
  layer.destroy();
});

test("unsupported Cesium extent leaves boundingSphere unavailable", async () => {
  const bounds = {
    minX: -1_100_000,
    minY: -1_100_000,
    minZ: 0,
    maxX: 1_100_000,
    maxY: 1_100_000,
    maxZ: 10,
  };
  const source = createBackend({
    metadata: {
      pointCount: 2,
      bounds,
      cube: bounds,
      wkt: 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]',
    },
  });
  const layer = new CopcCesiumLayer({
    url: "memory://unsupported-bounds.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  await layer.load();
  assert.equal(layer.boundingSphere, undefined);
  layer.destroy();
});

test("Cesium load failure emits a load error while preserving Promise rejection", async () => {
  const layer = new CopcCesiumLayer({
    url: "memory://load-error.copc.laz",
    backend: {
      async open() {
        throw new Error("controlled Cesium source failure");
      },
    },
  });
  const errors = [];
  layer.error.addEventListener((event) => errors.push(event));
  await assert.rejects(
    layer.load(),
    (error) => error.cause?.message === "controlled Cesium source failure",
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, "load");
  assert.ok(Number.isInteger(errors[0].loadGeneration));
  assert.equal("viewGeneration" in errors[0], false);
  layer.destroy();
});

test("Cesium zoomTo resolves completion and cancellation and rejects invalid state", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://zoom-to.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  await assert.rejects(layer.zoomTo(), /must be attached/);
  await layer.load();
  const viewer = createFakeViewer();
  layer.attachTo(viewer);
  viewer.scene.mode = Cesium.SceneMode.MORPHING;
  await assert.rejects(layer.zoomTo(), /scene is morphing/);
  delete viewer.scene.mode;
  viewer.destroyed = true;
  await assert.rejects(layer.zoomTo(), /Viewer has been destroyed/);
  viewer.destroyed = false;
  await assert.rejects(
    layer.zoomTo({ heading: Number.NaN, pitch: 0, range: 1 }),
    /finite values/,
  );

  const firstFlight = layer.zoomTo(new Cesium.HeadingPitchRange(0, -0.5, 0));
  const secondFlight = layer.zoomTo();
  assert.equal(await firstFlight, false);
  viewer.camera.completeBoundingSphereFlight();
  assert.equal(await secondFlight, true);

  const cancelledFlight = layer.zoomTo();
  viewer.camera.cancelFlight();
  assert.equal(await cancelledFlight, false);

  const applicationSupersededFlight = layer.zoomTo();
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(-122, 44, 2000),
  });
  assert.equal(await applicationSupersededFlight, false);

  const unloadedFlight = layer.zoomTo();
  layer.unload();
  assert.equal(await unloadedFlight, false);
  await assert.rejects(layer.zoomTo(), /supported bounding sphere/);
  await layer.reload();

  const detachedFlight = layer.zoomTo();
  layer.detachFrom();
  assert.equal(await detachedFlight, false);
  await assert.rejects(layer.zoomTo(), /must be attached/);
  layer.attachTo(viewer);
  const destroyedFlight = layer.zoomTo();
  layer.destroy();
  assert.equal(await destroyedFlight, false);
  await assert.rejects(layer.zoomTo(), /destroyed/);
});

test("explicit zoomTo remains separate from legacy automatic initial framing", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://automatic-and-explicit-framing.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();
  let automaticFlights = 0;
  const nativeFlyTo = viewer.camera.flyTo.bind(viewer.camera);
  viewer.camera.flyTo = (options) => {
    automaticFlights += 1;
    nativeFlyTo(options);
  };
  layer.attachTo(viewer);
  await layer.load();
  assert.equal(automaticFlights, 1);

  const explicitFlight = layer.zoomTo();
  assert.equal(automaticFlights, 1);
  viewer.camera.completeBoundingSphereFlight();
  assert.equal(await explicitFlight, true);
  layer.destroy();
});

test("two Cesium layers can supersede camera flights without destroying their shared Viewer", async () => {
  const firstSource = createBackend();
  const secondSource = createBackend();
  const first = new CopcCesiumLayer({
    url: "memory://first-zoom.copc.laz",
    backend: firstSource.backend,
    decoder: firstSource.decoder,
  });
  const second = new CopcCesiumLayer({
    url: "memory://second-zoom.copc.laz",
    backend: secondSource.backend,
    decoder: secondSource.decoder,
  });
  const viewer = createFakeViewer();
  await Promise.all([first.load(), second.load()]);
  first.attachTo(viewer);
  second.attachTo(viewer);

  const firstFlight = first.zoomTo();
  const secondFlight = second.zoomTo();
  assert.equal(await firstFlight, false);
  viewer.camera.completeBoundingSphereFlight();
  assert.equal(await secondFlight, true);
  first.destroy();
  second.destroy();
  assert.equal(viewer.destroyed, false);
});

test("runtime Cesium styling filters cached points without another point-chunk request or decode", async () => {
  const source = createBackend();
  const picked = [];
  const layer = new CopcCesiumLayer({
    url: "memory://runtime-style.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    colorMode: "rgb",
    onPointPicked: (point) => picked.push(point),
  });
  const viewer = createFakeViewer();
  const nodeKey = "0-0-0-0";

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  const collection = getLayerPointCollection(viewer);
  const requestCount = source.pointChunkRequestCount;
  const decodeCount = source.decodeCount;
  const cacheBefore = layer.getPointCacheDiagnostics();
  const hierarchyBefore = layer.getHierarchyDiagnostics();
  const streamingUpdateCount = layer.getSnapshot().streamingUpdateCount;

  layer.setStyle({ colorMode: "elevation" });
  assert.notDeepEqual(collection.get(0).color, collection.get(1).color);
  layer.setStyle({ colorMode: "rgb" });
  assert.deepEqual(
    [
      collection.get(0).color.red,
      collection.get(0).color.green,
      collection.get(0).color.blue,
    ],
    [1, 0, 0],
  );
  layer.setStyle({ colorMode: "intensity" });
  assert.deepEqual(
    [
      collection.get(0).color.red,
      collection.get(0).color.green,
      collection.get(0).color.blue,
    ],
    [0, 0, 0],
  );
  layer.setStyle({
    colorMode: "classification",
    classificationFilter: { include: [6] },
  });

  assert.equal(layer.getStyle().colorMode, "classification");
  assert.deepEqual(layer.getStyle().classificationFilter, { include: [6] });
  assert.equal(layer.getSnapshot().renderedPointCount, 1);
  assert.equal(layer.getSnapshot().renderedNodeKeys.includes(nodeKey), true);
  assert.equal(collection.get(0).show, false);
  assert.equal(collection.get(1).show, true);
  assert.equal(collection.get(1).id.pointIndex, 1);

  const controller = layer.controller;
  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 1, ownerId: controller.pointPicker.ownerId },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  assert.equal(layer.getSelectedPoint().pointIndex, 1);
  assert.equal(layer.getSelectedPoint().classification, 6);
  assert.equal(picked.at(-1).classification, 6);

  layer.setStyle({ classificationFilter: { exclude: [6] } });
  assert.equal(collection.get(0).show, true);
  assert.equal(collection.get(1).show, false);
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(picked.at(-1), undefined);

  layer.setStyle({ classificationFilter: { include: [] } });
  assert.equal(layer.getSnapshot().renderedPointCount, 0);
  layer.setStyle({ classificationFilter: { include: [2, 6], exclude: [6] } });
  assert.equal(layer.getSnapshot().renderedPointCount, 1);
  assert.equal(collection.get(0).show, true);
  assert.equal(collection.get(1).show, false);

  layer.setStyle({ classificationFilter: { exclude: [] } });
  assert.equal(layer.getSnapshot().renderedPointCount, 2);
  layer.setStyle({ classificationFilter: {} });
  assert.equal(layer.getSnapshot().renderedPointCount, 2);
  layer.setStyle({ classificationFilter: null });
  assert.equal(layer.getSnapshot().renderedPointCount, 2);

  assert.equal(source.pointChunkRequestCount, requestCount);
  assert.equal(source.decodeCount, decodeCount);
  assert.deepEqual(layer.getPointCacheDiagnostics(), cacheBefore);
  assert.deepEqual(layer.getHierarchyDiagnostics(), hierarchyBefore);
  assert.equal(layer.getSnapshot().streamingUpdateCount, streamingUpdateCount);
  assert.equal(viewer.addedCollections.length, 1);
  assert.equal(viewer.removedCollections.length, 0);
  layer.destroy();
});

test("runtime clipping composes with style filters, clears clipped selection, and reuses cached points", async () => {
  const source = createBackend();
  const picked = [];
  const layer = new CopcCesiumLayer({
    url: "memory://runtime-clipping.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    classificationFilter: { include: [6] },
    onPointPicked: (point) => picked.push(point),
  });
  const viewer = createFakeViewer();
  const nodeKey = "0-0-0-0";

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 1);
  const initialCollection = getLayerPointCollection(viewer);
  const class2X = initialCollection.get(0).position.x;
  const class6X = initialCollection.get(1).position.x;
  const midpoint = (class2X + class6X) / 2;
  const class6Normal = class6X > class2X ? [1, 0, 0] : [-1, 0, 0];
  const class2Normal = class6X > class2X ? [-1, 0, 0] : [1, 0, 0];
  const volume = (normal) => ({
    type: "planes",
    coordinateSystem: "wgs84-ecef-meters",
    planes: [{ normal, point: [midpoint, 0, 0] }],
  });
  const requestCount = source.pointChunkRequestCount;
  const decodeCount = source.decodeCount;
  const cacheBefore = layer.getPointCacheDiagnostics();
  const hierarchyBefore = layer.getHierarchyDiagnostics();
  const streamingUpdateCount = layer.getSnapshot().streamingUpdateCount;

  layer.setClippingVolume(volume(class6Normal));
  assert.equal(layer.getSnapshot().renderedPointCount, 1);
  const volumeSnapshot = layer.getClippingVolume();
  assert.deepEqual(volumeSnapshot.planes[0].normal, class6Normal);
  volumeSnapshot.planes[0].normal[0] = 0;
  assert.deepEqual(layer.getClippingVolume().planes[0].normal, class6Normal);
  const controller = layer.controller;
  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 1, ownerId: controller.pointPicker.ownerId },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  assert.equal(layer.getSelectedPoint().pointIndex, 1);

  layer.setClippingVolume(volume(class2Normal));
  assert.equal(layer.getSnapshot().renderedPointCount, 0);
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(picked.at(-1), undefined);
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(picked.at(-1), undefined);
  const clippedCollection = getLayerPointCollection(viewer);
  assert.equal(clippedCollection.get(0).show, false);
  assert.equal(clippedCollection.get(1).show, false);

  layer.setClippingVolume(undefined);
  assert.equal(layer.getClippingVolume(), undefined);
  assert.equal(layer.getSnapshot().renderedPointCount, 1);
  const restoredCollection = getLayerPointCollection(viewer);
  assert.equal(restoredCollection.get(0).show, false);
  assert.equal(restoredCollection.get(1).show, true);
  assert.equal(source.pointChunkRequestCount, requestCount);
  assert.equal(source.decodeCount, decodeCount);
  assert.deepEqual(layer.getPointCacheDiagnostics(), cacheBefore);
  assert.deepEqual(layer.getHierarchyDiagnostics(), hierarchyBefore);
  assert.equal(layer.getSnapshot().streamingUpdateCount, streamingUpdateCount);
  layer.destroy();
});

test("dimension ramp, NoData filter, and picking reuse cached Extra Bytes", async () => {
  const source = createBackend({
    extraDimensionData: {
      canopy_height: new Float64Array([20, -9999]),
    },
    extraDimensionMetadata: [
      {
        name: "canopy_height",
        type: "float",
        length: 8,
        noData: -9999,
      },
    ],
  });
  const picked = [];
  const layer = new CopcCesiumLayer({
    url: "memory://dimension-style.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    attributeLoading: "required",
    colorMode: "dimension",
    dimension: {
      name: "canopy_height",
      range: { min: 0, max: 100 },
      palette: [
        { position: 0, color: { red: 0, green: 0, blue: 1 } },
        { position: 1, color: { red: 1, green: 0, blue: 0 } },
      ],
    },
    dimensionFilter: { name: "canopy_height", min: 10, max: 30 },
    onPointPicked: (point) => picked.push(point),
  });
  const viewer = createFakeViewer();
  const nodeKey = "0-0-0-0";

  await layer.load();
  assert.deepEqual(source.lastOpenOptions.extraDimensions, ["canopy_height"]);
  assert.equal(layer.getStyle().dimension.missingValue, -9999);
  assert.equal(layer.getStyle().dimensionFilter.missingValue, -9999);
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedNodeKeys.length === 1);

  const collection = getLayerPointCollection(viewer);
  assert.equal(collection.get(0).show, true);
  assert.equal(collection.get(1).show, false);
  assert.deepEqual(
    [collection.get(0).color.red, collection.get(0).color.green, collection.get(0).color.blue],
    [0.2, 0, 0.8],
  );
  assert.deepEqual(
    [collection.get(1).color.red, collection.get(1).color.green, collection.get(1).color.blue],
    [0, 1, 1],
  );

  const controller = layer.controller;
  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 0, ownerId: controller.pointPicker.ownerId },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  assert.equal(layer.getSelectedPoint().dimensions.canopy_height, 20);
  assert.equal(picked.at(-1).dimensions.canopy_height, 20);

  const requestsBefore = source.pointChunkRequestCount;
  const decodesBefore = source.decodeCount;
  const cacheBefore = layer.getPointCacheDiagnostics();
  const hierarchyBefore = layer.getHierarchyDiagnostics();
  layer.setStyle({
    dimensionFilter: { name: "canopy_height", min: 20, max: 20 },
    dimension: {
      name: "canopy_height",
      range: { min: 0, max: 100 },
      palette: [
        { position: 0, color: { red: 0, green: 1, blue: 0 } },
        { position: 1, color: { red: 1, green: 1, blue: 0 } },
      ],
    },
  });

  assert.equal(collection.get(0).show, true);
  assert.equal(collection.get(1).show, false);
  assert.deepEqual(
    [collection.get(0).color.red, collection.get(0).color.green, collection.get(0).color.blue],
    [0.2, 1, 0],
  );
  assert.equal(source.pointChunkRequestCount, requestsBefore);
  assert.equal(source.decodeCount, decodesBefore);
  assert.deepEqual(layer.getPointCacheDiagnostics(), cacheBefore);
  assert.deepEqual(layer.getHierarchyDiagnostics(), hierarchyBefore);
  assert.equal(layer.getSelectedPoint().dimensions.canopy_height, 20);
  layer.destroy();
});

test("backend-configured Extra Bytes allow dimension restyling from cached points", async () => {
  const source = createBackend({
    extraDimensionData: {
      canopy_height: new Float64Array([20, 40]),
    },
    extraDimensionMetadata: [
      { name: "canopy_height", type: "float", length: 8 },
    ],
    configuredExtraDimensions: ["canopy_height"],
  });
  const layer = new CopcCesiumLayer({
    url: "memory://backend-configured-dimension-style.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    attributeLoading: "required",
  });
  const viewer = createFakeViewer();

  await layer.load();
  assert.deepEqual(source.lastOpenOptions.extraDimensions, ["canopy_height"]);
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedNodeKeys.length === 1);

  const requestsBefore = source.pointChunkRequestCount;
  const decodesBefore = source.decodeCount;
  layer.setStyle({
    colorMode: "dimension",
    dimension: { name: "canopy_height", range: { min: 0, max: 100 } },
    dimensionFilter: { name: "canopy_height", min: 10, max: 30 },
  });

  const collection = getLayerPointCollection(viewer);
  assert.equal(collection.get(0).show, true);
  assert.equal(collection.get(1).show, false);
  assert.equal(source.pointChunkRequestCount, requestsBefore);
  assert.equal(source.decodeCount, decodesBefore);
  layer.destroy();
});

test("64-bit Extra Bytes cannot be styled and failed restyling leaves style intact", async () => {
  const source = createBackend({
    extraDimensionData: { record_id: new BigUint64Array([12n, 42n]) },
    extraDimensionMetadata: [
      { name: "record_id", type: "unsigned", length: 8 },
    ],
  });
  const layer = new CopcCesiumLayer({
    url: "memory://integer-dimension-style.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    colorMode: "rgb",
    extraDimensions: ["record_id"],
  });

  await layer.load();
  const before = layer.getStyle();
  assert.throws(
    () =>
      layer.setStyle({
        colorMode: "dimension",
        dimension: { name: "record_id", range: { min: 0, max: 100 } },
      }),
    /not supported for numeric styling/u,
  );
  assert.deepEqual(layer.getStyle(), before);
  layer.destroy();
});

test("missing classification values use the color fallback and cannot pass an active filter", async () => {
  const source = createBackend();
  source.decoder = {
    async decode() {
      return {
        pointCount: 2,
        coordinates: new Float64Array([-122.6, 44.4, 12, -122.4, 44.6, 18]),
        attributes: {
          intensity: new Uint16Array([100, 500]),
          red: new Uint16Array([255, 128]),
          green: new Uint16Array([0, 128]),
          blue: new Uint16Array([0, 255]),
        },
      };
    },
  };
  const layer = new CopcCesiumLayer({
    url: "memory://no-classification.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedNodeKeys.length === 1);
  const collection = getLayerPointCollection(viewer);

  layer.setStyle({
    colorMode: "classification",
    classificationFilter: { include: [2] },
  });
  assert.equal(layer.getSnapshot().renderedPointCount, 0);
  assert.equal(collection.get(0).show, false);
  assert.equal(collection.get(1).show, false);

  layer.setStyle({ classificationFilter: null });
  assert.equal(layer.getSnapshot().renderedPointCount, 2);
  assert.deepEqual(
    [
      collection.get(0).color.red,
      collection.get(0).color.green,
      collection.get(0).color.blue,
    ],
    [0, 1, 1],
  );
  layer.destroy();
});

test("Cesium attachment listeners are stable and detach preserves loaded data", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://lifecycle.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  const firstViewer = createFakeViewer();
  const secondViewer = createFakeViewer();

  await layer.load();
  layer.attachTo(firstViewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  layer.attachTo(firstViewer);
  assert.equal(firstViewer.moveEnd.listeners.size, 1);
  assert.equal(firstViewer.changed.listeners.size, 1);

  layer.detachFrom();
  assert.equal(firstViewer.moveEnd.listeners.size, 0);
  assert.equal(firstViewer.changed.listeners.size, 0);
  assert.equal(layer.getSnapshot().attached, false);
  assert.equal(layer.getMetadata().pointCount, 2);
  assert.equal(layer.getPointCacheDiagnostics().cachedNodeCount, 1);
  assert.equal(layer.getSnapshot().renderedPointCount, 0);

  layer.attachTo(firstViewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  layer.attachTo(secondViewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  assert.equal(firstViewer.moveEnd.listeners.size, 0);
  assert.equal(secondViewer.moveEnd.listeners.size, 1);

  await layer.reload();
  assert.equal(source.openCount, 2);
  assert.equal(layer.getSnapshot().attached, true);
  assert.equal(secondViewer.destroyed, false);
  layer.destroy();
  assert.equal(secondViewer.destroyed, false);
});

test("Cesium reattachment seeds motion history before the next camera change", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://motion-reattach.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };

  try {
    setFakeCameraOrientation(viewer, 0);
    await layer.load();
    layer.attachTo(viewer);
    await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

    layer.detachFrom();
    layer.attachTo(viewer);
    await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
    await new Promise((resolve) => setTimeout(resolve, 10));

    setFakeCameraOrientation(viewer, 10);
    viewer.moveEnd.raise();
    await waitFor(
      () =>
        layer.getSnapshot().performance
          .motionPredictedHorizontalDisplacementDegrees > 0,
    );
    assert.ok(
      layer.getSnapshot().performance
        .motionHorizontalAngularVelocityDegreesPerSecond > 0,
    );
    assert.ok(layer.getSnapshot().performance.motionSampledMovementCount > 0);
  } finally {
    layer.destroy();
    globalThis.window = originalWindow;
  }
});

test("Cesium performs one final same-view selection after motion decays, then stays idle", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://motion-decay.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };

  try {
    setFakeCameraOrientation(viewer, 0);
    await layer.load();
    layer.attachTo(viewer);
    await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
    const initial = layer.getSnapshot();
    const initialPointRequests = source.pointChunkRequestCount;

    await new Promise((resolve) => setTimeout(resolve, 10));
    setFakeCameraOrientation(viewer, 10);
    viewer.changed.raise();
    await waitFor(
      () => layer.getSnapshot().performance.motionLive.state === "active",
    );
    await waitFor(
      () =>
        layer.getSnapshot().streamingUpdateCount > initial.streamingUpdateCount,
    );
    const moving = layer.getSnapshot();
    assert.ok(moving.performance.motionLive.activity > 0);
    assert.ok(moving.performance.motionSampledMovementCount > 0);
    assert.ok(
      moving.performance.motionPredictedHorizontalDisplacementDegrees > 0,
    );

    await new Promise((resolve) => setTimeout(resolve, 850));
    const settled = layer.getSnapshot();
    assert.equal(settled.streamingUpdateCount, moving.streamingUpdateCount + 1);
    assert.equal(settled.performance.motionLive.state, "stationary");
    assert.equal(settled.performance.motionLive.activity, 0);
    assert.equal(
      settled.performance.motionPredictedHorizontalDisplacementDegrees,
      0,
    );
    assert.equal(
      settled.performance.motionPredictedVerticalDisplacementDegrees,
      0,
    );
    assert.equal(settled.performance.motionWeightMax, 0);
    assert.equal(source.pointChunkRequestCount, initialPointRequests);

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      layer.getSnapshot().streamingUpdateCount,
      settled.streamingUpdateCount,
    );
    assert.equal(source.pointChunkRequestCount, initialPointRequests);
  } finally {
    layer.destroy();
    globalThis.window = originalWindow;
  }
});

test("Cesium layer show state is isolated and survives attachment and reload", async () => {
  const firstSource = createBackend();
  const secondSource = createBackend();
  const firstLayer = new CopcCesiumLayer({
    url: "memory://first-layer.copc.laz",
    backend: firstSource.backend,
    decoder: firstSource.decoder,
  });
  const secondLayer = new CopcCesiumLayer({
    url: "memory://second-layer.copc.laz",
    backend: secondSource.backend,
    decoder: secondSource.decoder,
  });
  const viewer = createFakeViewer();

  await Promise.all([firstLayer.load(), secondLayer.load()]);
  firstLayer.attachTo(viewer);
  secondLayer.attachTo(viewer);
  await Promise.all([
    waitFor(() => firstLayer.getSnapshot().renderedPointCount === 2),
    waitFor(() => secondLayer.getSnapshot().renderedPointCount === 2),
  ]);

  const firstContainer = viewer.addedCollections[0];
  const secondContainer = viewer.addedCollections[1];
  const applicationPrimitive = { show: true };
  viewer.scene.primitives.add(applicationPrimitive);
  assert.notEqual(firstContainer, secondContainer);
  assert.equal(firstContainer.length, 1);
  assert.equal(secondContainer.length, 1);
  assert.equal(firstLayer.show, true);
  assert.equal(secondLayer.show, true);

  firstLayer.show = false;
  assert.equal(firstContainer.show, false);
  assert.equal(secondContainer.show, true);
  assert.equal(getLayerPointCollection(viewer, 0).get(0).show, true);
  firstLayer.show = true;
  assert.equal(firstContainer.show, true);

  firstLayer.show = false;
  firstLayer.detachFrom();
  assert.equal(viewer.removedCollections.length, 1);
  assert.equal(viewer.removedCollections[0], firstContainer);
  assert.equal(secondLayer.getSnapshot().attached, true);
  assert.equal(secondContainer.show, true);
  assert.equal(applicationPrimitive.show, true);

  firstLayer.attachTo(viewer);
  await waitFor(() => firstLayer.getSnapshot().renderedPointCount === 2);
  const reattachedContainer = viewer.addedCollections[3];
  assert.equal(reattachedContainer.show, false);
  assert.equal(firstLayer.show, false);

  await firstLayer.reload();
  assert.equal(viewer.addedCollections.length, 4);
  assert.equal(reattachedContainer.show, false);
  assert.equal(reattachedContainer.length, 1);
  assert.equal(secondLayer.getSnapshot().renderedPointCount, 2);

  firstLayer.destroy();
  assert.equal(viewer.removedCollections.length, 2);
  assert.equal(viewer.removedCollections[1], reattachedContainer);
  assert.equal(viewer.removedCollections.includes(applicationPrimitive), false);
  assert.equal(secondLayer.getSnapshot().attached, true);
  assert.equal(secondLayer.getSnapshot().renderedPointCount, 2);
  assert.equal(viewer.destroyed, false);
  secondLayer.destroy();
});

test("detaching while loading preserves the loading lifecycle", async () => {
  const opening = createDeferred();
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://loading.copc.laz",
    backend: {
      open() {
        return opening.promise;
      },
    },
  });
  const viewer = createFakeViewer();
  const loadPromise = layer.load();

  layer.attachTo(viewer);
  assert.equal(layer.getSnapshot().lifecycle, "loading");
  layer.detachFrom();
  assert.equal(layer.getSnapshot().lifecycle, "loading");

  opening.resolve(await source.backend.open("memory://loading.copc.laz"));
  await loadPromise;

  assert.equal(layer.getSnapshot().lifecycle, "ready");
  assert.equal(layer.getSnapshot().attached, false);
  layer.destroy();
});

test("coalesces repeated camera events when the view has not materially changed", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://camera-events.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  const initialUpdateCount = layer.getSnapshot().streamingUpdateCount;

  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  try {
    viewer.changed.raise();
    viewer.moveEnd.raise();
    await new Promise((resolve) => setTimeout(resolve, 125));

    assert.equal(layer.getSnapshot().streamingUpdateCount, initialUpdateCount);
  } finally {
    layer.destroy();
    globalThis.window = originalWindow;
  }
});

test("invalidates stale progress when a materially changed camera event is queued", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://queued-camera-events.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

  const controller = layer.controller;
  const originalUpdateView = controller.core.updateView.bind(controller.core);
  const staleUpdate = createDeferred();
  const currentUpdate = createDeferred();
  const stalePoints = {
    pointCount: 1,
    coordinates: new Float64Array([-122.3, 44.7, 25]),
  };
  let updateCallCount = 0;
  controller.core.updateView = async (view, onProgress) => {
    updateCallCount += 1;
    if (updateCallCount === 1) {
      await staleUpdate.promise;
      onProgress({
        selectedNodeKeys: ["stale-node"],
        removedNodeKeys: [],
        loadedNodePoints: new Map([["stale-node", stalePoints]]),
        completedBatchPointCount: 1,
        replacementGroups: [],
        generation: 1,
      });
      return {
        selectedNodeKeys: ["stale-node"],
        removedNodeKeys: [],
        loadedNodePoints: new Map([["stale-node", stalePoints]]),
        replacementGroups: [],
        generation: 1,
      };
    }
    if (updateCallCount === 2) {
      await currentUpdate.promise;
    }
    return originalUpdateView(view, onProgress);
  };

  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  try {
    viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      -122.5,
      44.5,
      2000,
    );
    viewer.moveEnd.raise();
    await waitFor(() => updateCallCount === 1);

    viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      -122.5,
      44.5,
      3000,
    );
    viewer.moveEnd.raise();
    await new Promise((resolve) => setTimeout(resolve, 125));

    let queuedUpdateSettled = false;
    const queuedUpdate = controller.updateStreamingView().then(() => {
      queuedUpdateSettled = true;
    });
    staleUpdate.resolve();
    await waitFor(() => updateCallCount === 2);

    assert.equal(
      layer.getSnapshot().renderedNodeKeys.includes("stale-node"),
      false,
    );
    assert.equal(queuedUpdateSettled, false);

    currentUpdate.resolve();
    await queuedUpdate;
  } finally {
    layer.destroy();
    globalThis.window = originalWindow;
  }
});

test("reload waits for a queued update after the previous update is invalidated", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://queued-reload.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

  const controller = layer.controller;
  const originalUpdateView = controller.core.updateView.bind(controller.core);
  const previousUpdate = createDeferred();
  const reloadUpdate = createDeferred();
  let updateCallCount = 0;
  controller.core.updateView = async (view, onProgress) => {
    updateCallCount += 1;
    if (updateCallCount === 1) {
      await previousUpdate.promise;
      return undefined;
    }
    if (updateCallCount === 2) {
      await reloadUpdate.promise;
    }
    return originalUpdateView(view, onProgress);
  };

  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  try {
    viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      -122.5,
      44.5,
      2000,
    );
    viewer.moveEnd.raise();
    await waitFor(() => updateCallCount === 1);

    let reloadSettled = false;
    const reloadPromise = layer.reload().then(() => {
      reloadSettled = true;
    });
    await waitFor(() => source.openCount === 2);
    assert.equal(reloadSettled, false);

    previousUpdate.resolve();
    await waitFor(() => updateCallCount === 2);
    assert.equal(reloadSettled, false);

    reloadUpdate.resolve();
    await reloadPromise;
    assert.equal(reloadSettled, true);
    await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
    assert.equal(layer.getSnapshot().lifecycle, "ready");
  } finally {
    layer.destroy();
    globalThis.window = originalWindow;
  }
});

test("a failed first render rolls back the shared core and keeps the viewer usable", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://render-failure.copc.laz",
    backend: source.backend,
    decoder: {
      async decode() {
        throw new Error("point decode failed");
      },
    },
  });
  const viewer = createFakeViewer();
  const errors = [];
  layer.error.addEventListener((event) => errors.push(event));
  layer.attachTo(viewer);

  await assert.rejects(() => layer.load(), /point decode failed/);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, "view");
  assert.ok(Number.isInteger(errors[0].viewGeneration));
  assert.equal("loadGeneration" in errors[0], false);
  assert.equal(layer.getSnapshot().lifecycle, "mounted");
  assert.equal(layer.getMetadata(), undefined);
  assert.deepEqual(layer.getSnapshot().renderedNodeKeys, []);
  assert.deepEqual(layer.getSnapshot().selectedNodeKeys, []);
  assert.equal(viewer.destroyed, false);
  layer.destroy();
});

test("detach invalidates an in-flight core update before stale points reach Cesium", async () => {
  let resolveDecode;
  let decodeStarted;
  const decodeReady = new Promise((resolve) => {
    decodeStarted = resolve;
  });
  const source = createBackend();
  source.decoder = {
    async decode() {
      decodeStarted();
      return new Promise((resolve) => {
        resolveDecode = resolve;
      });
    },
  };
  const layer = new CopcCesiumLayer({
    url: "memory://stale.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await decodeReady;
  layer.detachFrom();
  resolveDecode({
    pointCount: 2,
    coordinates: new Float64Array([-122.6, 44.4, 12, -122.4, 44.6, 18]),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(layer.getSnapshot().attached, false);
  assert.equal(layer.getSnapshot().renderedPointCount, 0);
  assert.equal(viewer.addedCollections.length, 1);
  assert.equal(viewer.removedCollections.length, 1);
  layer.destroy();
});

test("Cesium view adapter produces a plain perspective view for oblique cameras", () => {
  const viewer = createFakeViewer();
  viewer.scene.drawingBufferHeight = 900;
  viewer.scene.canvas = { clientHeight: 900, height: 900 };
  viewer.camera.frustum = {
    fov: Math.PI / 3,
    aspectRatio: 16 / 9,
    near: 1,
    far: 6000,
  };
  viewer.camera.directionWC = new Cesium.Cartesian3(0, 1, 0);
  viewer.camera.upWC = new Cesium.Cartesian3(0, 0, 1);
  viewer.camera.rightWC = new Cesium.Cartesian3(1, 0, 0);

  const view = createCesiumStreamingView(viewer);

  assert.equal(view.viewFrustum.coordinateSystem, "wgs84-ecef-meters");
  assert.equal(view.viewFrustum.viewportHeightPixels, 900);
  assert.equal(view.viewFrustum.farMeters, 6000);
  assert.deepEqual(view.viewFrustum.direction, { x: 0, y: 1, z: 0 });
});

test("Cesium picks resolve through the shared live node and point cache", async () => {
  const picked = [];
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://picking.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    colorMode: "rgb",
    onPointPicked: (point) => picked.push(point),
  });
  const viewer = createFakeViewer();
  const nodeKey = "0-0-0-0";
  let scenePickArguments;

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

  // Drive the adapter-owned picker without constructing a browser DOM or a
  // real WebGL scene.
  const controller = layer.controller;
  viewer.scene.pick = (...args) => {
    scenePickArguments = args;
    return {
      id: { nodeKey, pointIndex: 1, ownerId: controller.pointPicker.ownerId },
    };
  };
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));

  assert.equal(
    scenePickArguments.length,
    1,
    "default renderer keeps Cesium pick defaults",
  );
  assert.equal(layer.getSelectedPoint().nodeKey, nodeKey);
  assert.equal(layer.getSelectedPoint().pointIndex, 1);
  assert.deepEqual(layer.getSelectedPoint().rgb, {
    red: 128,
    green: 128,
    blue: 255,
  });

  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 1, ownerId: "copc-layer-foreign" },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(picked.at(-1), undefined);

  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 0, ownerId: controller.pointPicker.ownerId },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  controller.core.streamingState.cache.delete(nodeKey);
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(picked.at(-1), undefined);

  layer.destroy();
});

test("CesiumPointPicker delegates node-level hits to the injected renderer and inspects the returned identity", async () => {
  const source = createBackend();
  const renderer = new PointPrimitiveRenderer();
  const viewer = createFakeViewer();
  const nodeKey = "0-0-0-0";
  const picked = [];
  let pointPickerOwnerId;
  let scenePickCalls = 0;
  let resolverCalls = 0;
  let scenePickArguments;
  renderer.resolvePointPick = (scene, position, pickedObject) => {
    resolverCalls += 1;
    assert.equal(scene, viewer.scene);
    assert.deepEqual([position.x, position.y], [10, 10]);
    assert.equal(pickedObject.id.nodeKey, nodeKey);
    return {
      nodeKey,
      pointIndex: 1,
      ownerId: pointPickerOwnerId,
    };
  };
  const layer = new CopcCesiumLayer({
    url: "memory://batched-picker-delegation.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    renderer,
    onPointPicked: (point) => picked.push(point),
  });
  pointPickerOwnerId = layer.controller.pointPicker.ownerId;

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  viewer.scene.pick = (...args) => {
    scenePickCalls += 1;
    scenePickArguments = args;
    return { id: { nodeKey, ownerId: layer.controller.pointPicker.ownerId } };
  };
  layer.controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));

  assert.equal(scenePickCalls, 1);
  assert.deepEqual(scenePickArguments.slice(1), [1, 1]);
  assert.equal(resolverCalls, 1);
  assert.equal(layer.getSelectedPoint().nodeKey, nodeKey);
  assert.equal(layer.getSelectedPoint().pointIndex, 1);
  assert.deepEqual(layer.getSelectedPoint().rgb, {
    red: 128,
    green: 128,
    blue: 255,
  });
  assert.equal(picked.at(-1).pointIndex, 1);
  layer.destroy();
});

test("terrain alignment estimates use the selected layer-owned point and invalidate on provider replacement", async () => {
  const verticalTransform = await createSyntheticVerticalGrid();
  const source = createBackend({
    metadata: {
      pointCount: 2,
      bounds: {
        minX: -123,
        minY: 44,
        minZ: 10,
        maxX: -122,
        maxY: 45,
        maxZ: 20,
      },
      cube: {
        minX: -123,
        minY: 44,
        minZ: 10,
        maxX: -122,
        maxY: 45,
        maxZ: 20,
      },
      wkt: WGS84_ORTHOMETRIC_WKT,
    },
  });
  const layer = new CopcCesiumLayer({
    url: "memory://terrain-estimate.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    heightOffsetMeters: 5,
    verticalTransform,
    coordinateCacheLayout: "A",
  });
  const viewer = createFakeViewer();
  const provider = createTerrainSamplingProvider(65);
  viewer.terrainProvider = provider;

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  const controller = layer.controller;
  viewer.scene.pick = () => ({
    id: { nodeKey: "0-0-0-0", pointIndex: 0, ownerId: controller.pointPicker.ownerId },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  const pickedBefore = layer.getSelectedPoint();
  const boundsBefore = layer.boundingSphere;

  const firstEstimate = await layer.estimateTerrainHeightAlignment(pickedBefore);
  assert.equal(firstEstimate.status, "ready");
  assert.equal(firstEstimate.actionable, true);
  assert.equal(firstEstimate.anchor.displayedHeightMeters, 42);
  assert.equal(firstEstimate.terrainHeightMeters, 65);
  assert.equal(firstEstimate.proposedOffsetMeters, 23);
  assert.equal(firstEstimate.existingHeightOffsetMeters, 5);
  assert.equal(firstEstimate.effectiveProposedHeightOffsetMeters, 28);
  assert.equal(firstEstimate.anchor.source.z, 12);
  assert.equal(layer.isTerrainHeightAlignmentEstimateCurrent(firstEstimate), true);
  assert.equal(layer.getSelectedPoint().height, 42);
  assert.equal(layer.getSelectedPoint().source.z, 12);
  assert.deepEqual(layer.boundingSphere, boundsBefore);

  viewer.terrainProvider = createTerrainSamplingProvider(66);
  assert.equal(layer.isTerrainHeightAlignmentEstimateCurrent(firstEstimate), false);
  const secondEstimate = await layer.estimateTerrainHeightAlignment(
    layer.getSelectedPoint(),
  );
  assert.equal(secondEstimate.terrainHeightMeters, 66);
  assert.equal(layer.isTerrainHeightAlignmentEstimateCurrent(firstEstimate), false);
  assert.equal(layer.isTerrainHeightAlignmentEstimateCurrent(secondEstimate), true);

  layer.destroy();

  // Applying is an explicit caller action: rebuild from the same source with
  // the proposed total offset rather than modifying the old layer in place.
  const approvedOffset = secondEstimate.effectiveProposedHeightOffsetMeters;
  const appliedLayer = new CopcCesiumLayer({
    url: "memory://terrain-estimate.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    heightOffsetMeters: approvedOffset,
    verticalTransform,
    coordinateCacheLayout: "A",
  });
  const appliedViewer = createFakeViewer();
  appliedViewer.terrainProvider = createTerrainSamplingProvider(66);
  await appliedLayer.load();
  appliedLayer.attachTo(appliedViewer);
  await waitFor(() => appliedLayer.getSnapshot().renderedPointCount === 2);
  const appliedBounds = appliedLayer.boundingSphere;
  assert.ok(appliedBounds);
  assert.notDeepEqual(appliedBounds.center, boundsBefore.center);

  const appliedController = appliedLayer.controller;
  appliedViewer.scene.pick = () => ({
    id: {
      nodeKey: "0-0-0-0",
      pointIndex: 0,
      ownerId: appliedController.pointPicker.ownerId,
    },
  });
  appliedController.pointPicker.pick(
    appliedViewer,
    new Cesium.Cartesian2(10, 10),
  );
  const appliedPoint = appliedLayer.getSelectedPoint();
  assert.equal(appliedPoint.source.z, 12);
  assert.equal(appliedPoint.height, 66);

  const zoomed = appliedLayer.zoomTo();
  assert.ok(appliedViewer.camera.lastBoundingSphereFlight);
  appliedViewer.camera.completeBoundingSphereFlight();
  assert.equal(await zoomed, true);
  appliedLayer.destroy();

  const experimentalCore = createExperimentalCompactEStreamingCore({
    url: "memory://terrain-estimate.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    heightOffsetMeters: approvedOffset,
    verticalTransform,
    streaming: {
      maxNodes: 8,
      maxDepth: 0,
      maxRenderDistanceMeters: 100_000,
      maxScreenSpaceError: 8,
      maxPointsPerBatch: 2,
    },
  });
  await experimentalCore.load();
  const eUpdate = await experimentalCore.updateView({
    longitude: -122.5,
    latitude: 44.5,
    height: 1_066,
    viewDistanceMeters: 12_000,
  });
  assert.ok(eUpdate?.loadedNodePoints.has("0-0-0-0"));
  const ePointData = eUpdate.loadedNodePoints.get("0-0-0-0");
  assert.ok(isCompactEPointCacheNode(ePointData));
  assert.deepEqual([...ePointData.height], [66, 72]);
  assert.equal("sourceCoordinates" in ePointData, false);
  assert.equal("geographic" in ePointData, false);
  assert.throws(
    () => experimentalCore.getCachedPreparedPointData("0-0-0-0"),
    /unavailable for E cache entries/,
  );
  experimentalCore.destroy();
});

test("terrain estimates stay independent for multiple layers on one Viewer", async () => {
  const verticalTransform = await createSyntheticVerticalGrid();
  const firstSource = createBackend({
    metadata: {
      pointCount: 2,
      bounds: {
        minX: -123,
        minY: 44,
        minZ: 10,
        maxX: -122,
        maxY: 45,
        maxZ: 20,
      },
      cube: {
        minX: -123,
        minY: 44,
        minZ: 10,
        maxX: -122,
        maxY: 45,
        maxZ: 20,
      },
      wkt: WGS84_ORTHOMETRIC_WKT,
    },
  });
  const secondSource = createBackend({
    metadata: {
      pointCount: 2,
      bounds: {
        minX: -123,
        minY: 44,
        minZ: 10,
        maxX: -122,
        maxY: 45,
        maxZ: 20,
      },
      cube: {
        minX: -123,
        minY: 44,
        minZ: 10,
        maxX: -122,
        maxY: 45,
        maxZ: 20,
      },
      wkt: WGS84_ORTHOMETRIC_WKT,
    },
  });
  const firstLayer = new CopcCesiumLayer({
    url: "memory://terrain-first-layer.copc.laz",
    backend: firstSource.backend,
    decoder: firstSource.decoder,
    heightOffsetMeters: 2,
    verticalTransform,
    coordinateCacheLayout: "A",
  });
  const secondLayer = new CopcCesiumLayer({
    url: "memory://terrain-second-layer.copc.laz",
    backend: secondSource.backend,
    decoder: secondSource.decoder,
    heightOffsetMeters: -3,
    verticalTransform,
    coordinateCacheLayout: "A",
  });
  const viewer = createFakeViewer();
  viewer.terrainProvider = createTerrainSamplingProvider(65);

  await Promise.all([firstLayer.load(), secondLayer.load()]);
  firstLayer.attachTo(viewer);
  secondLayer.attachTo(viewer);
  await Promise.all([
    waitFor(() => firstLayer.getSnapshot().renderedPointCount === 2),
    waitFor(() => secondLayer.getSnapshot().renderedPointCount === 2),
  ]);

  const pickFirstLayer = (layer) => {
    const controller = layer.controller;
    viewer.scene.pick = () => ({
      id: {
        nodeKey: "0-0-0-0",
        pointIndex: 0,
        ownerId: controller.pointPicker.ownerId,
      },
    });
    controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
    return layer.getSelectedPoint();
  };
  const firstAnchor = pickFirstLayer(firstLayer);
  const secondAnchor = pickFirstLayer(secondLayer);
  assert.notEqual(firstAnchor.ownerId, secondAnchor.ownerId);
  assert.equal(firstAnchor.height, 39);
  assert.equal(secondAnchor.height, 34);

  const firstEstimate = await firstLayer.estimateTerrainHeightAlignment(firstAnchor);
  const secondEstimate = await secondLayer.estimateTerrainHeightAlignment(secondAnchor);
  assert.equal(firstEstimate.existingHeightOffsetMeters, 2);
  assert.equal(secondEstimate.existingHeightOffsetMeters, -3);
  assert.equal(firstEstimate.effectiveProposedHeightOffsetMeters, 28);
  assert.equal(secondEstimate.effectiveProposedHeightOffsetMeters, 28);
  assert.equal(firstLayer.isTerrainHeightAlignmentEstimateCurrent(firstEstimate), true);
  assert.equal(secondLayer.isTerrainHeightAlignmentEstimateCurrent(secondEstimate), true);

  firstLayer.destroy();
  assert.equal(firstLayer.isTerrainHeightAlignmentEstimateCurrent(firstEstimate), false);
  assert.equal(secondLayer.isTerrainHeightAlignmentEstimateCurrent(secondEstimate), true);
  secondLayer.destroy();
  assert.equal(viewer.destroyed, false);
});

test("batched renderer follows layer style, unload, reload, and reattach lifecycle", async () => {
  const source = createBackend();
  const renderer = new BatchedGeometryPointRenderer();
  const layer = new CopcCesiumLayer({
    url: "memory://batched-lifecycle.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    renderer,
    colorMode: "classification",
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  const nodeKey = layer.getSnapshot().renderedNodeKeys[0];
  assert.ok(nodeKey);
  const initialRequests = source.pointChunkRequestCount;
  assert.equal(renderer.hasNode(nodeKey), true);

  layer.setStyle({ classificationFilter: { include: [6] } });
  assert.equal(layer.getSnapshot().renderedPointCount, 1);
  assert.equal(renderer.getRenderedNodePointCount(nodeKey), 1);
  assert.equal(source.pointChunkRequestCount, initialRequests);

  layer.unload();
  assert.equal(layer.getSnapshot().renderedPointCount, 0);
  assert.equal(renderer.getRenderedNodeKeys().length, 0);
  await layer.reload();
  await waitFor(() => layer.getSnapshot().renderedPointCount === 1);
  assert.equal(renderer.hasNode(nodeKey), true);

  layer.detachFrom();
  assert.equal(layer.getSnapshot().renderedPointCount, 0);
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 1);
  layer.destroy();
  assert.equal(renderer.getRenderedNodeKeys().length, 0);
  assert.equal(viewer.destroyed, false);
});

test("selection is cleared across unload, reload, and removed transition coverage", async () => {
  const picked = [];
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://selection-lifecycle.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    onPointPicked: (point) => picked.push(point),
  });
  const viewer = createFakeViewer();
  const nodeKey = "0-0-0-0";

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  const controller = layer.controller;

  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 0, ownerId: controller.pointPicker.ownerId },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  assert.ok(layer.getSelectedPoint());

  layer.unload();
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(layer.getSnapshot().selectedNodeKeys.length, 0);
  assert.equal(layer.getSnapshot().renderedPointCount, 0);

  await layer.reload();
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  assert.ok(layer.getSelectedPoint());

  const childPoints = {
    pointCount: 1,
    coordinates: new Float64Array([-122.4, 44.6, 18]),
  };
  controller.applyStreamingProgress(
    viewer,
    {
      selectedNodeKeys: ["1-child"],
      removedNodeKeys: [nodeKey],
      loadedNodePoints: new Map([["1-child", childPoints]]),
      completedBatchPointCount: 1,
      replacementGroups: [
        {
          kind: "refinement",
          oldNodeKeys: [nodeKey],
          newNodeKeys: ["1-child"],
        },
      ],
      generation: 1,
    },
    1,
  );

  assert.deepEqual(layer.getSnapshot().renderedNodeKeys, ["1-child"]);
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(picked.at(-1), undefined);

  // Keep the fixture explicit: old coverage is gone and cannot be picked
  // again even if a stale scene object is presented to the adapter.
  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 0, ownerId: controller.pointPicker.ownerId },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  assert.equal(layer.getSelectedPoint(), undefined);

  layer.destroy();
});

test("public snapshot composes core and renderer state without old-layer values", async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: "memory://snapshot.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

  const ready = layer.getSnapshot();
  assert.equal(ready.streamingUpdateCount, 1);
  assert.equal(
    ready.performance.activeRenderedPointCount,
    ready.renderedPointCount,
  );
  assert.equal(ready.performance.selectedNodeCount, 1);
  assert.equal(ready.pointCache.cachedNodeCount, 1);

  layer.unload();
  const unloaded = layer.getSnapshot();
  assert.equal(unloaded.streamingUpdateCount, 0);
  assert.deepEqual(unloaded.selectedNodeKeys, []);
  assert.deepEqual(unloaded.renderedNodeKeys, []);
  assert.equal(unloaded.renderedPointCount, 0);
  assert.equal(unloaded.performance.activeRenderedPointCount, 0);
  assert.equal(unloaded.performance.selectedNodeCount, 0);
  assert.equal(unloaded.performance.rendererPreparationDurationMs, 0);
  assert.equal(unloaded.pointCache.cachedNodeCount, 0);

  layer.destroy();
});
