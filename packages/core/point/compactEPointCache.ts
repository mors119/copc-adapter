import type {
  CopcPointAttributes,
  GeographicPointBuffer,
  PreparedPointData,
  PreparedPointStatistics,
} from "../copc/types/copc";
import type { VerticalGridValueUnit } from "../coordinates/transform/verticalGrid";
import { assertPreparedPointData } from "./preparedPoint";

const compactEHeightsByPreparedView = new WeakMap<
  PreparedPointData,
  Float64Array
>();

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
 * Experimental internal E cache value. `ecef` and `height` are 32 bytes per
 * point. The exact legacy compatibility view retains the original Source and
 * Geographic arrays too, making the actual retained coordinate footprint
 * 80 bytes per point before attributes. This is an explicitly documented
 * compatibility path, not a compact retained-cache result. Synchronous
 * coordinate getters require those exact values, which ECEF cannot recover.
 * Keep production A as the default until those APIs have a compatible
 * migration path.
 *
 * Point identity is `(nodeKey, zero-based point index)`. `ecef` aliases the
 * prepared ECEF backing store, while `height` is copied from the same prepared
 * transform result without changing Float64 precision. The compatibility view
 * keeps the existing synchronous coordinate APIs exact and aliases the
 * original prepared coordinate arrays.
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
  /** Exact legacy coordinate contract retained for synchronous public reads. */
  preparedCompatibility: PreparedPointData;
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

  const preparedCompatibility = { ...prepared };
  compactEHeightsByPreparedView.set(preparedCompatibility, height);

  return {
    layout: "E",
    nodeKey: input.nodeKey,
    pointCount: prepared.pointCount,
    ecef: prepared.world.coordinates,
    height,
    attributes: prepared.attributes,
    statistics: prepared.statistics,
    preparedCompatibility,
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
 * Return the exact legacy renderer/inspection view. Its source, geographic,
 * and world arrays alias the prepared transform result; no coordinate
 * reconstruction or per-load array allocation occurs.
 */
export function compactEPointCacheNodeToPreparedPointData(
  value: CompactEPointCacheNode,
): PreparedPointData {
  return value.preparedCompatibility;
}

/** Return the E cache's exact prepared height for a legacy prepared view. */
export function getCompactEPreparedHeightBuffer(
  points: GeographicPointBuffer,
): Float64Array | undefined {
  return compactEHeightsByPreparedView.get(
    points as PreparedPointData,
  );
}

/** Adapt either cache layout to the existing renderer and public contract. */
export function cachedPointDataToPreparedPointData(
  value: CachedPointData,
): PreparedPointData {
  return isCompactEPointCacheNode(value)
    ? compactEPointCacheNodeToPreparedPointData(value)
    : value;
}
