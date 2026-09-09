import * as Cesium from 'cesium';
import type { GeographicPoint, GeographicPointBuffer } from '../../copc/types/copc';
import type { CopcElevationRange } from '../../point/style/pointStyle';
import {
  getPointColor,
  type CopcColorMode,
  type CopcPointStyleOptions,
} from '../style/pointStyle';
import { resolveCopcPointStyleOptions } from '../../point/style/pointStyle';
import { performanceNow } from '../../copc/performance';

export {
  getPointBufferElevationRange,
  getPointBufferIntensityRange,
  getPointBufferRgbMax,
} from '../../point/style/pointStyle';
export type { CopcElevationRange } from '../../point/style/pointStyle';

export type CopcPointRenderOptions = {
  pointSize: number;
  colorMode?: CopcColorMode;
  elevationRange?: CopcElevationRange;
  rgbMax?: 255 | 65535;
  pointId?: (pointIndex: number) => unknown;
  onPerformance?: (
    stage: 'geographicToCartesian'
      | 'worldToCartesian'
      | 'pointStylePreparation'
      | 'pointCollectionCreation'
      | 'pointAdd',
    durationMs: number,
  ) => void;
};

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
  if (points.worldCoordinates !== undefined) {
    return toCartesian3ArrayFromWorldBuffer(points);
  }

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

/**
 * Wrap prepared WGS84 ECEF metres directly in Cesium Cartesian3 values.
 *
 * This deliberately does not call `Cartesian3.fromDegrees`; the Rust and JS
 * preparation paths already produced the authoritative ECEF render buffer.
 */
export function toCartesian3ArrayFromWorldBuffer(
  points: GeographicPointBuffer,
): Cesium.Cartesian3[] {
  const worldCoordinates = points.worldCoordinates;
  if (!worldCoordinates) {
    throw new Error('Prepared point data is missing world coordinates');
  }
  if (points.worldCoordinateSystem !== 'wgs84-ecef-meters') {
    throw new Error('Prepared world coordinates must use wgs84-ecef-meters');
  }
  if (worldCoordinates.length !== points.pointCount * 3) {
    throw new Error('Prepared world coordinates must contain three values per point');
  }

  const positions: Cesium.Cartesian3[] = [];
  for (let index = 0; index < points.pointCount; index += 1) {
    const offset = index * 3;
    const x = worldCoordinates[offset];
    const y = worldCoordinates[offset + 1];
    const z = worldCoordinates[offset + 2];
    if (![x, y, z].every(Number.isFinite)) {
      throw new Error('Prepared world coordinates must be finite');
    }
    positions.push(new Cesium.Cartesian3(x, y, z));
  }

  return positions;
}

export function renderCopcPoints(
  viewer: Cesium.Viewer,
  points: GeographicPointBuffer,
  options: CopcPointRenderOptions,
): Cesium.PointPrimitiveCollection {
  const collectionStartedAt = performanceNow();
  const collection = viewer.scene.primitives.add(
    new Cesium.PointPrimitiveCollection(),
  );
  options.onPerformance?.('pointCollectionCreation', performanceNow() - collectionStartedAt);
  const positionsStartedAt = performanceNow();
  const positions = toCartesian3ArrayFromBuffer(points);
  options.onPerformance?.(
    points.worldCoordinates === undefined ? 'geographicToCartesian' : 'worldToCartesian',
    performanceNow() - positionsStartedAt,
  );
  const styleOptions: CopcPointStyleOptions = resolveCopcPointStyleOptions(
    points,
    {
      colorMode: options.colorMode,
      elevationRange: options.elevationRange,
      rgbMax: options.rgbMax,
    },
  );

  const styleStartedAt = performanceNow();
  const colors = positions.map((_, index) => getPointColor(
    points.coordinates[index * 3 + 2],
    styleOptions,
    points.attributes,
    index,
  ));
  options.onPerformance?.('pointStylePreparation', performanceNow() - styleStartedAt);
  const addStartedAt = performanceNow();
  for (let index = 0; index < positions.length; index += 1) {
    collection.add({
      position: positions[index],
      pixelSize: options.pointSize,
      color: colors[index],
      id: options.pointId?.(index),
    });
  }
  options.onPerformance?.('pointAdd', performanceNow() - addStartedAt);

  return collection;
}
