import * as Cesium from 'cesium';

export function createCesiumViewer(
  container: string | HTMLElement,
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
  });
}
