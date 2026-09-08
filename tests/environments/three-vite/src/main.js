import * as THREE from 'three';
import {
  CopcThreeLayer,
  RustCrsTransformer,
} from '@frillab/copc-adapter/three';

if (typeof RustCrsTransformer !== 'function') {
  throw new Error('Packed Three consumer cannot import RustCrsTransformer');
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(0, 0, 10);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();

// A normal Three app owns the scene, camera, renderer, and render loop. The
// adapter contributes only its root group and explicitly driven updates.
const layer = new CopcThreeLayer({
  url: '/samples/autzen.copc.laz',
});
layer.attachTo({ scene, camera });

window.__PACKED_THREE_CONSUMER__ = {
  cameraType: camera.type,
  scene,
  layer,
};
