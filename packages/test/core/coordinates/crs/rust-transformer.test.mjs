import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { RustCrsTransformer } from "../../../../core/coordinates/transform/rustCrsTransformer.ts";
import { createPointTransformer } from "../../../../core/coordinates/transform/createPointTransformer.ts";
import { geographicToEcef } from "../../../../core/coordinates/transform/worldCoordinates.ts";
import { getCopcWasmBinary } from "../../../../core/wasm/copcWasm.ts";
import { loadCopcWasmWorker } from "../../../../core/wasm/copcWasmWorker.ts";
import { createPreparedPointData } from "../../../../core/point/preparedPoint.ts";
import { createCompactEPointCacheNode } from "../../../../core/point/compactEPointCache.ts";
import {
  applyPreparedPointVerticalGrid,
  transformPointBufferToPreparedPointData,
} from "../../../../core/coordinates/transform/createPointTransformer.ts";
import { loadGtxGeoidGrid } from "../../../../core/coordinates/transform/verticalGrid.ts";

const WGS84_GEOGRAPHIC_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';

test("Rust CRS WASM worker loader supplies the proj4rs imports", async () => {
  const wasm = await loadCopcWasmWorker(await getCopcWasmBinary());
  const wktBytes = new TextEncoder().encode(WGS84_GEOGRAPHIC_WKT);
  const wktPointer = wasm.alloc_bytes(wktBytes.byteLength);
  new Uint8Array(wasm.memory.buffer, wktPointer, wktBytes.byteLength).set(
    wktBytes,
  );

  try {
    const responsePointer = wasm.create_crs_transform_json(
      wktPointer,
      wktBytes.byteLength,
    );
    const responseBytes = new Uint8Array(wasm.memory.buffer);
    let responseEnd = responsePointer;
    while (responseBytes[responseEnd] !== 0) responseEnd += 1;
    const response = JSON.parse(
      new TextDecoder().decode(
        responseBytes.subarray(responsePointer, responseEnd),
      ),
    );
    assert.equal(response.ok, true);
    wasm.free_crs_transform(response.value.handle);
    wasm.free_parser_json(responsePointer);
  } finally {
    wasm.dealloc_bytes(wktPointer, wktBytes.byteLength);
  }
});

test("Rust CRS transformer reuses a WASM handle for geographic and ECEF buffers", async () => {
  const transformer = await RustCrsTransformer.fromMetadata({
    wkt: WGS84_GEOGRAPHIC_WKT,
    bounds: { minX: 10, minY: 20, minZ: 0, maxX: 11, maxY: 21, maxZ: 100 },
  });

  try {
    const first = transformer.transform(new Float64Array([10.25, 20.5, 100]));
    const second = transformer.transform(new Float64Array([10.75, 20.75, 200]));

    assert.equal(first.pointCount, 1);
    assert.equal(second.pointCount, 1);
    assert.ok(Math.abs(first.geographicCoordinates[0] - 10.25) < 1e-12);
    assert.ok(Math.abs(first.geographicCoordinates[1] - 20.5) < 1e-12);
    assert.equal(first.geographicCoordinates[2], 100);
    assert.ok(first.ecefCoordinates.every(Number.isFinite));
    const reference = geographicToEcef({
      longitude: 10.25,
      latitude: 20.5,
      height: 100,
    });
    assert.ok(Math.abs(first.ecefCoordinates[0] - reference.x) < 1e-6);
    assert.ok(Math.abs(first.ecefCoordinates[1] - reference.y) < 1e-6);
    assert.ok(Math.abs(first.ecefCoordinates[2] - reference.z) < 1e-6);
    assert.equal(first.usedHorizontalFallback, false);
  } finally {
    transformer.dispose();
  }
});

test("Rust and JavaScript apply the same offset to a geographic-height fixture", async () => {
  const metadata = {
    bounds: { minX: 10, minY: 20, minZ: 0, maxX: 11, maxY: 21, maxZ: 100 },
  };
  const sourcePoint = { x: 10.25, y: 20.5, z: 100 };
  const offset = -13.75;
  const rust = await RustCrsTransformer.fromMetadata(metadata, offset);
  try {
    const prepared = rust.transform(
      new Float64Array([sourcePoint.x, sourcePoint.y, sourcePoint.z]),
    );
    const javaScript = createPointTransformer(metadata, offset)(sourcePoint);
    assert.equal(prepared.geographicCoordinates[2], javaScript.height);
    assert.equal(javaScript.height, 86.25);
    const reference = geographicToEcef(javaScript);
    assert.ok(Math.abs(prepared.ecefCoordinates[0] - reference.x) < 1e-6);
    assert.ok(Math.abs(prepared.ecefCoordinates[1] - reference.y) < 1e-6);
    assert.ok(Math.abs(prepared.ecefCoordinates[2] - reference.z) < 1e-6);
  } finally {
    rust.dispose();
  }
});

test("Rust CRS transformer preserves the projected-WKT requirement without hidden fallback", async () => {
  await assert.rejects(
    () =>
      RustCrsTransformer.fromMetadata({
        bounds: {
          minX: 1000,
          minY: 1000,
          minZ: 0,
          maxX: 1001,
          maxY: 1001,
          maxZ: 1,
        },
      }),
    (error) => error?.code === "missing-wkt",
  );
});

test("Rust/WASM and JavaScript agree on foot units after one shared synthetic geoid pass", async () => {
  const point = { x: 126.5, y: 37.5 };
  const spacedHorizontalWkt = WGS84_GEOGRAPHIC_WKT.replace("GEOGCS[", "GEOGCS [");
  const compoundWkt = `COMPD_CS["WGS 84 + Local orthometric height",${spacedHorizontalWkt},VERT_CS["Local orthometric height",VERT_DATUM["Local vertical datum",2005],UNIT ["foot", 0.3048,AUTHORITY["EPSG","9002"]],AXIS["Gravity-related height",UP]]]`;
  const metadata = {
    wkt: compoundWkt,
    bounds: {
      minX: point.x,
      minY: point.y,
      minZ: 100,
      maxX: point.x,
      maxY: point.y,
      maxZ: 100,
    },
    cube: {
      minX: point.x,
      minY: point.y,
      minZ: 100,
      maxX: point.x,
      maxY: point.y,
      maxZ: 100,
    },
    pointCount: 1,
  };
  const sourceCoordinates = new Float64Array([point.x, point.y, 100]);
  const bytes = new ArrayBuffer(56);
  const gridHeader = new DataView(bytes);
  gridHeader.setFloat64(0, 37, false);
  gridHeader.setFloat64(8, 126, false);
  gridHeader.setFloat64(16, 1, false);
  gridHeader.setFloat64(24, 1, false);
  gridHeader.setInt32(32, 2, false);
  gridHeader.setInt32(36, 2, false);
  [10, 20, 30, 40].forEach((value, index) =>
    gridHeader.setFloat32(40 + index * 4, value, false),
  );
  const grid = await loadGtxGeoidGrid(bytes, {
    gridId: "synthetic-korea-parity-grid",
    sourceVerticalCrs: "Local orthometric height",
    targetVerticalCrs: "EPSG:4979",
    horizontalCrs: "EPSG:4326",
    referenceEllipsoid: "WGS84",
    sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
    valueUnit: "metre",
    valueConvention: "ellipsoidal-minus-orthometric",
    noDataValue: null,
  });
  const offset = 5;
  const javascript = transformPointBufferToPreparedPointData(
    metadata,
    { pointCount: 1, coordinates: sourceCoordinates },
    offset,
    grid,
  );
  const rustTransformer = await RustCrsTransformer.fromMetadata(metadata, offset);
  try {
    const rustRaw = rustTransformer.transform(sourceCoordinates);
    const rustPrepared = createPreparedPointData({
      pointCount: 1,
      sourceCoordinates: sourceCoordinates.slice(),
      geographicCoordinates: rustRaw.geographicCoordinates,
      worldCoordinates: rustRaw.ecefCoordinates,
    });
    const rustCorrected = applyPreparedPointVerticalGrid(rustPrepared, grid);
    assert.equal(rustCorrected.geographic.coordinates[2], javascript.geographic.coordinates[2]);
    assert.equal(rustCorrected.geographic.coordinates[2], 60.480000000000004);
    for (let axis = 0; axis < 3; axis += 1) {
      assert.ok(
        Math.abs(rustCorrected.world.coordinates[axis] - javascript.world.coordinates[axis]) < 1e-6,
        `Rust/JS geoid-corrected ECEF axis ${axis} should match`,
      );
    }
    assert.deepEqual([...rustCorrected.source.coordinates], [...sourceCoordinates]);

    const provenance = {
      sourceIdentity: "memory://rust-js-e-cache-parity.copc.laz",
      sourceCrsWkt: compoundWkt,
      transformGeneration: 12,
      heightOffsetMeters: offset,
      verticalDatum: {
        status: "validated-grid-applied",
        gridId: grid.gridId,
        sha256: grid.sha256,
        sourceVerticalCrs: grid.sourceVerticalCrs,
        targetVerticalCrs: "EPSG:4979",
        valueUnit: grid.valueUnit,
      },
    };
    const rustE = createCompactEPointCacheNode(rustCorrected, {
      nodeKey: "0-0-0-0",
      provenance,
    });
    const javascriptE = createCompactEPointCacheNode(javascript, {
      nodeKey: "0-0-0-0",
      provenance,
    });
    assert.ok(rustE.ecef instanceof Float64Array);
    assert.ok(javascriptE.ecef instanceof Float64Array);
    assert.ok(rustE.height instanceof Float64Array);
    assert.ok(javascriptE.height instanceof Float64Array);
    assert.equal(rustE.nodeKey, javascriptE.nodeKey);
    assert.equal(rustE.pointCount, javascriptE.pointCount);
    assert.deepEqual([...rustE.height], [...javascriptE.height]);
    assert.deepEqual([...rustE.height], [rustCorrected.geographic.coordinates[2]]);
    for (let axis = 0; axis < rustE.ecef.length; axis += 1) {
      assert.ok(
        Math.abs(rustE.ecef[axis] - javascriptE.ecef[axis]) < 1e-6,
        `Rust/JS E cache ECEF axis ${axis} should match`,
      );
    }
  } finally {
    rustTransformer.dispose();
  }
});
