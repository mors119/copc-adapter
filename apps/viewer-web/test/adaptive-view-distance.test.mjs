import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AdaptiveViewDistancePolicy,
  createPerspectiveViewFrustum,
  createStreamingViewBounds,
  ecefToGeographic,
  estimateVisibleFootprintDistanceMeters,
  geographicToEcef,
  intersectsViewFrustum,
} from '../src/viewer/streaming/view.ts';

function createView({
  height = 100,
  pitchFromDownDegrees = 0,
  verticalFovRadians = Math.PI / 6,
  aspectRatio = 16 / 9,
  farMeters = 100_000,
  longitude = 0,
  latitude = 0,
} = {}) {
  const position = geographicToEcef({ longitude, latitude, height });
  const pitch = (pitchFromDownDegrees * Math.PI) / 180;
  const direction = {
    x: -Math.cos(pitch),
    y: Math.sin(pitch),
    z: 0,
  };
  const up = {
    x: Math.sin(pitch),
    y: Math.cos(pitch),
    z: 0,
  };
  const right = { x: 0, y: 0, z: 1 };
  const viewFrustum = createPerspectiveViewFrustum({
    position,
    direction,
    up,
    right,
    verticalFovRadians,
    aspectRatio,
    nearMeters: 0.1,
    farMeters,
  });

  return {
    longitude,
    latitude,
    height,
    viewDistanceMeters: farMeters,
    viewFrustum,
  };
}

test('close downward views use a short overscanned distance and retain visible ground', () => {
  const view = createView({ height: 100 });
  const policy = new AdaptiveViewDistancePolicy();
  const adaptive = policy.apply(view, 12_000);
  const bounds = createStreamingViewBounds({
    camera: adaptive,
    viewDistanceMeters: adaptive.viewDistanceMeters,
    maxRenderDistanceMeters: 12_000,
    viewFrustum: adaptive.viewFrustum,
  });
  const groundNode = {
    coordinateSystem: 'wgs84-ecef-meters',
    center: geographicToEcef({ longitude: 0, latitude: 0, height: 0 }),
    radiusMeters: 2,
  };
  const frustum = view.viewFrustum;
  const verticalTangent = Math.tan(frustum.verticalFovRadians / 2);
  const horizontalTangent = verticalTangent * frustum.aspectRatio;
  const edgeRay = {
    x: frustum.direction.x
      + frustum.right.x * horizontalTangent
      + frustum.up.x * verticalTangent,
    y: frustum.direction.y
      + frustum.right.y * horizontalTangent
      + frustum.up.y * verticalTangent,
    z: frustum.direction.z
      + frustum.right.z * horizontalTangent
      + frustum.up.z * verticalTangent,
  };
  const edgeRayLength = Math.hypot(edgeRay.x, edgeRay.y, edgeRay.z);
  edgeRay.x /= edgeRayLength;
  edgeRay.y /= edgeRayLength;
  edgeRay.z /= edgeRayLength;
  const edgeDistance = (view.height + 25) / -edgeRay.x;
  const visibleEdge = ecefToGeographic({
    x: frustum.position.x + edgeRay.x * edgeDistance,
    y: frustum.position.y + edgeRay.y * edgeDistance,
    z: frustum.position.z + edgeRay.z * edgeDistance,
  });

  assert.ok(adaptive.viewDistanceMeters < 500);
  assert.ok(adaptive.viewDistanceMeters < 2_000);
  assert.ok(adaptive.viewDistanceMeters > adaptive.viewDistanceDiagnostics.visibleFootprintMeters);
  assert.ok(bounds.effectiveFarMeters > 100);
  assert.equal(intersectsViewFrustum(view.viewFrustum, groundNode), true);
  assert.ok(bounds.bounds.minX <= visibleEdge.longitude);
  assert.ok(bounds.bounds.maxX >= visibleEdge.longitude);
  assert.ok(bounds.bounds.minY <= visibleEdge.latitude);
  assert.ok(bounds.bounds.maxY >= visibleEdge.latitude);
  assert.equal(bounds.mode, 'frustum');
});

test('higher and more oblique views produce larger world-footprint estimates', () => {
  const close = createView({ height: 100 });
  const high = createView({ height: 2_000 });
  const oblique = createView({ height: 100, pitchFromDownDegrees: 70 });
  const closeEstimate = estimateVisibleFootprintDistanceMeters(close, 12_000);
  const highEstimate = estimateVisibleFootprintDistanceMeters(high, 12_000);
  const obliqueEstimate = estimateVisibleFootprintDistanceMeters(oblique, 12_000);

  assert.ok(highEstimate > closeEstimate);
  assert.ok(obliqueEstimate > closeEstimate);
});

test('near-horizontal views stay inside the configured hard distance ceiling', () => {
  const view = createView({
    height: 500,
    pitchFromDownDegrees: 89.5,
    verticalFovRadians: Math.PI / 9,
  });
  const adaptive = new AdaptiveViewDistancePolicy().apply(view, 750);

  assert.equal(adaptive.viewDistanceMeters, 750);
  assert.equal(adaptive.viewDistanceDiagnostics.maxRenderDistanceMeters, 750);
  assert.equal(adaptive.viewDistanceDiagnostics.clampedToMaxRenderDistance, true);
});

test('overscan is bounded and asymmetric hysteresis holds small changes', () => {
  const policy = new AdaptiveViewDistancePolicy();
  const initial = policy.apply(createView({ height: 100 }), 12_000);
  const smallChange = policy.apply(createView({ height: 102 }), 12_000);
  const materialShrink = policy.apply(createView({ height: 50 }), 12_000);
  const shrinkNoise = policy.apply(createView({ height: 54 }), 12_000);
  const materialExpansion = policy.apply(createView({ height: 80 }), 12_000);

  assert.equal(initial.viewDistanceDiagnostics.transition, 'initialized');
  assert.equal(initial.viewDistanceDiagnostics.updateCount, 1);
  assert.ok(initial.viewDistanceMeters
    <= initial.viewDistanceDiagnostics.visibleFootprintMeters * 1.5);
  assert.equal(smallChange.viewDistanceMeters, initial.viewDistanceMeters);
  assert.equal(smallChange.viewDistanceDiagnostics.transition, 'held');
  assert.equal(materialShrink.viewDistanceDiagnostics.transition, 'shrunk');
  assert.equal(shrinkNoise.viewDistanceMeters, materialShrink.viewDistanceMeters);
  assert.equal(shrinkNoise.viewDistanceDiagnostics.transition, 'held');
  assert.equal(materialExpansion.viewDistanceDiagnostics.transition, 'expanded');
  assert.equal(materialExpansion.viewDistanceDiagnostics.expansionCount, 1);
  assert.equal(materialExpansion.viewDistanceDiagnostics.shrinkCount, 1);
  assert.equal(materialExpansion.viewDistanceDiagnostics.updateCount, 5);
  assert.ok(materialExpansion.viewDistanceMeters > materialShrink.viewDistanceMeters);
});

test('equivalent renderer-neutral frusta produce the same adaptive distance', () => {
  const view = createView({ height: 850, pitchFromDownDegrees: 35 });
  const cesiumPolicy = new AdaptiveViewDistancePolicy();
  const threePolicy = new AdaptiveViewDistancePolicy();

  const fromCesiumInputs = cesiumPolicy.apply(view, 12_000);
  const fromThreeInputs = threePolicy.apply({
    ...view,
    viewDistanceMeters: 2_000,
  }, 12_000);

  assert.equal(fromCesiumInputs.viewDistanceMeters, fromThreeInputs.viewDistanceMeters);
  assert.equal(
    fromCesiumInputs.viewDistanceDiagnostics.visibleFootprintMeters,
    fromThreeInputs.viewDistanceDiagnostics.visibleFootprintMeters,
  );
});

test('missing or invalid perspective data uses finite conservative fallbacks', () => {
  const policy = new AdaptiveViewDistancePolicy();
  const noFrustum = policy.apply({
    longitude: 0,
    latitude: 0,
    height: 100,
    viewDistanceMeters: 20_000,
  }, 12_000);
  const invalidFrustum = policy.apply({
    ...createView(),
    viewFrustum: {
      ...createView().viewFrustum,
      farMeters: Number.NaN,
    },
  }, 12_000);

  assert.equal(noFrustum.viewDistanceMeters, 12_000);
  assert.equal(noFrustum.viewDistanceDiagnostics.transition, 'fallback');
  assert.equal(invalidFrustum.viewDistanceMeters, 12_000);
  assert.equal(invalidFrustum.viewDistanceDiagnostics.transition, 'fallback');
  assert.equal(Number.isFinite(invalidFrustum.viewDistanceMeters), true);
});
