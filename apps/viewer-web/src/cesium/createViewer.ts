import * as Cesium from 'cesium';

export async function createCesiumViewer(containerId: string) {
  const viewer = new Cesium.Viewer(containerId, {
    terrainProvider: await Cesium.createWorldTerrainAsync(),
    animation: false,
    timeline: false,
  });

  viewer.scene.globe.depthTestAgainstTerrain = true;

  return viewer;
}
