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
import type {
  CopcCrsMetadataDiagnostic,
  CopcCrsWktProvenance,
} from '../../coordinates/crs/copcCrsMetadata';

/**
 * COPC metadata expressed in the source coordinate system declared by the
 * dataset's CRS. Bounds and cube coordinates are not necessarily metres.
 */
export type CopcMetadata = {
  /** Total number of points declared by the COPC source. */
  pointCount: number;
  /** Axis-aligned source-coordinate bounds from the COPC metadata. */
  bounds: {
    /** Minimum X in source CRS units. */
    minX: number;
    /** Minimum Y in source CRS units. */
    minY: number;
    /** Minimum Z in source CRS vertical units. */
    minZ: number;
    /** Maximum X in source CRS units. */
    maxX: number;
    /** Maximum Y in source CRS units. */
    maxY: number;
    /** Maximum Z in source CRS vertical units. */
    maxZ: number;
  };
  /** Nominal point spacing in source coordinate units, when supplied. */
  spacing?: number;
  /** LAS coordinate scale factors applied to stored integer coordinates. */
  scale?: {
    /** X scale in source CRS units per stored integer unit. */
    x: number;
    /** Y scale in source CRS units per stored integer unit. */
    y: number;
    /** Z scale in source CRS vertical units per stored integer unit. */
    z: number;
  };
  /** LAS coordinate offsets in source CRS units. */
  offset?: {
    /** X offset in source CRS units. */
    x: number;
    /** Y offset in source CRS units. */
    y: number;
    /** Z offset in source CRS vertical units. */
    z: number;
  };
  /** COPC root cube in source coordinate units. */
  cube: {
    /** Minimum X of the root cube in source CRS units. */
    minX: number;
    /** Minimum Y of the root cube in source CRS units. */
    minY: number;
    /** Minimum Z of the root cube in source CRS vertical units. */
    minZ: number;
    /** Maximum X of the root cube in source CRS units. */
    maxX: number;
    /** Maximum Y of the root cube in source CRS units. */
    maxY: number;
    /** Maximum Z of the root cube in source CRS vertical units. */
    maxZ: number;
  };
  /** CRS WKT retained from the source metadata, when present. */
  wkt?: string;
  /**
   * Backend-neutral interpretation of source CRS metadata, when provided by a
   * built-in backend. It reports source evidence and never infers CRS from
   * coordinate ranges or the adapter's WGS84 output.
   */
  crsDiagnostic?: CopcCrsMetadataDiagnostic;
  /** Where source CRS WKT was found and whether VLR/EVLR values conflicted. */
  crsWktProvenance?: CopcCrsWktProvenance;
};

/** One decoded point in the COPC source CRS; axis units are CRS-defined. */
export type CopcPoint = {
  /** Source CRS X coordinate. */
  x: number;
  /** Source CRS Y coordinate. */
  y: number;
  /** Source CRS Z coordinate in its declared vertical units. */
  z: number;
};

/**
 * Per-point values of a non-standard schema dimension, such as LAS extra bytes.
 * 64-bit integer dimensions stay exact as BigInt arrays instead of being
 * narrowed to a double.
 */
export type CopcExtraDimensionValues = Float64Array | BigInt64Array | BigUint64Array;

/** Point attributes decoded from fields requested from the COPC source. */
export type CopcPointAttributes = {
  /** Raw LAS intensity values; no display normalization is applied. */
  intensity?: Uint16Array;
  /** Raw LAS classification codes. */
  classification?: Uint8Array;
  /** Raw red channel values in the source point format. */
  red?: Uint16Array;
  /** Raw green channel values in the source point format. */
  green?: Uint16Array;
  /** Raw blue channel values in the source point format. */
  blue?: Uint16Array;
  /** Requested extra schema dimensions keyed by dimension name. */
  extraDimensions?: Readonly<Record<string, CopcExtraDimensionValues>>;
};

/** Decoded point records in their original COPC source coordinate space. */
export type CopcPointBuffer = {
  /** Number of points represented by the packed coordinate triples. */
  pointCount: number;
  /** Interleaved source CRS XYZ triples, three values per point. */
  coordinates: Float64Array;
  /** Decoded COPC/source XYZ; absent only for legacy injected decoders. */
  coordinateSystem?: 'copc-source';
  /** Optional per-point attributes, in arrays parallel to the point indices. */
  attributes?: CopcPointAttributes;
};

/** WGS84 geographic position with angular longitude/latitude and metric height. */
export type GeographicPoint = {
  /** WGS84 longitude in degrees, in the conventional [-180, 180] range. */
  longitude: number;
  /** WGS84 latitude in degrees, in the conventional [-90, 90] range. */
  latitude: number;
  /** WGS84 ellipsoidal height in metres. */
  height: number;
};

/** Geographic camera position using WGS84 longitude/latitude and ellipsoidal height. */
export type GeographicCamera = GeographicPoint;

/** Point buffer exposing WGS84 geographic coordinates and optional retained spaces. */
export type GeographicPointBuffer = {
  /** Number of points represented by `coordinates`. */
  pointCount: number;
  /** Interleaved longitude (degrees), latitude (degrees), height (metres) triples. */
  coordinates: Float64Array;
  /** Geographic triples; retained as `coordinates` for Cesium compatibility. */
  coordinateSystem?: 'wgs84-geographic';
  /** Source/project-coordinate XYZ retained after the shared transform. */
  sourceCoordinates?: Float64Array;
  /** Label for `sourceCoordinates`; values use source CRS units. */
  sourceCoordinateSystem?: 'copc-source';
  /** WGS84 Earth-centered, Earth-fixed metres from the same shared transform. */
  worldCoordinates?: Float64Array;
  /** Label for `worldCoordinates`; values use ECEF metre axes. */
  worldCoordinateSystem?: 'wgs84-ecef-meters';
  /** Requested attributes for these point indices. */
  attributes?: CopcPointAttributes;
  /** Statistics prepared once with the renderer-neutral point data. */
  statistics?: PreparedPointStatistics;
};

/** Precomputed color/display ranges retained with prepared point data. */
export type PreparedPointStatistics = {
  /** WGS84 geographic ellipsoidal height range in metres. */
  elevation?: {
    /** Lowest prepared point height in metres. */
    min: number;
    /** Highest prepared point height in metres. */
    max: number;
  };
  /** Raw source intensity minimum and maximum. */
  intensity?: {
    /** Lowest decoded intensity value. */
    min: number;
    /** Highest decoded intensity value. */
    max: number;
  };
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
  /** Number of points shared by all coordinate buffers. */
  pointCount: number;
  /** Decoded coordinates in the COPC source CRS and its axis units. */
  source: CoordinateBuffer<'copc-source'>;
  /** WGS84 longitude/latitude in degrees and ellipsoidal height in metres. */
  geographic: CoordinateBuffer<'wgs84-geographic'>;
  /** WGS84 Earth-centred, Earth-fixed XYZ coordinates in metres. */
  world: CoordinateBuffer<'wgs84-ecef-meters'>;
  /** Requested source attributes, when any were decoded. */
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
  statistics: PreparedPointStatistics;
  coordinates: Float64Array;
  coordinateSystem: 'wgs84-geographic';
  sourceCoordinates: Float64Array;
  sourceCoordinateSystem: 'copc-source';
  worldCoordinates: Float64Array;
  worldCoordinateSystem: 'wgs84-ecef-meters';
};

/** A decoded point collection with indexed readers for requested dimensions. */
export type CopcPointView = {
  /** Number of decoded points available through this view. */
  pointCount: number;
  /** Fields that are both requested and available in the source point format. */
  availableFields: CopcPointFieldSelection;
  /**
   * Create a reader for one requested and available point component.
   *
   * @param component Component to read from each point.
   * @returns A function that reads the component at a zero-based point index.
   */
  getter(component: CopcPointComponent): (index: number) => number;
  /** Readers for the requested extra schema dimensions present in the source. */
  extraDimensions?: ReadonlyMap<string, CopcExtraDimensionReader>;
};

/** Reads one extra schema dimension of a decoded point view by point index. */
export type CopcExtraDimensionReader = {
  /** Numeric representation retained by the decoder for this dimension. */
  readonly valueType: 'float64' | 'int64' | 'uint64';
  /** Read a dimension value by zero-based point index. */
  read(index: number): number | bigint;
};
