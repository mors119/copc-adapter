import './style.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import { CopcCesiumLayer } from '@mors119/copc-cesium';
import * as Cesium from 'cesium';

const DEFAULT_COPC_URL = '/samples/autzen.copc.laz';
const NEAR_HEIGHT_METERS = 800;
const FAR_HEIGHT_METERS = 100_000;

const elements = {
  viewer: document.querySelector<HTMLElement>('#viewer-status'),
  layer: document.querySelector<HTMLElement>('#layer-status'),
  metadata: document.querySelector<HTMLElement>('#metadata-status'),
  renderedPoints: document.querySelector<HTMLElement>('#rendered-points'),
  selectedNodes: document.querySelector<HTMLElement>('#selected-nodes'),
  loadedNodes: document.querySelector<HTMLElement>('#loaded-nodes'),
  streamingUpdates: document.querySelector<HTMLElement>('#streaming-updates'),
  camera: document.querySelector<HTMLElement>('#camera-position'),
  dataset: document.querySelector<HTMLElement>('#dataset-url'),
  lastError: document.querySelector<HTMLElement>('#last-error'),
  load: document.querySelector<HTMLButtonElement>('#load-copc'),
  unload: document.querySelector<HTMLButtonElement>('#unload-copc'),
  reload: document.querySelector<HTMLButtonElement>('#reload-copc'),
  flyNear: document.querySelector<HTMLButtonElement>('#fly-near'),
  flyFar: document.querySelector<HTMLButtonElement>('#fly-far'),
  resetCamera: document.querySelector<HTMLButtonElement>('#reset-camera'),
};

for (const [name, element] of Object.entries(elements)) {
  if (!element) {
    throw new Error(`Missing required page element: ${name}`);
  }
}

const viewer = new Cesium.Viewer('cesium-container', {
  animation: false,
  baseLayer: false,
  baseLayerPicker: false,
  fullscreenButton: false,
  geocoder: false,
  homeButton: false,
  infoBox: false,
  navigationHelpButton: false,
  sceneModePicker: false,
  selectionIndicator: false,
  timeline: false,
});

let layer: CopcCesiumLayer | undefined;
let operationInProgress = false;
let resetView: Cesium.Cartographic | undefined;
let lastError: string | undefined;

const copcUrl = new URLSearchParams(window.location.search).get('copc')
  ?? DEFAULT_COPC_URL;

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function reportError(context: string, error: unknown): void {
  lastError = `${context}: ${describeError(error)}`;
  console.error(lastError, error);
  updateDiagnostics();
}

function getCameraPosition(): Cesium.Cartographic {
  return Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
}

function setCameraHeight(height: number): void {
  const current = getCameraPosition();

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromRadians(
      current.longitude,
      current.latitude,
      height,
    ),
    duration: 0.8,
  });
}

function updateDiagnostics(): void {
  const snapshot = layer?.getSnapshot();
  const metadata = layer?.getMetadata();
  const camera = getCameraPosition();

  elements.viewer!.textContent = viewer.isDestroyed() ? 'destroyed' : 'ready';
  elements.layer!.textContent = snapshot
    ? `${snapshot.lifecycle}${snapshot.attached ? ', attached' : ', detached'}`
    : 'not created';
  elements.metadata!.textContent = metadata
    ? `loaded — ${metadata.pointCount.toLocaleString()} points`
    : 'not loaded';
  elements.renderedPoints!.textContent = (snapshot?.renderedPointCount ?? 0).toLocaleString();
  elements.selectedNodes!.textContent = String(snapshot?.selectedNodeKeys.length ?? 0);
  elements.loadedNodes!.textContent = String(snapshot?.renderedNodeKeys.length ?? 0);
  elements.streamingUpdates!.textContent = String(snapshot?.streamingUpdateCount ?? 0);
  elements.camera!.textContent = [
    `${Cesium.Math.toDegrees(camera.longitude).toFixed(5)}°`,
    `${Cesium.Math.toDegrees(camera.latitude).toFixed(5)}°`,
    `${camera.height.toFixed(0)} m`,
  ].join(', ');
  elements.dataset!.textContent = copcUrl;
  elements.lastError!.textContent = lastError ?? 'none';

  elements.load!.disabled = operationInProgress || snapshot?.lifecycle === 'ready';
  elements.unload!.disabled = operationInProgress || !layer || !metadata;
  elements.reload!.disabled = operationInProgress || !layer;
  elements.flyNear!.disabled = operationInProgress || !metadata;
  elements.flyFar!.disabled = operationInProgress || !metadata;
  elements.resetCamera!.disabled = operationInProgress || !resetView;
}

async function runOperation(
  name: string,
  operation: () => Promise<void> | void,
): Promise<void> {
  if (operationInProgress) {
    return;
  }

  operationInProgress = true;
  lastError = undefined;
  updateDiagnostics();

  try {
    await operation();
  } catch (error) {
    reportError(name, error);
  } finally {
    operationInProgress = false;
    updateDiagnostics();
  }
}

async function loadLayer(): Promise<void> {
  if (!layer) {
    layer = new CopcCesiumLayer({
      url: copcUrl,
      pointSize: 2,
      debug: true,
    });
    layer.attachTo(viewer);
  }

  await layer.load();
  resetView = Cesium.Cartographic.clone(getCameraPosition());
  console.info('COPC metadata:', layer.getMetadata());
  console.info('COPC layer snapshot:', layer.getSnapshot());
}

elements.load!.addEventListener('click', () => {
  void runOperation('COPC load failed', loadLayer);
});

elements.unload!.addEventListener('click', () => {
  void runOperation('COPC unload failed', () => {
    layer?.unload();
  });
});

elements.reload!.addEventListener('click', () => {
  void runOperation('COPC reload failed', async () => {
    if (!layer) {
      await loadLayer();
      return;
    }

    await layer.reload();
    resetView = Cesium.Cartographic.clone(getCameraPosition());
  });
});

elements.flyNear!.addEventListener('click', () => setCameraHeight(NEAR_HEIGHT_METERS));
elements.flyFar!.addEventListener('click', () => setCameraHeight(FAR_HEIGHT_METERS));
elements.resetCamera!.addEventListener('click', () => {
  if (!resetView) {
    return;
  }

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromRadians(
      resetView.longitude,
      resetView.latitude,
      resetView.height,
    ),
    duration: 0.8,
  });
});

window.addEventListener('error', (event) => {
  reportError('Browser error', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  reportError('Unhandled promise rejection', event.reason);
});
viewer.scene.renderError.addEventListener((_scene, error) => {
  reportError('Cesium rendering failed', error);
});
window.addEventListener('beforeunload', () => {
  layer?.destroy();
  viewer.destroy();
});

setInterval(updateDiagnostics, 250);
updateDiagnostics();
void runOperation('Initial COPC load failed', loadLayer);
