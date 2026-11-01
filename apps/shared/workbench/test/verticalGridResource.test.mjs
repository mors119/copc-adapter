import assert from "node:assert/strict";
import test from "node:test";
import {
  createNgaEgm2008ResourceRegistry,
  createPointVerticalReferenceContext,
  getVerticalGridResourceDetails,
  isSupportedEgm2008Grid,
  NGA_EGM2008_FILE_BYTES,
  NGA_EGM2008_GRID_ID,
  NGA_EGM2008_MAX_GRID_BYTES,
  NGA_EGM2008_SHA256,
  OSGEO_EGM2008_FILE_BYTES,
  OSGEO_EGM2008_GRID_ID,
  OSGEO_EGM2008_SHA256,
} from "../verticalGridResource.ts";

function validGrid(overrides = {}) {
  return {
    gridId: NGA_EGM2008_GRID_ID,
    sha256: NGA_EGM2008_SHA256,
    sourceVerticalCrs: "EPSG:3855",
    targetVerticalCrs: "EPSG:4979",
    horizontalCrs: "EPSG:4326",
    referenceEllipsoid: "WGS84",
    valueUnit: "metre",
    valueConvention: "ellipsoidal-minus-orthometric",
    interpolation: "bilinear",
    noDataValue: null,
    width: 8640,
    height: 4321,
    longitudeOrigin: 0,
    latitudeOrigin: -90,
    longitudeStep: 2.5 / 60,
    latitudeStep: 2.5 / 60,
    encodedByteLength: NGA_EGM2008_FILE_BYTES,
    decodedByteLength: 8640 * 4321 * 4,
    globalLongitudeCoverage: "periodic",
    sampleUndulation() { return -32.16; },
    ...overrides,
  };
}

function validOsgeoGrid(overrides = {}) {
  return validGrid({
    gridId: OSGEO_EGM2008_GRID_ID,
    sha256: OSGEO_EGM2008_SHA256,
    longitudeOrigin: -180,
    encodedByteLength: OSGEO_EGM2008_FILE_BYTES,
    ...overrides,
  });
}

test("registers only the public loader result with the exact pinned NGA operation", async () => {
  const grid = validGrid();
  let observedOptions;
  const registry = createNgaEgm2008ResourceRegistry(async (file, options) => {
    assert.equal(file.size, NGA_EGM2008_FILE_BYTES);
    observedOptions = options;
    return grid;
  });
  const loaded = await registry.loadFile({ size: NGA_EGM2008_FILE_BYTES });

  assert.equal(loaded, grid);
  assert.deepEqual(observedOptions, { maxGridBytes: NGA_EGM2008_MAX_GRID_BYTES });
  assert.equal(registry.hostValidators.isLoadedVerticalGrid(loaded), true);
  assert.equal(registry.hostValidators.isLoadedVerticalGrid(validGrid()), false);
  assert.equal(isSupportedEgm2008Grid(loaded), true);
});

test("loads the pinned OSGeo GTX profile with explicit CRS, units, digest, and memory bounds", async () => {
  const grid = validOsgeoGrid();
  let observedOptions;
  const registry = createNgaEgm2008ResourceRegistry(
    async () => assert.fail("The NGA raw loader must not receive an OSGeo GTX"),
    async (file, options) => {
      assert.equal(file.size, OSGEO_EGM2008_FILE_BYTES);
      observedOptions = options;
      return grid;
    },
  );
  const loaded = await registry.loadFile({ size: OSGEO_EGM2008_FILE_BYTES });

  assert.equal(loaded, grid);
  assert.equal(observedOptions.gridId, OSGEO_EGM2008_GRID_ID);
  assert.equal(observedOptions.sourceVerticalCrs, "EPSG:3855");
  assert.equal(observedOptions.targetVerticalCrs, "EPSG:4979");
  assert.equal(observedOptions.valueUnit, "metre");
  assert.equal(observedOptions.valueConvention, "ellipsoidal-minus-orthometric");
  assert.equal(observedOptions.interpolation, "bilinear");
  assert.equal(observedOptions.noDataValue, null);
  assert.equal(observedOptions.sha256, OSGEO_EGM2008_SHA256);
  assert.equal(observedOptions.maxGridBytes, NGA_EGM2008_MAX_GRID_BYTES);
  assert.equal(registry.hostValidators.isLoadedVerticalGrid(loaded), true);
  assert.equal(isSupportedEgm2008Grid(loaded), true);
});

test("rejects wrong file size before invoking the loader and rejects wrong loader metadata", async () => {
  let calls = 0;
  const registry = createNgaEgm2008ResourceRegistry(async () => {
    calls += 1;
    return validGrid({ sourceVerticalCrs: "EPSG:5703" });
  });

  await assert.rejects(
    registry.loadFile({ size: 128 }),
    /149,368,328 bytes/u,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    registry.loadFile({ size: NGA_EGM2008_FILE_BYTES }),
    /outside the host's registered EGM2008 operations/u,
  );
  assert.equal(registry.hostValidators.isLoadedVerticalGrid(validGrid()), false);
});

test("rejects OSGeo loader results with invalid metadata or coverage", async (t) => {
  const invalidProfiles = [
    ["wrong digest", { sha256: "0".repeat(64) }],
    ["wrong source CRS", { sourceVerticalCrs: "EPSG:5703" }],
    ["wrong target CRS", { targetVerticalCrs: "EPSG:3855" }],
    ["wrong units", { valueUnit: "foot" }],
    ["wrong value convention", { valueConvention: "orthometric-minus-ellipsoidal" }],
    ["unexpected coordinate epoch", { sourceCoordinateEpoch: 2020 }],
    ["unexpected grid reference epoch", { gridReferenceEpoch: 2020 }],
    ["NoData sentinel", { noDataValue: -9999 }],
    ["out-of-bounds extent", { latitudeOrigin: -89.9 }],
    ["missing grid identity", { gridId: undefined }],
    ["missing sampler", { sampleUndulation: undefined }],
  ];

  for (const [label, overrides] of invalidProfiles) {
    await t.test(label, async () => {
      const registry = createNgaEgm2008ResourceRegistry(
        async () => assert.fail("The NGA raw loader must not receive an OSGeo GTX"),
        async () => validOsgeoGrid(overrides),
      );
      await assert.rejects(
        registry.loadFile({ size: OSGEO_EGM2008_FILE_BYTES }),
        /outside the host's registered EGM2008 operations/u,
      );
    });
  }
});

test("summarizes the pinned NGA model coverage, resource bounds, epoch, and source terms accurately", () => {
  const details = getVerticalGridResourceDetails(validGrid());
  assert.ok(details);
  assert.equal(details.sourceVerticalCrs, "EPSG:3855");
  assert.equal(details.targetVerticalCrs, "EPSG:4979");
  assert.match(details.extent, /longitude −180° to 180°.*latitude −90° to 90°/u);
  assert.match(details.dimensions, /8,640 × 4,321.*2.5 arc-minute/u);
  assert.match(details.memory, /142\.42 MiB decoded.*142\.45 MiB encoded.*284\.86 MiB combined.*160 MiB/u);
  assert.match(details.epoch, /no frame or epoch propagation/u);
  assert.match(details.licenseProvenance, /does not state redistribution terms/u);
  assert.equal(getVerticalGridResourceDetails(validGrid({ sha256: "0".repeat(64) })), undefined);
});

test("reports OSGeo public-domain provenance for its verified EGM2008 GTX", () => {
  const grid = validOsgeoGrid();
  const details = getVerticalGridResourceDetails(grid);
  assert.ok(details);
  assert.match(details.source, /OSGeo PROJ-DATUMGRID-WORLD.*NGA EGM2008/u);
  assert.match(details.licenseProvenance, /Public Domain/u);
  assert.match(details.licenseProvenance, /GeographicLib/u);
  assert.equal(getVerticalGridResourceDetails(validOsgeoGrid({ sha256: "0".repeat(64) })), undefined);
});

test("builds point provenance from declared source metadata and keeps Terrain separate", () => {
  const reference = createPointVerticalReferenceContext(
    {
      crsDiagnostic: {
        vertical: {
          identity: { authority: "EPSG", code: "3855", name: "EGM2008 height" },
          units: { name: "metre", kind: "linear" },
          heightKind: { value: "gravity-related/orthometric", certainty: "explicit" },
        },
      },
    },
    validGrid(),
    4.5,
    -1.25,
  );
  assert.equal(reference.sourceVerticalCrs, "EPSG:3855 · EGM2008 height");
  assert.equal(reference.sourceVerticalUnits, "metre (linear)");
  assert.equal(reference.sourceHeightKind, "gravity-related/orthometric (explicit)");
  assert.equal(reference.grid?.sha256, NGA_EGM2008_SHA256);
  assert.equal(reference.heightOffsetMeters, 4.5);
  assert.equal(reference.terrainResidualMeters, -1.25);
});
