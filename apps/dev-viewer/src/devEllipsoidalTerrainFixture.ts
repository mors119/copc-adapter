import type {
  CopcBackendSelection,
  CopcPointDecoder,
} from "@frillab/copc-adapter/cesium";

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

/** Tiny deterministic source for the Dev Viewer browser terrain workflow. */
export function createDevEllipsoidalTerrainFixture(): {
  backend: CopcBackendSelection;
  decoder: CopcPointDecoder;
} {
  const backend: CopcBackendSelection = {
    async open(source) {
      const sourceId = typeof source === "string" ? source : "WGS84 test COPC";
      return {
        source: sourceId,
        getMetadata: () => metadata,
        getRootHierarchyPage: () => ({
          key: node.key,
          pageOffset: 0,
          pageLength: 1,
        }),
        async loadHierarchyPage() {
          return { nodes: [node], pages: [] };
        },
        async loadPointDataView(_requestedNode, fields) {
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
        destroy() {},
      };
    },
  };

  const decoder: CopcPointDecoder = {
    async decode(view) {
      return {
        pointCount: view.pointCount,
        coordinates: sourceCoordinates.slice(),
        attributes: { classification: new Uint8Array([2, 2]) },
      };
    },
  };

  return { backend, decoder };
}
