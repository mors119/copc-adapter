import * as Cesium from 'cesium';

export function renderSinglePoint(viewer: Cesium.Viewer) {
  viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(127.0, 37.5, 1000),
    point: {
      pixelSize: 10,
      color: Cesium.Color.YELLOW,
    },
  });

  viewer.zoomTo(viewer.entities);
}
