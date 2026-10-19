import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as THREE from 'three';

import { createDatasetLocalFrame } from '../core/coordinates/transform/datasetLocalFrame.ts';
import { createCesiumStreamingView } from '../cesium/view/CesiumViewAdapter.ts';
import { NodeSelector } from '../core/streaming/NodeSelector.ts';
import {
  CameraMotionLookaheadEstimator,
  MOTION_LOOKAHEAD_DECAY_MS,
  MOTION_LOOKAHEAD_HORIZON_MS,
} from '../core/streaming/motionLookahead.ts';
import { createPerspectiveViewFrustum } from '../core/streaming/view.ts';
import { createThreeStreamingView } from '../three/view/ThreeViewAdapter.ts';

function cameraBasis(yawDegrees = 0, pitchDegrees = 0, rollDegrees = 0) {
  const yaw = yawDegrees * Math.PI / 180;
  const pitch = pitchDegrees * Math.PI / 180;
  const roll = rollDegrees * Math.PI / 180;
  const direction = {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  };
  const unrolledRight = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const unrolledUp = {
    x: -Math.sin(yaw) * Math.sin(pitch),
    y: Math.cos(pitch),
    z: -Math.cos(yaw) * Math.sin(pitch),
  };
  const right = {
    x: unrolledRight.x * Math.cos(roll) + unrolledUp.x * Math.sin(roll),
    y: unrolledRight.y * Math.cos(roll) + unrolledUp.y * Math.sin(roll),
    z: unrolledRight.z * Math.cos(roll) + unrolledUp.z * Math.sin(roll),
  };
  const up = {
    x: unrolledUp.x * Math.cos(roll) - unrolledRight.x * Math.sin(roll),
    y: unrolledUp.y * Math.cos(roll) - unrolledRight.y * Math.sin(roll),
    z: unrolledUp.z * Math.cos(roll) - unrolledRight.z * Math.sin(roll),
  };
  return createPerspectiveViewFrustum({
    position: { x: 0, y: 0, z: 0 },
    direction,
    right,
    up,
    verticalFovRadians: Math.PI / 2,
    viewportHeightPixels: 1000,
    aspectRatio: 1,
    nearMeters: 1,
    farMeters: 100,
  });
}

function makeRefinableNode(key, level, center, children = []) {
  return {
    node: {
      key,
      level,
      x: 0,
      y: 0,
      z: 0,
      pointCount: level === 0 ? 10 : 4,
      pointDataOffset: 0,
      pointDataLength: 0,
      children: children.map((child) => child.node.key),
    },
    children: children.map((child) => child.node.key),
    center: { longitude: 0, latitude: 0, height: 0 },
    bounds: {
      minX: -0.001,
      minY: -0.001,
      minZ: -0.001,
      maxX: 0.001,
      maxY: 0.001,
      maxZ: 0.001,
    },
    approximateSizeMeters: 10,
    boundingRadiusMeters: 0.1,
    boundingSphere: { center, radiusMeters: 0.05 },
    geometricErrorMeters: level === 0 ? 20 : 0,
    childrenComplete: true,
  };
}

function createCompetingHierarchy(axis = 'x', negativeIsBaseline = true) {
  const makeBranch = (key, sign) => {
    const center = axis === 'x'
      ? { x: sign * 4.75, y: 0, z: 5 }
      : { x: 0, y: sign * 4.75, z: 5 };
    const children = [0, 1].map((index) => makeRefinableNode(
      `1-${key}-${index}`,
      1,
      center,
    ));
    return makeRefinableNode(`0-${key}`, 0, center, children);
  };
  const negative = makeBranch(negativeIsBaseline ? 'a-negative' : 'z-negative', -1);
  const positive = makeBranch(negativeIsBaseline ? 'z-positive' : 'a-positive', 1);
  const hierarchyNodes = [negative, positive];
  for (const root of hierarchyNodes) {
    const center = root.boundingSphere.center;
    for (const key of root.children) {
      const child = makeRefinableNode(key, 1, center);
      hierarchyNodes.push(child);
    }
  }
  return new Map(hierarchyNodes.map((node) => [node.node.key, node]));
}

function prediction(horizontalDegrees, verticalDegrees, activity = 1) {
  return {
    enabled: true,
    horizontalAngularVelocityDegreesPerSecond: horizontalDegrees * 5,
    verticalAngularVelocityDegreesPerSecond: verticalDegrees * 5,
    horizonMilliseconds: MOTION_LOOKAHEAD_HORIZON_MS,
    predictedHorizontalDisplacementDegrees: horizontalDegrees,
    predictedVerticalDisplacementDegrees: verticalDegrees,
    activity,
  };
}

function createBudgetSelector(refinementAlgorithm = 'screen-projection', options = {}) {
  return new NodeSelector({
    maxNodes: 3,
    maxDepth: 1,
    maxScreenSpaceError: 8,
    maxRenderDistanceMeters: 2_000,
    maxRenderedPoints: 30,
    refinementAlgorithm,
    ...options,
  });
}

function selectedRefinedRootKeys(selector, hierarchy, view = cameraBasis(), height = 0) {
  return selector.selectVisibleNodes({
    longitude: 0,
    latitude: 0,
    height,
    viewDistanceMeters: 2_000,
    viewFrustum: view,
  }, hierarchy).map((node) => node.node.key.startsWith('1-')
    ? node.node.key.split('-').slice(1, 3).join('-')
    : undefined).filter(Boolean).filter((key, index, values) => values.indexOf(key) === index);
}

test('motion estimator maps yaw, pitch, roll and circular orientation changes to screen axes', () => {
  const right = new CameraMotionLookaheadEstimator();
  right.observe(cameraBasis(0), 100);
  const rightResult = right.observe(cameraBasis(2), 200).prediction;
  assert.ok(rightResult.predictedHorizontalDisplacementDegrees > 0);
  assert.equal(rightResult.horizonMilliseconds, 200);

  const left = new CameraMotionLookaheadEstimator();
  left.observe(cameraBasis(0), 100);
  assert.ok(left.observe(cameraBasis(-2), 200).prediction.predictedHorizontalDisplacementDegrees < 0);

  const up = new CameraMotionLookaheadEstimator();
  up.observe(cameraBasis(), 100);
  assert.ok(up.observe(cameraBasis(0, 2), 200).prediction.predictedVerticalDisplacementDegrees > 0);

  const down = new CameraMotionLookaheadEstimator();
  down.observe(cameraBasis(), 100);
  assert.ok(down.observe(cameraBasis(0, -2), 200).prediction.predictedVerticalDisplacementDegrees < 0);

  const rolled = new CameraMotionLookaheadEstimator();
  rolled.observe(cameraBasis(0, 20, 35), 100);
  const rolledRight = rolled.observe(cameraBasis(2, 20, 35), 200).prediction;
  assert.ok(rolledRight.predictedHorizontalDisplacementDegrees > 0);
  assert.ok(Number.isFinite(rolledRight.predictedVerticalDisplacementDegrees));

  const wrapRight = new CameraMotionLookaheadEstimator();
  wrapRight.observe(cameraBasis(359), 100);
  assert.ok(wrapRight.observe(cameraBasis(1), 200).prediction.predictedHorizontalDisplacementDegrees > 0);
  const wrapLeft = new CameraMotionLookaheadEstimator();
  wrapLeft.observe(cameraBasis(1), 100);
  assert.ok(wrapLeft.observe(cameraBasis(359), 200).prediction.predictedHorizontalDisplacementDegrees < 0);
});

test('motion estimator rejects bad clocks and vectors, clamps speed, reverses promptly and decays exactly', () => {
  const estimator = new CameraMotionLookaheadEstimator();
  assert.equal(estimator.observe(cameraBasis(), 100).valid, true);
  assert.equal(estimator.observe(cameraBasis(10), 100).valid, false);
  assert.equal(estimator.observe(cameraBasis(10), 90).valid, false);
  assert.equal(estimator.observe(cameraBasis(10), Number.NaN).valid, false);
  assert.equal(estimator.observe(undefined, 110).valid, false);
  const invalidBasis = cameraBasis();
  invalidBasis.direction.x = Number.POSITIVE_INFINITY;
  assert.equal(estimator.observe(invalidBasis, 110).valid, false);

  const huge = estimator.observe(cameraBasis(100), 120);
  assert.ok(Math.hypot(
    huge.prediction.horizontalAngularVelocityDegreesPerSecond,
    huge.prediction.verticalAngularVelocityDegreesPerSecond,
  ) <= 90.000001);
  assert.ok(Math.abs(huge.prediction.predictedHorizontalDisplacementDegrees) <= 18);
  const reversed = estimator.observe(cameraBasis(99), 220);
  assert.ok(reversed.prediction.predictedHorizontalDisplacementDegrees < 0);
  assert.equal(estimator.getPrediction(220 + MOTION_LOOKAHEAD_DECAY_MS).activity, 0);

  const afterGap = estimator.observe(cameraBasis(99), 3_000);
  assert.equal(afterGap.prediction.activity, 0);
  assert.equal(afterGap.prediction.horizontalAngularVelocityDegreesPerSecond, 0);

  const sparse = new CameraMotionLookaheadEstimator();
  sparse.observe(cameraBasis(), 0);
  const afterLongIdle = sparse.observe(cameraBasis(20), 100_000);
  assert.equal(afterLongIdle.sampledMovement, true);
  assert.ok(afterLongIdle.prediction.predictedHorizontalDisplacementDegrees > 0);
  assert.ok(afterLongIdle.prediction.horizontalAngularVelocityDegreesPerSecond <= 90);

  const first = estimator.observe(cameraBasis(), 5_000);
  assert.equal(first.valid, true);
  const tinyInterval = estimator.observe(cameraBasis(1), 5_002);
  assert.equal(tinyInterval.valid, false);
});

test('motion reversals immediately replace stale direction and disabled mode stays zero', () => {
  const estimator = new CameraMotionLookaheadEstimator();
  estimator.observe(cameraBasis(), 10);
  assert.ok(estimator.observe(cameraBasis(4), 110).prediction.predictedHorizontalDisplacementDegrees > 0);
  assert.ok(estimator.observe(cameraBasis(0), 210).prediction.predictedHorizontalDisplacementDegrees < 0);
  assert.ok(estimator.observe(cameraBasis(4), 310).prediction.predictedHorizontalDisplacementDegrees > 0);

  const disabled = new CameraMotionLookaheadEstimator(false);
  disabled.observe(cameraBasis(), 10);
  assert.equal(disabled.observe(cameraBasis(5), 110).prediction.activity, 0);
});

test('Cesium and Three snapshots produce the same renderer-neutral motion prediction', () => {
  const frame = createDatasetLocalFrame({
    pointCount: 1,
    bounds: { minX: 10, minY: 20, minZ: 100, maxX: 10.001, maxY: 20.001, maxZ: 101 },
    cube: { minX: 10, minY: 20, minZ: 100, maxX: 10.001, maxY: 20.001, maxZ: 101 },
  });
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 1, 1000);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);

  const toCesiumView = (view) => {
    const frustum = view.viewFrustum;
    return createCesiumStreamingView({
      camera: {
        positionWC: new Cesium.Cartesian3(
          frustum.position.x,
          frustum.position.y,
          frustum.position.z,
        ),
        directionWC: new Cesium.Cartesian3(
          frustum.direction.x,
          frustum.direction.y,
          frustum.direction.z,
        ),
        rightWC: new Cesium.Cartesian3(frustum.right.x, frustum.right.y, frustum.right.z),
        upWC: new Cesium.Cartesian3(frustum.up.x, frustum.up.y, frustum.up.z),
        frustum: {
          fovy: frustum.verticalFovRadians,
          aspectRatio: frustum.aspectRatio,
          near: frustum.nearMeters,
          far: frustum.farMeters,
        },
      },
      scene: {
        drawingBufferHeight: frustum.viewportHeightPixels,
        canvas: { clientHeight: frustum.viewportHeightPixels, height: frustum.viewportHeightPixels },
      },
    });
  };
  const createThreeView = () => createThreeStreamingView({
    camera,
    frame,
    renderer: { domElement: { width: 800, height: 600 } },
  });
  const threeEstimator = new CameraMotionLookaheadEstimator();
  const cesiumEstimator = new CameraMotionLookaheadEstimator();
  const initialThreeView = createThreeView();
  const initialCesiumView = toCesiumView(initialThreeView);
  threeEstimator.observe(initialThreeView.viewFrustum, 100);
  cesiumEstimator.observe(initialCesiumView.viewFrustum, 100);

  camera.lookAt(0.25, 0, -1);
  camera.updateMatrixWorld(true);
  const movedThreeView = createThreeView();
  const threePrediction = threeEstimator.observe(movedThreeView.viewFrustum, 200).prediction;
  const cesiumPrediction = cesiumEstimator.observe(
    toCesiumView(movedThreeView).viewFrustum,
    200,
  ).prediction;

  assert.ok(threePrediction.predictedHorizontalDisplacementDegrees > 0);
  assert.deepEqual(cesiumPrediction, threePrediction);
});

test('bounded motion influence changes the current-view refinement winner in both strategies', () => {
  for (const refinementAlgorithm of ['foveated', 'screen-projection']) {
    for (const { axis, horizontal, vertical, expected } of [
      { axis: 'x', horizontal: 18, vertical: 0, expected: 'z-positive' },
      { axis: 'x', horizontal: -18, vertical: 0, expected: 'z-negative', negativeIsBaseline: false },
      { axis: 'y', horizontal: 0, vertical: 18, expected: 'z-positive' },
      { axis: 'y', horizontal: 0, vertical: -18, expected: 'z-negative', negativeIsBaseline: false },
    ]) {
      const negativeIsBaseline = expected === 'z-positive';
      const hierarchy = createCompetingHierarchy(axis, negativeIsBaseline);
      const selector = createBudgetSelector(refinementAlgorithm);
      const stationary = selectedRefinedRootKeys(selector, hierarchy);
      assert.deepEqual(stationary, [negativeIsBaseline ? 'a-negative' : 'a-positive']);

      const disabledSelector = createBudgetSelector(refinementAlgorithm, {
        motionLookahead: false,
      });
      disabledSelector.setMotionPrediction(prediction(horizontal, vertical));
      assert.deepEqual(selectedRefinedRootKeys(disabledSelector, hierarchy), stationary);
      assert.equal(disabledSelector.getSelectionMetrics().motionLookaheadEnabled, false);
      assert.equal(disabledSelector.getSelectionMetrics().motionWeightMax, 0);

      selector.setMotionPrediction(prediction(horizontal, vertical));
      const moving = selectedRefinedRootKeys(selector, hierarchy);
      assert.deepEqual(moving, [expected]);
      const selectedKeys = selector.selectVisibleNodes({
        longitude: 0,
        latitude: 0,
        height: 0,
        viewDistanceMeters: 2_000,
        viewFrustum: cameraBasis(),
      }, hierarchy).map((node) => node.node.key);
      assert.equal(selectedKeys.includes(`0-${expected}`), false);
      assert.deepEqual(
        selectedKeys.filter((key) => key.startsWith('1-')).sort(),
        [`1-${expected}-0`, `1-${expected}-1`].sort(),
      );
      const metrics = selector.getSelectionMetrics();
      assert.ok(metrics.motionCandidateCount > 0);
      assert.ok(metrics.motionWeightMax > metrics.motionWeightMin);
      assert.ok(metrics.motionInfluencedRefinementCount > 0, JSON.stringify({
        refinementAlgorithm,
        horizontal,
        vertical,
        metrics,
      }));
      assert.ok(metrics.frontierNodeCount <= 3);
      assert.ok(metrics.frontierPointCount <= 30);

      selector.setMotionPrediction(prediction(0, 0, 0));
      assert.deepEqual(selectedRefinedRootKeys(selector, hierarchy), stationary);
    }
  }
});

test('raw SSE, explicit focus, node and point budgets remain authoritative over motion', () => {
  const hierarchy = createCompetingHierarchy('x', false);
  const selector = createBudgetSelector('screen-projection');
  hierarchy.get('0-z-negative').geometricErrorMeters = 80;
  selector.setMotionPrediction(prediction(18, 0));
  assert.deepEqual(selectedRefinedRootKeys(selector, hierarchy, cameraBasis(), 1_000), ['z-negative']);

  const focusHierarchy = createCompetingHierarchy('x');
  const focusSelector = createBudgetSelector('screen-projection');
  focusSelector.setMotionPrediction(prediction(18, 0));
  focusSelector.setRefinementFocus({
    type: 'screen-circle',
    center: { x: 0.125, y: 0.5 },
    radius: 0.08,
    detailBias: 2,
  });
  assert.deepEqual(selectedRefinedRootKeys(focusSelector, focusHierarchy), ['a-negative']);
  assert.ok(focusSelector.getSelectionMetrics().motionWeightMax <= 1);
});
