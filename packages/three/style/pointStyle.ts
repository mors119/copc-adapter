import type { GeographicPointBuffer } from "../../core/copc/types/copc";
import type { RenderablePointData } from "../../core/point/compactEPointCache";
import {
  prepareCopcPointColorBuffer,
  type CopcPointStyleInput,
  type CopcPointStyleState,
} from "../../core/point/style/pointStyle";

/** Style inputs plus the Three.js point diameter in screen-space pixels. */
export type CopcThreePointStyleOptions = CopcPointStyleInput & {
  /** Screen-space point size in pixels. */
  pointSize: number;
};

/** Three.js world-distance size scaling is disabled to retain pixel-sized points. */
export const THREE_POINT_SIZE_ATTENUATION = false;

/** Material settings produced by {@link getThreePointsMaterialOptions}. */
export type CopcThreePointsMaterialOptions = {
  /** Point diameter in screen-space pixels. */
  size: number;
  /** Fixed-size behavior matching {@link THREE_POINT_SIZE_ATTENUATION}. */
  sizeAttenuation: typeof THREE_POINT_SIZE_ATTENUATION;
  /** Whether the material reads per-vertex point colors. */
  vertexColors: true;
  /** Whether alpha blending is enabled. */
  transparent: true;
  /** Fixed alpha used by the adapter's point style. */
  opacity: number;
};

/**
 * Prepare the `color` BufferAttribute data consumed by a Three.js node.
 * Three.js can attach this array directly with `new BufferAttribute(colors, 3)`.
 * A renderer should create one `CopcPointStyleState` per layer and pass it for
 * every node so streamed nodes share one RGB display scale.
 */
export function prepareThreePointColorBuffer(
  points: GeographicPointBuffer | RenderablePointData,
  options: CopcPointStyleInput = {},
  state?: CopcPointStyleState,
): Float32Array {
  return prepareCopcPointColorBuffer(points, options, state);
}

/**
 * Explicit `THREE.PointsMaterial` settings for the MVP styling contract.
 * The shape intentionally avoids importing Three.js into the shared core.
 *
 * @param pointSize Screen-facing point size in pixels.
 * @param opacity Uniform material alpha in `[0, 1]`; defaults to `0.9`.
 * @returns Settings for one layer-owned `THREE.PointsMaterial`.
 */
export function getThreePointsMaterialOptions(
  pointSize: number,
  opacity = 0.9,
): CopcThreePointsMaterialOptions {
  return {
    size: pointSize,
    sizeAttenuation: THREE_POINT_SIZE_ATTENUATION,
    vertexColors: true,
    transparent: true,
    opacity,
  };
}

export type {
  CopcPointStyleInput,
  CopcPointStyleState,
  CopcValueRange,
} from "../../core/point/style/pointStyle";
