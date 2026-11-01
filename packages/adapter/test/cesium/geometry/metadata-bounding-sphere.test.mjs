import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Cesium from "cesium";

import { createMetadataBoundingSphere } from "../../../cesium/geometry/metadataBoundingSphere.ts";
import { createPointTransformer } from "../../../core/coordinates/transform/createPointTransformer.ts";
import { loadGtxGeoidGrid } from "../../../core/coordinates/transform/verticalGrid.ts";

const crsAuditPath = fileURLToPath(
  new URL("../../../../../crates/crs-audit/src/fixtures.json", import.meta.url),
);
const crsAudit = JSON.parse(readFileSync(crsAuditPath, "utf8"));
const epsg5186 = crsAudit.fixtures.find(
  (fixture) => fixture.id === "epsg-5186-korean-central-belt-2010",
);

function metadata(bounds, options = {}) {
  return {
    pointCount: options.pointCount ?? 100,
    bounds,
    cube: options.cube ?? bounds,
    ...(options.wkt === undefined ? {} : { wkt: options.wkt }),
  };
}

async function createSyntheticVerticalGrid() {
  const bytes = new ArrayBuffer(40 + 4 * 4);
  const view = new DataView(bytes);
  view.setFloat64(0, 0, false);
  view.setFloat64(8, 0, false);
  view.setFloat64(16, 1, false);
  view.setFloat64(24, 1, false);
  view.setInt32(32, 2, false);
  view.setInt32(36, 2, false);
  [10, 20, 30, 40].forEach((value, index) =>
    view.setFloat32(40 + index * 4, value, false),
  );
  return loadGtxGeoidGrid(bytes, {
    gridId: "bounding-sphere-synthetic-grid",
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

function assertContainsTransformedGrid(
  sphere,
  sourceMetadata,
  offset = 0,
  divisions = 16,
) {
  const transform = createPointTransformer(sourceMetadata, offset);
  const bounds = sourceMetadata.bounds;
  for (let zIndex = 0; zIndex <= 2; zIndex += 1) {
    const z = bounds.minZ + ((bounds.maxZ - bounds.minZ) * zIndex) / 2;
    for (let yIndex = 0; yIndex <= divisions; yIndex += 1) {
      const y =
        bounds.minY + ((bounds.maxY - bounds.minY) * yIndex) / divisions;
      for (let xIndex = 0; xIndex <= divisions; xIndex += 1) {
        const x =
          bounds.minX + ((bounds.maxX - bounds.minX) * xIndex) / divisions;
        const transformed = transform({ x, y, z });
        const ecef = Cesium.Cartesian3.fromDegrees(
          transformed.longitude,
          transformed.latitude,
          transformed.height,
        );
        assert.ok(
          Cesium.Cartesian3.distance(sphere.center, ecef) <=
            sphere.radius + 0.01,
          `metadata sphere missed transformed source point ${x}, ${y}, ${z}`,
        );
      }
    }
  }
}

test("metadata sphere contains geographic metadata bounds and applies either height offset once", () => {
  const source = metadata(
    {
      minX: -123.2,
      minY: 44.1,
      minZ: 100,
      maxX: -122.8,
      maxY: 44.5,
      maxZ: 180,
    },
    {
      cube: {
        minX: -123.1,
        minY: 44.2,
        minZ: 110,
        maxX: -122.9,
        maxY: 44.4,
        maxZ: 170,
      },
    },
  );

  for (const offset of [0, 35, -22]) {
    const sphere = createMetadataBoundingSphere(source, offset);
    assert.ok(sphere instanceof Cesium.BoundingSphere);
    assertContainsTransformedGrid(sphere, source, offset);
  }
  const base = createMetadataBoundingSphere(source);
  const raised = createMetadataBoundingSphere(source, 35);
  assert.ok(base && raised);
  assert.notEqual(base.center.z, raised.center.z);
});

test("metadata sphere uses grid extrema without sampling synthetic extent points", async () => {
  const spacedHorizontalWkt = 'COMPD_CS["WGS 84 + Local orthometric height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],VERT_CS["Local orthometric height",VERT_DATUM["Local vertical datum",2005],UNIT["metre",1],AXIS["Gravity-related height",UP]]]'
    .replace("GEOGCS[", "GEOGCS [")
    .replace('UNIT["degree"', 'UNIT ["degree"');
  const source = metadata(
    {
      minX: -0.5,
      minY: -0.5,
      minZ: 100,
      maxX: 1.5,
      maxY: 1.5,
      maxZ: 200,
    },
    {
      wkt: spacedHorizontalWkt,
    },
  );
  const sphere = createMetadataBoundingSphere(
    source,
    0,
    await createSyntheticVerticalGrid(),
  );

  assert.ok(sphere);
  assert.ok(Number.isFinite(sphere.radius) && sphere.radius > 0);
});

test("metadata sphere supports geographic WKT angular units and vertical unit conversion", () => {
  const geographicWkt =
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
  const geographic = metadata(
    {
      minX: -122.5,
      minY: 44,
      minZ: 10,
      maxX: -122.4,
      maxY: 44.1,
      maxZ: 50,
    },
    { wkt: geographicWkt },
  );
  const geographicSphere = createMetadataBoundingSphere(geographic);
  assert.ok(geographicSphere);
  assertContainsTransformedGrid(geographicSphere, geographic);

  assert.ok(epsg5186);
  const compoundWkt = `COMPD_CS["Projected feet",${epsg5186.wkt},VERT_CS["Height",VERT_DATUM["local",2005],UNIT["US foot",0.3048006096012192]]]`;
  const projected = metadata(
    {
      minX: 199_000,
      minY: 599_000,
      minZ: 10,
      maxX: 201_000,
      maxY: 601_000,
      maxZ: 110,
    },
    { wkt: compoundWkt },
  );
  const projectedSphere = createMetadataBoundingSphere(projected, -3);
  assert.ok(projectedSphere);
  assertContainsTransformedGrid(projectedSphere, projected, -3);
  const transformedHeight = createPointTransformer(
    projected,
    -3,
  )({
    x: 200_000,
    y: 600_000,
    z: 10,
  }).height;
  assert.ok(Math.abs(transformedHeight - (10 * 0.3048006096012192 - 3)) < 1e-8);
});

test("metadata sphere supports projected WKT bounds and contains transformed interior samples", () => {
  assert.ok(epsg5186);
  const source = metadata(
    {
      minX: 199_000,
      minY: 599_000,
      minZ: 12,
      maxX: 201_000,
      maxY: 601_000,
      maxZ: 92,
    },
    { wkt: epsg5186.wkt },
  );
  const sphere = createMetadataBoundingSphere(source, 8.5);
  assert.ok(sphere instanceof Cesium.BoundingSphere);
  assertContainsTransformedGrid(sphere, source, 8.5, 24);
});

test("metadata sphere rejects malformed, non-finite, unsupported, and unbounded input", () => {
  const valid = {
    minX: -123,
    minY: 44,
    minZ: 0,
    maxX: -122,
    maxY: 45,
    maxZ: 10,
  };
  assert.equal(
    createMetadataBoundingSphere(metadata({ ...valid, minX: NaN })),
    undefined,
  );
  assert.equal(
    createMetadataBoundingSphere(metadata({ ...valid, maxY: Infinity })),
    undefined,
  );
  assert.equal(
    createMetadataBoundingSphere(metadata({ ...valid, minZ: 20 })),
    undefined,
  );
  assert.equal(
    createMetadataBoundingSphere(metadata(valid, { pointCount: 0 })),
    undefined,
  );
  assert.equal(
    createMetadataBoundingSphere(
      metadata(valid, { wkt: 'LOCAL_CS["unsupported"]' }),
    ),
    undefined,
  );
  assert.equal(
    createMetadataBoundingSphere(
      metadata({
        minX: 500_000,
        minY: 6_000_000,
        minZ: 0,
        maxX: 500_100,
        maxY: 6_000_100,
        maxZ: 10,
      }),
    ),
    undefined,
  );
  assert.equal(
    createMetadataBoundingSphere(
      metadata({
        minX: -1_000_000,
        minY: 1_000_000,
        minZ: 0,
        maxX: 1_000_000,
        maxY: 3_000_001,
        maxZ: 10,
      }),
    ),
    undefined,
  );
});

test("large point counts with a supported local extent produce a finite sphere", () => {
  const sphere = createMetadataBoundingSphere(
    metadata(
      {
        minX: 127.0,
        minY: 37.9,
        minZ: -20,
        maxX: 127.1,
        maxY: 38.0,
        maxZ: 850,
      },
      { pointCount: 1_000_000_000 },
    ),
  );
  assert.ok(sphere);
  assert.ok(Number.isFinite(sphere.radius) && sphere.radius > 0);

  const broadSphere = createMetadataBoundingSphere(
    metadata({
      minX: -5,
      minY: -5,
      minZ: -100,
      maxX: 5,
      maxY: 5,
      maxZ: 10_000,
    }),
  );
  assert.ok(broadSphere);
  assertContainsTransformedGrid(
    broadSphere,
    metadata({
      minX: -5,
      minY: -5,
      minZ: -100,
      maxX: 5,
      maxY: 5,
      maxZ: 10_000,
    }),
    0,
    24,
  );
});
