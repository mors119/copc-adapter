import test from 'node:test';
import assert from 'node:assert/strict';

import { PointPrimitiveRenderer } from '../src/cesium/render/CopcPointRenderer.ts';

function createViewer() {
  const added = [];
  const removed = [];

  return {
    added,
    removed,
    scene: {
      primitives: {
        add(collection) {
          added.push(collection);
          return collection;
        },
        remove(collection) {
          removed.push(collection);
          return true;
        },
      },
    },
  };
}

function createPoints() {
  return {
    pointCount: 2,
    coordinates: new Float64Array([
      -123, 44, 100,
      -123.1, 44.1, 200,
    ]),
    attributes: {
      intensity: new Uint16Array([1000, 3000]),
      classification: new Uint8Array([2, 6]),
      red: new Uint16Array([255, 0]),
      green: new Uint16Array([0, 255]),
      blue: new Uint16Array([0, 0]),
    },
  };
}

test('PointPrimitiveRenderer preserves node lifecycle and optional pick identity', () => {
  const viewer = createViewer();
  const renderer = new PointPrimitiveRenderer();
  const stages = [];
  renderer.attachTo(viewer);

  renderer.addOrUpdateNode('node-a', createPoints(), {
    pointSize: 5,
    colorMode: 'rgb',
    pointId: (index) => `point-${index}`,
    onPerformance: (stage) => stages.push(stage),
  });

  assert.equal(renderer.hasNode('node-a'), true);
  assert.equal(renderer.getRenderedPointCount(), 2);
  assert.equal(viewer.added[0].get(0).id, 'point-0');
  assert.ok(stages.includes('geographicToCartesian'));
  assert.ok(stages.includes('pointStylePreparation'));
  assert.ok(stages.includes('pointCollectionCreation'));
  assert.ok(stages.includes('pointAdd'));
  assert.ok(stages.includes('rendererPreparation'));

  renderer.addOrUpdateNode('node-a', createPoints(), {
    pointSize: 2,
    colorMode: 'classification',
  });
  assert.equal(viewer.removed.length, 1);
  assert.equal(renderer.getRenderedNodeKeys().join(','), 'node-a');
  assert.equal(renderer.getRenderedPointCount(), 2);

  renderer.removeNode('node-a');
  assert.equal(renderer.getRenderedPointCount(), 0);
  renderer.clear();
  renderer.destroy();
  assert.throws(
    () => renderer.addOrUpdateNode('node-b', createPoints(), { pointSize: 2 }),
    /not attached/,
  );
});

test('PointPrimitiveRenderer forwards every supported style mode through the boundary', () => {
  const viewer = createViewer();
  const renderer = new PointPrimitiveRenderer();
  renderer.attachTo(viewer);

  for (const colorMode of ['fixed', 'rgb', 'elevation', 'intensity', 'classification']) {
    renderer.addOrUpdateNode(colorMode, createPoints(), {
      pointSize: 2,
      colorMode,
      elevationRange: { min: 100, max: 200 },
    });
  }

  assert.equal(renderer.getRenderedNodeKeys().length, 5);
  assert.equal(renderer.getRenderedPointCount(), 10);
});
