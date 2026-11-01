import test from "node:test";
import assert from "node:assert/strict";
import {
  isWorldPointInsideCopcCesiumClippingVolume,
  normalizeCopcCesiumClippingVolume,
} from "../../cesium/layer/clippingVolumes.ts";

test("plane clipping keeps the non-negative side and includes the boundary at different ECEF origins", () => {
  for (const origin of [0, 6_378_137]) {
    const volume = normalizeCopcCesiumClippingVolume({
      type: "planes",
      coordinateSystem: "wgs84-ecef-meters",
      planes: [
        {
          normal: [2, 0, 0],
          point: [origin + 10, 0, 0],
        },
      ],
    });
    const points = new Float64Array([
      origin + 9,
      0,
      0,
      origin + 10,
      0,
      0,
      origin + 11,
      0,
      0,
    ]);
    assert.equal(
      isWorldPointInsideCopcCesiumClippingVolume(points, 0, volume),
      false,
    );
    assert.equal(
      isWorldPointInsideCopcCesiumClippingVolume(points, 1, volume),
      true,
    );
    assert.equal(
      isWorldPointInsideCopcCesiumClippingVolume(points, 2, volume),
      true,
    );
  }
});

test("box clipping includes each face and rejects points outside at large ECEF offsets", () => {
  const origin = 6_378_137;
  const volume = normalizeCopcCesiumClippingVolume({
    type: "box",
    coordinateSystem: "wgs84-ecef-meters",
    minimum: [origin - 2, -4, 10],
    maximum: [origin + 2, 4, 20],
  });
  const points = new Float64Array([
    origin - 2,
    0,
    15,
    origin,
    4,
    20,
    origin + 2.001,
    0,
    15,
    origin,
    -4.001,
    15,
    origin,
    0,
    9.999,
  ]);
  assert.equal(
    isWorldPointInsideCopcCesiumClippingVolume(points, 0, volume),
    true,
  );
  assert.equal(
    isWorldPointInsideCopcCesiumClippingVolume(points, 1, volume),
    true,
  );
  assert.equal(
    isWorldPointInsideCopcCesiumClippingVolume(points, 2, volume),
    false,
  );
  assert.equal(
    isWorldPointInsideCopcCesiumClippingVolume(points, 3, volume),
    false,
  );
  assert.equal(
    isWorldPointInsideCopcCesiumClippingVolume(points, 4, volume),
    false,
  );
});

test("clipping volumes reject ambiguous coordinates, degenerate normals, and unbounded plane counts", () => {
  assert.throws(
    () =>
      normalizeCopcCesiumClippingVolume({
        type: "box",
        minimum: [0, 0, 0],
        maximum: [1, 1, 1],
      }),
    /coordinateSystem/,
  );
  assert.throws(
    () =>
      normalizeCopcCesiumClippingVolume({
        type: "planes",
        coordinateSystem: "wgs84-ecef-meters",
        planes: [{ normal: [0, 0, 0], point: [0, 0, 0] }],
      }),
    /nonzero/,
  );
  assert.throws(
    () =>
      normalizeCopcCesiumClippingVolume({
        type: "planes",
        coordinateSystem: "wgs84-ecef-meters",
        planes: Array.from({ length: 7 }, () => ({
          normal: [1, 0, 0],
          point: [0, 0, 0],
        })),
      }),
    /between 1 and 6/,
  );
});
