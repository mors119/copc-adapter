import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectCopcPoint,
  isCopcPointPickId,
} from "../../../../core/copc/points/pointInspection.ts";
import { createCompactEPointCacheNode } from "../../../../core/point/compactEPointCache.ts";
import { createPreparedPointData } from "../../../../core/point/preparedPoint.ts";
import { geographicToEcef } from "../../../../core/coordinates/transform/worldCoordinates.ts";

function createPoints({ includeAttributes = true } = {}) {
  return {
    pointCount: 2,
    coordinates: new Float64Array([10, 20, 30, 11, 21, 31]),
    sourceCoordinates: new Float64Array([100, 200, 300, 101, 201, 301]),
    ...(includeAttributes
      ? {
          attributes: {
            intensity: new Uint16Array([8000, 8241]),
            classification: new Uint8Array([2, 5]),
            red: new Uint16Array([12341, 12342]),
            green: new Uint16Array([24211, 24212]),
            blue: new Uint16Array([9841, 9842]),
          },
        }
      : {}),
  };
}

test("compact pick identity maps to position, source XYZ, and attributes", () => {
  const inspection = inspectCopcPoint(
    { nodeKey: "4-12-7-3", pointIndex: 1 },
    { level: 4 },
    createPoints(),
    "rust",
  );

  assert.deepEqual(inspection, {
    nodeKey: "4-12-7-3",
    level: 4,
    pointIndex: 1,
    longitude: 11,
    latitude: 21,
    height: 31,
    source: { x: 101, y: 201, z: 301 },
    intensity: 8241,
    classification: 5,
    classificationLabel: "High Vegetation",
    rgb: { red: 12342, green: 24212, blue: 9842 },
    backend: "rust",
  });
});

test("picked inspection preserves the owning layer identity", () => {
  const inspection = inspectCopcPoint(
    { nodeKey: "4-12-7-3", pointIndex: 0, ownerId: "layer-7" },
    { level: 4 },
    createPoints(),
    "copc-js",
  );
  assert.equal(inspection.ownerId, "layer-7");
  assert.deepEqual(inspection.source, { x: 100, y: 200, z: 300 });
});

test("compact E inspection uses exact cached height and only exposes retained coordinates", () => {
  const geographic = new Float64Array([127.1234, 38.5678, 123.456789]);
  const worldPoint = geographicToEcef({
    longitude: geographic[0],
    latitude: geographic[1],
    height: geographic[2],
  });
  const prepared = createPreparedPointData({
    pointCount: 1,
    sourceCoordinates: new Float64Array([10.25, 20.5, 30.75]),
    geographicCoordinates: geographic,
    worldCoordinates: new Float64Array([
      worldPoint.x,
      worldPoint.y,
      worldPoint.z,
    ]),
  });
  const provenance = {
    sourceIdentity: "memory://inspection.copc.laz",
    transformGeneration: 1,
    heightOffsetMeters: 0,
    verticalDatum: { status: "no-validated-grid-correction" },
  };
  const compact = createCompactEPointCacheNode(prepared, {
    nodeKey: "0-0-0-0",
    provenance,
  });
  const inspection = inspectCopcPoint(
    { nodeKey: compact.nodeKey, pointIndex: 0 },
    { level: 0 },
    compact,
    "rust",
  );

  assert.equal(inspection.height, geographic[2]);
  assert.equal(inspection.source, undefined);
  assert.ok(Math.abs(inspection.longitude - geographic[0]) < 1e-10);
  assert.ok(Math.abs(inspection.latitude - geographic[1]) < 1e-10);
  assert.deepEqual(inspection.world, {
    coordinateSystem: "wgs84-ecef-meters",
    x: worldPoint.x,
    y: worldPoint.y,
    z: worldPoint.z,
  });

  const retainedCompact = createCompactEPointCacheNode(prepared, {
    nodeKey: "0-0-0-0",
    provenance,
    retain: { sourceCoordinates: true, geographicCoordinates: true },
  });
  const retainedInspection = inspectCopcPoint(
    { nodeKey: retainedCompact.nodeKey, pointIndex: 0 },
    { level: 0 },
    retainedCompact,
    "rust",
  );
  assert.equal(retainedInspection.longitude, geographic[0]);
  assert.equal(retainedInspection.latitude, geographic[1]);
  assert.deepEqual(retainedInspection.source, { x: 10.25, y: 20.5, z: 30.75 });
});

test("unrequested fields remain unavailable and unknown classifications stay numeric", () => {
  const points = createPoints({ includeAttributes: false });
  points.attributes = { classification: new Uint8Array([250, 250]) };
  const inspection = inspectCopcPoint(
    { nodeKey: "1-0-0-0", pointIndex: 0 },
    { level: 1 },
    points,
    "copc-js",
  );

  assert.equal(inspection.intensity, undefined);
  assert.equal(inspection.rgb, undefined);
  assert.equal(inspection.classification, 250);
  assert.equal(inspection.classificationLabel, undefined);
});

test("invalid identities and indices do not produce stale inspection data", () => {
  const points = createPoints();
  assert.equal(isCopcPointPickId({ nodeKey: "", pointIndex: 0 }), false);
  assert.equal(isCopcPointPickId({ nodeKey: "node", pointIndex: -1 }), false);
  assert.equal(isCopcPointPickId({ nodeKey: "node", pointIndex: 0.5 }), false);
  assert.equal(
    isCopcPointPickId({ nodeKey: "node", pointIndex: 0, ownerId: "layer-1" }),
    true,
  );
  assert.equal(
    inspectCopcPoint(
      { nodeKey: "node", pointIndex: 2 },
      { level: 0 },
      points,
      "custom",
    ),
    undefined,
  );
  assert.equal(
    inspectCopcPoint(
      { nodeKey: "node", pointIndex: 0 },
      { level: 0 },
      {
        ...points,
        coordinates: new Float64Array([1, 2]),
      },
      "custom",
    ),
    undefined,
  );
});
