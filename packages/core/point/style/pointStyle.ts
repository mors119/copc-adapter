import type { CopcColorMode } from "../../copc/points/fieldSelection";
import type {
  CopcExtraDimensionMetadata,
  CopcMetadata,
  CopcPointAttributes,
  GeographicPointBuffer,
} from "../../copc/types/copc";
import type { RenderablePointData } from "../compactEPointCache";
import { getPreparedHeightBuffer, getPreparedPointHeight } from "../compactEPointCache";
import { extractVerticalUnitScale } from "../../coordinates/crs/parseCopcWkt";
import { resolveHeightOffsetMeters } from "../../coordinates/transform/heightOffset";
import type { GtxGeoidGrid } from "../../coordinates/transform/verticalGrid";

/** Inclusive numeric range used to normalize a point attribute for display. */
export type CopcValueRange = {
  /** Minimum observed or caller-supplied value. */
  min: number;
  /** Maximum observed or caller-supplied value. */
  max: number;
};

/** WGS84 ellipsoidal-height range in metres. */
export type CopcElevationRange = CopcValueRange;

/** One normalized RGB(A) stop in a dimension color ramp. */
export type CopcDimensionColorRampStop = {
  /** Position in the normalized input range, from 0 to 1. */
  position: number;
  /** Normalized color components in [0, 1]. Omitted alpha defaults to 0.9. */
  color: { red: number; green: number; blue: number; alpha?: number };
};

/** Color one retained numeric Extra Bytes dimension with a fixed value range. */
export type CopcDimensionStyle = {
  /** Exact LAS Extra Bytes name, or standard LAS `Intensity`. */
  name: string;
  /** Inclusive display range in the values returned by point inspection. */
  range: CopcValueRange;
  /** Optional ordered color stops. The default ramp runs blue, cyan, yellow, red. */
  palette?: readonly CopcDimensionColorRampStop[];
  /** Value to treat as missing; missing values use the fixed cyan fallback. */
  missingValue?: number;
};

/** Interpolation used between normalized numeric color-ramp stops. */
export type CopcColorRampInterpolation =
  /** Blend color components proportionally between neighboring stops. */
  | "linear"
  /** Keep the lower stop's color until the next stop position is reached. */
  | "step";

/** Palette and interpolation for absolute displayed elevation coloring. */
export type CopcElevationStyle = {
  /** Optional ordered normalized RGB(A) stops; defaults to the existing elevation palette. */
  palette?: readonly CopcDimensionColorRampStop[];
  /** Defaults to `linear`. */
  interpolation?: CopcColorRampInterpolation;
};

/** Inclusive numeric visibility range for a retained scalar dimension. */
export type CopcDimensionFilter = {
  /** Exact LAS Extra Bytes name, or standard LAS `Intensity`. */
  name: string;
  /** Inclusive minimum value in point inspection's source-value units. */
  min: number;
  /** Inclusive maximum value in point inspection's source-value units. */
  max: number;
  /** Optional source value to treat as missing and hide. */
  missingValue?: number;
};

/**
 * Return dataset metadata's WGS84 ellipsoidal-height range in metres.
 *
 * @param heightOffsetMeters Additive height correction in metres; defaults to 0.
 */
export function getDatasetElevationRange(
  metadata: CopcMetadata,
  heightOffsetMeters = 0,
  verticalGrid?: GtxGeoidGrid,
): CopcElevationRange {
  const heightOffset = resolveHeightOffsetMeters(heightOffsetMeters);
  const verticalUnitScale = verticalGrid
    ? verticalGrid.getSourceVerticalUnitScale(metadata.wkt)
    : metadata.wkt
      ? extractVerticalUnitScale(metadata.wkt)
      : 1;
  const convertedMin = metadata.bounds.minZ * verticalUnitScale;
  const convertedMax = metadata.bounds.maxZ * verticalUnitScale;
  const min =
    convertedMin +
    (verticalGrid?.minimumUndulationMeters ?? 0) +
    heightOffset;
  const max =
    convertedMax +
    (verticalGrid?.maximumUndulationMeters ?? 0) +
    heightOffset;

  return {
    min: Math.min(min, max),
    max: Math.max(min, max),
  };
}

/** A renderer-neutral color in the normalized [0, 1] range. */
export type CopcNormalizedColor = {
  /** Red component in [0, 1]. */
  red: number;
  /** Green component in [0, 1]. */
  green: number;
  /** Blue component in [0, 1]. */
  blue: number;
  /** Alpha component in [0, 1]. */
  alpha: number;
};

/** Fully resolved style settings used while preparing point colors. */
export type CopcPointStyleOptions = {
  /** Mapping applied to each point. */
  colorMode: CopcColorMode;
  /** Height range in metres used by elevation coloring. */
  elevationRange: CopcElevationRange;
  /** Optional palette and interpolation used by elevation coloring. */
  elevationStyle?: CopcElevationStyle;
  /** Source intensity range used by intensity coloring, when available. */
  intensityRange?: CopcValueRange;
  /** Source RGB precision. COPC RGB is retained as Uint16 until this step. */
  rgbMax?: 255 | 65535;
  /** Dimension mapping used by the `dimension` color mode. */
  dimension?: CopcDimensionStyle;
};

/** Partial style overrides; omitted values are inferred from the point buffer. */
export type CopcPointStyleInput = Partial<CopcPointStyleOptions>;

type PointStyleData = GeographicPointBuffer | RenderablePointData;

/** Per-layer state that keeps source-derived RGB scale consistent across nodes. */
export type CopcPointStyleState = {
  /** Resolve the RGB display scale once for the owning dataset/layer. */
  getRgbMax(points: PointStyleData): 255 | 65535 | undefined;
  /** Reset source-derived state before loading a different dataset. */
  reset(): void;
};

const FIXED_POINT_COLOR: CopcNormalizedColor = {
  red: 0,
  green: 1,
  blue: 1,
  alpha: 0.9,
};

const DEFAULT_ELEVATION_PALETTE: readonly CopcDimensionColorRampStop[] = [
  { position: 0, color: { red: 0.05, green: 0.2, blue: 0.65 } },
  { position: 0.25, color: { red: 0, green: 0.75, blue: 1 } },
  { position: 0.5, color: { red: 0.15, green: 0.75, blue: 0.25 } },
  { position: 0.75, color: { red: 1, green: 0.85, blue: 0.1 } },
  { position: 1, color: { red: 0.85, green: 0.1, blue: 0.05 } },
];

const CLASSIFICATION_COLORS: Readonly<Record<number, CopcNormalizedColor>> = {
  0: { red: 160 / 255, green: 160 / 255, blue: 160 / 255, alpha: 230 / 255 },
  1: { red: 190 / 255, green: 190 / 255, blue: 190 / 255, alpha: 230 / 255 },
  2: { red: 150 / 255, green: 100 / 255, blue: 50 / 255, alpha: 230 / 255 },
  3: { red: 120 / 255, green: 220 / 255, blue: 120 / 255, alpha: 230 / 255 },
  4: { red: 60 / 255, green: 180 / 255, blue: 75 / 255, alpha: 230 / 255 },
  5: { red: 20 / 255, green: 120 / 255, blue: 40 / 255, alpha: 230 / 255 },
  6: { red: 220 / 255, green: 60 / 255, blue: 45 / 255, alpha: 230 / 255 },
  7: { red: 45 / 255, green: 45 / 255, blue: 45 / 255, alpha: 230 / 255 },
  8: { red: 130 / 255, green: 130 / 255, blue: 130 / 255, alpha: 230 / 255 },
  9: { red: 45 / 255, green: 120 / 255, blue: 220 / 255, alpha: 230 / 255 },
  10: { red: 220 / 255, green: 120 / 255, blue: 180 / 255, alpha: 230 / 255 },
  11: { red: 90 / 255, green: 90 / 255, blue: 90 / 255, alpha: 230 / 255 },
  12: { red: 245 / 255, green: 210 / 255, blue: 45 / 255, alpha: 230 / 255 },
  13: { red: 245 / 255, green: 150 / 255, blue: 40 / 255, alpha: 230 / 255 },
  14: { red: 245 / 255, green: 100 / 255, blue: 30 / 255, alpha: 230 / 255 },
  15: { red: 180 / 255, green: 60 / 255, blue: 200 / 255, alpha: 230 / 255 },
  16: { red: 120 / 255, green: 70 / 255, blue: 190 / 255, alpha: 230 / 255 },
  17: { red: 245 / 255, green: 130 / 255, blue: 40 / 255, alpha: 230 / 255 },
  18: { red: 255 / 255, green: 40 / 255, blue: 140 / 255, alpha: 230 / 255 },
};

const UNKNOWN_CLASSIFICATION_COLOR: CopcNormalizedColor = {
  red: 1,
  green: 0,
  blue: 1,
  alpha: 230 / 255,
};

const DEFAULT_DIMENSION_PALETTE: readonly CopcDimensionColorRampStop[] = [
  { position: 0, color: { red: 0.05, green: 0.2, blue: 0.65 } },
  { position: 1 / 3, color: { red: 0, green: 0.75, blue: 1 } },
  { position: 2 / 3, color: { red: 1, green: 0.85, blue: 0.1 } },
  { position: 1, color: { red: 0.85, green: 0.1, blue: 0.05 } },
];

function cloneColor(color: CopcNormalizedColor): CopcNormalizedColor {
  return { ...color };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Normalize a finite value to [0, 1], clamping outside the range.
 *
 * Degenerate or non-finite inputs map to 0.5.
 */
export function normalizeElevation(
  height: number,
  range: CopcElevationRange,
): number {
  if (
    !Number.isFinite(height) ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max) ||
    range.max <= range.min
  ) {
    return 0.5;
  }

  return clamp((height - range.min) / (range.max - range.min), 0, 1);
}

/** Normalize a LAS intensity value with the same clamped range rule as elevation. */
export function normalizeIntensity(
  intensity: number,
  range: CopcValueRange,
): number {
  return normalizeElevation(intensity, range);
}

/** Validate and detach an explicit WGS84 ellipsoidal-height range in metres. */
export function cloneCopcElevationRange(
  range: CopcElevationRange,
): CopcElevationRange {
  assertFiniteRange(range, "elevation range", true);
  return { ...range };
}

function cloneCopcColorRamp(
  palette: readonly CopcDimensionColorRampStop[],
  label: string,
): CopcDimensionColorRampStop[] {
  if (!Array.isArray(palette) || palette.length < 2) {
    throw new RangeError(`${label} palette must contain at least two stops`);
  }
  let previousPosition = -1;
  const clonedPalette = palette.map((stop, index) => {
    if (
      !stop ||
      !Number.isFinite(stop.position) ||
      stop.position < 0 ||
      stop.position > 1 ||
      stop.position <= previousPosition
    ) {
      throw new RangeError(
        `${label} palette stop ${index} must have a strictly increasing position in [0, 1]`,
      );
    }
    previousPosition = stop.position;
    if (!stop.color || typeof stop.color !== "object") {
      throw new TypeError(`${label} palette stop ${index} must have a color`);
    }
    const { red, green, blue, alpha = 0.9 } = stop.color;
    if (
      ![red, green, blue, alpha].every(
        (component) =>
          Number.isFinite(component) && component >= 0 && component <= 1,
      )
    ) {
      throw new RangeError(
        `${label} palette stop ${index} color components must be in [0, 1]`,
      );
    }
    return {
      position: stop.position,
      color: { red, green, blue, alpha },
    };
  });
  if (
    clonedPalette[0].position !== 0 ||
    clonedPalette.at(-1)?.position !== 1
  ) {
    throw new RangeError(`${label} palette must start at 0 and end at 1`);
  }
  return clonedPalette;
}

/** Validate and detach elevation palette settings; omitted fields use compatible defaults. */
export function cloneCopcElevationStyle(
  style: CopcElevationStyle,
): CopcElevationStyle {
  if (!style || typeof style !== "object") {
    throw new TypeError("elevation style must be an object");
  }
  const interpolation = style.interpolation ?? "linear";
  if (interpolation !== "linear" && interpolation !== "step") {
    throw new RangeError('elevation style interpolation must be "linear" or "step"');
  }
  return {
    palette: cloneCopcColorRamp(
      style.palette ?? DEFAULT_ELEVATION_PALETTE,
      "elevation style",
    ),
    interpolation,
  };
}

/** Validate and detach the range, palette, and missing-value style settings. */
export function cloneCopcDimensionStyle(
  style: CopcDimensionStyle,
): CopcDimensionStyle {
  if (!style || typeof style !== "object") {
    throw new TypeError("dimension style must be an object");
  }
  if (typeof style.name !== "string" || style.name.trim().length === 0) {
    throw new TypeError("dimension style name must be a non-empty string");
  }
  assertFiniteRange(style.range, "dimension style range", true);
  if (
    style.missingValue !== undefined &&
    !Number.isFinite(style.missingValue)
  ) {
    throw new RangeError("dimension style missingValue must be finite");
  }

  const clonedPalette = cloneCopcColorRamp(
    style.palette ?? DEFAULT_DIMENSION_PALETTE,
    "dimension style",
  );

  return {
    name: style.name,
    range: { ...style.range },
    palette: clonedPalette,
    ...(style.missingValue === undefined
      ? {}
      : { missingValue: style.missingValue }),
  };
}

/** Validate and detach a dimension visibility range. */
export function cloneCopcDimensionFilter(
  filter: CopcDimensionFilter,
): CopcDimensionFilter {
  if (!filter || typeof filter !== "object") {
    throw new TypeError("dimension filter must be an object");
  }
  if (typeof filter.name !== "string" || filter.name.trim().length === 0) {
    throw new TypeError("dimension filter name must be a non-empty string");
  }
  assertFiniteRange(filter, "dimension filter", false);
  if (
    filter.missingValue !== undefined &&
    !Number.isFinite(filter.missingValue)
  ) {
    throw new RangeError("dimension filter missingValue must be finite");
  }
  return { ...filter };
}

/** Return whether an Extra Bytes descriptor is a supported numeric scalar. */
export function isCopcDimensionMetadataStyleable(
  dimension: CopcExtraDimensionMetadata,
): boolean {
  if (dimension.type === "signed" || dimension.type === "unsigned") {
    return [1, 2, 4].includes(dimension.length);
  }
  return dimension.type === "float" && [4, 8].includes(dimension.length);
}

function assertFiniteRange(
  range: CopcValueRange,
  label: string,
  requireWidth: boolean,
): void {
  if (
    !range ||
    typeof range !== "object" ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max) ||
    range.min > range.max ||
    (requireWidth && range.min === range.max)
  ) {
    throw new RangeError(
      `${label} must have finite bounds${requireWidth ? " with min < max" : " with min <= max"}`,
    );
  }
}

/** Return the prepared or measured WGS84 ellipsoidal-height range in metres. */
export function getPointBufferElevationRange(
  points: PointStyleData,
): CopcElevationRange {
  if (points.statistics?.elevation) {
    return { ...points.statistics.elevation };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < points.pointCount; index += 1) {
    const height = getPreparedPointHeight(points, index);

    if (Number.isFinite(height)) {
      min = Math.min(min, height);
      max = Math.max(max, height);
    }
  }

  return Number.isFinite(min) && Number.isFinite(max)
    ? { min, max }
    : { min: 0, max: 0 };
}

/** Return the prepared or measured intensity range, or `undefined` when absent. */
export function getPointBufferIntensityRange(
  points: PointStyleData,
): CopcValueRange | undefined {
  if (points.statistics?.intensity) {
    return { ...points.statistics.intensity };
  }

  const values = points.attributes?.intensity;

  if (!values || values.length === 0) {
    return undefined;
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (
    let index = 0;
    index < Math.min(points.pointCount, values.length);
    index += 1
  ) {
    const value = values[index];

    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }

  return Number.isFinite(min) && Number.isFinite(max)
    ? { min, max }
    : undefined;
}

/** Infer the source RGB display maximum (255 or 65,535), when RGB is present. */
export function getPointBufferRgbMax(
  points: PointStyleData,
): 255 | 65535 | undefined {
  if (points.statistics?.rgbMax !== undefined) {
    return points.statistics.rgbMax;
  }

  const { red, green, blue } = points.attributes ?? {};

  if (!red || !green || !blue) {
    return undefined;
  }

  const length = Math.min(
    points.pointCount,
    red.length,
    green.length,
    blue.length,
  );
  let max = 0;

  for (let index = 0; index < length; index += 1) {
    max = Math.max(max, red[index], green[index], blue[index]);
  }

  return max <= 255 ? 255 : 65535;
}

/**
 * Keep source-derived RGB display precision stable across streamed nodes.
 *
 * COPC point buffers do not currently carry a source-level RGB precision
 * marker, so the existing value-based detection is retained as a
 * compatibility fallback. It is deliberately performed once per owning
 * layer rather than once per node; callers with authoritative source metadata
 * can pass `rgbMax` explicitly in the style options.
 */
export function createCopcPointStyleState(
  initialRgbMax?: 255 | 65535,
): CopcPointStyleState {
  let rgbMax = initialRgbMax;

  return {
    getRgbMax(points: PointStyleData): 255 | 65535 | undefined {
      if (rgbMax !== undefined) {
        return rgbMax;
      }

      rgbMax = getPointBufferRgbMax(points);
      return rgbMax;
    },
    reset(): void {
      rgbMax = initialRgbMax;
    },
  };
}

function getRgbColor(
  attributes: CopcPointAttributes | undefined,
  pointIndex: number,
  rgbMax: 255 | 65535 | undefined,
): CopcNormalizedColor | undefined {
  const red = attributes?.red?.[pointIndex];
  const green = attributes?.green?.[pointIndex];
  const blue = attributes?.blue?.[pointIndex];

  if (
    red === undefined ||
    green === undefined ||
    blue === undefined ||
    rgbMax === undefined
  ) {
    return undefined;
  }

  return {
    red: clamp(red / rgbMax, 0, 1),
    green: clamp(green / rgbMax, 0, 1),
    blue: clamp(blue / rgbMax, 0, 1),
    alpha: 0.9,
  };
}

function getIntensityColor(
  attributes: CopcPointAttributes | undefined,
  pointIndex: number,
  range: CopcValueRange | undefined,
): CopcNormalizedColor | undefined {
  const intensity = attributes?.intensity?.[pointIndex];

  if (intensity === undefined || range === undefined) {
    return undefined;
  }

  const normalized = normalizeIntensity(intensity, range);
  return {
    red: normalized,
    green: normalized,
    blue: normalized,
    alpha: 0.9,
  };
}

function getClassificationColor(
  attributes: CopcPointAttributes | undefined,
  pointIndex: number,
): CopcNormalizedColor | undefined {
  const classification = attributes?.classification?.[pointIndex];

  if (classification === undefined) {
    return undefined;
  }

  return cloneColor(
    CLASSIFICATION_COLORS[classification] ?? UNKNOWN_CLASSIFICATION_COLOR,
  );
}

function getDimensionValue(
  attributes: CopcPointAttributes | undefined,
  style: CopcDimensionStyle,
  pointIndex: number,
): number | undefined {
  const value =
    style.name === "Intensity"
      ? attributes?.intensity?.[pointIndex]
      : attributes?.extraDimensions?.[style.name]?.[pointIndex];
  if (typeof value === "bigint") {
    throw new TypeError(
      `Dimension ${style.name} uses a 64-bit integer that cannot be styled as a JavaScript number`,
    );
  }
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    (style.missingValue !== undefined && value === style.missingValue)
  ) {
    return undefined;
  }
  return value;
}

function getDimensionColor(
  attributes: CopcPointAttributes | undefined,
  pointIndex: number,
  style: CopcDimensionStyle | undefined,
): CopcNormalizedColor | undefined {
  if (!style) return undefined;
  const value = getDimensionValue(attributes, style, pointIndex);
  if (value === undefined) return undefined;
  const normalized = normalizeElevation(value, style.range);
  const palette = style.palette ?? DEFAULT_DIMENSION_PALETTE;
  return getRampColor(normalized, palette, "linear");
}

function getRampColor(
  normalized: number,
  palette: readonly CopcDimensionColorRampStop[],
  interpolation: CopcColorRampInterpolation,
): CopcNormalizedColor {
  for (let index = 1; index < palette.length; index += 1) {
    const upper = palette[index];
    if (normalized <= upper.position) {
      const lower = palette[index - 1];
      if (normalized === upper.position) {
        return { ...upper.color, alpha: upper.color.alpha ?? 0.9 };
      }
      if (interpolation === "step") {
        return { ...lower.color, alpha: lower.color.alpha ?? 0.9 };
      }
      const amount =
        (normalized - lower.position) / (upper.position - lower.position);
      return interpolateColor(
        { ...lower.color, alpha: lower.color.alpha ?? 0.9 },
        { ...upper.color, alpha: upper.color.alpha ?? 0.9 },
        amount,
      );
    }
  }
  const last = palette.at(-1)!.color;
  return { ...last, alpha: last.alpha ?? 0.9 };
}

function interpolateColor(
  lower: CopcNormalizedColor,
  upper: CopcNormalizedColor,
  amount: number,
): CopcNormalizedColor {
  return {
    red: lower.red + (upper.red - lower.red) * amount,
    green: lower.green + (upper.green - lower.green) * amount,
    blue: lower.blue + (upper.blue - lower.blue) * amount,
    alpha: lower.alpha + (upper.alpha - lower.alpha) * amount,
  };
}

/**
 * Prepare one renderer-neutral color using the shared adapter semantics.
 * Missing source attributes use the fixed-color fallback.
 */
export function getCopcPointColor(
  height: number,
  options: CopcPointStyleOptions,
  attributes?: CopcPointAttributes,
  pointIndex = 0,
): CopcNormalizedColor {
  if (options.colorMode === "fixed") {
    return cloneColor(FIXED_POINT_COLOR);
  }

  if (options.colorMode === "rgb") {
    return (
      getRgbColor(attributes, pointIndex, options.rgbMax) ??
      cloneColor(FIXED_POINT_COLOR)
    );
  }

  if (options.colorMode === "intensity") {
    return (
      getIntensityColor(attributes, pointIndex, options.intensityRange) ??
      cloneColor(FIXED_POINT_COLOR)
    );
  }

  if (options.colorMode === "classification") {
    return (
      getClassificationColor(attributes, pointIndex) ??
      cloneColor(FIXED_POINT_COLOR)
    );
  }

  if (options.colorMode === "dimension") {
    return (
      getDimensionColor(attributes, pointIndex, options.dimension) ??
      cloneColor(FIXED_POINT_COLOR)
    );
  }

  const normalized = normalizeElevation(height, options.elevationRange);
  const elevationStyle = options.elevationStyle;
  return getRampColor(
    normalized,
    elevationStyle?.palette ?? DEFAULT_ELEVATION_PALETTE,
    elevationStyle?.interpolation ?? "linear",
  );
}

/** Resolve omitted ranges and RGB scale from one decoded point buffer. */
export function resolveCopcPointStyleOptions(
  points: PointStyleData,
  options: CopcPointStyleInput = {},
  state?: CopcPointStyleState,
): CopcPointStyleOptions {
  return {
    colorMode: options.colorMode ?? "fixed",
    elevationRange:
      options.elevationRange ?? getPointBufferElevationRange(points),
    ...(options.elevationStyle === undefined
      ? {}
      : { elevationStyle: cloneCopcElevationStyle(options.elevationStyle) }),
    intensityRange:
      options.intensityRange ?? getPointBufferIntensityRange(points),
    rgbMax:
      options.rgbMax ??
      state?.getRgbMax(points) ??
      getPointBufferRgbMax(points),
    ...(options.dimension === undefined
      ? {}
      : { dimension: cloneCopcDimensionStyle(options.dimension) }),
  };
}

/**
 * Build an RGB vertex-color buffer for Three.js or another GPU renderer.
 * The returned array contains exactly three finite floats per point.
 */
export function prepareCopcPointColorBuffer(
  points: PointStyleData,
  options: CopcPointStyleInput = {},
  state?: CopcPointStyleState,
): Float32Array {
  return prepareCopcPointColorComponents(points, options, state, false);
}

/** Build an RGBA vertex-color buffer for GPU renderers that preserve point alpha. */
export function prepareCopcPointColorBufferWithAlpha(
  points: PointStyleData,
  options: CopcPointStyleInput = {},
  state?: CopcPointStyleState,
  alphaOverride?: number,
): Float32Array {
  return prepareCopcPointColorComponents(
    points,
    options,
    state,
    true,
    alphaOverride,
  );
}

function prepareCopcPointColorComponents(
  points: PointStyleData,
  options: CopcPointStyleInput,
  state: CopcPointStyleState | undefined,
  includeAlpha: boolean,
  alphaOverride?: number,
): Float32Array {
  const styleOptions = resolveCopcPointStyleOptions(points, options, state);
  const componentsPerColor = includeAlpha ? 4 : 3;
  const colors = new Float32Array(points.pointCount * componentsPerColor);
  const compactHeights = getPreparedHeightBuffer(points);

  for (let index = 0; index < points.pointCount; index += 1) {
    const color = getCopcPointColor(
      compactHeights
        ? compactHeights[index]
        : getPreparedPointHeight(points, index),
      styleOptions,
      points.attributes,
      index,
    );
    const offset = index * componentsPerColor;

    colors[offset] = Number.isFinite(color.red)
      ? color.red
      : FIXED_POINT_COLOR.red;
    colors[offset + 1] = Number.isFinite(color.green)
      ? color.green
      : FIXED_POINT_COLOR.green;
    colors[offset + 2] = Number.isFinite(color.blue)
      ? color.blue
      : FIXED_POINT_COLOR.blue;
    if (includeAlpha) {
      const alpha = alphaOverride ?? color.alpha;
      colors[offset + 3] = Number.isFinite(alpha)
        ? alpha
        : FIXED_POINT_COLOR.alpha;
    }
  }

  return colors;
}

/** Return a fresh copy of the adapter's fixed cyan fallback color. */
export function getFixedPointColor(): CopcNormalizedColor {
  return cloneColor(FIXED_POINT_COLOR);
}
