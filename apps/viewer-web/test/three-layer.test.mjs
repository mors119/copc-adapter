import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  CopcThreeLayer,
} from '../src/three.ts';

function createBackend() {
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
  let hierarchyRequestCount = 0;

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
    backend: {
      async open(source) {
        openCount += 1;
        return {
          source,
          getMetadata() {
            return {
              pointCount: 2,
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
          pointCount: 2,
          coordinates: new Float64Array([
            10.0, 20.0, 100.0,
            10.0001, 20.0001, 100.5,
          ]),
          attributes: {
            red: new Uint16Array([255, 64]),
            green: new Uint16Array([0, 128]),
            blue: new Uint16Array([0, 255]),
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

function createAttachment(scene, camera, renderer = {
  getDrawingBufferSize(target) {
    return target.set(800, 600);
  },
}) {
  return {
    scene,
    camera,
    renderer,
  };
}

async function createLoadedLayer(renderer) {
  const source = createBackend();
  const layer = new CopcThreeLayer({
    url: 'memory://three-layer.copc.laz',
    backend: source.backend,
    decoder: source.decoder,
    colorMode: 'rgb',
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

test('loads without a scene, attaches one root, and update is a no-op for an unchanged camera', async () => {
  const { layer, source, scene, applicationMesh, attachment } = await createLoadedLayer();

  assert.equal(layer.getSnapshot().lifecycle, 'ready');
  assert.equal(scene.children.includes(applicationMesh), true);
  assert.equal(scene.children.filter((child) => child === layer.getRoot()).length, 1);
  assert.equal(layer.getSnapshot().renderedPointCount, 2);
  assert.equal(source.hierarchyRequestCount, 1);

  layer.attachTo(attachment);
  await layer.update();
  assert.equal(scene.children.filter((child) => child === layer.getRoot()).length, 1);
  assert.equal(source.hierarchyRequestCount, 1);
  assert.equal(layer.getSnapshot().streamingUpdateCount, 1);

  layer.destroy();
});

test('detach and unload preserve application objects and reload the source', async () => {
  const { layer, source, scene, applicationMesh, attachment } = await createLoadedLayer();

  layer.detachFrom();
  assert.equal(scene.children.includes(applicationMesh), true);
  assert.equal(scene.children.includes(layer.getRoot()), false);
  assert.equal(layer.getSnapshot().attached, false);
  assert.equal(layer.getMetadata().pointCount, 2);

  layer.attachTo(attachment);
  await layer.update();
  layer.unload();
  assert.equal(layer.getSnapshot().lifecycle, 'mounted');
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

test('ray hits resolve the current node and point index, while unrelated objects are ignored', async () => {
  const { layer, scene, camera } = await createLoadedLayer();
  const picked = layer.pick({ x: 0, y: 0 });

  assert.equal(picked.nodeKey, '0-0-0-0');
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

test('destroy releases layer resources without disposing the application scene or renderer', async () => {
  let rendererDisposed = 0;
  const applicationRenderer = {
    getDrawingBufferSize(target) {
      return target.set(800, 600);
    },
    dispose() {
      rendererDisposed += 1;
    },
  };
  const { layer, source, scene, applicationMesh } = await createLoadedLayer(applicationRenderer);

  layer.destroy();
  assert.equal(rendererDisposed, 0);
  assert.equal(scene.children.includes(applicationMesh), true);
  assert.equal(source.destroyCount, 1);
  assert.equal(layer.getSnapshot().lifecycle, 'destroyed');
});
