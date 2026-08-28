import './style.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import * as Cesium from 'cesium';
import {
  CopcCesiumLayer,
  RustCopcBackend,
} from '@frillab/copc-adapter';

const datasetUrl = '/samples/autzen.copc.laz';
const params = new URLSearchParams(window.location.search);
const backend = params.get('backend') === 'copc-js' ? 'copc-js' : 'rust';
const colorMode = params.get('mode') ?? 'rgb';

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
const layer = new CopcCesiumLayer({
  url: datasetUrl,
  backend,
  colorMode,
  pointSize: 2,
  debug: true,
  streaming: {
    maxNodes: 32,
    maxDepth: 6,
    maxScreenSpaceError: 8,
    maxRenderDistanceMeters: 20_000,
  },
});

let lastError;
let cameraMoveEventCount = 0;
viewer.camera.moveEnd.addEventListener(() => {
  cameraMoveEventCount += 1;
});

function reportError(error) {
  lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(lastError, error);
}

function renderedDiagnostics() {
  let renderedPointCount = 0;
  let minRenderedHeight = Number.POSITIVE_INFINITY;
  let maxRenderedHeight = Number.NEGATIVE_INFINITY;
  const colors = new Set();
  let firstPosition;

  for (let collectionIndex = 0; collectionIndex < viewer.scene.primitives.length; collectionIndex += 1) {
    const collection = viewer.scene.primitives.get(collectionIndex);
    if (!(collection instanceof Cesium.PointPrimitiveCollection)) {
      continue;
    }

    renderedPointCount += collection.length;
    const stride = Math.max(1, Math.floor(collection.length / 256));
    for (let pointIndex = 0; pointIndex < collection.length; pointIndex += stride) {
      const point = collection.get(pointIndex);
      const cartographic = Cesium.Cartographic.fromCartesian(point.position);
      firstPosition ??= {
        longitude: Cesium.Math.toDegrees(cartographic.longitude),
        latitude: Cesium.Math.toDegrees(cartographic.latitude),
        height: cartographic.height,
      };
      minRenderedHeight = Math.min(minRenderedHeight, cartographic.height);
      maxRenderedHeight = Math.max(maxRenderedHeight, cartographic.height);
      colors.add([
        point.color.red.toFixed(3),
        point.color.green.toFixed(3),
        point.color.blue.toFixed(3),
      ].join(','));
    }
  }

  return {
    renderedPointCount,
    minRenderedHeight: Number.isFinite(minRenderedHeight) ? minRenderedHeight : undefined,
    maxRenderedHeight: Number.isFinite(maxRenderedHeight) ? maxRenderedHeight : undefined,
    renderedColorCount: colors.size,
    firstPosition,
  };
}

function getState() {
  const snapshot = layer.getSnapshot();
  const metadata = layer.getMetadata();
  const diagnostics = renderedDiagnostics();
  const cameraPosition = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
  return {
    viewerCreatedByConsumer: true,
    viewerAlive: !viewer.isDestroyed(),
    layerAttachedToCallerViewer: snapshot.attached,
    lifecycle: snapshot.lifecycle,
    backend: snapshot.backend,
    colorMode,
    datasetUrl: snapshot.datasetUrl,
    metadata,
    hierarchy: layer.getHierarchyDiagnostics(),
    selectedNodeKeys: snapshot.selectedNodeKeys,
    renderedNodeKeys: snapshot.renderedNodeKeys,
    streamingUpdateCount: snapshot.streamingUpdateCount,
    cameraMoveEventCount,
    cameraPosition: {
      longitude: Cesium.Math.toDegrees(cameraPosition.longitude),
      latitude: Cesium.Math.toDegrees(cameraPosition.latitude),
      height: cameraPosition.height,
    },
    performance: snapshot.performance,
    lastError,
    ...diagnostics,
  };
}

async function probeRustAttributes() {
  const source = await new RustCopcBackend().open(datasetUrl);
  try {
    const rootPage = await source.loadHierarchyPage(source.getRootHierarchyPage());
    const rootNode = rootPage.nodes.find((node) => node.key === '0-0-0-0') ?? rootPage.nodes[0];
    const view = await source.loadPointDataView(
      rootNode,
      new Set(['position', 'intensity', 'classification', 'rgb']),
    );
    const sample = {};
    for (const component of ['x', 'y', 'z', 'intensity', 'classification', 'red', 'green', 'blue']) {
      if (component === 'x' || component === 'y' || component === 'z'
        || view.availableFields.has(component === 'intensity'
          ? 'intensity'
          : component === 'classification' ? 'classification' : 'rgb')) {
        sample[component] = view.getter(component)(0);
      }
    }
    return {
      pointCount: view.pointCount,
      availableFields: [...view.availableFields].sort(),
      sample,
    };
  } finally {
    source.destroy?.();
  }
}

window.__PACKED_CONSUMER__ = {
  getState,
  probeRustAttributes,
  setCameraHeight(height) {
    const current = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromRadians(current.longitude, current.latitude, height),
    });
    viewer.camera.moveEnd.raiseEvent();
  },
  setCameraOrientation(headingDegrees, pitchDegrees) {
    viewer.camera.setView({
      orientation: {
        heading: Cesium.Math.toRadians(headingDegrees),
        pitch: Cesium.Math.toRadians(pitchDegrees),
        roll: viewer.camera.roll,
      },
    });
    viewer.camera.moveEnd.raiseEvent();
  },
};

window.addEventListener('error', (event) => reportError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => reportError(event.reason));
viewer.scene.renderError.addEventListener((_scene, error) => reportError(error));

try {
  await layer.load();
  layer.attachTo(viewer);
} catch (error) {
  reportError(error);
  throw error;
}
