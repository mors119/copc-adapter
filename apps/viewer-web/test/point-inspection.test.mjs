import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inspectCopcPoint,
  isCopcPointPickId,
} from '../src/copc/points/pointInspection.ts';

function createPoints({ includeAttributes = true } = {}) {
  return {
    pointCount: 2,
    coordinates: new Float64Array([
      10, 20, 30,
      11, 21, 31,
    ]),
    sourceCoordinates: new Float64Array([
      100, 200, 300,
      101, 201, 301,
    ]),
    ...(includeAttributes ? {
      attributes: {
        intensity: new Uint16Array([8000, 8241]),
        classification: new Uint8Array([2, 5]),
        red: new Uint16Array([12341, 12342]),
        green: new Uint16Array([24211, 24212]),
        blue: new Uint16Array([9841, 9842]),
      },
    } : {}),
  };
}

test('compact pick identity maps to position, source XYZ, and attributes', () => {
  const inspection = inspectCopcPoint(
    { nodeKey: '4-12-7-3', pointIndex: 1 },
    { level: 4 },
    createPoints(),
    'rust',
  );

  assert.deepEqual(inspection, {
    nodeKey: '4-12-7-3',
    level: 4,
    pointIndex: 1,
    longitude: 11,
    latitude: 21,
    height: 31,
    source: { x: 101, y: 201, z: 301 },
    intensity: 8241,
    classification: 5,
    classificationLabel: 'High Vegetation',
    rgb: { red: 12342, green: 24212, blue: 9842 },
    backend: 'rust',
  });
});

test('unrequested fields remain unavailable and unknown classifications stay numeric', () => {
  const points = createPoints({ includeAttributes: false });
  points.attributes = { classification: new Uint8Array([250, 250]) };
  const inspection = inspectCopcPoint(
    { nodeKey: '1-0-0-0', pointIndex: 0 },
    { level: 1 },
    points,
    'copc-js',
  );

  assert.equal(inspection.intensity, undefined);
  assert.equal(inspection.rgb, undefined);
  assert.equal(inspection.classification, 250);
  assert.equal(inspection.classificationLabel, undefined);
});

test('invalid identities and indices do not produce stale inspection data', () => {
  const points = createPoints();
  assert.equal(isCopcPointPickId({ nodeKey: '', pointIndex: 0 }), false);
  assert.equal(isCopcPointPickId({ nodeKey: 'node', pointIndex: -1 }), false);
  assert.equal(isCopcPointPickId({ nodeKey: 'node', pointIndex: 0.5 }), false);
  assert.equal(
    inspectCopcPoint({ nodeKey: 'node', pointIndex: 2 }, { level: 0 }, points, 'custom'),
    undefined,
  );
  assert.equal(
    inspectCopcPoint({ nodeKey: 'node', pointIndex: 0 }, { level: 0 }, {
      ...points,
      coordinates: new Float64Array([1, 2]),
    }, 'custom'),
    undefined,
  );
});
