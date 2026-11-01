import assert from "node:assert/strict";
import test from "node:test";
import * as Cesium from "cesium";
import { writeEcefForEllipsoidalHeightOffset } from "../../../../core/coordinates/transform/ellipsoidalHeightOffset.ts";

const WGS84 = Cesium.Ellipsoid.WGS84;

function makeBaseline(longitudeDegrees, latitudeDegrees, heightMeters) {
  const geographic = new Float64Array([
    longitudeDegrees,
    latitudeDegrees,
    heightMeters,
  ]);
  const cartesian = Cesium.Cartesian3.fromDegrees(
    longitudeDegrees,
    latitudeDegrees,
    heightMeters,
    WGS84,
  );
  return {
    geographic,
    ecef: new Float64Array([cartesian.x, cartesian.y, cartesian.z]),
  };
}

test("writes ECEF offsets along the WGS84 normal with sub-millimetre error", () => {
  const samples = [
    [-122.5, 44.5, 100, 150],
    [179.9999, -35.25, -430, -25],
    [44, 89.999, 42_000_001.25, 2.75],
    [0, -90, 0, -12.5],
  ];

  for (const [longitude, latitude, baselineHeight, offset] of samples) {
    const baseline = makeBaseline(longitude, latitude, baselineHeight);
    const actual = writeEcefForEllipsoidalHeightOffset(
      baseline.ecef,
      baseline.geographic,
      0,
      offset,
    );
    const expected = Cesium.Cartesian3.fromDegrees(
      longitude,
      latitude,
      baselineHeight + offset,
      WGS84,
    );
    const errorMeters = Cesium.Cartesian3.distance(
      new Cesium.Cartesian3(actual[0], actual[1], actual[2]),
      expected,
    );
    assert.ok(errorMeters < 0.000001, `${errorMeters} m at ${longitude},${latitude}`);
  }
});

test("reversals reuse the immutable baseline without accumulating offsets", () => {
  const baseline = makeBaseline(-122.5, 44.5, 100);
  const output = new Float64Array(3);
  const atFive = writeEcefForEllipsoidalHeightOffset(
    baseline.ecef,
    baseline.geographic,
    0,
    5,
    output,
  );
  const fiveMetersReference = [...atFive];
  const atNegativeTwo = writeEcefForEllipsoidalHeightOffset(
    baseline.ecef,
    baseline.geographic,
    0,
    -2,
    output,
  );
  const backAtFive = writeEcefForEllipsoidalHeightOffset(
    baseline.ecef,
    baseline.geographic,
    0,
    5,
    output,
  );

  assert.equal(atFive, output);
  assert.equal(atNegativeTwo, output);
  assert.equal(backAtFive, output);
  assert.deepEqual([...output], fiveMetersReference);
  const baselineReference = Cesium.Cartesian3.fromDegrees(
    -122.5,
    44.5,
    100,
    WGS84,
  );
  assert.deepEqual([...baseline.ecef], [
    baselineReference.x,
    baselineReference.y,
    baselineReference.z,
  ]);
});

test("rejects malformed inputs and shared baseline storage", () => {
  const baseline = makeBaseline(0, 0, 0);
  assert.throws(
    () => writeEcefForEllipsoidalHeightOffset(new Float64Array(2), new Float64Array(2), 0, 1),
    /matching XYZ triples/u,
  );
  assert.throws(
    () => writeEcefForEllipsoidalHeightOffset(baseline.ecef, baseline.geographic, 0, Number.NaN),
    /finite numbers/u,
  );
  assert.throws(
    () => writeEcefForEllipsoidalHeightOffset(baseline.ecef, baseline.geographic, 0, 1, baseline.ecef),
    /must not share its baseline storage/u,
  );
  const sharedStorage = new Float64Array(6);
  assert.throws(
    () =>
      writeEcefForEllipsoidalHeightOffset(
        sharedStorage.subarray(0, 3),
        baseline.geographic,
        0,
        1,
        sharedStorage.subarray(3),
      ),
    /must not share its baseline storage/u,
  );
});
