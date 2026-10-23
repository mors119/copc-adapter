import type {
  CopcPointAttributes,
  PreparedPointData,
  PreparedPointStatistics,
} from "../copc/types/copc";
import { ecefToGeographic } from "../coordinates/transform/worldCoordinates";
import type { VerticalGridValueUnit } from "../coordinates/transform/verticalGrid";
import {
  assertPreparedPointData,
  createPreparedPointData,
} from "./preparedPoint";

/** Provenance retained with one experimental E cache entry. */
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

/**
 * Experimental internal E cache value. `ecef` and `height` are the compact
 * 32-byte-per-point coordinate/height representation. Exact Source XYZ stays
 * in a separate compatibility sidecar because synchronous public inspection
 * getters require it; ECEF cannot recover the source CRS values.
 *
 * Point identity is `(nodeKey, zero-based point index)`. `ecef` aliases the
 * prepared ECEF backing store, while `height` is copied from the same prepared
 * transform result without changing Float64 precision.
 */
export type CompactEPointCacheNode = {
  layout: "E";
  nodeKey: string;
  pointCount: number;
  /** Interleaved WGS84 ECEF XYZ in metres; three Float64 values per point. */
  ecef: Float64Array;
  /** Prepared display/ellipsoidal height in metres; one Float64 per point. */
  height: Float64Array;
  attributes?: CopcPointAttributes;
  statistics: PreparedPointStatistics;
  /** Compatibility-only exact source values, stored outside E's 32 B/point. */
  sourceCompatibility: Float64Array;
  provenance: CompactEPointProvenance;
};

/** Values accepted by the internal point cache during experimental rollout. */
export type CachedPointData = PreparedPointData | CompactEPointCacheNode;

/** Build compact E buffers from a validated result of one transform execution. */
export function createCompactEPointCacheNode(
  prepared: PreparedPointData,
  input: {
    nodeKey: string;
    provenance: CompactEPointProvenance;
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
    attributes: prepared.attributes,
    statistics: prepared.statistics,
    sourceCompatibility: prepared.source.coordinates,
    provenance: input.provenance,
  };
}

/** Return true for the internal compact E representation. */
export function isCompactEPointCacheNode(
  value: CachedPointData,
): value is CompactEPointCacheNode {
  return "layout" in value && value.layout === "E";
}

/**
 * Materialize the synchronous legacy contract without fabricating Source XYZ.
 * Geographic longitude and latitude come from inverse ECEF and can differ by
 * floating-point roundoff; longitude is inherently unrecoverable at a pole.
 * The original prepared height and exact Source values remain available.
 */
export function compactEPointCacheNodeToPreparedPointData(
  value: CompactEPointCacheNode,
): PreparedPointData {
  const geographicCoordinates = new Float64Array(value.pointCount * 3);
  for (let pointIndex = 0; pointIndex < value.pointCount; pointIndex += 1) {
    const offset = pointIndex * 3;
    const geographic = ecefToGeographic({
      x: value.ecef[offset],
      y: value.ecef[offset + 1],
      z: value.ecef[offset + 2],
    });
    geographicCoordinates[offset] = geographic.longitude;
    geographicCoordinates[offset + 1] = geographic.latitude;
    // Use the retained F64 transform result so styles and thresholds preserve
    // their prepared-height values even if the inverse ECEF calculation rounds.
    geographicCoordinates[offset + 2] = value.height[pointIndex];
  }

  return createPreparedPointData({
    pointCount: value.pointCount,
    sourceCoordinates: value.sourceCompatibility,
    geographicCoordinates,
    worldCoordinates: value.ecef,
    attributes: value.attributes,
    statistics: value.statistics,
  });
}

/** Adapt either cache layout to the existing renderer and public contract. */
export function cachedPointDataToPreparedPointData(
  value: CachedPointData,
): PreparedPointData {
  return isCompactEPointCacheNode(value)
    ? compactEPointCacheNodeToPreparedPointData(value)
    : value;
}
