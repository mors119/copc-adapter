import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GLTFMeshFeaturesExtension,
  GLTFStructuralMetadataExtension,
} from '3d-tiles-renderer/three/plugins';

let renderer;
let tiles;
let animationFrame;
let stopped = false;

function readRenderedPixels(canvas, gl) {
  const width = canvas.width;
  const height = canvas.height;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let nonBlackPixels = 0;
  const colors = new Set();
  const colorPixels = { red: 0, green: 0, blue: 0 };
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    if (red > 20 || green > 20 || blue > 20) {
      nonBlackPixels += 1;
      colors.add(`${Math.round(red / 32)},${Math.round(green / 32)},${Math.round(blue / 32)}`);
      if (red > green * 1.5 && red > blue * 1.5) colorPixels.red += 1;
      if (green > red * 1.5 && green > blue * 1.5) colorPixels.green += 1;
      if (blue > red * 1.5 && blue > green * 1.5) colorPixels.blue += 1;
    }
  }
  return { nonBlackPixels, distinctColorBins: colors.size, colorPixels, width, height };
}

function inspectModel(scene, url) {
  const pointObjects = [];
  scene.traverse((object) => {
    if (object.isPoints && object.geometry?.getAttribute('position')) pointObjects.push(object);
  });
  const points = pointObjects.reduce((sum, object) => sum + object.geometry.getAttribute('position').count, 0);
  const colors = pointObjects.flatMap((object) => {
    const attribute = object.geometry.getAttribute('color');
    if (!attribute) return [];
    return Array.from({ length: Math.min(attribute.count, 3) }, (_, index) => [attribute.getX(index), attribute.getY(index), attribute.getZ(index)]);
  });
  const metadata = scene.userData.structuralMetadata;
  const metadataProperties = metadata?.getPropertyTableInfo?.([0]) ?? [];
  const firstMetadataRow = metadata?.getPropertyTableData?.(0, 0) ?? null;
  const point = pointObjects[0];
  let firstPointWorld = null;
  if (point) {
    scene.updateMatrixWorld(true);
    const position = point.geometry.getAttribute('position');
    firstPointWorld = new THREE.Vector3().fromBufferAttribute(position, 0).applyMatrix4(point.matrixWorld).toArray();
  }
  return {
    url,
    points,
    colors,
    metadataProperties,
    metadataPropertyNames: Object.keys(firstMetadataRow ?? {}),
    firstMetadataRow,
    firstPointWorld,
  };
}

window.startThree = async () => {
  const startedAt = performance.now();
  const canvas = document.getElementById('threeCanvas');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 100_000);
  camera.position.set(6378155, 0, 0);
  camera.up.set(0, 0, 1);
  camera.lookAt(6378135, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  renderer = new THREE.WebGLRenderer({ canvas, alpha: false, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x000000, 1);

  tiles = new TilesRenderer('/fixture/tileset.json');
  tiles.errorTarget = 0.5;
  tiles.group.matrixAutoUpdate = true;
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  const loader = new GLTFLoader(tiles.manager);
  loader.register(() => new GLTFMeshFeaturesExtension());
  loader.register(() => new GLTFStructuralMetadataExtension());
  tiles.manager.addHandler(/\.(gltf|glb)$/i, loader);
  scene.add(tiles.group);

  const models = [];
  const modelLoadMilliseconds = [];
  const settled = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Three renderer loaded ${models.length} of 2 point-cloud tiles.`)), 45_000);
    tiles.addEventListener('load-model', (event) => {
      models.push(inspectModel(event.scene, event.url));
      modelLoadMilliseconds.push(performance.now() - startedAt);
      if (models.length >= 2) {
        clearTimeout(timeout);
        resolve();
      }
    });
    tiles.addEventListener('load-error', (event) => {
      clearTimeout(timeout);
      reject(event.error ?? new Error('Three renderer reported a tile load error.'));
    });
  });

  const renderFrame = () => {
    if (stopped) return;
    camera.updateMatrixWorld();
    tiles.update();
    renderer.render(scene, camera);
    animationFrame = requestAnimationFrame(renderFrame);
  };
  renderFrame();
  await settled;
  const allModelsLoadedAt = performance.now();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  camera.updateMatrixWorld();
  tiles.update();
  renderer.render(scene, camera);
  const firstRenderedFrameAt = performance.now();
  const resources = await (await fetch('/__stats')).json();
  const gl = renderer.getContext();
  return {
    models,
    pointCount: models.reduce((sum, model) => sum + model.points, 0),
    activeTiles: tiles.activeTiles.size,
    resources,
    pixels: readRenderedPixels(canvas, gl),
    modelLoadMilliseconds,
    allModelsLoadMilliseconds: allModelsLoadedAt - startedAt,
    postLoadRenderMilliseconds: firstRenderedFrameAt - allModelsLoadedAt,
  };
};

window.startThreeUrl = async ({ tilesetUrl, originEcef, halfExtents }) => {
  const startedAt = performance.now();
  const canvas = document.getElementById('threeCanvas');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const target = new THREE.Vector3(...originEcef);
  const radial = target.clone().normalize();
  const east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 0, 1), radial).normalize();
  const distance = Math.max(Math.hypot(...halfExtents) * 4, 100);
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 100_000);
  camera.position.copy(target).addScaledVector(radial, distance);
  camera.up.set(0, 0, 1);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  renderer = new THREE.WebGLRenderer({ canvas, alpha: false, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x000000, 1);

  tiles = new TilesRenderer(tilesetUrl);
  tiles.errorTarget = 0.5;
  tiles.group.matrixAutoUpdate = true;
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  const loader = new GLTFLoader(tiles.manager);
  loader.register(() => new GLTFMeshFeaturesExtension());
  loader.register(() => new GLTFStructuralMetadataExtension());
  tiles.manager.addHandler(/\.(gltf|glb)$/i, loader);
  scene.add(tiles.group);

  const models = [];
  const loadError = [];
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Three TilesRenderer did not load real Autzen points.')), 45_000);
    tiles.addEventListener('load-model', (event) => {
      models.push(inspectModel(event.scene, event.url));
      if (models.some((model) => model.points > 0)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    tiles.addEventListener('load-error', (event) => {
      loadError.push(event.error?.message ?? 'Three TilesRenderer load failed.');
      clearTimeout(timeout);
      reject(event.error ?? new Error(loadError.at(-1)));
    });
  });

  const renderFrame = () => {
    if (stopped) return;
    camera.updateMatrixWorld();
    tiles.update();
    renderer.render(scene, camera);
    animationFrame = requestAnimationFrame(renderFrame);
  };
  renderFrame();
  await ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  camera.updateMatrixWorld();
  tiles.update();
  renderer.render(scene, camera);
  const initialPixels = readRenderedPixels(canvas, renderer.getContext());

  const movedPosition = camera.position.clone().addScaledVector(east, distance * 0.2);
  camera.position.copy(movedPosition);
  camera.up.set(0, 0, 1);
  camera.lookAt(target);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  camera.updateMatrixWorld();
  tiles.update();
  renderer.render(scene, camera);
  const movedPixels = readRenderedPixels(canvas, renderer.getContext());
  const resources = await (await fetch('/__stats')).json();
  const pointCount = models.reduce((sum, model) => sum + model.points, 0);
  return {
    models,
    pointCount,
    activeTiles: tiles.activeTiles.size,
    loadError,
    initialPixels,
    movedPixels,
    resources,
    renderMilliseconds: performance.now() - startedAt,
  };
};

window.disposeThree = () => {
  stopped = true;
  if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
  const activeTilesBeforeDispose = tiles?.activeTiles.size ?? 0;
  tiles?.dispose();
  renderer?.dispose();
  return {
    activeTilesBeforeDispose,
    activeTilesAfterDispose: tiles?.activeTiles.size ?? 0,
    groupDetached: tiles?.group.parent === null,
    contextLost: renderer?.getContext().isContextLost() ?? false,
  };
};
