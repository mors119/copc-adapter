import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createBoundingSphereFromGeographicBounds } from '../src/viewer/streaming/view.ts';

const rendererContractSource = readFileSync(
  new URL('../src/viewer/streaming/renderer.ts', import.meta.url),
  'utf8',
);
const streamingTypesSource = readFileSync(
  new URL('../src/viewer/streaming/types.ts', import.meta.url),
  'utf8',
);
const streamingViewSource = readFileSync(
  new URL('../src/viewer/streaming/view.ts', import.meta.url),
  'utf8',
);

function createFakeRenderer() {
  const nodes = new Map();

  return {
    addOrUpdateNode(nodeKey, points) {
      nodes.set(nodeKey, points.pointCount);
    },
    removeNode(nodeKey) {
      nodes.delete(nodeKey);
    },
    clear() {
      nodes.clear();
    },
    destroy() {
      nodes.clear();
    },
    hasNode(nodeKey) {
      return nodes.has(nodeKey);
    },
    getRenderedNodePointCount(nodeKey) {
      return nodes.get(nodeKey);
    },
    getRenderedNodeKeys() {
      return [...nodes.keys()].sort();
    },
    getRenderedPointCount() {
      return [...nodes.values()].reduce((total, count) => total + count, 0);
    },
  };
}

test('the shared renderer contract has no engine attachment or Cesium geometry', () => {
  const interfaceSource = rendererContractSource.slice(
    rendererContractSource.indexOf('export interface CopcPointRenderer'),
  );

  assert.doesNotMatch(rendererContractSource, /from ['"].*cesium/iu);
  assert.doesNotMatch(rendererContractSource, /Cesium/iu);
  assert.doesNotMatch(interfaceSource, /attachTo|getSelectionBoundingSphere|Viewer|BoundingSphere/u);
  assert.doesNotMatch(streamingTypesSource, /from ['"].*cesium/iu);
  assert.doesNotMatch(streamingViewSource, /Cesium\.|Cartesian3|Cartographic/u);
});

test('a renderer-neutral fake preserves node lifecycle and point counts', () => {
  const renderer = createFakeRenderer();
  const points = (pointCount) => ({
    pointCount,
    coordinates: new Float64Array(pointCount * 3),
  });

  renderer.addOrUpdateNode('node-b', points(3), { pointSize: 2 });
  renderer.addOrUpdateNode('node-a', points(2), { pointSize: 2 });
  assert.deepEqual(renderer.getRenderedNodeKeys(), ['node-a', 'node-b']);
  assert.equal(renderer.getRenderedNodePointCount('node-a'), 2);
  assert.equal(renderer.getRenderedPointCount(), 5);

  renderer.addOrUpdateNode('node-a', points(4), { pointSize: 2 });
  assert.equal(renderer.getRenderedPointCount(), 7);
  renderer.removeNode('node-b');
  assert.deepEqual(renderer.getRenderedNodeKeys(), ['node-a']);
  renderer.clear();
  assert.equal(renderer.getRenderedPointCount(), 0);
  renderer.destroy();
});

test('project-owned bounding spheres remain deterministic plain geometry', () => {
  const center = { longitude: 10, latitude: 20, height: 100 };
  const bounds = {
    minX: 9.9,
    minY: 19.9,
    minZ: 0,
    maxX: 10.1,
    maxY: 20.1,
    maxZ: 200,
  };

  assert.deepEqual(
    createBoundingSphereFromGeographicBounds(center, bounds),
    createBoundingSphereFromGeographicBounds(center, bounds),
  );
});
