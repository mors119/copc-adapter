import * as THREE from "three";
import {
  CopcThreeLayer,
  type CopcThreeLayerSnapshot,
} from "@frillab/copc-adapter/three";

export type ThreeLifecycleState = {
  snapshot: CopcThreeLayerSnapshot;
  metadataPointCount?: number;
  hierarchy?: ReturnType<CopcThreeLayer["getHierarchyDiagnostics"]>;
  sceneChildCount: number;
  pointObjectCount: number;
  visiblePointObjectCount: number;
  rendererGeometryCount: number;
  rendererTextureCount: number;
  rendererInfo: {
    calls: number;
    points: number;
    triangles: number;
    geometries: number;
    textures: number;
    programs: number;
  };
  positionBufferBytes: number;
  colorBufferBytes: number;
  uniqueMaterialCount: number;
  materialOpacities: number[];
  canvasCount: number;
  contextLost: boolean;
  layerRootAttached: boolean;
  maxConcurrentNodeLoads?: number;
  errors: string[];
};

export type ThreeLifecycleFixture = {
  threeVersion: string;
  source: string;
  createLayer(): void;
  load(): Promise<void>;
  attach(): void;
  update(): Promise<void>;
  setCameraDistance(distance: number): void;
  setCameraPosition(position: { x: number; y: number; z: number }): void;
  setOpacity(opacity: number): void;
  detach(): void;
  unload(): void;
  reload(): Promise<void>;
  destroy(): void;
  getState(): ThreeLifecycleState;
  disposeViewer(): void;
};

declare global {
  interface Window {
    __COPC_THREE_LIFECYCLE__?: ThreeLifecycleFixture;
  }
}

const params = new URLSearchParams(window.location.search);
const source = params.get("source") ?? "/samples/autzen.copc.laz";
const requestedBackend = params.get("backend");
if (
  requestedBackend &&
  requestedBackend !== "copc-js" &&
  requestedBackend !== "rust"
) {
  throw new Error(`Unsupported Three.js lifecycle backend: ${requestedBackend}`);
}
const backend = requestedBackend ?? "rust";
const container = document.querySelector<HTMLElement>("#viewer");
if (!container) throw new Error("Three.js lifecycle container is missing");

const scene = new THREE.Scene();
scene.background = new THREE.Color("#08111d");
const camera = new THREE.PerspectiveCamera(
  45,
  Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
  0.1,
  250_000,
);
camera.up.set(0, 0, 1);
camera.position.set(0, -1_500, 570);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld(true);

const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
container.appendChild(renderer.domElement);

let layer: CopcThreeLayer | undefined;
const errors: string[] = [];
let animationFrame = 0;
let viewerDisposed = false;

const render = (): void => {
  if (viewerDisposed) return;
  animationFrame = requestAnimationFrame(render);
  renderer.render(scene, camera);
};
animationFrame = requestAnimationFrame(render);

function requireLayer(): CopcThreeLayer {
  if (!layer) throw new Error("Create the COPC layer before using it");
  return layer;
}

window.__COPC_THREE_LIFECYCLE__ = {
  threeVersion: THREE.REVISION,
  source,
  createLayer(): void {
    if (layer && layer.getSnapshot().lifecycle !== "destroyed") {
      throw new Error("Destroy the current COPC layer before creating another");
    }
    errors.length = 0;
    layer = new CopcThreeLayer({
      url: source,
      backend,
      colorMode: "elevation",
      pointSize: 2,
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
    layer.addEventListener("error", (event) =>
      errors.push(
        event.error instanceof Error ? event.error.message : String(event.error),
      ),
    );
  },
  load: () => requireLayer().load(),
  attach(): void {
    requireLayer().attachTo({ scene, camera, renderer });
  },
  update: () => requireLayer().update(),
  setCameraDistance(distance): void {
    camera.position.set(0, -distance, distance * 0.38);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
  },
  setCameraPosition(position): void {
    camera.position.set(position.x, position.y, position.z);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
  },
  setOpacity: (opacity) => requireLayer().setOpacity(opacity),
  detach: () => requireLayer().detachFrom(),
  unload: () => requireLayer().unload(),
  async reload(): Promise<void> {
    const activeLayer = requireLayer();
    await activeLayer.reload();
    if (activeLayer.getSnapshot().attached) await activeLayer.update();
  },
  destroy: () => requireLayer().destroy(),
  getState(): ThreeLifecycleState {
    const activeLayer = requireLayer();
    const snapshot = activeLayer.getSnapshot();
    let pointObjectCount = 0;
    const materials = new Set<THREE.Material>();
    const materialOpacities: number[] = [];
    let visiblePointObjectCount = 0;
    let positionBufferBytes = 0;
    let colorBufferBytes = 0;
    scene.traverse((object) => {
      if (!(object instanceof THREE.Points)) return;
      pointObjectCount += 1;
      if (object.visible) visiblePointObjectCount += 1;
      positionBufferBytes +=
        object.geometry.getAttribute("position").array.byteLength;
      colorBufferBytes +=
        object.geometry.getAttribute("color").array.byteLength;
      if (Array.isArray(object.material)) {
        for (const material of object.material) {
          materials.add(material);
          if (material instanceof THREE.PointsMaterial) {
            materialOpacities.push(material.opacity);
          }
        }
      } else {
        materials.add(object.material);
        if (object.material instanceof THREE.PointsMaterial) {
          materialOpacities.push(object.material.opacity);
        }
      }
    });
    return {
      snapshot,
      metadataPointCount: activeLayer.getMetadata()?.pointCount,
      hierarchy: activeLayer.getHierarchyDiagnostics(),
      sceneChildCount: scene.children.length,
      pointObjectCount,
      visiblePointObjectCount,
      rendererGeometryCount: renderer.info.memory.geometries,
      rendererTextureCount: renderer.info.memory.textures,
      rendererInfo: {
        calls: renderer.info.render.calls,
        points: renderer.info.render.points,
        triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        programs: renderer.info.programs?.length ?? 0,
      },
      positionBufferBytes,
      colorBufferBytes,
      uniqueMaterialCount: materials.size,
      materialOpacities,
      canvasCount: container.querySelectorAll("canvas").length,
      contextLost: renderer.getContext().isContextLost(),
      layerRootAttached: scene.children.includes(activeLayer.getRoot()),
      maxConcurrentNodeLoads: snapshot.performance.maxConcurrentNodeLoads,
      errors: [...errors],
    };
  },
  disposeViewer(): void {
    if (viewerDisposed) return;
    viewerDisposed = true;
    cancelAnimationFrame(animationFrame);
    if (layer && layer.getSnapshot().lifecycle !== "destroyed") {
      layer.destroy();
    }
    renderer.dispose();
    renderer.domElement.remove();
    scene.clear();
  },
};
