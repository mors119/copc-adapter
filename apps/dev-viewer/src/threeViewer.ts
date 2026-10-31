import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  CopcThreeLayer,
  type CopcPointInspection,
  type CopcThreeLayerOptions,
  type CopcThreeLayerSnapshot,
} from "@frillab/copc-adapter/three";
import { createCoalescedUpdate } from "./coalescedUpdate";
import { applySchemaRuntimeOperations, type SchemaRuntimeOperation } from "../../shared/config/index.ts";
import type { PointScreenPosition } from "../../shared/inspection/PointPopover.ts";

export type DevThreeCameraState = {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
};

export type DevThreeViewerOptions = {
  readonly container: HTMLElement;
  readonly sourceName: string;
  readonly layerOptions: CopcThreeLayerOptions;
  readonly runtimeOperations?: readonly SchemaRuntimeOperation[];
  readonly cameraRenderDistance: number;
  readonly onPointPicked: (
    point: CopcPointInspection | undefined,
    position?: PointScreenPosition,
  ) => void;
  readonly onPointPositionChanged: (
    position: PointScreenPosition | undefined,
  ) => void;
  readonly onError: (error: unknown) => void;
};

export type DevThreeViewer = {
  readonly ready: Promise<void>;
  getSnapshot(): CopcThreeLayerSnapshot;
  getMetadata(): ReturnType<CopcThreeLayer["getMetadata"]>;
  getHierarchyDiagnostics(): ReturnType<
    CopcThreeLayer["getHierarchyDiagnostics"]
  >;
  getSelectedPoint(): CopcPointInspection | undefined;
  setOpacity(opacity: number | undefined): void;
  getCameraState(): DevThreeCameraState;
  setCameraState(state: DevThreeCameraState): void;
  setCameraDistance(distance: number): void;
  setCameraPreset(preset: "overview" | "far" | "near"): void;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
  destroy(): void;
};

function getCameraDistance(sourceName: string): number {
  if (/chicago/i.test(sourceName)) return 14_000;
  if (/autzen/i.test(sourceName)) return 1_500;
  return 3_000;
}

function findPickablePosition(
  root: THREE.Object3D | undefined,
  liveNodeKeys: readonly string[],
  camera: THREE.PerspectiveCamera,
  canvas: HTMLCanvasElement,
): { x: number; y: number } | undefined {
  if (!root || liveNodeKeys.length === 0 || canvas.clientWidth <= 0 || canvas.clientHeight <= 0)
    return undefined;
  const liveNodes = new Set(liveNodeKeys);
  let candidate: { x: number; y: number } | undefined;
  const canvasBounds = canvas.getBoundingClientRect();
  const blockingPanels = [
    ...document.querySelectorAll<HTMLElement>(
      "#controls-panel, #inspector-panel, .dev-panel-toggle",
    ),
  ].map((panel) => panel.getBoundingClientRect());
  root.traverse((object) => {
    if (
      candidate ||
      !(object instanceof THREE.Points) ||
      !liveNodes.has(String(object.userData.copcNodeKey ?? ""))
    ) return;
    const attribute = object.geometry.getAttribute("position");
    if (!attribute || attribute.count === 0) return;
    object.updateMatrixWorld(true);
    const point = new THREE.Vector3();
    const stride = Math.max(1, Math.floor(attribute.count / 256));
    for (let index = 0; index < attribute.count; index += stride) {
      point
        .fromBufferAttribute(attribute, index)
        .applyMatrix4(object.matrixWorld)
        .project(camera);
      if (
        point.z < -1 ||
        point.z > 1 ||
        Math.abs(point.x) > 0.97 ||
        Math.abs(point.y) > 0.97
      )
        continue;
      const x = ((point.x + 1) * canvas.clientWidth) / 2;
      const y = ((1 - point.y) * canvas.clientHeight) / 2;
      const screenX = canvasBounds.left + x;
      const screenY = canvasBounds.top + y;
      if (
        blockingPanels.some(
          (bounds) =>
            screenX >= bounds.left &&
            screenX <= bounds.right &&
            screenY >= bounds.top &&
            screenY <= bounds.bottom,
        )
      )
        continue;
      candidate = { x, y };
      break;
    }
  });
  return candidate;
}

function findSelectedPointObject(
  root: THREE.Object3D | undefined,
  point: CopcPointInspection,
): THREE.Points | undefined {
  if (!root) return undefined;
  let match: THREE.Points | undefined;
  root.traverse((object) => {
    if (
      !match &&
      object instanceof THREE.Points &&
      object.userData.copcNodeKey === point.nodeKey
    ) match = object;
  });
  return match;
}

function projectSelectedPoint(
  object: THREE.Points | undefined,
  camera: THREE.PerspectiveCamera,
  canvas: HTMLCanvasElement,
  pointIndex: number,
): PointScreenPosition | undefined {
  if (!object) return undefined;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;
  const positions = object.geometry.getAttribute("position");
  if (!positions || pointIndex >= positions.count) return undefined;
  object.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const projected = new THREE.Vector3()
    .fromBufferAttribute(positions, pointIndex)
    .applyMatrix4(object.matrixWorld)
    .project(camera);
  if (
    !Number.isFinite(projected.x) ||
    !Number.isFinite(projected.y) ||
    !Number.isFinite(projected.z) ||
    projected.z < -1 ||
    projected.z > 1 ||
    Math.abs(projected.x) > 1 ||
    Math.abs(projected.y) > 1
  ) return undefined;
  return {
    x: bounds.left + ((projected.x + 1) * bounds.width) / 2,
    y: bounds.top + ((1 - projected.y) * bounds.height) / 2,
  };
}

export function createDevThreeViewer(
  options: DevThreeViewerOptions,
): DevThreeViewer {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#08111d");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(
    options.container.clientWidth,
    options.container.clientHeight,
  );
  renderer.domElement.setAttribute("role", "img");
  renderer.domElement.setAttribute(
    "aria-label",
    "Interactive Three.js COPC point cloud",
  );
  options.container.replaceChildren(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(
    45,
    Math.max(1, options.container.clientWidth) /
      Math.max(1, options.container.clientHeight),
    0.1,
    250_000,
  );
  camera.up.set(0, 0, 1);
  const presetBaseDistance = getCameraDistance(options.sourceName);
  const initialDistance = options.cameraRenderDistance || presetBaseDistance;
  camera.position.set(0, -initialDistance, initialDistance * 0.38);
  camera.lookAt(0, 0, 0);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  let root: THREE.Object3D | undefined;
  let selectedPoint: CopcPointInspection | undefined;
  let selectedPointObject: THREE.Points | undefined;
  const layer = new CopcThreeLayer({
    ...options.layerOptions,
    debug: true,
    onPointPicked: (point) => {
      selectedPoint = point;
      selectedPointObject = point
        ? findSelectedPointObject(root, point)
        : undefined;
      const position = point
        ? projectSelectedPoint(
            selectedPointObject,
            camera,
            renderer.domElement,
            point.pointIndex,
          )
        : undefined;
      options.onPointPicked(point, position);
      options.onPointPositionChanged(position);
    },
  });
  layer.addEventListener("error", (event) => options.onError(event.error));
  const childrenBeforeAttach = new Set(scene.children);
  layer.attachTo({ scene, camera, renderer });
  root = scene.children.find((child) => !childrenBeforeAttach.has(child));

  let destroyed = false;
  let animationFrame = 0;
  let updateTimer: number | undefined;
  const updateLayerView = createCoalescedUpdate(
    () => layer.update(),
    options.onError,
  );
  const onCameraChange = (): void => {
    if (updateTimer !== undefined) window.clearTimeout(updateTimer);
    updateTimer = window.setTimeout(updateLayerView.request, 90);
  };
  controls.addEventListener("change", onCameraChange);

  const draw = (): void => {
    if (destroyed) return;
    animationFrame = requestAnimationFrame(draw);
    controls.update();
    renderer.render(scene, camera);
    if (selectedPoint) {
      options.onPointPositionChanged(
        projectSelectedPoint(
          selectedPointObject,
          camera,
          renderer.domElement,
          selectedPoint.pointIndex,
        ),
      );
    }
  };
  animationFrame = requestAnimationFrame(draw);

  const resizeObserver = new ResizeObserver(() => {
    if (destroyed) return;
    const width = options.container.clientWidth;
    const height = options.container.clientHeight;
    if (width <= 0 || height <= 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    onCameraChange();
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
    const bounds = renderer.domElement.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    layer.pick({
      x: ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      y: -(((event.clientY - bounds.top) / bounds.height) * 2 - 1),
    });
  };
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);

  const ready = applySchemaRuntimeOperations(layer, options.runtimeOperations ?? [])
    .then(() => layer.load())
    .then(() => layer.update());
  return {
    ready,
    getSnapshot: () => layer.getSnapshot(),
    getMetadata: () => layer.getMetadata(),
    getHierarchyDiagnostics: () => layer.getHierarchyDiagnostics(),
    getSelectedPoint: () => layer.getSelectedPoint(),
    setOpacity: (opacity) => layer.setOpacity(opacity),
    getCameraState: () => ({
      position: [
        camera.position.x,
        camera.position.y,
        camera.position.z,
      ] as const,
      target: [
        controls.target.x,
        controls.target.y,
        controls.target.z,
      ] as const,
    }),
    setCameraState(state) {
      camera.position.set(...state.position);
      controls.target.set(...state.target);
      camera.lookAt(controls.target);
      controls.update();
      onCameraChange();
    },
    setCameraDistance(distance) {
      const direction = camera.position
        .clone()
        .sub(controls.target)
        .normalize();
      camera.position
        .copy(controls.target)
        .addScaledVector(direction, distance);
      onCameraChange();
    },
    setCameraPreset(preset) {
      const distance =
        presetBaseDistance *
        (preset === "near" ? 0.55 : preset === "far" ? 2.5 : 1);
      camera.position.set(0, -distance, distance * 0.38);
      controls.target.set(0, 0, 0);
      controls.update();
      onCameraChange();
    },
    getPickablePointScreenPosition: () =>
      findPickablePosition(
        root,
        layer.getRenderedNodeKeys(),
        camera,
        renderer.domElement,
      ),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (selectedPoint) {
        selectedPoint = undefined;
        options.onPointPicked(undefined);
        options.onPointPositionChanged(undefined);
      }
      cancelAnimationFrame(animationFrame);
      if (updateTimer !== undefined) window.clearTimeout(updateTimer);
      updateLayerView.destroy();
      resizeObserver.disconnect();
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
