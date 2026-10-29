/** WGS 84 Earth-Centered, Earth-Fixed XYZ coordinates in metres. */
export type CopcCesiumEcefPoint = readonly [number, number, number];

/** A half-space whose non-negative side remains visible. */
export type CopcCesiumClippingPlane = {
  /** Plane normal in WGS 84 ECEF XYZ; normalized by the layer. */
  normal: CopcCesiumEcefPoint;
  /** Any WGS 84 ECEF point on the plane, in metres. */
  point: CopcCesiumEcefPoint;
};

/** One renderer-space clip region, evaluated in WGS 84 ECEF metres. */
export type CopcCesiumClippingVolume =
  | {
      /** Intersect the non-negative half-spaces of up to six planes. */
      type: "planes";
      coordinateSystem: "wgs84-ecef-meters";
      planes: readonly CopcCesiumClippingPlane[];
    }
  | {
      /** Inclusive axis-aligned box in WGS 84 ECEF XYZ. */
      type: "box";
      coordinateSystem: "wgs84-ecef-meters";
      minimum: CopcCesiumEcefPoint;
      maximum: CopcCesiumEcefPoint;
    };

/** Internal normalized half-space representation used by CPU and GPU filters. */
export type NormalizedCopcCesiumClippingPlane = {
  normal: [number, number, number];
  point: [number, number, number];
};

export type NormalizedCopcCesiumClippingVolume = {
  input: CopcCesiumClippingVolume;
  planes: NormalizedCopcCesiumClippingPlane[];
};

const MAX_CLIPPING_PLANES = 6;

function clonePoint(value: unknown, name: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`${name} must be an XYZ tuple`);
  }
  const point = value as number[];
  if (!point.every(Number.isFinite)) {
    throw new RangeError(`${name} coordinates must be finite`);
  }
  return [point[0], point[1], point[2]];
}

function normalizePlane(
  plane: CopcCesiumClippingPlane,
  index: number,
): NormalizedCopcCesiumClippingPlane {
  if (!plane || typeof plane !== "object" || Array.isArray(plane)) {
    throw new TypeError(`Clipping plane ${index} must be an object`);
  }
  const normal = clonePoint(plane.normal, `Clipping plane ${index} normal`);
  const point = clonePoint(plane.point, `Clipping plane ${index} point`);
  const length = Math.hypot(...normal);
  if (!Number.isFinite(length) || length === 0) {
    throw new RangeError(`Clipping plane ${index} normal must be nonzero`);
  }
  return {
    normal: [normal[0] / length, normal[1] / length, normal[2] / length],
    point,
  };
}

/**
 * Validate and detach a public volume from caller-owned arrays.
 *
 * @param volume Public ECEF clipping volume, or `undefined` to clear clipping.
 * @returns Normalized planes and a cloned input suitable for the public getter.
 * @throws `TypeError` or `RangeError` when coordinates or volume semantics are invalid.
 */
export function normalizeCopcCesiumClippingVolume(
  volume: CopcCesiumClippingVolume | undefined,
): NormalizedCopcCesiumClippingVolume | undefined {
  if (volume === undefined) return undefined;
  if (volume === null || typeof volume !== "object" || Array.isArray(volume)) {
    throw new TypeError("Clipping volume must be an object");
  }
  if (volume.coordinateSystem !== "wgs84-ecef-meters") {
    throw new TypeError(
      'Clipping volume coordinateSystem must be "wgs84-ecef-meters"',
    );
  }

  if (volume.type === "planes") {
    if (!Array.isArray(volume.planes)) {
      throw new TypeError("Clipping volume planes must be an array");
    }
    if (
      volume.planes.length < 1 ||
      volume.planes.length > MAX_CLIPPING_PLANES
    ) {
      throw new RangeError(
        `Clipping volumes must contain between 1 and ${MAX_CLIPPING_PLANES} planes`,
      );
    }
    const planes = volume.planes.map(normalizePlane);
    return {
      input: {
        type: "planes",
        coordinateSystem: "wgs84-ecef-meters",
        planes: planes.map(({ normal, point }) => ({ normal, point })),
      },
      planes,
    };
  }

  if (volume.type === "box") {
    const minimum = clonePoint(volume.minimum, "Clipping box minimum");
    const maximum = clonePoint(volume.maximum, "Clipping box maximum");
    for (let axis = 0; axis < 3; axis += 1) {
      if (minimum[axis] > maximum[axis]) {
        throw new RangeError(
          "Clipping box minimum must not exceed maximum on any axis",
        );
      }
    }
    const planes: NormalizedCopcCesiumClippingPlane[] = [];
    for (let axis = 0; axis < 3; axis += 1) {
      const positive = [0, 0, 0] as [number, number, number];
      positive[axis] = 1;
      const negative = [0, 0, 0] as [number, number, number];
      negative[axis] = -1;
      const minimumFace = [0, 0, 0] as [number, number, number];
      minimumFace[axis] = minimum[axis];
      const maximumFace = [0, 0, 0] as [number, number, number];
      maximumFace[axis] = maximum[axis];
      planes.push(
        { normal: positive, point: minimumFace },
        { normal: negative, point: maximumFace },
      );
    }
    return {
      input: {
        type: "box",
        coordinateSystem: "wgs84-ecef-meters",
        minimum,
        maximum,
      },
      planes,
    };
  }

  throw new TypeError('Clipping volume type must be "planes" or "box"');
}

/** Test an absolute prepared ECEF point against all inclusive clip planes. */
export function isWorldPointInsideCopcCesiumClippingVolume(
  world: ArrayLike<number>,
  pointIndex: number,
  volume: NormalizedCopcCesiumClippingVolume | undefined,
): boolean {
  if (!volume) return true;
  const offset = pointIndex * 3;
  const x = world[offset];
  const y = world[offset + 1];
  const z = world[offset + 2];
  if (![x, y, z].every(Number.isFinite)) return false;
  return volume.planes.every(({ normal, point }) => {
    const signedDistance =
      normal[0] * (x - point[0]) +
      normal[1] * (y - point[1]) +
      normal[2] * (z - point[2]);
    return signedDistance >= 0;
  });
}
