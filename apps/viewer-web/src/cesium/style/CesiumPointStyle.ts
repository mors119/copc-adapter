import type { CopcColorMode } from '../../copc/points/fieldSelection';

/** Include and/or exclude LAS classification codes (unsigned byte values). */
export type CopcClassificationFilter = {
  /** When present, only these classifications are visible. An empty list hides all points. */
  include?: readonly number[];
  /** These classifications are hidden after applying `include`, when present. */
  exclude?: readonly number[];
};

/** Current renderer style for a Cesium COPC layer. */
export type CopcCesiumPointStyle = {
  colorMode: CopcColorMode;
  classificationFilter?: CopcClassificationFilter;
};

/** Partial update accepted by `CopcCesiumLayer.setStyle()`. */
export type CopcCesiumPointStyleUpdate = {
  colorMode?: CopcColorMode;
  /** Pass `null` to clear the current classification filter. */
  classificationFilter?: CopcClassificationFilter | null;
};
