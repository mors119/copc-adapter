import * as Cesium from 'cesium';

export type CopcColorMode = 'fixed' | 'elevation';

export type CopcElevationRange = {
  min: number;
  max: number;
};

export type CopcPointStyleOptions = {
  colorMode: CopcColorMode;
  elevationRange: CopcElevationRange;
};

const FIXED_POINT_COLOR = new Cesium.Color(0, 1, 1, 0.9);
const ELEVATION_COLOR_STOPS = [
  new Cesium.Color(0.05, 0.2, 0.65, 0.9),
  new Cesium.Color(0, 0.75, 1, 0.9),
  new Cesium.Color(0.15, 0.75, 0.25, 0.9),
  new Cesium.Color(1, 0.85, 0.1, 0.9),
  new Cesium.Color(0.85, 0.1, 0.05, 0.9),
];

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

export function getPointColor(
  height: number,
  options: CopcPointStyleOptions,
): Cesium.Color {
  if (options.colorMode === 'fixed') {
    return Cesium.Color.clone(FIXED_POINT_COLOR);
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
