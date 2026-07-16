import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { CopcViewer, createCopcViewer } from '../src/viewer/CopcViewer.ts';

function createFakeViewer() {
  const removedCollections = [];
  const addedCollections = [];
  const moveEndListeners = new Set();

  return {
    removedCollections,
    addedCollections,
    moveEndListeners,
    destroyed: false,
    flyToCalls: [],
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
      positionWC: Cesium.Cartesian3.fromDegrees(-123, 44, 1500),
      moveEnd: {
        addEventListener(listener) {
          moveEndListeners.add(listener);
        },
        removeEventListener(listener) {
          moveEndListeners.delete(listener);
        },
      },
      flyTo(options) {
        this.positionWC = options.destination;
      },
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

function createStreamingState(update) {
  return {
    metadata: {
      pointCount: 1,
      bounds: {
        minX: -123.1,
        minY: 44,
        minZ: 0,
        maxX: -123,
        maxY: 44.1,
        maxZ: 100,
      },
      cube: {
        minX: -123.1,
        minY: 44,
        minZ: 0,
        maxX: -123,
        maxY: 44.1,
        maxZ: 100,
      },
      wkt: undefined,
    },
    nodes: new Map(),
    context: {},
    manager: { update },
  };
}

test('CopcViewer destroy releases resources and remains safe when called twice', () => {
  const originalWindow = globalThis.window;
  const fakeViewer = createFakeViewer();
  const viewer = new CopcViewer({
    container: 'cesium-container',
    url: '/samples/autzen.copc.laz',
  });
  const existingCollection = new Cesium.PointPrimitiveCollection();
  let cleared = 0;
  let removedListener;

  globalThis.window = {
    clearTimeout() {},
  };
  fakeViewer.camera.moveEnd.removeEventListener = (listener) => {
    removedListener = listener;
  };

  viewer.viewer = fakeViewer;
  viewer.updateTimer = 42;
  viewer.pointCollections.set('0-0-0-0', existingCollection);
  viewer.selectedNodeKeys.add('0-0-0-0');
  viewer.nodePointCache.clear = () => {
    cleared += 1;
  };

  viewer.destroy();
  viewer.destroy();

  assert.equal(fakeViewer.destroyed, true);
  assert.equal(removedListener, viewer.handleCameraMoveEnd);
  assert.equal(viewer.getRenderedNodeKeys().length, 0);
  assert.equal(viewer.getCurrentSelection().length, 0);
  assert.equal(viewer.getSnapshot().lifecycle, 'destroyed');
  assert.equal(cleared, 2);

  globalThis.window = originalWindow;
});

test('CopcViewer updateStreamingView removes stale nodes and renders newly loaded nodes', async () => {
  const fakeViewer = createFakeViewer();
  const viewer = new CopcViewer({
    container: 'cesium-container',
    url: '/samples/autzen.copc.laz',
  });
  const staleCollection = new Cesium.PointPrimitiveCollection();

  viewer.viewer = fakeViewer;
  viewer.pointCollections.set('0-0-0-0', staleCollection);
  viewer.streamingState = createStreamingState(async () => ({
    selectedNodeKeys: ['1-0-0-0'],
    removedNodeKeys: ['0-0-0-0'],
    loadedNodePoints: new Map([
      [
        '1-0-0-0',
        {
          pointCount: 2,
          coordinates: new Float64Array([
            -123.0, 44.0, 100.0,
            -123.1, 44.1, 200.0,
          ]),
        },
      ],
    ]),
  }));

  await viewer.updateStreamingView();

  assert.deepEqual(viewer.getCurrentSelection(), ['1-0-0-0']);
  assert.deepEqual(viewer.getRenderedNodeKeys(), ['1-0-0-0']);
  assert.equal(fakeViewer.removedCollections[0], staleCollection);
  assert.equal(viewer.getRenderedPointCount(), 2);
  assert.ok(viewer.getSelectionBoundingSphere());
});

test('CopcViewer ignores loaded nodes after destroy during an in-flight update', async () => {
  const fakeViewer = createFakeViewer();
  const viewer = new CopcViewer({
    container: 'cesium-container',
    url: '/samples/autzen.copc.laz',
  });
  let resolveUpdate;

  viewer.viewer = fakeViewer;
  viewer.streamingState = createStreamingState(
    () =>
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
  );

  const updatePromise = viewer.updateStreamingView();
  viewer.destroy();
  resolveUpdate({
    selectedNodeKeys: ['1-0-0-0'],
    removedNodeKeys: [],
    loadedNodePoints: new Map([
      [
        '1-0-0-0',
        {
          pointCount: 1,
          coordinates: new Float64Array([-123, 44, 100]),
        },
      ],
    ]),
  });
  await updatePromise;

  assert.deepEqual(viewer.getRenderedNodeKeys(), []);
  assert.equal(fakeViewer.addedCollections.length, 0);
});

test('CopcViewer loadRenderableNodePoints rejects missing streaming state and unknown nodes', async () => {
  const viewer = new CopcViewer({
    container: 'cesium-container',
    url: '/samples/autzen.copc.laz',
  });

  await assert.rejects(
    () => viewer.loadRenderableNodePoints('0-0-0-0'),
    /Streaming state is not initialized/,
  );

  viewer.streamingState = createStreamingState(async () => ({
    selectedNodeKeys: [],
    removedNodeKeys: [],
    loadedNodePoints: new Map(),
  }));

  await assert.rejects(
    () => viewer.loadRenderableNodePoints('0-0-0-0'),
    /Unknown COPC hierarchy node/,
  );
});

test('CopcViewer load rejects invalid dataset paths after initialization', async () => {
  const viewer = new CopcViewer({
    container: 'cesium-container',
    url: '/samples/local/missing.copc.laz',
  });

  viewer.viewer = createFakeViewer();
  viewer.lifecycle = 'mounted';

  await assert.rejects(() => viewer.load());
  assert.equal(viewer.getSnapshot().lifecycle, 'loading');
});

test('createCopcViewer returns the started public viewer instance', async () => {
  const originalStart = CopcViewer.prototype.start;
  let started = 0;

  CopcViewer.prototype.start = async function startStub() {
    started += 1;
    this.lifecycle = 'ready';
  };

  const viewer = await createCopcViewer({
    container: 'cesium-container',
    url: '/samples/autzen.copc.laz',
  });

  assert.ok(viewer instanceof CopcViewer);
  assert.equal(started, 1);
  assert.equal(viewer.getSnapshot().lifecycle, 'ready');

  CopcViewer.prototype.start = originalStart;
});
