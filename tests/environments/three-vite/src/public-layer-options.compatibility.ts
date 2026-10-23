import { CopcThreeLayer } from "@frillab/copc-adapter/three";
import type {
  CopcThreeLayerAttachment,
  CopcThreeLayerOptions,
} from "@frillab/copc-adapter/three";
import * as THREE from "three";

const layerOptions: CopcThreeLayerOptions = {
  url: "https://example.com/data.copc.laz",
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
await minimalLayer.load();
minimalLayer.attachTo(attachment);
await minimalLayer.update();
minimalLayer.destroy();
