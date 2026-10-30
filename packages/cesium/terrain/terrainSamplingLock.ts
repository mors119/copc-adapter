import type * as Cesium from "cesium";

const activeViewerSamples = new WeakSet<Cesium.Viewer>();

/** Claim the one-at-a-time Terrain sampling slot shared by alignment estimators. */
export function acquireTerrainSamplingSlot(viewer: Cesium.Viewer): boolean {
  if (activeViewerSamples.has(viewer)) return false;
  activeViewerSamples.add(viewer);
  return true;
}

/** Release a Terrain sampling slot after the underlying Cesium request settles. */
export function releaseTerrainSamplingSlot(viewer: Cesium.Viewer): void {
  activeViewerSamples.delete(viewer);
}
