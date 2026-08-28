import test from 'node:test';
import assert from 'node:assert/strict';

import { extractHorizontalUnitScale } from '../src/coordinates/crs/parseCopcWkt.ts';
import { createNodePointCache } from '../src/viewer/streaming/createNodePointCache.ts';
import {
  calculateBoundsDistanceMeters,
  calculateDistanceMeters,
  compareNodePriority,
  calculateScreenSpaceErrorPixels,
  NodeSelector,
} from '../src/viewer/streaming/NodeSelector.ts';
import {
  createPerspectiveViewFrustum,
  intersectsViewFrustum,
} from '../src/viewer/streaming/view.ts';
import { StreamingManager } from '../src/viewer/streaming/StreamingManager.ts';
import { createStreamingWorkBatches } from '../src/viewer/streaming/scheduler.ts';

function createStreamingNode({
  key,
  level,
  pointCount,
  center,
  bounds,
  approximateSizeMeters,
  boundingRadiusMeters,
  boundingSphere,
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
    boundingSphere,
  };
}

function createSelector(options = {}) {
  return new NodeSelector({
    maxNodes: 8,
    maxDepth: 4,
    maxScreenSpaceError: 8,
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

function createWorkNode(key, pointCount, level = 1) {
  return createStreamingNode({
    key,
    level,
    pointCount,
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
  });
}

test('streaming work batches enforce a deterministic point bound', () => {
  const batches = createStreamingWorkBatches([
    createWorkNode('a', 70),
    createWorkNode('b', 30),
    createWorkNode('c', 40),
  ], 100);

  assert.deepEqual(
    batches.map((batch) => [batch.nodes.map((node) => node.node.key), batch.estimatedPointCount]),
    [
      [['a', 'b'], 100],
      [['c'], 40],
    ],
  );
});

test('a stricter workload bound never increases synchronous batch workload', () => {
  const nodes = [createWorkNode('a', 100), createWorkNode('b', 100), createWorkNode('c', 100)];
  const relaxed = createStreamingWorkBatches(nodes, 300);
  const strict = createStreamingWorkBatches(nodes, 100);

  assert.ok(strict.length >= relaxed.length);
  assert.ok(
    Math.max(...strict.map((batch) => batch.estimatedPointCount))
      <= Math.max(...relaxed.map((batch) => batch.estimatedPointCount)),
  );
});

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

  assert.deepEqual(
    selected.map((entry) => entry.node.key),
    ['0-0-0-0'],
  );
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
    ['1-1-0-0', '1-0-0-0'],
  );
});

test('NodeSelector prioritises finer LoD before a closer coarse fallback', () => {
  const camera = createCamera();
  const coarse = createWorkNode('coarse', 10, 1);
  const fine = createWorkNode('fine', 100, 2);

  assert.ok(compareNodePriority(camera, fine, coarse) < 0);
});

test('NodeSelector caps a refined selection at maxNodes', () => {
  const selector = createSelector({ maxNodes: 1 });
  const hierarchy = new Map([
    ['0-0-0-0', createStreamingNode({
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
    })],
    ['1-0-0-0', createStreamingNode({
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
    })],
    ['1-1-0-0', createStreamingNode({
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
    })],
  ]);

  const selected = selector.selectVisibleNodes(
    createCamera({ height: 1500, viewDistanceMeters: 6000 }),
    hierarchy,
  );

  assert.equal(selected.length, 1);
});

test('NodeSelector does not select a parent when a deeper descendant is selected', () => {
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
        children: ['2-0-0-0'],
        center: { longitude: -123, latitude: 44, height: 100 },
        bounds: {
          minX: -123.001,
          minY: 43.999,
          minZ: 80,
          maxX: -122.999,
          maxY: 44.001,
          maxZ: 120,
        },
        approximateSizeMeters: 600,
        boundingRadiusMeters: 120,
      }),
    ],
    [
      '2-0-0-0',
      createStreamingNode({
        key: '2-0-0-0',
        level: 2,
        pointCount: 30,
        center: { longitude: -123, latitude: 44, height: 100 },
        bounds: {
          minX: -123.0005,
          minY: 43.9995,
          minZ: 90,
          maxX: -122.9995,
          maxY: 44.0005,
          maxZ: 110,
        },
        approximateSizeMeters: 100,
        boundingRadiusMeters: 60,
      }),
    ],
  ]);

  const selected = selector.selectVisibleNodes(createCamera(), hierarchy);

  assert.deepEqual(
    selected.map((entry) => entry.node.key),
    ['2-0-0-0'],
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

  assert.deepEqual(
    selected.map((entry) => entry.node.key),
    ['0-0-0-0'],
  );
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

  assert.deepEqual(
    selected.map((entry) => entry.node.key),
    ['0-0-0-0'],
  );
});

function createTestFrustum(direction = { x: 0, y: 0, z: 1 }) {
  return createPerspectiveViewFrustum({
    position: { x: 0, y: 0, z: 0 },
    direction,
    up: { x: 0, y: 1, z: 0 },
    right: { x: 1, y: 0, z: 0 },
    verticalFovRadians: Math.PI / 2,
    viewportHeightPixels: 1000,
    aspectRatio: 1,
    nearMeters: 1,
    farMeters: 10,
  });
}

function createProjectionCamera(overrides = {}) {
  return createCamera({
    viewFrustum: createPerspectiveViewFrustum({
      position: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      up: { x: 0, y: 1, z: 0 },
      right: { x: 1, y: 0, z: 0 },
      verticalFovRadians: Math.PI / 3,
      viewportHeightPixels: 1000,
      aspectRatio: 1,
      nearMeters: 1,
      farMeters: 100000,
    }),
    ...overrides,
  });
}

test('screen-space error responds monotonically to viewport, distance, and FOV', () => {
  const node = createWorkNode('node', 100, 0);
  const base = createProjectionCamera({ height: 1000 });
  const largerViewport = {
    ...base,
    viewFrustum: { ...base.viewFrustum, viewportHeightPixels: 2000 },
  };
  const narrowerFov = {
    ...base,
    viewFrustum: { ...base.viewFrustum, verticalFovRadians: Math.PI / 4 },
  };
  const farther = createProjectionCamera({ height: 2000 });

  const baseError = calculateScreenSpaceErrorPixels(base, node);
  assert.ok(calculateScreenSpaceErrorPixels(largerViewport, node) > baseError);
  assert.ok(calculateScreenSpaceErrorPixels(narrowerFov, node) > baseError);
  assert.ok(calculateScreenSpaceErrorPixels(farther, node) < baseError);

  const root = createWorkNode('root', 100, 0);
  root.children = ['child'];
  const child = createWorkNode('child', 50, 1);
  const hierarchy = new Map([['root', root], ['child', child]]);
  const selector = (viewportHeightPixels) => new NodeSelector({
    maxNodes: 8,
    maxDepth: 4,
    maxScreenSpaceError: 60,
    maxRenderDistanceMeters: 12000,
  }).selectVisibleNodes({
    ...base,
    viewFrustum: { ...base.viewFrustum, viewportHeightPixels },
  }, hierarchy);

  assert.deepEqual(selector(1000).map((entry) => entry.node.key), ['root']);
  assert.deepEqual(selector(2000).map((entry) => entry.node.key), ['child']);
});

test('stricter SSE thresholds never select less detail', () => {
  const root = createWorkNode('0-0-0-0', 100, 0);
  root.children = ['1-0-0-0'];
  const child = createWorkNode('1-0-0-0', 50, 1);
  child.children = ['2-0-0-0'];
  const grandchild = createWorkNode('2-0-0-0', 25, 2);
  const hierarchy = new Map([
    [root.node.key, root],
    [child.node.key, child],
    [grandchild.node.key, grandchild],
  ]);
  const camera = createProjectionCamera({ height: 1000 });
  const relaxed = new NodeSelector({
    maxNodes: 8,
    maxDepth: 4,
    maxScreenSpaceError: 1000,
    maxRenderDistanceMeters: 12000,
  }).selectVisibleNodes(camera, hierarchy);
  const strict = new NodeSelector({
    maxNodes: 8,
    maxDepth: 4,
    maxScreenSpaceError: 1,
    maxRenderDistanceMeters: 12000,
  }).selectVisibleNodes(camera, hierarchy);

  assert.ok(Math.max(...strict.map((node) => node.node.level))
    >= Math.max(...relaxed.map((node) => node.node.level)));
});

test('frustum culling prevents a high-SSE out-of-view node from refining', () => {
  const selector = createSelector({ maxRenderDistanceMeters: 100000 });
  const root = createFrustumNode('root', {
    center: { x: 100000, y: 0, z: 5 },
    radiusMeters: 0.1,
  });
  root.children = ['child'];
  const child = createFrustumNode('child', {
    center: { x: 100000, y: 0, z: 5 },
    radiusMeters: 0.1,
  });
  child.node.level = 1;
  const selected = selector.selectVisibleNodes(
    createCamera({ height: 100, viewFrustum: createTestFrustum() }),
    new Map([['root', root], ['child', child]]),
  );

  assert.deepEqual(selected, []);
  assert.equal(selector.getSelectionMetrics().refinedNodeCount, 0);
  assert.equal(selector.getSelectionMetrics().frustumCulledCount, 1);
});

function createFrustumNode(key, sphere) {
  return createStreamingNode({
    key,
    level: 0,
    pointCount: 1,
    center: { longitude: -123, latitude: 44, height: 100 },
    bounds: {
      minX: -123.001,
      minY: 43.999,
      minZ: 99,
      maxX: -122.999,
      maxY: 44.001,
      maxZ: 101,
    },
    approximateSizeMeters: 10,
    boundingRadiusMeters: 1,
    boundingSphere: sphere,
  });
}

test('view frustum sphere culling retains inside and intersecting nodes', () => {
  const frustum = createTestFrustum();

  assert.equal(
    intersectsViewFrustum(frustum, { center: { x: 0, y: 0, z: 5 }, radiusMeters: 0.1 }),
    true,
  );
  assert.equal(
    intersectsViewFrustum(frustum, { center: { x: 5.5, y: 0, z: 5 }, radiusMeters: 1 }),
    true,
  );
  assert.equal(
    intersectsViewFrustum(frustum, { center: { x: 0, y: 0, z: -5 }, radiusMeters: 0.1 }),
    false,
  );
});

test('NodeSelector responds to orientation with an unchanged camera position', () => {
  const selector = createSelector({ maxRenderDistanceMeters: 100 });
  const hierarchy = new Map([
    ['forward', createFrustumNode('forward', {
      center: { x: 0, y: 0, z: 5 },
      radiusMeters: 0.1,
    })],
    ['backward', createFrustumNode('backward', {
      center: { x: 0, y: 0, z: -5 },
      radiusMeters: 0.1,
    })],
  ]);
  const camera = createCamera({ height: 100, viewFrustum: createTestFrustum() });

  assert.deepEqual(
    selector.selectVisibleNodes(camera, hierarchy).map((entry) => entry.node.key),
    ['forward'],
  );
  assert.equal(selector.getSelectionMetrics().frustumCulledCount, 1);

  const rotatedCamera = {
    ...camera,
    viewFrustum: createTestFrustum({ x: 0, y: 0, z: -1 }),
  };
  assert.deepEqual(
    selector.selectVisibleNodes(rotatedCamera, hierarchy).map((entry) => entry.node.key),
    ['backward'],
  );
});

test('NodeSelector falls back to the nearest node when nothing is visible', () => {
  const selector = createSelector({ maxRenderDistanceMeters: 10 });
  const hierarchy = new Map([
    [
      '0-0-0-0',
      createStreamingNode({
        key: '0-0-0-0',
        level: 0,
        pointCount: 50,
        center: { longitude: -123, latitude: 44.5, height: 100 },
        bounds: {
          minX: -123.1,
          minY: 44.4,
          minZ: 50,
          maxX: -122.9,
          maxY: 44.6,
          maxZ: 150,
        },
        approximateSizeMeters: 1200,
        boundingRadiusMeters: 0,
      }),
    ],
    [
      '0-1-0-0',
      createStreamingNode({
        key: '0-1-0-0',
        level: 0,
        pointCount: 50,
        center: { longitude: -121, latitude: 45.5, height: 100 },
        bounds: {
          minX: -121.1,
          minY: 45.4,
          minZ: 50,
          maxX: -120.9,
          maxY: 45.6,
          maxZ: 150,
        },
        approximateSizeMeters: 1200,
        boundingRadiusMeters: 0,
      }),
    ],
  ]);

  const selected = selector.selectVisibleNodes(createCamera(), hierarchy);

  assert.deepEqual(
    selected.map((entry) => entry.node.key),
    ['0-0-0-0'],
  );
});

test('NodeSelector returns an empty selection for an empty hierarchy', () => {
  const selector = createSelector();

  assert.deepEqual(selector.selectVisibleNodes(createCamera(), new Map()), []);
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
  const cache = createNodePointCache(
    async (nodeKey) => {
      loadCount += 1;

      return {
        pointCount: 1,
        coordinates: new Float64Array([-123, 44, nodeKey.length]),
      };
    },
    { maxEntries: 2 },
  );
  const manager = new StreamingManager(
    hierarchy,
    {
      maxNodes: 8,
      maxDepth: 4,
      refineDistanceMultiplier: 6,
      maxRenderDistanceMeters: 12000,
    },
    cache,
  );

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

test('StreamingManager.clear resets selection state and cache', async () => {
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
  ]);
  const cache = createNodePointCache(
    async () => ({
      pointCount: 1,
      coordinates: new Float64Array([-123, 44, 1]),
    }),
    { maxEntries: 2 },
  );
  const manager = new StreamingManager(
    hierarchy,
    {
      maxNodes: 8,
      maxDepth: 4,
      refineDistanceMultiplier: 6,
      maxRenderDistanceMeters: 12000,
    },
    cache,
  );

  await manager.update(createCamera());
  assert.equal(cache.getSize(), 1);

  manager.clear();

  assert.equal(cache.getSize(), 0);
  const nextUpdate = await manager.update(createCamera());
  assert.deepEqual(nextUpdate.removedNodeKeys, []);
  assert.deepEqual(nextUpdate.selectedNodeKeys, ['0-0-0-0']);
});

test('StreamingManager returns an empty update when no hierarchy nodes exist', async () => {
  const cache = createNodePointCache(
    async () => ({
      pointCount: 1,
      coordinates: new Float64Array([-123, 44, 1]),
    }),
    { maxEntries: 1 },
  );
  const manager = new StreamingManager(
    new Map(),
    {
      maxNodes: 8,
      maxDepth: 4,
      refineDistanceMultiplier: 6,
      maxRenderDistanceMeters: 12000,
    },
    cache,
  );

  const update = await manager.update(createCamera());

  assert.deepEqual(update.selectedNodeKeys, []);
  assert.deepEqual(update.removedNodeKeys, []);
  assert.equal(update.loadedNodePoints.size, 0);
});

test('StreamingManager propagates load failures and retries after cache eviction', async () => {
  let attempts = 0;
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
  ]);
  const cache = createNodePointCache(
    async () => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error('load failed');
      }

      return {
        pointCount: 1,
        coordinates: new Float64Array([-123, 44, 1]),
      };
    },
    { maxEntries: 1 },
  );
  const manager = new StreamingManager(
    hierarchy,
    {
      maxNodes: 8,
      maxDepth: 4,
      refineDistanceMultiplier: 6,
      maxRenderDistanceMeters: 12000,
    },
    cache,
  );

  await assert.rejects(() => manager.update(createCamera()), /load failed/);
  assert.equal(cache.getSize(), 0);

  const update = await manager.update(createCamera());

  assert.equal(attempts, 2);
  assert.deepEqual(update.selectedNodeKeys, ['0-0-0-0']);
  assert.equal(update.loadedNodePoints.size, 1);
});

test('StreamingManager ignores stale generation results after clear', async () => {
  let callCount = 0;
  const resolvers = [];
  const hierarchy = new Map([
    ['0-0-0-0', createWorkNode('0-0-0-0', 10, 0)],
  ]);
  const cache = createNodePointCache(
    () => new Promise((resolve) => {
      callCount += 1;
      resolvers.push(resolve);
    }),
    { maxEntries: 2 },
  );
  const manager = new StreamingManager(hierarchy, {
    maxNodes: 8,
    maxDepth: 4,
    refineDistanceMultiplier: 6,
    maxRenderDistanceMeters: 12000,
    maxPointsPerBatch: 10,
  }, cache);
  const progress = [];
  const firstUpdate = manager.update(createCamera(), (value) => progress.push(value));
  await Promise.resolve();
  manager.clear();
  const secondUpdate = manager.update(createCamera(), (value) => progress.push(value));
  await Promise.resolve();
  assert.equal(callCount, 2);

  resolvers[0]({ pointCount: 10, coordinates: new Float64Array(30) });
  await Promise.resolve();
  assert.equal(progress.filter((value) => value.loadedNodePoints.size > 0).length, 0);
  resolvers[1]({ pointCount: 10, coordinates: new Float64Array(30) });
  await Promise.all([firstUpdate, secondUpdate]);

  assert.equal(progress.filter((value) => value.loadedNodePoints.size > 0).length, 1);
});

test('extractHorizontalUnitScale ignores nested geographic angular units', () => {
  const wkt = `
    PROJCS["Test",
      GEOGCS["GCS",
        UNIT["Degree",0.0174532925199433]
      ],
      UNIT["US survey foot",0.3048006096012192]
    ]
  `;

  assert.equal(extractHorizontalUnitScale(wkt), 0.3048006096012192);
});
