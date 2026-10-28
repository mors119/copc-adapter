import * as Cesium from "cesium";

const sourceUrl = "memory://packed-terrain-alignment-fixture.copc.laz";
// EPSG:4979 declares latitude, longitude, height axis order in the WKT below.
const sourceCoordinates = new Float64Array([
  44.5, -122.5, 100,
  44.51, -122.49, 101,
]);
const metadata = {
  pointCount: 2,
  bounds: {
    minX: 44.5,
    minY: -122.5,
    minZ: 100,
    maxX: 44.51,
    maxY: -122.49,
    maxZ: 101,
  },
  cube: {
    minX: 44.5,
    minY: -122.5,
    minZ: 100,
    maxX: 44.51,
    maxY: -122.49,
    maxZ: 101,
  },
  wkt: 'GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]],ID["EPSG",6326]],CS[ellipsoidal,3],AXIS["geodetic latitude (Lat)",north,ORDER[1],ANGLEUNIT["degree",0.0174532925199433]],AXIS["geodetic longitude (Lon)",east,ORDER[2],ANGLEUNIT["degree",0.0174532925199433]],AXIS["ellipsoidal height (h)",up,ORDER[3],LENGTHUNIT["metre",1]],ID["EPSG",4979]]',
};
const node = {
  key: "0-0-0-0",
  level: 0,
  x: 0,
  y: 0,
  z: 0,
  pointCount: 2,
  pointDataOffset: 0,
  pointDataLength: 1,
};

function createBackend() {
  return {
    async open(source) {
      return {
        source: typeof source === "string" ? source : "WGS84 test COPC",
        getMetadata: () => metadata,
        getRootHierarchyPage: () => ({
          key: node.key,
          pageOffset: 0,
          pageLength: 1,
        }),
        async loadHierarchyPage() {
          return { nodes: [node], pages: [] };
        },
        async loadPointDataView(_node, fields) {
          return {
            pointCount: node.pointCount,
            availableFields: fields,
            getter(component) {
              const coordinateIndex =
                component === "x" ? 0 : component === "y" ? 1 : 2;
              return (pointIndex) =>
                sourceCoordinates[pointIndex * 3 + coordinateIndex];
            },
          };
        },
      };
    },
  };
}

function createDecoder() {
  return {
    async decode(view) {
      return {
        pointCount: view.pointCount,
        coordinates: sourceCoordinates.slice(),
        attributes: { classification: new Uint8Array([2, 2]) },
      };
    },
  };
}

function createTerrainProvider(heightMeters) {
  const tilingScheme = new Cesium.GeographicTilingScheme();
  const maximumLevel = 6;
  const availability = new Cesium.TileAvailability(
    tilingScheme,
    maximumLevel,
  );
  for (let level = 0; level <= maximumLevel; level += 1) {
    availability.addAvailableTileRange(
      level,
      0,
      0,
      tilingScheme.getNumberOfXTilesAtLevel(level) - 1,
      tilingScheme.getNumberOfYTilesAtLevel(level) - 1,
    );
  }

  const provider = {
    availability,
    tilingScheme,
    hasWaterMask: false,
    hasVertexNormals: false,
    errorEvent: new Cesium.Event(),
    credit: undefined,
    ready: true,
    readyPromise: Promise.resolve(true),
    getLevelMaximumGeometricError(level) {
      return (
        Cesium.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
          Cesium.Ellipsoid.WGS84,
          16,
          tilingScheme.getNumberOfXTilesAtLevel(0),
        ) / 2 ** level
      );
    },
    getTileDataAvailable() {
      return true;
    },
    loadTileDataAvailability() {
      return undefined;
    },
    requestTileGeometry() {
      return Promise.resolve(
        new Cesium.HeightmapTerrainData({
          buffer: new Float32Array(16 * 16).fill(heightMeters),
          width: 16,
          height: 16,
          childTileMask: 15,
          structure: { heightScale: 1, heightOffset: 0 },
        }),
      );
    },
  };
  Object.defineProperty(provider, "constructor", {
    value: { name: "PackedConsumerTerrainFixture" },
  });
  return provider;
}

/** Create a small WGS 84 ellipsoidal COPC source and deterministic Terrain provider. */
export function createTerrainAlignmentFixture(heightMeters) {
  return {
    sourceUrl,
    backend: createBackend(),
    decoder: createDecoder(),
    terrainProvider: createTerrainProvider(heightMeters),
  };
}
