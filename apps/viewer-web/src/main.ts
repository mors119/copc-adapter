import './style.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import * as Cesium from 'cesium';
import { CopcCesiumLayer } from './index';
import { createCesiumViewer } from './cesium/viewer/createViewer';

const COPC_URL = '/samples/autzen.copc.laz';

type CopcDebugState = {
  viewerReady: boolean;
  layerLoaded: boolean;
  metadataPointCount?: number;
  renderedPointCount: number;
  scenePointCollectionCount: number;
  renderedNodeKeys: string[];
  selectedNodeKeys: string[];
  streamingUpdateCount: number;
  cameraMoveEventCount: number;
  lastError?: string;
};

type CopcDebugAdapter = {
  getState(): CopcDebugState;
  setCameraHeight(height: number): void;
  recordError(error: unknown): void;
};

declare global {
  interface Window {
    __COPC_DEBUG__?: CopcDebugAdapter;
  }
}

function installDebugAdapter(
  viewer: Cesium.Viewer,
  layer: CopcCesiumLayer,
): CopcDebugAdapter {
  let cameraMoveEventCount = 0;
  let lastError: string | undefined;

  viewer.camera.moveEnd.addEventListener(() => {
    cameraMoveEventCount += 1;
  });

  const recordError = (error: unknown): void => {
    lastError = error instanceof Error ? error.message : String(error);
  };

  window.addEventListener('error', (event) => {
    recordError(event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    recordError(event.reason);
  });

  const adapter: CopcDebugAdapter = {
    getState(): CopcDebugState {
      const snapshot = layer.getSnapshot();

      return {
        viewerReady: !viewer.isDestroyed(),
        layerLoaded: snapshot.lifecycle === 'ready',
        metadataPointCount: layer.getMetadata()?.pointCount,
        renderedPointCount: snapshot.renderedPointCount,
        scenePointCollectionCount: getScenePointCollectionCount(viewer),
        renderedNodeKeys: snapshot.renderedNodeKeys,
        selectedNodeKeys: snapshot.selectedNodeKeys,
        streamingUpdateCount: snapshot.streamingUpdateCount,
        cameraMoveEventCount,
        lastError,
      };
    },
    setCameraHeight(height: number): void {
      const position = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);

      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromRadians(
          position.longitude,
          position.latitude,
          height,
        ),
      });
      viewer.camera.moveEnd.raiseEvent();
    },
    recordError,
  };

  window.__COPC_DEBUG__ = adapter;

  return adapter;
}

function getScenePointCollectionCount(viewer: Cesium.Viewer): number {
  let count = 0;

  for (let index = 0; index < viewer.scene.primitives.length; index += 1) {
    if (viewer.scene.primitives.get(index) instanceof Cesium.PointPrimitiveCollection) {
      count += 1;
    }
  }

  return count;
}

async function main(): Promise<void> {
  const viewer = createCesiumViewer('cesium-container');
  const layer = new CopcCesiumLayer({
    url: COPC_URL,
    debug: true,
  });
  const debugAdapter = import.meta.env.DEV
    ? installDebugAdapter(viewer, layer)
    : undefined;

  try {
    await layer.load();
    layer.attachTo(viewer);

    console.log('COPC Metadata:', layer.getMetadata());
    console.log('COPC Layer Snapshot:', layer.getSnapshot());
  } catch (error) {
    debugAdapter?.recordError(error);
    throw error;
  }
}

main().catch((error) => {
  console.error('Failed to load COPC:', error);
});
