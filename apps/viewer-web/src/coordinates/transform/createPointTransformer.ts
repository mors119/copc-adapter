import proj4 from 'proj4';
import type {
  CopcMetadata,
  CopcPoint,
  CopcPointBuffer,
  GeographicPoint,
  GeographicPointBuffer,
  PreparedPointData,
} from '../../copc/types/copc';
import {
  createPreparedPointData,
  preparedPointDataToGeographicBuffer,
  assertPreparedPointData,
} from '../../point/preparedPoint';
import { geographicToEcef } from './worldCoordinates';
import {
  extractHorizontalCrsWkt,
  extractVerticalUnitScale,
} from '../crs/parseCopcWkt';
import { resolveHeightOffsetMeters } from './heightOffset';

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
  heightOffsetMeters = 0,
): (point: CopcPoint) => GeographicPoint {
  const heightOffset = resolveHeightOffsetMeters(heightOffsetMeters);
  if (!metadata.wkt) {
    if (hasGeographicBounds(metadata)) {
      return (point: CopcPoint): GeographicPoint => ({
        longitude: point.x,
        latitude: point.y,
        height: heightOffset === 0 ? point.z : point.z + heightOffset,
      });
    }

    throw new Error(
      'COPC metadata WKT is required to transform projected coordinates for geographic rendering',
    );
  }

  const horizontalWkt = extractHorizontalCrsWkt(metadata.wkt);
  const verticalUnitScale = extractVerticalUnitScale(metadata.wkt);
  const projection = proj4(horizontalWkt, 'WGS84');

  return (point: CopcPoint): GeographicPoint => {
    const [longitude, latitude] = projection.forward([point.x, point.y]);
    const convertedHeight = point.z * verticalUnitScale;

    return {
      longitude,
      latitude,
      height: heightOffset === 0 ? convertedHeight : convertedHeight + heightOffset,
    };
  };
}

/** Convert adapter/view coordinates back into the COPC source coordinate space. */
export function createProjectPointTransformer(
  metadata: CopcMetadata,
  heightOffsetMeters = 0,
): (point: GeographicPoint) => CopcPoint {
  const heightOffset = resolveHeightOffsetMeters(heightOffsetMeters);
  if (!metadata.wkt) {
    if (hasGeographicBounds(metadata)) {
      return (point: GeographicPoint): CopcPoint => ({
        x: point.longitude,
        y: point.latitude,
        z: point.height - heightOffset,
      });
    }

    throw new Error(
      'COPC metadata WKT is required to transform projected view bounds',
    );
  }

  const horizontalWkt = extractHorizontalCrsWkt(metadata.wkt);
  const verticalUnitScale = extractVerticalUnitScale(metadata.wkt);
  const projection = proj4(horizontalWkt, 'WGS84');

  return (point: GeographicPoint): CopcPoint => {
    const [x, y] = projection.inverse([point.longitude, point.latitude]);

    return {
      x,
      y,
      z: (point.height - heightOffset) / verticalUnitScale,
    };
  };
}

export function transformPointBuffer(
  metadata: CopcMetadata,
  points: CopcPointBuffer,
  heightOffsetMeters = 0,
): GeographicPointBuffer {
  return preparedPointDataToGeographicBuffer(
    transformPointBufferToPreparedPointData(metadata, points, heightOffsetMeters),
  );
}

/**
 * Decode output after the shared CRS path, retaining every useful coordinate
 * space in Float64 form for engine adapters. This is the renderer-neutral
 * prepared-point contract retained by the streaming cache.
 */
export function transformPointBufferToPointData(
  metadata: CopcMetadata,
  points: CopcPointBuffer,
  heightOffsetMeters = 0,
): PreparedPointData {
  return transformPointBufferToPreparedPointData(metadata, points, heightOffsetMeters);
}

/** Prepare source points into the shared, renderer-neutral data contract. */
export function transformPointBufferToPreparedPointData(
  metadata: CopcMetadata,
  points: CopcPointBuffer,
  heightOffsetMeters = 0,
): PreparedPointData {
  const transformPoint = createPointTransformer(metadata, heightOffsetMeters);
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

  return createPreparedPointData({
    pointCount: points.pointCount,
    sourceCoordinates,
    geographicCoordinates,
    worldCoordinates,
    attributes: points.attributes,
  });
}

/** Apply a residual ellipsoidal-height correction to an already prepared result. */
export function applyPreparedPointHeightOffset(
  prepared: PreparedPointData,
  heightOffsetDeltaMeters: number,
): PreparedPointData {
  const heightOffsetDelta = resolveHeightOffsetMeters(heightOffsetDeltaMeters);
  assertPreparedPointData(prepared);
  if (heightOffsetDelta === 0) {
    return prepared;
  }

  const geographicCoordinates = prepared.geographic.coordinates.slice();
  const worldCoordinates = new Float64Array(prepared.pointCount * 3);
  for (let index = 0; index < prepared.pointCount; index += 1) {
    const offset = index * 3;
    const point = {
      longitude: geographicCoordinates[offset],
      latitude: geographicCoordinates[offset + 1],
      height: geographicCoordinates[offset + 2] + heightOffsetDelta,
    };
    geographicCoordinates[offset + 2] = point.height;

    const world = geographicToEcef(point);
    worldCoordinates[offset] = world.x;
    worldCoordinates[offset + 1] = world.y;
    worldCoordinates[offset + 2] = world.z;
  }

  return createPreparedPointData({
    pointCount: prepared.pointCount,
    sourceCoordinates: prepared.source.coordinates,
    geographicCoordinates,
    worldCoordinates,
    attributes: prepared.attributes,
  });
}
