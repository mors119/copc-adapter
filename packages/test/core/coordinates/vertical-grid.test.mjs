import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createPointTransformer,
  createProjectPointTransformer,
  transformPointBufferToPreparedPointData,
} from "../../../core/coordinates/transform/createPointTransformer.ts";
import {
  GtxGeoidGrid,
  VerticalTransformError,
  loadGtxGeoidGrid,
} from "../../../core/coordinates/transform/verticalGrid.ts";
import { geographicToEcef } from "../../../core/coordinates/transform/worldCoordinates.ts";
import { createPreparedPointData } from "../../../core/point/preparedPoint.ts";
import { buildStreamingHierarchy } from "../../../core/streaming/buildStreamingHierarchy.ts";
import { createDatasetLocalFrame } from "../../../core/coordinates/transform/datasetLocalFrame.ts";
import { getDatasetElevationRange } from "../../../core/point/style/pointStyle.ts";
import { applyPreparedPointVerticalGrid } from "../../../core/coordinates/transform/createPointTransformer.ts";

const ORTHOMETRIC_WKT =
  'COMPD_CS["WGS 84 + Local orthometric height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],VERT_CS["Local orthometric height",VERT_DATUM["Local vertical datum",2005],UNIT["metre",1],AXIS["Gravity-related height",UP]]]';

function encodeGtx({
  latitudeOrigin = 0,
  longitudeOrigin = 0,
  latitudeStep = 1,
  longitudeStep = 1,
  rows = 2,
  columns = 2,
  values = [10, 20, 30, 40],
  valueType = "float32",
}) {
  const bytesPerValue = valueType === "float64" ? 8 : 4;
  const bytes = new ArrayBuffer(40 + values.length * bytesPerValue);
  const header = new DataView(bytes);
  header.setFloat64(0, latitudeOrigin, false);
  header.setFloat64(8, longitudeOrigin, false);
  header.setFloat64(16, latitudeStep, false);
  header.setFloat64(24, longitudeStep, false);
  header.setInt32(32, rows, false);
  header.setInt32(36, columns, false);
  for (let index = 0; index < values.length; index += 1) {
    if (valueType === "float64") {
      header.setFloat64(40 + index * bytesPerValue, values[index], false);
    } else {
      header.setFloat32(40 + index * bytesPerValue, values[index], false);
    }
  }
  return bytes;
}

function digest(bytes) {
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

async function loadGrid(bytes, overrides = {}) {
  return loadGtxGeoidGrid(bytes, {
    gridId: "synthetic-test-grid",
    sourceVerticalCrs: "Local orthometric height",
    targetVerticalCrs: "EPSG:4979",
    horizontalCrs: "EPSG:4326",
    referenceEllipsoid: "WGS84",
    sha256: digest(bytes),
    valueUnit: "metre",
    valueConvention: "ellipsoidal-minus-orthometric",
    noDataValue: null,
    ...overrides,
  });
}

function createMetadata({
  wkt = ORTHOMETRIC_WKT,
  minX = 0,
  minY = 0,
  maxX = 1,
  maxY = 1,
  minZ = 100,
  maxZ = 200,
} = {}) {
  return {
    pointCount: 1,
    wkt,
    bounds: { minX, minY, maxX, maxY, minZ, maxZ },
    cube: { minX, minY, maxX, maxY, minZ, maxZ },
  };
}

test("GTX loader validates SHA-256, header, dimensions and memory limits", async () => {
  const bytes = encodeGtx({});
  const grid = await loadGrid(bytes);
  assert.ok(grid instanceof GtxGeoidGrid);
  assert.equal(grid.width, 2);
  assert.equal(grid.height, 2);
  assert.equal(grid.decodedByteLength, 16);
  assert.equal(grid.minimumUndulationMeters, 10);
  assert.equal(grid.maximumUndulationMeters, 40);

  await assert.rejects(
    loadGrid(bytes, { sha256: "0".repeat(64) }),
    (error) => error instanceof VerticalTransformError && error.code === "grid-integrity",
  );
  await assert.rejects(
    loadGrid(bytes.slice(0, 41)),
    (error) => error instanceof VerticalTransformError && error.code === "grid-integrity",
  );
  await assert.rejects(
    loadGrid(encodeGtx({ values: [10, Number.NaN, 30, 40] })),
    (error) => error instanceof VerticalTransformError && error.code === "grid-format",
  );
  await assert.rejects(
    loadGrid(bytes, { maxGridBytes: 55 }),
    (error) => error instanceof VerticalTransformError && error.code === "resource-limit",
  );
});

test("GTX bilinear interpolation handles positive and negative values and cell boundaries", async () => {
  const grid = await loadGrid(encodeGtx({ values: [-10, 10, 30, 50] }));
  assert.equal(grid.sampleUndulation(0, 0), -10);
  assert.equal(grid.sampleUndulation(1, 1), 50);
  assert.equal(grid.sampleUndulation(0.5, 0.5), 20);
  assert.equal(grid.transformHeight(100, 0.5, 0.5, "orthometric-to-ellipsoidal"), 120);
  assert.equal(grid.transformHeight(120, 0.5, 0.5, "ellipsoidal-to-orthometric"), 100);
  assert.equal(grid.sampleUndulation(1, 0.5), 30);

  const boundaryGrid = await loadGrid(
    encodeGtx({ values: [10, -9999, 30, 40] }),
    { noDataValue: -9999 },
  );
  assert.equal(boundaryGrid.sampleUndulation(0, 0), 10);
});

test("GTX loader snapshots mutable caller bytes before integrity verification", async () => {
  const bytes = encodeGtx({ values: [10, 20, 30, 40] });
  const loading = loadGrid(bytes);
  new DataView(bytes).setFloat32(40, 999, false);
  const grid = await loading;
  assert.equal(grid.sampleUndulation(0, 0), 10);
});

test("GTX loader snapshots CRS and unit metadata before asynchronous verification", async () => {
  const bytes = encodeGtx({ values: [10, 20, 30, 40] });
  const options = {
    gridId: "metadata-snapshot-grid",
    sourceVerticalCrs: "Local orthometric height",
    targetVerticalCrs: "EPSG:4979",
    horizontalCrs: "EPSG:4326",
    referenceEllipsoid: "WGS84",
    sha256: digest(bytes),
    valueUnit: "metre",
    valueConvention: "ellipsoidal-minus-orthometric",
    noDataValue: null,
  };
  const loading = loadGtxGeoidGrid(bytes, options);
  options.valueUnit = "international-foot";
  options.sourceVerticalCrs = "different vertical CRS";
  const grid = await loading;
  assert.equal(grid.valueUnit, "metre");
  assert.equal(grid.sampleUndulation(0, 0), 10);
});

test("GTX float64 values and declared feet convert to metres", async () => {
  const grid = await loadGrid(
    encodeGtx({ valueType: "float64", values: [-10, -10, -10, -10] }),
    { valueUnit: "international-foot" },
  );
  assert.equal(grid.decodedByteLength, 32);
  assert.ok(Math.abs(grid.sampleUndulation(0.5, 0.5) + 3.048) < 1e-12);
  assert.ok(
    Math.abs(
      grid.transformHeight(10, 0.5, 0.5, "orthometric-to-ellipsoidal") - 6.952,
    ) < 1e-12,
  );
});

test("GTX handles longitude origin conventions, wrapped global grids and antimeridian cells", async () => {
  const regional = await loadGrid(
    encodeGtx({
      longitudeOrigin: 170,
      longitudeStep: 10,
      rows: 2,
      columns: 3,
      values: [1, 3, 5, 7, 9, 11],
    }),
  );
  assert.equal(regional.sampleUndulation(-175, 0), 4);

  const global = await loadGrid(
    encodeGtx({
      longitudeOrigin: 0,
      longitudeStep: 90,
      latitudeStep: 90,
      rows: 2,
      columns: 4,
      values: [0, 10, 20, 30, 0, 10, 20, 30],
    }),
  );
  assert.equal(global.sampleUndulation(0, 0), 0);
  assert.equal(global.sampleUndulation(360, 0), 0);
  assert.equal(global.sampleUndulation(-45, 0), 15);
});

test("GTX rejects out-of-coverage, NoData and invalid CRS or interpolation settings", async () => {
  const grid = await loadGrid(encodeGtx({ values: [10, -9999, 30, 40] }), {
    noDataValue: -9999,
  });
  assert.throws(
    () => grid.sampleUndulation(2, 0.5),
    (error) => error instanceof VerticalTransformError && error.code === "outside-grid-coverage",
  );
  assert.throws(
    () => grid.sampleUndulation(0.5, 0),
    (error) => error instanceof VerticalTransformError && error.code === "grid-nodata",
  );
  const conventionalNoData = await loadGrid(
    encodeGtx({ values: [10, -88.8888, 30, 40] }),
    { noDataValue: -88.8888 },
  );
  assert.throws(
    () => conventionalNoData.sampleUndulation(1, 0),
    (error) => error instanceof VerticalTransformError && error.code === "grid-nodata",
  );
  await assert.rejects(
    loadGrid(encodeGtx({}), { sourceVerticalCrs: "" }),
    (error) => error instanceof VerticalTransformError && error.code === "missing-vertical-crs",
  );
  await assert.rejects(
    loadGrid(encodeGtx({}), { noDataValue: undefined }),
    (error) => error instanceof VerticalTransformError && error.code === "invalid-grid-metadata",
  );
  await assert.rejects(
    loadGrid(encodeGtx({}), { targetVerticalCrs: "EPSG:5703" }),
    (error) => error instanceof VerticalTransformError && error.code === "unsupported-crs-pair",
  );
  await assert.rejects(
    loadGrid(encodeGtx({}), { interpolation: "nearest" }),
    (error) => error instanceof VerticalTransformError && error.code === "unsupported-interpolation",
  );
  await assert.rejects(
    loadGrid(encodeGtx({}), { requiresMatchedEpoch: true }),
    (error) => error instanceof VerticalTransformError && error.code === "missing-epoch",
  );
  await assert.rejects(
    loadGrid(encodeGtx({}), {
      sourceCoordinateEpoch: 2010,
      gridReferenceEpoch: 2020,
    }),
    (error) => error instanceof VerticalTransformError && error.code === "incompatible-reference-frame",
  );
});

test("source WKT, grid units, manual offset, inverse query and ECEF agree", async () => {
  const bytes = encodeGtx({ values: [10, 20, 30, 40] });
  const grid = await loadGrid(bytes);
  const metadata = createMetadata();
  const sourcePoint = { x: 0.5, y: 0.5, z: 100 };
  const transformed = createPointTransformer(metadata, 5, grid)(sourcePoint);
  assert.deepEqual(transformed, {
    longitude: 0.5,
    latitude: 0.5,
    height: 130,
  });
  assert.deepEqual(
    createProjectPointTransformer(metadata, 5, grid)(transformed),
    sourcePoint,
  );

  const sourceCoordinates = new Float64Array([0.5, 0.5, 100]);
  const prepared = transformPointBufferToPreparedPointData(
    metadata,
    { pointCount: 1, coordinates: sourceCoordinates },
    5,
    grid,
  );
  assert.deepEqual([...prepared.source.coordinates], [0.5, 0.5, 100]);
  assert.deepEqual([...sourceCoordinates], [0.5, 0.5, 100]);
  assert.equal(prepared.geographic.coordinates[2], 130);
  const expectedEcef = geographicToEcef(transformed);
  assert.deepEqual([...prepared.world.coordinates], [expectedEcef.x, expectedEcef.y, expectedEcef.z]);

  const rustLikePrepared = createPreparedPointData({
    pointCount: 1,
    sourceCoordinates: sourceCoordinates.slice(),
    geographicCoordinates: new Float64Array([0.5, 0.5, 105]),
    worldCoordinates: (() => {
      const world = geographicToEcef({
        longitude: 0.5,
        latitude: 0.5,
        height: 105,
      });
      return new Float64Array([world.x, world.y, world.z]);
    })(),
  });
  const correctedPrepared = applyPreparedPointVerticalGrid(rustLikePrepared, grid);
  assert.deepEqual([...correctedPrepared.geographic.coordinates], [...prepared.geographic.coordinates]);
  assert.deepEqual([...correctedPrepared.world.coordinates], [...prepared.world.coordinates]);
});

test("grid transforms use the strict vertical unit scale in both directions and bounds", async () => {
  const grid = await loadGrid(encodeGtx({ values: [10, 20, 30, 40] }));
  const footWkt = ORTHOMETRIC_WKT.replace(
    'UNIT["metre",1]',
    'UNIT["foot", 0.3048]',
  );
  const metadata = createMetadata({ wkt: footWkt });
  const geographic = createPointTransformer(metadata, 5, grid)({
    x: 0.5,
    y: 0.5,
    z: 100,
  });
  assert.equal(geographic.height, 60.480000000000004);
  assert.ok(
    Math.abs(
      createProjectPointTransformer(metadata, 5, grid)(geographic).z - 100,
    ) < 1e-12,
  );
  assert.deepEqual(getDatasetElevationRange(metadata, 5, grid), {
    min: 45.480000000000004,
    max: 105.96000000000001,
  });

  const hierarchy = buildStreamingHierarchy(
    metadata,
    [
      {
        key: "0-0-0-0",
        level: 0,
        x: 0,
        y: 0,
        z: 0,
        pointCount: 1,
        pointDataOffset: 0,
        pointDataLength: 1,
      },
    ],
    5,
    grid,
  );
  const nodeBounds = hierarchy.get("0-0-0-0");
  assert.equal(nodeBounds.center.height, 60.632400000000004);
  assert.equal(nodeBounds.bounds.minZ, 45.480000000000004);
  assert.equal(nodeBounds.bounds.maxZ, 75.7848);

  const authorizedUnitWkt = footWkt.replace(
    'UNIT["foot", 0.3048]',
    'UNIT["foot", 0.3048,AUTHORITY["EPSG","9002"]]',
  );
  assert.equal(
    createPointTransformer(
      createMetadata({ wkt: authorizedUnitWkt }),
      0,
      grid,
    )({ x: 0.5, y: 0.5, z: 100 }).height,
    55.480000000000004,
  );
});

test("hierarchy bounds use grid extrema without sampling padded cube corners", async () => {
  const grid = await loadGrid(encodeGtx({ values: [10, 20, 30, 40] }));
  const metadata = createMetadata({
    minX: 0.25,
    minY: 0.25,
    maxX: 0.75,
    maxY: 0.75,
    minZ: 100,
    maxZ: 101,
  });
  metadata.cube = {
    minX: -2,
    minY: -2,
    maxX: 1,
    maxY: 1,
    minZ: 100,
    maxZ: 103,
  };
  const nodeBounds = buildStreamingHierarchy(
    metadata,
    [
      {
        key: "0-0-0-0",
        level: 0,
        x: 0,
        y: 0,
        z: 0,
        pointCount: 1,
        pointDataOffset: 0,
        pointDataLength: 1,
      },
    ],
    5,
    grid,
  ).get("0-0-0-0");

  assert.equal(nodeBounds.center.height, 131.5);
  assert.deepEqual(
    [nodeBounds.bounds.minX, nodeBounds.bounds.minY],
    [-2, -2],
  );
  assert.ok(Math.abs(nodeBounds.bounds.maxX - 1) < 1e-12);
  assert.ok(Math.abs(nodeBounds.bounds.maxY - 1) < 1e-12);
  assert.equal(nodeBounds.bounds.minZ, 115);
  assert.equal(nodeBounds.bounds.maxZ, 148);

  const frame = createDatasetLocalFrame(metadata, 5, grid);
  const expectedOrigin = geographicToEcef({
    longitude: -0.5,
    latitude: -0.5,
    height: 131.5,
  });
  assert.deepEqual(
    [frame.origin.x, frame.origin.y, frame.origin.z],
    [expectedOrigin.x, expectedOrigin.y, expectedOrigin.z],
  );
});

test("only a vertical CRS authority on the outer WKT section can satisfy an EPSG source", async () => {
  const bytes = encodeGtx({ values: [10, 20, 30, 40] });
  const nestedAuthorityWkt = ORTHOMETRIC_WKT.replace(
    'VERT_DATUM["Local vertical datum",2005]',
    'VERT_DATUM["Local vertical datum",2005,AUTHORITY["EPSG","5703"]]',
  );
  const grid = await loadGrid(bytes, { sourceVerticalCrs: "EPSG:5703" });
  assert.throws(
    () =>
      createPointTransformer(
        createMetadata({ wkt: nestedAuthorityWkt }),
        0,
        grid,
      ),
    (error) =>
      error instanceof VerticalTransformError &&
      error.code === "unsupported-crs-pair",
  );

  const outerAuthorityWkt = nestedAuthorityWkt.replace(
    'AXIS["Gravity-related height",UP]]',
    'AXIS["Gravity-related height",UP],AUTHORITY["EPSG","5703"]]',
  );
  assert.equal(
    createPointTransformer(
      createMetadata({ wkt: outerAuthorityWkt }),
      0,
      grid,
    )({ x: 0.5, y: 0.5, z: 100 }).height,
    125,
  );
});

test("vertical grid transforms reject downward axes and authority-name conflicts", async () => {
  const bytes = encodeGtx({ values: [10, 20, 30, 40] });
  const downwardWkt = ORTHOMETRIC_WKT.replace(
    'AXIS["Gravity-related height",UP]',
    'AXIS["Depth",DOWN]',
  );
  const namedGrid = await loadGrid(bytes);
  assert.throws(
    () =>
      createPointTransformer(
        createMetadata({ wkt: downwardWkt }),
        0,
        namedGrid,
      ),
    (error) =>
      error instanceof VerticalTransformError &&
      error.code === "unsupported-crs-pair" &&
      /requires an UP axis/.test(error.message),
  );

  const authoritativeWkt = ORTHOMETRIC_WKT.replace(
    'AXIS["Gravity-related height",UP]]',
    'AXIS["Gravity-related height",UP],AUTHORITY["EPSG","5703"]]',
  );
  assert.throws(
    () =>
      createPointTransformer(
        createMetadata({ wkt: authoritativeWkt }),
        0,
        namedGrid,
      ),
    (error) =>
      error instanceof VerticalTransformError &&
      error.code === "unsupported-crs-pair",
  );
});

test("vertical grid transforms accept the documented ESRI WGS 84 datum alias", async () => {
  const bytes = encodeGtx({ values: [10, 20, 30, 40] });
  const esriWkt = ORTHOMETRIC_WKT.replace(
    'DATUM["WGS_1984",SPHEROID["WGS 84"',
    'DATUM["D_WGS_1984",SPHEROID["WGS_1984"',
  );
  const grid = await loadGrid(bytes);

  assert.equal(
    createPointTransformer(createMetadata({ wkt: esriWkt }), 0, grid)({
      x: 0.5,
      y: 0.5,
      z: 100,
    }).height,
    125,
  );
});

test("configured source CRS must match COPC WKT and range bounds include grid extrema", async () => {
  const grid = await loadGrid(encodeGtx({ values: [10, 20, 30, 40] }));
  const mismatchedGrid = await loadGrid(encodeGtx({ values: [10, 20, 30, 40] }), {
    sourceVerticalCrs: "EPSG:3855",
  });
  assert.throws(
    () => createPointTransformer(createMetadata({ wkt: 'GEOGCS["WGS 84"]' }), 0, mismatchedGrid),
    (error) => error instanceof VerticalTransformError && error.code === "missing-vertical-crs",
  );
  assert.throws(
    () => createPointTransformer(createMetadata(), 0, mismatchedGrid),
    (error) => error instanceof VerticalTransformError && error.code === "unsupported-crs-pair",
  );
  assert.throws(
    () => createPointTransformer(createMetadata({
      wkt: ORTHOMETRIC_WKT.replace('DATUM["WGS_1984"', 'DATUM["NAD83"'),
    }), 0, grid),
    (error) => error instanceof VerticalTransformError && error.code === "incompatible-reference-frame",
  );
  const missingUnitWkt = ORTHOMETRIC_WKT.replace(',UNIT["metre",1],AXIS["Gravity-related height",UP]', ',AXIS["Gravity-related height",UP]');
  assert.throws(
    () => createPointTransformer(createMetadata({ wkt: missingUnitWkt }), 0, grid),
    (error) => error instanceof VerticalTransformError && error.code === "unsupported-crs-pair",
  );

  const metadata = createMetadata();
  assert.deepEqual(getDatasetElevationRange(metadata, 5, grid), {
    min: 115,
    max: 245,
  });
  const node = {
    key: "0-0-0-0",
    level: 0,
    x: 0,
    y: 0,
    z: 0,
    pointCount: 1,
    pointDataOffset: 0,
    pointDataLength: 1,
  };
  const hierarchyMetadata = {
    ...metadata,
    cube: { minX: 0, minY: 0, minZ: 100, maxX: 1, maxY: 1, maxZ: 101 },
  };
  const hierarchy = buildStreamingHierarchy(hierarchyMetadata, [node], 5, grid);
  const preparedNode = hierarchy.get(node.key);
  assert.equal(preparedNode.center.height, 130.5);
  assert.equal(preparedNode.bounds.minZ, 115);
  assert.equal(preparedNode.bounds.maxZ, 146);
});
