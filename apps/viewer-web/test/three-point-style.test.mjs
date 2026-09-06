import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCopcPointStyleState,
  getCopcPointColor,
  getPointBufferRgbMax,
  getThreePointsMaterialOptions,
  prepareThreePointColorBuffer,
  THREE_POINT_SIZE_ATTENUATION,
} from '../src/index.ts';
import { getCopcPointFieldSelection } from '../src/copc/points/fieldSelection.ts';

function createPoints(attributes = {}) {
  return {
    pointCount: 3,
    coordinates: new Float64Array([
      -123, 44, 100,
      -123, 44, 150,
      -123, 44, 200,
    ]),
    attributes,
  };
}

function colorAt(colors, index) {
  const offset = index * 3;
  return Array.from(colors.slice(offset, offset + 3));
}

test('fixed styling produces one finite RGB triplet per point', () => {
  const colors = prepareThreePointColorBuffer(createPoints(), {
    colorMode: 'fixed',
  });

  assert.equal(colors.length, 9);
  assert.deepEqual(colorAt(colors, 0), [0, 1, 1]);
  assert.ok(Array.from(colors).every(Number.isFinite));
});

test('RGB styling preserves 16-bit precision until normalized', () => {
  const points = createPoints({
    red: new Uint16Array([65535, 32768, 0]),
    green: new Uint16Array([0, 32768, 65535]),
    blue: new Uint16Array([0, 0, 65535]),
  });

  assert.equal(getPointBufferRgbMax(points), 65535);
  const colors = prepareThreePointColorBuffer(points, { colorMode: 'rgb' });

  assert.deepEqual(colorAt(colors, 0), [1, 0, 0]);
  assert.ok(Math.abs(colors[4] - (32768 / 65535)) < 1e-6);
  assert.deepEqual(colorAt(colors, 2), [0, 1, 1]);
});

test('RGB display scale is stable across streamed nodes and resets per dataset', () => {
  const state = createCopcPointStyleState();
  const lowRangeNode = createPoints({
    red: new Uint16Array([200, 0, 0]),
    green: new Uint16Array([0, 200, 0]),
    blue: new Uint16Array([0, 0, 200]),
  });
  const fullRangeNode = createPoints({
    red: new Uint16Array([65535, 128, 0]),
    green: new Uint16Array([0, 65535, 0]),
    blue: new Uint16Array([0, 0, 65535]),
  });

  assert.equal(state.getRgbMax(lowRangeNode), 255);
  assert.equal(state.getRgbMax(fullRangeNode), 255);
  const secondNodeColors = prepareThreePointColorBuffer(fullRangeNode, {
    colorMode: 'rgb',
  }, state);
  assert.ok(secondNodeColors[3] > 0.4);
  state.reset();
  assert.equal(state.getRgbMax(fullRangeNode), 65535);
});

test('RGB, intensity, and classification missing fields fall back to fixed cyan', () => {
  for (const colorMode of ['rgb', 'intensity', 'classification']) {
    const colors = prepareThreePointColorBuffer(createPoints(), { colorMode });
    assert.deepEqual(colorAt(colors, 0), [0, 1, 1], colorMode);
  }
});

test('elevation, intensity, and classification use shared mappings', () => {
  const points = createPoints({
    intensity: new Uint16Array([1000, 2000, 3000]),
    classification: new Uint8Array([2, 6, 42]),
  });

  const elevation = prepareThreePointColorBuffer(points, {
    colorMode: 'elevation',
    elevationRange: { min: 100, max: 200 },
  });
  const intensity = prepareThreePointColorBuffer(points, {
    colorMode: 'intensity',
  });
  const classification = prepareThreePointColorBuffer(points, {
    colorMode: 'classification',
  });

  assert.notDeepEqual(colorAt(elevation, 0), colorAt(elevation, 2));
  assert.deepEqual(colorAt(intensity, 0), [0, 0, 0]);
  assert.deepEqual(colorAt(intensity, 2), [1, 1, 1]);
  assert.notDeepEqual(colorAt(classification, 0), colorAt(classification, 1));
  assert.deepEqual(colorAt(classification, 2), [1, 0, 1]);
  assert.ok(
    [...elevation, ...intensity, ...classification].every(Number.isFinite),
  );
});

test('Three point material keeps pointSize in screen space deliberately', () => {
  assert.equal(THREE_POINT_SIZE_ATTENUATION, false);
  assert.deepEqual(getThreePointsMaterialOptions(4), {
    size: 4,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
  });
});

test('Three styling accepts the same minimal field selection as the shared core', () => {
  assert.deepEqual([...getCopcPointFieldSelection('fixed')], ['position']);
  assert.deepEqual([...getCopcPointFieldSelection('elevation')], ['position']);
  assert.deepEqual([...getCopcPointFieldSelection('rgb')], ['position', 'rgb']);
  assert.deepEqual([...getCopcPointFieldSelection('intensity')], ['position', 'intensity']);
  assert.deepEqual(
    [...getCopcPointFieldSelection('classification')],
    ['position', 'classification'],
  );
});

test('shared point colors remain finite for an invalid elevation value', () => {
  const color = getCopcPointColor(Number.NaN, {
    colorMode: 'elevation',
    elevationRange: { min: 0, max: 1 },
  });

  assert.ok([color.red, color.green, color.blue, color.alpha].every(Number.isFinite));
});
