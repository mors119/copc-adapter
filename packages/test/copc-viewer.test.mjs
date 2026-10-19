import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { CopcCesiumLayer } from '../index.ts';
import { PointPrimitiveRenderer } from '../cesium/render/CopcPointRenderer.ts';
import { BatchedGeometryPointRenderer } from '../cesium/render/BatchedGeometryPointRenderer.ts';
import { createCesiumStreamingView } from '../cesium/view/CesiumViewAdapter.ts';

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
    raise(...args) {
      for (const listener of listeners) listener(...args);
    },
  };
}

function createFakeViewer() {
  const moveEnd = createEvent();
  const changed = createEvent();
  const removedCollections = [];
  const addedCollections = [];
  let activeBoundingSphereFlight;

  return {
    moveEnd,
    changed,
    removedCollections,
    addedCollections,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
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
        const flight = activeBoundingSphereFlight;
        activeBoundingSphereFlight = undefined;
        flight?.cancel?.();
        this.positionWC = options.destination;
      },
      flyToBoundingSphere(sphere, options) {
        const previousFlight = activeBoundingSphereFlight;
        activeBoundingSphereFlight = undefined;
        previousFlight?.cancel?.();
        this.lastBoundingSphereFlight = { sphere, options };
        activeBoundingSphereFlight = options;
      },
      cancelFlight() {
        const flight = activeBoundingSphereFlight;
        activeBoundingSphereFlight = undefined;
        flight?.cancel?.();
      },
      completeBoundingSphereFlight() {
        const flight = activeBoundingSphereFlight;
        activeBoundingSphereFlight = undefined;
        flight?.complete?.();
      },
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

function getLayerPointCollection(viewer, layerIndex = 0) {
  return viewer.addedCollections[layerIndex].get(0);
}

function createBackend({ onFields, metadata: metadataOverride } = {}) {
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
  let pointChunkRequestCount = 0;
  let decodeCount = 0;
  let lastOpenOptions;

  return {
    get openCount() {
      return openCount;
    },
    get destroyCount() {
      return destroyCount;
    },
    get pointChunkRequestCount() {
      return pointChunkRequestCount;
    },
    get decodeCount() {
      return decodeCount;
    },
    get lastOpenOptions() {
      return lastOpenOptions;
    },
    backend: {
      async open(source, options) {
        lastOpenOptions = options;
        openCount += 1;
        return {
          source,
          getMetadata() {
            return metadataOverride ?? {
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
            pointChunkRequestCount += 1;
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
        decodeCount += 1;
        return {
          pointCount: 2,
          coordinates: new Float64Array([
            -122.6, 44.4, 12,
            -122.4, 44.6, 18,
          ]),
          attributes: {
            intensity: new Uint16Array([100, 500]),
            classification: new Uint8Array([2, 6]),
            red: new Uint16Array([255, 128]),
            green: new Uint16Array([0, 128]),
            blue: new Uint16Array([0, 255]),
          },
        };
      },
    },
  };
}

async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
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
  assert.equal(source.lastOpenOptions.rangeValidation, undefined);
  assert.equal(layer.getSnapshot().lifecycle, 'ready');
  const hierarchy = layer.getHierarchyDiagnostics();
  assert.equal(hierarchy.pageRequests, 1);
  assert.equal(hierarchy.pageCacheHits, 0);
  assert.equal(hierarchy.hierarchyBytesFetched, 10);
  assert.equal(hierarchy.loadedPageCount, 1);
  assert.equal(hierarchy.discoveredPageCount, 1);
  assert.equal(hierarchy.completedPageCount, 1);
  assert.equal(hierarchy.activePageLoads, 0);
  assert.equal(hierarchy.peakActivePageLoads, 1);
  assert.ok(hierarchy.rootHierarchyLoadDurationMs >= 0);
  assert.equal(hierarchy.lastQueryDurationMs, 0);
  assert.equal(hierarchy.loadedEntryCount, 1);

  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

  assert.deepEqual(requestedFields, [[
    'position',
    'intensity',
    'classification',
    'rgb',
  ]]);
  assert.deepEqual(layer.getSnapshot().selectedNodeKeys, ['0-0-0-0']);
  assert.deepEqual(layer.getSnapshot().renderedNodeKeys, ['0-0-0-0']);
  assert.equal(layer.getSnapshot().streamingUpdateCount, 1);

  layer.destroy();
  assert.equal(source.destroyCount, 1);
  assert.equal(viewer.destroyed, false);
});

test('CopcCesiumLayer validates refinement options and focus values', () => {
  assert.throws(() => new CopcCesiumLayer({
    url: 'memory://invalid-refinement-algorithm.copc.laz',
    streaming: { refinementAlgorithm: 'nearest' },
  }), /Unknown refinement algorithm.*foveated.*screen-projection/);

  const layer = new CopcCesiumLayer({ url: 'memory://invalid-focus.copc.laz' });
  assert.throws(() => layer.setRefinementFocus({
    type: 'screen-circle',
    center: { x: Number.NaN, y: 0.5 },
    radius: 0.1,
    detailBias: 2,
  }), /center\.x/);
  assert.throws(() => layer.setRefinementFocus({
    type: 'screen-circle',
    center: { x: 0.5, y: 0.5 },
    radius: 0,
    detailBias: 2,
  }), /radius/);
  assert.throws(() => layer.setRefinementFocus({
    type: 'screen-circle',
    center: { x: 0.5, y: 0.5 },
    radius: 0.1,
    detailBias: 2.1,
  }), /detailBias/);
  layer.destroy();
});

test('focus changes reselect a stationary Cesium view without reopening or reloading points', async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://runtime-focus.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  const waitForViewSettled = () => {
    let removeListener = () => {};
    let timeout;
    return new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        removeListener();
        reject(new Error('timed out waiting for Cesium view to settle'));
      }, 5000);
      removeListener = layer.viewSettled.addEventListener((viewGeneration, selectedNodeKeys) => {
        clearTimeout(timeout);
        removeListener();
        resolve({ viewGeneration, selectedNodeKeys });
      });
    });
  };
  try {
    await layer.load();
    const initialSettled = waitForViewSettled();
    layer.attachTo(viewer);
    await initialSettled;
    assert.equal(layer.getSnapshot().renderedPointCount, 2);
    assert.equal(layer.getSnapshot().performance.refinementAlgorithm, 'foveated');
    const updatesBeforeFocus = layer.getSnapshot().streamingUpdateCount;
    const focusSettled = waitForViewSettled();

    layer.setRefinementFocus({
      type: 'screen-circle',
      center: { x: 0.8, y: 0.5 },
      radius: 0.15,
      detailBias: 2,
    });
    await focusSettled;

    assert.ok(layer.getSnapshot().streamingUpdateCount > updatesBeforeFocus);
    assert.equal(layer.getSnapshot().performance.refinementFocusEnabled, true);
    assert.equal(source.openCount, 1);
    assert.equal(source.pointChunkRequestCount, 1);
    assert.equal(source.decodeCount, 1);
  } finally {
    layer.destroy();
    globalThis.window = originalWindow;
  }
});

test('CopcCesiumLayer forwards an explicit strict HTTP validation policy', async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://strict-policy.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
    rangeValidation: 'strict',
  });

  await layer.load();
  assert.equal(source.lastOpenOptions.rangeValidation, 'strict');
  layer.destroy();
});

test('Cesium layers load geographic-WKT metadata with automatic framing before or after attachment', async () => {
  const metadata = {
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
    wkt: 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
  };

  for (const attachBeforeLoad of [true, false]) {
    const source = createBackend({ metadata: metadata });
    const layer = new CopcCesiumLayer({
      url: `memory://geographic-wkt-${attachBeforeLoad}.copc.laz`,
      backend: source.backend,
      decoder: source.decoder,
    });
    const viewer = createFakeViewer();
    const automaticFlights = [];
    const nativeFlyTo = viewer.camera.flyTo.bind(viewer.camera);
    viewer.camera.flyTo = (options) => {
      automaticFlights.push(options);
      nativeFlyTo(options);
    };

    if (attachBeforeLoad) {
      layer.attachTo(viewer);
    }
    await layer.load();
    if (!attachBeforeLoad) {
      layer.attachTo(viewer);
    }
    await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

    assert.equal(automaticFlights.length, 1);
    assert.ok(Number.isFinite(automaticFlights[0].destination.z));
    assert.ok(layer.boundingSphere);
    layer.destroy();
  }
});

test('Cesium metadata and view events describe real milestones with one public view generation', async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://layer-events.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
  });
  layer.show = false;
  const viewer = createFakeViewer();
  const events = [];
  let releaseDecode;
  let decodeStartedResolve;
  const decodeStarted = new Promise((resolve) => { decodeStartedResolve = resolve; });
  const decodeGate = new Promise((resolve) => { releaseDecode = resolve; });
  const normalDecode = source.decoder.decode.bind(source.decoder);
  source.decoder.decode = async (...args) => {
    decodeStartedResolve();
    await decodeGate;
    return normalDecode(...args);
  };
  layer.metadataReady.addEventListener((metadata, loadGeneration) => {
    events.push(['metadataready', metadata, loadGeneration]);
  });
  layer.loadProgress.addEventListener((queued, active, viewGeneration) => {
    events.push(['progress', queued, active, viewGeneration]);
  });
  layer.firstVisible.addEventListener((loadGeneration, viewGeneration) => {
    events.push(['firstvisible', loadGeneration, viewGeneration]);
  });
  layer.viewSettled.addEventListener((viewGeneration, selectedNodeKeys) => {
    events.push(['viewsettled', viewGeneration, selectedNodeKeys]);
  });
  layer.attachTo(viewer);

  let loadSettled = false;
  const loadPromise = layer.load().then(() => { loadSettled = true; });
  await decodeStarted;
  assert.equal(viewer.addedCollections[0].show, false);
  assert.equal(events.filter(([type]) => type === 'metadataready').length, 1);
  assert.equal(loadSettled, false, 'metadata readiness must precede the attached initial view completion');
  releaseDecode();
  await loadPromise;

  const metadataEvent = events.find(([type]) => type === 'metadataready');
  const firstVisibleEvent = events.find(([type]) => type === 'firstvisible');
  const settledEvent = events.find(([type]) => type === 'viewsettled');
  const progressEvents = events.filter(([type]) => type === 'progress');
  assert.ok(metadataEvent);
  assert.ok(firstVisibleEvent);
  assert.ok(settledEvent);
  assert.ok(progressEvents.length > 0);
  assert.ok(events.indexOf(metadataEvent) < events.indexOf(progressEvents[0]));
  assert.equal(firstVisibleEvent[1], metadataEvent[2]);
  assert.equal(firstVisibleEvent[2], settledEvent[1]);
  assert.equal(settledEvent[2].includes('0-0-0-0'), true);
  const sourceBounds = layer.boundingSphere;
  const renderedBounds = layer.controller.getSelectionBoundingSphere();
  assert.ok(sourceBounds && renderedBounds);
  assert.ok(sourceBounds.radius > renderedBounds.radius);
  layer.show = true;
  assert.equal(viewer.addedCollections[0].show, true);
  for (let index = 1; index < progressEvents.length; index += 1) {
    assert.notDeepEqual(progressEvents[index].slice(1, 3), progressEvents[index - 1].slice(1, 3));
    assert.equal(progressEvents[index][3], settledEvent[1]);
  }
  layer.destroy();
});

test('Cesium lifecycle events preserve native listener deduplication and removal behavior', () => {
  const layer = new CopcCesiumLayer({ url: 'memory://cesium-event-listeners.copc.laz' });
  const event = layer.metadataReady;
  assert.ok(event instanceof Cesium.Event);
  let calls = 0;
  const scope = {};
  const listener = () => { calls += 1; };
  const remove = event.addEventListener(listener, scope);
  const removeDuplicate = event.addEventListener(listener, scope);
  assert.equal(event.numberOfListeners, 1);

  event.raiseEvent({ pointCount: 1 }, 1);
  assert.equal(calls, 1);
  remove();
  removeDuplicate();
  assert.equal(event.numberOfListeners, 0);

  event.addEventListener(listener, scope);
  assert.equal(event.removeEventListener(listener, scope), true);
  assert.equal(event.removeEventListener(listener, scope), false);
  assert.equal(event.numberOfListeners, 0);

  event.addEventListener(listener);
  layer.destroy();
  event.raiseEvent({ pointCount: 1 }, 2);
  assert.equal(event.numberOfListeners, 0);
  assert.equal(calls, 1, 'destroy removes listeners and shuts event delivery down');
});

test('Cesium boundingSphere caches full metadata extent, clones on access, and clears on unload', async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://metadata-sphere.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
    heightOffsetMeters: 20,
  });
  assert.equal(layer.boundingSphere, undefined);
  await layer.load();
  const first = layer.boundingSphere;
  assert.ok(first instanceof Cesium.BoundingSphere);
  const expected = Cesium.BoundingSphere.clone(first);
  first.radius = 0;
  first.center.x = 123;
  const second = layer.boundingSphere;
  assert.ok(second);
  assert.equal(second.radius, expected.radius);
  assert.equal(second.center.x, expected.center.x);

  layer.unload();
  assert.equal(layer.boundingSphere, undefined);
  await layer.reload();
  assert.ok(layer.boundingSphere instanceof Cesium.BoundingSphere);
  layer.destroy();
});

test('unsupported Cesium extent leaves boundingSphere unavailable', async () => {
  const bounds = {
    minX: -1_100_000,
    minY: -1_100_000,
    minZ: 0,
    maxX: 1_100_000,
    maxY: 1_100_000,
    maxZ: 10,
  };
  const source = createBackend({
    metadata: {
      pointCount: 2,
      bounds,
      cube: bounds,
      wkt: 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]',
    },
  });
  const layer = new CopcCesiumLayer({
    url: 'memory://unsupported-bounds.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
  });
  await layer.load();
  assert.equal(layer.boundingSphere, undefined);
  layer.destroy();
});

test('Cesium load failure emits a load error while preserving Promise rejection', async () => {
  const layer = new CopcCesiumLayer({
    url: 'memory://load-error.copc.laz',
    backend: {
      async open() {
        throw new Error('controlled Cesium source failure');
      },
    },
  });
  const errors = [];
  layer.error.addEventListener((event) => errors.push(event));
  await assert.rejects(
    layer.load(),
    (error) => error.cause?.message === 'controlled Cesium source failure',
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, 'load');
  assert.ok(Number.isInteger(errors[0].loadGeneration));
  assert.equal('viewGeneration' in errors[0], false);
  layer.destroy();
});

test('Cesium zoomTo resolves completion and cancellation and rejects invalid state', async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://zoom-to.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
  });
  await assert.rejects(layer.zoomTo(), /must be attached/);
  await layer.load();
  const viewer = createFakeViewer();
  layer.attachTo(viewer);
  viewer.scene.mode = Cesium.SceneMode.MORPHING;
  await assert.rejects(layer.zoomTo(), /scene is morphing/);
  delete viewer.scene.mode;
  viewer.destroyed = true;
  await assert.rejects(layer.zoomTo(), /Viewer has been destroyed/);
  viewer.destroyed = false;
  await assert.rejects(
    layer.zoomTo({ heading: Number.NaN, pitch: 0, range: 1 }),
    /finite values/,
  );

  const firstFlight = layer.zoomTo(new Cesium.HeadingPitchRange(0, -0.5, 0));
  const secondFlight = layer.zoomTo();
  assert.equal(await firstFlight, false);
  viewer.camera.completeBoundingSphereFlight();
  assert.equal(await secondFlight, true);

  const cancelledFlight = layer.zoomTo();
  viewer.camera.cancelFlight();
  assert.equal(await cancelledFlight, false);

  const applicationSupersededFlight = layer.zoomTo();
  viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(-122, 44, 2000) });
  assert.equal(await applicationSupersededFlight, false);

  const unloadedFlight = layer.zoomTo();
  layer.unload();
  assert.equal(await unloadedFlight, false);
  await assert.rejects(layer.zoomTo(), /supported bounding sphere/);
  await layer.reload();

  const detachedFlight = layer.zoomTo();
  layer.detachFrom();
  assert.equal(await detachedFlight, false);
  await assert.rejects(layer.zoomTo(), /must be attached/);
  layer.attachTo(viewer);
  const destroyedFlight = layer.zoomTo();
  layer.destroy();
  assert.equal(await destroyedFlight, false);
  await assert.rejects(layer.zoomTo(), /destroyed/);
});

test('explicit zoomTo remains separate from legacy automatic initial framing', async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://automatic-and-explicit-framing.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();
  let automaticFlights = 0;
  const nativeFlyTo = viewer.camera.flyTo.bind(viewer.camera);
  viewer.camera.flyTo = (options) => {
    automaticFlights += 1;
    nativeFlyTo(options);
  };
  layer.attachTo(viewer);
  await layer.load();
  assert.equal(automaticFlights, 1);

  const explicitFlight = layer.zoomTo();
  assert.equal(automaticFlights, 1);
  viewer.camera.completeBoundingSphereFlight();
  assert.equal(await explicitFlight, true);
  layer.destroy();
});

test('two Cesium layers can supersede camera flights without destroying their shared Viewer', async () => {
  const firstSource = createBackend();
  const secondSource = createBackend();
  const first = new CopcCesiumLayer({
    url: 'memory://first-zoom.copc.laz',
    backend: firstSource.backend,
    decoder: firstSource.decoder,
  });
  const second = new CopcCesiumLayer({
    url: 'memory://second-zoom.copc.laz',
    backend: secondSource.backend,
    decoder: secondSource.decoder,
  });
  const viewer = createFakeViewer();
  await Promise.all([first.load(), second.load()]);
  first.attachTo(viewer);
  second.attachTo(viewer);

  const firstFlight = first.zoomTo();
  const secondFlight = second.zoomTo();
  assert.equal(await firstFlight, false);
  viewer.camera.completeBoundingSphereFlight();
  assert.equal(await secondFlight, true);
  first.destroy();
  second.destroy();
  assert.equal(viewer.destroyed, false);
});

test('runtime Cesium styling filters cached points without another point-chunk request or decode', async () => {
  const source = createBackend();
  const picked = [];
  const layer = new CopcCesiumLayer({
    url: 'memory://runtime-style.copc.laz',
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
  const collection = getLayerPointCollection(viewer);
  const requestCount = source.pointChunkRequestCount;
  const decodeCount = source.decodeCount;
  const cacheBefore = layer.getPointCacheDiagnostics();
  const hierarchyBefore = layer.getHierarchyDiagnostics();
  const streamingUpdateCount = layer.getSnapshot().streamingUpdateCount;

  layer.setStyle({ colorMode: 'elevation' });
  assert.notDeepEqual(collection.get(0).color, collection.get(1).color);
  layer.setStyle({ colorMode: 'rgb' });
  assert.deepEqual(
    [collection.get(0).color.red, collection.get(0).color.green, collection.get(0).color.blue],
    [1, 0, 0],
  );
  layer.setStyle({ colorMode: 'intensity' });
  assert.deepEqual(
    [collection.get(0).color.red, collection.get(0).color.green, collection.get(0).color.blue],
    [0, 0, 0],
  );
  layer.setStyle({
    colorMode: 'classification',
    classificationFilter: { include: [6] },
  });

  assert.equal(layer.getStyle().colorMode, 'classification');
  assert.deepEqual(layer.getStyle().classificationFilter, { include: [6] });
  assert.equal(layer.getSnapshot().renderedPointCount, 1);
  assert.equal(layer.getSnapshot().renderedNodeKeys.includes(nodeKey), true);
  assert.equal(collection.get(0).show, false);
  assert.equal(collection.get(1).show, true);
  assert.equal(collection.get(1).id.pointIndex, 1);

  const controller = layer.controller;
  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 1, ownerId: controller.pointPicker.ownerId },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  assert.equal(layer.getSelectedPoint().pointIndex, 1);
  assert.equal(layer.getSelectedPoint().classification, 6);
  assert.equal(picked.at(-1).classification, 6);

  layer.setStyle({ classificationFilter: { exclude: [6] } });
  assert.equal(collection.get(0).show, true);
  assert.equal(collection.get(1).show, false);
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(picked.at(-1), undefined);

  layer.setStyle({ classificationFilter: { include: [] } });
  assert.equal(layer.getSnapshot().renderedPointCount, 0);
  layer.setStyle({ classificationFilter: { include: [2, 6], exclude: [6] } });
  assert.equal(layer.getSnapshot().renderedPointCount, 1);
  assert.equal(collection.get(0).show, true);
  assert.equal(collection.get(1).show, false);

  layer.setStyle({ classificationFilter: { exclude: [] } });
  assert.equal(layer.getSnapshot().renderedPointCount, 2);
  layer.setStyle({ classificationFilter: {} });
  assert.equal(layer.getSnapshot().renderedPointCount, 2);
  layer.setStyle({ classificationFilter: null });
  assert.equal(layer.getSnapshot().renderedPointCount, 2);

  assert.equal(source.pointChunkRequestCount, requestCount);
  assert.equal(source.decodeCount, decodeCount);
  assert.deepEqual(layer.getPointCacheDiagnostics(), cacheBefore);
  assert.deepEqual(layer.getHierarchyDiagnostics(), hierarchyBefore);
  assert.equal(layer.getSnapshot().streamingUpdateCount, streamingUpdateCount);
  assert.equal(viewer.addedCollections.length, 1);
  assert.equal(viewer.removedCollections.length, 0);
  layer.destroy();
});

test('missing classification values use the color fallback and cannot pass an active filter', async () => {
  const source = createBackend();
  source.decoder = {
    async decode() {
      return {
        pointCount: 2,
        coordinates: new Float64Array([
          -122.6, 44.4, 12,
          -122.4, 44.6, 18,
        ]),
        attributes: {
          intensity: new Uint16Array([100, 500]),
          red: new Uint16Array([255, 128]),
          green: new Uint16Array([0, 128]),
          blue: new Uint16Array([0, 255]),
        },
      };
    },
  };
  const layer = new CopcCesiumLayer({
    url: 'memory://no-classification.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedNodeKeys.length === 1);
  const collection = getLayerPointCollection(viewer);

  layer.setStyle({
    colorMode: 'classification',
    classificationFilter: { include: [2] },
  });
  assert.equal(layer.getSnapshot().renderedPointCount, 0);
  assert.equal(collection.get(0).show, false);
  assert.equal(collection.get(1).show, false);

  layer.setStyle({ classificationFilter: null });
  assert.equal(layer.getSnapshot().renderedPointCount, 2);
  assert.deepEqual(
    [collection.get(0).color.red, collection.get(0).color.green, collection.get(0).color.blue],
    [0, 1, 1],
  );
  layer.destroy();
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

test('Cesium layer show state is isolated and survives attachment and reload', async () => {
  const firstSource = createBackend();
  const secondSource = createBackend();
  const firstLayer = new CopcCesiumLayer({
    url: 'memory://first-layer.copc.laz',
    backend: firstSource.backend,
    decoder: firstSource.decoder,
  });
  const secondLayer = new CopcCesiumLayer({
    url: 'memory://second-layer.copc.laz',
    backend: secondSource.backend,
    decoder: secondSource.decoder,
  });
  const viewer = createFakeViewer();

  await Promise.all([firstLayer.load(), secondLayer.load()]);
  firstLayer.attachTo(viewer);
  secondLayer.attachTo(viewer);
  await Promise.all([
    waitFor(() => firstLayer.getSnapshot().renderedPointCount === 2),
    waitFor(() => secondLayer.getSnapshot().renderedPointCount === 2),
  ]);

  const firstContainer = viewer.addedCollections[0];
  const secondContainer = viewer.addedCollections[1];
  const applicationPrimitive = { show: true };
  viewer.scene.primitives.add(applicationPrimitive);
  assert.notEqual(firstContainer, secondContainer);
  assert.equal(firstContainer.length, 1);
  assert.equal(secondContainer.length, 1);
  assert.equal(firstLayer.show, true);
  assert.equal(secondLayer.show, true);

  firstLayer.show = false;
  assert.equal(firstContainer.show, false);
  assert.equal(secondContainer.show, true);
  assert.equal(getLayerPointCollection(viewer, 0).get(0).show, true);
  firstLayer.show = true;
  assert.equal(firstContainer.show, true);

  firstLayer.show = false;
  firstLayer.detachFrom();
  assert.equal(viewer.removedCollections.length, 1);
  assert.equal(viewer.removedCollections[0], firstContainer);
  assert.equal(secondLayer.getSnapshot().attached, true);
  assert.equal(secondContainer.show, true);
  assert.equal(applicationPrimitive.show, true);

  firstLayer.attachTo(viewer);
  await waitFor(() => firstLayer.getSnapshot().renderedPointCount === 2);
  const reattachedContainer = viewer.addedCollections[3];
  assert.equal(reattachedContainer.show, false);
  assert.equal(firstLayer.show, false);

  await firstLayer.reload();
  assert.equal(viewer.addedCollections.length, 4);
  assert.equal(reattachedContainer.show, false);
  assert.equal(reattachedContainer.length, 1);
  assert.equal(secondLayer.getSnapshot().renderedPointCount, 2);

  firstLayer.destroy();
  assert.equal(viewer.removedCollections.length, 2);
  assert.equal(viewer.removedCollections[1], reattachedContainer);
  assert.equal(viewer.removedCollections.includes(applicationPrimitive), false);
  assert.equal(secondLayer.getSnapshot().attached, true);
  assert.equal(secondLayer.getSnapshot().renderedPointCount, 2);
  assert.equal(viewer.destroyed, false);
  secondLayer.destroy();
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

test('coalesces repeated camera events when the view has not materially changed', async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://camera-events.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  const initialUpdateCount = layer.getSnapshot().streamingUpdateCount;

  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  try {
    viewer.changed.raise();
    viewer.moveEnd.raise();
    await new Promise((resolve) => setTimeout(resolve, 125));

    assert.equal(layer.getSnapshot().streamingUpdateCount, initialUpdateCount);
  } finally {
    layer.destroy();
    globalThis.window = originalWindow;
  }
});

test('invalidates stale progress when a materially changed camera event is queued', async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://queued-camera-events.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

  const controller = layer.controller;
  const originalUpdateView = controller.core.updateView.bind(controller.core);
  const staleUpdate = createDeferred();
  const currentUpdate = createDeferred();
  const stalePoints = {
    pointCount: 1,
    coordinates: new Float64Array([-122.3, 44.7, 25]),
  };
  let updateCallCount = 0;
  controller.core.updateView = async (view, onProgress) => {
    updateCallCount += 1;
    if (updateCallCount === 1) {
      await staleUpdate.promise;
      onProgress({
        selectedNodeKeys: ['stale-node'],
        removedNodeKeys: [],
        loadedNodePoints: new Map([['stale-node', stalePoints]]),
        completedBatchPointCount: 1,
        replacementGroups: [],
        generation: 1,
      });
      return {
        selectedNodeKeys: ['stale-node'],
        removedNodeKeys: [],
        loadedNodePoints: new Map([['stale-node', stalePoints]]),
        replacementGroups: [],
        generation: 1,
      };
    }
    if (updateCallCount === 2) {
      await currentUpdate.promise;
    }
    return originalUpdateView(view, onProgress);
  };

  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  try {
    viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(-122.5, 44.5, 2000);
    viewer.moveEnd.raise();
    await waitFor(() => updateCallCount === 1);

    viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(-122.5, 44.5, 3000);
    viewer.moveEnd.raise();
    await new Promise((resolve) => setTimeout(resolve, 125));

    let queuedUpdateSettled = false;
    const queuedUpdate = controller.updateStreamingView().then(() => {
      queuedUpdateSettled = true;
    });
    staleUpdate.resolve();
    await waitFor(() => updateCallCount === 2);

    assert.equal(layer.getSnapshot().renderedNodeKeys.includes('stale-node'), false);
    assert.equal(queuedUpdateSettled, false);

    currentUpdate.resolve();
    await queuedUpdate;
  } finally {
    layer.destroy();
    globalThis.window = originalWindow;
  }
});

test('reload waits for a queued update after the previous update is invalidated', async () => {
  const source = createBackend();
  const layer = new CopcCesiumLayer({
    url: 'memory://queued-reload.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

  const controller = layer.controller;
  const originalUpdateView = controller.core.updateView.bind(controller.core);
  const previousUpdate = createDeferred();
  const reloadUpdate = createDeferred();
  let updateCallCount = 0;
  controller.core.updateView = async (view, onProgress) => {
    updateCallCount += 1;
    if (updateCallCount === 1) {
      await previousUpdate.promise;
      return undefined;
    }
    if (updateCallCount === 2) {
      await reloadUpdate.promise;
    }
    return originalUpdateView(view, onProgress);
  };

  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  try {
    viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(-122.5, 44.5, 2000);
    viewer.moveEnd.raise();
    await waitFor(() => updateCallCount === 1);

    let reloadSettled = false;
    const reloadPromise = layer.reload().then(() => {
      reloadSettled = true;
    });
    await waitFor(() => source.openCount === 2);
    assert.equal(reloadSettled, false);

    previousUpdate.resolve();
    await waitFor(() => updateCallCount === 2);
    assert.equal(reloadSettled, false);

    reloadUpdate.resolve();
    await reloadPromise;
    assert.equal(reloadSettled, true);
    await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
    assert.equal(layer.getSnapshot().lifecycle, 'ready');
  } finally {
    layer.destroy();
    globalThis.window = originalWindow;
  }
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
  const errors = [];
  layer.error.addEventListener((event) => errors.push(event));
  layer.attachTo(viewer);

  await assert.rejects(() => layer.load(), /point decode failed/);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, 'view');
  assert.ok(Number.isInteger(errors[0].viewGeneration));
  assert.equal('loadGeneration' in errors[0], false);
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
  assert.equal(viewer.addedCollections.length, 1);
  assert.equal(viewer.removedCollections.length, 1);
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
  let scenePickArguments;

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);

  // Drive the adapter-owned picker without constructing a browser DOM or a
  // real WebGL scene.
  const controller = layer.controller;
  viewer.scene.pick = (...args) => {
    scenePickArguments = args;
    return {
      id: { nodeKey, pointIndex: 1, ownerId: controller.pointPicker.ownerId },
    };
  };
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));

  assert.equal(scenePickArguments.length, 1, 'default renderer keeps Cesium pick defaults');
  assert.equal(layer.getSelectedPoint().nodeKey, nodeKey);
  assert.equal(layer.getSelectedPoint().pointIndex, 1);
  assert.deepEqual(layer.getSelectedPoint().rgb, { red: 128, green: 128, blue: 255 });

  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 1, ownerId: 'copc-layer-foreign' },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(picked.at(-1), undefined);

  viewer.scene.pick = () => ({
    id: { nodeKey, pointIndex: 0, ownerId: controller.pointPicker.ownerId },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  controller.core.streamingState.cache.delete(nodeKey);
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(picked.at(-1), undefined);

  layer.destroy();
});

test('CesiumPointPicker delegates node-level hits to the injected renderer and inspects the returned identity', async () => {
  const source = createBackend();
  const renderer = new PointPrimitiveRenderer();
  const viewer = createFakeViewer();
  const nodeKey = '0-0-0-0';
  const picked = [];
  let pointPickerOwnerId;
  let scenePickCalls = 0;
  let resolverCalls = 0;
  let scenePickArguments;
  renderer.resolvePointPick = (scene, position, pickedObject) => {
    resolverCalls += 1;
    assert.equal(scene, viewer.scene);
    assert.deepEqual([position.x, position.y], [10, 10]);
    assert.equal(pickedObject.id.nodeKey, nodeKey);
    return {
      nodeKey,
      pointIndex: 1,
      ownerId: pointPickerOwnerId,
    };
  };
  const layer = new CopcCesiumLayer({
    url: 'memory://batched-picker-delegation.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
    renderer,
    onPointPicked: (point) => picked.push(point),
  });
  pointPickerOwnerId = layer.controller.pointPicker.ownerId;

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  viewer.scene.pick = (...args) => {
    scenePickCalls += 1;
    scenePickArguments = args;
    return { id: { nodeKey, ownerId: layer.controller.pointPicker.ownerId } };
  };
  layer.controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));

  assert.equal(scenePickCalls, 1);
  assert.deepEqual(scenePickArguments.slice(1), [1, 1]);
  assert.equal(resolverCalls, 1);
  assert.equal(layer.getSelectedPoint().nodeKey, nodeKey);
  assert.equal(layer.getSelectedPoint().pointIndex, 1);
  assert.deepEqual(layer.getSelectedPoint().rgb, { red: 128, green: 128, blue: 255 });
  assert.equal(picked.at(-1).pointIndex, 1);
  layer.destroy();
});

test('batched renderer follows layer style, unload, reload, and reattach lifecycle', async () => {
  const source = createBackend();
  const renderer = new BatchedGeometryPointRenderer();
  const layer = new CopcCesiumLayer({
    url: 'memory://batched-lifecycle.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
    renderer,
    colorMode: 'classification',
  });
  const viewer = createFakeViewer();

  await layer.load();
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  const nodeKey = layer.getSnapshot().renderedNodeKeys[0];
  assert.ok(nodeKey);
  const initialRequests = source.pointChunkRequestCount;
  assert.equal(renderer.hasNode(nodeKey), true);

  layer.setStyle({ classificationFilter: { include: [6] } });
  assert.equal(layer.getSnapshot().renderedPointCount, 1);
  assert.equal(renderer.getRenderedNodePointCount(nodeKey), 1);
  assert.equal(source.pointChunkRequestCount, initialRequests);

  layer.unload();
  assert.equal(layer.getSnapshot().renderedPointCount, 0);
  assert.equal(renderer.getRenderedNodeKeys().length, 0);
  await layer.reload();
  await waitFor(() => layer.getSnapshot().renderedPointCount === 1);
  assert.equal(renderer.hasNode(nodeKey), true);

  layer.detachFrom();
  assert.equal(layer.getSnapshot().renderedPointCount, 0);
  layer.attachTo(viewer);
  await waitFor(() => layer.getSnapshot().renderedPointCount === 1);
  layer.destroy();
  assert.equal(renderer.getRenderedNodeKeys().length, 0);
  assert.equal(viewer.destroyed, false);
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
    id: { nodeKey, pointIndex: 0, ownerId: controller.pointPicker.ownerId },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
  assert.ok(layer.getSelectedPoint());

  layer.unload();
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(layer.getSnapshot().selectedNodeKeys.length, 0);
  assert.equal(layer.getSnapshot().renderedPointCount, 0);

  await layer.reload();
  await waitFor(() => layer.getSnapshot().renderedPointCount === 2);
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
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
    id: { nodeKey, pointIndex: 0, ownerId: controller.pointPicker.ownerId },
  });
  controller.pointPicker.pick(viewer, new Cesium.Cartesian2(10, 10));
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
