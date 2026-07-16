import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  renderCopcPoints,
  toCartesian3ArrayFromBuffer,
} from '../src/cesium/render/renderPoints.ts';

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
  const existingCollection = new Cesium.PointPrimitiveCollection();

  const collection = renderCopcPoints(
    viewer,
    {
      pointCount: 2,
      coordinates: new Float64Array([
        -123.0, 44.0, 100.0,
        -123.1, 44.1, 200.0,
      ]),
    },
    existingCollection,
  );

  assert.equal(removedCollections.length, 1);
  assert.equal(removedCollections[0], existingCollection);
  assert.equal(addedCollections.length, 1);
  assert.equal(collection.length, 2);
});
