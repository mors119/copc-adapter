import * as Cesium from 'cesium';
import './style.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';

const viewer = new Cesium.Viewer('cesium-container', {
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
});

viewer.entities.add({
  position: Cesium.Cartesian3.fromDegrees(127.0, 37.5, 1000),
  point: {
    pixelSize: 12,
    color: Cesium.Color.YELLOW,
  },
});

viewer.zoomTo(viewer.entities);
