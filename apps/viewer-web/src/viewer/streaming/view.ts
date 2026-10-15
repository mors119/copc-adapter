import {
  ecefToGeographic,
  geographicToEcef,
} from '../../coordinates/transform/worldCoordinates';

export {
  ecefToGeographic,
  geographicToEcef,
} from '../../coordinates/transform/worldCoordinates';

/** A small, serializable vector used at the renderer/streaming boundary. */
export type ViewVector3 = {
  x: number;
  y: number;
  z: number;
};

export type BoundingSphere = {
  /** Bounding sphere coordinates are WGS84 ECEF metres, never renderer-local. */
  coordinateSystem: 'wgs84-ecef-meters';
  center: ViewVector3;
  radiusMeters: number;
};

/**
 * Input accepted by the frustum helper, including pre-#134 unlabeled spheres.
 * Shared streaming nodes continue to use the explicitly labeled BoundingSphere.
 */
export type BoundingSphereInput =
  | BoundingSphere
  | Omit<BoundingSphere, 'coordinateSystem'>;

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
  /** Drawing-buffer height used to convert projected size to pixels. */
  viewportHeightPixels: number;
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
  viewportHeightPixels?: number;
  aspectRatio: number;
  nearMeters: number;
  farMeters: number;
};

export type GeographicViewBounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

export type StreamingViewBoundsInput = {
  camera: {
    longitude: number;
    latitude: number;
    height: number;
  };
  viewDistanceMeters: number;
  maxRenderDistanceMeters: number;
  viewFrustum?: ViewFrustum;
};

export type StreamingViewBounds = {
  bounds: GeographicViewBounds;
  mode: 'frustum' | 'camera-fallback';
  effectiveFarMeters: number;
};

export type AdaptiveViewDistanceTransition =
  | 'initialized'
  | 'expanded'
  | 'shrunk'
  | 'held'
  | 'fallback';

/** Aggregate view-distance diagnostics attached to the current streaming view. */
export type AdaptiveViewDistanceDiagnostics = {
  /** Farthest sampled ground footprint along the perspective view, before overscan. */
  visibleFootprintMeters?: number;
  /** Current footprint plus the bounded overscan, before hysteresis. */
  targetDistanceMeters: number;
  /** Distance consumed by the streaming selector and hierarchy query. */
  effectiveDistanceMeters: number;
  maxRenderDistanceMeters: number;
  overscanFactor: number;
  clampedToMaxRenderDistance: boolean;
  transition: AdaptiveViewDistanceTransition;
  updateCount: number;
  expansionCount: number;
  shrinkCount: number;
  hysteresisHoldCount: number;
  fallbackCount: number;
};

type AdaptiveViewDistanceInput = {
  longitude: number;
  latitude: number;
  height: number;
  viewDistanceMeters: number;
  viewFrustum?: ViewFrustum;
};

const ADAPTIVE_VIEW_OVERSCAN_FACTOR = 1.5;
const ADAPTIVE_VIEW_EXPANSION_RATIO = 1.15;
const ADAPTIVE_VIEW_SHRINK_RATIO = 0.75;
const ADAPTIVE_VIEW_MIN_DISTANCE_METERS = 25;
const ADAPTIVE_GROUND_CLEARANCE_METERS = 25;
const ADAPTIVE_VIEW_RAY_EPSILON = 1e-8;

function samplePerspectiveRayDirections(frustum: ViewFrustum): ViewVector3[] {
  const verticalTangent = Math.tan(frustum.verticalFovRadians / 2);
  const horizontalTangent = verticalTangent * frustum.aspectRatio;
  if (!Number.isFinite(verticalTangent) || !Number.isFinite(horizontalTangent)) {
    return [];
  }
  const direction = normalize(frustum.direction);
  const up = normalize(frustum.up);
  const right = normalize(frustum.right);

  const directions: ViewVector3[] = [];
  // Include the center, edge midpoints, and corners. This captures the
  // farthest ground intersection for a perspective footprint without tying
  // the estimate to a particular renderer's frustum implementation.
  for (const horizontal of [-1, 0, 1]) {
    for (const vertical of [-1, 0, 1]) {
      directions.push(normalize(add(
        add(
          direction,
          multiply(right, horizontal * horizontalTangent),
        ),
        multiply(up, vertical * verticalTangent),
      )));
    }
  }
  return directions;
}

/**
 * Estimate the farthest ground footprint reached by the current perspective
 * view. The local tangent plane is placed at least 25 m below the WGS84
 * surface and below the dataset's minimum elevation, when known. A view whose
 * cone reaches the horizon uses its configured hard distance cap as a fallback.
 */
export function estimateVisibleFootprintDistanceMeters(
  view: AdaptiveViewDistanceInput,
  maxRenderDistanceMeters: number,
  minimumDatasetHeightMeters?: number,
): number | undefined {
  return estimateVisibleFootprint(view, maxRenderDistanceMeters, minimumDatasetHeightMeters)
    ?.distanceMeters;
}

type VisibleFootprintEstimate = {
  distanceMeters: number;
  usedFallback: boolean;
};

function estimateVisibleFootprint(
  view: AdaptiveViewDistanceInput,
  maxRenderDistanceMeters: number,
  minimumDatasetHeightMeters?: number,
): VisibleFootprintEstimate | undefined {
  const frustum = view.viewFrustum;
  if (!isUsablePerspectiveFrustum(frustum)
    || !Number.isFinite(maxRenderDistanceMeters)
    || maxRenderDistanceMeters <= 0
    || !Number.isFinite(view.longitude)
    || !Number.isFinite(view.latitude)
    || !Number.isFinite(view.height)) {
    return undefined;
  }

  let directions: ViewVector3[];
  let direction: ViewVector3;
  let up: ViewVector3;
  let right: ViewVector3;
  try {
    direction = normalize(frustum.direction);
    up = normalize(frustum.up);
    right = normalize(frustum.right);
    directions = samplePerspectiveRayDirections(frustum);
  } catch {
    return undefined;
  }
  if (directions.length === 0) {
    return undefined;
  }

  const longitudeRadians = (view.longitude * Math.PI) / 180;
  const latitudeRadians = (view.latitude * Math.PI) / 180;
  const localUp = {
    x: Math.cos(latitudeRadians) * Math.cos(longitudeRadians),
    y: Math.cos(latitudeRadians) * Math.sin(longitudeRadians),
    z: Math.sin(latitudeRadians),
  };
  const verticalTangent = Math.tan(frustum.verticalFovRadians / 2);
  const horizontalTangent = verticalTangent * frustum.aspectRatio;
  const horizonReach = dot(direction, localUp)
    + Math.abs(dot(right, localUp)) * horizontalTangent
    + Math.abs(dot(up, localUp)) * verticalTangent;
  if (!Number.isFinite(horizonReach)) {
    return undefined;
  }
  // If the perspective cone touches the local horizon, ground range is
  // unbounded in this approximation. Preserve coverage conservatively up to
  // the frustum/application ceiling instead of trusting sparse ray samples.
  if (horizonReach >= -ADAPTIVE_VIEW_RAY_EPSILON) {
    return {
      distanceMeters: Math.min(frustum.farMeters, maxRenderDistanceMeters),
      usedFallback: true,
    };
  }

  const datasetMinimumHeight = Number.isFinite(minimumDatasetHeightMeters)
    ? minimumDatasetHeightMeters as number
    : 0;
  const groundPlaneHeight = Math.min(
    -ADAPTIVE_GROUND_CLEARANCE_METERS,
    datasetMinimumHeight - ADAPTIVE_GROUND_CLEARANCE_METERS,
  );
  const cameraGroundDistance = Math.max(
    view.height - groundPlaneHeight,
    ADAPTIVE_GROUND_CLEARANCE_METERS,
  );
  if (!Number.isFinite(cameraGroundDistance)) {
    return undefined;
  }

  let farthestGroundDistance = 0;
  for (const direction of directions) {
    const downwardRate = -dot(direction, localUp);
    if (!Number.isFinite(downwardRate) || downwardRate <= ADAPTIVE_VIEW_RAY_EPSILON) {
      continue;
    }

    const intersectionDistance = cameraGroundDistance / downwardRate;
    if (!Number.isFinite(intersectionDistance) || intersectionDistance < 0) {
      continue;
    }
    farthestGroundDistance = Math.max(
      farthestGroundDistance,
      Math.min(intersectionDistance, frustum.farMeters, maxRenderDistanceMeters),
    );
  }

  return farthestGroundDistance > 0
    ? { distanceMeters: farthestGroundDistance, usedFallback: false }
    : undefined;
}

/**
 * Renderer-neutral asymmetric hysteresis for the current visible footprint.
 * Expansions are immediate; a view must need less than 75% of the current
 * range before the policy shrinks it. The 1.5x overscan retains adjacent edge
 * coverage while remaining independent of any future-view prefetch policy.
 */
export class AdaptiveViewDistancePolicy {
  private currentDistanceMeters?: number;
  private updateCount = 0;
  private expansionCount = 0;
  private shrinkCount = 0;
  private hysteresisHoldCount = 0;
  private fallbackCount = 0;

  apply(
    view: AdaptiveViewDistanceInput,
    maxRenderDistanceMeters: number,
    minimumDatasetHeightMeters?: number,
  ): AdaptiveViewDistanceInput & {
    viewDistanceDiagnostics: AdaptiveViewDistanceDiagnostics;
  } {
    return this.resolve(view, maxRenderDistanceMeters, minimumDatasetHeightMeters, true);
  }

  /** Calculate an update view without changing hysteresis or aggregate counts. */
  preview(
    view: AdaptiveViewDistanceInput,
    maxRenderDistanceMeters: number,
    minimumDatasetHeightMeters?: number,
  ): AdaptiveViewDistanceInput & {
    viewDistanceDiagnostics: AdaptiveViewDistanceDiagnostics;
  } {
    return this.resolve(view, maxRenderDistanceMeters, minimumDatasetHeightMeters, false);
  }

  private resolve(
    view: AdaptiveViewDistanceInput,
    maxRenderDistanceMeters: number,
    minimumDatasetHeightMeters: number | undefined,
    commit: boolean,
  ): AdaptiveViewDistanceInput & {
    viewDistanceDiagnostics: AdaptiveViewDistanceDiagnostics;
  } {
    const safeMaximum = Number.isFinite(maxRenderDistanceMeters)
      ? Math.max(maxRenderDistanceMeters, 0)
      : 0;
    const footprintEstimate = estimateVisibleFootprint(
      view,
      safeMaximum,
      minimumDatasetHeightMeters,
    );
    const footprint = footprintEstimate?.distanceMeters;
    const usedFallback = footprintEstimate?.usedFallback ?? footprint === undefined;
    const hasFrustum = view.viewFrustum !== undefined;
    const fallbackDistance = hasFrustum
      ? safeMaximum
      : Number.isFinite(view.viewDistanceMeters)
        ? Math.max(view.viewDistanceMeters, 0)
        : safeMaximum;
    const unclampedTarget = footprint === undefined
      ? fallbackDistance
      : Math.max(
        ADAPTIVE_VIEW_MIN_DISTANCE_METERS,
        footprint * ADAPTIVE_VIEW_OVERSCAN_FACTOR,
      );
    const targetDistanceMeters = Math.min(
      unclampedTarget,
      safeMaximum,
      isUsablePerspectiveFrustum(view.viewFrustum)
        ? view.viewFrustum.farMeters
        : safeMaximum,
    );

    let effectiveDistanceMeters = targetDistanceMeters;
    let transition: AdaptiveViewDistanceTransition;
    let expansionCount = this.expansionCount;
    let updateCount = this.updateCount;
    let shrinkCount = this.shrinkCount;
    let hysteresisHoldCount = this.hysteresisHoldCount;
    let fallbackCount = this.fallbackCount;
    if (usedFallback) {
      transition = 'fallback';
      if (commit) fallbackCount += 1;
    } else if (this.currentDistanceMeters === undefined) {
      transition = 'initialized';
    } else if (targetDistanceMeters > this.currentDistanceMeters * ADAPTIVE_VIEW_EXPANSION_RATIO) {
      transition = 'expanded';
      if (commit) expansionCount += 1;
    } else if (targetDistanceMeters < this.currentDistanceMeters * ADAPTIVE_VIEW_SHRINK_RATIO) {
      transition = 'shrunk';
      if (commit) shrinkCount += 1;
    } else {
      transition = 'held';
      if (commit) hysteresisHoldCount += 1;
      effectiveDistanceMeters = this.currentDistanceMeters;
    }

    if (commit) {
      this.currentDistanceMeters = effectiveDistanceMeters;
      updateCount += 1;
      this.updateCount = updateCount;
      this.expansionCount = expansionCount;
      this.shrinkCount = shrinkCount;
      this.hysteresisHoldCount = hysteresisHoldCount;
      this.fallbackCount = fallbackCount;
    }
    const clampedToMaxRenderDistance = unclampedTarget > safeMaximum
      || (footprint === undefined && hasFrustum);
    return {
      ...view,
      viewDistanceMeters: effectiveDistanceMeters,
      viewDistanceDiagnostics: {
        ...(footprint === undefined || usedFallback
          ? {}
          : { visibleFootprintMeters: footprint }),
        targetDistanceMeters,
        effectiveDistanceMeters,
        maxRenderDistanceMeters: safeMaximum,
        overscanFactor: ADAPTIVE_VIEW_OVERSCAN_FACTOR,
        clampedToMaxRenderDistance,
        transition,
        updateCount,
        expansionCount,
        shrinkCount,
        hysteresisHoldCount,
        fallbackCount,
      },
    };
  }

  reset(): void {
    this.currentDistanceMeters = undefined;
    this.updateCount = 0;
    this.expansionCount = 0;
    this.shrinkCount = 0;
    this.hysteresisHoldCount = 0;
    this.fallbackCount = 0;
  }
}

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
    input.farMeters <= input.nearMeters ||
    (input.viewportHeightPixels !== undefined &&
      (!Number.isFinite(input.viewportHeightPixels) || input.viewportHeightPixels <= 0))
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
    viewportHeightPixels: input.viewportHeightPixels ?? 1080,
    aspectRatio: input.aspectRatio,
    nearMeters: input.nearMeters,
    farMeters: input.farMeters,
  };
}

/** Return true unless a node sphere is completely outside one frustum plane. */
export function intersectsViewFrustum(
  frustum: ViewFrustum,
  sphere: BoundingSphereInput,
): boolean {
  // Accept unlabeled legacy test/custom objects, but never compare spheres
  // explicitly labeled in a different coordinate space.
  if (
    'coordinateSystem' in sphere
    && sphere.coordinateSystem !== frustum.coordinateSystem
  ) {
    return false;
  }

  // The tolerance intentionally biases toward retaining edge-touching nodes.
  const edgeTolerance = Math.max(1, sphere.radiusMeters * 1e-6);

  return frustum.planes.every((currentPlane) =>
    dot(currentPlane.normal, sphere.center) + currentPlane.distance
      >= -sphere.radiusMeters - edgeTolerance);
}

function isFiniteVector(vector: ViewVector3 | undefined): vector is ViewVector3 {
  return vector !== undefined
    && Number.isFinite(vector.x)
    && Number.isFinite(vector.y)
    && Number.isFinite(vector.z);
}

function addBoundsPoint(
  bounds: GeographicViewBounds,
  point: { longitude: number; latitude: number; height: number },
): void {
  bounds.minX = Math.min(bounds.minX, point.longitude);
  bounds.minY = Math.min(bounds.minY, point.latitude);
  bounds.minZ = Math.min(bounds.minZ, point.height);
  bounds.maxX = Math.max(bounds.maxX, point.longitude);
  bounds.maxY = Math.max(bounds.maxY, point.latitude);
  bounds.maxZ = Math.max(bounds.maxZ, point.height);
}

function createEmptyGeographicBounds(): GeographicViewBounds {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
}

function isUsablePerspectiveFrustum(frustum: ViewFrustum | undefined): frustum is ViewFrustum {
  return frustum?.coordinateSystem === 'wgs84-ecef-meters'
    && isFiniteVector(frustum.position)
    && isFiniteVector(frustum.direction)
    && isFiniteVector(frustum.up)
    && isFiniteVector(frustum.right)
    && Number.isFinite(frustum.verticalFovRadians)
    && frustum.verticalFovRadians > 0
    && frustum.verticalFovRadians < Math.PI
    && Number.isFinite(frustum.aspectRatio)
    && frustum.aspectRatio > 0
    && Number.isFinite(frustum.nearMeters)
    && frustum.nearMeters >= 0
    && Number.isFinite(frustum.farMeters)
    && frustum.farMeters > frustum.nearMeters;
}

function createCameraFallbackBounds(
  input: StreamingViewBoundsInput,
  radiusMeters: number,
): GeographicViewBounds {
  const longitude = Number.isFinite(input.camera.longitude) ? input.camera.longitude : 0;
  const latitude = Number.isFinite(input.camera.latitude) ? input.camera.latitude : 0;
  const height = Number.isFinite(input.camera.height) ? input.camera.height : 0;
  const safeRadius = Number.isFinite(radiusMeters) ? Math.max(radiusMeters, 0) : 0;
  const latitudeRadius = safeRadius / 111_320;
  const longitudeRadius = safeRadius /
    (111_320 * Math.max(Math.cos((latitude * Math.PI) / 180), 0.1));

  return {
    minX: longitude - longitudeRadius,
    minY: latitude - latitudeRadius,
    minZ: height - safeRadius,
    maxX: longitude + longitudeRadius,
    maxY: latitude + latitudeRadius,
    maxZ: height + safeRadius,
  };
}

/**
 * Create a conservative geographic envelope for the hierarchy required by a
 * streaming view. A valid perspective view is padded around its truncated
 * frustum; callers without one retain the historical camera-radius query.
 */
export function createStreamingViewBounds(
  input: StreamingViewBoundsInput,
): StreamingViewBounds {
  const fallbackDistance = Math.min(
    Number.isFinite(input.viewDistanceMeters) ? Math.max(input.viewDistanceMeters, 0) : 0,
    Number.isFinite(input.maxRenderDistanceMeters)
      ? Math.max(input.maxRenderDistanceMeters, 0)
      : 0,
  );

  if (!isUsablePerspectiveFrustum(input.viewFrustum)) {
    return {
      bounds: createCameraFallbackBounds(input, fallbackDistance),
      mode: 'camera-fallback',
      effectiveFarMeters: fallbackDistance,
    };
  }

  const frustum = input.viewFrustum;
  const effectiveFarMeters = Math.min(
    frustum.farMeters,
    Number.isFinite(input.viewDistanceMeters)
      ? Math.max(input.viewDistanceMeters, 0)
      : frustum.farMeters,
    Number.isFinite(input.maxRenderDistanceMeters)
      ? Math.max(input.maxRenderDistanceMeters, 0)
      : frustum.farMeters,
  );
  // Keep the near plane represented when a caller configures a distance below
  // it. This may over-query a thin slice, but never creates an invalid query.
  const far = Math.max(effectiveFarMeters, frustum.nearMeters);
  const verticalTangent = Math.tan(frustum.verticalFovRadians / 2);
  const horizontalTangent = verticalTangent * frustum.aspectRatio;
  const position = frustum.position;
  const direction = normalize(frustum.direction);
  const up = normalize(frustum.up);
  const right = normalize(frustum.right);
  const distances = [frustum.nearMeters, far];
  const ecefBounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };

  for (const distance of distances) {
    const center = add(position, multiply(direction, distance));
    const halfHeight = verticalTangent * distance;
    const halfWidth = horizontalTangent * distance;
    for (const horizontal of [-1, 1]) {
      for (const vertical of [-1, 1]) {
        const corner = add(
          add(center, multiply(right, horizontal * halfWidth)),
          multiply(up, vertical * halfHeight),
        );
        ecefBounds.minX = Math.min(ecefBounds.minX, corner.x);
        ecefBounds.minY = Math.min(ecefBounds.minY, corner.y);
        ecefBounds.minZ = Math.min(ecefBounds.minZ, corner.z);
        ecefBounds.maxX = Math.max(ecefBounds.maxX, corner.x);
        ecefBounds.maxY = Math.max(ecefBounds.maxY, corner.y);
        ecefBounds.maxZ = Math.max(ecefBounds.maxZ, corner.z);
      }
    }
  }

  // The AABB is only a coarse page filter. A 0.1% depth cushion keeps
  // hierarchy cells touching a frustum edge from being lost to rounding or
  // the selector's bounding-volume tolerance without loading the full tree.
  const edgeCushionMeters = Math.max(1, far * 1e-3);
  ecefBounds.minX -= edgeCushionMeters;
  ecefBounds.minY -= edgeCushionMeters;
  ecefBounds.minZ -= edgeCushionMeters;
  ecefBounds.maxX += edgeCushionMeters;
  ecefBounds.maxY += edgeCushionMeters;
  ecefBounds.maxZ += edgeCushionMeters;

  const bounds = createEmptyGeographicBounds();
  for (const x of [ecefBounds.minX, ecefBounds.maxX]) {
    for (const y of [ecefBounds.minY, ecefBounds.maxY]) {
      for (const z of [ecefBounds.minZ, ecefBounds.maxZ]) {
        addBoundsPoint(bounds, ecefToGeographic({ x, y, z }));
      }
    }
  }

  // CopcHierarchyQuery currently accepts one AABB, so a longitude interval
  // crossing the antimeridian cannot be represented as two narrow ranges.
  // Widen only that axis to preserve correctness for dateline views; this is
  // preferable to excluding the visible side of the dataset.
  if (bounds.maxX - bounds.minX > 180) {
    bounds.minX = -180;
    bounds.maxX = 180;
  }

  return {
    bounds,
    mode: 'frustum',
    effectiveFarMeters: far,
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
    coordinateSystem: 'wgs84-ecef-meters',
    center: sphereCenter,
    // Keep a small numerical cushion for transformed/projected boxes and
    // camera planes that meet exactly at a frustum edge.
    radiusMeters: radiusMeters + Math.max(1, radiusMeters * 1e-6),
  };
}
