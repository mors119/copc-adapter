import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPointColor,
  normalizeElevation,
} from '../src/cesium/style/pointStyle.ts';
import {
  getPointBufferElevationRange,
  renderCopcPoints,
} from '../src/cesium/render/renderPoints.ts';

const elevationRange = { min: 100, max: 200 };

test('normalizeElevation maps and clamps heights to the configured range', () => {
  assert.equal(normalizeElevation(100, elevationRange), 0);
  assert.equal(normalizeElevation(150, elevationRange), 0.5);
  assert.equal(normalizeElevation(200, elevationRange), 1);
  assert.equal(normalizeElevation(50, elevationRange), 0);
  assert.equal(normalizeElevation(250, elevationRange), 1);
});

test('normalizeElevation uses the gradient midpoint for a flat or invalid range', () => {
  assert.equal(normalizeElevation(100, { min: 100, max: 100 }), 0.5);
  assert.equal(normalizeElevation(Number.NaN, elevationRange), 0.5);
});

test('getPointColor keeps fixed cyan and selects distinct elevation colors', () => {
  const fixed = getPointColor(100, {
    colorMode: 'fixed',
    elevationRange,
  });
  const low = getPointColor(100, {
    colorMode: 'elevation',
    elevationRange,
  });
  const high = getPointColor(200, {
    colorMode: 'elevation',
    elevationRange,
  });

  assert.deepEqual(
    [fixed.red, fixed.green, fixed.blue, fixed.alpha],
    [0, 1, 1, 0.9],
  );
  assert.notDeepEqual(
    [low.red, low.green, low.blue],
    [high.red, high.green, high.blue],
  );
});

test('renderCopcPoints applies an elevation color per transformed height', () => {
  const viewer = {
    scene: {
      primitives: {
        add(collection) {
          return collection;
        },
      },
    },
  };
  const points = {
    pointCount: 3,
    coordinates: new Float64Array([
      -123, 44, 100,
      -123, 44, 150,
      -123, 44, 200,
    ]),
  };

  assert.deepEqual(getPointBufferElevationRange(points), elevationRange);

  const collection = renderCopcPoints(viewer, points, {
    pointSize: 2,
    colorMode: 'elevation',
    elevationRange,
  });

  assert.notDeepEqual(collection.get(0).color, collection.get(1).color);
  assert.notDeepEqual(collection.get(1).color, collection.get(2).color);
});
