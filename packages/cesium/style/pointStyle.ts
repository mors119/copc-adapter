import * as Cesium from "cesium";
import type { CopcPointAttributes } from "../../core/copc/types/copc";
import {
  getCopcPointColor,
  normalizeElevation,
  normalizeIntensity,
  type CopcPointStyleOptions,
} from "../../core/point/style/pointStyle";

export type { CopcColorMode } from "../../core/copc/points/fieldSelection";

export type {
  CopcElevationRange,
  CopcPointStyleOptions,
  CopcValueRange,
} from "../../core/point/style/pointStyle";

/** Convert the shared normalized color into Cesium's renderer-native value. */
export function getPointColor(
  height: number,
  options: CopcPointStyleOptions,
  attributes?: CopcPointAttributes,
  pointIndex = 0,
): Cesium.Color {
  const color = getCopcPointColor(height, options, attributes, pointIndex);

  return new Cesium.Color(color.red, color.green, color.blue, color.alpha);
}

export {
  getPointBufferElevationRange,
  getPointBufferIntensityRange,
  getPointBufferRgbMax,
  prepareCopcPointColorBuffer,
  resolveCopcPointStyleOptions,
} from "../../core/point/style/pointStyle";

export { normalizeElevation, normalizeIntensity };

export type {
  CopcNormalizedColor,
  CopcPointStyleInput,
} from "../../core/point/style/pointStyle";
