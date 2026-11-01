import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  CopcStaleSourceError,
  HierarchyLoader,
  InMemoryByteSource,
  createCopcContext,
  loadGtxGeoidGrid,
  transformPointBufferToPreparedPointData,
} from "../../../core.ts";

const WGS84_COMPOUND_WKT =
  'COMPD_CS["WGS 84 + ellipsoidal height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AXIS["Longitude",EAST],AXIS["Latitude",NORTH],AUTHORITY["EPSG","4326"]],VERT_CS["WGS 84 ellipsoidal height",VERT_DATUM["WGS 84 ellipsoid",2002],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Ellipsoidal height",UP]]]';
const ORTHOMETRIC_WKT =
  'COMPD_CS["WGS 84 + Local orthometric height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AXIS["Longitude",EAST],AXIS["Latitude",NORTH],AUTHORITY["EPSG","4326"]],VERT_CS["Local orthometric height",VERT_DATUM["Local vertical datum",2005],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Gravity-related height",UP]]]';
const WGS84_3D_WKT2 =
  'GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1],ID["EPSG",7030]],ID["EPSG",6326]],CS[ellipsoidal,3],AXIS["geodetic latitude (Lat)",north,ORDER[1],ANGLEUNIT["degree",0.0174532925199433]],AXIS["geodetic longitude (Lon)",east,ORDER[2],ANGLEUNIT["degree",0.0174532925199433]],AXIS["ellipsoidal height (h)",up,ORDER[3],LENGTHUNIT["metre",1]],ID["EPSG",4979]]';

const crsFixtures = JSON.parse(
  readFileSync(new URL("../../../../../crates/crs-audit/src/fixtures.json", import.meta.url), "utf8"),
);
const autzenPath = fileURLToPath(new URL("../../../../../samples/local/autzen.copc.laz", import.meta.url));

function createMetadata({
  wkt = WGS84_COMPOUND_WKT,
  bounds = { minX: -123.5, minY: 44, minZ: 10, maxX: -123, maxY: 44.5, maxZ: 90 },
} = {}) {
  return {
    pointCount: 1,
    wkt,
    bounds,
    cube: bounds,
    scale: { x: 0.01, y: 0.01, z: 0.01 },
    offset: { x: 0, y: 0, z: 0 },
    crsWktProvenance: { selected: "vlr", available: ["vlr"], conflicting: false },
  };
}

function createBackend(metadata, calls = { point: 0, hierarchy: 0 }) {
  return {
    async open() {
      return {
        source: "memory://conservative-bounds",
        getMetadata: () => metadata,
        getRootHierarchyPage: () => ({ key: "0-0-0-0", pageOffset: 0, pageLength: 1 }),
        async loadHierarchyPage() {
          calls.hierarchy += 1;
          return { nodes: [], pages: [] };
        },
        async loadPointDataView() {
          calls.point += 1;
          throw new Error("conservative bounds must not decode points");
        },
        destroy() {},
      };
    },
  };
}

async function openSource({ metadata = createMetadata(), options = {}, calls } = {}) {
  const backend = createBackend(metadata, calls);
  return createCopcContext("memory://input", backend, options);
}

function assertContainsPreparedPoints(bounds, prepared) {
  assert.equal(bounds.coordinateSystem, "wgs84-ecef-meters");
  const coordinates = prepared.world.coordinates;
  for (let index = 0; index < coordinates.length; index += 3) {
    assert.ok(coordinates[index] >= bounds.minX && coordinates[index] <= bounds.maxX, `x ${coordinates[index]}`);
    assert.ok(coordinates[index + 1] >= bounds.minY && coordinates[index + 1] <= bounds.maxY, `y ${coordinates[index + 1]}`);
    assert.ok(coordinates[index + 2] >= bounds.minZ && coordinates[index + 2] <= bounds.maxZ, `z ${coordinates[index + 2]}`);
  }
}

function prepareSamples(metadata, coordinates, offset = 0, grid) {
  return transformPointBufferToPreparedPointData(
    metadata,
    { pointCount: coordinates.length / 3, coordinates: new Float64Array(coordinates) },
    offset,
    grid,
  );
}

async function createGrid({ noDataValue = null } = {}) {
  const bytes = new ArrayBuffer(56);
  const view = new DataView(bytes);
  view.setFloat64(0, 44, false);
  view.setFloat64(8, -124, false);
  view.setFloat64(16, 1, false);
  view.setFloat64(24, 1, false);
  view.setInt32(32, 2, false);
  view.setInt32(36, 2, false);
  [10, 20, noDataValue ?? 30, 40].forEach((value, index) =>
    view.setFloat32(40 + index * 4, value, false),
  );
  return loadGtxGeoidGrid(bytes, {
    gridId: "conservative-bounds-grid",
    sourceVerticalCrs: "Local orthometric height",
    targetVerticalCrs: "EPSG:4979",
    horizontalCrs: "EPSG:4326",
    referenceEllipsoid: "WGS84",
    sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
    valueUnit: "metre",
    valueConvention: "ellipsoidal-minus-orthometric",
    noDataValue,
  });
}

test("metadata-only ECEF bounds cover the complete source cell and every octree descendant", async () => {
  const calls = { point: 0, hierarchy: 0 };
  const metadata = createMetadata();
  const source = await openSource({ metadata, calls });
  try {
    const root = source.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(root.status, "supported");
    assert.equal(root.coverage, "full-source-cell-and-descendant-cells");
    assert.equal(root.method, "wgs84-geodetic-interval-v1");
    assert.equal(root.verification, "analytic-interval");
    assert.equal(root.verticalReference, "ellipsoidal");
    assert.equal(root.encoderErrorPaddingRequired, true);
    assert.equal(root.sourceIdentity, source.source);
    assert.equal(root.sourceGeneration, source.sourceGeneration);
    assert.equal(root.transformGeneration, source.transformGeneration);
    assert.equal(root.transformPlanIdentity, source.transformPlan.identity.key);
    assert.equal(root.sourceCoordinateSystem, "copc-source");
    assert.equal(root.sourceCellBounds.minX, metadata.cube.minX);
    assert.ok(root.assumptions.length >= 4);

    const samples = prepareSamples(metadata, [
      -123.5, 44, 10,
      -123.25, 44.25, 50,
      -123, 44.5, 90,
      -123.37, 44.11, 73,
    ]);
    assertContainsPreparedPoints(root.boundsEcef, samples);

    const child = source.getConservativeNodeEcefBounds("1-0-0-0");
    assert.equal(child.status, "supported");
    assert.ok(child.boundsEcef.minX >= root.boundsEcef.minX);
    assert.ok(child.boundsEcef.maxX <= root.boundsEcef.maxX);
    assert.ok(child.boundsEcef.minY >= root.boundsEcef.minY);
    assert.ok(child.boundsEcef.maxY <= root.boundsEcef.maxY);
    assert.ok(child.boundsEcef.minZ >= root.boundsEcef.minZ);
    assert.ok(child.boundsEcef.maxZ <= root.boundsEcef.maxZ);
    assert.deepEqual(calls, { point: 0, hierarchy: 0 });

    source.close();
    assert.throws(() => source.getConservativeNodeEcefBounds("0-0-0-0"), CopcStaleSourceError);
  } finally {
    source.close();
  }
});

test("WKT1 EPSG:4326 without AXIS clauses follows the point transform's XY convention", async () => {
  const metadata = createMetadata({
    wkt: WGS84_COMPOUND_WKT.replace('AXIS["Longitude",EAST],AXIS["Latitude",NORTH],', ""),
  });
  const source = await openSource({ metadata });
  try {
    const result = source.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "supported");
    assertContainsPreparedPoints(
      result.boundsEcef,
      prepareSamples(metadata, [-123.5, 44, 10, -123.25, 44.25, 50, -123, 44.5, 90]),
    );
  } finally {
    source.close();
  }
});

test("WKT2 latitude-longitude axes, antimeridian, poles, and extreme heights are enclosed", async () => {
  const metadata = createMetadata({
    wkt: WGS84_3D_WKT2,
    bounds: { minX: 89.5, minY: 179, minZ: -20_000, maxX: 90, maxY: 181, maxZ: 200_000 },
  });
  const source = await openSource({ metadata });
  try {
    const result = source.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "supported", result.status === "unsupported" ? result.reason : undefined);
    const samples = prepareSamples(metadata, [
      89.5, 179, -20_000,
      89.75, 180, 80_000,
      90, 181, 200_000,
      89.999999, 179.999, -1_000,
    ]);
    assertContainsPreparedPoints(result.boundsEcef, samples);
  } finally {
    source.close();
  }
});

test("uniform positive and negative height offsets are included in the bounds", async () => {
  const metadata = createMetadata();
  for (const offset of [500, -700]) {
    const source = await openSource({ metadata, options: { heightOffsetMeters: offset } });
    try {
      const result = source.getConservativeNodeEcefBounds("0-0-0-0");
      assert.equal(result.status, "supported");
      assert.equal(result.heightOffsetMeters, offset);
      assertContainsPreparedPoints(
        result.boundsEcef,
        prepareSamples(metadata, [-123.5, 44, 10, -123.25, 44.25, 50, -123, 44.5, 90], offset),
      );
    } finally {
      source.close();
    }
  }
});

test("bounds provenance changes when a source is reopened with a new transform generation", async () => {
  const metadata = createMetadata();
  const first = await openSource({ metadata });
  const second = await openSource({ metadata, options: { heightOffsetMeters: 125 } });
  try {
    const firstBounds = first.getConservativeNodeEcefBounds("0-0-0-0");
    const secondBounds = second.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(firstBounds.status, "supported");
    assert.equal(secondBounds.status, "supported");
    assert.notEqual(firstBounds.sourceGeneration, secondBounds.sourceGeneration);
    assert.notEqual(firstBounds.transformGeneration, secondBounds.transformGeneration);
    assert.notEqual(firstBounds.transformPlanIdentity, secondBounds.transformPlanIdentity);
    assert.equal(secondBounds.heightOffsetMeters, 125);
  } finally {
    first.close();
    second.close();
  }
});

test("explicit vertical unit conversion is included before the height offset", async () => {
  const usSurveyFootWkt = WGS84_COMPOUND_WKT.replace(
    'UNIT["metre",1,AUTHORITY["EPSG","9001"]]',
    'UNIT["US survey foot",0.304800609601219,AUTHORITY["EPSG","9003"]]',
  );
  const metadata = createMetadata({
    wkt: usSurveyFootWkt,
    bounds: { minX: -123.5, minY: 44, minZ: -100, maxX: -123, maxY: 44.5, maxZ: 1_000 },
  });
  const source = await openSource({ metadata, options: { heightOffsetMeters: 12.5 } });
  try {
    const result = source.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "supported");
    assert.equal(result.sourceVerticalUnitToMeters, 0.304800609601219);
    assertContainsPreparedPoints(
      result.boundsEcef,
      prepareSamples(metadata, [-123.5, 44, -100, -123.25, 44.25, 500, -123, 44.5, 1_000], 12.5),
    );
  } finally {
    source.close();
  }
});

test("validated vertical-grid extrema bound bilinear corrections and reject NoData or uncovered cells", async () => {
  const grid = await createGrid();
  const metadata = createMetadata({
    wkt: ORTHOMETRIC_WKT,
    bounds: { minX: -124, minY: 44, minZ: 0, maxX: -123, maxY: 45, maxZ: 100 },
  });
  const noGridSource = await openSource({ metadata });
  try {
    const result = noGridSource.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "unsupported");
    assert.equal(result.reasonCode, "unsupported-vertical-reference");
  } finally {
    noGridSource.close();
  }

  const source = await openSource({ metadata, options: { verticalGrid: grid, heightOffsetMeters: 7 } });
  try {
    const result = source.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "supported", result.status === "unsupported" ? result.reason : undefined);
    assert.equal(result.verticalReference, "validated-grid");
    assert.equal(result.verticalGrid.id, grid.gridId);
    assert.equal(result.verticalGrid.sha256, grid.sha256);
    const samples = prepareSamples(metadata, [
      -124, 44, 0,
      -123.5, 44.5, 50,
      -123, 45, 100,
      -123.9, 44.1, 91,
    ], 7, grid);
    assertContainsPreparedPoints(result.boundsEcef, samples);
  } finally {
    source.close();
  }

  const outsideMetadata = createMetadata({
    wkt: ORTHOMETRIC_WKT,
    bounds: { minX: -125, minY: 44, minZ: 0, maxX: -124.5, maxY: 44.5, maxZ: 100 },
  });
  const outsideSource = await openSource({ metadata: outsideMetadata, options: { verticalGrid: grid } });
  try {
    const result = outsideSource.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "unsupported");
    assert.equal(result.reasonCode, "vertical-grid-outside-cell-coverage");
  } finally {
    outsideSource.close();
  }

  const noDataGrid = await createGrid({ noDataValue: -9999 });
  const noDataSource = await openSource({ metadata, options: { verticalGrid: noDataGrid } });
  try {
    const result = noDataSource.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "unsupported");
    assert.equal(result.reasonCode, "vertical-grid-has-nodata-sentinel");
  } finally {
    noDataSource.close();
  }
});

test("projected CRS, unknown height reference, epochs, and large geographic ranges fail closed", async () => {
  const fixtures = crsFixtures.fixtures;
  const autzenWkt = fixtures.find((entry) => entry.id === "autzen-wkt1-compound-lcc")?.wkt;
  const sofiWkt = fixtures.find((entry) => entry.id === "sofi-wkt1-compound-utm11")?.wkt;
  const epsg5186Wkt = fixtures.find((entry) => entry.id === "epsg-5186-korean-central-belt-2010")?.wkt;
  for (const wkt of [autzenWkt, sofiWkt, epsg5186Wkt]) {
    const source = await openSource({
      metadata: createMetadata({
        wkt,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 100, maxZ: 100 },
      }),
    });
    try {
      const result = source.getConservativeNodeEcefBounds("0-0-0-0");
      assert.equal(result.status, "unsupported");
      assert.equal(result.reasonCode, "unsupported-horizontal-crs");
      assert.match(result.reason, /WGS 84 geographic/);
    } finally {
      source.close();
    }
  }

  const unsupportedAngularUnit = await openSource({
    metadata: createMetadata({
      wkt: WGS84_COMPOUND_WKT.replace(
        'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]]',
        'UNIT["grad",0.015707963267949,AUTHORITY["EPSG","9105"]]',
      ),
    }),
  });
  try {
    const result = unsupportedAngularUnit.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "unsupported");
    assert.equal(result.reasonCode, "unsupported-horizontal-units");
  } finally {
    unsupportedAngularUnit.close();
  }

  const mismatchedEllipsoidSource = await openSource({
    metadata: createMetadata({
      wkt: WGS84_COMPOUND_WKT.replace(
        'SPHEROID["WGS 84",6378137,298.257223563',
        'SPHEROID["WGS 84",6378138,298.257223563',
      ),
    }),
  });
  try {
    const result = mismatchedEllipsoidSource.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "unsupported");
    assert.equal(result.reasonCode, "unsupported-horizontal-crs");
    assert.match(result.reason, /datum or ensemble, ellipsoid, and Greenwich prime meridian/);
  } finally {
    mismatchedEllipsoidSource.close();
  }

  const unknownVerticalWkt = WGS84_COMPOUND_WKT.replace(
    "WGS 84 ellipsoidal height",
    "Unspecified local height",
  ).replace("Ellipsoidal height", "Height");
  const unknownVerticalSource = await openSource({
    metadata: createMetadata({ wkt: unknownVerticalWkt }),
  });
  try {
    const result = unknownVerticalSource.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "unsupported");
    assert.equal(result.reasonCode, "unsupported-vertical-reference");
  } finally {
    unknownVerticalSource.close();
  }

  const dynamicSource = await openSource({
    metadata: createMetadata({
      wkt: WGS84_3D_WKT2.replace(
        'ID["EPSG",6326]],CS[ellipsoidal,3]',
        'ID["EPSG",6326]],DYNAMIC[FRAMEEPOCH[2020.0]],CS[ellipsoidal,3]',
      ),
    }),
  });
  try {
    const result = dynamicSource.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "unsupported");
    assert.equal(result.reasonCode, "unsupported-coordinate-epoch");
  } finally {
    dynamicSource.close();
  }

  const ensembleSource = await openSource({
    metadata: createMetadata({
      wkt: WGS84_3D_WKT2
        .replace(
          'DATUM["World Geodetic System 1984"',
          'ENSEMBLE["World Geodetic System 1984 ensemble"',
        )
        .replace('ID["EPSG",6326]]', 'ENSEMBLEACCURACY[2],ID["EPSG",6326]]'),
      bounds: { minX: 89.5, minY: 179, minZ: -20_000, maxX: 90, maxY: 181, maxZ: 200_000 },
    }),
  });
  try {
    const result = ensembleSource.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "supported");
    assertContainsPreparedPoints(
      result.boundsEcef,
      prepareSamples(ensembleSource.getMetadata(), [89.5, 179, -20_000, 90, 181, 200_000, 89.75, 180, 80_000]),
    );
  } finally {
    ensembleSource.close();
  }

  const hugeCellSource = await openSource({
    metadata: createMetadata({ bounds: { minX: 500, minY: 0, minZ: 0, maxX: 501, maxY: 1, maxZ: 100 } }),
  });
  try {
    const result = hugeCellSource.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "unsupported");
    assert.equal(result.reasonCode, "unsupported-geographic-cell");
  } finally {
    hugeCellSource.close();
  }
});

test("deep, very small, and degenerate source cells produce finite bounds", async () => {
  const metadata = createMetadata({
    bounds: { minX: -123.5, minY: 44, minZ: 10, maxX: -123.5, maxY: 44, maxZ: 10 },
  });
  const source = await openSource({ metadata });
  try {
    const result = source.getConservativeNodeEcefBounds("31-2147483647-0-2147483647");
    assert.equal(result.status, "supported", result.status === "unsupported" ? result.reason : undefined);
    for (const value of Object.values(result.boundsEcef)) {
      if (typeof value === "number") assert.ok(Number.isFinite(value));
    }
    const empty = source.getConservativeNodeEcefBounds("31-0-0-0");
    assert.equal(empty.status, "supported");
    assert.ok(empty.boundsEcef.minX <= empty.boundsEcef.maxX);
    assert.throws(() => source.getConservativeNodeEcefBounds("bad-key"), TypeError);
  } finally {
    source.close();
  }
});

test("large finite height magnitudes remain bounded with outward numeric intervals", async () => {
  const metadata = createMetadata({
    bounds: { minX: -123.5, minY: 44, minZ: -1e100, maxX: -123, maxY: 44.5, maxZ: 1e100 },
  });
  const source = await openSource({ metadata });
  try {
    const result = source.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "supported");
    for (const value of Object.values(result.boundsEcef)) {
      if (typeof value === "number") assert.ok(Number.isFinite(value));
    }
    assertContainsPreparedPoints(
      result.boundsEcef,
      prepareSamples(metadata, [-123.5, 44, -1e100, -123.25, 44.25, 0, -123, 44.5, 1e100]),
    );
  } finally {
    source.close();
  }
});

test("malformed source cells return a typed unsupported result", async () => {
  const source = await openSource({
    metadata: createMetadata({
      bounds: { minX: -123, minY: 44, minZ: 10, maxX: -123.5, maxY: 44.5, maxZ: 90 },
    }),
  });
  try {
    const result = source.getConservativeNodeEcefBounds("0-0-0-0");
    assert.equal(result.status, "unsupported");
    assert.equal(result.reasonCode, "invalid-source-cell");
  } finally {
    source.close();
  }
});

test(
  "real Autzen hierarchy and prepared node remain explicitly unsupported by both backends",
  { skip: !existsSync(autzenPath) },
  async () => {
    const bytes = await readFile(autzenPath);
    for (const backend of ["copc-js", "rust"]) {
      const source = await createCopcContext(
        new InMemoryByteSource(bytes, `memory://autzen-bounds-${backend}`),
        backend,
      );
      try {
        const metadata = source.getMetadata();
        const loader = new HierarchyLoader(source, metadata.cube);
        const hierarchy = await loader.query(
          { bounds: { ...metadata.cube, coordinateSystem: "copc-source" }, maxLevel: 12 },
          { maxPages: 16 },
        );
        assert.ok(hierarchy.nodes.some((node) => node.level >= 2), `${backend} traversed multiple hierarchy levels`);
        const node = hierarchy.nodes
          .filter((candidate) => candidate.level >= 1 && candidate.pointCount > 0)
          .sort((left, right) => right.level - left.level)[0];
        assert.ok(node, `${backend} has a non-root point node`);
        assert.equal(source.transformPlan.source.horizontalCrs?.code, "2992");
        assert.equal(source.transformPlan.source.verticalCrs?.code, "6360");

        const startedAt = performance.now();
        const conservative = source.getConservativeNodeEcefBounds(node.key);
        const boundsDurationMs = performance.now() - startedAt;
        assert.equal(conservative.status, "unsupported");
        assert.equal(conservative.reasonCode, "unsupported-horizontal-crs");
        assert.equal("boundsEcef" in conservative, false);
        assert.equal(conservative.sourceGeneration, source.sourceGeneration);
        assert.equal(conservative.transformGeneration, source.transformGeneration);
        assert.equal(conservative.transformPlanIdentity, source.transformPlan.identity.key);

        const prepared = await source.loadPreparedNodeData(
          node,
          new Set(["position"]),
        );
        assert.ok(prepared.ecefBounds, `${backend} still returns bounds for decoded point content`);
        assert.equal(prepared.ecefBoundsKind, "decoded-point-content");
        assert.equal(prepared.sourceIdentity, source.source);
        assert.equal(prepared.transformGeneration, conservative.transformGeneration);
        assert.equal(prepared.transformPlan.identity.key, conservative.transformPlanIdentity);
        assert.ok(Number.isFinite(boundsDurationMs));
        console.log(`${backend} Autzen node ${node.key}: ${conservative.reasonCode}; metadata bound ${boundsDurationMs.toFixed(3)} ms`);
      } finally {
        source.close();
      }
    }
  },
);
