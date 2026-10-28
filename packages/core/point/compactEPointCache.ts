import type {
  CopcPointAttributes,
  GeographicPointBuffer,
  PreparedPointData,
  PreparedPointStatistics,
} from "../copc/types/copc";
import type { VerticalGridValueUnit } from "../coordinates/transform/verticalGrid";
import { assertPreparedPointData } from "./preparedPoint";

/** Provenance retained with one compact E cache entry. */
export type CompactEPointProvenance = {
  /** Source identity from the opened COPC resource. */
  sourceIdentity: string;
  /** Original source CRS definition, when present in COPC metadata. */
  sourceCrsWkt?: string;
  /** Core load generation that prepared this entry. */
  transformGeneration: number;
  /** Additive correction already included in `height`, in metres. */
  heightOffsetMeters: number;
  /** A verified grid correction or an explicit unverified datum state. */
  verticalDatum:
    | {
        status: "validated-grid-applied";
        gridId: string;
        sha256: string;
        sourceVerticalCrs: string;
        targetVerticalCrs: "EPSG:4979";
        valueUnit: VerticalGridValueUnit;
      }
    | { status: "no-validated-grid-correction" };
};

/** Internal E-cache policy for exact coordinate spaces needed by a consumer. */
export type CompactECoordinateRetention = Readonly<{
  /** Retain the exact original source-CRS XYZ buffer. Defaults to false. */
  sourceCoordinates?: boolean;
  /** Retain the exact prepared WGS84 longitude/latitude/height buffer. Defaults to false. */
  geographicCoordinates?: boolean;
}>;

/**
 * Experimental internal E cache value. Its base coordinate/height buffers are
 * ECEF XYZ and prepared display height, totaling 32 bytes per point. Exact
 * Source and Geographic arrays are retained independently only when explicitly
 * requested by an internal consumer policy. Point identity is
 * `(nodeKey, zero-based array index)`.
 */
export type CompactEPointCacheNode = {
  layout: "E";
  nodeKey: string;
  pointCount: number;
  /** Interleaved WGS84 ECEF XYZ in metres; three Float64 values per point. */
  ecef: Float64Array;
  /** Prepared display/ellipsoidal height in metres; one Float64 per point. */
  height: Float64Array;
  /** Exact source XYZ, retained only when explicitly requested. */
  sourceCoordinates?: Float64Array;
  /** Exact prepared geographic triples, retained only when explicitly requested. */
  geographicCoordinates?: Float64Array;
  attributes?: CopcPointAttributes;
  statistics: PreparedPointStatistics;
  provenance: CompactEPointProvenance;
};

/** Data accepted by the renderer boundary; E is selected only internally. */
export type RenderablePointData = PreparedPointData | CompactEPointCacheNode;

/** Values accepted by the internal point cache during experimental rollout. */
export type CachedPointData = RenderablePointData;

/** Build compact E buffers from a validated result of one transform execution. */
export function createCompactEPointCacheNode(
  prepared: PreparedPointData,
  input: {
    nodeKey: string;
    provenance: CompactEPointProvenance;
    /** Optional exact coordinate buffers required by a selected consumer policy. */
    retain?: CompactECoordinateRetention;
  },
): CompactEPointCacheNode {
  assertPreparedPointData(prepared);
  if (!input.nodeKey) {
    throw new TypeError("Compact E cache entries require a node key");
  }

  const height = new Float64Array(prepared.pointCount);
  for (let pointIndex = 0; pointIndex < prepared.pointCount; pointIndex += 1) {
    height[pointIndex] = prepared.geographic.coordinates[pointIndex * 3 + 2];
  }

  return {
    layout: "E",
    nodeKey: input.nodeKey,
    pointCount: prepared.pointCount,
    ecef: prepared.world.coordinates,
    height,
    ...(input.retain?.sourceCoordinates
      ? { sourceCoordinates: prepared.source.coordinates }
      : {}),
    ...(input.retain?.geographicCoordinates
      ? { geographicCoordinates: prepared.geographic.coordinates }
      : {}),
    attributes: prepared.attributes,
    statistics: prepared.statistics,
    provenance: input.provenance,
  };
}

/** Return true for the internal compact E representation. */
export function isCompactEPointCacheNode(
  value: RenderablePointData | GeographicPointBuffer,
): value is CompactEPointCacheNode {
  return "layout" in value && value.layout === "E";
}

/** Return the E height buffer when present; A continues to use geographic Z. */
export function getPreparedHeightBuffer(
  points: RenderablePointData | GeographicPointBuffer,
): Float64Array | undefined {
  return isCompactEPointCacheNode(points) ? points.height : undefined;
}

/** Return one point's prepared height from either internal cache layout. */
export function getPreparedPointHeight(
  points: RenderablePointData | GeographicPointBuffer,
  pointIndex: number,
): number {
  if (isCompactEPointCacheNode(points)) {
    return points.height[pointIndex];
  }
  return points.coordinates[pointIndex * 3 + 2];
}

/** Return the ECEF buffer for either cache layout without creating an alias. */
export function getPreparedWorldCoordinateBuffer(
  points: RenderablePointData | GeographicPointBuffer,
): Float64Array | undefined {
  if (isCompactEPointCacheNode(points)) return points.ecef;
  return points.worldCoordinates;
}

/** Pass the cache-owned E or A representation directly to renderer consumers. */
export function cachedPointDataToRenderablePointData(
  value: CachedPointData,
): RenderablePointData {
  return value;
}

/** Guard synchronous legacy coordinate APIs against incomplete E data. */
export function assertLegacyCoordinatesAvailable(
  value: RenderablePointData,
): asserts value is PreparedPointData {
  if (isCompactEPointCacheNode(value)) {
    throw new Error(
      "The complete synchronous PreparedPointData contract is unavailable for E cache entries; use coordinateCacheLayout: 'A' for legacy coordinate APIs.",
    );
  }
}
