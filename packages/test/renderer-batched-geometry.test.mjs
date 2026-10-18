import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { BatchedGeometryPointRenderer } from '../cesium/render/BatchedGeometryPointRenderer.ts';

function createPreparedPoints() {
  return {
    pointCount: 2,
    coordinates: new Float64Array([-123, 44, 100, -123.00001, 44.00001, 101]),
    worldCoordinates: new Float64Array([
      -2615000.25, -3930000.5, 3638000.75,
      -2615000.24, -3930000.49, 3638000.76,
    ]),
    worldCoordinateSystem: 'wgs84-ecef-meters',
  };
}

test('BatchedGeometryPointRenderer removes owned nodes and preserves scene primitives', () => {
  const scenePrimitives = new Cesium.PrimitiveCollection();
  const applicationPrimitive = new Cesium.PrimitiveCollection();
  scenePrimitives.add(applicationPrimitive);

  const renderer = new BatchedGeometryPointRenderer();
  renderer.attachTo({ scene: { primitives: scenePrimitives } });
  const rendererContainer = scenePrimitives.get(1);

  renderer.addOrUpdateNode('node-a', createPreparedPoints(), {
    pointSize: 2,
    colorMode: 'fixed',
  });
  assert.equal(renderer.hasNode('node-a'), true);
  assert.equal(renderer.getRenderedPointCount(), 2);
  assert.equal(rendererContainer.length, 1);
  const removedPrimitive = rendererContainer.get(0);

  renderer.removeNode('node-a');
  assert.equal(rendererContainer.length, 0);
  assert.equal(renderer.hasNode('node-a'), false);
  assert.equal(removedPrimitive.isDestroyed(), true);

  renderer.addOrUpdateNode('node-b', createPreparedPoints(), {
    pointSize: 2,
    colorMode: 'fixed',
  });
  const clearedPrimitive = rendererContainer.get(0);
  renderer.clear();
  assert.equal(rendererContainer.length, 0);
  assert.equal(clearedPrimitive.isDestroyed(), true);
  renderer.destroy();

  assert.equal(scenePrimitives.length, 1);
  assert.equal(scenePrimitives.get(0), applicationPrimitive);
  assert.equal(applicationPrimitive.isDestroyed(), false);
  scenePrimitives.destroy();
});
