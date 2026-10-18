import assert from 'node:assert/strict';
import test from 'node:test';
import { packRelativeEcef } from '../cesium/render/relativeEcef.ts';

test('relative Float32 ECEF packing retains millimetre detail at geographic extremes', () => {
  const origins = [
    [6_378_137, 0, 0],
    [-6_378_137, 0, 0],
    [0, 0, 6_356_752.314245],
    [0, 0, -6_356_752.314245],
  ];

  for (const [x, y, z] of origins) {
    const world = new Float64Array([
      x - 500, y, z,
      x + 500, y, z,
      x, y - 0.001, z,
      x, y + 0.001, z,
      x, y, z - 0.001,
      x, y, z + 0.001,
    ]);
    const packed = packRelativeEcef(world);
    assert.equal(packed.positions.length, world.length);
    assert.ok(packed.maxAbsoluteError < 0.00004, `max error ${packed.maxAbsoluteError} m`);
    assert.ok(packed.radius >= 500);
    for (let index = 0; index < world.length; index += 1) {
      const reconstructed = packed.origin[index % 3] + packed.positions[index];
      assert.ok(Math.abs(reconstructed - world[index]) < 0.00004);
    }
  }
});

test('relative Float32 ECEF packing rejects malformed and non-finite data', () => {
  assert.throws(() => packRelativeEcef(new Float64Array()), /one or more XYZ triples/);
  assert.throws(() => packRelativeEcef(new Float64Array([1, 2])), /XYZ triples/);
  assert.throws(() => packRelativeEcef(new Float64Array([1, 2, Number.NaN])), /finite/);
});
