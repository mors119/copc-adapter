import { CopcThreeLayer } from "@frillab/copc-adapter/three";
import type {
  CopcThreeLayerAttachment,
  CopcThreeLayerOptions,
  CopcPointQueryOptions,
  CopcPointQuerySummary,
} from "@frillab/copc-adapter/three";
import * as THREE from "three";

const layerOptions: CopcThreeLayerOptions = {
  url: "https://example.com/data.copc.laz",
  opacity: 0.5,
  coordinateCacheLayout: "A",
  retainSourceCoordinatesForQueries: true,
  maxRenderedPoints: 200_000,
  streaming: {
    maxRenderedPoints: 100_000,
    maxConcurrentNodeLoads: 2,
  },
};
void layerOptions;

const attachment: CopcThreeLayerAttachment = {
  scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(),
  renderer: new THREE.WebGLRenderer(),
};

const minimalLayer = new CopcThreeLayer({
  url: "https://example.com/data.copc.laz",
});
minimalLayer.setOpacity(0.5);
await minimalLayer.load();
minimalLayer.attachTo(attachment);
await minimalLayer.update();
const queryOptions: CopcPointQueryOptions = {
  region: {
    coordinateSystem: "copc-source",
    min: { x: 100, y: 200, z: 0 },
    max: { x: 120, y: 240, z: 30 },
  },
  mode: "fetch-missing",
  maxDepth: 4,
  maxConcurrentPointReads: 2,
};
const query = minimalLayer.queryPoints(queryOptions);
const querySummary: Promise<CopcPointQuerySummary> = query.result;
void querySummary;
minimalLayer.destroy();
