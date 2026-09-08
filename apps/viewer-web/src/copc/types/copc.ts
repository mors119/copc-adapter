export type {
  CopcHierarchyNode,
  CopcHierarchyPage,
  CopcHierarchyTree,
} from '../hierarchy/types';
export type {
  CopcColorMode,
  CopcPointComponent,
  CopcPointField,
  CopcPointFieldSelection,
} from '../points/fieldSelection';
import type {
  CopcPointComponent,
  CopcPointFieldSelection,
} from '../points/fieldSelection';
import type { CoordinateBuffer } from '../../coordinates/types';

export type CopcMetadata = {
  pointCount: number;
  bounds: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
  spacing?: number;
  scale?: {
    x: number;
    y: number;
    z: number;
  };
  offset?: {
    x: number;
    y: number;
    z: number;
  };
  cube: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
  wkt?: string;
};

export type CopcPoint = {
  x: number;
  y: number;
  z: number;
};

export type CopcPointAttributes = {
  intensity?: Uint16Array;
  classification?: Uint8Array;
  red?: Uint16Array;
  green?: Uint16Array;
  blue?: Uint16Array;
};

export type CopcPointBuffer = {
  pointCount: number;
  coordinates: Float64Array;
  /** Decoded COPC/source XYZ; absent only for legacy injected decoders. */
  coordinateSystem?: 'copc-source';
  attributes?: CopcPointAttributes;
};

export type GeographicPoint = {
  longitude: number;
  latitude: number;
  height: number;
};

export type GeographicCamera = GeographicPoint;

export type GeographicPointBuffer = {
  pointCount: number;
  coordinates: Float64Array;
  /** Geographic triples; retained as `coordinates` for Cesium compatibility. */
  coordinateSystem?: 'wgs84-geographic';
  /** Source/project-coordinate XYZ retained after the shared transform. */
  sourceCoordinates?: Float64Array;
  sourceCoordinateSystem?: 'copc-source';
  /** WGS84 Earth-centered, Earth-fixed metres from the same shared transform. */
  worldCoordinates?: Float64Array;
  worldCoordinateSystem?: 'wgs84-ecef-meters';
  attributes?: CopcPointAttributes;
  /** Statistics prepared once with the renderer-neutral point data. */
  statistics?: PreparedPointStatistics;
};

export type PreparedPointStatistics = {
  /** WGS84 geographic ellipsoidal height range in metres. */
  elevation?: { min: number; max: number };
  intensity?: { min: number; max: number };
  /** Value scale used by the source RGB attributes. */
  rgbMax?: 255 | 65535;
};

/**
 * Shared point data produced after decoding and CRS transformation.
 *
 * All coordinate arrays stay Float64 until a renderer deliberately chooses a
 * presentation format. The `geographic` member is also represented by the
 * legacy `GeographicPointBuffer` returned by `transformPointBuffer`.
 */
export type CopcPointData = {
  pointCount: number;
  source: CoordinateBuffer<'copc-source'>;
  geographic: CoordinateBuffer<'wgs84-geographic'>;
  world: CoordinateBuffer<'wgs84-ecef-meters'>;
  attributes?: CopcPointAttributes;
};

/**
 * Renderer-neutral point data retained by the shared streaming cache.
 *
 * The named coordinate buffers are the stable contract. The flat fields are
 * compatibility aliases for existing inspection and renderer APIs and point
 * at the same typed-array storage; they are not a second coordinate copy.
 * Current preparation retains source, geographic, and ECEF buffers because
 * source/geographic values remain part of the public inspection semantics and
 * ECEF is the shared render-space authority.
 */
export type PreparedPointData = CopcPointData & GeographicPointBuffer & {
  attributes: CopcPointAttributes;
  statistics: PreparedPointStatistics;
  coordinates: Float64Array;
  coordinateSystem: 'wgs84-geographic';
  sourceCoordinates: Float64Array;
  sourceCoordinateSystem: 'copc-source';
  worldCoordinates: Float64Array;
  worldCoordinateSystem: 'wgs84-ecef-meters';
};

export type CopcPointView = {
  pointCount: number;
  /** Fields that are both requested and available in the source point format. */
  availableFields: CopcPointFieldSelection;
  getter(component: CopcPointComponent): (index: number) => number;
};
