import proj4 from 'proj4';
import type {
  CopcMetadata,
  CopcPoint,
  CopcPointBuffer,
  CopcPointData,
  GeographicPoint,
  GeographicPointBuffer,
} from '../../copc/types/copc';
import { geographicToEcef } from './worldCoordinates';
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
  const projection = proj4(horizontalWkt, 'WGS84');

  return (point: CopcPoint): GeographicPoint => {
    const [longitude, latitude] = projection.forward([point.x, point.y]);

    return {
      longitude,
      latitude,
      height: point.z * verticalUnitScale,
    };
  };
}

/** Convert adapter/view coordinates back into the COPC source coordinate space. */
export function createProjectPointTransformer(
  metadata: CopcMetadata,
): (point: GeographicPoint) => CopcPoint {
  if (!metadata.wkt) {
    if (hasGeographicBounds(metadata)) {
      return (point: GeographicPoint): CopcPoint => ({
        x: point.longitude,
        y: point.latitude,
        z: point.height,
      });
    }

    throw new Error(
      'COPC metadata WKT is required to transform projected view bounds',
    );
  }

  const horizontalWkt = extractHorizontalWkt(metadata.wkt);
  const verticalUnitScale = extractVerticalUnitScale(metadata.wkt);
  const projection = proj4(horizontalWkt, 'WGS84');

  return (point: GeographicPoint): CopcPoint => {
    const [x, y] = projection.inverse([point.longitude, point.latitude]);

    return {
      x,
      y,
      z: point.height / verticalUnitScale,
    };
  };
}

export function transformPointBuffer(
  metadata: CopcMetadata,
  points: CopcPointBuffer,
): GeographicPointBuffer {
  const transformed = transformPointBufferToPointData(metadata, points);

  return {
    pointCount: transformed.pointCount,
    coordinateSystem: 'wgs84-geographic',
    coordinates: transformed.geographic.coordinates,
    sourceCoordinateSystem: 'copc-source',
    sourceCoordinates: transformed.source.coordinates,
    worldCoordinateSystem: 'wgs84-ecef-meters',
    worldCoordinates: transformed.world.coordinates,
    attributes: transformed.attributes,
  };
}

/**
 * Decode output after the shared CRS path, retaining every useful coordinate
 * space in Float64 form for engine adapters.
 */
export function transformPointBufferToPointData(
  metadata: CopcMetadata,
  points: CopcPointBuffer,
): CopcPointData {
  const transformPoint = createPointTransformer(metadata);
  const sourceCoordinates = points.coordinates.slice();
  const geographicCoordinates = new Float64Array(points.coordinates.length);
  const worldCoordinates = new Float64Array(points.coordinates.length);

  for (let index = 0; index < points.pointCount; index += 1) {
    const offset = index * 3;
    const point = transformPoint({
      x: points.coordinates[offset],
      y: points.coordinates[offset + 1],
      z: points.coordinates[offset + 2],
    });

    geographicCoordinates[offset] = point.longitude;
    geographicCoordinates[offset + 1] = point.latitude;
    geographicCoordinates[offset + 2] = point.height;

    const world = geographicToEcef(point);
    worldCoordinates[offset] = world.x;
    worldCoordinates[offset + 1] = world.y;
    worldCoordinates[offset + 2] = world.z;
  }

  return {
    pointCount: points.pointCount,
    source: {
      coordinateSystem: 'copc-source',
      pointCount: points.pointCount,
      coordinates: sourceCoordinates,
    },
    geographic: {
      coordinateSystem: 'wgs84-geographic',
      pointCount: points.pointCount,
      coordinates: geographicCoordinates,
    },
    world: {
      coordinateSystem: 'wgs84-ecef-meters',
      pointCount: points.pointCount,
      coordinates: worldCoordinates,
    },
    attributes: points.attributes,
  };
}
