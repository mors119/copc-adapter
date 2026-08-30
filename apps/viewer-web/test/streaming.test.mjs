import test from 'node:test';
import assert from 'node:assert/strict';

import { extractHorizontalUnitScale } from '../src/coordinates/crs/parseCopcWkt.ts';
import { createNodePointCache } from '../src/viewer/streaming/createNodePointCache.ts';
import {
  calculateBoundsDistanceMeters,
  calculateDistanceMeters,
  calculateGazeCenterWeight,
  compareNodePriority,
  calculateScreenSpaceErrorPixels,
  DEFAULT_CENTER_PRIORITY_BOOST,
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
  childrenComplete = true,
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
    childrenComplete,
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

function createRefinementHierarchy(
  parentPointCount = 10,
  childPointCounts = [3, 3, 3],
  parentKey = '0-root',
) {
  const parent = createWorkNode(parentKey, parentPointCount, 0);
  const children = childPointCounts.map((pointCount, index) => {
    const key = `1-${parentKey}-${index}`;
    return createWorkNode(key, pointCount, 1);
  });
  parent.children = children.map((child) => child.node.key);
  parent.node.children = parent.children;

  return new Map([
    [parent.node.key, parent],
    ...children.map((child) => [child.node.key, child]),
  ]);
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

test('NodeSelector keeps the parent when refinement cannot fit maxNodes', () => {
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

  assert.deepEqual(selected.map((entry) => entry.node.key), ['0-0-0-0']);
});

test('NodeSelector accepts all candidates under the rendered-point budget', () => {
  const selector = createSelector({ maxRenderedPoints: 100 });
  const nodes = new Map([
    ['0-a', createWorkNode('0-a', 30, 0)],
    ['0-b', createWorkNode('0-b', 40, 0)],
  ]);

  const selected = selector.selectVisibleNodes(createCamera(), nodes);

  assert.deepEqual(selected.map((node) => node.node.key), ['0-a', '0-b']);
  assert.equal(selector.getSelectionMetrics().candidateSelectedPointCount, 70);
  assert.equal(selector.getSelectionMetrics().budgetedPointCount, 70);
  assert.equal(selector.getSelectionMetrics().deferredNodeCount, 0);
});

test('NodeSelector deterministically bounds an impossible minimum frontier by point cost', () => {
  const selector = createSelector({ maxRenderedPoints: 100 });
  const nodes = new Map([
    ['0-a', createWorkNode('0-a', 70, 0)],
    ['0-b', createWorkNode('0-b', 30, 0)],
    ['0-c', createWorkNode('0-c', 40, 0)],
  ]);

  const selected = selector.selectVisibleNodes(createCamera(), nodes);

  assert.deepEqual(selected.map((node) => node.node.key), ['0-b', '0-c']);
  assert.equal(selector.getSelectionMetrics().candidateSelectedPointCount, 140);
  assert.equal(selector.getSelectionMetrics().budgetedPointCount, 70);
  assert.equal(selector.getSelectionMetrics().deferredNodeCount, 1);
  assert.equal(selector.getSelectionMetrics().deferredPointCount, 70);
});

test('point-budget refinement rejection preserves the parent', () => {
  const selector = createSelector({ maxRenderedPoints: 50 });
  const hierarchy = createRefinementHierarchy(10, [30, 30, 30]);

  assert.deepEqual(
    selector.selectVisibleNodes(createCamera(), hierarchy).map((node) => node.node.key),
    ['0-root'],
  );
  assert.equal(selector.getSelectionMetrics().refinementRejectedByPointBudgetCount, 1);
  assert.equal(selector.getSelectionMetrics().frontierPointCount, 10);
});

test('budget-reducing refinement rescues an oversized coarse frontier', () => {
  const selector = createSelector({ maxRenderedPoints: 50 });
  const hierarchy = createRefinementHierarchy(100, [20, 20]);

  assert.deepEqual(
    selector.selectVisibleNodes(createCamera(), hierarchy).map((node) => node.node.key),
    ['1-0-root-0', '1-0-root-1'],
  );
  assert.equal(selector.getSelectionMetrics().acceptedRefinementCount, 1);
  assert.equal(selector.getSelectionMetrics().frontierPointCount, 40);
});

test('multi-step budget-reducing refinement reaches an affordable frontier', () => {
  const selector = createSelector({ maxRenderedPoints: 50 });
  const root = createWorkNode('0-root', 100, 0);
  const child = createWorkNode('1-child', 80, 1);
  const grandchildren = [20, 20].map((pointCount, index) =>
    createWorkNode(`2-grandchild-${index}`, pointCount, 2));
  root.children = [child.node.key];
  root.node.children = root.children;
  child.children = grandchildren.map((node) => node.node.key);
  child.node.children = child.children;
  const hierarchy = new Map([
    [root.node.key, root],
    [child.node.key, child],
    ...grandchildren.map((node) => [node.node.key, node]),
  ]);

  assert.deepEqual(
    selector.selectVisibleNodes(createCamera(), hierarchy).map((node) => node.node.key),
    ['2-grandchild-0', '2-grandchild-1'],
  );
  assert.equal(selector.getSelectionMetrics().acceptedRefinementCount, 2);
  assert.equal(selector.getSelectionMetrics().frontierPointCount, 40);
});

test('node-budget refinement rejection preserves the parent', () => {
  const selector = createSelector({ maxNodes: 2, maxRenderedPoints: 100 });
  const hierarchy = createRefinementHierarchy(10, [3, 3, 3]);

  assert.deepEqual(
    selector.selectVisibleNodes(createCamera(), hierarchy).map((node) => node.node.key),
    ['0-root'],
  );
  assert.equal(selector.getSelectionMetrics().refinementRejectedByNodeBudgetCount, 1);
});

test('affordable refinement replaces the parent atomically', () => {
  const selector = createSelector({ maxNodes: 8, maxRenderedPoints: 100 });
  const hierarchy = createRefinementHierarchy(10, [3, 3, 3]);

  assert.deepEqual(
    selector.selectVisibleNodes(createCamera(), hierarchy).map((node) => node.node.key),
    ['1-0-root-0', '1-0-root-1', '1-0-root-2'],
  );
  assert.equal(selector.getSelectionMetrics().acceptedRefinementCount, 1);
});

test('incomplete replacement hierarchy keeps the parent', () => {
  const selector = createSelector({ maxRenderedPoints: 100 });
  const hierarchy = createRefinementHierarchy(10, [3, 3, 3]);
  hierarchy.get('0-root').childrenComplete = false;

  assert.deepEqual(
    selector.selectVisibleNodes(createCamera(), hierarchy).map((node) => node.node.key),
    ['0-root'],
  );
  assert.equal(selector.getSelectionMetrics().refinementDeferredByIncompleteHierarchyCount, 1);
});

test('a sparse but complete child set can refine', () => {
  const selector = createSelector({ maxRenderedPoints: 100 });
  const hierarchy = createRefinementHierarchy(10, [3]);

  assert.deepEqual(
    selector.selectVisibleNodes(createCamera(), hierarchy).map((node) => node.node.key),
    ['1-0-root-0'],
  );
});

test('mixed-LoD refinement preserves coarse sibling coverage', () => {
  const selector = createSelector({ maxNodes: 3, maxRenderedPoints: 120 });
  const first = createRefinementHierarchy(20, [40, 40], '0-a');
  const second = createRefinementHierarchy(20, [40, 40], '0-b');
  const hierarchy = new Map([...first, ...second]);

  const selected = selector.selectVisibleNodes(createCamera(), hierarchy);

  assert.deepEqual(
    selected.map((node) => node.node.key),
    ['1-0-a-0', '1-0-a-1', '0-b'],
  );
  assert.equal(selector.getSelectionMetrics().acceptedRefinementCount, 1);
  assert.equal(selector.getSelectionMetrics().refinementRejectedByNodeBudgetCount, 1);
});

test('far to near refines branches without dropping unrefined coverage', () => {
  const selector = createSelector({
    maxNodes: 3,
    maxRenderedPoints: 120,
    maxRenderDistanceMeters: 100000,
  });
  const first = createRefinementHierarchy(20, [40, 40], '0-a');
  const second = createRefinementHierarchy(20, [40, 40], '0-b');
  const hierarchy = new Map([...first, ...second]);

  const far = selector.selectVisibleNodes(
    createCamera({ height: 40000, viewDistanceMeters: 100000 }),
    hierarchy,
  );
  const near = selector.selectVisibleNodes(createCamera(), hierarchy);

  assert.deepEqual(far.map((node) => node.node.key), ['0-a', '0-b']);
  assert.deepEqual(near.map((node) => node.node.key), ['1-0-a-0', '1-0-a-1', '0-b']);
});

test('near to far collapses the frontier to coarse roots', () => {
  const selector = createSelector({ maxNodes: 8, maxRenderedPoints: 100 });
  const hierarchy = createRefinementHierarchy(10, [3, 3, 3]);

  assert.equal(selector.selectVisibleNodes(createCamera(), hierarchy)[0].node.level, 1);
  assert.deepEqual(
    selector.selectVisibleNodes(createCamera({ height: 40000 }), hierarchy)
      .map((node) => node.node.key),
    ['0-root'],
  );
});

test('identical selection inputs produce identical ordering', () => {
  const selector = createSelector({ maxNodes: 3, maxRenderedPoints: 120 });
  const first = createRefinementHierarchy(20, [40, 40], '0-a');
  const second = createRefinementHierarchy(20, [40, 40], '0-b');
  const hierarchy = new Map([...first, ...second]);
  const camera = createCamera();

  const firstSelection = selector.selectVisibleNodes(camera, hierarchy).map((node) => node.node.key);
  const secondSelection = selector.selectVisibleNodes(camera, hierarchy).map((node) => node.node.key);

  assert.deepEqual(firstSelection, secondSelection);
});

test('impossible minimum frontier stays within hard budgets and is recorded', () => {
  const selector = createSelector({ maxNodes: 1, maxRenderedPoints: 100 });
  const hierarchy = new Map([
    ['0-a', createWorkNode('0-a', 60, 0)],
    ['0-b', createWorkNode('0-b', 60, 0)],
  ]);

  const selected = selector.selectVisibleNodes(createCamera(), hierarchy);

  assert.equal(selected.length, 1);
  assert.ok(selected[0].node.pointCount <= 100);
  assert.equal(selector.getSelectionMetrics().minimumFrontierExceedsNodeBudget, true);
  assert.equal(selector.getSelectionMetrics().minimumFrontierExceedsPointBudget, true);
});

test('NodeSelector rejects an individual node that exceeds the rendered-point budget', () => {
  const selector = createSelector({ maxRenderedPoints: 50 });
  const nodes = new Map([
    ['0-dense', createWorkNode('0-dense', 51, 0)],
  ]);

  assert.deepEqual(selector.selectVisibleNodes(createCamera(), nodes), []);
  assert.equal(selector.getSelectionMetrics().deferredPointCount, 51);
});

test('NodeSelector enforces the rendered-point budget for distance fallback', () => {
  const selector = createSelector({ maxRenderedPoints: 50 });
  const fallback = createWorkNode('0-fallback', 51, 0);
  const hierarchy = new Map([['0-fallback', fallback]]);

  assert.deepEqual(
    selector.selectVisibleNodes(
      createCamera({ longitude: -122, viewDistanceMeters: 1 }),
      hierarchy,
    ),
    [],
  );
  assert.equal(selector.getSelectionMetrics().deferredPointCount, 51);
  assert.equal(selector.getSelectionMetrics().budgetDeferDropCount, 1);
});

test('NodeSelector reprioritises the budget when the camera moves', () => {
  const selector = createSelector({ maxRenderedPoints: 40 });
  const makePositionedNode = (key, longitude) => createStreamingNode({
    key,
    level: 0,
    pointCount: 40,
    center: { longitude, latitude: 44, height: 100 },
    bounds: {
      minX: longitude - 0.001,
      minY: 43.999,
      minZ: 80,
      maxX: longitude + 0.001,
      maxY: 44.001,
      maxZ: 120,
    },
    approximateSizeMeters: 100,
    boundingRadiusMeters: 20,
  });
  const hierarchy = new Map([
    ['0-near', makePositionedNode('0-near', -123)],
    ['0-far', makePositionedNode('0-far', -122.98)],
  ]);

  assert.deepEqual(
    selector.selectVisibleNodes(createCamera({ longitude: -123 }), hierarchy)
      .map((node) => node.node.key),
    ['0-near'],
  );
  assert.deepEqual(
    selector.selectVisibleNodes(createCamera({ longitude: -122.98 }), hierarchy)
      .map((node) => node.node.key),
    ['0-far'],
  );
});

test('NodeSelector validates the rendered-point budget', () => {
  assert.throws(
    () => createSelector({ maxRenderedPoints: 0 }),
    /maxRenderedPoints must be a positive safe integer/,
  );
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

function createGazeRefinementHierarchy() {
  const peripheral = createFrustumNode('0-peripheral', {
    center: { x: 2.5, y: 0, z: 5 },
    radiusMeters: 0.1,
  });
  const peripheralChildren = [0, 1].map((index) => {
    const child = createFrustumNode(`1-peripheral-${index}`, {
      center: { x: 2.5, y: 0, z: 5 },
      radiusMeters: 0.1,
    });
    child.node.level = 1;
    return child;
  });
  peripheral.children = peripheralChildren.map((child) => child.node.key);
  peripheral.geometricErrorMeters = 21;

  const centre = createFrustumNode('0-centre', {
    center: { x: 0, y: 0, z: 5 },
    radiusMeters: 0.1,
  });
  const centreChildren = [0, 1].map((index) => {
    const child = createFrustumNode(`1-centre-${index}`, {
      center: { x: 0, y: 0, z: 5 },
      radiusMeters: 0.1,
    });
    child.node.level = 1;
    return child;
  });
  centre.children = centreChildren.map((child) => child.node.key);
  centre.geometricErrorMeters = 20;

  return new Map([
    [peripheral.node.key, peripheral],
    ...peripheralChildren.map((child) => [child.node.key, child]),
    [centre.node.key, centre],
    ...centreChildren.map((child) => [child.node.key, child]),
  ]);
}

function createThresholdHierarchy(desiredSse, camera) {
  const root = createWorkNode('0-threshold-root', 100, 0);
  root.children = ['1-threshold-child'];
  const child = createWorkNode('1-threshold-child', 40, 1);
  const unitErrorNode = createWorkNode('0-unit-error', 1, 0);
  unitErrorNode.geometricErrorMeters = 1;
  const unitSse = calculateScreenSpaceErrorPixels(camera, unitErrorNode);
  root.geometricErrorMeters = desiredSse / unitSse;
  return new Map([
    [root.node.key, root],
    [child.node.key, child],
  ]);
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

test('gaze priority lets a centre candidate beat a modestly stronger peripheral candidate', () => {
  const selector = createSelector({
    maxNodes: 3,
    maxRenderedPoints: 10,
    maxRenderDistanceMeters: 100000,
  });
  const hierarchy = createGazeRefinementHierarchy();
  const selected = selector.selectVisibleNodes(
    createProjectionCamera({ height: 1000 }),
    hierarchy,
  );

  assert.deepEqual(
    selected.map((node) => node.node.key),
    ['1-centre-0', '1-centre-1', '0-peripheral'],
  );
  assert.equal(selector.getSelectionMetrics().acceptedRefinementCount, 1);
  assert.equal(selector.getSelectionMetrics().candidatesWithCenterBoostCount, 2);
  assert.equal(DEFAULT_CENTER_PRIORITY_BOOST, 0.25);
});

test('a very large peripheral SSE still beats a low-error centre candidate', () => {
  const selector = createSelector({
    maxNodes: 3,
    maxRenderedPoints: 10,
    maxRenderDistanceMeters: 100000,
    screenSpaceErrorHysteresis: 0,
  });
  const hierarchy = createGazeRefinementHierarchy();
  hierarchy.get('0-peripheral').geometricErrorMeters = 100;
  hierarchy.get('0-centre').geometricErrorMeters = 16;

  const selected = selector.selectVisibleNodes(
    createProjectionCamera({ height: 1000 }),
    hierarchy,
  );

  assert.deepEqual(
    selected.map((node) => node.node.key),
    ['1-peripheral-0', '1-peripheral-1', '0-centre'],
  );
});

test('equal gaze and visual scores use deterministic key tie-breakers', () => {
  const selector = createSelector({ maxNodes: 1 });
  const first = createFrustumNode('0-a', {
    center: { x: 0, y: 0, z: 5 },
    radiusMeters: 0.1,
  });
  const second = createFrustumNode('0-b', {
    center: { x: 0, y: 0, z: 5 },
    radiusMeters: 0.1,
  });

  assert.deepEqual(
    selector.selectVisibleNodes(
      createProjectionCamera({ height: 1000 }),
      new Map([[first.node.key, first], [second.node.key, second]]),
    ).map((node) => node.node.key),
    ['0-a'],
  );
});

test('a behind-camera sphere receives no centre bonus', () => {
  const node = createFrustumNode('behind', {
    center: { x: 0, y: 0, z: -5 },
    radiusMeters: 0.1,
  });

  assert.equal(
    calculateGazeCenterWeight(createProjectionCamera(), node),
    0,
  );
});

test('missing perspective data falls back to finite deterministic SSE priority', () => {
  const selector = createSelector({ maxRenderedPoints: 100 });
  const hierarchy = createRefinementHierarchy(10, [3, 3]);
  const selected = selector.selectVisibleNodes(createCamera(), hierarchy);
  const metrics = selector.getSelectionMetrics();

  assert.deepEqual(
    selected.map((node) => node.node.key),
    ['1-0-root-0', '1-0-root-1'],
  );
  assert.equal(metrics.centerWeightMin, 0);
  assert.equal(metrics.centerWeightMax, 0);
  assert.equal(metrics.candidatesWithCenterBoostCount, 0);
  assert.ok(Number.isFinite(metrics.frontierPointCount));
});

test('invalid perspective values fall back without producing NaN priority', () => {
  const selector = createSelector({ maxRenderedPoints: 100 });
  const hierarchy = createRefinementHierarchy(10, [3, 3]);
  const malformedFrustum = {
    ...createTestFrustum(),
    verticalFovRadians: Number.NaN,
  };

  assert.doesNotThrow(() => selector.selectVisibleNodes(
    createCamera({ viewFrustum: malformedFrustum }),
    hierarchy,
  ));
  const metrics = selector.getSelectionMetrics();
  assert.ok(Number.isFinite(metrics.screenSpaceErrorMin));
  assert.ok(Number.isFinite(metrics.screenSpaceErrorMax));
  assert.equal(metrics.centerWeightMin, 0);
  assert.equal(metrics.centerWeightMax, 0);
});

test('camera rotation moves refinement focus while retaining a valid frontier', () => {
  const selector = createSelector({
    maxNodes: 3,
    maxRenderedPoints: 10,
    maxRenderDistanceMeters: 100000,
  });
  const forward = createFrustumNode('0-forward', {
    center: { x: 0, y: 0, z: 5 },
    radiusMeters: 0.1,
  });
  const forwardChild = createFrustumNode('1-forward', {
    center: { x: 0, y: 0, z: 5 },
    radiusMeters: 0.1,
  });
  forwardChild.node.level = 1;
  forward.children = [forwardChild.node.key];
  forward.geometricErrorMeters = 20;
  const right = createFrustumNode('0-right', {
    center: { x: 5, y: 0, z: 0 },
    radiusMeters: 0.1,
  });
  const rightChild = createFrustumNode('1-right', {
    center: { x: 5, y: 0, z: 0 },
    radiusMeters: 0.1,
  });
  rightChild.node.level = 1;
  right.children = [rightChild.node.key];
  right.geometricErrorMeters = 20;
  const hierarchy = new Map([
    [forward.node.key, forward],
    [forwardChild.node.key, forwardChild],
    [right.node.key, right],
    [rightChild.node.key, rightChild],
  ]);
  const camera = createProjectionCamera({
    height: 1000,
    viewFrustum: createPerspectiveViewFrustum({
      position: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      up: { x: 0, y: 1, z: 0 },
      right: { x: 1, y: 0, z: 0 },
      verticalFovRadians: Math.PI / 2,
      viewportHeightPixels: 1000,
      aspectRatio: 1,
      nearMeters: 1,
      farMeters: 100,
    }),
  });
  const rotatedCamera = {
    ...camera,
    viewFrustum: createPerspectiveViewFrustum({
      position: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      right: { x: 0, y: 0, z: -1 },
      verticalFovRadians: Math.PI / 2,
      viewportHeightPixels: 1000,
      aspectRatio: 1,
      nearMeters: 1,
      farMeters: 100,
    }),
  };

  assert.deepEqual(
    selector.selectVisibleNodes(camera, hierarchy).map((node) => node.node.key),
    ['1-forward'],
  );
  assert.deepEqual(
    selector.selectVisibleNodes(rotatedCamera, hierarchy).map((node) => node.node.key),
    ['1-right'],
  );
  assert.equal(selector.getSelectionMetrics().frontierNodeCount, 1);
});

test('default hysteresis refines above 9px and keeps the coarse state below it', () => {
  const camera = createProjectionCamera({ height: 1000 });
  const selector = createSelector({ maxRenderedPoints: 200 });

  assert.deepEqual(
    selector.selectVisibleNodes(camera, createThresholdHierarchy(8.5, camera))
      .map((node) => node.node.key),
    ['0-threshold-root'],
  );
  assert.deepEqual(
    selector.selectVisibleNodes(camera, createThresholdHierarchy(9.1, camera))
      .map((node) => node.node.key),
    ['1-threshold-child'],
  );
});

test('coarse frontier holds inside the hysteresis band', () => {
  const camera = createProjectionCamera({ height: 1000 });
  const selector = createSelector({ maxRenderedPoints: 200 });
  const hierarchy = createThresholdHierarchy(8.5, camera);

  assert.deepEqual(selector.selectVisibleNodes(camera, hierarchy)
    .map((node) => node.node.key), ['0-threshold-root']);
  assert.deepEqual(selector.selectVisibleNodes(camera, hierarchy, {
    previousSelectedNodeKeys: new Set(['0-threshold-root']),
  }).map((node) => node.node.key), ['0-threshold-root']);
  assert.equal(selector.getSelectionMetrics().hysteresisHoldCount, 1);
});

test('fine frontier holds inside the hysteresis band and collapses below 7px', () => {
  const camera = createProjectionCamera({ height: 1000 });
  const selector = createSelector({ maxRenderedPoints: 200 });
  const fineHierarchy = createThresholdHierarchy(9.1, camera);

  assert.deepEqual(selector.selectVisibleNodes(camera, fineHierarchy)
    .map((node) => node.node.key), ['1-threshold-child']);
  assert.deepEqual(selector.selectVisibleNodes(
    camera,
    createThresholdHierarchy(8.5, camera),
    { previousSelectedNodeKeys: new Set(['1-threshold-child']) },
  ).map((node) => node.node.key), ['1-threshold-child']);
  assert.equal(selector.getSelectionMetrics().hysteresisHoldCount, 1);

  assert.deepEqual(selector.selectVisibleNodes(
    camera,
    createThresholdHierarchy(6.9, camera),
    { previousSelectedNodeKeys: new Set(['1-threshold-child']) },
  ).map((node) => node.node.key), ['0-threshold-root']);
  assert.equal(selector.getSelectionMetrics().collapseDecisionCount, 1);
});

test('repeated threshold noise does not flap a previously fine frontier', () => {
  const camera = createProjectionCamera({ height: 1000 });
  const selector = createSelector({ maxRenderedPoints: 200 });
  const fineHierarchy = createThresholdHierarchy(9.1, camera);
  assert.deepEqual(selector.selectVisibleNodes(camera, fineHierarchy)
    .map((node) => node.node.key), ['1-threshold-child']);

  for (const sse of [7.9, 8.1, 7.95, 8.05, 7.98, 8.02]) {
    assert.deepEqual(selector.selectVisibleNodes(
      camera,
      createThresholdHierarchy(sse, camera),
      { previousSelectedNodeKeys: new Set(['1-threshold-child']) },
    ).map((node) => node.node.key), ['1-threshold-child']);
  }
  assert.equal(selector.getSelectionMetrics().collapseDecisionCount, 0);
});

test('clear approach and retreat cross the hysteresis boundaries', () => {
  const camera = createProjectionCamera({ height: 1000 });
  const selector = createSelector({ maxRenderedPoints: 200 });

  assert.deepEqual(selector.selectVisibleNodes(
    camera,
    createThresholdHierarchy(9.5, camera),
  ).map((node) => node.node.key), ['1-threshold-child']);
  assert.deepEqual(selector.selectVisibleNodes(
    camera,
    createThresholdHierarchy(6.5, camera),
    { previousSelectedNodeKeys: new Set(['1-threshold-child']) },
  ).map((node) => node.node.key), ['0-threshold-root']);
  assert.deepEqual(selector.selectVisibleNodes(
    camera,
    createThresholdHierarchy(9.5, camera),
    { previousSelectedNodeKeys: new Set(['0-threshold-root']) },
  ).map((node) => node.node.key), ['1-threshold-child']);
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
  const fourthUpdate = await manager.update(
    createCamera({ height: 40000, viewDistanceMeters: 12000 }),
  );

  assert.deepEqual(firstUpdate.selectedNodeKeys, ['0-0-0-0']);
  assert.equal(firstUpdate.loadedNodePoints.size, 1);
  assert.deepEqual(secondUpdate.removedNodeKeys, []);
  assert.equal(loadCount, 2);
  assert.deepEqual(thirdUpdate.selectedNodeKeys, ['1-0-0-0']);
  assert.deepEqual(thirdUpdate.removedNodeKeys, ['0-0-0-0']);
  assert.deepEqual(fourthUpdate.selectedNodeKeys, ['0-0-0-0']);
  assert.equal(loadCount, 2);
});

test('StreamingManager applies backpressure before loading deferred nodes', async () => {
  const hierarchy = new Map([
    ['0-a', createWorkNode('0-a', 30, 0)],
    ['0-b', createWorkNode('0-b', 40, 0)],
    ['0-c', createWorkNode('0-c', 70, 0)],
  ]);
  const loadedKeys = [];
  const cache = createNodePointCache(
    async (nodeKey) => {
      loadedKeys.push(nodeKey);
      const pointCount = hierarchy.get(nodeKey).node.pointCount;
      return { pointCount, coordinates: new Float64Array(pointCount * 3) };
    },
    { maxEntries: 8 },
  );
  const manager = new StreamingManager(hierarchy, {
    maxNodes: 8,
    maxDepth: 4,
    maxRenderDistanceMeters: 12000,
    maxRenderedPoints: 100,
  }, cache);

  const update = await manager.update(createCamera());

  assert.deepEqual(update.selectedNodeKeys, ['0-a', '0-b']);
  assert.deepEqual(loadedKeys, ['0-a', '0-b']);
  assert.equal(update.loadedNodePoints.size, 2);
  assert.equal(
    [...update.loadedNodePoints.values()].reduce((sum, points) => sum + points.pointCount, 0),
    70,
  );
  assert.equal(manager.getPerformanceSnapshot().deferredNodeCount, 1);
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
