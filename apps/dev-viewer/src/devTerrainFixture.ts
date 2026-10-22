import * as Cesium from "cesium";

/** Deterministic browser-test provider with the same public sampling contract. */
export function createDevTerrainFixture(heightMeters: number): Cesium.TerrainProvider {
  const tilingScheme = new Cesium.GeographicTilingScheme();
  const maximumLevel = 6;
  const availability = new Cesium.TileAvailability(
    tilingScheme,
    maximumLevel,
  );
  for (let level = 0; level <= maximumLevel; level += 1) {
    const tilesX = tilingScheme.getNumberOfXTilesAtLevel(level);
    const tilesY = tilingScheme.getNumberOfYTilesAtLevel(level);
    availability.addAvailableTileRange(
      level,
      0,
      0,
      tilesX - 1,
      tilesY - 1,
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
    getLevelMaximumGeometricError(level: number): number {
      return (
        Cesium.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
          Cesium.Ellipsoid.WGS84,
          16,
          tilingScheme.getNumberOfXTilesAtLevel(0),
        ) / 2 ** level
      );
    },
    getTileDataAvailable(): boolean {
      return true;
    },
    loadTileDataAvailability(): undefined {
      return undefined;
    },
    requestTileGeometry(): Promise<Cesium.HeightmapTerrainData> {
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
    value: { name: "ControlledTerrainProvider" },
  });
  return provider as unknown as Cesium.TerrainProvider;
}
