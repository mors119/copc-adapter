import * as Cesium from "cesium";

export function createCesiumViewer(
  container: string | HTMLElement,
  options: {
    scene3DOnly?: boolean;
    useBrowserRecommendedResolution?: boolean;
    terrainProvider?: Cesium.TerrainProvider;
    preserveDrawingBuffer?: boolean;
  } = {},
): Cesium.Viewer {
  return new Cesium.Viewer(container, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    scene3DOnly: options.scene3DOnly ?? false,
    ...(options.preserveDrawingBuffer === undefined
      ? {}
      : { contextOptions: { webgl: { preserveDrawingBuffer: options.preserveDrawingBuffer } } }),
    ...(options.terrainProvider === undefined
      ? {}
      : { terrainProvider: options.terrainProvider }),
    ...(options.useBrowserRecommendedResolution === undefined
      ? {}
      : {
          useBrowserRecommendedResolution:
            options.useBrowserRecommendedResolution,
        }),
  });
}
