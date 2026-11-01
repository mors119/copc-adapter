import type { CopcColorMode } from "../../core/copc/points/fieldSelection";
import type {
  CopcElevationRange,
  CopcElevationStyle,
  CopcDimensionFilter,
  CopcDimensionStyle,
} from "../../core/point/style/pointStyle";

/** Include and/or exclude LAS classification codes (unsigned byte values). */
export type CopcClassificationFilter = {
  /** When present, only these classifications are visible. An empty list hides all points. */
  include?: readonly number[];
  /** These classifications are hidden after applying `include`, when present. */
  exclude?: readonly number[];
};

/** Current renderer style for a Cesium COPC layer. */
export type CopcCesiumPointStyle = {
  /** Color mapping currently applied to rendered points. */
  colorMode: CopcColorMode;
  /** Optional explicit WGS84 ellipsoidal-height range in metres. Omitted uses the dataset range. */
  elevationRange?: CopcElevationRange;
  /** Optional elevation palette; omitted preserves the existing default appearance. */
  elevationStyle?: CopcElevationStyle;
  /** Optional LAS classification visibility filter. */
  classificationFilter?: CopcClassificationFilter;
  /** Numeric dimension ramp used when `colorMode` is `dimension`. */
  dimension?: CopcDimensionStyle;
  /** Optional inclusive numeric visibility filter for a retained dimension. */
  dimensionFilter?: CopcDimensionFilter;
};

/** Partial update accepted by `CopcCesiumLayer.setStyle()`. */
export type CopcCesiumPointStyleUpdate = {
  /** New color mapping; omitted values keep the current mode. */
  colorMode?: CopcColorMode;
  /** New inclusive elevation range in displayed ellipsoidal metres; `null` restores the dataset range. */
  elevationRange?: CopcElevationRange | null;
  /** New elevation palette; `null` restores the existing default palette. */
  elevationStyle?: CopcElevationStyle | null;
  /** Pass `null` to clear the current classification filter. */
  classificationFilter?: CopcClassificationFilter | null;
  /** New dimension ramp; pass `null` to remove the stored ramp. */
  dimension?: CopcDimensionStyle | null;
  /** Pass `null` to clear the current numeric dimension filter. */
  dimensionFilter?: CopcDimensionFilter | null;
};
