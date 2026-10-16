import assert from 'node:assert/strict';
import test from 'node:test';
import { areStreamingViewsEquivalent } from '../core/streaming/areStreamingViewsEquivalent.ts';

function createView(overrides = {}) {
  return {
    longitude: 127,
    latitude: 37,
    height: 100,
    viewDistanceMeters: 2_000,
    ...overrides,
  };
}

function createFrustum(overrides = {}) {
  const vector = { x: 1, y: 0, z: 0 };
  return {
    coordinateSystem: 'wgs84-ecef-meters',
    position: vector,
    direction: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
    right: { x: 1, y: 0, z: 0 },
    planes: [],
    verticalFovRadians: 1,
    viewportHeightPixels: 720,
    aspectRatio: 16 / 9,
    nearMeters: 1,
    farMeters: 100_000,
    ...overrides,
  };
}

test('equivalent renderer-neutral views stay equivalent within existing tolerances', () => {
  assert.equal(areStreamingViewsEquivalent(
    createView(),
    createView({
      longitude: 127 + 5e-8,
      latitude: 37 - 5e-8,
      height: 100.1,
      viewDistanceMeters: 2_001,
    }),
  ), true);
});

test('views with different frustum availability are not equivalent', () => {
  assert.equal(areStreamingViewsEquivalent(
    createView(),
    createView({ viewFrustum: createFrustum() }),
  ), false);
  assert.equal(areStreamingViewsEquivalent(
    createView({ viewFrustum: createFrustum() }),
    createView({ viewFrustum: createFrustum() }),
  ), true);
});

test('frustum vectors and projection settings participate in equivalence', () => {
  const baseline = createView({ viewFrustum: createFrustum() });
  assert.equal(areStreamingViewsEquivalent(
    baseline,
    createView({
      viewFrustum: createFrustum({
        direction: { x: 0, y: 1e-5, z: -1 },
        viewportHeightPixels: 721,
      }),
    }),
  ), true);
  assert.equal(areStreamingViewsEquivalent(
    baseline,
    createView({ viewFrustum: createFrustum({ aspectRatio: 1 }) }),
  ), false);
});
