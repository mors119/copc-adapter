import assert from "node:assert/strict";
import test from "node:test";
import { createSelectedPointEcefBox } from "../clippingGeometry.ts";

test("creates an explicit WGS 84 ECEF metres box around a selected world point", () => {
  assert.deepEqual(createSelectedPointEcefBox([100, -200, 300], 12.5), {
    type: "box",
    coordinateSystem: "wgs84-ecef-meters",
    minimum: [87.5, -212.5, 287.5],
    maximum: [112.5, -187.5, 312.5],
  });
});

test("rejects missing or invalid point coordinates and non-positive half-widths", () => {
  assert.equal(createSelectedPointEcefBox(undefined, 1), undefined);
  assert.equal(createSelectedPointEcefBox([0, Number.NaN, 0], 1), undefined);
  assert.equal(createSelectedPointEcefBox([0, 0, 0], 0), undefined);
  assert.equal(createSelectedPointEcefBox([0, 0, 0], Number.POSITIVE_INFINITY), undefined);
});
