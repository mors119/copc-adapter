import type { CoordinateTransformGridProvenance } from "../../coordinates/transform/coordinateTransformPlan";
import type { Wgs84EcefBounds } from "../../coordinates/types";
import type { CopcHierarchyBounds } from "../hierarchy/types";

/**
 * Stable reason codes for source cells that cannot be safely bounded.
 * Horizontal CRS/unit/axis codes describe unsupported source metadata;
 * vertical codes describe datum, grid, NoData, or grid-coverage limitations;
 * `invalid-source-cell`, `unsupported-geographic-cell`, and `numeric-range`
 * describe invalid or numerically unrepresentable regions.
 */
export type CopcConservativeBoundsUnsupportedReasonCode =
  | "unsupported-horizontal-crs"
  | "unsupported-horizontal-units"
  | "unsupported-axis-order"
  | "unsupported-coordinate-epoch"
  | "unsupported-vertical-reference"
  | "unsupported-vertical-grid"
  | "vertical-grid-has-nodata-sentinel"
  | "vertical-grid-outside-cell-coverage"
  | "invalid-source-cell"
  | "unsupported-geographic-cell"
  | "numeric-range";

type CopcConservativeBoundsProvenance = Readonly<{
  /** Stable node key whose complete source-space cell was considered. */
  nodeKey: string;
  /** Source-coordinate bounds in the COPC metadata cube's axes and units. */
  sourceCellBounds: Readonly<CopcHierarchyBounds>;
  /** Identifies `sourceCellBounds` as source CRS coordinates, not ECEF. */
  sourceCoordinateSystem: "copc-source";
  /** Source identity and lifetime generation for this result. */
  sourceIdentity: string;
  /** Unique source lifetime generation that produced the result. */
  sourceGeneration: number;
  /** Immutable transform generation and plan identity used for evaluation. */
  transformGeneration: number;
  /** Transform-plan key; this identifies inputs and is not a cryptographic hash. */
  transformPlanIdentity: string;
  /** Transform dependencies relevant to the Z interval. */
  heightOffsetMeters: number;
  /** Validated grid identity, extent, vertical CRS, and NoData provenance. */
  verticalGrid?: CoordinateTransformGridProvenance;
}>;

/**
 * Conservative WGS 84 ECEF bounds for one COPC source-space octree cell.
 *
 * A supported result covers the full cell, and therefore the spatial cells of
 * all octree descendants. A later content encoder must still enclose its own
 * reconstruction error.
 */
export type CopcConservativeBoundsResult =
  | (CopcConservativeBoundsProvenance & Readonly<{
      status: "supported";
      /** WGS 84 Earth-centred, Earth-fixed axis-aligned bounds in metres. */
      boundsEcef: Readonly<Wgs84EcefBounds>;
      /** Full cell and all geometrically nested octree descendant cells. */
      coverage: "full-source-cell-and-descendant-cells";
      /** Analytic method identifier; version changes require contract review. */
      method: "wgs84-geodetic-interval-v1";
      /** Indicates interval derivation, not a point-sampling estimate. */
      verification: "analytic-interval";
      /** Explicit source height semantics used for ECEF preparation. */
      verticalReference: "ellipsoidal" | "validated-grid";
      /** Explicit source Z unit factor applied before the vertical correction. */
      sourceVerticalUnitToMeters: number;
      /** Tile/content encoders must add their own proven reconstruction padding. */
      encoderErrorPaddingRequired: true;
      /** Preconditions used by the analytic enclosure proof. */
      assumptions: readonly string[];
    }>)
  | (CopcConservativeBoundsProvenance & Readonly<{
      status: "unsupported";
      /** Stable machine-readable reason; `reason` provides source detail. */
      reasonCode: CopcConservativeBoundsUnsupportedReasonCode;
      /** Human-readable explanation of why a safe enclosure was not returned. */
      reason: string;
    }>);
