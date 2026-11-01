import {
  validateTilePointView,
  type TilePointView,
} from '../input/tilePointView.js';

export type TileLocalCoordinateOptions = Readonly<{
  /** Optional exact origin chosen from a tile's conservative bounds. */
  originEcef?: Float64Array;
  /** ECEF origin of the parent tile; identity/zero is the global parent frame. */
  parentOriginEcef?: Float64Array;
  maxAbsoluteErrorMeters?: number;
  maxRelativeError?: number;
}>;

export type TileEcefBounds = Readonly<{
  minimum: readonly [number, number, number];
  maximum: readonly [number, number, number];
}>;

export type TileLocalPositionResult = Readonly<{
  pointCount: number;
  /** glTF Y-up POSITION values; 3D Tiles applies its standard Y-up to Z-up rotation. */
  positions: Float32Array;
  /** Float64 origin in WGS 84 ECEF metres. */
  originEcef: Float64Array;
  /** The single placement transform for tileset.json, relative to parentOriginEcef. */
  tileTransform: Float64Array;
  /** Bounds use the encoded glTF Y-up position axes. */
  positionMin: Float32Array;
  positionMax: Float32Array;
  maxAbsoluteErrorMeters: number;
  maxRelativeError: number;
  context: TilePointView['context'];
}>;

export type TilePrecisionErrorCode =
  | 'INVALID_VIEW'
  | 'INVALID_ECEF'
  | 'INVALID_ORIGIN'
  | 'INVALID_BOUNDS'
  | 'INVALID_ERROR_BUDGET'
  | 'PRECISION_BUDGET_EXCEEDED';

export class TilePrecisionError extends Error {
  readonly code: TilePrecisionErrorCode;
  readonly pointIndex: number | undefined;
  readonly absoluteErrorMeters: number | undefined;
  readonly relativeError: number | undefined;

  constructor(
    code: TilePrecisionErrorCode,
    message: string,
    details: Readonly<{ pointIndex?: number; absoluteErrorMeters?: number; relativeError?: number }> = {},
  ) {
    super(message);
    this.name = 'TilePrecisionError';
    this.code = code;
    this.pointIndex = details.pointIndex;
    this.absoluteErrorMeters = details.absoluteErrorMeters;
    this.relativeError = details.relativeError;
  }
}

const DEFAULT_MAX_ABSOLUTE_ERROR_METERS = 0.01;
const DEFAULT_MAX_RELATIVE_ERROR = 1e-7;

/**
 * Return an a priori Euclidean Float32 rounding bound for a tile-local ECEF
 * origin at the center of a conservative world-space AABB. This bound is
 * based on the maximum local component magnitude, not on decoded samples.
 */
export function getFloat32EcefReconstructionErrorBound(bounds: TileEcefBounds): number {
  if (
    !bounds ||
    !Array.isArray(bounds.minimum) || !Array.isArray(bounds.maximum) ||
    bounds.minimum.length !== 3 || bounds.maximum.length !== 3 ||
    ![...bounds.minimum, ...bounds.maximum].every(Number.isFinite) ||
    bounds.minimum.some((minimum, axis) => minimum > bounds.maximum[axis])
  ) {
    throw new TilePrecisionError('INVALID_BOUNDS', 'ECEF bounds must contain finite ordered three-component vectors.');
  }
  const perAxisHalfUlp: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const minimum = bounds.minimum[axis];
    const maximum = bounds.maximum[axis];
    const origin = minimum + (maximum - minimum) / 2;
    const halfExtent = (maximum - minimum) / 2;
    const subtractionSafety = Number.EPSILON * Math.max(1, Math.abs(minimum), Math.abs(maximum), Math.abs(origin)) * 8;
    const maximumLocalMagnitude = halfExtent + subtractionSafety;
    if (!Number.isFinite(maximumLocalMagnitude) || maximumLocalMagnitude > 3.4028234663852886e38) {
      throw new TilePrecisionError('INVALID_BOUNDS', 'ECEF tile-local extent is outside the finite Float32 range.');
    }
    if (maximumLocalMagnitude === 0 || maximumLocalMagnitude < 2 ** -126) {
      perAxisHalfUlp.push(2 ** -150);
    } else {
      const exponent = Math.floor(Math.log2(maximumLocalMagnitude));
      perAxisHalfUlp.push(2 ** (exponent - 24));
    }
  }
  const result = Math.hypot(perAxisHalfUlp[0], perAxisHalfUlp[1], perAxisHalfUlp[2]);
  if (!Number.isFinite(result)) {
    throw new TilePrecisionError('INVALID_BOUNDS', 'ECEF Float32 reconstruction error bound is not finite.');
  }
  return result;
}

/**
 * Converts WGS 84 ECEF Float64 positions to tile-local Float32 glTF positions.
 * Placement is represented once by a standard 3D Tiles translation transform.
 * Source buffers are read-only and never modified.
 */
export function encodeTileLocalPositions(
  input: TilePointView,
  options: TileLocalCoordinateOptions = {},
): TileLocalPositionResult {
  let view: TilePointView;
  try {
    view = validateTilePointView(input, {
      sourceIdentity: input.context.sourceIdentity,
      transformGeneration: input.context.transformGeneration,
    });
  } catch (error) {
    throw new TilePrecisionError('INVALID_VIEW', `Tile input view failed validation: ${error instanceof Error ? error.message : String(error)}`);
  }

  const absoluteLimit = options.maxAbsoluteErrorMeters ?? DEFAULT_MAX_ABSOLUTE_ERROR_METERS;
  const relativeLimit = options.maxRelativeError ?? DEFAULT_MAX_RELATIVE_ERROR;
  if (!Number.isFinite(absoluteLimit) || absoluteLimit < 0 || !Number.isFinite(relativeLimit) || relativeLimit < 0) {
    throw new TilePrecisionError('INVALID_ERROR_BUDGET', 'Precision error limits must be finite non-negative numbers.');
  }

  const ecef = view.ecef;
  for (let index = 0; index < ecef.length; index += 1) {
    if (!Number.isFinite(ecef[index])) {
      throw new TilePrecisionError('INVALID_ECEF', `ECEF component ${index} is not finite.`, { pointIndex: Math.floor(index / 3) });
    }
  }

  const origin = options.originEcef === undefined ? computeOrigin(ecef) : copyOrigin(options.originEcef, 'originEcef');
  const parentOrigin = options.parentOriginEcef === undefined
    ? new Float64Array(3)
    : copyOrigin(options.parentOriginEcef, 'parentOriginEcef');
  const positions = new Float32Array(ecef.length);
  const positionMin = new Float32Array([Infinity, Infinity, Infinity]);
  const positionMax = new Float32Array([-Infinity, -Infinity, -Infinity]);
  let maxAbsoluteErrorMeters = 0;
  let maxRelativeError = 0;

  for (let point = 0; point < view.pointCount; point += 1) {
    const index = point * 3;
    const dx = ecef[index] - origin[0];
    const dy = ecef[index + 1] - origin[1];
    const dz = ecef[index + 2] - origin[2];

    // Store z-up ECEF-local vectors in glTF's Y-up basis. 3D Tiles applies
    // the standard Y-up-to-Z-up rotation at load time, restoring (dx,dy,dz).
    const gltfX = Math.fround(dx);
    const gltfY = Math.fround(dz);
    const gltfZ = Math.fround(-dy);
    if (!Number.isFinite(gltfX) || !Number.isFinite(gltfY) || !Number.isFinite(gltfZ)) {
      throw new TilePrecisionError('INVALID_ECEF', `Point ${point} is outside Float32 local coordinate range.`, { pointIndex: point });
    }
    positions[index] = gltfX;
    positions[index + 1] = gltfY;
    positions[index + 2] = gltfZ;

    const errorX = gltfX - dx;
    const errorY = -gltfZ - dy;
    const errorZ = gltfY - dz;
    const absoluteError = Math.hypot(errorX, errorY, errorZ);
    const localMagnitude = Math.max(Math.hypot(dx, dy, dz), 1);
    const relativeError = absoluteError / localMagnitude;
    maxAbsoluteErrorMeters = Math.max(maxAbsoluteErrorMeters, absoluteError);
    maxRelativeError = Math.max(maxRelativeError, relativeError);
    if (absoluteError > absoluteLimit || relativeError > relativeLimit) {
      throw new TilePrecisionError(
        'PRECISION_BUDGET_EXCEEDED',
        `Point ${point} exceeds the Float32 precision budget (absolute ${absoluteError} m, relative ${relativeError}). Split the tile or choose a closer origin.`,
        { pointIndex: point, absoluteErrorMeters: absoluteError, relativeError },
      );
    }

    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis];
      positionMin[axis] = Math.min(positionMin[axis], value);
      positionMax[axis] = Math.max(positionMax[axis], value);
    }
  }

  if (view.pointCount === 0) {
    positionMin.fill(0);
    positionMax.fill(0);
  }

  return Object.freeze({
    pointCount: view.pointCount,
    positions,
    originEcef: origin,
    tileTransform: createTileTranslationTransform(origin, parentOrigin),
    positionMin,
    positionMax,
    maxAbsoluteErrorMeters,
    maxRelativeError,
    context: view.context,
  });
}

function computeOrigin(ecef: Float64Array): Float64Array {
  if (ecef.length === 0) return new Float64Array(3);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let point = 0; point < ecef.length / 3; point += 1) {
    const index = point * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = ecef[index + axis];
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  return new Float64Array(minimum.map((minimumValue, axis) => minimumValue + (maximum[axis] - minimumValue) / 2));
}

function copyOrigin(value: Float64Array, name: string): Float64Array {
  if (!(value instanceof Float64Array) || value.length !== 3 || [...value].some((component) => !Number.isFinite(component))) {
    throw new TilePrecisionError('INVALID_ORIGIN', `${name} must be a finite Float64Array with three components.`);
  }
  return new Float64Array(value);
}

export function createTileTranslationTransform(
  originInput: Float64Array,
  parentOriginInput: Float64Array = new Float64Array(3),
): Float64Array {
  const origin = copyOrigin(originInput, 'originEcef');
  const parentOrigin = copyOrigin(parentOriginInput, 'parentOriginEcef');
  const dx = origin[0] - parentOrigin[0];
  const dy = origin[1] - parentOrigin[1];
  const dz = origin[2] - parentOrigin[2];
  if (![dx, dy, dz].every(Number.isFinite)) {
    throw new TilePrecisionError('INVALID_ORIGIN', 'Tile translation is not finite.');
  }
  return new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    dx, dy, dz, 1,
  ]);
}
