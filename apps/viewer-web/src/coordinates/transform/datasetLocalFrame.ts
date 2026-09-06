import type { CopcMetadata } from '../../copc/types/copc';
import { createPointTransformer } from './createPointTransformer';
import {
  geographicToEcef,
} from './worldCoordinates';
import type {
  CoordinateDirection,
  CoordinateBounds,
  DatasetLocalFrame,
  RendererLocalPoint,
  Wgs84EcefBounds,
  Wgs84EcefPoint,
} from '../types';

const WORLD_COORDINATE_SYSTEM = 'wgs84-ecef-meters' as const;
const LOCAL_COORDINATE_SYSTEM = 'renderer-local' as const;

type FiniteVector = { x: number; y: number; z: number };

function assertFiniteVector(vector: FiniteVector, label: string): void {
  if (![vector.x, vector.y, vector.z].every(Number.isFinite)) {
    throw new Error(`${label} must have finite coordinates`);
  }
}

function assertWorldPoint(point: Wgs84EcefPoint, label: string): void {
  if (point.coordinateSystem !== WORLD_COORDINATE_SYSTEM) {
    throw new Error(`${label} must use ${WORLD_COORDINATE_SYSTEM}`);
  }

  assertFiniteVector(point, label);
}

function assertLocalPoint(point: RendererLocalPoint): void {
  if (point.coordinateSystem !== LOCAL_COORDINATE_SYSTEM) {
    throw new Error(`Local point must use ${LOCAL_COORDINATE_SYSTEM}`);
  }

  assertFiniteVector(point, 'Local point');
}

function dot(left: FiniteVector, right: FiniteVector): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function addScaled(
  left: FiniteVector,
  right: FiniteVector,
  scalar: number,
): CoordinateDirection {
  return {
    x: left.x + right.x * scalar,
    y: left.y + right.y * scalar,
    z: left.z + right.z * scalar,
  };
}

function freezePoint(point: Wgs84EcefPoint): Readonly<Wgs84EcefPoint> {
  return Object.freeze({ ...point });
}

function freezeDirection(direction: CoordinateDirection): Readonly<CoordinateDirection> {
  return Object.freeze({ ...direction });
}

function getDatasetSourceOrigin(metadata: CopcMetadata): {
  x: number;
  y: number;
  z: number;
} {
  const { minX, minY, minZ, maxX, maxY, maxZ } = metadata.cube;
  const cubeValues = [minX, minY, minZ, maxX, maxY, maxZ];

  if (!cubeValues.every(Number.isFinite)) {
    throw new Error('COPC cube bounds must have finite coordinates');
  }

  if (maxX <= minX || maxY <= minY || maxZ <= minZ) {
    throw new Error('COPC cube bounds must have positive dimensions');
  }

  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: (minZ + maxZ) / 2,
  };
}

/**
 * Create the fixed dataset-local frame used by a renderer adapter.
 *
 * The origin is the COPC cube centre after the existing source-CRS to WGS84
 * transform. Local axes are an orthonormal geodetic ENU basis at that ECEF
 * origin: +X east, +Y north, and +Z up. The returned object is deeply
 * immutable at the frame boundary so it can be shared by point and camera
 * adapters for the full lifetime of a loaded dataset.
 */
export function createDatasetLocalFrame(
  metadata: CopcMetadata,
): DatasetLocalFrame {
  const sourceOrigin = getDatasetSourceOrigin(metadata);
  const geographicOrigin = createPointTransformer(metadata)(sourceOrigin);
  const origin = geographicToEcef(geographicOrigin);
  const longitude = (geographicOrigin.longitude * Math.PI) / 180;
  const latitude = (geographicOrigin.latitude * Math.PI) / 180;
  const sinLongitude = Math.sin(longitude);
  const cosLongitude = Math.cos(longitude);
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);

  const east = {
    x: -sinLongitude,
    y: cosLongitude,
    z: 0,
  };
  const north = {
    x: -sinLatitude * cosLongitude,
    y: -sinLatitude * sinLongitude,
    z: cosLatitude,
  };
  const up = {
    x: cosLatitude * cosLongitude,
    y: cosLatitude * sinLongitude,
    z: sinLatitude,
  };

  assertWorldPoint(origin, 'Dataset frame origin');
  assertFiniteVector(east, 'Dataset frame east axis');
  assertFiniteVector(north, 'Dataset frame north axis');
  assertFiniteVector(up, 'Dataset frame up axis');

  return Object.freeze({
    coordinateSystem: LOCAL_COORDINATE_SYSTEM,
    axisConvention: 'enu',
    units: 'metres',
    origin: freezePoint(origin),
    east: freezeDirection(east),
    north: freezeDirection(north),
    up: freezeDirection(up),
  });
}

/** Convert a shared WGS84 ECEF position into fixed dataset-local ENU metres. */
export function worldToDatasetLocal(
  world: Wgs84EcefPoint,
  frame: DatasetLocalFrame,
): RendererLocalPoint {
  assertWorldPoint(world, 'World point');
  const delta = {
    x: world.x - frame.origin.x,
    y: world.y - frame.origin.y,
    z: world.z - frame.origin.z,
  };

  return {
    coordinateSystem: LOCAL_COORDINATE_SYSTEM,
    x: dot(delta, frame.east),
    y: dot(delta, frame.north),
    z: dot(delta, frame.up),
  };
}

/** Convert a dataset-local ENU position back into shared WGS84 ECEF metres. */
export function datasetLocalToWorld(
  local: RendererLocalPoint,
  frame: DatasetLocalFrame,
): Wgs84EcefPoint {
  assertLocalPoint(local);
  const world = addScaled(
    addScaled(
      addScaled(frame.origin, frame.east, local.x),
      frame.north,
      local.y,
    ),
    frame.up,
    local.z,
  );

  return {
    coordinateSystem: WORLD_COORDINATE_SYSTEM,
    x: world.x,
    y: world.y,
    z: world.z,
  };
}

/** Transform a direction/vector from shared ECEF axes into dataset-local ENU. */
export function worldDirectionToDatasetLocal(
  worldDirection: CoordinateDirection,
  frame: DatasetLocalFrame,
): CoordinateDirection {
  assertFiniteVector(worldDirection, 'World direction');

  return {
    x: dot(worldDirection, frame.east),
    y: dot(worldDirection, frame.north),
    z: dot(worldDirection, frame.up),
  };
}

/** Transform a direction/vector from dataset-local ENU into shared ECEF axes. */
export function datasetLocalDirectionToWorld(
  localDirection: CoordinateDirection,
  frame: DatasetLocalFrame,
): CoordinateDirection {
  assertFiniteVector(localDirection, 'Local direction');

  return addScaled(
    addScaled(
      addScaled({ x: 0, y: 0, z: 0 }, frame.east, localDirection.x),
      frame.north,
      localDirection.y,
    ),
    frame.up,
    localDirection.z,
  );
}

/** Transform interleaved ECEF triples to local ENU before any Float32 cast. */
export function worldBufferToDatasetLocal(
  worldCoordinates: Float64Array,
  frame: DatasetLocalFrame,
): Float64Array {
  if (worldCoordinates.length % 3 !== 0) {
    throw new Error('World coordinate buffer must contain XYZ triples');
  }

  const localCoordinates = new Float64Array(worldCoordinates.length);
  for (let index = 0; index < worldCoordinates.length; index += 3) {
    const local = worldToDatasetLocal({
      coordinateSystem: WORLD_COORDINATE_SYSTEM,
      x: worldCoordinates[index],
      y: worldCoordinates[index + 1],
      z: worldCoordinates[index + 2],
    }, frame);
    localCoordinates[index] = local.x;
    localCoordinates[index + 1] = local.y;
    localCoordinates[index + 2] = local.z;
  }

  return localCoordinates;
}

/**
 * Derive renderer-local bounds from shared ECEF bounds.
 *
 * This is intentionally a presentation helper: the shared hierarchy's
 * source/geographic/ECEF bounds remain authoritative for selection and LoD.
 */
export function worldBoundsToDatasetLocal(
  bounds: Wgs84EcefBounds,
  frame: DatasetLocalFrame,
): CoordinateBounds<'renderer-local'> {
  if (bounds.coordinateSystem !== WORLD_COORDINATE_SYSTEM) {
    throw new Error(`World bounds must use ${WORLD_COORDINATE_SYSTEM}`);
  }

  const values = [
    bounds.minX,
    bounds.minY,
    bounds.minZ,
    bounds.maxX,
    bounds.maxY,
    bounds.maxZ,
  ];
  if (!values.every(Number.isFinite)) {
    throw new Error('World bounds must have finite coordinates');
  }

  const corners = [
    [bounds.minX, bounds.minY, bounds.minZ],
    [bounds.minX, bounds.minY, bounds.maxZ],
    [bounds.minX, bounds.maxY, bounds.minZ],
    [bounds.minX, bounds.maxY, bounds.maxZ],
    [bounds.maxX, bounds.minY, bounds.minZ],
    [bounds.maxX, bounds.minY, bounds.maxZ],
    [bounds.maxX, bounds.maxY, bounds.minZ],
    [bounds.maxX, bounds.maxY, bounds.maxZ],
  ].map(([x, y, z]) => worldToDatasetLocal({
    coordinateSystem: WORLD_COORDINATE_SYSTEM,
    x,
    y,
    z,
  }, frame));

  return corners.reduce<CoordinateBounds<'renderer-local'>>((result, corner) => ({
    coordinateSystem: LOCAL_COORDINATE_SYSTEM,
    minX: Math.min(result.minX, corner.x),
    minY: Math.min(result.minY, corner.y),
    minZ: Math.min(result.minZ, corner.z),
    maxX: Math.max(result.maxX, corner.x),
    maxY: Math.max(result.maxY, corner.y),
    maxZ: Math.max(result.maxZ, corner.z),
  }), {
    coordinateSystem: LOCAL_COORDINATE_SYSTEM,
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  });
}
