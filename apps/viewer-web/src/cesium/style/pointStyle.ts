import * as Cesium from 'cesium';
import type { CopcPointAttributes } from '../../copc/types/copc';
export { getCopcPointFieldSelection } from '../../copc/points/fieldSelection';
export type { CopcColorMode } from '../../copc/points/fieldSelection';
import type { CopcColorMode } from '../../copc/points/fieldSelection';

export type CopcValueRange = {
  min: number;
  max: number;
};

export type CopcElevationRange = CopcValueRange;

export type CopcPointStyleOptions = {
  colorMode: CopcColorMode;
  elevationRange: CopcElevationRange;
  intensityRange?: CopcValueRange;
  rgbMax?: 255 | 65535;
};

const FIXED_POINT_COLOR = new Cesium.Color(0, 1, 1, 0.9);
const ELEVATION_COLOR_STOPS = [
  new Cesium.Color(0.05, 0.2, 0.65, 0.9),
  new Cesium.Color(0, 0.75, 1, 0.9),
  new Cesium.Color(0.15, 0.75, 0.25, 0.9),
  new Cesium.Color(1, 0.85, 0.1, 0.9),
  new Cesium.Color(0.85, 0.1, 0.05, 0.9),
];
const CLASSIFICATION_COLORS: Readonly<Record<number, Cesium.Color>> = {
  0: Cesium.Color.fromBytes(160, 160, 160, 230),
  1: Cesium.Color.fromBytes(190, 190, 190, 230),
  2: Cesium.Color.fromBytes(150, 100, 50, 230),
  3: Cesium.Color.fromBytes(120, 220, 120, 230),
  4: Cesium.Color.fromBytes(60, 180, 75, 230),
  5: Cesium.Color.fromBytes(20, 120, 40, 230),
  6: Cesium.Color.fromBytes(220, 60, 45, 230),
  7: Cesium.Color.fromBytes(45, 45, 45, 230),
  8: Cesium.Color.fromBytes(130, 130, 130, 230),
  9: Cesium.Color.fromBytes(45, 120, 220, 230),
  10: Cesium.Color.fromBytes(220, 120, 180, 230),
  11: Cesium.Color.fromBytes(90, 90, 90, 230),
  12: Cesium.Color.fromBytes(245, 210, 45, 230),
  13: Cesium.Color.fromBytes(245, 150, 40, 230),
  14: Cesium.Color.fromBytes(245, 100, 30, 230),
  15: Cesium.Color.fromBytes(180, 60, 200, 230),
  16: Cesium.Color.fromBytes(120, 70, 190, 230),
  17: Cesium.Color.fromBytes(245, 130, 40, 230),
  18: Cesium.Color.fromBytes(255, 40, 140, 230),
};
const UNKNOWN_CLASSIFICATION_COLOR = Cesium.Color.fromBytes(255, 0, 255, 230);

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

  return Cesium.Math.clamp(
    (height - range.min) / (range.max - range.min),
    0,
    1,
  );
}

export function normalizeIntensity(
  intensity: number,
  range: CopcValueRange,
): number {
  return normalizeElevation(intensity, range);
}

function getRgbColor(
  attributes: CopcPointAttributes | undefined,
  pointIndex: number,
  rgbMax: 255 | 65535 | undefined,
): Cesium.Color | undefined {
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

  return new Cesium.Color(
    Cesium.Math.clamp(red / rgbMax, 0, 1),
    Cesium.Math.clamp(green / rgbMax, 0, 1),
    Cesium.Math.clamp(blue / rgbMax, 0, 1),
    0.9,
  );
}

function getIntensityColor(
  attributes: CopcPointAttributes | undefined,
  pointIndex: number,
  range: CopcValueRange | undefined,
): Cesium.Color | undefined {
  const intensity = attributes?.intensity?.[pointIndex];

  if (intensity === undefined || range === undefined) {
    return undefined;
  }

  const normalized = normalizeIntensity(intensity, range);

  return new Cesium.Color(normalized, normalized, normalized, 0.9);
}

function getClassificationColor(
  attributes: CopcPointAttributes | undefined,
  pointIndex: number,
): Cesium.Color | undefined {
  const classification = attributes?.classification?.[pointIndex];

  if (classification === undefined) {
    return undefined;
  }

  return Cesium.Color.clone(
    CLASSIFICATION_COLORS[classification] ?? UNKNOWN_CLASSIFICATION_COLOR,
  );
}

export function getPointColor(
  height: number,
  options: CopcPointStyleOptions,
  attributes?: CopcPointAttributes,
  pointIndex = 0,
): Cesium.Color {
  if (options.colorMode === 'fixed') {
    return Cesium.Color.clone(FIXED_POINT_COLOR);
  }

  if (options.colorMode === 'rgb') {
    return getRgbColor(attributes, pointIndex, options.rgbMax)
      ?? Cesium.Color.clone(FIXED_POINT_COLOR);
  }

  if (options.colorMode === 'intensity') {
    return getIntensityColor(attributes, pointIndex, options.intensityRange)
      ?? Cesium.Color.clone(FIXED_POINT_COLOR);
  }

  if (options.colorMode === 'classification') {
    return getClassificationColor(attributes, pointIndex)
      ?? Cesium.Color.clone(FIXED_POINT_COLOR);
  }

  const normalized = normalizeElevation(height, options.elevationRange);
  const scaled = normalized * (ELEVATION_COLOR_STOPS.length - 1);
  const lowerIndex = Math.floor(scaled);
  const upperIndex = Math.min(
    lowerIndex + 1,
    ELEVATION_COLOR_STOPS.length - 1,
  );

  return Cesium.Color.lerp(
    ELEVATION_COLOR_STOPS[lowerIndex],
    ELEVATION_COLOR_STOPS[upperIndex],
    scaled - lowerIndex,
    new Cesium.Color(),
  );
}
