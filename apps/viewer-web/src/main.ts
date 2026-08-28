import './style.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import * as Cesium from 'cesium';
import { CopcCesiumLayer, type CopcBackendName } from './index';
import { createCesiumViewer } from './cesium/viewer/createViewer';
import { createCopcDebugPanel } from './debug/CopcDebugPanel';
import { runSyntheticRendererPerformanceBenchmark } from './cesium/render/rendererPerformanceBenchmark';

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
  cameraPitchDegrees: number;
  minRenderedHeight?: number;
  maxRenderedHeight?: number;
  renderedColorCount: number;
  lastError?: string;
  backend: CopcBackendName | 'custom';
  performance: ReturnType<CopcCesiumLayer['getSnapshot']>['performance'];
  longestMainThreadTaskMs: number;
  cesiumFrameDurationMs: number;
};

function isDebugPanelEnabled(): boolean {
  const value = new URLSearchParams(window.location.search).get('debugPanel');

  return value === null || !['0', 'false', 'off'].includes(value.toLowerCase());
}

type CopcDebugAdapter = {
  getState(): CopcDebugState;
  getLastError(): string | undefined;
  setCameraHeight(height: number): void;
  setCameraPitch(pitchDegrees: number): void;
  recordError(error: unknown): void;
  runSyntheticRendererPerformanceBenchmark(): ReturnType<typeof runSyntheticRendererPerformanceBenchmark>;
};

function getRenderedPointDiagnostics(viewer: Cesium.Viewer): {
  minRenderedHeight?: number;
  maxRenderedHeight?: number;
  renderedColorCount: number;
} {
  let minRenderedHeight = Number.POSITIVE_INFINITY;
  let maxRenderedHeight = Number.NEGATIVE_INFINITY;
  const colors = new Set<string>();

  for (let collectionIndex = 0;
    collectionIndex < viewer.scene.primitives.length;
    collectionIndex += 1) {
    const collection = viewer.scene.primitives.get(collectionIndex);

    if (!(collection instanceof Cesium.PointPrimitiveCollection)) {
      continue;
    }

    const stride = Math.max(1, Math.floor(collection.length / 256));

    for (let pointIndex = 0; pointIndex < collection.length; pointIndex += stride) {
      const point = collection.get(pointIndex);
      const height = Cesium.Cartographic.fromCartesian(point.position).height;

      minRenderedHeight = Math.min(minRenderedHeight, height);
      maxRenderedHeight = Math.max(maxRenderedHeight, height);
      colors.add([
        point.color.red.toFixed(3),
        point.color.green.toFixed(3),
        point.color.blue.toFixed(3),
      ].join(','));
    }
  }

  return {
    minRenderedHeight: Number.isFinite(minRenderedHeight)
      ? minRenderedHeight
      : undefined,
    maxRenderedHeight: Number.isFinite(maxRenderedHeight)
      ? maxRenderedHeight
      : undefined,
    renderedColorCount: colors.size,
  };
}

declare global {
  interface Window {
    __COPC_DEBUG__?: CopcDebugAdapter;
  }
}

function installDebugAdapter(
  viewer: Cesium.Viewer,
  layer: CopcCesiumLayer,
  exposeGlobally: boolean,
): CopcDebugAdapter {
  let cameraMoveEventCount = 0;
  let lastError: string | undefined;
  let longestMainThreadTaskMs = 0;
  let cesiumFrameDurationMs = 0;
  let cesiumFrameStartedAt = 0;

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longestMainThreadTaskMs = Math.max(longestMainThreadTaskMs, entry.duration);
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      // Long Task API is optional in browsers and test environments.
    }
  }

  viewer.scene.preRender.addEventListener(() => {
    cesiumFrameStartedAt = performance.now();
  });
  viewer.scene.postRender.addEventListener(() => {
    if (cesiumFrameStartedAt > 0) {
      cesiumFrameDurationMs = performance.now() - cesiumFrameStartedAt;
    }
  });

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
      const pointDiagnostics = getRenderedPointDiagnostics(viewer);

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
        cameraPitchDegrees: Cesium.Math.toDegrees(viewer.camera.pitch),
        ...pointDiagnostics,
        backend: snapshot.backend,
        performance: snapshot.performance,
        longestMainThreadTaskMs,
        cesiumFrameDurationMs,
        lastError,
      };
    },
    getLastError(): string | undefined {
      return lastError;
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
    setCameraPitch(pitchDegrees: number): void {
      viewer.camera.setView({
        orientation: {
          heading: viewer.camera.heading,
          pitch: Cesium.Math.toRadians(pitchDegrees),
          roll: viewer.camera.roll,
        },
      });
      viewer.camera.moveEnd.raiseEvent();
    },
    recordError,
    runSyntheticRendererPerformanceBenchmark: () => runSyntheticRendererPerformanceBenchmark({
      viewer,
      pointCounts: [10_000, 50_000, 100_000],
      repetitions: 5,
      warmups: 2,
    }),
  };

  if (exposeGlobally) {
    window.__COPC_DEBUG__ = adapter;
  }

  return adapter;
}

function getSelectedBackend(): CopcBackendName {
  return new URLSearchParams(window.location.search).get('backend') === 'rust'
    ? 'rust'
    : 'copc-js';
}

function getLayerOptions(): ConstructorParameters<typeof CopcCesiumLayer>[0] {
  const params = new URLSearchParams(window.location.search);

  if (params.get('scenario') === 'issue61') {
    return {
      url: COPC_URL,
      colorMode: 'elevation',
      backend: params.get('backend') === 'copc-js' ? 'copc-js' : 'rust',
      pointSize: 2,
      debug: true,
      streaming: {
        maxNodes: 32,
        maxDepth: 6,
        maxScreenSpaceError: 8,
        maxRenderDistanceMeters: 20_000,
      },
    };
  }

  return {
    url: COPC_URL,
    colorMode: 'rgb',
    backend: getSelectedBackend(),
    debug: true,
  };
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
  const layer = new CopcCesiumLayer(getLayerOptions());
  const debugAdapter = installDebugAdapter(viewer, layer, import.meta.env.DEV);
  const debugPanel = isDebugPanelEnabled()
    ? createCopcDebugPanel(() => ({
        snapshot: layer.getSnapshot(),
        metadata: layer.getMetadata(),
        lastError: debugAdapter.getLastError(),
      }))
    : undefined;

  window.addEventListener('pagehide', () => debugPanel?.destroy(), { once: true });

  try {
    await layer.load();
    layer.attachTo(viewer);

    console.log('COPC Metadata:', layer.getMetadata());
    console.log('COPC Layer Snapshot:', layer.getSnapshot());
  } catch (error) {
    debugAdapter.recordError(error);
    throw error;
  }
}

main().catch((error) => {
  console.error('Failed to load COPC:', error);
});
