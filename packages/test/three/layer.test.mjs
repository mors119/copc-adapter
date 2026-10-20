import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { CopcThreeLayer, createThreeStreamingView } from "../../three.ts";

function createBackend({ pointCount = 2 } = {}) {
  const node = {
    key: "0-0-0-0",
    level: 0,
    x: 0,
    y: 0,
    z: 0,
    pointCount,
    pointDataOffset: 100,
    pointDataLength: 20,
  };
  let openCount = 0;
  let destroyCount = 0;
  let hierarchyRequestCount = 0;
  let lastOpenOptions;

  return {
    get openCount() {
      return openCount;
    },
    get destroyCount() {
      return destroyCount;
    },
    get hierarchyRequestCount() {
      return hierarchyRequestCount;
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
            return {
              pointCount,
              bounds: {
                minX: 9.999,
                minY: 19.999,
                minZ: 99,
                maxX: 10.001,
                maxY: 20.001,
                maxZ: 101,
              },
              cube: {
                minX: 9.999,
                minY: 19.999,
                minZ: 99,
                maxX: 10.001,
                maxY: 20.001,
                maxZ: 101,
              },
            };
          },
          getRootHierarchyPage() {
            return { key: node.key, pageOffset: 0, pageLength: 10 };
          },
          async loadHierarchyPage() {
            hierarchyRequestCount += 1;
            return { nodes: [node], pages: [] };
          },
          async loadPointDataView(_node, fields) {
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
          pointCount,
          coordinates: new Float64Array(
            pointCount === 0
              ? []
              : [10.0, 20.0, 100.0, 10.0001, 20.0001, 100.5],
          ),
          attributes: {
            red: new Uint16Array(pointCount === 0 ? [] : [255, 64]),
            green: new Uint16Array(pointCount === 0 ? [] : [0, 128]),
            blue: new Uint16Array(pointCount === 0 ? [] : [0, 255]),
          },
        };
      },
    },
  };
}

function createCamera() {
  const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 2000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function createAttachment(
  scene,
  camera,
  renderer = {
    getDrawingBufferSize(target) {
      return target.set(800, 600);
    },
  },
) {
  return {
    scene,
    camera,
    renderer,
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createLoadedLayer(renderer) {
  const source = createBackend();
  const layer = new CopcThreeLayer({
    url: "memory://three-layer.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    colorMode: "rgb",
    streaming: {
      maxNodes: 1,
      maxDepth: 0,
      maxRenderDistanceMeters: 2000,
      maxRenderedPoints: 10,
    },
  });
  const scene = new THREE.Scene();
  const applicationMesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
  );
  scene.add(applicationMesh);
  const camera = createCamera();
  const attachment = createAttachment(scene, camera, renderer);
  await layer.load();
  layer.attachTo(attachment);
  await layer.update();
  return { layer, source, scene, applicationMesh, camera, attachment };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("loads without a scene, attaches one root, and update is a no-op for an unchanged camera", async () => {
  const { layer, source, scene, applicationMesh, attachment } =
    await createLoadedLayer();

  assert.equal(source.lastOpenOptions.rangeValidation, undefined);
  assert.equal(layer.getSnapshot().lifecycle, "ready");
  assert.equal(scene.children.includes(applicationMesh), true);
  assert.equal(
    scene.children.filter((child) => child === layer.getRoot()).length,
    1,
  );
  assert.equal(layer.getSnapshot().renderedPointCount, 2);
  assert.equal(source.hierarchyRequestCount, 1);

  layer.attachTo(attachment);
  await layer.update();
  assert.equal(
    scene.children.filter((child) => child === layer.getRoot()).length,
    1,
  );
  assert.equal(source.hierarchyRequestCount, 1);
  assert.equal(layer.getSnapshot().streamingUpdateCount, 1);

  layer.destroy();
});

test("Three performs one final same-view selection after motion decays, then stays idle", async () => {
  const { layer, source, camera } = await createLoadedLayer();
  const initialUpdates = layer.getSnapshot().streamingUpdateCount;

  await delay(5);
  camera.lookAt(100, 0, 0);
  camera.updateMatrixWorld(true);
  await layer.update();
  const movingUpdates = layer.getSnapshot().streamingUpdateCount;
  assert.equal(movingUpdates, initialUpdates + 1);
  assert.ok(
    Math.abs(
      layer.getSnapshot().performance
        .motionPredictedHorizontalDisplacementDegrees ?? 0,
    ) > 0,
    JSON.stringify(layer.getSnapshot().performance),
  );

  await delay(850);
  const settled = layer.getSnapshot();
  assert.equal(settled.streamingUpdateCount, movingUpdates + 1);
  assert.equal(
    settled.performance.motionPredictedHorizontalDisplacementDegrees,
    0,
  );
  assert.equal(
    settled.performance.motionPredictedVerticalDisplacementDegrees,
    0,
  );
  assert.equal(source.hierarchyRequestCount, 1);

  await delay(250);
  assert.equal(
    layer.getSnapshot().streamingUpdateCount,
    settled.streamingUpdateCount,
  );
  layer.destroy();
});

test("Three detach clears the pending stationary motion update and camera history", async () => {
  const { layer, camera } = await createLoadedLayer();
  await delay(5);
  camera.lookAt(100, 0, 0);
  camera.updateMatrixWorld(true);
  await layer.update();
  const detachedUpdates = layer.getSnapshot().streamingUpdateCount;

  layer.detachFrom();
  await delay(850);
  assert.equal(layer.getSnapshot().streamingUpdateCount, detachedUpdates);
  assert.equal(layer.getSnapshot().attached, false);
  layer.destroy();
});

test("CopcThreeLayer forwards an explicit strict HTTP validation policy", async () => {
  const source = createBackend();
  const layer = new CopcThreeLayer({
    url: "memory://three-strict-policy.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    rangeValidation: "strict",
  });

  await layer.load();
  assert.equal(source.lastOpenOptions.rangeValidation, "strict");
  layer.destroy();
});

test("Three layer emits typed lifecycle events with the public view generation", async () => {
  const source = createBackend();
  const layer = new CopcThreeLayer({
    url: "memory://three-layer-events.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    streaming: {
      maxNodes: 1,
      maxDepth: 0,
      maxRenderDistanceMeters: 2000,
      maxRenderedPoints: 10,
    },
  });
  const events = [];
  const onProgress = (event) => events.push(event);
  const onMetadata = (event) => events.push(event);
  const onFirstVisible = (event) => events.push(event);
  const onSettled = function (event) {
    assert.equal(this, layer);
    assert.equal(event.target, layer);
    events.push(event);
  };
  layer.addEventListener("progress", onProgress);
  layer.addEventListener("progress", onProgress);
  layer.addEventListener("metadataready", onMetadata);
  layer.addEventListener("firstvisible", onFirstVisible);
  layer.addEventListener("viewsettled", onSettled);

  await layer.load();
  const metadataEvent = events.find((event) => event.type === "metadataready");
  assert.ok(metadataEvent);
  assert.equal(Object.isFrozen(metadataEvent.metadata), true);
  assert.equal(Object.isFrozen(metadataEvent.metadata.bounds), true);
  const scene = new THREE.Scene();
  const camera = createCamera();
  layer.attachTo(createAttachment(scene, camera));
  await layer.update();

  const progress = events.filter((event) => event.type === "progress");
  const firstVisible = events.find((event) => event.type === "firstvisible");
  const settled = events.find((event) => event.type === "viewsettled");
  assert.ok(progress.length > 0);
  assert.ok(firstVisible);
  assert.ok(settled);
  assert.equal(firstVisible.loadGeneration, metadataEvent.loadGeneration);
  assert.equal(firstVisible.viewGeneration, settled.viewGeneration);
  assert.deepEqual(settled.selectedNodeKeys, ["0-0-0-0"]);
  assert.equal(Object.isFrozen(settled.selectedNodeKeys), true);
  assert.ok(
    progress.every((event) => event.viewGeneration === settled.viewGeneration),
  );
  for (let index = 1; index < progress.length; index += 1) {
    assert.notDeepEqual(
      [progress[index].queuedNodeCount, progress[index].activeNodeCount],
      [
        progress[index - 1].queuedNodeCount,
        progress[index - 1].activeNodeCount,
      ],
    );
  }

  layer.removeEventListener("viewsettled", onSettled);
  const settledBefore = events.filter(
    (event) => event.type === "viewsettled",
  ).length;
  camera.position.x += 30;
  camera.updateMatrixWorld(true);
  await layer.update();
  assert.equal(
    events.filter((event) => event.type === "viewsettled").length,
    settledBefore,
  );
  await layer.reload();
  const loadGenerations = events
    .filter((event) => event.type === "metadataready")
    .map((event) => event.loadGeneration);
  assert.equal(loadGenerations.length, 2);
  assert.ok(loadGenerations[1] > loadGenerations[0]);
  layer.removeEventListener("progress", onProgress);
  layer.removeEventListener("metadataready", onMetadata);
  layer.removeEventListener("firstvisible", onFirstVisible);
  layer.destroy();
});

test("destroying Three layer during an event stops remaining listener delivery", async () => {
  const source = createBackend();
  const layer = new CopcThreeLayer({
    url: "memory://three-event-destroy.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  const events = [];
  layer.addEventListener("metadataready", () => {
    events.push("destroy");
    layer.destroy();
  });
  layer.addEventListener("metadataready", () => events.push("late-listener"));

  await layer.load();
  assert.deepEqual(events, ["destroy"]);
});

test("Three detach cancels an active view once and suppresses late generation events", async () => {
  const source = createBackend();
  let releaseDecode;
  let decodeStartedResolve;
  const decodeStarted = new Promise((resolve) => {
    decodeStartedResolve = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseDecode = resolve;
  });
  const decode = source.decoder.decode.bind(source.decoder);
  source.decoder.decode = async (...args) => {
    decodeStartedResolve();
    await gate;
    return decode(...args);
  };
  const layer = new CopcThreeLayer({
    url: "memory://three-cancel-view.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    streaming: { maxNodes: 1, maxDepth: 0, maxRenderDistanceMeters: 2000 },
  });
  const events = [];
  layer.addEventListener("viewcancelled", (event) => events.push(event));
  layer.addEventListener("firstvisible", (event) => events.push(event));
  layer.addEventListener("viewsettled", (event) => events.push(event));
  await layer.load();
  layer.attachTo(createAttachment(new THREE.Scene(), createCamera()));
  const update = layer.update();
  await decodeStarted;
  layer.detachFrom();
  assert.deepEqual(
    events
      .filter((event) => event.type === "viewcancelled")
      .map((event) => event.reason),
    ["detach"],
  );
  releaseDecode();
  await update;
  assert.deepEqual(
    events.map((event) => event.type),
    ["viewcancelled"],
  );
  layer.destroy();
});

test("Three view errors are terminal and do not also settle or cancel", async () => {
  const source = createBackend();
  source.decoder.decode = async () => {
    throw new Error("controlled decode failure");
  };
  const layer = new CopcThreeLayer({
    url: "memory://three-view-failure.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    streaming: { maxNodes: 1, maxDepth: 0, maxRenderDistanceMeters: 2000 },
  });
  const events = [];
  layer.addEventListener("error", (event) => events.push(event));
  layer.addEventListener("viewsettled", (event) => events.push(event));
  layer.addEventListener("viewcancelled", (event) => events.push(event));
  await layer.load();
  layer.attachTo(createAttachment(new THREE.Scene(), createCamera()));
  await assert.rejects(layer.update(), /controlled decode failure/);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].phase, "view");
  assert.ok(Number.isInteger(events[0].viewGeneration));
  layer.destroy();
});

test("Three empty point data never emits firstvisible", async () => {
  const source = createBackend({ pointCount: 0 });
  const layer = new CopcThreeLayer({
    url: "memory://three-empty.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
    streaming: { maxNodes: 1, maxDepth: 0, maxRenderDistanceMeters: 2000 },
  });
  const events = [];
  layer.addEventListener("firstvisible", (event) => events.push(event));
  layer.addEventListener("viewsettled", (event) => events.push(event));
  layer.addEventListener("viewcancelled", (event) => events.push(event));
  layer.detachFrom();
  assert.equal(
    events.length,
    0,
    "an idle detached layer has no view to cancel",
  );
  await layer.load();
  layer.attachTo(createAttachment(new THREE.Scene(), createCamera()));
  await layer.update();
  assert.equal(
    events.some((event) => event.type === "firstvisible"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "viewcancelled"),
    false,
  );
  layer.destroy();
});

test("Three load failures emit a load error with only the load generation", async () => {
  const layer = new CopcThreeLayer({
    url: "memory://three-load-failure.copc.laz",
    backend: {
      async open() {
        throw new Error("controlled source open failure");
      },
    },
  });
  const events = [];
  layer.addEventListener("error", (event) => events.push(event));
  await assert.rejects(
    layer.load(),
    (error) => error.cause?.message === "controlled source open failure",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, "load");
  assert.ok(Number.isInteger(events[0].loadGeneration));
  assert.equal("viewGeneration" in events[0], false);
  layer.destroy();
});

test("DOMException load failures remain readable in immutable error events", async () => {
  const failure = new DOMException("request aborted", "AbortError");
  const layer = new CopcThreeLayer({
    url: "memory://three-dom-exception.copc.laz",
    backend: {
      async open() {
        throw failure;
      },
    },
  });
  const errors = [];
  layer.addEventListener("error", (event) => errors.push(event));
  await assert.rejects(layer.load(), (error) => error.cause === failure);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].error instanceof Error);
  assert.ok(errors[0].error.cause instanceof DOMException);
  assert.equal(errors[0].error.cause.name, "AbortError");
  assert.equal(errors[0].error.cause.message, "request aborted");
  assert.notEqual(errors[0].error.cause, failure);
  assert.equal(Object.isFrozen(errors[0].error), true);
  assert.equal(Object.isFrozen(errors[0].error.cause), true);
  layer.destroy();
});

test("an invalidated Three load does not emit stale metadataready", async () => {
  const source = createBackend();
  const openGate = createDeferred();
  let openStartedResolve;
  const openStarted = new Promise((resolve) => {
    openStartedResolve = resolve;
  });
  const originalOpen = source.backend.open.bind(source.backend);
  source.backend.open = async (url) => {
    openStartedResolve();
    await openGate.promise;
    return originalOpen(url);
  };
  const layer = new CopcThreeLayer({
    url: "memory://three-stale-metadata.copc.laz",
    backend: source.backend,
    decoder: source.decoder,
  });
  const metadataEvents = [];
  layer.addEventListener("metadataready", (event) =>
    metadataEvents.push(event),
  );
  const loadPromise = layer.load();
  await openStarted;
  layer.unload();
  openGate.resolve();
  await loadPromise;
  assert.deepEqual(metadataEvents, []);
  layer.destroy();
});

test("retries an invalidated update when the camera returns to the recorded view", async () => {
  const { layer, camera } = await createLoadedLayer();
  const cancellations = [];
  layer.addEventListener("viewcancelled", (event) => cancellations.push(event));
  const core = layer.controller.core;
  const previousUpdate = core.updateView.bind(core);
  const firstUpdate = createDeferred();
  let updateCallCount = 0;
  core.updateView = async (view, onProgress) => {
    updateCallCount += 1;
    if (updateCallCount === 1) {
      await firstUpdate.promise;
      return undefined;
    }
    return previousUpdate(view, onProgress);
  };

  camera.position.x = 10;
  camera.updateMatrixWorld(true);
  const updatePromise = layer.update();
  assert.equal(updateCallCount, 1);

  camera.position.x = 20;
  camera.updateMatrixWorld(true);
  layer.update();
  camera.position.x = 10;
  camera.updateMatrixWorld(true);
  layer.update();

  firstUpdate.resolve();
  await updatePromise;
  assert.equal(updateCallCount, 2);
  assert.deepEqual(
    cancellations.map(({ reason }) => reason),
    ["camera-change"],
  );
  assert.equal(cancellations[0].viewGeneration, 2);

  layer.destroy();
});

test("uses a perspective camera effective FOV when zoom changes", async () => {
  const { layer, camera, attachment } = await createLoadedLayer();
  const frame = layer.getLocalFrame();
  const unzoomed = createThreeStreamingView({
    camera,
    frame,
    renderer: attachment.renderer,
  });

  camera.zoom = 2;
  camera.updateProjectionMatrix();
  const zoomed = createThreeStreamingView({
    camera,
    frame,
    renderer: attachment.renderer,
  });
  const zoomedFov = zoomed.viewFrustum.verticalFovRadians;
  const expectedFov = THREE.MathUtils.degToRad(camera.getEffectiveFOV());
  assert.ok(Math.abs(zoomedFov - expectedFov) < 1e-12);
  assert.ok(zoomedFov < unzoomed.viewFrustum.verticalFovRadians);

  layer.destroy();
});

test("detach and unload preserve application objects and reload the source", async () => {
  const { layer, source, scene, applicationMesh, attachment } =
    await createLoadedLayer();

  layer.detachFrom();
  assert.equal(scene.children.includes(applicationMesh), true);
  assert.equal(scene.children.includes(layer.getRoot()), false);
  assert.equal(layer.getSnapshot().attached, false);
  assert.equal(layer.getMetadata().pointCount, 2);

  layer.attachTo(attachment);
  await layer.update();
  layer.unload();
  assert.equal(layer.getSnapshot().lifecycle, "mounted");
  assert.equal(layer.getSnapshot().renderedPointCount, 0);

  await layer.reload();
  assert.equal(source.openCount, 2);
  assert.equal(layer.getSnapshot().attached, true);
  await layer.update();
  assert.equal(layer.getSnapshot().renderedPointCount, 2);

  layer.destroy();
  assert.equal(source.destroyCount, 2);
  assert.equal(scene.children.includes(applicationMesh), true);
});

test("ray hits resolve the current node and point index, while unrelated objects are ignored", async () => {
  const { layer, scene, camera } = await createLoadedLayer();
  const picked = layer.pick({ x: 0, y: 0 });

  assert.equal(picked.nodeKey, "0-0-0-0");
  assert.equal(picked.pointIndex, 0);
  assert.equal(picked.source.x, 10);
  assert.deepEqual(picked.rgb, { red: 255, green: 0, blue: 0 });
  assert.deepEqual(layer.getSelectedPoint(), picked);

  const unrelated = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial(),
  );
  const fakeRaycaster = {
    params: { Points: { threshold: 0 } },
    setFromCamera() {},
    intersectObject() {
      return [{ object: unrelated, index: 1 }];
    },
  };
  assert.equal(layer.pick({ x: 0, y: 0 }, fakeRaycaster), undefined);
  assert.equal(layer.getSelectedPoint(), undefined);
  assert.equal(scene.children.includes(layer.getRoot()), true);

  layer.destroy();
  assert.equal(camera.parent, null);
});

test("destroy releases layer resources without disposing the application scene or renderer", async () => {
  let rendererDisposed = 0;
  const applicationRenderer = {
    getDrawingBufferSize(target) {
      return target.set(800, 600);
    },
    dispose() {
      rendererDisposed += 1;
    },
  };
  const { layer, source, scene, applicationMesh } =
    await createLoadedLayer(applicationRenderer);

  layer.destroy();
  assert.equal(rendererDisposed, 0);
  assert.equal(scene.children.includes(applicationMesh), true);
  assert.equal(source.destroyCount, 1);
  assert.equal(layer.getSnapshot().lifecycle, "destroyed");
});
