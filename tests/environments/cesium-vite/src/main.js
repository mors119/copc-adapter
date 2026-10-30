import "./style.css";
import "cesium/Build/Cesium/Widgets/widgets.css";
import * as Cesium from "cesium";
import { createTerrainAlignmentFixture } from "./terrainAlignmentFixture.js";
import {
  CopcCesiumLayer,
  BatchedGeometryPointRenderer,
  CopcJsBackend,
  RustCopcBackend,
  RustCrsTransformer,
} from "@packed-adapter";

const params = new URLSearchParams(window.location.search);
const terrainAlignmentFixtureEnabled =
  params.get("terrainAlignmentFixture") === "1";
const terrainFixture = terrainAlignmentFixtureEnabled
  ? createTerrainAlignmentFixture(250)
  : undefined;
const datasetUrl =
  terrainFixture?.sourceUrl ?? "/samples/autzen.copc.laz";
const backend = params.get("backend") === "copc-js" ? "copc-js" : "rust";
const colorMode = params.get("mode") ?? "rgb";
const attributeLoading =
  params.get("attributeLoading") === "required" ? "required" : "all";
const pointSizeMode =
  params.get("pointSizeMode") === "attenuated" ? "attenuated" : "fixed";
const maxRenderDistanceMeters =
  Number(params.get("maxRenderDistanceMeters")) || 20_000;
const renderer =
  params.get("renderer") === "batched"
    ? new BatchedGeometryPointRenderer()
    : undefined;

const terrainFixtureProvider = terrainFixture?.terrainProvider;

const viewer = new Cesium.Viewer("cesium-container", {
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
  ...(terrainFixtureProvider
    ? { terrainProvider: terrainFixtureProvider }
    : {}),
});
const layer = new CopcCesiumLayer({
  url: datasetUrl,
  ...(renderer ? { renderer } : {}),
  backend: terrainFixture?.backend ?? backend,
  ...(terrainFixture ? { decoder: terrainFixture.decoder } : {}),
  colorMode,
  attributeLoading,
  pointSizeMode,
  minPointSize: 1,
  maxPointSize: 8,
  pointSize: 2,
  debug: true,
  streaming: {
    maxNodes: 32,
    maxDepth: 6,
    maxScreenSpaceError: 8,
    maxRenderDistanceMeters,
    motionLookahead: true,
  },
});

let lastError;
let lastErrorStack;
let lastTerrainEstimate;
let lastTerrainBatchEstimate;
let cameraMoveEventCount = 0;
let cameraChangeCount = 0;
let lastWheelInputAt;
let responsivenessCaptureStartedAt = 0;
let longestMainThreadTaskMs = 0;
const mainThreadTasks = [];
const cameraChangeSamples = [];
const wheelInputSamples = [];
const cesiumFrameSamples = [];
let cesiumFrameStartedAt = 0;
viewer.camera.moveEnd.addEventListener(() => {
  cameraMoveEventCount += 1;
});
viewer.camera.changed.addEventListener(() => {
  cameraChangeCount += 1;
  cameraChangeSamples.push({
    at: performance.now(),
    lastWheelInputAt,
    worker: layer.getSnapshot().worker,
  });
});
viewer.scene.preRender.addEventListener(() => {
  cesiumFrameStartedAt = performance.now();
});
viewer.scene.postRender.addEventListener(() => {
  if (cesiumFrameStartedAt <= 0) return;
  cesiumFrameSamples.push({
    at: performance.now(),
    durationMs: performance.now() - cesiumFrameStartedAt,
  });
  if (cesiumFrameSamples.length > 2000) cesiumFrameSamples.shift();
});
window.addEventListener(
  "wheel",
  () => {
    lastWheelInputAt = performance.now();
    wheelInputSamples.push({
      at: lastWheelInputAt,
      worker: layer.getSnapshot().worker,
    });
  },
  { capture: true },
);
if (typeof PerformanceObserver !== "undefined") {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const sample = { at: entry.startTime, durationMs: entry.duration };
        mainThreadTasks.push(sample);
        longestMainThreadTaskMs = Math.max(
          longestMainThreadTaskMs,
          entry.duration,
        );
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // The Long Task API is optional in browser and test environments.
  }
}

function reportError(error) {
  lastError =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  lastErrorStack = error instanceof Error ? error.stack : undefined;
  console.error(lastError, error);
}

function* getPointPrimitiveCollections(collection) {
  for (let index = 0; index < collection.length; index += 1) {
    const primitive = collection.get(index);
    if (primitive instanceof Cesium.PointPrimitiveCollection) {
      yield primitive;
    } else if (primitive instanceof Cesium.PrimitiveCollection) {
      yield* getPointPrimitiveCollections(primitive);
    }
  }
}

function getPointPrimitivePickTarget(targetPointIndex) {
  for (const collection of getPointPrimitiveCollections(
    viewer.scene.primitives,
  )) {
    for (let pointIndex = 0; pointIndex < collection.length; pointIndex += 1) {
      const point = collection.get(pointIndex);
      if (!point.show) continue;
      const screenPosition = Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        point.position,
      );
      if (
        !screenPosition ||
        screenPosition.x < 0 ||
        screenPosition.y < 0 ||
        screenPosition.x >= viewer.scene.canvas.clientWidth ||
        screenPosition.y >= viewer.scene.canvas.clientHeight
      ) {
        continue;
      }
      const position = new Cesium.Cartesian2(
        Math.round(screenPosition.x),
        Math.round(screenPosition.y),
      );
      const picked = viewer.scene.pick(position, 1, 1);
      const id = picked?.id;
      if (
        id &&
        typeof id.nodeKey === "string" &&
        typeof id.pointIndex === "number" &&
        (targetPointIndex === undefined || id.pointIndex === targetPointIndex)
      ) {
        return {
          nodeKey: id.nodeKey,
          pointIndex: id.pointIndex,
          screenPosition: { x: position.x, y: position.y },
        };
      }
    }
  }
  return undefined;
}

function renderedDiagnostics() {
  let renderedPointCount = 0;
  let minRenderedHeight = Number.POSITIVE_INFINITY;
  let maxRenderedHeight = Number.NEGATIVE_INFINITY;
  const colors = new Set();
  let firstPosition;

  for (const collection of getPointPrimitiveCollections(
    viewer.scene.primitives,
  )) {
    renderedPointCount += collection.length;
    const stride = Math.max(1, Math.floor(collection.length / 256));
    for (
      let pointIndex = 0;
      pointIndex < collection.length;
      pointIndex += stride
    ) {
      const point = collection.get(pointIndex);
      const cartographic = Cesium.Cartographic.fromCartesian(point.position);
      firstPosition ??= {
        longitude: Cesium.Math.toDegrees(cartographic.longitude),
        latitude: Cesium.Math.toDegrees(cartographic.latitude),
        height: cartographic.height,
      };
      minRenderedHeight = Math.min(minRenderedHeight, cartographic.height);
      maxRenderedHeight = Math.max(maxRenderedHeight, cartographic.height);
      colors.add(
        [
          point.color.red.toFixed(3),
          point.color.green.toFixed(3),
          point.color.blue.toFixed(3),
        ].join(","),
      );
    }
  }

  return {
    renderedPointCount,
    minRenderedHeight: Number.isFinite(minRenderedHeight)
      ? minRenderedHeight
      : undefined,
    maxRenderedHeight: Number.isFinite(maxRenderedHeight)
      ? maxRenderedHeight
      : undefined,
    renderedColorCount: colors.size,
    firstPosition,
  };
}

function getState() {
  const snapshot = layer.getSnapshot();
  const metadata = layer.getMetadata();
  const diagnostics = renderedDiagnostics();
  const cameraPosition = Cesium.Cartographic.fromCartesian(
    viewer.camera.positionWC,
  );
  const datasetCenter = layer.boundingSphere
    ? Cesium.Cartographic.fromCartesian(layer.boundingSphere.center)
    : undefined;
  return {
    viewerCreatedByConsumer: true,
    viewerAlive: !viewer.isDestroyed(),
    layerAttachedToCallerViewer: snapshot.attached,
    lifecycle: snapshot.lifecycle,
    backend: snapshot.backend,
    colorMode,
    attributeLoading,
    style: layer.getStyle(),
    clippingVolume: layer.getClippingVolume(),
    datasetUrl: snapshot.datasetUrl,
    metadata,
    hierarchy: layer.getHierarchyDiagnostics(),
    pointCache: snapshot.pointCache,
    selectedPoint: layer.getSelectedPoint(),
    selectedNodeKeys: snapshot.selectedNodeKeys,
    renderedNodeKeys: snapshot.renderedNodeKeys,
    streamingUpdateCount: snapshot.streamingUpdateCount,
    cameraMoveEventCount,
    cameraPosition: {
      longitude: Cesium.Math.toDegrees(cameraPosition.longitude),
      latitude: Cesium.Math.toDegrees(cameraPosition.latitude),
      height: cameraPosition.height,
    },
    datasetCenter: datasetCenter
      ? {
          longitude: Cesium.Math.toDegrees(datasetCenter.longitude),
          latitude: Cesium.Math.toDegrees(datasetCenter.latitude),
        }
      : undefined,
    cameraOrientation: {
      heading: Cesium.Math.toDegrees(viewer.camera.heading),
      pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
    },
    performance: snapshot.performance,
    transition: snapshot.transition,
    rangeRequests: snapshot.rangeRequests,
    worker: snapshot.worker,
    cameraChangeCount,
    longestMainThreadTaskMs,
    cesiumFrameDurationMs: cesiumFrameSamples.at(-1)?.durationMs ?? 0,
    lastError,
    ...diagnostics,
    renderedPointCount: snapshot.renderedPointCount,
  };
}

function getResponsivenessDiagnostics() {
  const startedAt = responsivenessCaptureStartedAt;
  const cameraSamples = cameraChangeSamples.filter(
    (sample) => sample.at >= startedAt,
  );
  const wheelSamples = wheelInputSamples.filter(
    (sample) => sample.at >= startedAt,
  );
  const frameSamples = cesiumFrameSamples
    .filter((sample) => sample.at >= startedAt)
    .map((sample) => sample.durationMs)
    .sort((left, right) => left - right);
  const taskSamples = mainThreadTasks.filter(
    (sample) => sample.at >= startedAt,
  );
  const percentile = (fraction) =>
    frameSamples.length === 0
      ? undefined
      : frameSamples[
          Math.min(
            frameSamples.length - 1,
            Math.floor(frameSamples.length * fraction),
          )
        ];
  const worker = layer.getSnapshot().worker;
  return {
    elapsedMs: startedAt > 0 ? performance.now() - startedAt : 0,
    worker,
    workerCameraChangeCount: cameraSamples.filter(
      (sample) => sample.worker?.activeCount > 0,
    ).length,
    workerWheelInputCount: wheelSamples.filter(
      (sample) => sample.worker?.activeCount > 0,
    ).length,
    workerWheelCameraChangeCount: cameraSamples.filter(
      (sample) =>
        sample.worker?.activeCount > 0 &&
        sample.lastWheelInputAt !== undefined &&
        sample.lastWheelInputAt >= startedAt &&
        sample.at - sample.lastWheelInputAt < 200,
    ).length,
    cameraChangeCount: cameraSamples.length,
    wheelInputCount: wheelSamples.length,
    frameDurationMs: {
      count: frameSamples.length,
      median: percentile(0.5),
      p95: percentile(0.95),
      max: percentile(1),
    },
    longTaskCount: taskSamples.length,
    longestMainThreadTaskMs: taskSamples.reduce(
      (maximum, sample) => Math.max(maximum, sample.durationMs),
      0,
    ),
  };
}

async function probeRustAttributes() {
  const source = await new RustCopcBackend().open(datasetUrl);
  try {
    const rootPage = await source.loadHierarchyPage(
      source.getRootHierarchyPage(),
    );
    const rootNode =
      rootPage.nodes.find((node) => node.key === "0-0-0-0") ??
      rootPage.nodes[0];
    const view = await source.loadPointDataView(
      rootNode,
      new Set(["position", "intensity", "classification", "rgb"]),
    );
    const sample = {};
    for (const component of [
      "x",
      "y",
      "z",
      "intensity",
      "classification",
      "red",
      "green",
      "blue",
    ]) {
      if (
        component === "x" ||
        component === "y" ||
        component === "z" ||
        view.availableFields.has(
          component === "intensity"
            ? "intensity"
            : component === "classification"
              ? "classification"
              : "rgb",
        )
      ) {
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
  async compareUrlAndFile(file) {
    const backend = new CopcJsBackend();
    const [urlSource, fileSource] = await Promise.all([
      backend.open(datasetUrl),
      backend.open(file),
    ]);
    const urlMetadata = urlSource.getMetadata();
    const fileMetadata = fileSource.getMetadata();
    const [urlPage, filePage] = await Promise.all([
      urlSource.loadHierarchyPage(urlSource.getRootHierarchyPage()),
      fileSource.loadHierarchyPage(fileSource.getRootHierarchyPage()),
    ]);
    const compact = (page) =>
      page.nodes
        .map(({ key, pointCount, pointDataOffset, pointDataLength }) => ({
          key,
          pointCount,
          pointDataOffset,
          pointDataLength,
        }))
        .sort((left, right) => left.key.localeCompare(right.key));
    const urlNodes = compact(urlPage);
    const fileNodes = compact(filePage);
    const sampleNode = urlPage.nodes
      .filter((node) => node.pointCount > 0 && node.pointCount <= 20_000)
      .sort((left, right) => left.pointCount - right.pointCount)[0];
    if (!sampleNode)
      throw new Error("No bounded COPC node was available for source parity");
    const fileNode = filePage.nodes.find((node) => node.key === sampleNode.key);
    const [urlPoints, filePoints] = await Promise.all([
      urlSource.loadPointDataView(sampleNode, new Set(["position"])),
      fileSource.loadPointDataView(fileNode, new Set(["position"])),
    ]);
    const sample = Array.from(
      { length: Math.min(8, sampleNode.pointCount) },
      (_, index) =>
        ["x", "y", "z"].map((component) => [
          urlPoints.getter(component)(index),
          filePoints.getter(component)(index),
        ]),
    );
    return {
      urlPointCount: urlMetadata.pointCount,
      filePointCount: fileMetadata.pointCount,
      urlNodes,
      fileNodes,
      urlSource: urlSource.source,
      fileSource: fileSource.source,
      sample,
    };
  },
  rustCrsTransformerExportAvailable: typeof RustCrsTransformer === "function",
  async estimateTerrainHeightAlignment(options) {
    const anchor = layer.getSelectedPoint();
    if (!anchor) throw new Error("Select a rendered point before estimating");
    lastTerrainEstimate = await layer.estimateTerrainHeightAlignment(
      anchor,
      options,
    );
    return lastTerrainEstimate;
  },
  isTerrainHeightAlignmentEstimateCurrent(estimate) {
    return layer.isTerrainHeightAlignmentEstimateCurrent(
      estimate ?? lastTerrainEstimate,
    );
  },
  async estimateTerrainHeightAlignmentBatch(candidates, options) {
    lastTerrainBatchEstimate = await layer.estimateTerrainHeightAlignmentBatch(
      candidates,
      options,
    );
    return lastTerrainBatchEstimate;
  },
  isTerrainHeightAlignmentBatchEstimateCurrent(estimate) {
    return layer.isTerrainHeightAlignmentBatchEstimateCurrent(
      estimate ?? lastTerrainBatchEstimate,
    );
  },
  getPointPrimitivePickTarget,
  usesTerrainFixtureProvider() {
    return (
      terrainFixtureProvider !== undefined &&
      viewer.terrainProvider === terrainFixtureProvider
    );
  },
  useEllipsoidTerrainProvider() {
    viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    return viewer.terrainProvider;
  },
  batchedRendererExportAvailable:
    typeof BatchedGeometryPointRenderer === "function",
  getLastErrorStack: () => lastErrorStack,
  getState,
  trySetStyle(update) {
    try {
      layer.setStyle(update);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  setClippingVolume(volume) {
    layer.setClippingVolume(volume);
    viewer.scene.requestRender();
  },
  getClippingDiagnostics() {
    if (!renderer) return undefined;
    return [...renderer.nodes.entries()].map(([nodeKey, node]) => {
      const appearance = node.primitive.appearance;
      return {
        nodeKey,
        hasClippingAttribute: Boolean(
          node.primitive.geometryInstances.geometry.attributes.a_clippingPosition,
        ),
        fragmentShaderSource: appearance.fragmentShaderSource,
        clippingUniformNames: Object.keys(appearance.material.uniforms).filter(
          (name) => name.startsWith("u_clipPlane"),
        ),
      };
    });
  },
  getPointSizeDiagnostics() {
    if (!renderer) return undefined;
    return [...renderer.nodes.entries()].map(([nodeKey, node]) => ({
      nodeKey,
      mode: node.pointSizeMode,
      spacingMeters: node.pointSpacingMeters,
      minimumCssPixels: node.minPointSize,
      maximumCssPixels: node.maxPointSize,
      generation: node.generation,
      geometrySpacingAttribute: node.primitive.geometryInstances.geometry
        .attributes.a_spacingMeters?.values
        ? Array.from(
            node.primitive.geometryInstances.geometry.attributes.a_spacingMeters
              .values,
          )
        : [],
      vertexShaderSource: node.primitive.appearance.vertexShaderSource,
    }));
  },
  getBatchedPointPickTarget() {
    if (!renderer) return undefined;
    for (const nodeKey of renderer.getRenderedNodeKeys()) {
      const probe = renderer.probePick(viewer.scene, nodeKey);
      if (
        probe.picked &&
        probe.screenPosition &&
        probe.targetSourcePointIndex !== undefined
      ) {
        // Browser mouse input is delivered at CSS-pixel coordinates. Probe
        // and resolve against the same integer coordinate that the E2E
        // click will use, rather than the projected point's fractional
        // coordinate, which can land in an adjacent pick pixel.
        const position = new Cesium.Cartesian2(
          Math.round(probe.screenPosition.x),
          Math.round(probe.screenPosition.y),
        );
        const pickedObject = viewer.scene.pick(position, 1, 1);
        const identity = renderer.resolvePointPick(
          viewer.scene,
          position,
          pickedObject,
        );
        if (!identity || identity.nodeKey !== nodeKey) continue;
        return {
          nodeKey,
          pointIndex: identity.pointIndex,
          screenPosition: { x: position.x, y: position.y },
          worldPosition: probe.worldPosition,
        };
      }
    }
    return undefined;
  },
  beginResponsivenessCapture() {
    responsivenessCaptureStartedAt = performance.now();
  },
  getResponsivenessDiagnostics,
  probeRustAttributes,
  setCameraHeight(height) {
    const current = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromRadians(
        current.longitude,
        current.latitude,
        height,
      ),
    });
    viewer.camera.moveEnd.raiseEvent();
  },
  setCameraPose({ longitude, latitude, height, heading = 0, pitch = -45 }) {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, height),
      orientation: {
        heading: Cesium.Math.toRadians(heading),
        pitch: Cesium.Math.toRadians(pitch),
        roll: 0,
      },
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

window.addEventListener("error", (event) =>
  reportError(event.error ?? event.message),
);
window.addEventListener("unhandledrejection", (event) =>
  reportError(event.reason),
);
viewer.scene.renderError.addEventListener((_scene, error) =>
  reportError(error),
);

try {
  await layer.load();
  layer.attachTo(viewer);
} catch (error) {
  reportError(error);
  throw error;
}
