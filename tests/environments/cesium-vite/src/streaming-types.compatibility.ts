import {
  CopcCesiumLayer,
  CopcStreamingCore,
} from "@frillab/copc-adapter/cesium";
import type {
  CopcCesiumLayerOptions,
  CopcCesiumClippingVolume,
  CopcStreamingProgressHandler,
  StreamingProgress,
  StreamingUpdateResult,
  StreamingView,
  PreparedPointData,
  CopcStreamingControllerOptions,
  CopcPointQueryOptions,
  CopcPointQuerySummary,
} from "@frillab/copc-adapter/cesium";

declare const core: CopcStreamingCore;
declare const view: StreamingView;
declare const options: CopcStreamingControllerOptions;
declare const viewer: import("cesium").Viewer;

const layerOptions: CopcCesiumLayerOptions = {
  url: "https://example.com/data.copc.laz",
  opacity: 0.5,
  coordinateCacheLayout: "A",
  retainSourceCoordinatesForQueries: true,
  colorMode: "rgb",
  attributeLoading: "required",
  classificationFilter: { include: [2, 6] },
  clippingVolume: {
    type: "planes",
    coordinateSystem: "wgs84-ecef-meters",
    planes: [{ normal: [1, 0, 0], point: [6_378_137, 0, 0] }],
  },
  pointFields: new Set(["intensity"]),
  maxRenderedPoints: 200_000,
  streaming: {
    maxRenderedPoints: 100_000,
    maxConcurrentNodeLoads: 2,
  },
};
void layerOptions;

const minimalLayer = new CopcCesiumLayer({
  url: "https://example.com/data.copc.laz",
});
minimalLayer.setOpacity(0.5);
minimalLayer.setOpacity(undefined);
const runtimeClipping: CopcCesiumClippingVolume = {
  type: "box",
  coordinateSystem: "wgs84-ecef-meters",
  minimum: [-10, -10, -10],
  maximum: [10, 10, 10],
};
minimalLayer.setClippingVolume(runtimeClipping);
const clippingSnapshot: CopcCesiumClippingVolume | undefined =
  minimalLayer.getClippingVolume();
void clippingSnapshot;
minimalLayer.setClippingVolume(undefined);
await minimalLayer.load();
minimalLayer.attachTo(viewer);
minimalLayer.destroy();

// The public core keeps its A contract; Cesium layers can opt into A
// compatibility while defaulting to E retained storage.
// @ts-expect-error The production controller cannot claim an arbitrary point layout.
const forgedLayoutCore = new CopcStreamingCore<{ invented: true }>(options);
void forgedLayoutCore;

const oldCallbackShape: CopcStreamingProgressHandler = (
  progress: StreamingProgress,
) => {
  const prepared: PreparedPointData | undefined =
    progress.loadedNodePoints.get("0-0-0-0");
  if (prepared) {
    const exactSource: Float64Array = prepared.source.coordinates;
    const exactGeographic: Float64Array = prepared.geographic.coordinates;
    void [exactSource, exactGeographic];
  }
};

const oldResultShape: Promise<StreamingUpdateResult | undefined> =
  core.updateView(view, oldCallbackShape);

const pointQueryOptions: CopcPointQueryOptions = {
  region: {
    coordinateSystem: "copc-source",
    min: { x: 100, y: 200, z: 0 },
    max: { x: 120, y: 240, z: 30 },
  },
  mode: "cache-only",
  maxDepth: 4,
};
const pointQuery = core.queryPoints(pointQueryOptions);
const pointQuerySummary: Promise<CopcPointQuerySummary> = pointQuery.result;
void pointQuerySummary;
const layerPointQuery = minimalLayer.queryPoints(pointQueryOptions);
void layerPointQuery;

async function consumeOldResultShape(): Promise<void> {
  const result = await oldResultShape;
  if (!result) return;

  const oldMapShape: Map<string, PreparedPointData> =
    result.loadedNodePoints;
  const prepared = oldMapShape.get("0-0-0-0");
  if (prepared) {
    const sourceCoordinates: Float64Array = prepared.sourceCoordinates;
    const geographicCoordinates: Float64Array = prepared.coordinates;
    void [sourceCoordinates, geographicCoordinates];
  }
}

void consumeOldResultShape;
