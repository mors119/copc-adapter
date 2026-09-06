import * as THREE from 'three';
import {
  CopcStreamingCore,
  createPerspectiveViewFrustum,
} from '@frillab/copc-adapter/three';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(0, 0, 10);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();

// This is the public-boundary placeholder used before the concrete Three
// facade lands. It proves a normal Three app can load the renderer-neutral
// entry without importing the Cesium root entry.
const streamingCore = new CopcStreamingCore({
  url: '/samples/autzen.copc.laz',
});
const frustum = createPerspectiveViewFrustum({
  position: { x: 0, y: 0, z: 10 },
  direction: { x: 0, y: 0, z: -1 },
  up: { x: 0, y: 1, z: 0 },
  verticalFovRadians: THREE.MathUtils.degToRad(camera.fov),
  aspectRatio: camera.aspect,
  viewportHeightPixels: 1,
  nearMeters: camera.near,
  farMeters: camera.far,
});

window.__PACKED_THREE_CONSUMER__ = {
  cameraType: camera.type,
  scene,
  streamingCore,
  hasFrustum: Boolean(frustum),
};
