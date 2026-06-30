import * as Cesium from 'cesium';

export function createCesiumViewer(containerId: string): Cesium.Viewer {
  return new Cesium.Viewer(containerId, {
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
