import type { GeographicPointBuffer } from '../../copc/types/copc';
import {
  prepareCopcPointColorBuffer,
  type CopcPointStyleInput,
} from '../../point/style/pointStyle';

export type CopcThreePointStyleOptions = CopcPointStyleInput & {
  /** Screen-space point size in pixels. */
  pointSize: number;
};

/**
 * Three.js MVP uses fixed-size points so `pointSize` retains the Cesium API's
 * screen-facing pixel meaning across camera distances.
 */
export const THREE_POINT_SIZE_ATTENUATION = false;

export type CopcThreePointsMaterialOptions = {
  size: number;
  sizeAttenuation: typeof THREE_POINT_SIZE_ATTENUATION;
  vertexColors: true;
  transparent: true;
  opacity: number;
};

/**
 * Prepare the `color` BufferAttribute data consumed by a Three.js node.
 * Three.js can attach this array directly with `new BufferAttribute(colors, 3)`.
 */
export function prepareThreePointColorBuffer(
  points: GeographicPointBuffer,
  options: CopcPointStyleInput = {},
): Float32Array {
  return prepareCopcPointColorBuffer(points, options);
}

/**
 * Explicit `THREE.PointsMaterial` settings for the MVP styling contract.
 * The shape intentionally avoids importing Three.js into the shared core.
 */
export function getThreePointsMaterialOptions(
  pointSize: number,
): CopcThreePointsMaterialOptions {
  return {
    size: pointSize,
    sizeAttenuation: THREE_POINT_SIZE_ATTENUATION,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
  };
}

export type { CopcPointStyleInput, CopcValueRange } from '../../point/style/pointStyle';
