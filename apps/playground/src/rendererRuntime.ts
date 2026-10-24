import type * as CesiumTypes from "cesium";
import type * as ThreeTypes from "three";
import type {
  CopcCesiumLayer,
  CopcCesiumLayerOptions,
  CopcCesiumPointStyle,
  CopcCesiumPointStyleUpdate,
  CopcClassificationFilter,
  CopcMetadata,
  CopcPointInspection,
  RefinementFocus,
} from "@frillab/copc-adapter/cesium";
import type { CopcThreeLayer } from "@frillab/copc-adapter/three";
import type {
  PlaygroundLayerDiagnostics,
  PlaygroundPerformanceDiagnostics,
  PlaygroundSnapshot,
} from "./diagnostics";
import {
  toWorkbenchLayerOptions,
  type WorkbenchCameraPreset,
  type WorkbenchLayerConfig,
  type WorkbenchRenderer,
} from "../../shared/workbench-config";

export type PlaygroundRenderer = WorkbenchRenderer;
export type PlaygroundBackend = WorkbenchLayerConfig["backend"];
export type PlaygroundSource = string | File;
export type PlaygroundColorMode = WorkbenchLayerConfig["colorMode"];
export type PlaygroundCameraView = WorkbenchCameraPreset;

export type PlaygroundCameraState = {
  readonly longitude: number;
  readonly latitude: number;
  readonly height: number;
  readonly heading: number;
  readonly pitch: number;
  readonly roll: number;
};

export type { PlaygroundSnapshot } from "./diagnostics";

export type PlaygroundRuntime = {
  readonly renderer: PlaygroundRenderer;
  readonly ready: Promise<void>;
  getSnapshot(): PlaygroundSnapshot;
  getDiagnostics(): PlaygroundLayerDiagnostics;
  getLatestRenderIntervalMs(): number | undefined;
  getSelectedPoint(): CopcPointInspection | undefined;
  getMetadata(): CopcMetadata | undefined;
  /** Present only for the public Cesium runtime style API. */
  getStyle?(): CopcCesiumPointStyle;
  /** Present only for the public Cesium runtime style API. */
  setStyle?(update: CopcCesiumPointStyleUpdate): void;
  setCameraView(view: PlaygroundCameraView): Promise<void>;
  getCameraState(): PlaygroundCameraState;
  setCameraState(state: PlaygroundCameraState): void;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
  setRefinementFocus(focus: RefinementFocus | undefined): void;
  getFocusCanvas(): HTMLCanvasElement | undefined;
  setFocusDragging(dragging: boolean): void;
  getCameraInputsEnabled(): boolean | undefined;
  destroy(): void;
};

export type PlaygroundRuntimeOptions = WorkbenchLayerConfig & {
  readonly renderer: PlaygroundRenderer;
  readonly source: PlaygroundSource;
  readonly sourceName: string;
  readonly classificationFilter?: CopcClassificationFilter;
  readonly container: HTMLElement;
  readonly onPointPicked: (point: CopcPointInspection | undefined) => void;
  readonly onError: (message: string) => void;
  readonly isCurrent: () => boolean;
  /** Allow callers to keep camera input made while the source was loading. */
  readonly canAutoZoom?: () => boolean;
  /** App-owned observation hooks around the public layer.load() call. */
  readonly onLayerLoadStart?: () => void;
  readonly onLayerLoadComplete?: () => void;
};

type CesiumLayer = Pick<
  CopcCesiumLayer,
  | "load"
  | "attachTo"
  | "destroy"
  | "getSnapshot"
  | "getSelectedPoint"
  | "getMetadata"
  | "getHierarchyDiagnostics"
  | "getPointCacheDiagnostics"
  | "getStyle"
  | "setStyle"
  | "zoomTo"
  | "boundingSphere"
  | "setRefinementFocus"
>;

export type CesiumLayerFactory = (
  options: CopcCesiumLayerOptions,
) => CesiumLayer;

function getInitialThreeCameraDistance(sourceName: string): number {
  if (/chicago/i.test(sourceName)) return 14_000;
  if (/autzen/i.test(sourceName)) return 1_500;
  return 3_000;
}

function normalizeLod(
  value: unknown,
): { min: number; max: number } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const range = value as { min?: unknown; max?: unknown };
  return typeof range.min === "number" &&
    Number.isFinite(range.min) &&
    typeof range.max === "number" &&
    Number.isFinite(range.max)
    ? { min: range.min, max: range.max }
    : undefined;
}

function snapshotFromCesium(
  layer: CesiumLayer,
  snapshot = layer.getSnapshot(),
): PlaygroundSnapshot {
  return {
    lifecycle: snapshot.lifecycle,
    renderedPoints: snapshot.renderedPointCount,
    renderedNodes: snapshot.renderedNodeKeys.length,
    selectedNodes: snapshot.selectedNodeKeys.length,
    selectedNodeKeys: snapshot.selectedNodeKeys,
    streamingUpdateCount: snapshot.streamingUpdateCount,
    backend: snapshot.backend,
    performance: snapshot.performance as PlaygroundPerformanceDiagnostics,
    ...(normalizeLod(snapshot.performance.visibleLevelRange)
      ? {
          visibleLevelRange: normalizeLod(
            snapshot.performance.visibleLevelRange,
          )!,
        }
      : {}),
    refinementAlgorithm: snapshot.performance.refinementAlgorithm,
    refinementFocusEnabled: snapshot.performance.refinementFocusEnabled,
    focusCandidateCount: snapshot.performance.focusCandidateCount,
    focusWeightMin: snapshot.performance.focusWeightMin,
    focusWeightMax: snapshot.performance.focusWeightMax,
    focusInfluencedRefinementCount:
      snapshot.performance.focusInfluencedRefinementCount,
  };
}

function snapshotFromThree(
  layer: CopcThreeLayer,
  snapshot = layer.getSnapshot(),
): PlaygroundSnapshot {
  return {
    lifecycle: snapshot.lifecycle,
    renderedPoints: snapshot.renderedPointCount,
    renderedNodes: snapshot.renderedNodeKeys.length,
    selectedNodes: snapshot.selectedNodeKeys.length,
    selectedNodeKeys: snapshot.selectedNodeKeys,
    streamingUpdateCount: snapshot.streamingUpdateCount,
    backend: snapshot.backend,
    performance: {
      ...snapshot.performance,
      rendererPreparationDurationMs:
        snapshot.renderer.rendererPreparationDurationMs,
    } as PlaygroundPerformanceDiagnostics,
    ...(normalizeLod(snapshot.performance.visibleLevelRange)
      ? {
          visibleLevelRange: normalizeLod(
            snapshot.performance.visibleLevelRange,
          )!,
        }
      : {}),
    refinementAlgorithm: snapshot.performance.refinementAlgorithm,
    refinementFocusEnabled: snapshot.performance.refinementFocusEnabled,
    focusCandidateCount: snapshot.performance.focusCandidateCount,
    focusWeightMin: snapshot.performance.focusWeightMin,
    focusWeightMax: snapshot.performance.focusWeightMax,
    focusInfluencedRefinementCount:
      snapshot.performance.focusInfluencedRefinementCount,
  };
}

function* getCesiumPointCollections(
  Cesium: typeof import("cesium"),
  collection: CesiumTypes.PrimitiveCollection,
): Generator<CesiumTypes.PointPrimitiveCollection> {
  for (let index = 0; index < collection.length; index += 1) {
    const primitive = collection.get(index);
    if (primitive instanceof Cesium.PointPrimitiveCollection) {
      yield primitive;
    } else if (primitive instanceof Cesium.PrimitiveCollection) {
      yield* getCesiumPointCollections(Cesium, primitive);
    }
  }
}

function getCesiumPickPosition(
  Cesium: typeof import("cesium"),
  viewer: CesiumTypes.Viewer,
): { x: number; y: number } | undefined {
  const canvas = viewer.scene.canvas;
  for (const collection of getCesiumPointCollections(
    Cesium,
    viewer.scene.primitives,
  )) {
    for (let index = 0; index < collection.length; index += 1) {
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        collection.get(index).position,
      );
      if (
        screen &&
        screen.x >= 2 &&
        screen.x < canvas.clientWidth - 2 &&
        screen.y >= 2 &&
        screen.y < canvas.clientHeight - 2
      ) {
        const pixel = new Cesium.Cartesian2(screen.x, screen.y);
        if (viewer.scene.pick(pixel)) return { x: screen.x, y: screen.y };
      }
    }
  }
  return undefined;
}

function getThreePickPosition(
  THREE: typeof import("three"),
  root: ThreeTypes.Object3D | undefined,
  camera: ThreeTypes.PerspectiveCamera,
  renderer: ThreeTypes.WebGLRenderer,
): { x: number; y: number } | undefined {
  const canvas = renderer.domElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!root || width <= 0 || height <= 0) return undefined;

  let position: { x: number; y: number } | undefined;
  root.traverse((object) => {
    if (position || !(object instanceof THREE.Points)) return;
    const attribute = object.geometry.getAttribute("position");
    if (!attribute || attribute.count === 0) return;
    object.updateMatrixWorld(true);
    const world = new THREE.Vector3();
    const stride = Math.max(1, Math.floor(attribute.count / 256));
    for (let index = 0; index < attribute.count; index += stride) {
      world
        .fromBufferAttribute(attribute, index)
        .applyMatrix4(object.matrixWorld)
        .project(camera);
      if (
        world.z < -1 ||
        world.z > 1 ||
        Math.abs(world.x) > 0.98 ||
        Math.abs(world.y) > 0.98
      )
        continue;
      position = {
        x: ((world.x + 1) * width) / 2,
        y: ((1 - world.y) * height) / 2,
      };
      break;
    }
  });
  return position;
}

export async function createPlaygroundRuntime(
  options: PlaygroundRuntimeOptions,
  layerFactory?: CesiumLayerFactory,
): Promise<PlaygroundRuntime | undefined> {
  if (options.renderer === "cesium") {
    const [Cesium, adapter] = await Promise.all([
      import("cesium"),
      import("@frillab/copc-adapter/cesium"),
    ]);
    if (!options.isCurrent()) return undefined;
    const viewer = new Cesium.Viewer(options.container, {
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
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    });
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#172635");
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#08111d");
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(-12, 24, 19_000_000),
    });

    const layerOptions: CopcCesiumLayerOptions = {
      url: options.source,
      ...toWorkbenchLayerOptions(options),
      onPointPicked: options.onPointPicked,
    };
    const layer = layerFactory
      ? layerFactory(layerOptions)
      : new adapter.CopcCesiumLayer(layerOptions);
    if (options.classificationFilter !== undefined) {
      layer.setStyle({ classificationFilter: options.classificationFilter });
    }
    layer.attachTo(viewer);
    let destroyed = false;
    let lastPostRenderAt: number | undefined;
    let latestRenderIntervalMs: number | undefined;
    const onPostRender = (): void => {
      const now = performance.now();
      if (lastPostRenderAt !== undefined)
        latestRenderIntervalMs = now - lastPostRenderAt;
      lastPostRenderAt = now;
    };
    viewer.scene.postRender.addEventListener(onPostRender);
    let previousCameraInputs: boolean | undefined;
    const setFocusDragging = (dragging: boolean): void => {
      const cameraController = viewer.scene.screenSpaceCameraController;
      if (dragging) {
        if (previousCameraInputs === undefined) {
          previousCameraInputs = cameraController.enableInputs;
          cameraController.enableInputs = false;
        }
      } else if (previousCameraInputs !== undefined) {
        cameraController.enableInputs = previousCameraInputs;
        previousCameraInputs = undefined;
      }
    };
    options.onLayerLoadStart?.();
    const ready = layer.load().then(async () => {
      options.onLayerLoadComplete?.();
      if (!destroyed && (options.canAutoZoom?.() ?? true)) await layer.zoomTo();
    });

    const getDiagnostics = (): PlaygroundLayerDiagnostics => {
      const layerSnapshot = layer.getSnapshot();
      const metadata = layer.getMetadata();
      const hierarchy = layer.getHierarchyDiagnostics();
      return {
        snapshot: snapshotFromCesium(layer, layerSnapshot),
        ...(metadata ? { metadataPointCount: metadata.pointCount } : {}),
        transition: layerSnapshot.transition,
        ...(hierarchy ? { hierarchy } : {}),
        pointCache: layer.getPointCacheDiagnostics(),
        rangeRequests: layerSnapshot.rangeRequests,
        ...(layerSnapshot.worker
          ? { worker: layerSnapshot.worker }
          : {}),
      };
    };

    return {
      renderer: "cesium",
      ready,
      getSnapshot: () => getDiagnostics().snapshot,
      getDiagnostics,
      getLatestRenderIntervalMs: () => latestRenderIntervalMs,
      getSelectedPoint: () => layer.getSelectedPoint(),
      getMetadata: () => layer.getMetadata(),
      getStyle: () => layer.getStyle(),
      setStyle: (update) => layer.setStyle(update),
      async setCameraView(view) {
        if (destroyed) return;
        const radius = layer.boundingSphere?.radius ?? 1_000;
        const multiplier = view === "near" ? 1.5 : view === "far" ? 6 : 3;
        await layer.zoomTo(
          new Cesium.HeadingPitchRange(
            0,
            -Cesium.Math.PI_OVER_FOUR,
            Math.max(100, radius * multiplier),
          ),
        );
      },
      getCameraState: () => {
        const cartographic = Cesium.Cartographic.fromCartesian(
          viewer.camera.positionWC,
        );
        return {
          longitude: Cesium.Math.toDegrees(cartographic.longitude),
          latitude: Cesium.Math.toDegrees(cartographic.latitude),
          height: cartographic.height,
          heading: Cesium.Math.toDegrees(viewer.camera.heading),
          pitch: Cesium.Math.toDegrees(viewer.camera.pitch),
          roll: Cesium.Math.toDegrees(viewer.camera.roll),
        };
      },
      setCameraState: (state) =>
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(
            state.longitude,
            state.latitude,
            state.height,
          ),
          orientation: {
            heading: Cesium.Math.toRadians(state.heading),
            pitch: Cesium.Math.toRadians(state.pitch),
            roll: Cesium.Math.toRadians(state.roll),
          },
        }),
      getPickablePointScreenPosition: () =>
        getCesiumPickPosition(Cesium, viewer),
      setRefinementFocus: (focus) => layer.setRefinementFocus(focus),
      getFocusCanvas: () =>
        destroyed || viewer.isDestroyed() ? undefined : viewer.scene.canvas,
      setFocusDragging,
      getCameraInputsEnabled: () =>
        destroyed || viewer.isDestroyed()
          ? undefined
          : viewer.scene.screenSpaceCameraController.enableInputs,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        viewer.scene.postRender.removeEventListener(onPostRender);
        setFocusDragging(false);
        layer.destroy();
        if (!viewer.isDestroyed()) viewer.destroy();
      },
    };
  }

  const [THREE, { OrbitControls }, adapter] = await Promise.all([
    import("three"),
    import("three/addons/controls/OrbitControls.js"),
    import("@frillab/copc-adapter/three"),
  ]);
  if (!options.isCurrent()) return undefined;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#08111d");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(
    options.container.clientWidth,
    options.container.clientHeight,
  );
  renderer.domElement.setAttribute(
    "aria-label",
    "Interactive Three.js point cloud viewport",
  );
  renderer.domElement.setAttribute("role", "img");
  options.container.replaceChildren(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(
    45,
    Math.max(1, options.container.clientWidth) /
      Math.max(1, options.container.clientHeight),
    0.1,
    250_000,
  );
  camera.up.set(0, 0, 1);
  let cameraDistance = getInitialThreeCameraDistance(options.sourceName);
  const cameraTarget = new THREE.Vector3(0, 0, 0);
  const initialCameraDirection = new THREE.Vector3(0, -1, 0.38).normalize();
  camera.position
    .copy(cameraTarget)
    .addScaledVector(initialCameraDirection, cameraDistance);
  camera.lookAt(cameraTarget);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  let userInteracted = false;
  const onCameraStart = (): void => {
    userInteracted = true;
  };
  controls.addEventListener("start", onCameraStart);

  const layerOptions = {
    url: options.source,
    ...toWorkbenchLayerOptions(options),
    onPointPicked: options.onPointPicked,
  };
  const layer = new adapter.CopcThreeLayer(layerOptions);
  layer.addEventListener("error", (event) => {
    options.onError(
      event.error instanceof Error ? event.error.message : String(event.error),
    );
  });
  const sceneChildrenBeforeAttach = new Set(scene.children);
  layer.attachTo({ scene, camera, renderer });
  const layerRoot = scene.children.find(
    (child) => !sceneChildrenBeforeAttach.has(child),
  );
  let destroyed = false;
  let animationFrame = 0;
  let lastRenderCallbackAt: number | undefined;
  let latestRenderIntervalMs: number | undefined;
  const draw = (): void => {
    if (destroyed) return;
    animationFrame = requestAnimationFrame(draw);
    const now = performance.now();
    if (lastRenderCallbackAt !== undefined)
      latestRenderIntervalMs = now - lastRenderCallbackAt;
    lastRenderCallbackAt = now;
    controls.update();
    renderer.render(scene, camera);
  };
  animationFrame = requestAnimationFrame(draw);
  let synchronizingCamera = false;
  const onCameraChange = (): void => {
    if (synchronizingCamera) return;
    void layer.update().catch((error: unknown) => {
      options.onError(error instanceof Error ? error.message : String(error));
    });
  };
  controls.addEventListener("change", onCameraChange);
  const resizeObserver = new ResizeObserver(() => {
    if (destroyed) return;
    const width = options.container.clientWidth;
    const height = options.container.clientHeight;
    if (width <= 0 || height <= 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    void layer.update().catch((error: unknown) => {
      options.onError(error instanceof Error ? error.message : String(error));
    });
  });
  resizeObserver.observe(options.container);

  let pointerStart: { x: number; y: number } | undefined;
  const onPointerDown = (event: PointerEvent): void => {
    pointerStart = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (
      !pointerStart ||
      Math.hypot(
        event.clientX - pointerStart.x,
        event.clientY - pointerStart.y,
      ) > 5
    ) {
      pointerStart = undefined;
      return;
    }
    pointerStart = undefined;
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    layer.pick({
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    });
  };
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);

  options.onLayerLoadStart?.();
  const ready = layer.load().then(async () => {
    options.onLayerLoadComplete?.();
    await layer.update();
    if (destroyed || userInteracted) return;

    const bounds = new THREE.Box3().setFromObject(layer.getRoot());
    if (bounds.isEmpty()) return;
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    cameraTarget.copy(sphere.center);
    cameraDistance = Math.max(10, sphere.radius * 2.8);
    camera.position
      .copy(cameraTarget)
      .addScaledVector(initialCameraDirection, cameraDistance);
    camera.lookAt(cameraTarget);
    controls.target.copy(cameraTarget);
    synchronizingCamera = true;
    controls.update();
    synchronizingCamera = false;
    await layer.update();
  });
  const getDiagnostics = (): PlaygroundLayerDiagnostics => {
    const layerSnapshot = layer.getSnapshot();
    const metadata = layer.getMetadata();
    const hierarchy = layer.getHierarchyDiagnostics();
    return {
      snapshot: snapshotFromThree(layer, layerSnapshot),
      ...(metadata ? { metadataPointCount: metadata.pointCount } : {}),
      transition: layerSnapshot.transition,
      ...(hierarchy ? { hierarchy } : {}),
      pointCache: layer.getPointCacheDiagnostics(),
      ...(layerSnapshot.worker
        ? { worker: layerSnapshot.worker }
        : {}),
    };
  };
  return {
    renderer: "three",
    ready,
    getSnapshot: () => getDiagnostics().snapshot,
    getDiagnostics,
    getLatestRenderIntervalMs: () => latestRenderIntervalMs,
    getSelectedPoint: () => layer.getSelectedPoint(),
    getMetadata: () => layer.getMetadata(),
    async setCameraView(view) {
      if (destroyed) return;
      const distance =
        cameraDistance * (view === "near" ? 0.55 : view === "far" ? 2.5 : 1);
      const direction = camera.position
        .clone()
        .sub(controls.target)
        .normalize();
      camera.position
        .copy(controls.target)
        .addScaledVector(direction, distance);
      controls.update();
      await layer.update();
    },
    getCameraState: () => ({
      longitude: camera.position.x,
      latitude: camera.position.y,
      height: camera.position.z,
      heading: controls.target.x,
      pitch: controls.target.y,
      roll: controls.target.z,
    }),
    setCameraState: (state) => {
      camera.position.set(state.longitude, state.latitude, state.height);
      controls.target.set(state.heading, state.pitch, state.roll);
      camera.lookAt(controls.target);
      controls.update();
    },
    getPickablePointScreenPosition: () =>
      getThreePickPosition(THREE, layerRoot, camera, renderer),
    setRefinementFocus(): void {},
    getFocusCanvas: () => undefined,
    setFocusDragging(): void {},
    getCameraInputsEnabled: () => undefined,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      controls.removeEventListener("start", onCameraStart);
      controls.removeEventListener("change", onCameraChange);
      controls.dispose();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      layer.destroy();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
