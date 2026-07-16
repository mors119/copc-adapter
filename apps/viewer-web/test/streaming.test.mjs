import test from 'node:test';
import assert from 'node:assert/strict';

import { createNodePointCache } from '../src/viewer/streaming/createNodePointCache.ts';
import {
  calculateBoundsDistanceMeters,
  calculateDistanceMeters,
  NodeSelector,
} from '../src/viewer/streaming/NodeSelector.ts';
import { StreamingManager } from '../src/viewer/streaming/StreamingManager.ts';

function createStreamingNode({
  key,
  level,
  pointCount,
  center,
  bounds,
  approximateSizeMeters,
  boundingRadiusMeters,
  children = [],
}) {
  return {
    node: {
      key,
      level,
      x: 0,
      y: 0,
      z: 0,
      pointCount,
      pointDataOffset: 0,
      pointDataLength: 0,
      children,
    },
    children,
    center,
    bounds,
    approximateSizeMeters,
    boundingRadiusMeters,
  };
}

function createSelector(options = {}) {
  return new NodeSelector({
    maxNodes: 8,
    maxDepth: 4,
    refineDistanceMultiplier: 6,
    maxRenderDistanceMeters: 12000,
    ...options,
  });
}

function createCamera(overrides = {}) {
  return {
    longitude: -123,
    latitude: 44,
    height: 1000,
    viewDistanceMeters: 6000,
    ...overrides,
  };
}

test('NodeSelector selects the visible root node when the camera is far', () => {
  const selector = createSelector();
  const hierarchy = new Map([
    [
      '0-0-0-0',
      createStreamingNode({
        key: '0-0-0-0',
        level: 0,
        pointCount: 100,
        children: ['1-0-0-0'],
        center: { longitude: -123, latitude: 44, height: 100 },
        bounds: {
          minX: -123.01,
          minY: 43.99,
          minZ: 50,
          maxX: -122.99,
          maxY: 44.01,
          maxZ: 150,
        },
        approximateSizeMeters: 1200,
        boundingRadiusMeters: 800,
      }),
    ],
    [
      '1-0-0-0',
      createStreamingNode({
        key: '1-0-0-0',
        level: 1,
        pointCount: 60,
        center: { longitude: -123.0008, latitude: 44, height: 100 },
        bounds: {
          minX: -123.001,
          minY: 43.999,
          minZ: 80,
          maxX: -123.0006,
          maxY: 44.001,
          maxZ: 120,
        },
        approximateSizeMeters: 300,
        boundingRadiusMeters: 120,
      }),
    ],
  ]);

  const selected = selector.selectVisibleNodes(
    createCamera({ height: 40000, viewDistanceMeters: 12000 }),
    hierarchy,
  );

  assert.deepEqual(selected.map((entry) => entry.node.key), ['0-0-0-0']);
});

test('NodeSelector selects child nodes when the camera is closer', () => {
  const selector = createSelector();
  const hierarchy = new Map([
    [
      '0-0-0-0',
      createStreamingNode({
        key: '0-0-0-0',
        level: 0,
        pointCount: 100,
        children: ['1-0-0-0', '1-1-0-0'],
        center: { longitude: -123, latitude: 44, height: 100 },
        bounds: {
          minX: -123.01,
          minY: 43.99,
          minZ: 50,
          maxX: -122.99,
          maxY: 44.01,
          maxZ: 150,
        },
        approximateSizeMeters: 1200,
        boundingRadiusMeters: 800,
      }),
    ],
    [
      '1-0-0-0',
      createStreamingNode({
        key: '1-0-0-0',
        level: 1,
        pointCount: 60,
        center: { longitude: -123.0008, latitude: 44, height: 100 },
        bounds: {
          minX: -123.001,
          minY: 43.999,
          minZ: 80,
          maxX: -123.0006,
          maxY: 44.001,
          maxZ: 120,
        },
        approximateSizeMeters: 300,
        boundingRadiusMeters: 120,
      }),
    ],
    [
      '1-1-0-0',
      createStreamingNode({
        key: '1-1-0-0',
        level: 1,
        pointCount: 40,
        center: { longitude: -122.9992, latitude: 44, height: 100 },
        bounds: {
          minX: -122.9994,
          minY: 43.999,
          minZ: 80,
          maxX: -122.999,
          maxY: 44.001,
          maxZ: 120,
        },
        approximateSizeMeters: 300,
        boundingRadiusMeters: 120,
      }),
    ],
  ]);

  const selected = selector.selectVisibleNodes(
    createCamera({ height: 1500, viewDistanceMeters: 6000 }),
    hierarchy,
  );

  assert.deepEqual(
    selected.map((entry) => entry.node.key),
    ['1-0-0-0', '1-1-0-0'],
  );
});

test('NodeSelector respects the maximum depth limit', () => {
  const selector = createSelector({ maxDepth: 0 });
  const hierarchy = new Map([
    [
      '0-0-0-0',
      createStreamingNode({
        key: '0-0-0-0',
        level: 0,
        pointCount: 100,
        children: ['1-0-0-0'],
        center: { longitude: -123, latitude: 44, height: 100 },
        bounds: {
          minX: -123.01,
          minY: 43.99,
          minZ: 50,
          maxX: -122.99,
          maxY: 44.01,
          maxZ: 150,
        },
        approximateSizeMeters: 1200,
        boundingRadiusMeters: 800,
      }),
    ],
    [
      '1-0-0-0',
      createStreamingNode({
        key: '1-0-0-0',
        level: 1,
        pointCount: 60,
        center: { longitude: -123.0008, latitude: 44, height: 100 },
        bounds: {
          minX: -123.001,
          minY: 43.999,
          minZ: 80,
          maxX: -123.0006,
          maxY: 44.001,
          maxZ: 120,
        },
        approximateSizeMeters: 300,
        boundingRadiusMeters: 120,
      }),
    ],
  ]);

  const selected = selector.selectVisibleNodes(createCamera(), hierarchy);

  assert.deepEqual(selected.map((entry) => entry.node.key), ['0-0-0-0']);
});

test('NodeSelector uses bounds to exclude nodes outside the current view range', () => {
  const selector = createSelector();
  const hierarchy = new Map([
    [
      '0-0-0-0',
      createStreamingNode({
        key: '0-0-0-0',
        level: 0,
        pointCount: 100,
        center: { longitude: -123, latitude: 44, height: 100 },
        bounds: {
          minX: -123.01,
          minY: 43.99,
          minZ: 50,
          maxX: -122.99,
          maxY: 44.01,
          maxZ: 150,
        },
        approximateSizeMeters: 1200,
        boundingRadiusMeters: 800,
      }),
    ],
    [
      '0-1-0-0',
      createStreamingNode({
        key: '0-1-0-0',
        level: 0,
        pointCount: 100,
        center: { longitude: -120, latitude: 44, height: 100 },
        bounds: {
          minX: -120.01,
          minY: 43.99,
          minZ: 50,
          maxX: -119.99,
          maxY: 44.01,
          maxZ: 150,
        },
        approximateSizeMeters: 1200,
        boundingRadiusMeters: 800,
      }),
    ],
  ]);

  const selected = selector.selectVisibleNodes(
    createCamera({ viewDistanceMeters: 5000 }),
    hierarchy,
  );

  assert.deepEqual(selected.map((entry) => entry.node.key), ['0-0-0-0']);
});

test('calculateDistanceMeters measures geographic and height delta', () => {
  const distance = calculateDistanceMeters(
    createCamera({ height: 1000, viewDistanceMeters: 5000 }),
    createStreamingNode({
      key: '0-0-0-0',
      level: 0,
      pointCount: 1,
      center: { longitude: -123, latitude: 44.001, height: 1500 },
      bounds: {
        minX: -123,
        minY: 44.001,
        minZ: 1500,
        maxX: -123,
        maxY: 44.001,
        maxZ: 1500,
      },
      approximateSizeMeters: 100,
      boundingRadiusMeters: 0,
    }),
  );

  assert.ok(distance > 500);
  assert.ok(distance < 700);
});

test('calculateBoundsDistanceMeters returns zero when the camera is inside node bounds', () => {
  const distance = calculateBoundsDistanceMeters(
    createCamera({ longitude: -123, latitude: 44, height: 100 }),
    createStreamingNode({
      key: '0-0-0-0',
      level: 0,
      pointCount: 1,
      center: { longitude: -123, latitude: 44, height: 100 },
      bounds: {
        minX: -123.01,
        minY: 43.99,
        minZ: 50,
        maxX: -122.99,
        maxY: 44.01,
        maxZ: 150,
      },
      approximateSizeMeters: 100,
      boundingRadiusMeters: 20,
    }),
  );

  assert.equal(distance, 0);
});

test('StreamingManager uses cached nodes and loads missing nodes', async () => {
  let loadCount = 0;
  const hierarchy = new Map([
    [
      '0-0-0-0',
      createStreamingNode({
        key: '0-0-0-0',
        level: 0,
        pointCount: 100,
        children: ['1-0-0-0'],
        center: { longitude: -123, latitude: 44, height: 100 },
        bounds: {
          minX: -123.01,
          minY: 43.99,
          minZ: 50,
          maxX: -122.99,
          maxY: 44.01,
          maxZ: 150,
        },
        approximateSizeMeters: 1200,
        boundingRadiusMeters: 800,
      }),
    ],
    [
      '1-0-0-0',
      createStreamingNode({
        key: '1-0-0-0',
        level: 1,
        pointCount: 60,
        center: { longitude: -123.0008, latitude: 44, height: 100 },
        bounds: {
          minX: -123.001,
          minY: 43.999,
          minZ: 80,
          maxX: -123.0006,
          maxY: 44.001,
          maxZ: 120,
        },
        approximateSizeMeters: 300,
        boundingRadiusMeters: 120,
      }),
    ],
  ]);
  const cache = createNodePointCache(async (nodeKey) => {
    loadCount += 1;

    return {
      pointCount: 1,
      coordinates: new Float64Array([
        -123,
        44,
        nodeKey.length,
      ]),
    };
  }, { maxEntries: 2 });
  const manager = new StreamingManager(hierarchy, {
    maxNodes: 8,
    maxDepth: 4,
    refineDistanceMultiplier: 6,
    maxRenderDistanceMeters: 12000,
  }, cache);

  const firstUpdate = await manager.update(
    createCamera({ height: 40000, viewDistanceMeters: 12000 }),
  );
  const secondUpdate = await manager.update(
    createCamera({ height: 40000, viewDistanceMeters: 12000 }),
  );
  const thirdUpdate = await manager.update(
    createCamera({ height: 1500, viewDistanceMeters: 6000 }),
  );

  assert.deepEqual(firstUpdate.selectedNodeKeys, ['0-0-0-0']);
  assert.equal(firstUpdate.loadedNodePoints.size, 1);
  assert.deepEqual(secondUpdate.removedNodeKeys, []);
  assert.equal(loadCount, 2);
  assert.deepEqual(thirdUpdate.selectedNodeKeys, ['1-0-0-0']);
  assert.deepEqual(thirdUpdate.removedNodeKeys, ['0-0-0-0']);
});
