/** A small, serializable vector used at the Cesium/streaming boundary. */
export type ViewVector3 = {
  x: number;
  y: number;
  z: number;
};

export type BoundingSphere = {
  center: ViewVector3;
  radiusMeters: number;
};

export type FrustumPlane = {
  /** Plane interior is the non-negative side of this equation. */
  normal: ViewVector3;
  distance: number;
};

/**
 * Perspective view in WGS84 Earth-centered, Earth-fixed metres.
 *
 * This type deliberately contains no Cesium objects. It can be serialized,
 * unit-tested, and passed through the streaming selector independently of the
 * viewer implementation.
 */
export type ViewFrustum = {
  coordinateSystem: 'wgs84-ecef-meters';
  position: ViewVector3;
  direction: ViewVector3;
  up: ViewVector3;
  right: ViewVector3;
  planes: FrustumPlane[];
  verticalFovRadians: number;
  aspectRatio: number;
  nearMeters: number;
  farMeters: number;
};

export type PerspectiveViewInput = {
  position: ViewVector3;
  direction: ViewVector3;
  up: ViewVector3;
  right: ViewVector3;
  verticalFovRadians: number;
  aspectRatio: number;
  nearMeters: number;
  farMeters: number;
};

const WGS84_SEMI_MAJOR_AXIS_METERS = 6378137;
const WGS84_FIRST_ECCENTRICITY_SQUARED = 6.6943799901413165e-3;

function dot(left: ViewVector3, right: ViewVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function length(vector: ViewVector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector: ViewVector3): ViewVector3 {
  const magnitude = length(vector);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error('View vector must have a finite, non-zero length');
  }

  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
    z: vector.z / magnitude,
  };
}

function add(left: ViewVector3, right: ViewVector3): ViewVector3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function multiply(vector: ViewVector3, scalar: number): ViewVector3 {
  return { x: vector.x * scalar, y: vector.y * scalar, z: vector.z * scalar };
}

function plane(normal: ViewVector3, point: ViewVector3): FrustumPlane {
  return {
    normal,
    distance: -dot(normal, point),
  };
}

function validateInput(input: PerspectiveViewInput): void {
  if (
    !Number.isFinite(input.verticalFovRadians) ||
    input.verticalFovRadians <= 0 ||
    input.verticalFovRadians >= Math.PI ||
    !Number.isFinite(input.aspectRatio) ||
    input.aspectRatio <= 0 ||
    !Number.isFinite(input.nearMeters) ||
    input.nearMeters < 0 ||
    !Number.isFinite(input.farMeters) ||
    input.farMeters <= input.nearMeters
  ) {
    throw new Error('Invalid perspective view parameters');
  }
}

/** Build a conservative six-plane perspective frustum from plain vectors. */
export function createPerspectiveViewFrustum(
  input: PerspectiveViewInput,
): ViewFrustum {
  validateInput(input);

  const direction = normalize(input.direction);
  const up = normalize(input.up);
  const right = normalize(input.right);
  const verticalTangent = Math.tan(input.verticalFovRadians / 2);
  const horizontalTangent = verticalTangent * input.aspectRatio;
  const nearPoint = add(input.position, multiply(direction, input.nearMeters));
  const farPoint = add(input.position, multiply(direction, input.farMeters));

  return {
    coordinateSystem: 'wgs84-ecef-meters',
    position: { ...input.position },
    direction,
    up,
    right,
    planes: [
      // left, right, bottom, top, near, far; interior is n dot p + d >= 0.
      plane(normalize(add(right, multiply(direction, horizontalTangent))), input.position),
      plane(normalize(add(multiply(right, -1), multiply(direction, horizontalTangent))), input.position),
      plane(normalize(add(up, multiply(direction, verticalTangent))), input.position),
      plane(normalize(add(multiply(up, -1), multiply(direction, verticalTangent))), input.position),
      plane(direction, nearPoint),
      plane(multiply(direction, -1), farPoint),
    ],
    verticalFovRadians: input.verticalFovRadians,
    aspectRatio: input.aspectRatio,
    nearMeters: input.nearMeters,
    farMeters: input.farMeters,
  };
}

/** Return true unless a node sphere is completely outside one frustum plane. */
export function intersectsViewFrustum(
  frustum: ViewFrustum,
  sphere: BoundingSphere,
): boolean {
  // The tolerance intentionally biases toward retaining edge-touching nodes.
  const edgeTolerance = Math.max(1, sphere.radiusMeters * 1e-6);

  return frustum.planes.every((currentPlane) =>
    dot(currentPlane.normal, sphere.center) + currentPlane.distance
      >= -sphere.radiusMeters - edgeTolerance);
}

/** Convert WGS84 longitude/latitude/ellipsoidal height to ECEF metres. */
export function geographicToEcef(point: {
  longitude: number;
  latitude: number;
  height: number;
}): ViewVector3 {
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
    x: horizontalRadius * cosLatitude * Math.cos(longitude),
    y: horizontalRadius * cosLatitude * Math.sin(longitude),
    z: polarRadius * sinLatitude,
  };
}

export function createBoundingSphereFromGeographicBounds(
  center: { longitude: number; latitude: number; height: number },
  bounds: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  },
): BoundingSphere {
  const sphereCenter = geographicToEcef(center);
  let radiusMeters = 0;

  for (const longitude of [bounds.minX, bounds.maxX]) {
    for (const latitude of [bounds.minY, bounds.maxY]) {
      for (const height of [bounds.minZ, bounds.maxZ]) {
        const corner = geographicToEcef({ longitude, latitude, height });
        radiusMeters = Math.max(
          radiusMeters,
          Math.hypot(
            corner.x - sphereCenter.x,
            corner.y - sphereCenter.y,
            corner.z - sphereCenter.z,
          ),
        );
      }
    }
  }

  return {
    center: sphereCenter,
    // Keep a small numerical cushion for transformed/projected boxes and
    // camera planes that meet exactly at a frustum edge.
    radiusMeters: radiusMeters + Math.max(1, radiusMeters * 1e-6),
  };
}
