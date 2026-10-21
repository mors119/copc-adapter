import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { deriveNodePointSpacingMeters } from "../../../cesium/render/pointSpacing.ts";
import { CopcCesiumLayer } from "../../../cesium/layer/CopcCesiumLayer.ts";
import { loadGtxGeoidGrid } from "../../../core/coordinates/transform/verticalGrid.ts";
import {
  computeProjectedPointSizeCssPixels,
  DEFAULT_MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS,
  DEFAULT_MIN_ATTENUATED_POINT_SIZE_CSS_PIXELS,
  MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS,
} from "../../../cesium/render/projectedPointSize.ts";

const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
const ORTHOMETRIC_WKT =
  'COMPD_CS["WGS 84 + Local orthometric height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],VERT_CS["Local orthometric height",VERT_DATUM["Local vertical datum",2005],UNIT["metre",1],AXIS["Gravity-related height",UP]]]';

function geographicMetadata(spacing = 0.001) {
  return {
    pointCount: 1,
    spacing,
    bounds: { minX: -1, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
    cube: { minX: -1, minY: -1, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
    wkt: WGS84_WKT,
  };
}

function projectSize(overrides = {}) {
  return computeProjectedPointSizeCssPixels({
    spacingMeters: 1,
    projectionYScale: 1,
    viewportHeightCssPixels: 600,
    viewDepthMeters: 10,
    perspective: true,
    minPointSize: 1,
    maxPointSize: 12,
    ...overrides,
  });
}

async function createRegionalVerticalGrid() {
  const bytes = new ArrayBuffer(40 + 4 * 4);
  const view = new DataView(bytes);
  view.setFloat64(0, 44.3, false);
  view.setFloat64(8, -122.7, false);
  view.setFloat64(16, 0.2, false);
  view.setFloat64(24, 0.2, false);
  view.setInt32(32, 2, false);
  view.setInt32(36, 2, false);
  [25, 25, 25, 25].forEach((value, index) =>
    view.setFloat32(40 + index * 4, value, false),
  );
  return loadGtxGeoidGrid(bytes, {
    gridId: "spacing-test-regional-grid",
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

test("node spacing converts geographic degrees to local metres and halves by octree level", () => {
  const metadata = geographicMetadata();
  const equator = deriveNodePointSpacingMeters(metadata, 0, {
    longitude: 0,
    latitude: 0,
    height: 0,
  });
  const latitude60 = deriveNodePointSpacingMeters(metadata, 0, {
    longitude: 0,
    latitude: 60,
    height: 0,
  });
  const level2 = deriveNodePointSpacingMeters(metadata, 2, {
    longitude: 0,
    latitude: 0,
    height: 0,
  });

  assert.ok(
    equator > 110 && equator < 112,
    `expected local metre spacing, got ${equator}`,
  );
  assert.ok(
    latitude60 > 77 && latitude60 < 80,
    `expected latitude-adjusted spacing, got ${latitude60}`,
  );
  assert.ok(Math.abs(equator / 4 - level2) < 1e-6);
});

test("node spacing converts projected source units through the render CRS transform", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL("../../../../crates/crs-audit/src/fixtures.json", import.meta.url),
    ),
    "utf8",
  );
  const fixture = JSON.parse(source).fixtures.find(
    (candidate) => candidate.id === "epsg-5186-korean-central-belt-2010",
  );
  assert.ok(fixture);
  const spacing = deriveNodePointSpacingMeters(
    {
      ...geographicMetadata(1),
      wkt: fixture.wkt,
    },
    0,
    { longitude: 127, latitude: 38, height: 0 },
  );
  assert.ok(
    spacing > 0.99 && spacing < 1.01,
    `expected metre CRS spacing, got ${spacing}`,
  );
});

test("regional geoid coverage does not restrict synthetic spacing probes", async () => {
  const metadata = {
    ...geographicMetadata(0.5),
    wkt: ORTHOMETRIC_WKT,
  };
  const grid = await createRegionalVerticalGrid();

  const centerOutsideGrid = deriveNodePointSpacingMeters(
    metadata,
    0,
    { longitude: 0, latitude: 0, height: 0 },
    grid,
  );
  const probesOutsideGrid = deriveNodePointSpacingMeters(
    metadata,
    0,
    { longitude: -122.6, latitude: 44.4, height: 100 },
    grid,
  );

  assert.ok(centerOutsideGrid > 0);
  assert.ok(probesOutsideGrid > 0);
});

test("node spacing falls back when metadata or source CRS cannot produce metric spacing", () => {
  assert.equal(
    deriveNodePointSpacingMeters(
      {
        ...geographicMetadata(),
        spacing: undefined,
      },
      0,
      {
        longitude: 0,
        latitude: 0,
        height: 0,
      },
    ),
    undefined,
  );
  assert.equal(
    deriveNodePointSpacingMeters(geographicMetadata(), -1, {
      longitude: 0,
      latitude: 0,
      height: 0,
    }),
    undefined,
  );
  assert.equal(
    deriveNodePointSpacingMeters(
      {
        ...geographicMetadata(),
        wkt: "INVALID CRS",
      },
      0,
      { longitude: 0, latitude: 0, height: 0 },
    ),
    undefined,
  );
});

test("projected spacing uses perspective depth, CSS viewport height, and bounded diameters", () => {
  assert.equal(projectSize({ viewDepthMeters: 40 }), 7.5);
  assert.equal(projectSize({ viewDepthMeters: 100 }), 3);
  assert.equal(projectSize({ viewDepthMeters: 1 }), 12);
  assert.equal(
    projectSize({ viewportHeightCssPixels: 1200, viewDepthMeters: 40 }),
    12,
  );
  assert.equal(
    projectSize({ minPointSize: 4, maxPointSize: 8, viewDepthMeters: 100 }),
    4,
  );
  assert.equal(DEFAULT_MIN_ATTENUATED_POINT_SIZE_CSS_PIXELS, 1);
  assert.equal(DEFAULT_MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS, 12);
  assert.equal(MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS, 64);
});

test("orthographic projected spacing is independent of camera height", () => {
  assert.equal(projectSize({ perspective: false, viewDepthMeters: 10 }), 12);
  assert.equal(
    projectSize({ perspective: false, viewDepthMeters: 10_000 }),
    12,
  );
  assert.equal(projectSize({ perspective: false, spacingMeters: 0.01 }), 3);
});

test("projected point sizing rejects invalid and non-finite inputs", () => {
  assert.equal(projectSize({ spacingMeters: Number.NaN }), undefined);
  assert.equal(
    projectSize({ viewDepthMeters: Number.POSITIVE_INFINITY }),
    undefined,
  );
  assert.equal(projectSize({ projectionYScale: 0 }), undefined);
  assert.equal(projectSize({ minPointSize: 0 }), undefined);
  assert.equal(projectSize({ minPointSize: 8, maxPointSize: 7 }), undefined);
  assert.equal(projectSize({ maxPointSize: 65 }), undefined);
});

test("Cesium layer rejects invalid point-size mode and bounds at construction", () => {
  assert.throws(
    () =>
      new CopcCesiumLayer({
        url: "memory://point-size.copc.laz",
        pointSize: Number.NaN,
      }),
    /pointSize must be a positive finite number/,
  );
  assert.throws(
    () =>
      new CopcCesiumLayer({
        url: "memory://point-size.copc.laz",
        pointSizeMode: "adaptive",
      }),
    /pointSizeMode must be/,
  );
  assert.throws(
    () =>
      new CopcCesiumLayer({
        url: "memory://point-size.copc.laz",
        minPointSize: 10,
        maxPointSize: 5,
      }),
    /minPointSize and maxPointSize/,
  );
  assert.throws(
    () =>
      new CopcCesiumLayer({
        url: "memory://point-size.copc.laz",
        maxPointSize: 65,
      }),
    /maxPointSize <= 64/,
  );
});
