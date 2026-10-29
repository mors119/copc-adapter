import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  CopcStaleSourceError,
  HierarchyLoader,
  createCopcContext,
  createCopcPointFieldSelection,
  loadGtxGeoidGrid,
  transformPointBufferToPreparedPointData,
} from "../../../core.ts";

const GEOGRAPHIC_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
const ORTHOMETRIC_WKT =
  'COMPD_CS["WGS 84 + Local orthometric height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],VERT_CS["Local orthometric height",VERT_DATUM["Local vertical datum",2005],UNIT["metre",1],AXIS["Gravity-related height",UP]]]';
const CRS_FIXTURES = JSON.parse(
  readFileSync(
    new URL("../../../../crates/crs-audit/src/fixtures.json", import.meta.url),
    "utf8",
  ),
);

function createMetadata({
  wkt = GEOGRAPHIC_WKT,
  bounds = {
    minX: -180,
    minY: -90,
    minZ: -20_000,
    maxX: 180,
    maxY: 90,
    maxZ: 200_000,
  },
} = {}) {
  return {
    pointCount: 3,
    wkt,
    bounds,
    cube: bounds,
    scale: { x: 0.01, y: 0.01, z: 0.01 },
    offset: { x: 0, y: 0, z: 0 },
    crsWktProvenance: { selected: "vlr", available: ["vlr"], conflicting: false },
  };
}

function createPoints(fields, extraDimensions = []) {
  const attributes = {};
  if (fields.has("intensity")) {
    attributes.intensity = new Uint16Array([11, 22, 33]);
  }
  if (fields.has("classification")) {
    attributes.classification = new Uint8Array([2, 3, 4]);
  }
  if (fields.has("rgb")) {
    attributes.red = new Uint16Array([100, 200, 300]);
    attributes.green = new Uint16Array([101, 201, 301]);
    attributes.blue = new Uint16Array([102, 202, 302]);
  }
  if (extraDimensions.length > 0) {
    attributes.extraDimensions = Object.fromEntries(
      extraDimensions.map((name) => [
        name,
        new BigUint64Array([9_007_199_254_740_995n, 9_007_199_254_740_996n, 9_007_199_254_740_997n]),
      ]),
    );
  }
  return {
    pointCount: 3,
    coordinates: new Float64Array([
      -179.8, 89.2, -10_000,
      179.9, 89.9, 200_000,
      0, 89.5, 12_000,
    ]),
    attributes,
  };
}

const rootPage = { key: "0-0-0-0", pageOffset: 100, pageLength: 32 };
const childPage = { key: "1-1-1-1", pageOffset: 200, pageLength: 32 };
const rootNode = {
  key: "0-0-0-0",
  level: 0,
  x: 0,
  y: 0,
  z: 0,
  pointCount: 3,
  pointDataOffset: 1_000,
  pointDataLength: 48,
};

function createBackend({
  metadata = createMetadata(),
  loadPointDataBuffer,
  loadPreparedPointData,
  preparedHeightOffsetMeters,
  loadHierarchyPage,
} = {}) {
  const calls = { point: 0, hierarchy: [], destroyed: 0, cancelled: 0 };
  return {
    calls,
    async open() {
      return {
        source: "memory://source-api-test",
        ...(preparedHeightOffsetMeters === undefined
          ? {}
          : { preparedHeightOffsetMeters }),
        getMetadata: () => metadata,
        getRootHierarchyPage: () => rootPage,
        async loadHierarchyPage(page, options) {
          calls.hierarchy.push(page.key);
          if (loadHierarchyPage) return loadHierarchyPage(page, options);
          if (page.key === rootPage.key) {
            return { nodes: [rootNode], pages: [childPage] };
          }
          if (page.key === childPage.key) {
            return {
              nodes: [{
                key: "1-1-1-1",
                level: 1,
                x: 1,
                y: 1,
                z: 1,
                pointCount: 1,
                pointDataOffset: 2_000,
                pointDataLength: 12,
              }],
              pages: [],
            };
          }
          throw new Error(`Unexpected page ${page.key}`);
        },
        async loadPointDataView() {
          throw new Error("The test backend uses its decoded buffer path");
        },
        async loadPointDataBuffer(node, fields, options) {
          calls.point += 1;
          if (loadPointDataBuffer) {
            return loadPointDataBuffer(node, fields, options);
          }
          return createPoints(fields, options.extraDimensions);
        },
        ...(loadPreparedPointData
          ? {
              async loadPreparedPointData(node, fields, options) {
                calls.point += 1;
                return loadPreparedPointData(node, fields, options);
              },
            }
          : {}),
        cancelPendingPointJobs() {
          calls.cancelled += 1;
        },
        destroy() {
          calls.destroyed += 1;
        },
      };
    },
  };
}

test("public Core opens a lazy hierarchy and returns prepared ECEF plus exact requested fields", async () => {
  const backend = createBackend();
  const source = await createCopcContext("memory://input", backend);
  const hierarchy = new HierarchyLoader(source, source.getMetadata().cube);

  try {
    assert.throws(() => {
      source.getMetadata().cube.minX = -999;
    }, TypeError);
    assert.equal(source.getMetadata().cube.minX, -180);
    const root = await hierarchy.loadRoot();
    assert.equal(root.nodes[0].childrenComplete, false);
    assert.deepEqual(backend.calls.hierarchy, ["0-0-0-0"]);

    const expanded = await hierarchy.query(
      { bounds: source.getMetadata().cube, maxLevel: 1 },
      { maxPages: 1 },
    );
    assert.equal(expanded.nodes.find((node) => node.key === "0-0-0-0").childrenComplete, true);
    assert.deepEqual(backend.calls.hierarchy, ["0-0-0-0", "1-1-1-1"]);

    const node = expanded.nodes.find((entry) => entry.key === "0-0-0-0");
    const fields = createCopcPointFieldSelection(["position", "intensity", "rgb"]);
    const result = await source.loadPreparedNodeData(node, fields, {
      extraDimensions: ["track_id"],
    });

    assert.ok(result.pointData.world.coordinates instanceof Float64Array);
    assert.equal(result.pointData.world.coordinateSystem, "wgs84-ecef-meters");
    assert.deepEqual([...result.availableFields].sort(), ["intensity", "position", "rgb"]);
    assert.deepEqual(result.availableExtraDimensions, ["track_id"]);
    assert.equal(result.pointData.attributes.extraDimensions.track_id[0], 9_007_199_254_740_995n);
    assert.equal(result.sourceGeneration, source.sourceGeneration);
    assert.equal(result.transformGeneration, source.transformGeneration);
    assert.equal(result.ecefBoundsKind, "decoded-point-content");
    assert.equal(result.ecefBounds.coordinateSystem, "wgs84-ecef-meters");
    for (let index = 0; index < result.pointData.world.coordinates.length; index += 3) {
      const [x, y, z] = result.pointData.world.coordinates.slice(index, index + 3);
      assert.ok(x >= result.ecefBounds.minX && x <= result.ecefBounds.maxX);
      assert.ok(y >= result.ecefBounds.minY && y <= result.ecefBounds.maxY);
      assert.ok(z >= result.ecefBounds.minZ && z <= result.ecefBounds.maxZ);
    }
    assert.deepEqual(source.getNodeCellBounds("1-1-1-1"), {
      minX: 0,
      minY: 0,
      minZ: 90_000,
      maxX: 180,
      maxY: 90,
      maxZ: 200_000,
    });

    const retainedCoordinate = result.pointData.world.coordinates[0];
    source.close();
    assert.equal(result.pointData.world.coordinates[0], retainedCoordinate);
    assert.equal(source.isCurrent(), false);
    assert.equal(backend.calls.destroyed, 1);
  } finally {
    source.close();
  }
});

test("source requests snapshot caller-owned nodes, fields, pages, and option arrays", async () => {
  let loadedNode;
  let loadedFields;
  let loadedExtraDimensions;
  let loadedPage;
  const backend = createBackend({
    loadHierarchyPage: async (page) => {
      loadedPage = { ...page };
      return { nodes: [rootNode], pages: [] };
    },
    loadPointDataBuffer: async (node, fields, options) => {
      loadedNode = { ...node };
      loadedFields = [...fields];
      loadedExtraDimensions = [...options.extraDimensions];
      return createPoints(fields, options.extraDimensions);
    },
  });
  const source = await createCopcContext("memory://snapshots", backend);

  try {
    const page = { ...rootPage };
    const pageRequest = source.loadHierarchyPage(page);
    page.key = "1-0-0-0";
    page.pageOffset = 999;
    await pageRequest;
    assert.equal(loadedPage.key, rootPage.key);
    assert.equal(loadedPage.pageOffset, rootPage.pageOffset);

    const node = { ...rootNode };
    const fields = createCopcPointFieldSelection(["position"]);
    const extraDimensions = ["track_id"];
    const pointRequest = source.loadPreparedNodeData(node, fields, {
      extraDimensions,
    });
    node.pointCount = 9;
    fields.add("intensity");
    extraDimensions[0] = "other_id";
    const result = await pointRequest;

    assert.equal(loadedNode.pointCount, rootNode.pointCount);
    assert.deepEqual(loadedFields, ["position"]);
    assert.deepEqual(loadedExtraDimensions, ["track_id"]);
    assert.equal(result.node.pointCount, rootNode.pointCount);
    assert.deepEqual(result.availableExtraDimensions, ["track_id"]);
  } finally {
    source.close();
  }
});

test("source requests reject unsupported fields and malformed Extra Dimension names", async () => {
  const backend = createBackend();
  const source = await createCopcContext("memory://invalid-fields", backend);
  try {
    await assert.rejects(
      source.loadPreparedNodeData(
        rootNode,
        new Set(["position", "gps-time"]),
      ),
      /Unsupported COPC point field: gps-time/,
    );
    await assert.rejects(
      source.loadPreparedNodeData(
        rootNode,
        createCopcPointFieldSelection(["position"]),
        { extraDimensions: ["  "] },
      ),
      /Extra Dimension names must be non-empty strings/,
    );
    assert.equal(backend.calls.point, 0);
  } finally {
    source.close();
  }
});

test("aborted and stale point operations reject without cancelling another source", async () => {
  const finishPointLoads = [];
  const backend = createBackend({
    loadPointDataBuffer: () => new Promise((resolve) => finishPointLoads.push(resolve)),
  });
  const first = await createCopcContext("memory://first", backend);
  const secondBackend = createBackend();
  const second = await createCopcContext("memory://second", secondBackend, {
    heightOffsetMeters: 4,
  });
  const fields = createCopcPointFieldSelection(["position"]);
  const controller = new AbortController();
  controller.abort("before-start");
  await assert.rejects(
    first.loadPreparedNodeData(rootNode, fields, { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(backend.calls.point, 0);

  const duringAbort = new AbortController();
  const pendingAbort = first.loadPreparedNodeData(rootNode, fields, {
    signal: duringAbort.signal,
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(backend.calls.point, 1);
  duringAbort.abort("during-read");
  await assert.rejects(pendingAbort, { name: "AbortError" });
  finishPointLoads.shift()(createPoints(fields));

  const stalePending = first.loadPreparedNodeData(rootNode, fields);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(backend.calls.point, 2);
  first.close();
  await assert.rejects(stalePending, CopcStaleSourceError);
  finishPointLoads.shift()(createPoints(fields));

  const afterAbort = new AbortController();
  const nextGeneration = await second.loadPreparedNodeData(rootNode, fields, {
    signal: afterAbort.signal,
  });
  afterAbort.abort("after-completion");
  assert.notEqual(first.sourceGeneration, second.sourceGeneration);
  assert.equal(second.isCurrent(nextGeneration.sourceGeneration), true);
  assert.notEqual(
    first.transformPlan.identity.key,
    second.transformPlan.identity.key,
  );
  assert.equal(secondBackend.calls.destroyed, 0);
  second.close();
});

test("a caller can abort one lazy hierarchy request without affecting its source", async () => {
  let finishHierarchyRead;
  let backendSignal;
  const backend = createBackend({
    loadHierarchyPage: (_page, options) => {
      backendSignal = options.signal;
      return new Promise((resolve) => {
        finishHierarchyRead = resolve;
      });
    },
  });
  const source = await createCopcContext("memory://hierarchy-cancel", backend);
  const controller = new AbortController();
  try {
    const pending = source.loadHierarchyPage(childPage, {
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(backendSignal);
    controller.abort("page-no-longer-needed");
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(source.isCurrent(), true);
    assert.equal(backendSignal.aborted, true);
    finishHierarchyRead({ nodes: [], pages: [] });
  } finally {
    source.close();
  }
});

test("manual height offsets and a verified vertical grid are applied once to prepared backend output", async () => {
  const bytes = new ArrayBuffer(56);
  const view = new DataView(bytes);
  view.setFloat64(0, 0, false);
  view.setFloat64(8, 100, false);
  view.setFloat64(16, 1, false);
  view.setFloat64(24, 1, false);
  view.setInt32(32, 2, false);
  view.setInt32(36, 2, false);
  [10, 20, 30, 40].forEach((value, index) => view.setFloat32(40 + index * 4, value, false));
  const grid = await loadGtxGeoidGrid(bytes, {
    gridId: "context-api-grid",
    sourceVerticalCrs: "Local orthometric height",
    targetVerticalCrs: "EPSG:4979",
    horizontalCrs: "EPSG:4326",
    referenceEllipsoid: "WGS84",
    sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
    valueUnit: "metre",
    valueConvention: "ellipsoidal-minus-orthometric",
    noDataValue: null,
    sourceCoordinateEpoch: 2020,
    gridReferenceEpoch: 2020,
  });
  const metadata = createMetadata({
    wkt: ORTHOMETRIC_WKT,
    bounds: { minX: 100, minY: 0, minZ: 0, maxX: 101, maxY: 1, maxZ: 100 },
  });
  const points = {
    pointCount: 1,
    coordinates: new Float64Array([100.5, 0.5, 50]),
  };
  const backend = createBackend({
    metadata,
    preparedHeightOffsetMeters: 2,
    loadPreparedPointData: () =>
      transformPointBufferToPreparedPointData(metadata, points, 2),
  });
  const source = await createCopcContext("memory://grid", backend, {
    heightOffsetMeters: 5,
    verticalGrid: grid,
  });
  try {
    const result = await source.loadPreparedNodeData(
      { ...rootNode, pointCount: 1 },
      createCopcPointFieldSelection(["position"]),
    );
    assert.ok(Math.abs(result.pointData.geographic.coordinates[2] - 80) < 1e-9);
    assert.equal(result.transformPlan.verticalGrid.compatibility, "validated");
    assert.equal(result.transformPlan.manualHeightOffsetMeters, 5);
  } finally {
    source.close();
  }
});

test("projected source points produce conservative ECEF content bounds", async () => {
  const fixture = CRS_FIXTURES.fixtures.find(
    (entry) => entry.id === "epsg-5186-korean-central-belt-2010",
  );
  assert.ok(fixture, "projected CRS fixture must be checked in");
  const sourcePoints = fixture.points.slice(0, 3);
  const coordinates = new Float64Array(
    sourcePoints.flatMap(({ x, y, z }) => [x, y, z]),
  );
  const bounds = {
    minX: Math.min(...sourcePoints.map(({ x }) => x)),
    minY: Math.min(...sourcePoints.map(({ y }) => y)),
    minZ: Math.min(...sourcePoints.map(({ z }) => z)),
    maxX: Math.max(...sourcePoints.map(({ x }) => x)),
    maxY: Math.max(...sourcePoints.map(({ y }) => y)),
    maxZ: Math.max(...sourcePoints.map(({ z }) => z)),
  };
  const metadata = {
    ...createMetadata({ wkt: fixture.wkt, bounds }),
    pointCount: sourcePoints.length,
  };
  const backend = createBackend({
    metadata,
    loadPointDataBuffer: () => ({
      pointCount: sourcePoints.length,
      coordinates,
    }),
  });
  const source = await createCopcContext("memory://projected", backend);
  try {
    const result = await source.loadPreparedNodeData(
      { ...rootNode, pointCount: sourcePoints.length },
      createCopcPointFieldSelection(["position"]),
    );
    assert.equal(result.transformPlan.source.horizontalResolution, "wkt");
    assert.equal(result.transformPlan.provenance.sourceWkt, fixture.wkt);
    assert.ok(result.pointData.geographic.coordinates[0] > 126);
    assert.ok(result.pointData.geographic.coordinates[0] < 128);
    assert.ok(result.pointData.geographic.coordinates[1] > 37);
    assert.ok(result.pointData.geographic.coordinates[1] < 39);
    assert.ok(result.ecefBounds);
    assert.equal(result.ecefBoundsKind, "decoded-point-content");
    for (let index = 0; index < result.pointData.world.coordinates.length; index += 3) {
      const [x, y, z] = result.pointData.world.coordinates.slice(index, index + 3);
      assert.ok(x >= result.ecefBounds.minX && x <= result.ecefBounds.maxX);
      assert.ok(y >= result.ecefBounds.minY && y <= result.ecefBounds.maxY);
      assert.ok(z >= result.ecefBounds.minZ && z <= result.ecefBounds.maxZ);
    }
  } finally {
    source.close();
  }
});

test("malformed node identities are rejected before a point read", async () => {
  const backend = createBackend();
  const source = await createCopcContext("memory://malformed", backend);
  try {
    await assert.rejects(
      source.loadPreparedNodeData(
        { ...rootNode, key: "1-1-0-0", level: 1, x: 0 },
        createCopcPointFieldSelection(["position"]),
      ),
      /coordinates do not match its key/,
    );
    assert.equal(backend.calls.point, 0);
    assert.throws(
      () => source.loadHierarchyPage({
        ...rootPage,
        pageOffset: Number.MAX_SAFE_INTEGER,
        pageLength: 1,
      }),
      /offset or length is invalid/u,
    );
    assert.deepEqual(backend.calls.hierarchy, []);
  } finally {
    source.close();
  }
});
