import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { CopcCesiumLayer, CopcSourceError } from '../src/index.ts';
import { CopcLayerController } from '../src/viewer/CopcViewer.ts';
import { PointPrimitiveRenderer } from '../src/cesium/render/CopcPointRenderer.ts';

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

function createStreamingState(update, nodes = new Map()) {
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
    nodes,
    context: {},
    manager: { update },
  };
}

function createFakeBackend() {
  const node = {
    key: '0-0-0-0',
    level: 0,
    x: 0,
    y: 0,
    z: 0,
    pointCount: 1,
    pointDataOffset: 100,
    pointDataLength: 20,
  };

  return {
    async open(source) {
      return {
        source,
        getMetadata() {
          return {
            pointCount: 1,
            bounds: {
              minX: -123,
              minY: 44,
              minZ: 10,
              maxX: -123,
              maxY: 44,
              maxZ: 10,
            },
            cube: {
              minX: -123,
              minY: 44,
              minZ: 10,
              maxX: -122,
              maxY: 45,
              maxZ: 11,
            },
          };
        },
        getRootHierarchyPage() {
          return { key: node.key, pageOffset: 10, pageLength: 10 };
        },
        async loadHierarchyPage() {
          return { nodes: [node], pages: [] };
        },
        async loadPointDataView() {
          throw new Error('point data is not loaded until the layer is attached');
        },
      };
    },
  };
}

test('CopcLayerController destroy releases layer resources without destroying the attached viewer', () => {
  const originalWindow = globalThis.window;
  const fakeViewer = createFakeViewer();
  const renderer = new PointPrimitiveRenderer();
  const viewer = new CopcLayerController({
    url: '/samples/autzen.copc.laz',
    renderer,
  });
  let cleared = 0;
  let removedListener;

  globalThis.window = {
    clearTimeout() {},
  };
  fakeViewer.camera.moveEnd.removeEventListener = (listener) => {
    removedListener = listener;
  };

  renderer.attachTo(fakeViewer);
  renderer.addOrUpdateNode('0-0-0-0', {
    pointCount: 1,
    coordinates: new Float64Array([-123, 44, 10]),
  }, { pointSize: 2 });
  viewer.viewer = fakeViewer;
  viewer.updateTimer = 42;
  viewer.selectedNodeKeys.add('0-0-0-0');
  viewer.nodePointCache.clear = () => {
    cleared += 1;
  };

  viewer.destroy();
  viewer.destroy();

  assert.equal(fakeViewer.destroyed, false);
  assert.equal(removedListener, viewer.handleCameraMoveEnd);
  assert.equal(viewer.getRenderedNodeKeys().length, 0);
  assert.equal(viewer.getCurrentSelection().length, 0);
  assert.equal(viewer.getSnapshot().lifecycle, 'destroyed');
  assert.equal(cleared, 1);

  globalThis.window = originalWindow;
});

test('CopcCesiumLayer attaches and detaches without taking ownership of the viewer', () => {
  const fakeViewer = createFakeViewer();
  const layer = new CopcCesiumLayer({
    url: '/samples/autzen.copc.laz',
    pointSize: 5,
    colorMode: 'elevation',
    debug: true,
  });

  layer.attachTo(fakeViewer);

  assert.equal(layer.getSnapshot().attached, true);
  assert.equal(fakeViewer.moveEndListeners.size, 1);

  layer.detachFrom();

  assert.equal(layer.getSnapshot().attached, false);
  assert.equal(fakeViewer.moveEndListeners.size, 0);

  layer.destroy();
  assert.equal(fakeViewer.destroyed, false);
});

test('CopcCesiumLayer loads through an injected backend', async () => {
  const layer = new CopcCesiumLayer({
    url: 'memory://fake.copc.laz',
    backend: createFakeBackend(),
  });

  await layer.load();

  assert.equal(layer.getSnapshot().lifecycle, 'ready');
  assert.equal(layer.getMetadata().pointCount, 1);
  assert.deepEqual(layer.getHierarchyDiagnostics(), {
    pageRequests: 1,
    pageCacheHits: 0,
    hierarchyBytesFetched: 10,
    loadedPageCount: 1,
    loadedEntryCount: 1,
  });
  layer.unload();
  assert.equal(layer.getHierarchyDiagnostics(), undefined);
  await layer.reload();
  assert.equal(layer.getHierarchyDiagnostics()?.pageRequests, 1);
  layer.destroy();
});

test('CopcLayerController updateStreamingView removes stale nodes and renders newly loaded nodes', async () => {
  const fakeViewer = createFakeViewer();
  const renderer = new PointPrimitiveRenderer();
  const viewer = new CopcLayerController({
    url: '/samples/autzen.copc.laz',
    colorMode: 'elevation',
    renderer,
  });

  renderer.attachTo(fakeViewer);
  renderer.addOrUpdateNode('0-0-0-0', {
    pointCount: 1,
    coordinates: new Float64Array([-123, 44, 10]),
  }, { pointSize: 2 });
  const staleCollection = fakeViewer.addedCollections[0];
  viewer.viewer = fakeViewer;
  viewer.streamingState = createStreamingState(async () => ({
    selectedNodeKeys: ['1-0-0-0'],
    removedNodeKeys: ['0-0-0-0'],
    loadedNodePoints: new Map([
      [
        '1-0-0-0',
        {
          pointCount: 2,
          coordinates: new Float64Array([
            -123.0, 44.0, 0.0,
            -123.1, 44.1, 100.0,
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
  const renderedCollection = fakeViewer.addedCollections.at(-1);
  assert.notDeepEqual(
    renderedCollection.get(0).color,
    renderedCollection.get(1).color,
  );
  assert.ok(viewer.getSelectionBoundingSphere());
});

test('CopcLayerController maps Cesium picks and clears unrelated, removed, and evicted selections', () => {
  const fakeViewer = createFakeViewer();
  const nodeKey = '4-12-7-3';
  const points = {
    pointCount: 1,
    coordinates: new Float64Array([-123, 44, 132.42]),
    sourceCoordinates: new Float64Array([500000, 4870000, 434]),
    attributes: {
      intensity: new Uint16Array([8241]),
      classification: new Uint8Array([5]),
      red: new Uint16Array([12341]),
      green: new Uint16Array([24211]),
      blue: new Uint16Array([9841]),
    },
  };
  const renderer = new PointPrimitiveRenderer();
  renderer.attachTo(fakeViewer);
  renderer.addOrUpdateNode(nodeKey, points, { pointSize: 3 });
  const picked = [];
  const controller = new CopcLayerController({
    url: 'memory://pick.copc.laz',
    renderer,
    onPointPicked: (point) => picked.push(point),
    backend: 'rust',
  });
  controller.streamingState = {
    nodes: new Map([[nodeKey, {
      node: { key: nodeKey, level: 4 },
    }]]),
    context: {},
    manager: {},
  };
  controller.nodePointCache.get = () => points;
  fakeViewer.scene.pick = () => ({ id: {
    nodeKey,
    pointIndex: 0,
    ownerId: controller.pickOwnerId,
  } });

  controller.handlePick(fakeViewer, new Cesium.Cartesian2(10, 10));
  assert.equal(picked.length, 1);
  assert.equal(controller.getSelectedPoint().classificationLabel, 'High Vegetation');
  assert.equal(controller.getSelectedPoint().backend, 'rust');

  fakeViewer.scene.pick = () => ({ id: { unrelated: true } });
  controller.handlePick(fakeViewer, new Cesium.Cartesian2(10, 10));
  assert.equal(controller.getSelectedPoint(), undefined);
  assert.equal(picked.at(-1), undefined);

  fakeViewer.scene.pick = () => ({ id: {
    nodeKey,
    pointIndex: 0,
    ownerId: controller.pickOwnerId,
  } });
  controller.handlePick(fakeViewer, new Cesium.Cartesian2(10, 10));
  controller.nodePointCache.get = () => undefined;
  assert.equal(controller.getSelectedPoint(), undefined);

  controller.nodePointCache.get = () => points;
  fakeViewer.scene.pick = () => ({ id: {
    nodeKey,
    pointIndex: 0,
    ownerId: 'copc-layer-foreign',
  } });
  controller.handlePick(fakeViewer, new Cesium.Cartesian2(10, 10));
  assert.equal(controller.getSelectedPoint(), undefined);

  fakeViewer.scene.pick = () => ({ id: {
    nodeKey,
    pointIndex: 0,
    ownerId: controller.pickOwnerId,
  } });
  controller.handlePick(fakeViewer, new Cesium.Cartesian2(10, 10));
  controller.removePointCollection(nodeKey);
  assert.equal(controller.getSelectedPoint(), undefined);

  controller.unload();
  assert.equal(controller.getSelectedPoint(), undefined);
});

test('CopcLayerController retains a coarse parent until all selected replacements are ready', async () => {
  const fakeViewer = createFakeViewer();
  const renderer = new PointPrimitiveRenderer();
  const viewer = new CopcLayerController({
    url: '/samples/autzen.copc.laz',
    colorMode: 'elevation',
    renderer,
  });
  const parent = {
    node: { key: '0-0-0-0', level: 0, pointCount: 1 },
    children: ['1-0-0-0'],
  };
  const child = {
    node: { key: '1-0-0-0', level: 1, pointCount: 1 },
    children: [],
  };
  const nodes = new Map([
    ['0-0-0-0', parent],
    ['1-0-0-0', child],
  ]);
  const namesDuringProgress = [];

  renderer.attachTo(fakeViewer);
  renderer.addOrUpdateNode('0-0-0-0', {
    pointCount: 1,
    coordinates: new Float64Array([-123, 44, 10]),
  }, { pointSize: 2 });
  viewer.viewer = fakeViewer;
  viewer.streamingState = createStreamingState(async (_camera, onProgress) => {
    onProgress({
      selectedNodeKeys: ['1-0-0-0'],
      removedNodeKeys: ['0-0-0-0'],
      loadedNodePoints: new Map(),
      completedBatchPointCount: 0,
    });
    namesDuringProgress.push(viewer.getRenderedNodeKeys());
    onProgress({
      selectedNodeKeys: ['1-0-0-0'],
      removedNodeKeys: ['0-0-0-0'],
      loadedNodePoints: new Map([['1-0-0-0', {
        pointCount: 1,
        coordinates: new Float64Array([-123, 44, 100]),
      }]]),
      completedBatchPointCount: 1,
    });
    return {
      selectedNodeKeys: ['1-0-0-0'],
      removedNodeKeys: ['0-0-0-0'],
      loadedNodePoints: new Map(),
    };
  }, nodes);

  await viewer.updateStreamingView();

  assert.deepEqual(namesDuringProgress, [['0-0-0-0']]);
  assert.deepEqual(viewer.getRenderedNodeKeys(), ['1-0-0-0']);
});

test('CopcLayerController ignores loaded nodes after destroy during an in-flight update', async () => {
  const fakeViewer = createFakeViewer();
  const viewer = new CopcLayerController({
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

test('CopcLayerController ignores an older streaming result after a newer camera update', async () => {
  const fakeViewer = createFakeViewer();
  const renderer = new PointPrimitiveRenderer();
  const viewer = new CopcLayerController({
    url: '/samples/autzen.copc.laz',
    renderer,
  });
  let callCount = 0;
  let resolveFirst;
  let resolveSecond;

  renderer.attachTo(fakeViewer);
  viewer.viewer = fakeViewer;
  viewer.streamingState = createStreamingState(() => {
    callCount += 1;

    return new Promise((resolve) => {
      if (callCount === 1) {
        resolveFirst = resolve;
      } else {
        resolveSecond = resolve;
      }
    });
  });

  const firstUpdate = viewer.updateStreamingView();
  const secondUpdate = viewer.updateStreamingView();

  resolveSecond({
    selectedNodeKeys: ['1-0-0-0'],
    removedNodeKeys: [],
    loadedNodePoints: new Map([
      ['1-0-0-0', {
        pointCount: 1,
        coordinates: new Float64Array([-123, 44, 100]),
      }],
    ]),
  });
  await secondUpdate;

  resolveFirst({
    selectedNodeKeys: ['0-0-0-0'],
    removedNodeKeys: [],
    loadedNodePoints: new Map([
      ['0-0-0-0', {
        pointCount: 1,
        coordinates: new Float64Array([-123, 44, 100]),
      }],
    ]),
  });
  await firstUpdate;

  assert.deepEqual(viewer.getCurrentSelection(), ['1-0-0-0']);
  assert.deepEqual(viewer.getRenderedNodeKeys(), ['1-0-0-0']);
  viewer.destroy();
});

test('CopcLayerController loadRenderableNodePoints rejects missing streaming state and unknown nodes', async () => {
  const viewer = new CopcLayerController({
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

test('CopcLayerController decodes point views through an injected decoder', async () => {
  const node = {
    key: '0-0-0-0',
    level: 0,
    x: 0,
    y: 0,
    z: 0,
    pointCount: 1,
    pointDataOffset: 100,
    pointDataLength: 20,
  };
  const view = {
    pointCount: 1,
    availableFields: new Set(['position']),
    getter() {
      return () => 0;
    },
  };
  let decodedView;
  let requestedFields;
  const viewer = new CopcLayerController({
    url: 'memory://fake.copc.laz',
    decoder: {
      async decode(requestedView) {
        decodedView = requestedView;
        return {
          pointCount: 1,
          coordinates: new Float64Array([-123, 44, 10]),
        };
      },
    },
  });
  viewer.streamingState = {
    ...createStreamingState(async () => ({
      selectedNodeKeys: [],
      removedNodeKeys: [],
      loadedNodePoints: new Map(),
    })),
    context: {
      source: 'memory://fake.copc.laz',
      async loadPointDataView(_node, fields) {
        requestedFields = fields;
        return view;
      },
    },
  };

  const buffer = await viewer.loadPoints(node);

  assert.equal(decodedView, view);
  assert.deepEqual([...requestedFields], ['position']);
  assert.deepEqual(Array.from(buffer.coordinates), [-123, 44, 10]);
});

test('CopcLayerController load rejects invalid dataset paths', async () => {
  const viewer = new CopcLayerController({
    url: '/samples/local/missing.copc.laz',
  });

  viewer.viewer = createFakeViewer();
  viewer.lifecycle = 'mounted';

  await assert.rejects(
    () => viewer.load(),
    (error) => {
      assert.ok(error instanceof CopcSourceError);
      assert.equal(error.stage, 'source');
      assert.match(error.message, /missing\.copc\.laz/);
      return true;
    },
  );
  assert.equal(viewer.getSnapshot().lifecycle, 'loading');
});
