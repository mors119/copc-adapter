import * as Cesium from 'cesium';
import type { GeographicPoint, GeographicPointBuffer } from '../../copc/types/copc';
import {
  getPointColor,
  type CopcColorMode,
  type CopcElevationRange,
  type CopcPointStyleOptions,
} from '../style/pointStyle';

export type CopcPointRenderOptions = {
  pointSize: number;
  colorMode?: CopcColorMode;
  elevationRange?: CopcElevationRange;
};

export function getPointBufferElevationRange(
  points: GeographicPointBuffer,
): CopcElevationRange {
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

export function toCartesian3Array(points: GeographicPoint[]): Cesium.Cartesian3[] {
  return points.map((point) =>
    Cesium.Cartesian3.fromDegrees(
      point.longitude,
      point.latitude,
      point.height,
    ),
  );
}

export function toCartesian3ArrayFromBuffer(
  points: GeographicPointBuffer,
): Cesium.Cartesian3[] {
  const positions: Cesium.Cartesian3[] = [];

  for (let index = 0; index < points.pointCount; index += 1) {
    const offset = index * 3;

    positions.push(
      Cesium.Cartesian3.fromDegrees(
        points.coordinates[offset],
        points.coordinates[offset + 1],
        points.coordinates[offset + 2],
      ),
    );
  }

  return positions;
}

export function renderCopcPoints(
  viewer: Cesium.Viewer,
  points: GeographicPointBuffer,
  options: CopcPointRenderOptions,
): Cesium.PointPrimitiveCollection {
  const collection = viewer.scene.primitives.add(
    new Cesium.PointPrimitiveCollection(),
  );
  const positions = toCartesian3ArrayFromBuffer(points);
  const styleOptions: CopcPointStyleOptions = {
    colorMode: options.colorMode ?? 'fixed',
    elevationRange:
      options.elevationRange ?? getPointBufferElevationRange(points),
  };

  for (let index = 0; index < positions.length; index += 1) {
    collection.add({
      position: positions[index],
      pixelSize: options.pointSize,
      color: getPointColor(points.coordinates[index * 3 + 2], styleOptions),
    });
  }

  return collection;
}
