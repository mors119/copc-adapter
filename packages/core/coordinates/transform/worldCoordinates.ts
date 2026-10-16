import type {
  RendererLocalPoint,
  Wgs84EcefPoint,
  Wgs84GeographicPoint,
} from '../types';

const WGS84_SEMI_MAJOR_AXIS_METERS = 6378137;
const WGS84_FIRST_ECCENTRICITY_SQUARED = 6.6943799901413165e-3;

function assertFinitePoint(point: { x: number; y: number; z: number }, label: string): void {
  if (![point.x, point.y, point.z].every(Number.isFinite)) {
    throw new Error(`${label} must have finite coordinates`);
  }
}

/** Convert WGS84 longitude/latitude/ellipsoidal height to ECEF metres. */
export function geographicToEcef(
  point: Pick<Wgs84GeographicPoint, 'longitude' | 'latitude' | 'height'>,
): Wgs84EcefPoint {
  if (![point.longitude, point.latitude, point.height].every(Number.isFinite)) {
    throw new Error('Geographic point must have finite coordinates');
  }

  const longitude = (point.longitude * Math.PI) / 180;
  const latitude = (point.latitude * Math.PI) / 180;
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const radiusOfCurvature = WGS84_SEMI_MAJOR_AXIS_METERS /
    Math.sqrt(1 - WGS84_FIRST_ECCENTRICITY_SQUARED * sinLatitude ** 2);
  const horizontalRadius = radiusOfCurvature + point.height;
  const polarRadius = radiusOfCurvature * (1 - WGS84_FIRST_ECCENTRICITY_SQUARED)
    + point.height;

  return {
    coordinateSystem: 'wgs84-ecef-meters',
    x: horizontalRadius * cosLatitude * Math.cos(longitude),
    y: horizontalRadius * cosLatitude * Math.sin(longitude),
    z: polarRadius * sinLatitude,
  };
}

/** Convert WGS84 Earth-centered, Earth-fixed metres to geographic coordinates. */
export function ecefToGeographic(point: Pick<Wgs84EcefPoint, 'x' | 'y' | 'z'>): {
  longitude: number;
  latitude: number;
  height: number;
} {
  assertFinitePoint(point, 'ECEF point');

  const semiMinorAxis = WGS84_SEMI_MAJOR_AXIS_METERS * Math.sqrt(
    1 - WGS84_FIRST_ECCENTRICITY_SQUARED,
  );
  const secondEccentricitySquared = (
    WGS84_SEMI_MAJOR_AXIS_METERS ** 2 - semiMinorAxis ** 2
  ) / semiMinorAxis ** 2;
  const horizontalDistance = Math.hypot(point.x, point.y);
  const longitude = Math.atan2(point.y, point.x);

  if (horizontalDistance < 1e-10) {
    const latitude = point.z >= 0 ? Math.PI / 2 : -Math.PI / 2;
    const height = Math.abs(point.z) - semiMinorAxis;
    return {
      longitude: 0,
      latitude: (latitude * 180) / Math.PI,
      height,
    };
  }

  const theta = Math.atan2(
    WGS84_SEMI_MAJOR_AXIS_METERS * point.z,
    semiMinorAxis * horizontalDistance,
  );
  const sinTheta = Math.sin(theta);
  const cosTheta = Math.cos(theta);
  const latitude = Math.atan2(
    point.z + secondEccentricitySquared * semiMinorAxis * sinTheta ** 3,
    horizontalDistance - WGS84_FIRST_ECCENTRICITY_SQUARED
      * WGS84_SEMI_MAJOR_AXIS_METERS * cosTheta ** 3,
  );
  const sinLatitude = Math.sin(latitude);
  const radiusOfCurvature = WGS84_SEMI_MAJOR_AXIS_METERS / Math.sqrt(
    1 - WGS84_FIRST_ECCENTRICITY_SQUARED * sinLatitude ** 2,
  );
  const height = horizontalDistance / Math.cos(latitude) - radiusOfCurvature;

  return {
    longitude: (longitude * 180) / Math.PI,
    latitude: (latitude * 180) / Math.PI,
    height,
  };
}

/**
 * Subtract a renderer-selected origin in shared ECEF world space.
 *
 * This deliberately returns JavaScript numbers, not Float32 values. An
 * adapter can subtract the origin while values are still high precision and
 * only then create its renderer/GPU buffer.
 */
export function worldToLocal(
  world: Wgs84EcefPoint,
  origin: Wgs84EcefPoint,
): RendererLocalPoint {
  if (
    world.coordinateSystem !== 'wgs84-ecef-meters'
    || origin.coordinateSystem !== 'wgs84-ecef-meters'
  ) {
    throw new Error('World point and origin must use wgs84-ecef-meters');
  }

  assertFinitePoint(world, 'World point');
  assertFinitePoint(origin, 'World origin');

  return {
    coordinateSystem: 'renderer-local',
    x: world.x - origin.x,
    y: world.y - origin.y,
    z: world.z - origin.z,
  };
}

/** Transform interleaved ECEF triples to a local frame without early Float32 coercion. */
export function worldBufferToLocal(
  worldCoordinates: Float64Array,
  origin: Wgs84EcefPoint,
): Float64Array {
  if (worldCoordinates.length % 3 !== 0) {
    throw new Error('World coordinate buffer must contain XYZ triples');
  }

  const localCoordinates = new Float64Array(worldCoordinates.length);
  for (let index = 0; index < worldCoordinates.length; index += 3) {
    const local = worldToLocal({
      coordinateSystem: 'wgs84-ecef-meters',
      x: worldCoordinates[index],
      y: worldCoordinates[index + 1],
      z: worldCoordinates[index + 2],
    }, origin);
    localCoordinates[index] = local.x;
    localCoordinates[index + 1] = local.y;
    localCoordinates[index + 2] = local.z;
  }

  return localCoordinates;
}
