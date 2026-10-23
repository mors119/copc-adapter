import { CopcStreamingCore } from "@frillab/copc-adapter/cesium";
import type {
  CopcStreamingProgressHandler,
  StreamingProgress,
  StreamingUpdateResult,
  StreamingView,
} from "@frillab/copc-adapter/cesium";
import type { PreparedPointData } from "@frillab/copc-adapter/cesium";

declare const core: CopcStreamingCore;
declare const view: StreamingView;

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
