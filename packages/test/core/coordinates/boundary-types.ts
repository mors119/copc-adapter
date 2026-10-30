import { intersectsViewFrustum } from "../../../index";
import type {
  CopcCesiumLayerOptions,
  CopcCesiumPointStyleUpdate,
  CopcElevationStyle,
  CopcHierarchyQuery,
  ViewFrustum,
} from "../../../index";
import type { CopcThreeLayerOptions } from "../../../three";

const legacyHierarchyQuery: CopcHierarchyQuery = {
  bounds: {
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 1,
    maxY: 1,
    maxZ: 1,
  },
};

const legacyBoundingSphere = {
  center: { x: 0, y: 0, z: 5 },
  radiusMeters: 1,
};

declare const frustum: ViewFrustum;
intersectsViewFrustum(frustum, legacyBoundingSphere);

void legacyHierarchyQuery;

const elevationStyle: CopcElevationStyle = {
  interpolation: "step",
  palette: [
    { position: 0, color: { red: 0, green: 0, blue: 0.3 } },
    { position: 1, color: { red: 1, green: 0, blue: 0 } },
  ],
};
const cesiumElevationOptions: CopcCesiumLayerOptions = {
  url: "https://example.com/sample.copc.laz",
  colorMode: "elevation",
  elevationRange: { min: -10, max: 100 },
  elevationStyle,
};
const cesiumElevationUpdate: CopcCesiumPointStyleUpdate = {
  elevationRange: null,
  elevationStyle: null,
};
const threeElevationOptions: CopcThreeLayerOptions = {
  url: "https://example.com/sample.copc.laz",
  colorMode: "elevation",
  elevationRange: { min: -10, max: 100 },
  elevationStyle,
};

void cesiumElevationOptions;
void cesiumElevationUpdate;
void threeElevationOptions;
