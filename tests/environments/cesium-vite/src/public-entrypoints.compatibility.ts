import { CopcCesiumLayer as RootCopcCesiumLayer } from "@frillab/copc-adapter";
import type {
  CopcCesiumLayerOptions as RootCopcCesiumLayerOptions,
  CopcElevationStyle as RootCopcElevationStyle,
  CopcStreamingOptions as RootCopcStreamingOptions,
} from "@frillab/copc-adapter";
import { CopcCesiumLayer } from "@frillab/copc-adapter/cesium";
import type {
  CopcCesiumLayerOptions,
  CopcElevationStyle,
  CopcStreamingOptions,
} from "@frillab/copc-adapter/cesium";

const rootElevationStyle: RootCopcElevationStyle = {
  interpolation: "linear",
  palette: [
    { position: 0, color: { red: 0, green: 0, blue: 0.3 } },
    { position: 1, color: { red: 1, green: 0, blue: 0 } },
  ],
};
const cesiumElevationStyle: CopcElevationStyle = {
  interpolation: "step",
  palette: [
    { position: 0, color: { red: 0, green: 0, blue: 0.3 } },
    { position: 1, color: { red: 1, green: 0, blue: 0 } },
  ],
};

const rootOptions: RootCopcCesiumLayerOptions = {
  url: "https://example.com/root.copc.laz",
  colorMode: "elevation",
  elevationRange: { min: -20, max: 120 },
  elevationStyle: rootElevationStyle,
};
const cesiumOptions: CopcCesiumLayerOptions = {
  url: "https://example.com/cesium.copc.laz",
  colorMode: "elevation",
  elevationRange: { min: -20, max: 120 },
  elevationStyle: cesiumElevationStyle,
};
const rootStreaming: RootCopcStreamingOptions = { maxConcurrentNodeLoads: 2 };
const cesiumStreaming: CopcStreamingOptions = { maxConcurrentNodeLoads: 2 };

void [
  RootCopcCesiumLayer,
  CopcCesiumLayer,
  rootOptions,
  cesiumOptions,
  rootElevationStyle,
  cesiumElevationStyle,
  rootStreaming,
  cesiumStreaming,
];
