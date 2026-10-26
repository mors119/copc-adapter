import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { resolveCopcCrsMetadata } from "../../../core/coordinates/crs/copcCrsMetadata.ts";
import {
  createCoordinateTransformPlan,
  getCoordinateTransformPlan,
} from "../../../core/coordinates/transform/coordinateTransformPlan.ts";
import {
  createPointTransformer,
  createProjectPointTransformer,
} from "../../../core/coordinates/transform/createPointTransformer.ts";
import { loadGtxGeoidGrid } from "../../../core/coordinates/transform/verticalGrid.ts";

const ORTHOMETRIC_WKT =
  'COMPD_CS["WGS 84 + Local orthometric height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],VERT_CS["Local orthometric height",VERT_DATUM["Local vertical datum",2005],UNIT["metre",1],AXIS["Gravity-related height",UP]]]';

function createMetadata({ wkt = ORTHOMETRIC_WKT, ...bounds } = {}) {
  const extent = {
    minX: bounds.minX ?? 0,
    minY: bounds.minY ?? 0,
    minZ: bounds.minZ ?? 100,
    maxX: bounds.maxX ?? 1,
    maxY: bounds.maxY ?? 1,
    maxZ: bounds.maxZ ?? 200,
  };
  return {
    pointCount: 1,
    wkt,
    bounds: extent,
    cube: extent,
    scale: { x: 0.01, y: 0.01, z: 0.01 },
    offset: { x: 100, y: 200, z: 300 },
    crsWktProvenance: { selected: "vlr", available: ["vlr"], conflicting: false },
  };
}

function encodeGrid() {
  const bytes = new ArrayBuffer(56);
  const view = new DataView(bytes);
  view.setFloat64(0, 0, false);
  view.setFloat64(8, 100, false);
  view.setFloat64(16, 1, false);
  view.setFloat64(24, 1, false);
  view.setInt32(32, 2, false);
  view.setInt32(36, 2, false);
  [10, 20, 30, 40].forEach((value, index) => view.setFloat32(40 + index * 4, value, false));
  return bytes;
}

function digest(bytes) {
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

async function createGrid(overrides = {}) {
  const bytes = encodeGrid();
  return loadGtxGeoidGrid(bytes, {
    gridId: "synthetic-transform-plan-grid",
    sourceVerticalCrs: "Local orthometric height",
    targetVerticalCrs: "EPSG:4979",
    horizontalCrs: "EPSG:4326",
    referenceEllipsoid: "WGS84",
    sha256: digest(bytes),
    valueUnit: "metre",
    valueConvention: "ellipsoidal-minus-orthometric",
    noDataValue: null,
    sourceCoordinateEpoch: 2020,
    gridReferenceEpoch: 2020,
    ...overrides,
  });
}

test("records a frozen v1 plan in the canonical order and exposes it on both directions", () => {
  const metadata = createMetadata();
  const plan = createCoordinateTransformPlan(metadata, { heightOffsetMeters: -7.5 });
  const forward = createPointTransformer(metadata, -7.5);
  const inverse = createProjectPointTransformer(metadata, -7.5);

  assert.equal(plan.schema, "copc-coordinate-transform-plan");
  assert.equal(plan.version, 1);
  assert.deepEqual(
    plan.operations.map(({ name, order }) => [order, name]),
    [
      [0, "decode-las-scale-offset"],
      [1, "normalize-source-axes-and-units"],
      [2, "transform-horizontal-reference"],
      [3, "convert-vertical-datum"],
      [4, "apply-manual-height-offset"],
      [5, "apply-terrain-placement-residual"],
      [6, "prepare-wgs84-ecef"],
    ],
  );
  assert.equal(plan.operations[3].disposition, "not-configured");
  assert.equal(plan.operations[4].disposition, "configured");
  assert.equal(plan.operations[5].disposition, "viewer-owned");
  assert.equal(plan.terrainPlacementResidual.appliedByPlan, false);
  assert.equal(plan.source.verticalHeightKind.value, "gravity-related/orthometric");
  assert.equal(plan.target.verticalCrs.code, "4979");
  assert.equal(plan.target.worldCoordinateSystem, "wgs84-ecef-meters");
  assert.equal(plan.provenance.sourceWkt, ORTHOMETRIC_WKT);
  assert.equal(plan.identity.key, forward.plan.identity.key);
  assert.equal(plan.identity.key, inverse.plan.identity.key);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.operations));
  assert.ok(Object.isFrozen(plan.operations[0]));
  assert.ok(Object.isFrozen(forward.plan));
});

test("includes verified grid identity, coverage, epochs, and manual offset in the plan identity", async () => {
  const metadata = createMetadata();
  const grid = await createGrid();
  const plan = createCoordinateTransformPlan(metadata, {
    verticalGrid: grid,
    heightOffsetMeters: 4,
  });

  assert.equal(plan.verticalGrid.id, "synthetic-transform-plan-grid");
  assert.equal(plan.verticalGrid.sha256, grid.sha256);
  assert.equal(plan.verticalGrid.valueConvention, "ellipsoidal-minus-orthometric");
  assert.equal(plan.verticalGrid.noDataValue, null);
  assert.equal(plan.verticalGrid.compatibility, "validated");
  assert.deepEqual(plan.source.verticalUnitConversion, {
    scaleToMeters: 1,
    source: "validated-grid",
  });
  assert.deepEqual(plan.verticalGrid.longitude, { min: 100, max: 101, coverage: "none" });
  assert.deepEqual(plan.verticalGrid.latitude, { min: 0, max: 1 });
  assert.deepEqual(plan.epochs, {
    sourceCoordinateEpoch: 2020,
    gridReferenceEpoch: 2020,
    status: "matched",
  });
  assert.equal(plan.operations[3].disposition, "configured");
  assert.equal(plan.operations[4].disposition, "configured");
  assert.equal(plan.inverse.syntheticBoundsPolicy, "use-grid-extrema-without-sampling-synthetic-corners");
  assert.notEqual(
    plan.identity.key,
    createCoordinateTransformPlan(metadata, { verticalGrid: grid, heightOffsetMeters: 5 }).identity.key,
  );
  const feetGrid = await createGrid({ valueUnit: "international-foot" });
  assert.notEqual(
    plan.identity.key,
    createCoordinateTransformPlan(metadata, { verticalGrid: feetGrid, heightOffsetMeters: 4 }).identity.key,
  );

  const transformer = createPointTransformer(metadata, 4, grid);
  assert.equal(transformer.plan.verticalGrid.sha256, grid.sha256);

  const incompatible = createCoordinateTransformPlan(
    createMetadata({ wkt: ORTHOMETRIC_WKT.replaceAll("Local orthometric height", "Different local height") }),
    { verticalGrid: grid },
  );
  assert.equal(incompatible.verticalGrid.compatibility, "unsupported");
  assert.equal(incompatible.operations[3].disposition, "not-configured");
  assert.ok(incompatible.unsupportedReasons.some(({ code }) => code === "incompatible-grid-configuration"));
});

test("memoizes by metadata and transformation inputs while reflecting metadata changes", () => {
  const metadata = createMetadata();
  const first = getCoordinateTransformPlan(metadata, { heightOffsetMeters: 3 });
  assert.strictEqual(getCoordinateTransformPlan(metadata, { heightOffsetMeters: 3 }), first);
  assert.notStrictEqual(getCoordinateTransformPlan(metadata, { heightOffsetMeters: 4 }), first);

  metadata.offset.z += 1;
  const changed = getCoordinateTransformPlan(metadata, { heightOffsetMeters: 3 });
  assert.notStrictEqual(changed, first);
  assert.notEqual(changed.identity.key, first.identity.key);
});

test("reports unknown source vertical reference when no grid is configured", () => {
  const metadata = createMetadata({ wkt: undefined });
  metadata.wkt = undefined;
  metadata.crsDiagnostic = resolveCopcCrsMetadata(undefined);
  const plan = createCoordinateTransformPlan(metadata);

  assert.equal(plan.source.verticalHeightKind.value, "local/unknown");
  assert.equal(plan.source.horizontalResolution, "geographic-bounds-fallback");
  assert.equal(plan.source.horizontalCrs.certainty, "inferred");
  assert.ok(plan.unsupportedReasons.some(({ code }) => code === "unknown-vertical-reference"));
  assert.equal(plan.operations[3].disposition, "not-configured");
  assert.match(plan.operations[3].detail, /passed through/);
  assert.equal(plan.terrainPlacementResidual.appliedByPlan, false);
});

test("keeps a dynamic source epoch unresolved unless the grid operation supplies a matched epoch", async () => {
  const metadata = createMetadata({
    wkt: 'GEODCRS["Dynamic test CRS",DYNAMIC[FRAMEEPOCH[2020]],DATUM["Dynamic datum",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]],CS[ellipsoidal,2],AXIS["longitude",east,ANGLEUNIT["degree",0.0174532925199433]],AXIS["latitude",north,ANGLEUNIT["degree",0.0174532925199433]],ID["EPSG",4326]]',
  });
  const plan = createCoordinateTransformPlan(metadata);

  assert.equal(plan.epochs.status, "source-epoch-unresolved");
  assert.ok(plan.unsupportedReasons.some(({ code }) => code === "missing-coordinate-epoch"));
  assert.equal(plan.confidence, "partial");

  const compoundDynamicMetadata = createMetadata({
    wkt: ORTHOMETRIC_WKT.replace(
      'GEOGCS["WGS 84",',
      'GEOGCS["WGS 84",DYNAMIC[FRAMEEPOCH[2020]],',
    ),
  });
  const matched = createCoordinateTransformPlan(compoundDynamicMetadata, {
    verticalGrid: await createGrid(),
  });
  assert.equal(matched.verticalGrid.compatibility, "validated");
  assert.equal(matched.epochs.status, "matched");
  assert.ok(!matched.unsupportedReasons.some(({ code }) => code === "missing-coordinate-epoch"));
});
