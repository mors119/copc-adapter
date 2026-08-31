import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CopcStreamingController,
} from '../src/viewer/streaming/CopcStreamingController.ts';
import {
  createPerspectiveViewFrustum,
  geographicToEcef,
} from '../src/viewer/streaming/view.ts';

const ROOT_KEY = '0-0-0-0';
const CHILD_KEY = '1-0-0-0';

function createMetadata() {
  return {
    pointCount: 2,
    bounds: {
      minX: 10,
      minY: 20,
      minZ: 100,
      maxX: 10.01,
      maxY: 20.01,
      maxZ: 200,
    },
    cube: {
      minX: 10,
      minY: 20,
      minZ: 100,
      maxX: 10.01,
      maxY: 20.01,
      maxZ: 200,
    },
    spacing: 10,
  };
}

function createNode(key, level, pointCount, children = []) {
  return {
    key,
    level,
    x: 0,
    y: 0,
    z: 0,
    pointCount,
    pointDataOffset: level * 100,
    pointDataLength: 20,
    children,
    childrenComplete: true,
  };
}

function createSourceFactory({ onOpen, paged = false } = {}) {
  let openCount = 0;
  let destroyCount = 0;
  let performanceObserver;
  const root = createNode(ROOT_KEY, 0, 1, [CHILD_KEY]);
  const child = createNode(CHILD_KEY, 1, 1);

  return {
    get openCount() {
      return openCount;
    },
    get destroyCount() {
      return destroyCount;
    },
    backend: {
      async open(source) {
        openCount += 1;
        onOpen?.(source);
        return {
          source,
          getMetadata: createMetadata,
          getRootHierarchyPage() {
            return { key: ROOT_KEY, pageOffset: 0, pageLength: 10 };
          },
          setPerformanceObserver(observer) {
            performanceObserver = observer;
          },
          async loadHierarchyPage(page) {
            performanceObserver?.({
              stage: 'rangeFetch',
              durationMs: 7,
              bytes: page.pageLength,
            });
            if (paged && page.key === ROOT_KEY) {
              return {
                nodes: [root],
                pages: [{ key: CHILD_KEY, pageOffset: 10, pageLength: 10 }],
              };
            }
            if (!paged) {
              return { nodes: [root, child], pages: [] };
            }
            return { nodes: [child], pages: [] };
          },
          async loadPointDataView() {
            return {
              pointCount: 1,
              availableFields: new Set(['position']),
              getter() {
                return () => 0;
              },
            };
          },
          destroy() {
            destroyCount += 1;
          },
        };
      },
    },
  };
}

function createView(overrides = {}) {
  return {
    longitude: 10.005,
    latitude: 20.005,
    height: 150,
    viewDistanceMeters: 6000,
    ...overrides,
  };
}

function createPointBuffer(height = 150) {
  return {
    pointCount: 1,
    coordinates: new Float64Array([10.005, 20.005, height]),
  };
}

function createController(backend, options = {}) {
  return new CopcStreamingController({
    url: 'memory://deterministic.copc.laz',
    backend,
    decoder: {
      async decode() {
        return createPointBuffer();
      },
    },
    streaming: {
      maxNodes: 8,
      maxDepth: 0,
      maxRenderDistanceMeters: 12000,
      maxScreenSpaceError: 8,
      maxPointsPerBatch: 1,
    },
    ...options,
  });
}

test('renderer-neutral core loads metadata and hierarchy without Cesium', async () => {
  const source = createSourceFactory();
  const controller = createController(source.backend);

  await controller.load();

  assert.equal(controller.getMetadata().pointCount, 2);
  assert.equal(controller.getSnapshot().lifecycle, 'ready');
  assert.deepEqual(controller.getHierarchyDiagnostics(), {
    pageRequests: 1,
    pageCacheHits: 0,
    hierarchyBytesFetched: 10,
    loadedPageCount: 1,
    loadedEntryCount: 2,
  });

  controller.destroy();
  assert.equal(source.destroyCount, 1);
});

test('a plain project-owned view drives hierarchy query and deterministic selection', async () => {
  const source = createSourceFactory();
  const controller = createController(source.backend);
  const progress = [];

  await controller.load();
  const result = await controller.updateView(createView(), (entry) => progress.push(entry));

  assert.deepEqual(result.selectedNodeKeys, [ROOT_KEY]);
  assert.deepEqual(controller.getCurrentSelection(), [ROOT_KEY]);
  assert.equal(progress.length, 2);
  assert.deepEqual(progress[0].selectedNodeKeys, [ROOT_KEY]);
  assert.deepEqual(progress[1].loadedNodePoints.get(ROOT_KEY).coordinates, new Float64Array([
    10.005,
    20.005,
    150,
  ]));
  assert.equal(controller.getPointCacheDiagnostics().cachedNodeCount, 1);
});

test('view updates refresh the core hierarchy used by point loading', async () => {
  const source = createSourceFactory({ paged: true });
  const controller = createController(source.backend, {
    streaming: {
      maxDepth: 1,
    },
  });

  await controller.load();
  assert.equal(controller.getHierarchyDiagnostics().loadedEntryCount, 2);

  await controller.updateView(createView());

  assert.equal(controller.getHierarchyDiagnostics().loadedEntryCount, 3);
  assert.equal(controller.getSnapshot().performance.rangeFetchDurationMs, 7);
  assert.equal(controller.getSnapshot().performance.rangeFetchBytes, 10);
  for (const nodeKey of controller.getCurrentSelection()) {
    assert.ok(controller.getCachedPointBuffer(nodeKey));
  }
});

test('the same view produces the same frontier and increments updates once per generation', async () => {
  const source = createSourceFactory();
  const controller = createController(source.backend);
  const view = createView();

  await controller.load();
  const first = await controller.updateView(view);
  const second = await controller.updateView(view);

  assert.deepEqual(first.selectedNodeKeys, [ROOT_KEY]);
  assert.deepEqual(second.selectedNodeKeys, [ROOT_KEY]);
  assert.deepEqual(controller.getCurrentSelection(), [ROOT_KEY]);
  assert.equal(controller.getSnapshot().streamingUpdateCount, 2);
  assert.ok(controller.getPointCacheDiagnostics().hits >= 1);
});

test('a changed view invalidates stale streaming generations', async () => {
  let resolvePoints;
  let resolveDecodeStarted;
  const decodeStarted = new Promise((resolve) => {
    resolveDecodeStarted = resolve;
  });
  const source = createSourceFactory();
  const controller = createController(source.backend, {
    decoder: {
      async decode() {
        resolveDecodeStarted();
        return new Promise((resolve) => {
          resolvePoints = resolve;
        });
      },
    },
  });

  await controller.load();
  const firstUpdate = controller.updateView(createView({ height: 150 }));
  await decodeStarted;
  const secondUpdate = controller.updateView(createView({ height: 250 }));
  resolvePoints(createPointBuffer(250));

  const [stale, current] = await Promise.all([firstUpdate, secondUpdate]);
  assert.equal(stale, undefined);
  assert.deepEqual(current.selectedNodeKeys, [ROOT_KEY]);
  assert.equal(controller.getSnapshot().streamingUpdateCount, 1);
  assert.deepEqual(controller.getCurrentView(), createView({ height: 250 }));
});

test('same-position views with different directions produce different hierarchy queries', async () => {
  const source = createSourceFactory();
  const controller = createController(source.backend);
  await controller.load();

  const position = geographicToEcef({ longitude: 10.005, latitude: 20.005, height: 5000 });
  const makeFrustum = (direction) => createPerspectiveViewFrustum({
    position,
    direction,
    up: { x: 0, y: 0, z: 1 },
    right: { x: 1, y: 0, z: 0 },
    verticalFovRadians: Math.PI / 3,
    aspectRatio: 1,
    nearMeters: 1,
    farMeters: 6000,
  });
  const firstView = createView({ viewFrustum: makeFrustum({ x: 0, y: 1, z: 0 }) });
  const secondView = createView({ viewFrustum: makeFrustum({ x: 0, y: -1, z: 0 }) });

  const firstQuery = controller.getHierarchyQuery(firstView);
  const secondQuery = controller.getHierarchyQuery(secondView);

  assert.notDeepEqual(firstQuery.bounds, secondQuery.bounds);
});

test('unload, reload, and destroy clean up source and cache state', async () => {
  const source = createSourceFactory();
  const controller = createController(source.backend);

  await controller.load();
  await controller.updateView(createView());
  assert.equal(controller.getPointCacheDiagnostics().cachedNodeCount, 1);

  controller.unload();
  assert.equal(source.destroyCount, 1);
  assert.equal(controller.getSnapshot().lifecycle, 'idle');
  assert.equal(controller.getPointCacheDiagnostics().cachedNodeCount, 0);

  await controller.reload();
  assert.equal(source.openCount, 2);
  assert.equal(controller.getSnapshot().lifecycle, 'ready');

  controller.destroy();
  controller.destroy();
  assert.equal(source.destroyCount, 2);
  assert.equal(controller.getSnapshot().lifecycle, 'destroyed');
});
