import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { CopcCesiumLayer } from '../src/index.ts';
import { createCesiumStreamingView } from '../src/cesium/view/CesiumViewAdapter.ts';

function createEvent() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(listener) {
      listeners.add(listener);
    },
    removeEventListener(listener) {
      listeners.delete(listener);
    },
  };
}

function createFakeViewer() {
  const moveEnd = createEvent();
  const changed = createEvent();
  const removedCollections = [];
  const addedCollections = [];

  return {
    moveEnd,
    changed,
    removedCollections,
    addedCollections,
    destroyed: false,
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
    camera: {
      percentageChanged: 0,
      positionWC: Cesium.Cartesian3.fromDegrees(-122.5, 44.5, 1500),
      moveEnd,
      changed,
      flyTo(options) {
        this.positionWC = options.destination;
      },
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

function createBackend({ onFields } = {}) {
  const node = {
    key: '0-0-0-0',
    level: 0,
    x: 0,
    y: 0,
    z: 0,
    pointCount: 2,
    pointDataOffset: 100,
    pointDataLength: 20,
  };
  let openCount = 0;
  let destroyCount = 0;

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
        return {
          source,
          getMetadata() {
            return {
              pointCount: 2,
              bounds: {
                minX: -123,
                minY: 44,
                minZ: 10,
                maxX: -122,
                maxY: 45,
                maxZ: 20,
              },
              cube: {
                minX: -123,
                minY: 44,
                minZ: 10,
                maxX: -122,
                maxY: 45,
                maxZ: 20,
              },
            };
          },
          getRootHierarchyPage() {
            return { key: node.key, pageOffset: 0, pageLength: 10 };
          },
          async loadHierarchyPage() {
            return { nodes: [node], pages: [] };
          },
          async loadPointDataView(_node, fields) {
            onFields?.([...fields]);
            return {
              pointCount: node.pointCount,
              availableFields: fields,
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
    decoder: {
      async decode() {
        return {
          pointCount: 2,
          coordinates: new Float64Array([
            -122.6, 44.4, 12,
            -122.4, 44.6, 18,
          ]),
          attributes: {
            red: new Uint16Array([255, 128]),
            green: new Uint16Array([0, 128]),
            blue: new Uint16Array([0, 255]),
          },
        };
      },
    },
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('timed out waiting for Cesium adapter update');
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('CopcCesiumLayer delegates source and streaming work to the shared core', async () => {
  const requestedFields = [];
  const source = createBackend({ onFields: (fields) => requestedFields.push(fields) });
  const layer = new CopcCesiumLayer({
    url: 'memory://adapter.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
    colorMode: 'rgb',
  });
  const viewer = createFakeViewer();

  await layer.load();
  assert.equal(source.openCount, 1);
  assert.equal(layer.getSnapshot().lifecycle, 'ready');
  assert.deepEqual(layer.getHierarchyDiagnostics(), {
    pageRequests: 1,
    pageCacheHits: 0,
    hierarchyBytesFetched: 10,
    loadedPageCount: 1,
    loadedEntryCount: 1,
  });

  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

  assert.deepEqual(requestedFields, [['position', 'rgb']]);
  assert.deepEqual(layer.getSnapshot().selectedNodeKeys, ['0-0-0-0']);
  assert.deepEqual(layer.getSnapshot().renderedNodeKeys, ['0-0-0-0']);
  assert.equal(layer.getSnapshot().streamingUpdateCount, 1);

  layer.destroy();
  assert.equal(source.destroyCount, 1);
  assert.equal(viewer.destroyed, false);
});

test('Cesium attachment listeners are stable and detach preserves loaded data', async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://lifecycle.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
  });
  const firstViewer = createFakeViewer();
  const secondViewer = createFakeViewer();

  await layer.load();
  layer.attachTo(firstViewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  layer.attachTo(firstViewer);
  assert.equal(firstViewer.moveEnd.listeners.size, 1);
  assert.equal(firstViewer.changed.listeners.size, 1);

  layer.detachFrom();
  assert.equal(firstViewer.moveEnd.listeners.size, 0);
  assert.equal(firstViewer.changed.listeners.size, 0);
  assert.equal(layer.getSnapshot().attached, false);
  assert.equal(layer.getMetadata().pointCount, 2);
  assert.equal(layer.getPointCacheDiagnostics().cachedNodeCount, 1);
  assert.equal(layer.getSnapshot().renderedPointCount, 0);

  layer.attachTo(firstViewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  layer.attachTo(secondViewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  assert.equal(firstViewer.moveEnd.listeners.size, 0);
  assert.equal(secondViewer.moveEnd.listeners.size, 1);

  await layer.reload();
  assert.equal(source.openCount, 2);
  assert.equal(layer.getSnapshot().attached, true);
  assert.equal(secondViewer.destroyed, false);
  layer.destroy();
  assert.equal(secondViewer.destroyed, false);
});

test('detaching while loading preserves the loading lifecycle', async () => {
  const opening = createDeferred();
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://loading.copc.laz',
    backend: {
      open() {
        return opening.promise;
      },
    },
  });
  const viewer = createFakeViewer();
  const loadPromise = layer.load();

  layer.attachTo(viewer);
  assert.equal(layer.getSnapshot().lifecycle, 'loading');
  layer.detachFrom();
  assert.equal(layer.getSnapshot().lifecycle, 'loading');

  opening.resolve(await source.backend.open('memory://loading.copc.laz'));
  await loadPromise;

  assert.equal(layer.getSnapshot().lifecycle, 'ready');
  assert.equal(layer.getSnapshot().attached, false);
  layer.destroy();
});

test('a failed first render rolls back the shared core and keeps the viewer usable', async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://render-failure.copc.laz',
    backend: source.backend,
    decoder: {
      async decode() {
        throw new Error('point decode failed');
      },
    },
  });
  const viewer = createFakeViewer();
  layer.attachTo(viewer);

  await assert.rejects(() => layer.load(), /point decode failed/);
  assert.equal(layer.getSnapshot().lifecycle, 'mounted');
  assert.equal(layer.getMetadata(), undefined);
  assert.deepEqual(layer.getSnapshot().renderedNodeKeys, []);
  assert.deepEqual(layer.getSnapshot().selectedNodeKeys, []);
  assert.equal(viewer.destroyed, false);
  layer.destroy();
});

test('detach invalidates an in-flight core update before stale points reach Cesium', async () => {
  let resolveDecode;
  let decodeStarted;
  const decodeReady = new Promise((resolve) => {
    decodeStarted = resolve;
  });
  const source = createBackend();
  source.decoder = {
    async decode() {
      decodeStarted();
      return new Promise((resolve) => {
        resolveDecode = resolve;
      });
    },
  };
  const layer = new CopcCesiumLayer({
    url: 'memory://stale.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await decodeReady;
  layer.detachFrom();
  resolveDecode({
    pointCount: 2,
    coordinates: new Float64Array([
      -122.6, 44.4, 12,
      -122.4, 44.6, 18,
    ]),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(layer.getSnapshot().attached, false);
  assert.equal(layer.getSnapshot().renderedPointCount, 0);
  assert.equal(viewer.addedCollections.length, 0);
  layer.destroy();
});

test('Cesium view adapter produces a plain perspective view for oblique cameras', () => {
  const viewer = createFakeViewer();
  viewer.scene.drawingBufferHeight = 900;
  viewer.scene.canvas = { clientHeight: 900, height: 900 };
  viewer.camera.frustum = {
    fov: Math.PI / 3,
    aspectRatio: 16 / 9,
    near: 1,
    far: 6000,
  };
  viewer.camera.directionWC = new Cesium.Cartesian3(0, 1, 0);
  viewer.camera.upWC = new Cesium.Cartesian3(0, 0, 1);
  viewer.camera.rightWC = new Cesium.Cartesian3(1, 0, 0);

  const view = createCesiumStreamingView(viewer);

  assert.equal(view.viewFrustum.coordinateSystem, 'wgs84-ecef-meters');
  assert.equal(view.viewFrustum.viewportHeightPixels, 900);
  assert.equal(view.viewFrustum.farMeters, 6000);
  assert.deepEqual(view.viewFrustum.direction, { x: 0, y: 1, z: 0 });
});

test('Cesium picks resolve through the shared live node and point cache', async () => {
  const picked = [];
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://picking.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
    colorMode: 'rgb',
    onPointPicked: (point) => picked.push(point),
  });
  const viewer = createFakeViewer();
  const nodeKey = '0-0-0-0';

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

  // Private members are used here only to drive the adapter-side Cesium pick
  // event without constructing a browser DOM or a real WebGL scene.
  const controller = layer.controller;
  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 1, ownerId: controller.pickOwnerId },
  });
  controller.handlePick(viewer, new Cesium.Cartesian2(10, 10));

  assert.equal(layer.getSelectedPoint().nodeKey, nodeKey);
  assert.equal(layer.getSelectedPoint().pointIndex, 1);
  assert.deepEqual(layer.getSelectedPoint().rgb, { red: 128, green: 128, blue: 255 });

  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 1, ownerId: 'copc-layer-foreign' },
  });
  controller.handlePick(viewer, new Cesium.Cartesian2(10, 10));
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(picked.at(-1), undefined);

  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 0, ownerId: controller.pickOwnerId },
  });
  controller.handlePick(viewer, new Cesium.Cartesian2(10, 10));
  controller.core.streamingState.cache.delete(nodeKey);
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(picked.at(-1), undefined);

  layer.destroy();
});

test('selection is cleared across unload, reload, and removed transition coverage', async () => {
  const picked = [];
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://selection-lifecycle.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
    onPointPicked: (point) => picked.push(point),
  });
  const viewer = createFakeViewer();
  const nodeKey = '0-0-0-0';

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  const controller = layer.controller;

  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 0, ownerId: controller.pickOwnerId },
  });
  controller.handlePick(viewer, new Cesium.Cartesian2(10, 10));
  assert.ok(layer.getSelectedPoint());

  layer.unload();
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(layer.getSnapshot().selectedNodeKeys.length, 0);
  assert.equal(layer.getSnapshot().renderedPointCount, 0);

  await layer.reload();
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  controller.handlePick(viewer, new Cesium.Cartesian2(10, 10));
  assert.ok(layer.getSelectedPoint());

  const childPoints = {
    pointCount: 1,
    coordinates: new Float64Array([-122.4, 44.6, 18]),
  };
  controller.applyStreamingProgress(viewer, {
    selectedNodeKeys: ['1-child'],
    removedNodeKeys: [nodeKey],
    loadedNodePoints: new Map([['1-child', childPoints]]),
    completedBatchPointCount: 1,
    replacementGroups: [{
      kind: 'refinement',
      oldNodeKeys: [nodeKey],
      newNodeKeys: ['1-child'],
    }],
    generation: 1,
  }, 1);

  assert.deepEqual(layer.getSnapshot().renderedNodeKeys, ['1-child']);
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(picked.at(-1), undefined);

  // Keep the fixture explicit: old coverage is gone and cannot be picked
  // again even if a stale scene object is presented to the adapter.
  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 0, ownerId: controller.pickOwnerId },
  });
  controller.handlePick(viewer, new Cesium.Cartesian2(10, 10));
  assert.equal(layer.getSelectedPoint(), undefined);

  layer.destroy();
});

test('public snapshot composes core and renderer state without old-layer values', async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://snapshot.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

  const ready = layer.getSnapshot();
  assert.equal(ready.streamingUpdateCount, 1);
  assert.equal(ready.performance.activeRenderedPointCount, ready.renderedPointCount);
  assert.equal(ready.performance.selectedNodeCount, 1);
  assert.equal(ready.pointCache.cachedNodeCount, 1);

  layer.unload();
  const unloaded = layer.getSnapshot();
  assert.equal(unloaded.streamingUpdateCount, 0);
  assert.deepEqual(unloaded.selectedNodeKeys, []);
  assert.deepEqual(unloaded.renderedNodeKeys, []);
  assert.equal(unloaded.renderedPointCount, 0);
  assert.equal(unloaded.performance.activeRenderedPointCount, 0);
  assert.equal(unloaded.performance.selectedNodeCount, 0);
  assert.equal(unloaded.performance.rendererPreparationDurationMs, 0);
  assert.equal(unloaded.pointCache.cachedNodeCount, 0);

  layer.destroy();
});
