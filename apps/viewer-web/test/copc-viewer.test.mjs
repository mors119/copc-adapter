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
