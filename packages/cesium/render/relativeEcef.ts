/** Float32 render coordinates relative to a per-node Float64 ECEF origin. */
export type RelativeEcefCoordinates = {
  /** Per-node world-space origin in WGS84 ECEF metres. */
  origin: [number, number, number];
  /** Interleaved XYZ offsets in metres, narrowed to Float32. */
  positions: Float32Array;
  /** Radius in metres enclosing the source Float64 points around the origin. */
  radius: number;
  /** Largest absolute Float64-to-Float32 component error in metres. */
  maxAbsoluteError: number;
};

/**
 * Pack ECEF metres into node-local coordinates. The origin and subtraction
 * stay Float64 on the CPU; the relative coordinates are explicitly narrowed
 * to Float32 for Cesium's vertex attributes.
 *
 * @param world Interleaved WGS84 ECEF metre triples.
 * @returns Relative coordinates, their origin, conservative input radius, and maximum narrowing error.
 * @throws If the buffer is empty, malformed, or contains non-finite values.
 */
export function packRelativeEcef(world: Float64Array): RelativeEcefCoordinates {
  if (world.length === 0 || world.length % 3 !== 0) {
    throw new Error('ECEF coordinates must contain one or more XYZ triples');
  }
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let index = 0; index < world.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = world[index + axis];
      if (!Number.isFinite(value)) throw new Error('ECEF coordinates must be finite');
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  const origin: [number, number, number] = [
    (minimum[0] + maximum[0]) / 2,
    (minimum[1] + maximum[1]) / 2,
    (minimum[2] + maximum[2]) / 2,
  ];
  const positions = new Float32Array(world.length);
  let radiusSquared = 0;
  let maxAbsoluteError = 0;
  for (let index = 0; index < world.length; index += 3) {
    let distanceSquared = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const relative = world[index + axis] - origin[axis];
      const narrowed = Math.fround(relative);
      positions[index + axis] = narrowed;
      const error = Math.abs(relative - narrowed);
      maxAbsoluteError = Math.max(maxAbsoluteError, error);
      distanceSquared += relative * relative;
    }
    radiusSquared = Math.max(radiusSquared, distanceSquared);
  }
  return { origin, positions, radius: Math.sqrt(radiusSquared), maxAbsoluteError };
}
