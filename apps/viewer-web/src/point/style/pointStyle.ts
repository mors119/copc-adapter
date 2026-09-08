import type { CopcColorMode } from '../../copc/points/fieldSelection';
import type { CopcPointAttributes, GeographicPointBuffer } from '../../copc/types/copc';

export type CopcValueRange = {
  min: number;
  max: number;
};

export type CopcElevationRange = CopcValueRange;

/** A renderer-neutral color in the normalized [0, 1] range. */
export type CopcNormalizedColor = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

export type CopcPointStyleOptions = {
  colorMode: CopcColorMode;
  elevationRange: CopcElevationRange;
  intensityRange?: CopcValueRange;
  /** Source RGB precision. COPC RGB is retained as Uint16 until this step. */
  rgbMax?: 255 | 65535;
};

export type CopcPointStyleInput = Partial<CopcPointStyleOptions>;

export type CopcPointStyleState = {
  /** Resolve the RGB display scale once for the owning dataset/layer. */
  getRgbMax(points: GeographicPointBuffer): 255 | 65535 | undefined;
  /** Reset source-derived state before loading a different dataset. */
  reset(): void;
};

const FIXED_POINT_COLOR: CopcNormalizedColor = {
  red: 0,
  green: 1,
  blue: 1,
  alpha: 0.9,
};

const ELEVATION_COLOR_STOPS: readonly CopcNormalizedColor[] = [
  { red: 0.05, green: 0.2, blue: 0.65, alpha: 0.9 },
  { red: 0, green: 0.75, blue: 1, alpha: 0.9 },
  { red: 0.15, green: 0.75, blue: 0.25, alpha: 0.9 },
  { red: 1, green: 0.85, blue: 0.1, alpha: 0.9 },
  { red: 0.85, green: 0.1, blue: 0.05, alpha: 0.9 },
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

function cloneColor(color: CopcNormalizedColor): CopcNormalizedColor {
  return { ...color };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeElevation(
  height: number,
  range: CopcElevationRange,
): number {
  if (
    !Number.isFinite(height)
    || !Number.isFinite(range.min)
    || !Number.isFinite(range.max)
    || range.max <= range.min
  ) {
    return 0.5;
  }

  return clamp((height - range.min) / (range.max - range.min), 0, 1);
}

export function normalizeIntensity(
  intensity: number,
  range: CopcValueRange,
): number {
  return normalizeElevation(intensity, range);
}

export function getPointBufferElevationRange(
  points: GeographicPointBuffer,
): CopcElevationRange {
  if (points.statistics?.elevation) {
    return { ...points.statistics.elevation };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < points.pointCount; index += 1) {
    const height = points.coordinates[index * 3 + 2];

    if (Number.isFinite(height)) {
      min = Math.min(min, height);
      max = Math.max(max, height);
    }
  }

  return Number.isFinite(min) && Number.isFinite(max)
    ? { min, max }
    : { min: 0, max: 0 };
}

export function getPointBufferIntensityRange(
  points: GeographicPointBuffer,
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

  for (let index = 0; index < Math.min(points.pointCount, values.length); index += 1) {
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

export function getPointBufferRgbMax(
  points: GeographicPointBuffer,
): 255 | 65535 | undefined {
  if (points.statistics?.rgbMax !== undefined) {
    return points.statistics.rgbMax;
  }

  const { red, green, blue } = points.attributes ?? {};

  if (!red || !green || !blue) {
    return undefined;
  }

  const length = Math.min(points.pointCount, red.length, green.length, blue.length);
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
    getRgbMax(points: GeographicPointBuffer): 255 | 65535 | undefined {
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
    red === undefined
    || green === undefined
    || blue === undefined
    || rgbMax === undefined
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

  return cloneColor(CLASSIFICATION_COLORS[classification] ?? UNKNOWN_CLASSIFICATION_COLOR);
}

function interpolateColor(
  lower: CopcNormalizedColor,
  upper: CopcNormalizedColor,
  amount: number,
): CopcNormalizedColor {
  return {
    red: lower.red + ((upper.red - lower.red) * amount),
    green: lower.green + ((upper.green - lower.green) * amount),
    blue: lower.blue + ((upper.blue - lower.blue) * amount),
    alpha: lower.alpha + ((upper.alpha - lower.alpha) * amount),
  };
}

/**
 * Prepare one renderer-neutral color using the shared adapter semantics.
 * Attribute modes intentionally return `undefined` when their field is not
 * available so callers can apply the documented fixed-color fallback.
 */
export function getCopcPointColor(
  height: number,
  options: CopcPointStyleOptions,
  attributes?: CopcPointAttributes,
  pointIndex = 0,
): CopcNormalizedColor {
  if (options.colorMode === 'fixed') {
    return cloneColor(FIXED_POINT_COLOR);
  }

  if (options.colorMode === 'rgb') {
    return getRgbColor(attributes, pointIndex, options.rgbMax)
      ?? cloneColor(FIXED_POINT_COLOR);
  }

  if (options.colorMode === 'intensity') {
    return getIntensityColor(attributes, pointIndex, options.intensityRange)
      ?? cloneColor(FIXED_POINT_COLOR);
  }

  if (options.colorMode === 'classification') {
    return getClassificationColor(attributes, pointIndex)
      ?? cloneColor(FIXED_POINT_COLOR);
  }

  const normalized = normalizeElevation(height, options.elevationRange);
  const scaled = normalized * (ELEVATION_COLOR_STOPS.length - 1);
  const lowerIndex = Math.floor(scaled);
  const upperIndex = Math.min(lowerIndex + 1, ELEVATION_COLOR_STOPS.length - 1);

  return interpolateColor(
    ELEVATION_COLOR_STOPS[lowerIndex],
    ELEVATION_COLOR_STOPS[upperIndex],
    scaled - lowerIndex,
  );
}

/** Resolve node-local ranges once before generating a node's color buffer. */
export function resolveCopcPointStyleOptions(
  points: GeographicPointBuffer,
  options: CopcPointStyleInput = {},
  state?: CopcPointStyleState,
): CopcPointStyleOptions {
  return {
    colorMode: options.colorMode ?? 'fixed',
    elevationRange: options.elevationRange ?? getPointBufferElevationRange(points),
    intensityRange: options.intensityRange ?? getPointBufferIntensityRange(points),
    rgbMax: options.rgbMax ?? state?.getRgbMax(points) ?? getPointBufferRgbMax(points),
  };
}

/**
 * Build an RGB vertex-color buffer for Three.js or another GPU renderer.
 * The returned array contains exactly three finite floats per point.
 */
export function prepareCopcPointColorBuffer(
  points: GeographicPointBuffer,
  options: CopcPointStyleInput = {},
  state?: CopcPointStyleState,
): Float32Array {
  const styleOptions = resolveCopcPointStyleOptions(points, options, state);
  const colors = new Float32Array(points.pointCount * 3);

  for (let index = 0; index < points.pointCount; index += 1) {
    const color = getCopcPointColor(
      points.coordinates[index * 3 + 2],
      styleOptions,
      points.attributes,
      index,
    );
    const offset = index * 3;

    colors[offset] = Number.isFinite(color.red) ? color.red : FIXED_POINT_COLOR.red;
    colors[offset + 1] = Number.isFinite(color.green) ? color.green : FIXED_POINT_COLOR.green;
    colors[offset + 2] = Number.isFinite(color.blue) ? color.blue : FIXED_POINT_COLOR.blue;
  }

  return colors;
}

export function getFixedPointColor(): CopcNormalizedColor {
  return cloneColor(FIXED_POINT_COLOR);
}
