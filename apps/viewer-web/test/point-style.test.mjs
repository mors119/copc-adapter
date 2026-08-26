import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  getPointColor,
  normalizeElevation,
  normalizeIntensity,
} from '../src/cesium/style/pointStyle.ts';
import {
  getPointBufferElevationRange,
  getPointBufferIntensityRange,
  getPointBufferRgbMax,
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

test('normalizeIntensity maps, clamps, and handles a flat range', () => {
  const range = { min: 1000, max: 3000 };

  assert.equal(normalizeIntensity(1000, range), 0);
  assert.equal(normalizeIntensity(2000, range), 0.5);
  assert.equal(normalizeIntensity(3000, range), 1);
  assert.equal(normalizeIntensity(500, range), 0);
  assert.equal(normalizeIntensity(4000, range), 1);
  assert.equal(normalizeIntensity(1000, { min: 1000, max: 1000 }), 0.5);
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

  const renderedHeights = Array.from(
    { length: collection.length },
    (_, index) => Cesium.Cartographic.fromCartesian(
      collection.get(index).position,
    ).height,
  );

  assert.deepEqual(
    renderedHeights.map((height) => Math.round(height)),
    [100, 150, 200],
  );
});

test('getPointColor maps RGB, intensity, and classification attributes', () => {
  const attributes = {
    intensity: new Uint16Array([1000, 2000, 3000]),
    classification: new Uint8Array([2, 6, 42]),
    red: new Uint16Array([65535, 0, 0]),
    green: new Uint16Array([32768, 65535, 0]),
    blue: new Uint16Array([0, 0, 65535]),
  };
  const baseOptions = {
    elevationRange,
    intensityRange: { min: 1000, max: 3000 },
    rgbMax: 65535,
  };
  const rgb = getPointColor(0, {
    ...baseOptions,
    colorMode: 'rgb',
  }, attributes, 0);
  const lowIntensity = getPointColor(0, {
    ...baseOptions,
    colorMode: 'intensity',
  }, attributes, 0);
  const highIntensity = getPointColor(0, {
    ...baseOptions,
    colorMode: 'intensity',
  }, attributes, 2);
  const ground = getPointColor(0, {
    ...baseOptions,
    colorMode: 'classification',
  }, attributes, 0);
  const building = getPointColor(0, {
    ...baseOptions,
    colorMode: 'classification',
  }, attributes, 1);
  const unknown = getPointColor(0, {
    ...baseOptions,
    colorMode: 'classification',
  }, attributes, 2);

  assert.equal(rgb.red, 1);
  assert.ok(Math.abs(rgb.green - (32768 / 65535)) < 1e-9);
  assert.equal(rgb.blue, 0);
  assert.deepEqual(
    [lowIntensity.red, lowIntensity.green, lowIntensity.blue],
    [0, 0, 0],
  );
  assert.deepEqual(
    [highIntensity.red, highIntensity.green, highIntensity.blue],
    [1, 1, 1],
  );
  assert.notDeepEqual(ground, building);
  assert.deepEqual(
    [unknown.red, unknown.green, unknown.blue],
    [1, 0, 1],
  );
});

test('attribute color modes fall back to fixed cyan when data is unavailable', () => {
  for (const colorMode of ['rgb', 'intensity', 'classification']) {
    const color = getPointColor(0, { colorMode, elevationRange });

    assert.deepEqual(
      [color.red, color.green, color.blue, color.alpha],
      [0, 1, 1, 0.9],
    );
  }
});

test('renderCopcPoints derives attribute ranges and applies each color mode', () => {
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
    attributes: {
      intensity: new Uint16Array([1000, 2000, 3000]),
      classification: new Uint8Array([2, 5, 6]),
      red: new Uint16Array([255, 0, 0]),
      green: new Uint16Array([0, 255, 0]),
      blue: new Uint16Array([0, 0, 255]),
    },
  };

  assert.deepEqual(getPointBufferIntensityRange(points), {
    min: 1000,
    max: 3000,
  });
  assert.equal(getPointBufferRgbMax(points), 255);

  const rgb = renderCopcPoints(viewer, points, {
    pointSize: 2,
    colorMode: 'rgb',
  });
  const intensity = renderCopcPoints(viewer, points, {
    pointSize: 2,
    colorMode: 'intensity',
  });
  const classification = renderCopcPoints(viewer, points, {
    pointSize: 2,
    colorMode: 'classification',
  });

  assert.deepEqual(
    [rgb.get(0).color.red, rgb.get(0).color.green, rgb.get(0).color.blue],
    [1, 0, 0],
  );
  assert.equal(intensity.get(0).color.red, 0);
  assert.equal(intensity.get(2).color.red, 1);
  assert.notDeepEqual(classification.get(0).color, classification.get(2).color);
});
