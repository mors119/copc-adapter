import { CopcCesiumLayer as RootCopcCesiumLayer } from "@frillab/copc-adapter";
import type {
  CopcCesiumLayerOptions as RootCopcCesiumLayerOptions,
  CopcStreamingOptions as RootCopcStreamingOptions,
} from "@frillab/copc-adapter";
import { CopcCesiumLayer } from "@frillab/copc-adapter/cesium";
import type {
  CopcCesiumLayerOptions,
  CopcStreamingOptions,
} from "@frillab/copc-adapter/cesium";

const rootOptions: RootCopcCesiumLayerOptions = {
  url: "https://example.com/root.copc.laz",
};
const cesiumOptions: CopcCesiumLayerOptions = {
  url: "https://example.com/cesium.copc.laz",
};
const rootStreaming: RootCopcStreamingOptions = { maxConcurrentNodeLoads: 2 };
const cesiumStreaming: CopcStreamingOptions = { maxConcurrentNodeLoads: 2 };

void [
  RootCopcCesiumLayer,
  CopcCesiumLayer,
  rootOptions,
  cesiumOptions,
  rootStreaming,
  cesiumStreaming,
];
