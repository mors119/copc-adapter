import type { CopcColorMode } from '../../core/copc/points/fieldSelection';

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
  /** Optional LAS classification visibility filter. */
  classificationFilter?: CopcClassificationFilter;
};

/** Partial update accepted by `CopcCesiumLayer.setStyle()`. */
export type CopcCesiumPointStyleUpdate = {
  /** New color mapping; omitted values keep the current mode. */
  colorMode?: CopcColorMode;
  /** Pass `null` to clear the current classification filter. */
  classificationFilter?: CopcClassificationFilter | null;
};
