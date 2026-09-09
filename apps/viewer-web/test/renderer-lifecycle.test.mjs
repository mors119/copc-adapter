import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  renderCopcPoints,
  toCartesian3ArrayFromBuffer,
  toCartesian3ArrayFromWorldBuffer,
} from '../src/cesium/render/renderPoints.ts';
import { geographicToEcef } from '../src/coordinates/transform/worldCoordinates.ts';

test('toCartesian3ArrayFromBuffer converts buffered geographic triples', () => {
  const positions = toCartesian3ArrayFromBuffer({
    pointCount: 2,
    coordinates: new Float64Array([
      -123.0, 44.0, 100.0,
      -123.1, 44.1, 200.0,
    ]),
  });

  assert.equal(positions.length, 2);
  assert.ok(Number.isFinite(positions[0].x));
  assert.ok(Number.isFinite(positions[1].z));
});

test('prepared ECEF buffers bypass geographic-to-Cesium conversion', () => {
  const points = {
    pointCount: 2,
    coordinates: new Float64Array([
      -123.0, 44.0, 100.0,
      -123.1, 44.1, 200.0,
    ]),
    worldCoordinates: new Float64Array([
      1, 2, 3,
      4, 5, 6,
    ]),
    worldCoordinateSystem: 'wgs84-ecef-meters',
  };

  const positions = toCartesian3ArrayFromWorldBuffer(points);
  assert.deepEqual(
    positions.map(({ x, y, z }) => [x, y, z]),
    [[1, 2, 3], [4, 5, 6]],
  );
  assert.deepEqual(
    toCartesian3ArrayFromBuffer(points).map(({ x, y, z }) => [x, y, z]),
    [[1, 2, 3], [4, 5, 6]],
  );
});

test('prepared ECEF positions match Cesium geographic conversion output', () => {
  const geographic = { longitude: -123, latitude: 44, height: 100 };
  const ecef = geographicToEcef(geographic);
  const expected = Cesium.Cartesian3.fromDegrees(
    geographic.longitude,
    geographic.latitude,
    geographic.height,
  );
  const positions = toCartesian3ArrayFromWorldBuffer({
    pointCount: 1,
    coordinates: new Float64Array([
      geographic.longitude,
      geographic.latitude,
      geographic.height,
    ]),
    worldCoordinates: new Float64Array([ecef.x, ecef.y, ecef.z]),
    worldCoordinateSystem: 'wgs84-ecef-meters',
  });

  assert.ok(Math.abs(ecef.x - expected.x) < 1e-6);
  assert.ok(Math.abs(ecef.y - expected.y) < 1e-6);
  assert.ok(Math.abs(ecef.z - expected.z) < 1e-6);
  assert.deepEqual(
    positions.map(({ x, y, z }) => [x, y, z]),
    [[ecef.x, ecef.y, ecef.z]],
  );
});

test('renderCopcPoints reports the direct world-buffer stage for prepared data', () => {
  const stages = [];
  const viewer = {
    scene: {
      primitives: {
        add(collection) {
          return collection;
        },
      },
    },
  };
  renderCopcPoints(viewer, {
    pointCount: 1,
    coordinates: new Float64Array([-123, 44, 100]),
    worldCoordinates: new Float64Array([1, 2, 3]),
    worldCoordinateSystem: 'wgs84-ecef-meters',
  }, {
    pointSize: 2,
    onPerformance: (stage) => stages.push(stage),
  });

  assert.ok(stages.includes('worldToCartesian'));
  assert.equal(stages.includes('geographicToCartesian'), false);
});

test('renderCopcPoints replaces an existing primitive collection', () => {
  const removedCollections = [];
  const addedCollections = [];
  const viewer = {
    scene: {
      primitives: {
        add(collection) {
          addedCollections.push(collection);
          return collection;
        },
        remove(collection) {
          removedCollections.push(collection);
          return true;
        },
      },
    },
  };
  const collection = renderCopcPoints(
    viewer,
    {
      pointCount: 2,
      coordinates: new Float64Array([
        -123.0, 44.0, 100.0,
        -123.1, 44.1, 200.0,
      ]),
    },
    { pointSize: 5 },
  );

  assert.equal(removedCollections.length, 0);
  assert.equal(addedCollections.length, 1);
  assert.equal(collection.length, 2);
  assert.equal(collection.get(0).pixelSize, 5);
  assert.deepEqual(
    [
      collection.get(0).color.red,
      collection.get(0).color.green,
      collection.get(0).color.blue,
      collection.get(0).color.alpha,
    ],
    [0, 1, 1, 0.9],
  );
});
