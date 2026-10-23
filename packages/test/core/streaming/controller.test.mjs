import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { CopcStreamingController } from "../../../core/streaming/CopcStreamingController.ts";
import {
  CopcStreamingCore,
  createExperimentalCompactEStreamingCore,
} from "../../../core/streaming/CopcStreamingCore.ts";
import { inspectCopcPoint } from "../../../core/copc/points/pointInspection.ts";
import {
  createPerspectiveViewFrustum,
  geographicToEcef,
} from "../../../core/streaming/view.ts";
import { createPreparedPointData } from "../../../core/point/preparedPoint.ts";
import { getCompactEPreparedHeightBuffer } from "../../../core/point/compactEPointCache.ts";
import { createPredictedStreamingView } from "../../../core/streaming/predictivePrefetch.ts";
import { loadGtxGeoidGrid } from "../../../core/coordinates/transform/verticalGrid.ts";

const ROOT_KEY = "0-0-0-0";
const CHILD_KEY = "1-0-0-0";

function createMetadata(wkt) {
  return {
    pointCount: 2,
    bounds: {
      minX: 10,
      minY: 20,
      minZ: 100,
      maxX: 10.01,
      maxY: 20.01,
      maxZ: 200,
    },
    cube: {
      minX: 10,
      minY: 20,
      minZ: 100,
      maxX: 10.01,
      maxY: 20.01,
      maxZ: 200,
    },
    spacing: 10,
    ...(wkt ? { wkt } : {}),
  };
}

function createNode(key, level, pointCount, children = []) {
  return {
    key,
    level,
    x: 0,
    y: 0,
    z: 0,
    pointCount,
    pointDataOffset: level * 100,
    pointDataLength: 20,
    children,
    childrenComplete: true,
  };
}

function createSourceFactory({
  onOpen,
  onPerformanceObserver,
  onPreparedPointLoad,
  metadata = createMetadata(),
  paged = false,
  prepared = false,
  preparedHeightOffsetMeters,
} = {}) {
  let openCount = 0;
  let destroyCount = 0;
  let performanceObserver;
  const root = createNode(ROOT_KEY, 0, 1, [CHILD_KEY]);
  const child = createNode(CHILD_KEY, 1, 1);

  return {
    get openCount() {
      return openCount;
    },
    get destroyCount() {
      return destroyCount;
    },
    backend: {
      async open(source) {
        openCount += 1;
        onOpen?.(source);
        return {
          source,
          ...(preparedHeightOffsetMeters === undefined
            ? {}
            : { preparedHeightOffsetMeters }),
          getMetadata: () => metadata,
          getRootHierarchyPage() {
            return { key: ROOT_KEY, pageOffset: 0, pageLength: 10 };
          },
          setPerformanceObserver(observer) {
            performanceObserver = observer;
            onPerformanceObserver?.(observer);
          },
          async loadHierarchyPage(page) {
            performanceObserver?.({
              stage: "rangeFetch",
              durationMs: 7,
              bytes: page.pageLength,
            });
            if (paged && page.key === ROOT_KEY) {
              return {
                nodes: [root],
                pages: [{ key: CHILD_KEY, pageOffset: 10, pageLength: 10 }],
              };
            }
            if (!paged) {
              return { nodes: [root, child], pages: [] };
            }
            return { nodes: [child], pages: [] };
          },
          async loadPointDataView() {
            return {
              pointCount: 1,
              availableFields: new Set(["position"]),
              getter() {
                return () => 0;
              },
            };
          },
          ...(prepared
            ? {
                async loadPreparedPointData(node, fields, options) {
                  if (onPreparedPointLoad) {
                    return onPreparedPointLoad(node, fields, options);
                  }
                  performanceObserver?.({
                    stage: "decode",
                    durationMs: 5,
                    bytes: 20,
                  });
                  performanceObserver?.({
                    stage: "pointPreparation",
                    durationMs: 3,
                  });
                  return createPreparedPointData({
                    pointCount: 1,
                    sourceCoordinates: new Float64Array([10.005, 20.005, 150]),
                    geographicCoordinates: new Float64Array([
                      10.005, 20.005, 150,
                    ]),
                    worldCoordinates: new Float64Array([1, 2, 3]),
                  });
                },
              }
            : {}),
          destroy() {
            destroyCount += 1;
          },
        };
      },
    },
  };
}

function createView(overrides = {}) {
  return {
    longitude: 10.005,
    latitude: 20.005,
    height: 150,
    viewDistanceMeters: 6000,
    ...overrides,
  };
}

function createMotionFrustum(yawDegrees) {
  const yaw = (yawDegrees * Math.PI) / 180;
  return createPerspectiveViewFrustum({
    position: geographicToEcef({
      longitude: 10.005,
      latitude: 20.005,
      height: 150,
    }),
    direction: { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) },
    up: { x: 0, y: 1, z: 0 },
    right: { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) },
    verticalFovRadians: Math.PI / 3,
    aspectRatio: 1,
    nearMeters: 1,
    farMeters: 6000,
  });
}

function createEcefNadirView(yawDegrees = 0) {
  const yaw = (yawDegrees * Math.PI) / 180;
  const position = geographicToEcef({
    longitude: 0,
    latitude: 0,
    height: 1000,
  });
  return {
    longitude: 0,
    latitude: 0,
    height: 1000,
    viewDistanceMeters: 12_000,
    viewFrustum: createPerspectiveViewFrustum({
      position,
      direction: { x: -Math.cos(yaw), y: Math.sin(yaw), z: 0 },
      right: { x: Math.sin(yaw), y: Math.cos(yaw), z: 0 },
      up: { x: 0, y: 0, z: 1 },
      verticalFovRadians: Math.PI / 36,
      aspectRatio: 1,
      nearMeters: 1,
      farMeters: 12_000,
    }),
  };
}

function createPrefetchTestHierarchy() {
  const nodes = [];
  let pointDataOffset = 100;
  for (let level = 0; level <= 2; level += 1) {
    const side = 2 ** level;
    for (let x = 0; x < side; x += 1) {
      for (let y = 0; y < side; y += 1) {
        for (let z = 0; z < side; z += 1) {
          nodes.push({
            key: `${level}-${x}-${y}-${z}`,
            level,
            x,
            y,
            z,
            pointCount: level === 2 ? 10 : 1,
            pointDataOffset: pointDataOffset++,
            pointDataLength: 10,
          });
        }
      }
    }
  }
  return nodes;
}

function createPointBuffer(height = 150) {
  return {
    pointCount: 1,
    coordinates: new Float64Array([10.005, 20.005, height]),
  };
}

async function createSyntheticVerticalGrid({
  latitudeOrigin = 19,
  longitudeOrigin = 9,
  latitudeStep = 1,
  longitudeStep = 1,
} = {}) {
  const rows = 3;
  const columns = 3;
  const bytes = new ArrayBuffer(40 + rows * columns * 4);
  const view = new DataView(bytes);
  view.setFloat64(0, latitudeOrigin, false);
  view.setFloat64(8, longitudeOrigin, false);
  view.setFloat64(16, latitudeStep, false);
  view.setFloat64(24, longitudeStep, false);
  view.setInt32(32, rows, false);
  view.setInt32(36, columns, false);
  Array.from({ length: rows * columns }, () => 25).forEach((value, index) =>
    view.setFloat32(40 + index * 4, value, false),
  );
  const sha256 = createHash("sha256")
    .update(new Uint8Array(bytes))
    .digest("hex");
  return loadGtxGeoidGrid(bytes, {
    gridId: "streaming-synthetic-grid",
    sourceVerticalCrs: "Local orthometric height",
    targetVerticalCrs: "EPSG:4979",
    horizontalCrs: "EPSG:4326",
    referenceEllipsoid: "WGS84",
    sha256,
    valueUnit: "metre",
    valueConvention: "ellipsoidal-minus-orthometric",
    noDataValue: null,
  });
}

function createController(backend, options = {}) {
  return new CopcStreamingController({
    url: "memory://deterministic.copc.laz",
    backend,
    decoder: {
      async decode() {
        return createPointBuffer();
      },
    },
    streaming: {
      maxNodes: 8,
      maxDepth: 0,
      maxRenderDistanceMeters: 12000,
      maxScreenSpaceError: 8,
      maxPointsPerBatch: 1,
    },
    ...options,
  });
}

test("renderer-neutral core loads metadata and hierarchy without Cesium", async () => {
  const source = createSourceFactory();
  const controller = createController(source.backend);

  await controller.load();

  assert.equal(controller.getMetadata().pointCount, 2);
  assert.equal(controller.getSnapshot().lifecycle, "ready");
  const hierarchy = controller.getHierarchyDiagnostics();
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
  assert.equal(hierarchy.loadedEntryCount, 2);

  controller.destroy();
  assert.equal(source.destroyCount, 1);
});

test("shared streaming core applies a grid once after prepared Rust-style output and across reload", async () => {
  const wkt =
    'COMPD_CS["WGS 84 + Local orthometric height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],VERT_CS["Local orthometric height",VERT_DATUM["Local vertical datum",2005],UNIT["metre",1],AXIS["Gravity-related height",UP]]]';
  const metadata = createMetadata(wkt);
  const source = createSourceFactory({
    metadata,
    prepared: true,
    preparedHeightOffsetMeters: 5,
    onPreparedPointLoad: () => {
      const geographic = new Float64Array([10.005, 20.005, 155]);
      const world = geographicToEcef({
        longitude: geographic[0],
        latitude: geographic[1],
        height: geographic[2],
      });
      return createPreparedPointData({
        pointCount: 1,
        sourceCoordinates: new Float64Array([10.005, 20.005, 150]),
        geographicCoordinates: geographic,
        worldCoordinates: new Float64Array([world.x, world.y, world.z]),
      });
    },
  });
  const grid = await createSyntheticVerticalGrid();
  const core = new CopcStreamingCore({
    url: "memory://geoid.copc.laz",
    backend: source.backend,
    heightOffsetMeters: 5,
    verticalTransform: grid,
    streaming: {
      maxNodes: 8,
      maxDepth: 0,
      maxRenderDistanceMeters: 12000,
      maxScreenSpaceError: 8,
      maxPointsPerBatch: 1,
    },
  });

  await core.load();
  await core.updateView(createView());
  const performance = core.getSnapshot().performance;
  assert.ok(performance.crsTransformDurationMs > 0);
  assert.ok(performance.longestMainThreadBlockingSectionMs > 0);
  let prepared = core.getCachedPreparedPointData(ROOT_KEY);
  assert.deepEqual([...prepared.source.coordinates], [10.005, 20.005, 150]);
  assert.equal(prepared.geographic.coordinates[2], 180);
  const expectedWorld = geographicToEcef({
    longitude: 10.005,
    latitude: 20.005,
    height: 180,
  });
  assert.deepEqual([...prepared.world.coordinates], [expectedWorld.x, expectedWorld.y, expectedWorld.z]);

  core.unload();
  await core.load();
  await core.updateView(createView());
  prepared = core.getCachedPreparedPointData(ROOT_KEY);
  assert.equal(prepared.geographic.coordinates[2], 180);
  assert.deepEqual([...prepared.source.coordinates], [10.005, 20.005, 150]);
  core.destroy();
});

test("internal E streaming path preserves exact coordinates and reuses prepared height without re-decoding", async () => {
  const geographicCoordinates = new Float64Array([10.005, 20.005, 150.125]);
  const world = geographicToEcef({
    longitude: geographicCoordinates[0],
    latitude: geographicCoordinates[1],
    height: geographicCoordinates[2],
  });
  const sourceCoordinates = new Float64Array([500.25, 600.5, 7.75]);
  let preparedPointLoadCount = 0;
  const source = createSourceFactory({
    prepared: true,
    onPreparedPointLoad: () => {
      preparedPointLoadCount += 1;
      return createPreparedPointData({
        pointCount: 1,
        sourceCoordinates: sourceCoordinates.slice(),
        geographicCoordinates,
        worldCoordinates: new Float64Array([world.x, world.y, world.z]),
      });
    },
  });
  const core = createExperimentalCompactEStreamingCore({
    url: "memory://compact-e.copc.laz",
    backend: source.backend,
    streaming: {
      maxNodes: 8,
      maxDepth: 0,
      maxRenderDistanceMeters: 12_000,
      maxScreenSpaceError: 8,
      maxPointsPerBatch: 1,
    },
  });

  await core.load();
  const update = await core.updateView(createView());
  assert.ok(update?.loadedNodePoints.has(ROOT_KEY));
  const cachedPrepared = core.getCachedPreparedPointData(ROOT_KEY);
  const cachedPointBuffer = core.getCachedPointBuffer(ROOT_KEY);
  assert.ok(cachedPrepared);
  assert.ok(cachedPointBuffer);
  assert.deepEqual([...cachedPrepared.source.coordinates], [500.25, 600.5, 7.75]);
  assert.equal(cachedPrepared.geographic.coordinates[2], 150.125);
  assert.deepEqual([...cachedPrepared.world.coordinates], [world.x, world.y, world.z]);
  assert.equal(cachedPrepared.coordinates, cachedPrepared.geographic.coordinates);
  assert.equal(cachedPrepared.sourceCoordinates, cachedPrepared.source.coordinates);
  assert.equal(cachedPrepared.worldCoordinates, cachedPrepared.world.coordinates);
  assert.deepEqual(
    [...update.loadedNodePoints.get(ROOT_KEY).geographic.coordinates],
    [...cachedPrepared.geographic.coordinates],
  );

  const inspection = inspectCopcPoint(
    { nodeKey: ROOT_KEY, pointIndex: 0 },
    core.getHierarchyNode(ROOT_KEY).node,
    cachedPointBuffer,
    "custom",
  );
  assert.deepEqual(inspection.source, { x: 500.25, y: 600.5, z: 7.75 });
  assert.equal(inspection.height, 150.125);
  assert.equal(core.getSnapshot().pointCache.currentCacheBytes, 80);
  assert.equal(preparedPointLoadCount, 1);

  const cacheHitsBefore = core.getSnapshot().pointCache.hits;
  await core.updateView(createView({ longitude: 10.006 }));
  assert.equal(preparedPointLoadCount, 1);
  assert.ok(core.getSnapshot().pointCache.hits > cacheHitsBefore);
  assert.deepEqual(
    [...core.getCachedPreparedPointData(ROOT_KEY).geographic.coordinates],
    [...geographicCoordinates],
  );
  core.destroy();
});

test("experimental E keeps height and ECEF synchronized across positive and negative offsets", async () => {
  for (const heightOffsetMeters of [25, -13.75]) {
    const source = createSourceFactory({ prepared: true });
    const core = createExperimentalCompactEStreamingCore({
      url: `memory://compact-e-offset-${heightOffsetMeters}.copc.laz`,
      backend: source.backend,
      decoder: undefined,
      heightOffsetMeters,
      streaming: {
        maxNodes: 8,
        maxDepth: 0,
        maxRenderDistanceMeters: 12_000,
        maxScreenSpaceError: 8,
        maxPointsPerBatch: 1,
      },
    });

    await core.load();
    await core.updateView(createView());
    const prepared = core.getCachedPreparedPointData(ROOT_KEY);
    const compactHeight = getCompactEPreparedHeightBuffer(prepared);
    const expectedHeight = 150 + heightOffsetMeters;
    const expectedWorld = geographicToEcef({
      longitude: 10.005,
      latitude: 20.005,
      height: expectedHeight,
    });

    assert.ok(compactHeight instanceof Float64Array);
    assert.equal(compactHeight[0], expectedHeight);
    assert.equal(prepared.geographic.coordinates[2], compactHeight[0]);
    assert.deepEqual(
      [...prepared.world.coordinates],
      [expectedWorld.x, expectedWorld.y, expectedWorld.z],
    );
    assert.deepEqual([...prepared.source.coordinates], [10.005, 20.005, 150]);
    core.destroy();
    assert.equal(core.getCachedPreparedPointData(ROOT_KEY), undefined);
  }
});

test("experimental E applies an opt-in geoid correction once after backend height offset", async () => {
  const wkt =
    'COMPD_CS["WGS 84 + Local orthometric height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],VERT_CS["Local orthometric height",VERT_DATUM["Local vertical datum",2005],UNIT["metre",1],AXIS["Gravity-related height",UP]]]';
  const geographicCoordinates = new Float64Array([10.005, 20.005, 155]);
  const backendWorld = geographicToEcef({
    longitude: geographicCoordinates[0],
    latitude: geographicCoordinates[1],
    height: geographicCoordinates[2],
  });
  const source = createSourceFactory({
    metadata: createMetadata(wkt),
    prepared: true,
    preparedHeightOffsetMeters: 5,
    onPreparedPointLoad: () =>
      createPreparedPointData({
        pointCount: 1,
        sourceCoordinates: new Float64Array([10.005, 20.005, 150]),
        geographicCoordinates,
        worldCoordinates: new Float64Array([
          backendWorld.x,
          backendWorld.y,
          backendWorld.z,
        ]),
      }),
  });
  const verticalGrid = await createSyntheticVerticalGrid();
  const core = createExperimentalCompactEStreamingCore({
    url: "memory://compact-e-geoid.copc.laz",
    backend: source.backend,
    decoder: undefined,
    heightOffsetMeters: 5,
    verticalTransform: verticalGrid,
    streaming: {
      maxNodes: 8,
      maxDepth: 0,
      maxRenderDistanceMeters: 12_000,
      maxScreenSpaceError: 8,
      maxPointsPerBatch: 1,
    },
  });

  await core.load();
  await core.updateView(createView());
  const prepared = core.getCachedPreparedPointData(ROOT_KEY);
  const compactHeight = getCompactEPreparedHeightBuffer(prepared);
  const expectedWorld = geographicToEcef({
    longitude: 10.005,
    latitude: 20.005,
    height: 180,
  });
  assert.equal(compactHeight[0], 180);
  assert.equal(prepared.geographic.coordinates[2], compactHeight[0]);
  assert.deepEqual(
    [...prepared.world.coordinates],
    [expectedWorld.x, expectedWorld.y, expectedWorld.z],
  );
  assert.deepEqual([...prepared.source.coordinates], [10.005, 20.005, 150]);
  core.destroy();
});

test("experimental E preserves A selection, replacement, and cache reuse across LoD updates", async () => {
  const createPair = () => {
    const sourceA = createSourceFactory({ paged: true, prepared: true });
    const sourceE = createSourceFactory({ paged: true, prepared: true });
    const streaming = {
      maxNodes: 8,
      maxDepth: 1,
      maxRenderDistanceMeters: 12_000,
      maxScreenSpaceError: 8,
      maxPointsPerBatch: 2,
    };
    return [
      new CopcStreamingCore({
        url: "memory://layout-a-lod.copc.laz",
        backend: sourceA.backend,
        decoder: undefined,
        streaming,
      }),
      createExperimentalCompactEStreamingCore({
        url: "memory://layout-e-lod.copc.laz",
        backend: sourceE.backend,
        decoder: undefined,
        streaming,
      }),
    ];
  };
  const [coreA, coreE] = createPair();
  await Promise.all([coreA.load(), coreE.load()]);
  const nearView = createView({ viewDistanceMeters: 500 });
  const firstA = await coreA.updateView(nearView);
  const firstE = await coreE.updateView(nearView);
  const fartherView = createView({ viewDistanceMeters: 600 });
  const secondA = await coreA.updateView(fartherView);
  const secondE = await coreE.updateView(fartherView);

  assert.deepEqual(firstE.selectedNodeKeys, firstA.selectedNodeKeys);
  assert.deepEqual(firstE.replacementGroups, firstA.replacementGroups);
  assert.deepEqual(secondE.selectedNodeKeys, secondA.selectedNodeKeys);
  assert.deepEqual(secondE.replacementGroups, secondA.replacementGroups);
  assert.deepEqual(coreE.getCurrentSelection(), coreA.getCurrentSelection());
  assert.ok(
    secondE.selectedNodeKeys.some((nodeKey) => nodeKey.startsWith("1-")) ||
      firstE.selectedNodeKeys.some((nodeKey) => nodeKey.startsWith("1-")),
    "near-view selection should exercise child LoD nodes",
  );
  assert.ok(coreE.getSnapshot().pointCache.hits > 0);
  for (const nodeKey of coreE.getCurrentSelection()) {
    const pointsA = coreA.getCachedPreparedPointData(nodeKey);
    const pointsE = coreE.getCachedPreparedPointData(nodeKey);
    assert.ok(pointsA);
    assert.ok(pointsE);
    assert.deepEqual(
      [...pointsE.source.coordinates],
      [...pointsA.source.coordinates],
    );
    assert.deepEqual(
      [...pointsE.world.coordinates],
      [...pointsA.world.coordinates],
    );
  }
  coreA.destroy();
  coreE.destroy();
});

test("public core construction keeps production A as the default cache layout", async () => {
  let preparedInput;
  const source = createSourceFactory({
    prepared: true,
    onPreparedPointLoad: () => {
      const world = geographicToEcef({
        longitude: 10.005,
        latitude: 20.005,
        height: 150,
      });
      preparedInput = createPreparedPointData({
        pointCount: 1,
        sourceCoordinates: new Float64Array([500.25, 600.5, 7.75]),
        geographicCoordinates: new Float64Array([10.005, 20.005, 150]),
        worldCoordinates: new Float64Array([world.x, world.y, world.z]),
      });
      return preparedInput;
    },
  });
  const core = new CopcStreamingCore({
    url: "memory://production-a.copc.laz",
    backend: source.backend,
    streaming: {
      maxNodes: 8,
      maxDepth: 0,
      maxRenderDistanceMeters: 12_000,
      maxScreenSpaceError: 8,
      maxPointsPerBatch: 1,
    },
  });

  await core.load();
  await core.updateView(createView());
  assert.equal(core.getSnapshot().pointCache.currentCacheBytes, 72);
  assert.equal(core.getCachedPreparedPointData(ROOT_KEY), preparedInput);
  core.destroy();
});

test("regional geoid grids do not need to cover synthetic camera query corners", async () => {
  const wkt =
    'COMPD_CS["WGS 84 + Local orthometric height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],VERT_CS["Local orthometric height",VERT_DATUM["Local vertical datum",2005],UNIT["metre",1],AXIS["Gravity-related height",UP]]]';
  const source = createSourceFactory({
    metadata: createMetadata(wkt),
    prepared: true,
    preparedHeightOffsetMeters: 5,
    onPreparedPointLoad: () => {
      const geographic = new Float64Array([10.005, 20.005, 155]);
      const world = geographicToEcef({
        longitude: geographic[0],
        latitude: geographic[1],
        height: geographic[2],
      });
      return createPreparedPointData({
        pointCount: 1,
        sourceCoordinates: new Float64Array([10.005, 20.005, 150]),
        geographicCoordinates: geographic,
        worldCoordinates: new Float64Array([world.x, world.y, world.z]),
      });
    },
  });
  const grid = await createSyntheticVerticalGrid({
    latitudeOrigin: 20,
    longitudeOrigin: 10,
    latitudeStep: 0.01,
    longitudeStep: 0.01,
  });
  const core = new CopcStreamingCore({
    url: "memory://regional-geoid.copc.laz",
    backend: source.backend,
    heightOffsetMeters: 5,
    verticalTransform: grid,
    streaming: {
      maxNodes: 8,
      maxDepth: 0,
      maxRenderDistanceMeters: 12_000,
      maxScreenSpaceError: 8,
      maxPointsPerBatch: 1,
    },
  });

  await core.load();
  const result = await core.updateView(
    createView({ viewDistanceMeters: 12_000 }),
  );
  assert.ok(result.selectedNodeKeys.includes(ROOT_KEY));
  assert.ok(result.loadedNodePoints.has(ROOT_KEY));
  assert.equal(
    core.getCachedPreparedPointData(ROOT_KEY).geographic.coordinates[2],
    180,
  );
  core.destroy();
});

test("a plain project-owned view drives hierarchy query and deterministic selection", async () => {
  const source = createSourceFactory();
  const controller = createController(source.backend);
  const progress = [];

  await controller.load();
  const result = await controller.updateView(createView(), (entry) =>
    progress.push(entry),
  );

  assert.deepEqual(result.selectedNodeKeys, [ROOT_KEY]);
  assert.deepEqual(controller.getCurrentSelection(), [ROOT_KEY]);
  assert.equal(progress.length, 2);
  assert.deepEqual(progress[0].selectedNodeKeys, [ROOT_KEY]);
  assert.deepEqual(
    progress[1].loadedNodePoints.get(ROOT_KEY).coordinates,
    new Float64Array([10.005, 20.005, 150]),
  );
  const prepared = controller.getCachedPreparedPointData(ROOT_KEY);
  assert.equal(prepared.source.coordinateSystem, "copc-source");
  assert.equal(prepared.geographic.coordinateSystem, "wgs84-geographic");
  assert.equal(prepared.world.coordinateSystem, "wgs84-ecef-meters");
  assert.deepEqual(prepared.statistics.elevation, { min: 150, max: 150 });
  assert.equal(controller.getPointCacheDiagnostics().cachedNodeCount, 1);
});

test("direct core updateView calls sample camera motion without adapter observations", async () => {
  const source = createSourceFactory();
  const controller = createController(source.backend);
  await controller.load();

  await controller.updateView(
    createView({ viewFrustum: createMotionFrustum(0) }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await controller.updateView(
    createView({ viewFrustum: createMotionFrustum(10) }),
  );

  const { performance } = controller.getSnapshot();
  assert.ok(performance.motionPredictedHorizontalDisplacementDegrees > 0);
  assert.ok(performance.motionHorizontalAngularVelocityDegreesPerSecond > 0);
  assert.equal(performance.motionSampledMovementCount, 1);
  controller.destroy();
});

test("predictive prefetch caches offscreen points without selecting them and reuses them on entry", async () => {
  const nodes = createPrefetchTestHierarchy();
  const observedPerformanceEvents = [];
  let performanceObserver;
  let prefetchLoadCount = 0;
  const metadata = {
    pointCount: nodes.reduce((total, node) => total + node.pointCount, 0),
    bounds: {
      minX: -0.004,
      minY: -0.004,
      minZ: 0,
      maxX: 0.004,
      maxY: 0.004,
      maxZ: 0.008,
    },
    cube: {
      minX: -0.004,
      minY: -0.004,
      minZ: 0,
      maxX: 0.004,
      maxY: 0.004,
      maxZ: 0.008,
    },
    spacing: 1000,
  };
  const core = new CopcStreamingCore({
    url: "memory://predictive-prefetch.copc.laz",
    backend: {
      async open(source) {
        return {
          source,
          getMetadata: () => metadata,
          getRootHierarchyPage: () => ({
            key: ROOT_KEY,
            pageOffset: 0,
            pageLength: 32,
          }),
          setPerformanceObserver(observer) {
            performanceObserver = observer
              ? (event) => {
                  observedPerformanceEvents.push(event);
                  observer(event);
                }
              : undefined;
          },
          async loadHierarchyPage(_page, options) {
            const observer =
              options?.performanceObserver === undefined
                ? performanceObserver
                : options.performanceObserver;
            observer?.({ stage: "rangeFetch", durationMs: 7, bytes: 32 });
            return { nodes, pages: [] };
          },
          async loadPreparedPointData(node, _fields, options = {}) {
            if (options.performanceObserver === null) prefetchLoadCount += 1;
            const observer =
              options.performanceObserver === undefined
                ? performanceObserver
                : options.performanceObserver;
            observer?.({
              stage: "rangeFetch",
              durationMs: 7,
              bytes: node.pointDataLength,
            });
            observer?.({ stage: "decode", durationMs: 5, nodeKey: node.key });
            observer?.({
              stage: "pointPreparation",
              durationMs: 3,
              nodeKey: node.key,
            });
            const coordinates = new Float64Array([
              metadata.cube.minX + ((node.x + 0.5) * 0.008) / 2 ** node.level,
              metadata.cube.minY + ((node.y + 0.5) * 0.008) / 2 ** node.level,
              metadata.cube.minZ + ((node.z + 0.5) * 0.008) / 2 ** node.level,
            ]);
            const geographic = new Float64Array(coordinates);
            const worldPoint = geographicToEcef({
              longitude: geographic[0],
              latitude: geographic[1],
              height: geographic[2],
            });
            return createPreparedPointData({
              pointCount: 1,
              sourceCoordinates: coordinates,
              geographicCoordinates: geographic,
              worldCoordinates: new Float64Array([
                worldPoint.x,
                worldPoint.y,
                worldPoint.z,
              ]),
            });
          },
        };
      },
    },
    maxPointCacheBytes: 2 * 1024 * 1024,
    streaming: {
      maxNodes: 64,
      maxDepth: 2,
      maxRenderedPoints: 1000,
      maxConcurrentNodeLoads: 4,
      maxScreenSpaceError: 1,
      maxRenderDistanceMeters: 12_000,
      predictivePrefetch: true,
    },
  });

  await core.load();
  await core.updateView(createEcefNadirView(0));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const currentView = createEcefNadirView(5);
  const currentResult = await core.updateView(currentView);
  const observedEventCountAfterCurrentView = observedPerformanceEvents.length;
  const selectedBeforePrefetch = core.getCurrentSelection();

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (core.getSnapshot().predictivePrefetch.completedNodeCount > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const prefetchedDiagnostics = core.getSnapshot().predictivePrefetch;
  assert.ok(
    prefetchedDiagnostics.completedNodeCount > 0,
    JSON.stringify({
      prefetchedDiagnostics,
      motion: core.getSnapshot().performance.motionLive,
      selectedCount: selectedBeforePrefetch.length,
      currentResultCount: currentResult.loadedNodePoints.size,
    }),
  );
  assert.ok(prefetchLoadCount > 0);
  assert.equal(
    observedPerformanceEvents.length,
    observedEventCountAfterCurrentView,
  );
  assert.equal(prefetchedDiagnostics.activeNodeCount, 0);
  assert.equal(prefetchedDiagnostics.queuedNodeCount, 0);
  assert.ok(
    prefetchedDiagnostics.pointRangeRequestCount <=
      prefetchedDiagnostics.completedNodeCount,
  );
  assert.ok(prefetchedDiagnostics.pointRangeBytesRequested <= 8 * 1024 * 1024);
  assert.ok(prefetchedDiagnostics.hierarchyPageVisitCount <= 1);

  const speculativeKeys = nodes
    .map((node) => node.key)
    .filter(
      (nodeKey) =>
        core.getCachedPreparedPointData(nodeKey) !== undefined &&
        !selectedBeforePrefetch.includes(nodeKey),
    );
  assert.ok(speculativeKeys.length > 0);
  assert.deepEqual(core.getCurrentSelection(), selectedBeforePrefetch);
  assert.equal(
    speculativeKeys.some((nodeKey) =>
      currentResult.loadedNodePoints.has(nodeKey),
    ),
    false,
  );

  const liveMotion = core.getSnapshot().performance.motionLive;
  const predictedView = createPredictedStreamingView(currentView, liveMotion);
  assert.ok(predictedView);
  const previousUsefulHits =
    core.getPointCacheDiagnostics().prefetchUsefulHitCount;
  const nextResult = await core.updateView(predictedView);
  assert.ok(
    speculativeKeys.some((nodeKey) =>
      nextResult.selectedNodeKeys.includes(nodeKey),
    ),
  );
  assert.ok(
    core.getPointCacheDiagnostics().prefetchUsefulHitCount > previousUsefulHits,
  );
  assert.ok(core.getSnapshot().performance.activeRenderedPointCount <= 1000);

  core.destroy();
});

test("predictive prefetch tracks overlapping stale point loads until each settles", async () => {
  const nodes = createPrefetchTestHierarchy();
  const metadata = {
    pointCount: nodes.reduce((total, node) => total + node.pointCount, 0),
    bounds: {
      minX: -0.004,
      minY: -0.004,
      minZ: 0,
      maxX: 0.004,
      maxY: 0.004,
      maxZ: 0.008,
    },
    cube: {
      minX: -0.004,
      minY: -0.004,
      minZ: 0,
      maxX: 0.004,
      maxY: 0.004,
      maxZ: 0.008,
    },
    spacing: 1000,
  };
  const heldPrefetchLoads = [];
  const createPrepared = (node) => {
    const coordinates = new Float64Array([
      metadata.cube.minX + ((node.x + 0.5) * 0.008) / 2 ** node.level,
      metadata.cube.minY + ((node.y + 0.5) * 0.008) / 2 ** node.level,
      metadata.cube.minZ + ((node.z + 0.5) * 0.008) / 2 ** node.level,
    ]);
    const worldPoint = geographicToEcef({
      longitude: coordinates[0],
      latitude: coordinates[1],
      height: coordinates[2],
    });
    return createPreparedPointData({
      pointCount: 1,
      sourceCoordinates: coordinates,
      geographicCoordinates: new Float64Array(coordinates),
      worldCoordinates: new Float64Array([
        worldPoint.x,
        worldPoint.y,
        worldPoint.z,
      ]),
    });
  };
  const core = new CopcStreamingCore({
    url: "memory://predictive-prefetch-overlap.copc.laz",
    backend: {
      async open(source) {
        return {
          source,
          getMetadata: () => metadata,
          getRootHierarchyPage: () => ({
            key: ROOT_KEY,
            pageOffset: 0,
            pageLength: 32,
          }),
          async loadHierarchyPage() {
            return { nodes, pages: [] };
          },
          loadPreparedPointData(node, _fields, options = {}) {
            if (options.performanceObserver !== null)
              return Promise.resolve(createPrepared(node));
            return new Promise((resolve) => {
              heldPrefetchLoads.push({
                nodeKey: node.key,
                resolve: () => resolve(createPrepared(node)),
              });
            });
          },
        };
      },
    },
    maxPointCacheBytes: 2 * 1024 * 1024,
    streaming: {
      maxNodes: 64,
      maxDepth: 2,
      maxRenderedPoints: 1000,
      maxConcurrentNodeLoads: 8,
      maxScreenSpaceError: 1,
      maxRenderDistanceMeters: 12_000,
      predictivePrefetch: true,
    },
  });
  const waitFor = async (predicate, label) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`Timed out waiting for ${label}`);
  };

  await core.load();
  await core.updateView(createEcefNadirView(0));
  core.observeCameraMotion(createEcefNadirView(0), 1000);
  core.observeCameraMotion(createEcefNadirView(5), 1100);
  const state = core.streamingState;
  const selectedKeys = new Set(core.getCurrentSelection());
  const availablePrefetchKeys = nodes
    .map((node) => node.key)
    .filter(
      (nodeKey) =>
        !selectedKeys.has(nodeKey) && !core.getCachedPreparedPointData(nodeKey),
    );
  assert.ok(availablePrefetchKeys.length >= 2);

  const firstController = new AbortController();
  core.predictivePrefetchGeneration = 1;
  core.predictivePrefetchController = firstController;
  void core.runPredictivePrefetch({
    generation: 1,
    controller: firstController,
    state,
    queue: [availablePrefetchKeys[0]],
  });
  await waitFor(
    () => heldPrefetchLoads.length >= 1,
    "the first speculative load",
  );

  core.supersedePredictivePrefetch();
  const secondController = new AbortController();
  const secondGeneration = core.predictivePrefetchGeneration;
  core.predictivePrefetchController = secondController;
  void core.runPredictivePrefetch({
    generation: secondGeneration,
    controller: secondController,
    state,
    queue: [availablePrefetchKeys[1]],
  });
  await waitFor(
    () => heldPrefetchLoads.length >= 2,
    "the next speculative load",
  );
  assert.ok(core.getSnapshot().predictivePrefetch.activeNodeCount >= 2);

  heldPrefetchLoads[0].resolve();
  await waitFor(
    () => core.getSnapshot().predictivePrefetch.activeNodeCount === 1,
    "the older cancelled load to settle without clearing the newer active load",
  );

  let releasedCount = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    while (releasedCount < heldPrefetchLoads.length) {
      heldPrefetchLoads[releasedCount++].resolve();
    }
    if (core.getSnapshot().predictivePrefetch.activeNodeCount === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(core.getSnapshot().predictivePrefetch.activeNodeCount, 0);
  core.destroy();
});

test("the shared core derives its current distance from perspective footprint", async () => {
  const source = createSourceFactory();
  const controller = createController(source.backend);
  await controller.load();

  const longitude = 10.005;
  const latitude = 20.005;
  const longitudeRadians = (longitude * Math.PI) / 180;
  const latitudeRadians = (latitude * Math.PI) / 180;
  const localUp = {
    x: Math.cos(latitudeRadians) * Math.cos(longitudeRadians),
    y: Math.cos(latitudeRadians) * Math.sin(longitudeRadians),
    z: Math.sin(latitudeRadians),
  };
  const position = geographicToEcef({ longitude, latitude, height: 100 });
  const viewFrustum = createPerspectiveViewFrustum({
    position,
    direction: { x: -localUp.x, y: -localUp.y, z: -localUp.z },
    up: {
      x: -Math.sin(latitudeRadians) * Math.cos(longitudeRadians),
      y: -Math.sin(latitudeRadians) * Math.sin(longitudeRadians),
      z: Math.cos(latitudeRadians),
    },
    right: {
      x: -Math.sin(longitudeRadians),
      y: Math.cos(longitudeRadians),
      z: 0,
    },
    verticalFovRadians: Math.PI / 6,
    aspectRatio: 16 / 9,
    nearMeters: 0.1,
    farMeters: 100_000,
  });

  await controller.updateView(createView({ height: 100, viewFrustum }));
  const currentView = controller.getCurrentView();

  assert.ok(currentView.viewDistanceMeters < 500);
  assert.ok(currentView.viewDistanceMeters < 2_000);
  assert.ok(currentView.viewDistanceDiagnostics.visibleFootprintMeters > 0);
  assert.equal(
    controller.getSnapshot().viewDistance.effectiveDistanceMeters,
    currentView.viewDistanceMeters,
  );
});

test("streaming cache consumes a backend prepared result without a TypeScript transform pass", async () => {
  const source = createSourceFactory({ prepared: true });
  const controller = createController(source.backend, { decoder: undefined });

  await controller.load();
  await controller.updateView(createView());

  const prepared = controller.getCachedPreparedPointData(ROOT_KEY);
  assert.deepEqual([...prepared.source.coordinates], [10.005, 20.005, 150]);
  assert.deepEqual([...prepared.world.coordinates], [1, 2, 3]);
  assert.equal(controller.getSnapshot().performance.decodeDurationMs, 5);
  assert.equal(
    controller.getSnapshot().performance.pointPreparationDurationMs,
    3,
  );
  assert.equal(controller.getSnapshot().performance.crsTransformDurationMs, 0);
});

test("streaming core applies height offset to prepared data from custom backends", async () => {
  const source = createSourceFactory({ prepared: true });
  const controller = createController(source.backend, {
    decoder: undefined,
    heightOffsetMeters: 25,
  });

  await controller.load();
  await controller.updateView(createView());

  const prepared = controller.getCachedPreparedPointData(ROOT_KEY);
  const expectedWorld = geographicToEcef({
    longitude: 10.005,
    latitude: 20.005,
    height: 175,
  });
  assert.deepEqual([...prepared.source.coordinates], [10.005, 20.005, 150]);
  assert.deepEqual([...prepared.geographic.coordinates], [10.005, 20.005, 175]);
  assert.deepEqual(
    [...prepared.world.coordinates],
    [expectedWorld.x, expectedWorld.y, expectedWorld.z],
  );
  assert.deepEqual(prepared.statistics.elevation, { min: 175, max: 175 });
});

test("streaming core does not apply an offset already included in prepared data", async () => {
  const expectedWorld = geographicToEcef({
    longitude: 10.005,
    latitude: 20.005,
    height: 175,
  });
  const source = createSourceFactory({
    prepared: true,
    preparedHeightOffsetMeters: 25,
    onPreparedPointLoad() {
      return createPreparedPointData({
        pointCount: 1,
        sourceCoordinates: new Float64Array([10.005, 20.005, 150]),
        geographicCoordinates: new Float64Array([10.005, 20.005, 175]),
        worldCoordinates: new Float64Array([
          expectedWorld.x,
          expectedWorld.y,
          expectedWorld.z,
        ]),
      });
    },
  });
  const controller = createController(source.backend, {
    decoder: undefined,
    heightOffsetMeters: 25,
  });

  await controller.load();
  await controller.updateView(createView());

  const prepared = controller.getCachedPreparedPointData(ROOT_KEY);
  assert.deepEqual([...prepared.source.coordinates], [10.005, 20.005, 150]);
  assert.deepEqual([...prepared.geographic.coordinates], [10.005, 20.005, 175]);
  assert.deepEqual(
    [...prepared.world.coordinates],
    [expectedWorld.x, expectedWorld.y, expectedWorld.z],
  );
});

test("view updates refresh the core hierarchy used by point loading", async () => {
  const source = createSourceFactory({ paged: true });
  const controller = createController(source.backend, {
    streaming: {
      maxDepth: 1,
    },
  });

  await controller.load();
  assert.equal(controller.getHierarchyDiagnostics().loadedEntryCount, 2);

  await controller.updateView(createView());

  assert.equal(controller.getHierarchyDiagnostics().loadedEntryCount, 3);
  assert.equal(controller.getSnapshot().performance.rangeFetchDurationMs, 7);
  assert.equal(controller.getSnapshot().performance.rangeFetchBytes, 10);
  for (const nodeKey of controller.getCurrentSelection()) {
    assert.ok(controller.getCachedPointBuffer(nodeKey));
  }
});

test("the same view produces the same frontier and increments updates once per generation", async () => {
  const source = createSourceFactory();
  const controller = createController(source.backend);
  const view = createView();

  await controller.load();
  const first = await controller.updateView(view);
  const second = await controller.updateView(view);

  assert.deepEqual(first.selectedNodeKeys, [ROOT_KEY]);
  assert.deepEqual(second.selectedNodeKeys, [ROOT_KEY]);
  assert.deepEqual(controller.getCurrentSelection(), [ROOT_KEY]);
  assert.equal(controller.getSnapshot().streamingUpdateCount, 2);
  assert.ok(controller.getPointCacheDiagnostics().hits >= 1);
});

test("a changed view invalidates stale streaming generations", async () => {
  let resolvePoints;
  let resolveDecodeStarted;
  const decodeStarted = new Promise((resolve) => {
    resolveDecodeStarted = resolve;
  });
  const source = createSourceFactory();
  const controller = createController(source.backend, {
    decoder: {
      async decode() {
        resolveDecodeStarted();
        return new Promise((resolve) => {
          resolvePoints = resolve;
        });
      },
    },
  });

  await controller.load();
  const firstUpdate = controller.updateView(createView({ height: 150 }));
  await decodeStarted;
  const secondUpdate = controller.updateView(createView({ height: 250 }));
  resolvePoints(createPointBuffer(250));

  const [stale, current] = await Promise.all([firstUpdate, secondUpdate]);
  assert.equal(stale, undefined);
  assert.deepEqual(current.selectedNodeKeys, [ROOT_KEY]);
  assert.equal(controller.getSnapshot().streamingUpdateCount, 1);
  const currentView = controller.getCurrentView();
  const { viewDistanceDiagnostics, ...plainCurrentView } = currentView;
  assert.deepEqual(plainCurrentView, createView({ height: 250 }));
  assert.equal(viewDistanceDiagnostics.transition, "fallback");
});

test("experimental E does not retain points prepared for a stale view generation", async () => {
  let resolvePoints;
  let resolveDecodeStarted;
  const decodeStarted = new Promise((resolve) => {
    resolveDecodeStarted = resolve;
  });
  const source = createSourceFactory();
  const core = createExperimentalCompactEStreamingCore({
    url: "memory://compact-e-stale-generation.copc.laz",
    backend: source.backend,
    decoder: {
      async decode() {
        resolveDecodeStarted();
        return new Promise((resolve) => {
          resolvePoints = resolve;
        });
      },
    },
    streaming: {
      maxNodes: 8,
      maxDepth: 0,
      maxRenderDistanceMeters: 12_000,
      maxScreenSpaceError: 8,
      maxPointsPerBatch: 1,
    },
  });

  await core.load();
  const staleUpdate = core.updateView(createView({ height: 150 }));
  await decodeStarted;
  const currentUpdate = core.updateView(createView({ height: 250 }));
  resolvePoints(createPointBuffer(250));

  const [stale, current] = await Promise.all([staleUpdate, currentUpdate]);
  assert.equal(stale, undefined);
  assert.deepEqual(current.selectedNodeKeys, [ROOT_KEY]);
  const prepared = core.getCachedPreparedPointData(ROOT_KEY);
  const compactHeight = getCompactEPreparedHeightBuffer(prepared);
  assert.equal(prepared.geographic.coordinates[2], 250);
  assert.equal(compactHeight[0], 250);
  const expectedWorld = geographicToEcef({
    longitude: 10.005,
    latitude: 20.005,
    height: 250,
  });
  assert.deepEqual(
    [...prepared.world.coordinates],
    [expectedWorld.x, expectedWorld.y, expectedWorld.z],
  );
  assert.equal(core.getSnapshot().streamingUpdateCount, 1);
  core.destroy();
});

test("invalidating with a superseding view aborts obsolete point work immediately", async () => {
  let resolvePointStarted;
  const pointStarted = new Promise((resolve) => {
    resolvePointStarted = resolve;
  });
  let pointSignal;
  const source = createSourceFactory({
    prepared: true,
    onPreparedPointLoad(_node, _fields, options) {
      pointSignal = options.signal;
      resolvePointStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    },
  });
  const controller = createController(source.backend, { decoder: undefined });

  await controller.load();
  const pointUpdate = controller.updateView(createView());
  await pointStarted;
  const farCameraPosition = geographicToEcef({
    longitude: 10.005,
    latitude: 20.005,
    height: 100_000,
  });
  const directionLength = Math.hypot(
    farCameraPosition.x,
    farCameraPosition.y,
    farCameraPosition.z,
  );
  const longitudeRadians = (10.005 * Math.PI) / 180;
  const latitudeRadians = (20.005 * Math.PI) / 180;
  const farView = createView({
    height: 100_000,
    viewFrustum: createPerspectiveViewFrustum({
      position: farCameraPosition,
      direction: {
        x: farCameraPosition.x / directionLength,
        y: farCameraPosition.y / directionLength,
        z: farCameraPosition.z / directionLength,
      },
      up: {
        x: -Math.sin(latitudeRadians) * Math.cos(longitudeRadians),
        y: -Math.sin(latitudeRadians) * Math.sin(longitudeRadians),
        z: Math.cos(latitudeRadians),
      },
      right: {
        x: -Math.sin(longitudeRadians),
        y: Math.cos(longitudeRadians),
        z: 0,
      },
      verticalFovRadians: Math.PI / 3,
      aspectRatio: 1,
      nearMeters: 1,
      farMeters: 6_000,
    }),
  });
  controller.invalidateView(farView);

  assert.equal(pointSignal.aborted, true);
  assert.equal(pointSignal.reason, "superseded");
  assert.equal(await pointUpdate, undefined);
  assert.equal(controller.getSnapshot().streamingUpdateCount, 0);
});

test("unload aborts the source lifecycle and pending point work without surfacing an error", async () => {
  let lifecycleSignal;
  let resolvePointStarted;
  const pointStarted = new Promise((resolve) => {
    resolvePointStarted = resolve;
  });
  let pointSignal;
  const source = createSourceFactory({
    prepared: true,
    onPreparedPointLoad(_node, _fields, options) {
      pointSignal = options.signal;
      resolvePointStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    },
  });
  const backend = {
    async open(url, options) {
      lifecycleSignal = options.signal;
      return source.backend.open(url, options);
    },
  };
  const controller = createController(backend, { decoder: undefined });

  await controller.load();
  const update = controller.updateView(createView());
  await pointStarted;
  controller.unload();

  assert.equal(await update, undefined);
  assert.equal(lifecycleSignal.aborted, true);
  assert.equal(lifecycleSignal.reason, "lifecycle");
  assert.equal(pointSignal.aborted, true);
  assert.equal(pointSignal.reason, "lifecycle");
  assert.equal(controller.getSnapshot().lifecycle, "idle");
});

test("unload isolates performance metrics from a stale non-cancellable point load", async () => {
  let resolvePoints;
  let resolveDecodeStarted;
  let stalePerformanceObserver;
  const decodeStarted = new Promise((resolve) => {
    resolveDecodeStarted = resolve;
  });
  const source = createSourceFactory({
    onPerformanceObserver: (observer) => {
      stalePerformanceObserver = observer;
    },
  });
  const controller = createController(source.backend, {
    decoder: {
      async decode() {
        resolveDecodeStarted();
        return new Promise((resolve) => {
          resolvePoints = resolve;
        });
      },
    },
  });

  await controller.load();
  const update = controller.updateView(createView());
  await decodeStarted;

  controller.unload();
  stalePerformanceObserver({
    stage: "decode",
    durationMs: 17,
    bytes: 256,
  });
  resolvePoints(createPointBuffer());

  assert.equal(await update, undefined);
  assert.equal(controller.getSnapshot().performance.decodeDurationMs, 0);
  assert.equal(controller.getSnapshot().performance.crsTransformDurationMs, 0);
});

test("same-position views with different directions produce different hierarchy queries", async () => {
  const source = createSourceFactory();
  const controller = createController(source.backend);
  await controller.load();

  const position = geographicToEcef({
    longitude: 10.005,
    latitude: 20.005,
    height: 5000,
  });
  const makeFrustum = (direction) =>
    createPerspectiveViewFrustum({
      position,
      direction,
      up: { x: 0, y: 0, z: 1 },
      right: { x: 1, y: 0, z: 0 },
      verticalFovRadians: Math.PI / 3,
      aspectRatio: 1,
      nearMeters: 1,
      farMeters: 6000,
    });
  const firstView = createView({
    viewFrustum: makeFrustum({ x: 0, y: 1, z: 0 }),
  });
  const secondView = createView({
    viewFrustum: makeFrustum({ x: 0, y: -1, z: 0 }),
  });

  const firstQuery = controller.getHierarchyQuery(firstView);
  const secondQuery = controller.getHierarchyQuery(secondView);

  assert.equal(firstQuery.bounds.coordinateSystem, "copc-source");
  assert.equal(secondQuery.bounds.coordinateSystem, "copc-source");
  assert.notDeepEqual(firstQuery.bounds, secondQuery.bounds);
});

test("unload, reload, and destroy clean up source and cache state", async () => {
  const source = createSourceFactory();
  const controller = createController(source.backend);

  await controller.load();
  await controller.updateView(createView());
  assert.equal(controller.getPointCacheDiagnostics().cachedNodeCount, 1);

  controller.unload();
  assert.equal(source.destroyCount, 1);
  assert.equal(controller.getSnapshot().lifecycle, "idle");
  assert.equal(controller.getPointCacheDiagnostics().cachedNodeCount, 0);

  await controller.reload();
  assert.equal(source.openCount, 2);
  assert.equal(controller.getSnapshot().lifecycle, "ready");

  controller.destroy();
  controller.destroy();
  assert.equal(source.destroyCount, 2);
  assert.equal(controller.getSnapshot().lifecycle, "destroyed");
});
