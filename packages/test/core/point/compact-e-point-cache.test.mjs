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
import { transformPointBufferToPreparedPointData } from "../../../core/coordinates/transform/createPointTransformer.ts";
import { getCompactEPreparedHeightBuffer } from "../../../core/point/compactEPointCache.ts";
import { prepareCopcPointColorBuffer } from "../../../core/point/style/pointStyle.ts";

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
  assert.equal(compact.preparedCompatibility.source, prepared.source);
  assert.equal(compact.preparedCompatibility.geographic, prepared.geographic);
  assert.equal(compact.preparedCompatibility.world, prepared.world);
  assert.equal(compact.provenance.sourceIdentity, "memory://compact-e.copc.laz");
  assert.equal(compact.provenance.transformGeneration, 7);
  assert.deepEqual(compact.provenance.verticalDatum, {
    status: "no-validated-grid-correction",
  });
});

test("legacy reads preserve exact Source, Geographic, ECEF, height, and aliases", () => {
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
  assert.equal(restored, compact.preparedCompatibility);
  assert.deepEqual(
    [...restored.source.coordinates],
    [...prepared.source.coordinates],
  );
  assert.equal(restored.source.coordinates, prepared.source.coordinates);
  assert.equal(restored.geographic.coordinates, prepared.geographic.coordinates);
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
    assert.equal(
      restored.geographic.coordinates[offset],
      prepared.geographic.coordinates[offset],
    );
    assert.equal(
      restored.geographic.coordinates[offset + 1],
      prepared.geographic.coordinates[offset + 1],
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

test("E preserves exact coordinates for negative, high, polar, date-line, and extreme finite points", () => {
  const sourceCoordinates = new Float64Array([
    137, 90, -550,
    -180, -89.999999, 100000,
    179.999999999, 0.000001, 20000000,
    -45, 89.5, -6300000,
  ]);
  const metadata = {
    bounds: {
      minX: -180,
      minY: -90,
      minZ: -6_300_000,
      maxX: 180,
      maxY: 90,
      maxZ: 20_000_000,
    },
  };
  const prepared = transformPointBufferToPreparedPointData(metadata, {
    pointCount: 4,
    coordinates: sourceCoordinates,
  });
  const compact = createCompactEPointCacheNode(prepared, {
    nodeKey: "pole-dateline-precision",
    provenance: provenance(),
  });
  const restored = compactEPointCacheNodeToPreparedPointData(compact);

  assert.ok(compact.ecef instanceof Float64Array);
  assert.ok(compact.height instanceof Float64Array);
  assert.deepEqual([...restored.source.coordinates], [...prepared.source.coordinates]);
  for (let pointIndex = 0; pointIndex < prepared.pointCount; pointIndex += 1) {
    const offset = pointIndex * 3;
    assert.deepEqual(
      [...compact.ecef.slice(offset, offset + 3)],
      [...prepared.world.coordinates.slice(offset, offset + 3)],
    );
    assert.equal(
      compact.height[pointIndex],
      prepared.geographic.coordinates[offset + 2],
    );
    assert.deepEqual(
      [...restored.geographic.coordinates.slice(offset, offset + 3)],
      [...prepared.geographic.coordinates.slice(offset, offset + 3)],
    );
  }
  assert.equal(compact.provenance.sourceIdentity, "memory://compact-e.copc.laz");
});

test("E byte accounting counts compatibility coordinates and shared aliases once", () => {
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
    compact.pointCount * 80 + attributeBytes,
  );
  assert.equal(
    estimateDecodedCpuPointBufferBytes({ compact, ecefAlias: compact.ecef }),
    compact.pointCount * 80 + attributeBytes,
  );
});

test("E elevation colors match A across repeated narrow and palette-boundary ranges", () => {
  const spans = [10, 100, 1000];
  const heights = spans.flatMap((span) => {
    const values = [0, span];
    for (const fraction of [0.25, 0.5, 0.75]) {
      const boundary = span * fraction;
      const epsilon = Number.EPSILON * Math.max(1, Math.abs(boundary));
      values.push(boundary - epsilon, boundary, boundary + epsilon);
    }
    return values;
  });
  const sourceCoordinates = new Float64Array(heights.length * 3);
  const geographicCoordinates = new Float64Array(heights.length * 3);
  const worldCoordinates = new Float64Array(heights.length * 3);
  const attributes = {
    red: new Uint16Array(heights.length).fill(65535),
    green: new Uint16Array(heights.length).fill(32768),
    blue: new Uint16Array(heights.length).fill(1),
    intensity: Uint16Array.from(heights, (_, index) => index * 100),
    classification: Uint8Array.from(heights, (_, index) => index % 4),
  };
  for (let pointIndex = 0; pointIndex < heights.length; pointIndex += 1) {
    const offset = pointIndex * 3;
    const height = heights[pointIndex];
    geographicCoordinates.set([127, 38, height], offset);
    sourceCoordinates.set([pointIndex, pointIndex + 1, -pointIndex], offset);
    const world = geographicToEcef({ longitude: 127, latitude: 38, height });
    worldCoordinates.set([world.x, world.y, world.z], offset);
  }
  const prepared = createPreparedPointData({
    pointCount: heights.length,
    sourceCoordinates,
    geographicCoordinates,
    worldCoordinates,
    attributes,
  });
  const compact = createCompactEPointCacheNode(prepared, {
    nodeKey: "elevation-boundaries",
    provenance: provenance(),
  });
  const compactView = compactEPointCacheNodeToPreparedPointData(compact);
  const compactHeights = getCompactEPreparedHeightBuffer(compactView);

  assert.ok(compactHeights instanceof Float64Array);
  for (let pointIndex = 0; pointIndex < compact.pointCount; pointIndex += 1) {
    assert.equal(compactHeights[pointIndex], compact.height[pointIndex]);
  }

  const styles = [
    { colorMode: "fixed" },
    { colorMode: "rgb", rgbMax: 65535 },
    { colorMode: "intensity", intensityRange: { min: 0, max: 1000 } },
    { colorMode: "classification" },
    ...spans.map((span) => ({
      colorMode: "elevation",
      elevationRange: { min: 0, max: span },
    })),
    { colorMode: "elevation", elevationRange: { min: 100, max: 100.001 } },
    { colorMode: "elevation", elevationRange: { min: -1, max: 1 } },
  ];
  for (const style of styles) {
    const colorsA = prepareCopcPointColorBuffer(prepared, style);
    const colorsE = prepareCopcPointColorBuffer(compactView, style);
    assert.deepEqual([...colorsE], [...colorsA], style.colorMode);
  }

  const filteredIndicesA = [...prepared.attributes.classification.keys()].filter(
    (index) => prepared.attributes.classification[index] === 2,
  );
  const filteredIndicesE = [...compactView.attributes.classification.keys()].filter(
    (index) => compactView.attributes.classification[index] === 2,
  );
  assert.deepEqual(filteredIndicesE, filteredIndicesA);
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
