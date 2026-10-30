import { CopcCesiumLayer as RootCopcCesiumLayer } from "@frillab/copc-adapter";
import type {
  CopcCesiumLayerOptions as RootCopcCesiumLayerOptions,
  CopcStreamingOptions as RootCopcStreamingOptions,
  TerrainHeightAlignmentBatchEstimate as RootTerrainBatchEstimate,
  TerrainHeightAlignmentBatchOptions as RootTerrainBatchOptions,
  TerrainHeightAlignmentGroundCandidate as RootTerrainGroundCandidate,
} from "@frillab/copc-adapter";
import { CopcCesiumLayer } from "@frillab/copc-adapter/cesium";
import type {
  CopcCesiumLayerOptions,
  CopcStreamingOptions,
  TerrainHeightAlignmentBatchEstimate,
  TerrainHeightAlignmentBatchOptions,
  TerrainHeightAlignmentGroundCandidate,
} from "@frillab/copc-adapter/cesium";

const rootOptions: RootCopcCesiumLayerOptions = {
  url: "https://example.com/root.copc.laz",
};
const cesiumOptions: CopcCesiumLayerOptions = {
  url: "https://example.com/cesium.copc.laz",
};
const rootStreaming: RootCopcStreamingOptions = { maxConcurrentNodeLoads: 2 };
const cesiumStreaming: CopcStreamingOptions = { maxConcurrentNodeLoads: 2 };
const rootTerrainCandidates: readonly RootTerrainGroundCandidate[] = [];
const cesiumTerrainCandidates: readonly TerrainHeightAlignmentGroundCandidate[] = [];
const rootTerrainBatchOptions: RootTerrainBatchOptions = { maxAnchors: 8 };
const cesiumTerrainBatchOptions: TerrainHeightAlignmentBatchOptions = {
  maxAnchors: 8,
  highSpreadWarningMeters: 2,
};
const rootBatchEstimate: RootTerrainBatchEstimate | undefined = undefined;
const cesiumBatchEstimate: TerrainHeightAlignmentBatchEstimate | undefined =
  rootBatchEstimate;

function rootBatchMethod(layer: RootCopcCesiumLayer) {
  return layer.estimateTerrainHeightAlignmentBatch(
    rootTerrainCandidates,
    rootTerrainBatchOptions,
  );
}

function cesiumBatchMethod(layer: CopcCesiumLayer) {
  return layer.estimateTerrainHeightAlignmentBatch(
    cesiumTerrainCandidates,
    cesiumTerrainBatchOptions,
  );
}

void [
  RootCopcCesiumLayer,
  CopcCesiumLayer,
  rootOptions,
  cesiumOptions,
  rootStreaming,
  cesiumStreaming,
  cesiumBatchEstimate,
  rootBatchMethod,
  cesiumBatchMethod,
];
