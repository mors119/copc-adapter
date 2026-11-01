/** Inputs for a projected spacing-aware CSS-pixel point diameter. */
export type ProjectedPointSizeInput = {
  /** Approximate point spacing at this node, in metres. */
  spacingMeters: number;
  /** Absolute projection matrix Y scale. */
  projectionYScale: number;
  /** Current viewport height in CSS pixels. */
  viewportHeightCssPixels: number;
  /** View-space distance in metres; used only by perspective projection. */
  viewDepthMeters: number;
  /** Whether the current projection is perspective. */
  perspective: boolean;
  /** Lower bound in CSS pixels. */
  minPointSize: number;
  /** Upper bound in CSS pixels. */
  maxPointSize: number;
};

/** Hard upper limit for spacing-aware point diameters, in CSS pixels. */
export const MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS = 64;

/** Default lower bound for spacing-aware point diameters, in CSS pixels. */
export const DEFAULT_MIN_ATTENUATED_POINT_SIZE_CSS_PIXELS = 1;

/** Default upper bound for spacing-aware point diameters, in CSS pixels. */
export const DEFAULT_MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS = 12;

/**
 * Calculate the projected diameter of a nominal node point spacing.
 *
 * Perspective projection divides by view depth. Orthographic projection does
 * not, because its pixel scale is independent of camera distance. The result
 * is clamped before it reaches the GPU and returned in CSS pixels so callers
 * can apply the same device-pixel and rendering-resolution scale as Cesium.
 *
 * @returns A finite bounded diameter, or `undefined` for invalid inputs.
 */
export function computeProjectedPointSizeCssPixels(
  input: ProjectedPointSizeInput,
): number | undefined {
  const {
    spacingMeters,
    projectionYScale,
    viewportHeightCssPixels,
    viewDepthMeters,
    perspective,
    minPointSize,
    maxPointSize,
  } = input;
  if (
    !Number.isFinite(spacingMeters) ||
    spacingMeters <= 0 ||
    !Number.isFinite(projectionYScale) ||
    projectionYScale <= 0 ||
    !Number.isFinite(viewportHeightCssPixels) ||
    viewportHeightCssPixels <= 0 ||
    !Number.isFinite(minPointSize) ||
    minPointSize <= 0 ||
    !Number.isFinite(maxPointSize) ||
    maxPointSize < minPointSize ||
    maxPointSize > MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS ||
    (perspective && (!Number.isFinite(viewDepthMeters) || viewDepthMeters <= 0))
  ) {
    return undefined;
  }

  let projectedSize =
    spacingMeters * projectionYScale * viewportHeightCssPixels * 0.5;
  if (perspective) projectedSize /= viewDepthMeters;
  if (!Number.isFinite(projectedSize)) return undefined;
  return Math.min(maxPointSize, Math.max(minPointSize, projectedSize));
}
