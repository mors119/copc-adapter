import * as Cesium from 'cesium';

let viewer;
let tileset;

function readRenderedPixels(canvas, gl) {
  const width = canvas.width;
  const height = canvas.height;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let nonBlackPixels = 0;
  const colors = new Set();
  const colorPixels = { red: 0, green: 0, blue: 0 };
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    if (red > 20 || green > 20 || blue > 20) {
      nonBlackPixels += 1;
      colors.add(`${Math.round(red / 32)},${Math.round(green / 32)},${Math.round(blue / 32)}`);
      if (red > green * 1.5 && red > blue * 1.5) colorPixels.red += 1;
      if (green > red * 1.5 && green > blue * 1.5) colorPixels.green += 1;
      if (blue > red * 1.5 && blue > green * 1.5) colorPixels.blue += 1;
    }
  }
  return { nonBlackPixels, distinctColorBins: colors.size, colorPixels, width, height };
}

window.startCesium = async () => {
  const startedAt = performance.now();
  viewer = new Cesium.Viewer(document.getElementById('cesiumContainer'), {
    baseLayer: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    scene3DOnly: true,
    requestRenderMode: false,
    contextOptions: {
      webgl: { alpha: false, antialias: false, preserveDrawingBuffer: true },
    },
  });
  viewer.scene.globe.show = false;
  viewer.scene.backgroundColor = Cesium.Color.BLACK;
  viewer.scene.skyBox.show = false;
  viewer.scene.skyAtmosphere.show = false;
  viewer.camera.setView({
    destination: new Cesium.Cartesian3(6378155, 0, 0),
    orientation: {
      direction: new Cesium.Cartesian3(-1, 0, 0),
      up: new Cesium.Cartesian3(0, 0, 1),
    },
  });

  const loadEvents = [];
  const tileLoadError = [];
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Cesium did not finish loading the initial tile view.')), 45_000);
    viewer.scene.renderError.addEventListener((_scene, error) => {
      clearTimeout(timeout);
      reject(error);
    });
    Cesium.Cesium3DTileset.fromUrl('/fixture/tileset.json', {
      maximumScreenSpaceError: 1,
      maximumNumberOfLoadedTiles: 16,
      dynamicScreenSpaceError: false,
      foveatedScreenSpaceError: false,
    }).then((createdTileset) => {
      tileset = createdTileset;
      tileset.tileFailed.addEventListener((event) => tileLoadError.push(event.message));
      tileset.tileLoad.addEventListener((tile) => {
        loadEvents.push({
          pointsLength: tile.content.pointsLength,
          center: [tile.boundingSphere.center.x, tile.boundingSphere.center.y, tile.boundingSphere.center.z],
        });
      });
      tileset.initialTilesLoaded.addEventListener(() => {
        clearTimeout(timeout);
        resolve();
      });
      viewer.scene.primitives.add(tileset);
      viewer.scene.requestRender();
    }).catch((error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  await loaded;
  const initialTilesLoadedAt = performance.now();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  viewer.render();
  const firstRenderedFrameAt = performance.now();
  const canvas = viewer.scene.canvas;
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) throw new Error('Cesium did not create a public WebGL canvas context.');
  const response = await fetch('/__stats');
  const resources = await response.json();
  return {
    tileLoads: loadEvents,
    pointCount: loadEvents.reduce((sum, event) => sum + event.pointsLength, 0),
    tileLoadErrors: tileLoadError,
    resources,
    pixels: readRenderedPixels(canvas, gl),
    tilesLoaded: tileset.tilesLoaded,
    initialTilesLoadMilliseconds: initialTilesLoadedAt - startedAt,
    postLoadRenderMilliseconds: firstRenderedFrameAt - initialTilesLoadedAt,
  };
};

window.startCesiumUrl = async ({ tilesetUrl, originEcef, halfExtents }) => {
  const startedAt = performance.now();
  viewer = new Cesium.Viewer(document.getElementById('cesiumContainer'), {
    baseLayer: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    scene3DOnly: true,
    requestRenderMode: false,
    contextOptions: {
      webgl: { alpha: false, antialias: false, preserveDrawingBuffer: true },
    },
  });
  viewer.scene.globe.show = false;
  viewer.scene.backgroundColor = Cesium.Color.BLACK;
  viewer.scene.skyBox.show = false;
  viewer.scene.skyAtmosphere.show = false;

  const target = Cesium.Cartesian3.fromArray(originEcef);
  const radial = Cesium.Cartesian3.normalize(target, new Cesium.Cartesian3());
  const east = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(Cesium.Cartesian3.UNIT_Z, radial, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const radius = Math.hypot(...halfExtents);
  const distance = Math.max(radius * 4, 100);
  const initialPosition = Cesium.Cartesian3.add(
    target,
    Cesium.Cartesian3.multiplyByScalar(radial, distance, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const setCameraTarget = (position) => {
    const direction = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(target, position, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    const right = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.cross(direction, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    const up = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    viewer.camera.setView({ destination: position, orientation: { direction, up } });
  };
  setCameraTarget(initialPosition);

  const loadedTiles = new Map();
  const visibleTiles = new Map();
  const tileLoadErrors = [];
  const createdTileset = await Cesium.Cesium3DTileset.fromUrl(tilesetUrl, {
    maximumScreenSpaceError: 1,
    maximumNumberOfLoadedTiles: 16,
    dynamicScreenSpaceError: false,
    foveatedScreenSpaceError: false,
  });
  tileset = createdTileset;
  tileset.tileFailed.addEventListener((event) => tileLoadErrors.push(event.message));
  const tileSummary = (tile) => ({
    pointsLength: tile.content?.pointsLength ?? 0,
    center: [tile.boundingSphere.center.x, tile.boundingSphere.center.y, tile.boundingSphere.center.z],
  });
  tileset.tileLoad.addEventListener((tile) => loadedTiles.set(tile, tileSummary(tile)));
  tileset.tileVisible.addEventListener((tile) => visibleTiles.set(tile, tileSummary(tile)));
  viewer.scene.primitives.add(tileset);
  viewer.scene.requestRender();

  const waitForRealPoints = new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      const resources = await (await fetch('/__stats')).json();
      const rootSphere = tileset.root.boundingSphere;
      const position = viewer.camera.positionWC;
      const direction = viewer.camera.directionWC;
      const up = viewer.camera.upWC;
      const culling = viewer.camera.frustum.computeCullingVolume(position, direction, up);
      reject(new Error(`Cesium did not select visible Autzen point content; loaded=${JSON.stringify([...loadedTiles.values()])}; visible=${JSON.stringify([...visibleTiles.values()])}; rootSphere=${JSON.stringify({ center: [rootSphere.center.x, rootSphere.center.y, rootSphere.center.z], radius: rootSphere.radius, visibility: culling.computeVisibility(rootSphere) })}; camera=${JSON.stringify({ position: [position.x, position.y, position.z], direction: [direction.x, direction.y, direction.z], up: [up.x, up.y, up.z], canvas: [viewer.scene.canvas.width, viewer.scene.canvas.height] })}; root=${JSON.stringify({ geometricError: tileset.root.geometricError, contentAvailable: tileset.root.contentAvailable, contentReady: tileset.root.contentReady, content: tileset.root.content?.url, screenSpaceError: tileset.root.screenSpaceError })}; statistics=${JSON.stringify({ pending: tileset.statistics.numberOfPendingRequests, processing: tileset.statistics.numberOfTilesProcessing, ready: tileset.statistics.numberOfTilesWithContentReady })}; requests=${JSON.stringify(resources.httpRequests)}; failures=${JSON.stringify(tileLoadErrors)}`));
    }, 45_000);
    const check = () => {
      if ([...visibleTiles.values()].some((tile) => tile.pointsLength > 0)) {
        clearTimeout(timeout);
        resolve();
      } else if (tileLoadErrors.length > 0) {
        clearTimeout(timeout);
        reject(new Error(tileLoadErrors.join('; ')));
      }
    };
    tileset.tileLoad.addEventListener(check);
    tileset.tileVisible.addEventListener(check);
  });
  await waitForRealPoints;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  viewer.render();
  const initialVisiblePoints = [...visibleTiles.values()].reduce((sum, tile) => sum + tile.pointsLength, 0);
  const canvas = viewer.scene.canvas;
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) throw new Error('Cesium did not create a public WebGL canvas context.');
  const initialPixels = readRenderedPixels(canvas, gl);

  visibleTiles.clear();
  const movedPosition = Cesium.Cartesian3.add(
    initialPosition,
    Cesium.Cartesian3.multiplyByScalar(east, distance * 0.2, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  setCameraTarget(movedPosition);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  viewer.render();
  const movedVisiblePoints = [...visibleTiles.values()].reduce((sum, tile) => sum + tile.pointsLength, 0);
  const cartographic = Cesium.Cartographic.fromCartesian(target);
  const movedPixels = readRenderedPixels(canvas, gl);
  const resources = await (await fetch('/__stats')).json();
  return {
    loadedPoints: [...loadedTiles.values()].reduce((sum, tile) => sum + tile.pointsLength, 0),
    visiblePoints: initialVisiblePoints,
    movedVisiblePoints,
    loadedTileCenters: [...loadedTiles.values()].map((tile) => tile.center),
    visibleTileCount: visibleTiles.size,
    tileLoadErrors,
    longitudeDegrees: Cesium.Math.toDegrees(cartographic.longitude),
    latitudeDegrees: Cesium.Math.toDegrees(cartographic.latitude),
    pixels: initialPixels,
    movedPixels,
    resources,
    renderMilliseconds: performance.now() - startedAt,
  };
};

window.disposeCesium = () => {
  if (viewer && !viewer.isDestroyed()) viewer.destroy();
  return { viewerDestroyed: viewer?.isDestroyed() ?? false };
};
