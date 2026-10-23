import test from "node:test";
import assert from "node:assert/strict";

import {
  cachedPointDataToPreparedPointData,
  compactEPointCacheNodeToPreparedPointData,
  createCompactEPointCacheNode,
} from "../../../core/point/compactEPointCache.ts";
import { createPreparedPointData } from "../../../core/point/preparedPoint.ts";
import {
  createNodePointCache,
  estimateDecodedCpuPointBufferBytes,
} from "../../../core/streaming/createNodePointCache.ts";
import { geographicToEcef } from "../../../core/coordinates/transform/worldCoordinates.ts";

function preparedFixture() {
  const sourceCoordinates = new Float64Array([
    100.25, 200.5, -300.75,
    101.25, 201.5, -301.75,
    102.25, 202.5, -302.75,
  ]);
  const geographicCoordinates = new Float64Array([
    127, 38, 0,
    -122.4, 47.2, 240.0000000003,
    179.9, -65.2, -120.125,
  ]);
  const worldCoordinates = new Float64Array(geographicCoordinates.length);
  for (let pointIndex = 0; pointIndex < geographicCoordinates.length / 3; pointIndex += 1) {
    const offset = pointIndex * 3;
    const world = geographicToEcef({
      longitude: geographicCoordinates[offset],
      latitude: geographicCoordinates[offset + 1],
      height: geographicCoordinates[offset + 2],
    });
    worldCoordinates.set([world.x, world.y, world.z], offset);
  }
  const attributes = {
    intensity: new Uint16Array([10, 20, 30]),
    classification: new Uint8Array([2, 5, 6]),
    red: new Uint16Array([100, 200, 300]),
    green: new Uint16Array([101, 201, 301]),
    blue: new Uint16Array([102, 202, 302]),
    extraDimensions: { returnNumber: new Uint8Array([1, 2, 3]) },
  };
  return createPreparedPointData({
    pointCount: 3,
    sourceCoordinates,
    geographicCoordinates,
    worldCoordinates,
    attributes,
  });
}

function provenance(overrides = {}) {
  return {
    sourceIdentity: "memory://compact-e.copc.laz",
    sourceCrsWkt: "source WKT retained as provenance",
    transformGeneration: 7,
    heightOffsetMeters: 2.5,
    verticalDatum: { status: "no-validated-grid-correction" },
    ...overrides,
  };
}

test("E stores 3 ECEF F64 values and one prepared-height F64 value per point", () => {
  const prepared = preparedFixture();
  const compact = createCompactEPointCacheNode(prepared, {
    nodeKey: "2-1-0-3",
    provenance: provenance(),
  });

  assert.equal(compact.layout, "E");
  assert.equal(compact.nodeKey, "2-1-0-3");
  assert.equal(compact.pointCount, 3);
  assert.equal(compact.ecef, prepared.world.coordinates);
  assert.equal(compact.ecef.length, compact.pointCount * 3);
  assert.ok(compact.height instanceof Float64Array);
  assert.equal(compact.height.length, compact.pointCount);
  assert.deepEqual(
    [...compact.height],
    [0, 240.0000000003, -120.125],
  );
  assert.equal(compact.ecef.byteLength / compact.pointCount, 24);
  assert.equal(compact.height.byteLength / compact.pointCount, 8);
  assert.equal(
    (compact.ecef.byteLength + compact.height.byteLength) /
      compact.pointCount,
    32,
  );
  assert.equal(compact.attributes, prepared.attributes);
  assert.equal(compact.statistics, prepared.statistics);
  assert.equal(compact.sourceCompatibility, prepared.source.coordinates);
  assert.equal(compact.provenance.sourceIdentity, "memory://compact-e.copc.laz");
  assert.equal(compact.provenance.transformGeneration, 7);
  assert.deepEqual(compact.provenance.verticalDatum, {
    status: "no-validated-grid-correction",
  });
});

test("legacy materialization preserves exact Source, ECEF, height, aliases, and attributes", () => {
  const prepared = preparedFixture();
  const compact = createCompactEPointCacheNode(prepared, {
    nodeKey: "2-1-0-3",
    provenance: provenance({
      verticalDatum: {
        status: "validated-grid-applied",
        gridId: "test-grid",
        sha256: "a".repeat(64),
        sourceVerticalCrs: "EPSG:5773",
        targetVerticalCrs: "EPSG:4979",
        valueUnit: "metre",
      },
    }),
  });

  const restored = compactEPointCacheNodeToPreparedPointData(compact);
  assert.notEqual(restored.geographic.coordinates, prepared.geographic.coordinates);
  assert.deepEqual(
    [...restored.source.coordinates],
    [...prepared.source.coordinates],
  );
  assert.equal(restored.source.coordinates, compact.sourceCompatibility);
  assert.equal(restored.world.coordinates, compact.ecef);
  assert.equal(restored.coordinates, restored.geographic.coordinates);
  assert.equal(restored.sourceCoordinates, restored.source.coordinates);
  assert.equal(restored.worldCoordinates, restored.world.coordinates);
  assert.equal(restored.attributes, prepared.attributes);
  assert.equal(restored.statistics, prepared.statistics);

  for (let pointIndex = 0; pointIndex < compact.pointCount; pointIndex += 1) {
    const offset = pointIndex * 3;
    assert.equal(
      restored.geographic.coordinates[offset + 2],
      prepared.geographic.coordinates[offset + 2],
    );
    assert.ok(
      Math.abs(
        restored.geographic.coordinates[offset] -
          prepared.geographic.coordinates[offset],
      ) < 1e-10,
    );
    assert.ok(
      Math.abs(
        restored.geographic.coordinates[offset + 1] -
          prepared.geographic.coordinates[offset + 1],
      ) < 1e-10,
    );
  }
  assert.deepEqual(compact.provenance.verticalDatum, {
    status: "validated-grid-applied",
    gridId: "test-grid",
    sha256: "a".repeat(64),
    sourceVerticalCrs: "EPSG:5773",
    targetVerticalCrs: "EPSG:4979",
    valueUnit: "metre",
  });
});

test("legacy geographic materialization is approximate at poles and retains exact height", () => {
  const geographicCoordinates = new Float64Array([
    137, 90, 123.123456789123,
    180, 0, 1.234567890123,
    179.999999999, 0.000001, 0.123456789123,
  ]);
  const worldCoordinates = new Float64Array(geographicCoordinates.length);
  for (let pointIndex = 0; pointIndex < geographicCoordinates.length / 3; pointIndex += 1) {
    const offset = pointIndex * 3;
    const world = geographicToEcef({
      longitude: pointIndex === 0 ? 0 : geographicCoordinates[offset],
      latitude: geographicCoordinates[offset + 1],
      height: geographicCoordinates[offset + 2],
    });
    worldCoordinates.set(
      [pointIndex === 0 ? 0 : world.x, pointIndex === 0 ? 0 : world.y, world.z],
      offset,
    );
  }
  const prepared = createPreparedPointData({
    pointCount: 3,
    sourceCoordinates: new Float64Array(9),
    geographicCoordinates,
    worldCoordinates,
  });
  const compact = createCompactEPointCacheNode(prepared, {
    nodeKey: "pole-dateline-precision",
    provenance: provenance(),
  });
  const restored = compactEPointCacheNodeToPreparedPointData(compact);

  // Pole longitude has no unique inverse; the conversion utility chooses zero.
  assert.equal(restored.geographic.coordinates[0], 0);
  assert.equal(restored.geographic.coordinates[1], 90);
  // Dateline values stay near their source representation, including the sign.
  assert.equal(restored.geographic.coordinates[3], 180);
  // The explicit F64 height buffer avoids inverse-height roundoff.
  for (let pointIndex = 0; pointIndex < prepared.pointCount; pointIndex += 1) {
    const offset = pointIndex * 3;
    assert.equal(
      restored.geographic.coordinates[offset + 2],
      prepared.geographic.coordinates[offset + 2],
    );
  }
  // Away from the pole, longitude/latitude reconstruction is close but not an
  // exact substitute for the original geographic transform result.
  assert.notEqual(
    restored.geographic.coordinates[6],
    prepared.geographic.coordinates[6],
  );
  assert.ok(
    Math.abs(
      restored.geographic.coordinates[6] - prepared.geographic.coordinates[6],
    ) < 1e-10,
  );
});

test("E byte accounting counts the compatibility Source sidecar once and attributes separately", () => {
  const prepared = preparedFixture();
  const compact = createCompactEPointCacheNode(prepared, {
    nodeKey: "2-1-0-3",
    provenance: provenance(),
  });
  const attributeBytes = Object.values(prepared.attributes)
    .filter((value) => ArrayBuffer.isView(value))
    .reduce((total, value) => total + value.byteLength, 0) +
    prepared.attributes.extraDimensions.returnNumber.byteLength;

  assert.equal(
    estimateDecodedCpuPointBufferBytes(compact),
    compact.pointCount * 56 + attributeBytes,
  );
  assert.equal(
    estimateDecodedCpuPointBufferBytes({ compact, ecefAlias: compact.ecef }),
    compact.pointCount * 56 + attributeBytes,
  );
});

test("compact E values follow the existing node-cache delete and clear lifecycle", async () => {
  const prepared = preparedFixture();
  const compact = createCompactEPointCacheNode(prepared, {
    nodeKey: "2-1-0-3",
    provenance: provenance(),
  });
  const bytes = estimateDecodedCpuPointBufferBytes(compact);
  const cache = createNodePointCache(async () => compact, {
    maxEntries: 2,
    maxBytes: bytes * 2,
  });

  await cache.load(compact.nodeKey);
  assert.equal(cache.get(compact.nodeKey), compact);
  assert.equal(cache.getDiagnostics().currentCacheBytes, bytes);
  cache.delete(compact.nodeKey);
  assert.equal(cache.get(compact.nodeKey), undefined);
  assert.equal(cache.getDiagnostics().currentCacheBytes, 0);

  await cache.load(compact.nodeKey);
  assert.equal(cache.getSize(), 1);
  cache.clear();
  assert.equal(cache.getSize(), 0);
  assert.equal(cache.get(compact.nodeKey), undefined);
  assert.equal(cache.getDiagnostics().currentCacheBytes, 0);
});

test("cache layout adapter passes production A entries through unchanged", () => {
  const prepared = preparedFixture();
  assert.equal(cachedPointDataToPreparedPointData(prepared), prepared);
});
