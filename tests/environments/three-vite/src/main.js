import * as THREE from "three";
import {
  CopcThreeLayer,
  RustCrsTransformer,
} from "@frillab/copc-adapter/three";

if (typeof RustCrsTransformer !== "function") {
  throw new Error("Packed Three consumer cannot import RustCrsTransformer");
}

const container = document.querySelector("#three-container");
if (!container) throw new Error("Packed Three consumer container is missing");
// Keep SwiftShader's software framebuffer modest on hosted Chromium runners.
const rendererWidth = 640;
const rendererHeight = 360;
container.style.width = `${rendererWidth}px`;
container.style.height = `${rendererHeight}px`;

const scene = new THREE.Scene();
scene.background = new THREE.Color("#08111d");
const camera = new THREE.PerspectiveCamera(
  45,
  rendererWidth / rendererHeight,
  0.1,
  250_000,
);
camera.up.set(0, 0, 1);
camera.position.set(0, -1_500, 570);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld(true);

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(rendererWidth, rendererHeight);
container.appendChild(renderer.domElement);
const rendererContextLossEvents = [];
renderer.domElement.addEventListener("webglcontextlost", (event) => {
  rendererContextLossEvents.push(event.statusMessage || "WebGL context lost");
});

const applicationGeometry = new THREE.BoxGeometry(1, 1, 1);
const applicationMaterial = new THREE.MeshBasicMaterial({ color: 0xff00ff });
let applicationMaterialDisposed = false;
applicationMaterial.addEventListener(
  "dispose",
  () => (applicationMaterialDisposed = true),
);
const applicationObject = new THREE.Mesh(
  applicationGeometry,
  applicationMaterial,
);
applicationObject.position.set(100_000, 100_000, 100_000);
scene.add(applicationObject);

const layer = new CopcThreeLayer({
  url: "/samples/autzen.copc.laz",
  backend: "rust",
  coordinateCacheLayout: "E",
  maxRenderedPoints: 250_000,
  maxPointCacheBytes: 256 * 1024 * 1024,
  maxConcurrentRangeRequests: 4,
  streaming: {
    maxNodes: 32,
    maxDepth: 6,
    maxScreenSpaceError: 8,
    maxRenderDistanceMeters: 20_000,
    motionLookahead: true,
  },
});
const errors = [];
layer.addEventListener("error", (event) => {
  errors.push(event.error instanceof Error ? event.error.message : String(event.error));
});

let animationFrame = 0;
let rendering = true;
const render = () => {
  if (!rendering) return;
  renderer.render(scene, camera);
  animationFrame = requestAnimationFrame(render);
};
animationFrame = requestAnimationFrame(render);

let started = false;
const start = async () => {
  if (started) return;
  started = true;
  await layer.load();
  layer.attachTo({ scene, camera, renderer });
  await layer.update();
};

function getState() {
  const snapshot = layer.getSnapshot();
  let pointObjectCount = 0;
  let positionBufferBytes = 0;
  scene.traverse((object) => {
    if (!(object instanceof THREE.Points)) return;
    pointObjectCount += 1;
    positionBufferBytes += object.geometry.getAttribute("position").array.byteLength;
  });
  return {
    snapshot,
    pointObjectCount,
    positionBufferBytes,
    sceneChildCount: scene.children.length,
    rendererGeometryCount: renderer.info.memory.geometries,
    contextLost: renderer.getContext().isContextLost(),
    errors: [...errors],
  };
}

function pickVisiblePoint() {
  camera.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);
  const projected = new THREE.Vector3();
  let candidate;
  scene.traverse((object) => {
    if (candidate || !(object instanceof THREE.Points) || !object.visible) return;
    const positions = object.geometry.getAttribute("position");
    object.updateWorldMatrix(true, false);
    for (let vertexIndex = 0; vertexIndex < positions.count; vertexIndex += 1) {
      projected
        .fromBufferAttribute(positions, vertexIndex)
        .applyMatrix4(object.matrixWorld)
        .project(camera);
      if (
        projected.x >= -0.9 &&
        projected.x <= 0.9 &&
        projected.y >= -0.9 &&
        projected.y <= 0.9 &&
        projected.z >= -1 &&
        projected.z <= 1
      ) {
        candidate = { x: projected.x, y: projected.y };
        break;
      }
    }
  });
  if (!candidate) return undefined;
  const inspection = layer.pick(candidate, { threshold: 2 });
  return inspection ? { candidate, inspection } : undefined;
}

function destroyLayer() {
  rendering = false;
  cancelAnimationFrame(animationFrame);
  const rendererContextLostBeforeDestroy = renderer.getContext().isContextLost();
  layer.destroy();
  const rendererContextLostAfterLayerDestroy = renderer.getContext().isContextLost();
  // The caller still owns these objects and its render loop.
  renderer.render(scene, camera);
  return {
    snapshot: layer.getSnapshot(),
    sceneChildCount: scene.children.length,
    applicationObjectPreserved: scene.children.includes(applicationObject),
    applicationMaterialDisposed,
    rendererCanvasConnected: renderer.domElement.isConnected,
    rendererContextLostBeforeDestroy,
    rendererContextLostAfterLayerDestroy,
    rendererContextLost: renderer.getContext().isContextLost(),
    rendererContextLossEvents: [...rendererContextLossEvents],
    errors: [...errors],
  };
}

window.__PACKED_THREE_CONSUMER__ = {
  threeVersion: THREE.REVISION,
  camera,
  scene,
  layer,
  renderer,
  start,
  getState,
  pickVisiblePoint,
  destroyLayer,
};
