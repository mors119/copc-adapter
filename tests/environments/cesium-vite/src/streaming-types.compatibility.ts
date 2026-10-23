import {
  CopcCesiumLayer,
  CopcStreamingCore,
} from "@frillab/copc-adapter/cesium";
import type {
  CopcCesiumLayerOptions,
  CopcStreamingProgressHandler,
  StreamingProgress,
  StreamingUpdateResult,
  StreamingView,
  PreparedPointData,
  CopcStreamingControllerOptions,
} from "@frillab/copc-adapter/cesium";

declare const core: CopcStreamingCore;
declare const view: StreamingView;
declare const options: CopcStreamingControllerOptions;
declare const viewer: import("cesium").Viewer;

const layerOptions: CopcCesiumLayerOptions = {
  url: "https://example.com/data.copc.laz",
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
await minimalLayer.load();
minimalLayer.attachTo(viewer);
minimalLayer.destroy();

// The public constructor is bound to A; E selection stays on its internal
// factory.
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
