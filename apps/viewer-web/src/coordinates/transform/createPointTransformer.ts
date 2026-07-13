import proj4 from 'proj4';
import type {
  CopcMetadata,
  CopcPoint,
  CopcPointBuffer,
  GeographicPoint,
  GeographicPointBuffer,
} from '../../copc/types/copc';
import {
  extractHorizontalWkt,
  extractVerticalUnitScale,
} from '../crs/parseCopcWkt';

function hasGeographicBounds(metadata: CopcMetadata): boolean {
  const { minX, minY, maxX, maxY } = metadata.bounds;

  return (
    minX >= -180 &&
    maxX <= 180 &&
    minY >= -90 &&
    maxY <= 90
  );
}

export function createPointTransformer(
  metadata: CopcMetadata,
): (point: CopcPoint) => GeographicPoint {
  if (!metadata.wkt) {
    if (hasGeographicBounds(metadata)) {
      return (point: CopcPoint): GeographicPoint => ({
        longitude: point.x,
        latitude: point.y,
        height: point.z,
      });
    }

    throw new Error(
      'COPC metadata WKT is required to transform projected coordinates for Cesium rendering',
    );
  }

  const horizontalWkt = extractHorizontalWkt(metadata.wkt);
  const verticalUnitScale = extractVerticalUnitScale(metadata.wkt);

  return (point: CopcPoint): GeographicPoint => {
    const [longitude, latitude] = proj4(horizontalWkt, 'WGS84', [point.x, point.y]);

    return {
      longitude,
      latitude,
      height: point.z * verticalUnitScale,
    };
  };
}

export function transformPointBuffer(
  metadata: CopcMetadata,
  points: CopcPointBuffer,
): GeographicPointBuffer {
  const transformPoint = createPointTransformer(metadata);
  const coordinates = new Float64Array(points.coordinates.length);

  for (let index = 0; index < points.pointCount; index += 1) {
    const offset = index * 3;
    const point = transformPoint({
      x: points.coordinates[offset],
      y: points.coordinates[offset + 1],
      z: points.coordinates[offset + 2],
    });

    coordinates[offset] = point.longitude;
    coordinates[offset + 1] = point.latitude;
    coordinates[offset + 2] = point.height;
  }

  return {
    pointCount: points.pointCount,
    coordinates,
  };
}
