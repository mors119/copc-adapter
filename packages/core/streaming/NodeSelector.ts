import { intersectsViewFrustum } from './view';
import type { CameraMotionPrediction } from './motionLookahead';
import type {
  StreamingHierarchyNode,
  StreamingSelectedNode,
  StreamingSelectionMetrics,
} from './types';
import type {
  StreamingCameraState,
  StreamingHierarchy,
  StreamingSelectionOptions,
  StreamingSelectionContext,
  ViewFrustum,
  ViewVector3,
} from './types';
import {
  calculateRefinementInfluence,
  DEFAULT_MAX_REFINEMENT_DETAIL_BIAS,
  type RefinementInfluence,
} from './refinementInfluence';
import {
  createRefinementRelevanceStrategy,
  normalizeRefinementFocus,
  type RefinementFocus,
  type RefinementRelevanceStrategy,
} from './refinementStrategies';

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function calculateSurfaceDistanceMeters(
  startLatitude: number,
  startLongitude: number,
  endLatitude: number,
  endLongitude: number,
): number {
  const earthRadiusMeters = 6371000;
  const latitude1 = toRadians(startLatitude);
  const latitude2 = toRadians(endLatitude);
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = toRadians(endLongitude - startLongitude);
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(deltaLongitude / 2) ** 2;

  return (
    2 *
    earthRadiusMeters *
    Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Estimate camera-to-node-centre distance using a spherical WGS84 surface approximation and height delta.
 *
 * @param camera Camera longitude/latitude in degrees and height in metres.
 * @param node Hierarchy node with a geographic centre.
 * @returns Approximate centre distance in metres.
 */
export function calculateDistanceMeters(
  camera: StreamingCameraState,
  node: StreamingHierarchyNode,
): number {
  const surfaceDistance = calculateSurfaceDistanceMeters(
    camera.latitude,
    camera.longitude,
    node.center.latitude,
    node.center.longitude,
  );
  const heightDelta = node.center.height - camera.height;

  return Math.hypot(surfaceDistance, heightDelta);
}

/**
 * Estimate camera distance to the closest point in a node's geographic bounds.
 *
 * @param camera Camera longitude/latitude in degrees and height in metres.
 * @param node Hierarchy node with WGS84 geographic bounds.
 * @returns Approximate closest-bound distance in metres.
 */
export function calculateBoundsDistanceMeters(
  camera: StreamingCameraState,
  node: StreamingHierarchyNode,
): number {
  const closestLongitude = clamp(
    camera.longitude,
    node.bounds.minX,
    node.bounds.maxX,
  );
  const closestLatitude = clamp(
    camera.latitude,
    node.bounds.minY,
    node.bounds.maxY,
  );
  const closestHeight = clamp(
    camera.height,
    node.bounds.minZ,
    node.bounds.maxZ,
  );
  const surfaceDistance = calculateSurfaceDistanceMeters(
    camera.latitude,
    camera.longitude,
    closestLatitude,
    closestLongitude,
  );
  const heightDelta = closestHeight - camera.height;

  return Math.hypot(surfaceDistance, heightDelta);
}

function isNodeVisible(
  camera: StreamingCameraState,
  node: StreamingHierarchyNode,
  options: StreamingSelectionOptions,
): boolean {
  const boundsDistance = calculateBoundsDistanceMeters(camera, node);
  const visibleDistance =
    Math.min(options.maxRenderDistanceMeters, camera.viewDistanceMeters) +
    node.boundingRadiusMeters;

  return boundsDistance <= visibleDistance;
}

function isNodeFrustumVisible(
  camera: StreamingCameraState,
  node: StreamingHierarchyNode,
): boolean {
  // Nodes without a volume are retained so missing bounds can never create a
  // false negative. Production hierarchy nodes always have one.
  return !camera.viewFrustum
    || !Array.isArray(camera.viewFrustum.planes)
    || !node.boundingSphere
    || intersectsViewFrustum(camera.viewFrustum, node.boundingSphere);
}

const DEFAULT_MAX_SCREEN_SPACE_ERROR = 8;
const DEFAULT_SCREEN_SPACE_ERROR_HYSTERESIS_FRACTION = 0.125;
/** Maximum additional refinement pressure available to passive screen-centre gaze. */
export const DEFAULT_CENTER_PRIORITY_BOOST = DEFAULT_MAX_REFINEMENT_DETAIL_BIAS - 1;
/**
 * Conservative first workload default, informed by the issue-48 renderer
 * measurements. It is a point-pressure guard, not a GPU-memory limit.
 */
export const DEFAULT_MAX_RENDERED_POINTS = 250_000;
const DEFAULT_VERTICAL_FOV_RADIANS = Math.PI / 3;
const DEFAULT_VIEWPORT_HEIGHT_PIXELS = 1080;
/** Normalized screen distance at which scheduling centre relevance falls off. */
export const DEFAULT_SCHEDULING_CENTER_FALLOFF = 0.45;
/** Scheduling-only centre boost; refinement influence remains capped at 1.25×. */
export const DEFAULT_MAX_SCHEDULING_CENTER_BOOST = 0.5;

type GazeProjection = {
  position: ViewVector3;
  direction: ViewVector3;
  up: ViewVector3;
  right: ViewVector3;
  verticalTangent: number;
  horizontalTangent: number;
};

function isFiniteVector(vector: ViewVector3 | undefined): vector is ViewVector3 {
  return vector !== undefined
    && Number.isFinite(vector.x)
    && Number.isFinite(vector.y)
    && Number.isFinite(vector.z);
}

function normalizeVector(vector: ViewVector3): ViewVector3 | undefined {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    return undefined;
  }

  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
    z: vector.z / magnitude,
  };
}

function createGazeProjection(frustum: ViewFrustum | undefined): GazeProjection | undefined {
  if (!frustum
    || !Array.isArray(frustum.planes)
    || !isFiniteVector(frustum.position)
    || !isFiniteVector(frustum.direction)
    || !isFiniteVector(frustum.up)
    || !isFiniteVector(frustum.right)
    || !Number.isFinite(frustum.verticalFovRadians)
    || frustum.verticalFovRadians <= 0
    || frustum.verticalFovRadians >= Math.PI
    || !Number.isFinite(frustum.aspectRatio)
    || frustum.aspectRatio <= 0) {
    return undefined;
  }

  const direction = normalizeVector(frustum.direction);
  const up = normalizeVector(frustum.up);
  const right = normalizeVector(frustum.right);
  const verticalTangent = Math.tan(frustum.verticalFovRadians / 2);
  const horizontalTangent = verticalTangent * frustum.aspectRatio;
  if (!direction || !up || !right
    || !Number.isFinite(verticalTangent)
    || verticalTangent <= 0
    || !Number.isFinite(horizontalTangent)
    || horizontalTangent <= 0) {
    return undefined;
  }

  return {
    position: frustum.position,
    direction,
    up,
    right,
    verticalTangent,
    horizontalTangent,
  };
}

function dot(left: ViewVector3, right: ViewVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function calculateInfluenceWithoutManualFocus(
  influence: RefinementInfluence,
  focus: RefinementFocus | undefined,
): RefinementInfluence {
  return calculateRefinementInfluence({
    rawScreenSpaceError: influence.rawScreenSpaceError,
    gazeWeight: influence.gazeWeight,
    motionWeight: influence.motionWeight,
    ...(focus ? { manualFocusDetailBias: focus.detailBias } : {}),
  });
}

function calculateInfluenceWithoutMotion(
  influence: RefinementInfluence,
  focus: RefinementFocus | undefined,
): RefinementInfluence {
  return calculateRefinementInfluence({
    rawScreenSpaceError: influence.rawScreenSpaceError,
    gazeWeight: influence.gazeWeight,
    manualFocusWeight: influence.manualFocusWeight,
    ...(focus ? { manualFocusDetailBias: focus.detailBias } : {}),
  });
}

type ProjectedNodeCentre = {
  normalizedScreenDistance: number;
  normalizedScreenX: number;
  normalizedScreenY: number;
  forward: number;
};

function projectNodeCentre(
  node: StreamingHierarchyNode,
  projection: GazeProjection | undefined,
): ProjectedNodeCentre | undefined {
  if (!projection || !node.boundingSphere || !isFiniteVector(node.boundingSphere.center)) {
    return undefined;
  }

  const vector = {
    x: node.boundingSphere.center.x - projection.position.x,
    y: node.boundingSphere.center.y - projection.position.y,
    z: node.boundingSphere.center.z - projection.position.z,
  };
  const forward = dot(vector, projection.direction);
  if (!Number.isFinite(forward) || forward <= 0) {
    return undefined;
  }

  const signedHorizontalDisplacement = dot(vector, projection.right) /
    (forward * projection.horizontalTangent);
  const signedVerticalDisplacement = dot(vector, projection.up) /
    (forward * projection.verticalTangent);
  if (!Number.isFinite(signedHorizontalDisplacement)
    || !Number.isFinite(signedVerticalDisplacement)) {
    return undefined;
  }

  return {
    normalizedScreenDistance: Math.hypot(
      Math.abs(signedHorizontalDisplacement),
      Math.abs(signedVerticalDisplacement),
    ),
    normalizedScreenX: 0.5 + signedHorizontalDisplacement / 2,
    normalizedScreenY: 0.5 - signedVerticalDisplacement / 2,
    forward,
  };
}

type MotionLookaheadTarget = {
  normalizedScreenX: number;
  normalizedScreenY: number;
  activity: number;
};

function createMotionLookaheadTarget(
  projection: GazeProjection | undefined,
  prediction: CameraMotionPrediction | undefined,
): MotionLookaheadTarget | undefined {
  if (!projection || !prediction || prediction.activity <= 0) {
    return undefined;
  }

  const horizontalDisplacement = toRadians(
    prediction.predictedHorizontalDisplacementDegrees,
  );
  const verticalDisplacement = toRadians(
    prediction.predictedVerticalDisplacementDegrees,
  );
  const targetX = 0.5 + Math.tan(horizontalDisplacement)
    / (2 * projection.horizontalTangent);
  const targetY = 0.5 - Math.tan(verticalDisplacement)
    / (2 * projection.verticalTangent);
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    return undefined;
  }

  return {
    normalizedScreenX: targetX,
    normalizedScreenY: targetY,
    activity: prediction.activity,
  };
}

function calculateMotionLookaheadWeight(
  projected: ProjectedNodeCentre | undefined,
  target: MotionLookaheadTarget | undefined,
): number {
  if (!projected || !target || projected.forward <= 0) {
    return 0;
  }

  // A quadratic smoothstep falloff covers the current viewport while avoiding
  // a hard left/right or top/bottom boundary. The current frustum has already
  // decided visibility; this target never admits a node outside that frontier.
  const deltaX = projected.normalizedScreenX - target.normalizedScreenX;
  const deltaY = projected.normalizedScreenY - target.normalizedScreenY;
  const distanceSquared = deltaX * deltaX + deltaY * deltaY;
  const falloffSquared = 0.75 * 0.75;
  const normalizedDistance = clamp(distanceSquared / falloffSquared, 0, 1);
  const falloff = 1 - normalizedDistance * normalizedDistance
    * (3 - 2 * normalizedDistance);
  const weight = target.activity * falloff;
  return Number.isFinite(weight) ? clamp(weight, 0, 1) : 0;
}

function calculateAngularGapRadians(
  node: StreamingHierarchyNode,
  projection: GazeProjection | undefined,
): number | undefined {
  if (!projection || !node.boundingSphere || !isFiniteVector(node.boundingSphere.center)) {
    return undefined;
  }
  const vector = {
    x: node.boundingSphere.center.x - projection.position.x,
    y: node.boundingSphere.center.y - projection.position.y,
    z: node.boundingSphere.center.z - projection.position.z,
  };
  const distance = Math.hypot(vector.x, vector.y, vector.z);
  const radius = Number.isFinite(node.boundingSphere.radiusMeters)
    ? Math.max(node.boundingSphere.radiusMeters, 0)
    : 0;
  // A camera inside a node sphere overlaps every focus ray direction.
  if (distance <= radius) {
    return 0;
  }
  if (!Number.isFinite(distance) || distance <= 0) {
    return undefined;
  }
  const direction = {
    x: vector.x / distance,
    y: vector.y / distance,
    z: vector.z / distance,
  };
  const theta = Math.acos(clamp(dot(direction, projection.direction), -1, 1));
  const angularRadius = Math.asin(clamp(radius / distance, 0, 1));
  const gap = Math.max(0, theta - angularRadius);
  return Number.isFinite(gap) ? gap : undefined;
}

function calculateManualFocusWeight(
  node: StreamingHierarchyNode,
  projection: GazeProjection | undefined,
  focus: RefinementFocus | undefined,
): number {
  if (!focus || !projection || !node.boundingSphere
    || !isFiniteVector(node.boundingSphere.center)) {
    return 0;
  }
  const projected = projectNodeCentre(node, projection);
  const radiusMeters = Number.isFinite(node.boundingSphere.radiusMeters)
    ? Math.max(node.boundingSphere.radiusMeters, 0)
    : 0;
  const vector = {
    x: node.boundingSphere.center.x - projection.position.x,
    y: node.boundingSphere.center.y - projection.position.y,
    z: node.boundingSphere.center.z - projection.position.z,
  };
  const distanceMeters = Math.hypot(vector.x, vector.y, vector.z);
  if (Number.isFinite(distanceMeters) && distanceMeters <= radiusMeters) {
    return 1;
  }
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return 0;
  }

  const angularRadius = Math.asin(clamp(radiusMeters / distanceMeters, 0, 1));
  const centerDirection = {
    x: vector.x / distanceMeters,
    y: vector.y / distanceMeters,
    z: vector.z / distanceMeters,
  };
  const centerAngle = Math.acos(clamp(dot(centerDirection, projection.direction), -1, 1));
  const outerAngle = centerAngle + angularRadius;
  if (outerAngle >= Math.PI / 2) {
    // The projected silhouette is unbounded at the horizon, but remains on
    // the sphere's angular side of the view. Compare the lens rays with the
    // sphere's angular cap so an opposite-side lens does not get full weight.
    const horizontalSlope = (2 * focus.center.x - 1) * projection.horizontalTangent;
    const verticalSlope = (1 - 2 * focus.center.y) * projection.verticalTangent;
    const focusRayVector = {
      x: projection.direction.x
        + horizontalSlope * projection.right.x
        + verticalSlope * projection.up.x,
      y: projection.direction.y
        + horizontalSlope * projection.right.y
        + verticalSlope * projection.up.y,
      z: projection.direction.z
        + horizontalSlope * projection.right.z
        + verticalSlope * projection.up.z,
    };
    const focusRay = normalizeVector(focusRayVector);
    if (!focusRay) {
      return 0;
    }

    const focusAngle = Math.acos(clamp(dot(centerDirection, focusRay), -1, 1));
    const angularGap = Math.max(0, focusAngle - angularRadius);
    const aspect = projection.horizontalTangent / projection.verticalTangent;
    const focusRayLength = Math.hypot(
      focusRayVector.x,
      focusRayVector.y,
      focusRayVector.z,
    );
    const angularRadiusForScreenCircle = (screenRadius: number): number => {
      const slopeRadius = 2 * projection.verticalTangent
        * Math.min(1, aspect)
        * screenRadius;
      const vectorRadius = slopeRadius
        * Math.sqrt(1 + Math.abs(dot(projection.right, projection.up)));
      return vectorRadius >= focusRayLength
        ? Math.PI
        : Math.asin(clamp(vectorRadius / focusRayLength, 0, 1));
    };
    const lensAngularRadius = angularRadiusForScreenCircle(focus.radius);
    const feather = Math.max(focus.radius * 0.25, 0.02);
    const featheredLensAngularRadius = angularRadiusForScreenCircle(focus.radius + feather);
    if (angularGap <= lensAngularRadius) {
      return 1;
    }
    if (angularGap >= featheredLensAngularRadius) {
      return 0;
    }

    const angularFeather = featheredLensAngularRadius - lensAngularRadius;
    if (angularFeather <= 0) {
      return 0;
    }
    const falloff = clamp((angularGap - lensAngularRadius) / angularFeather, 0, 1);
    const smoothFalloff = falloff * falloff * (3 - 2 * falloff);
    return clamp(1 - smoothFalloff, 0, 1);
  }
  if (!projected) {
    return 0;
  }

  const aspect = projection.horizontalTangent / projection.verticalTangent;
  const scaleX = Math.max(1, aspect);
  const scaleY = Math.max(1, 1 / aspect);
  const viewportDistance = Math.hypot(
    (projected.normalizedScreenX - focus.center.x) * scaleX,
    (projected.normalizedScreenY - focus.center.y) * scaleY,
  );
  // Perspective projection is gnomonic: a sphere's outer cone edge projects
  // at tan(theta + alpha), not linearly in angle. Subtracting the projected
  // center radius gives a conservative off-axis extent as well.
  const projectedRadius = (Math.tan(outerAngle) - Math.tan(centerAngle))
    / (2 * projection.verticalTangent)
    * Math.max(1, 1 / aspect);
  if (!Number.isFinite(viewportDistance) || !Number.isFinite(projectedRadius)) {
    return 0;
  }

  // Radius is measured in units of min(viewportWidth, viewportHeight). The
  // 2% minimum feather keeps the boundary stable for small lens radii.
  const distanceOutsideNode = Math.max(0, viewportDistance - projectedRadius);
  const feather = Math.max(focus.radius * 0.25, 0.02);
  const falloff = clamp((distanceOutsideNode - focus.radius) / feather, 0, 1);
  const smoothFalloff = falloff * falloff * (3 - 2 * falloff);
  return clamp(1 - smoothFalloff, 0, 1);
}

function calculateCenterWeightForProjection(
  node: StreamingHierarchyNode,
  projection: GazeProjection | undefined,
): number {
  const projected = projectNodeCentre(node, projection);
  if (projected === undefined || !projection || !node.boundingSphere) {
    return 0;
  }

  // Treat the sphere's angular extent conservatively: a large sphere gets
  // credit when its visible extent reaches toward the screen centre, while a
  // sphere whose centre is behind the camera never receives a bonus.
  const radius = Number.isFinite(node.boundingSphere.radiusMeters)
    ? Math.max(node.boundingSphere.radiusMeters, 0)
    : 0;
  const angularRadius = radius / Math.max(projected.forward, 1e-6) /
    Math.min(projection.horizontalTangent, projection.verticalTangent);
  return clamp(
    1 - Math.max(0, projected.normalizedScreenDistance - angularRadius),
    0,
    1,
  );
}

function calculateSchedulingCenterWeightForProjection(
  node: StreamingHierarchyNode,
  projection: GazeProjection | undefined,
): number {
  const projected = projectNodeCentre(node, projection);
  if (projected === undefined) {
    return 0;
  }

  // Refinement intentionally credits the visible extent of a large sphere.
  // Scheduling uses the projected centre instead, with a smooth Gaussian
  // falloff. This sharpens work order without introducing a hard screen band
  // or changing which nodes are eligible for refinement.
  const normalizedFalloff = projected.normalizedScreenDistance /
    DEFAULT_SCHEDULING_CENTER_FALLOFF;
  const weight = Math.exp(-0.5 * normalizedFalloff * normalizedFalloff);
  return Number.isFinite(weight) ? clamp(weight, 0, 1) : 0;
}

/** Calculate the bounded screen-centre relevance for a project-owned view. */
export function calculateGazeCenterWeight(
  camera: StreamingCameraState,
  node: StreamingHierarchyNode,
): number {
  return calculateCenterWeightForProjection(node, createGazeProjection(camera.viewFrustum));
}

/** Calculate the sharper, scheduling-only screen-centre relevance. */
export function calculateSchedulingCenterWeight(
  camera: StreamingCameraState,
  node: StreamingHierarchyNode,
): number {
  return calculateSchedulingCenterWeightForProjection(
    node,
    createGazeProjection(camera.viewFrustum),
  );
}

function getGeometricErrorMeters(node: StreamingHierarchyNode): number {
  const geometricError = node.geometricErrorMeters ?? node.approximateSizeMeters / 2;
  return Number.isFinite(geometricError) ? Math.max(geometricError, 0) : 0;
}

/**
 * Estimate the pixel error of replacing a node with its children.
 *
 * SSE = geometricErrorMeters * viewportHeightPixels /
 *       (2 * distanceMeters * tan(verticalFovRadians / 2))
 *
 * `geometricErrorMeters` is the adapter's conservative unresolved detail
 * scale, `distanceMeters` is the camera-to-node-bounds distance, and the
 * remaining values describe the current perspective projection. A fallback
 * projection is used only for callers that cannot provide a perspective
 * frustum (for example an older test/custom camera state).
 */
export function calculateScreenSpaceErrorPixels(
  camera: StreamingCameraState,
  node: StreamingHierarchyNode,
): number {
  const projection = camera.viewFrustum;
  const viewportHeightPixels = projection
    && Number.isFinite(projection.viewportHeightPixels)
    && projection.viewportHeightPixels > 0
    ? projection.viewportHeightPixels
    : DEFAULT_VIEWPORT_HEIGHT_PIXELS;
  const verticalFovRadians = projection
    && Number.isFinite(projection.verticalFovRadians)
    && projection.verticalFovRadians > 0
    && projection.verticalFovRadians < Math.PI
    ? projection.verticalFovRadians
    : DEFAULT_VERTICAL_FOV_RADIANS;
  const geometricErrorMeters = Math.max(getGeometricErrorMeters(node), 0);
  // A camera can be inside a node volume. Clamp the perspective distance to
  // the node's detail scale rather than allowing a singular near-field SSE.
  const distanceMeters = Math.max(
    calculateBoundsDistanceMeters(camera, node),
    geometricErrorMeters,
    1e-6,
  );

  const screenSpaceErrorPixels = geometricErrorMeters * viewportHeightPixels /
    (2 * distanceMeters * Math.tan(verticalFovRadians / 2));
  return Number.isFinite(screenSpaceErrorPixels)
    ? Math.max(screenSpaceErrorPixels, 0)
    : screenSpaceErrorPixels === Number.POSITIVE_INFINITY
      ? Number.MAX_VALUE
      : 0;
}

function shouldRefine(
  node: StreamingHierarchyNode,
  options: StreamingSelectionOptions,
  effectiveScreenSpaceErrorPixels: number,
  wasPreviouslyRefined: boolean,
): 'refine' | 'hold' | 'collapse' {
  if (node.children.length === 0 || node.node.level >= options.maxDepth) {
    return 'hold';
  }

  const nominalThreshold = options.maxScreenSpaceError
    ?? DEFAULT_MAX_SCREEN_SPACE_ERROR;
  const hysteresis = options.screenSpaceErrorHysteresis ?? 0;
  const refineThreshold = nominalThreshold + hysteresis;
  const collapseThreshold = Math.max(0, nominalThreshold - hysteresis);

  if (wasPreviouslyRefined) {
    if (effectiveScreenSpaceErrorPixels < collapseThreshold) {
      return 'collapse';
    }
    if (effectiveScreenSpaceErrorPixels <= refineThreshold) {
      return 'hold';
    }
    return 'refine';
  }

  return effectiveScreenSpaceErrorPixels > refineThreshold ? 'refine' : 'hold';
}

function getRootNodes(hierarchy: StreamingHierarchy): StreamingHierarchyNode[] {
  return [...hierarchy.values()].filter((entry) => entry.node.level === 0);
}

function validateMaxRenderedPoints(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      'Streaming maxRenderedPoints must be a positive safe integer',
    );
  }

  return value;
}

function getNodePointCost(node: StreamingHierarchyNode): number {
  return Number.isSafeInteger(node.node.pointCount) && node.node.pointCount > 0
    ? node.node.pointCount
    : 0;
}

type PrioritisedNode = {
  node: StreamingHierarchyNode;
  screenSpaceErrorPixels: number;
  influence: RefinementInfluence;
  centerWeight: number;
  schedulingCenterWeight: number;
  focusWeight: number;
  motionWeight: number;
  refinementPriority: number;
  schedulingPriority: number;
  boundsDistanceMeters: number;
  wasPreviouslySelected: boolean;
  wasPreviouslyRefined: boolean;
  isCached: boolean;
  pointCost: number;
};

function compareRefinementPriority(
  left: PrioritisedNode,
  right: PrioritisedNode,
): number {
  return compareRefinementPriorityByScore(
    left,
    right,
    left.refinementPriority,
    right.refinementPriority,
  );
}

function compareRefinementPriorityByScore(
  left: PrioritisedNode,
  right: PrioritisedNode,
  leftScore: number,
  rightScore: number,
): number {
  // Refinement and coverage decisions use only the conservative influence
  // model. Scheduling relevance is deliberately absent from this comparator.
  return rightScore - leftScore
    || right.screenSpaceErrorPixels - left.screenSpaceErrorPixels
    || right.centerWeight - left.centerWeight
    || left.boundsDistanceMeters - right.boundsDistanceMeters
    || right.node.node.level - left.node.node.level
    || Number(right.wasPreviouslyRefined) - Number(left.wasPreviouslyRefined)
    || Number(right.wasPreviouslySelected) - Number(left.wasPreviouslySelected)
    || Number(right.isCached) - Number(left.isCached)
    || left.pointCost - right.pointCost
    || left.node.node.key.localeCompare(right.node.node.key);
}

function compareSchedulingPriority(
  left: PrioritisedNode,
  right: PrioritisedNode,
): number {
  // This comparator is used only after the selected frontier is valid. Raw
  // SSE remains an explicit tie-breaker so a large peripheral visual error
  // retains authority over a modest centre preference.
  return right.schedulingPriority - left.schedulingPriority
    || right.refinementPriority - left.refinementPriority
    || right.screenSpaceErrorPixels - left.screenSpaceErrorPixels
    || right.schedulingCenterWeight - left.schedulingCenterWeight
    || right.centerWeight - left.centerWeight
    || left.boundsDistanceMeters - right.boundsDistanceMeters
    || right.node.node.level - left.node.node.level
    || Number(right.wasPreviouslyRefined) - Number(left.wasPreviouslyRefined)
    || Number(right.wasPreviouslySelected) - Number(left.wasPreviouslySelected)
    || Number(right.isCached) - Number(left.isCached)
    || left.pointCost - right.pointCost
    || left.node.node.key.localeCompare(right.node.node.key);
}

function toSelectedNode(candidate: PrioritisedNode): StreamingSelectedNode {
  return {
    ...candidate.node,
    refinementPriority: candidate.refinementPriority,
    schedulingPriority: candidate.schedulingPriority,
    priority: candidate.schedulingPriority,
    rawScreenSpaceError: candidate.screenSpaceErrorPixels,
    effectiveScreenSpaceError: candidate.influence.effectiveScreenSpaceError,
    centerWeight: candidate.centerWeight,
    schedulingCenterWeight: candidate.schedulingCenterWeight,
    focusWeight: candidate.focusWeight,
  };
}

type RefinementCandidate = PrioritisedNode & {
  replacement: StreamingHierarchyNode[];
  replacementPointCost: number;
  focusChangedRefinementDecision: boolean;
  refinementPriorityWithoutManualFocus: number;
  motionChangedRefinementDecision: boolean;
  refinementPriorityWithoutMotion: number;
};

function createSelectionMetrics(
  maxScreenSpaceError: number,
  maxRenderedPoints: number,
  refinementAlgorithm: StreamingSelectionOptions['refinementAlgorithm'],
  refinementFocusEnabled: boolean,
  motionPrediction: CameraMotionPrediction,
): StreamingSelectionMetrics {
  return {
    refinementAlgorithm: refinementAlgorithm ?? 'foveated',
    refinementFocusEnabled,
    motionLookaheadEnabled: motionPrediction.enabled,
    motionHorizontalAngularVelocityDegreesPerSecond:
      motionPrediction.horizontalAngularVelocityDegreesPerSecond,
    motionVerticalAngularVelocityDegreesPerSecond:
      motionPrediction.verticalAngularVelocityDegreesPerSecond,
    motionHorizonMilliseconds: motionPrediction.horizonMilliseconds,
    motionPredictedHorizontalDisplacementDegrees:
      motionPrediction.predictedHorizontalDisplacementDegrees,
    motionPredictedVerticalDisplacementDegrees:
      motionPrediction.predictedVerticalDisplacementDegrees,
    candidatesBeforeCulling: 0,
    frustumCulledCount: 0,
    maxScreenSpaceError,
    refinedNodeCount: 0,
    keptNodeCount: 0,
    candidateSelectedPointCount: 0,
    budgetedPointCount: 0,
    maxRenderedPoints,
    deferredNodeCount: 0,
    deferredPointCount: 0,
    budgetDeferDropCount: 0,
    frontierNodeCount: 0,
    frontierPointCount: 0,
    acceptedRefinementCount: 0,
    refinementRejectedByNodeBudgetCount: 0,
    refinementRejectedByPointBudgetCount: 0,
    refinementDeferredByIncompleteHierarchyCount: 0,
    minimumFrontierExceedsNodeBudget: false,
    minimumFrontierExceedsPointBudget: false,
    candidatesWithNonZeroInfluenceCount: 0,
    focusCandidateCount: 0,
    motionCandidateCount: 0,
    motionWeightMax: 0,
    motionInfluencedRefinementCount: 0,
    focusInfluencedRefinementCount: 0,
    acceptedGazeInfluencedRefinementCount: 0,
    influenceClampCount: 0,
    candidatesWithCenterBoostCount: 0,
    hysteresisHoldCount: 0,
    refineDecisionCount: 0,
    collapseDecisionCount: 0,
  };
}

/** Compare nodes by level, camera distance, point count, then stable key. */
export function compareNodePriority(
  camera: StreamingCameraState,
  left: StreamingHierarchyNode,
  right: StreamingHierarchyNode,
): number {
  return right.node.level - left.node.level
    || calculateBoundsDistanceMeters(camera, left) - calculateBoundsDistanceMeters(camera, right)
    || left.node.pointCount - right.node.pointCount
    || left.node.key.localeCompare(right.node.key);
}

/**
 * Select a visible hierarchy frontier for one geographic camera view.
 *
 * The selector culls by distance and optional frustum, then refines by
 * screen-space error while respecting depth, node, and estimated point
 * budgets. Separate refinement and scheduling priorities keep work ordering
 * from changing the selected coverage frontier.
 */
export class NodeSelector {
  private readonly options: StreamingSelectionOptions;
  private readonly strategy: RefinementRelevanceStrategy;
  private refinementFocus?: RefinementFocus;
  private motionPrediction?: CameraMotionPrediction;
  private lastSelectionMetrics: StreamingSelectionMetrics = createSelectionMetrics(
    DEFAULT_MAX_SCREEN_SPACE_ERROR,
    DEFAULT_MAX_RENDERED_POINTS,
    'foveated',
    false,
    {
      enabled: true,
      horizontalAngularVelocityDegreesPerSecond: 0,
      verticalAngularVelocityDegreesPerSecond: 0,
      horizonMilliseconds: 200,
      predictedHorizontalDisplacementDegrees: 0,
      predictedVerticalDisplacementDegrees: 0,
      activity: 0,
    },
  );

  /**
   * Create a selector with required node/depth/distance limits.
   *
   * Screen-space error defaults to 8 pixels, its hold band to 12.5% of that
   * threshold, and the current-view point budget to 250,000 points.
   *
   * @param options Required node/depth/distance limits and optional selection budgets.
   * @throws `RangeError` if the hysteresis or point-budget configuration is invalid.
   */
  constructor(options: StreamingSelectionOptions) {
    this.strategy = createRefinementRelevanceStrategy(options.refinementAlgorithm);
    const maxScreenSpaceError = options.maxScreenSpaceError
      ?? DEFAULT_MAX_SCREEN_SPACE_ERROR;
    const screenSpaceErrorHysteresis = options.screenSpaceErrorHysteresis
      ?? Math.max(maxScreenSpaceError, 0) * DEFAULT_SCREEN_SPACE_ERROR_HYSTERESIS_FRACTION;
    if (!Number.isFinite(screenSpaceErrorHysteresis) || screenSpaceErrorHysteresis < 0) {
      throw new RangeError(
        'Streaming screenSpaceErrorHysteresis must be a non-negative finite number',
      );
    }

    this.options = {
      ...options,
      refinementAlgorithm: this.strategy.algorithm,
      maxScreenSpaceError,
      screenSpaceErrorHysteresis,
      maxRenderedPoints: validateMaxRenderedPoints(
        options.maxRenderedPoints ?? DEFAULT_MAX_RENDERED_POINTS,
      ),
    };
  }

  /** Update the optional screen-circle focus without rebuilding hierarchy or cache state. */
  setRefinementFocus(focus: RefinementFocus | undefined): void {
    this.refinementFocus = normalizeRefinementFocus(focus);
  }

  /** Update the current-view motion estimate without rebuilding selector or hierarchy state. */
  setMotionPrediction(prediction: CameraMotionPrediction): void {
    this.motionPrediction = {
      ...prediction,
      enabled: prediction.enabled && this.options.motionLookahead !== false,
    };
  }

  /** Return a detached snapshot of the most recent selection counters. */
  getSelectionMetrics(): StreamingSelectionMetrics {
    return {
      ...this.lastSelectionMetrics,
      motionWeightMin: this.lastSelectionMetrics.motionWeightMin ?? 0,
    };
  }

  /**
   * Select the current visible frontier and order it for point-data scheduling.
   *
   * Previous selection and cache state are optional inputs used for stable
   * hysteresis decisions and tie-breaking; they do not change source data.
   *
   * @param camera Geographic camera state, view distance, and optional ECEF frustum.
   * @param hierarchy Available hierarchy nodes keyed by their stable COPC keys.
   * @param context Prior selection and cache information for this view update.
   * @returns Selected nodes with separate refinement and scheduling scores.
   */
  selectVisibleNodes(
    camera: StreamingCameraState,
    hierarchy: StreamingHierarchy,
    context: StreamingSelectionContext = {},
  ): StreamingSelectedNode[] {
    const maxScreenSpaceError = this.options.maxScreenSpaceError
      ?? DEFAULT_MAX_SCREEN_SPACE_ERROR;
    const budget = this.options.maxRenderedPoints ?? DEFAULT_MAX_RENDERED_POINTS;
    this.lastSelectionMetrics = createSelectionMetrics(
      maxScreenSpaceError,
      budget,
      this.strategy.algorithm,
      this.refinementFocus !== undefined,
      this.motionPrediction ?? {
        enabled: this.options.motionLookahead !== false,
        horizontalAngularVelocityDegreesPerSecond: 0,
        verticalAngularVelocityDegreesPerSecond: 0,
        horizonMilliseconds: 200,
        predictedHorizontalDisplacementDegrees: 0,
        predictedVerticalDisplacementDegrees: 0,
        activity: 0,
      },
    );

    const frontier = new Map<string, StreamingHierarchyNode>();
    const gazeProjection = createGazeProjection(camera.viewFrustum);
    const evaluations = new Map<string, {
      visible: boolean;
      screenSpaceErrorPixels: number;
      influence: RefinementInfluence;
      focusWeight: number;
      schedulingWeight: number;
      motionWeight: number;
    }>();
    const priorityMetricsRecorded = new Set<string>();
    const motionTarget = this.options.motionLookahead === false
      ? undefined
      : createMotionLookaheadTarget(gazeProjection, this.motionPrediction);

    const evaluate = (node: StreamingHierarchyNode) => {
      const existing = evaluations.get(node.node.key);
      if (existing) {
        return existing;
      }

      this.lastSelectionMetrics.candidatesBeforeCulling += 1;
      if (!isNodeFrustumVisible(camera, node)) {
        this.lastSelectionMetrics.frustumCulledCount += 1;
        const result = {
          visible: false,
          screenSpaceErrorPixels: 0,
          influence: calculateRefinementInfluence({ rawScreenSpaceError: 0 }),
          focusWeight: 0,
          schedulingWeight: 0,
          motionWeight: 0,
        };
        evaluations.set(node.node.key, result);
        return result;
      }

      if (!isNodeVisible(camera, node, this.options)) {
        const result = {
          visible: false,
          screenSpaceErrorPixels: 0,
          influence: calculateRefinementInfluence({ rawScreenSpaceError: 0 }),
          focusWeight: 0,
          schedulingWeight: 0,
          motionWeight: 0,
        };
        evaluations.set(node.node.key, result);
        return result;
      }

      const screenSpaceErrorPixels = calculateScreenSpaceErrorPixels(camera, node);
      const projected = projectNodeCentre(node, gazeProjection);
      const angularGapRadians = calculateAngularGapRadians(node, gazeProjection);
      const angularFalloffRadians = gazeProjection
        ? Math.atan(gazeProjection.verticalTangent * DEFAULT_SCHEDULING_CENTER_FALLOFF)
        : undefined;
      const screenProjectionWeight = calculateCenterWeightForProjection(node, gazeProjection);
      const screenProjectionSchedulingWeight =
        calculateSchedulingCenterWeightForProjection(node, gazeProjection);
      const relevance = this.strategy.evaluate({
        screenX: projected?.normalizedScreenX,
        screenY: projected?.normalizedScreenY,
        screenProjectionWeight,
        screenProjectionSchedulingWeight,
        angularGapRadians,
        angularFalloffRadians,
      });
      const focusWeight = calculateManualFocusWeight(
        node,
        gazeProjection,
        this.refinementFocus,
      );
      const motionWeight = this.options.motionLookahead === false
        ? 0
        : calculateMotionLookaheadWeight(
          projected,
          motionTarget,
        );
      const influence = calculateRefinementInfluence({
        rawScreenSpaceError: screenSpaceErrorPixels,
        gazeWeight: relevance.refinementWeight,
        manualFocusWeight: focusWeight,
        motionWeight,
        ...(this.refinementFocus
          ? { manualFocusDetailBias: this.refinementFocus.detailBias }
          : {}),
      });
      this.lastSelectionMetrics.screenSpaceErrorMin = Math.min(
        this.lastSelectionMetrics.screenSpaceErrorMin ?? Number.POSITIVE_INFINITY,
        screenSpaceErrorPixels,
      );
      this.lastSelectionMetrics.screenSpaceErrorMax = Math.max(
        this.lastSelectionMetrics.screenSpaceErrorMax ?? Number.NEGATIVE_INFINITY,
        screenSpaceErrorPixels,
      );
      const result = {
        visible: true,
        screenSpaceErrorPixels,
        influence,
        focusWeight,
        motionWeight,
        schedulingWeight: relevance.schedulingWeight,
      };
      evaluations.set(node.node.key, result);
      this.lastSelectionMetrics.motionWeightMin = Math.min(
        this.lastSelectionMetrics.motionWeightMin ?? motionWeight,
        motionWeight,
      );
      this.lastSelectionMetrics.motionWeightMax = Math.max(
        this.lastSelectionMetrics.motionWeightMax ?? Number.NEGATIVE_INFINITY,
        motionWeight,
      );
      if (motionWeight > 0) {
        this.lastSelectionMetrics.motionCandidateCount =
          (this.lastSelectionMetrics.motionCandidateCount ?? 0) + 1;
      }
      return result;
    };

    for (const rootNode of getRootNodes(hierarchy).sort((left, right) =>
      left.node.key.localeCompare(right.node.key))) {
      const evaluation = evaluate(rootNode);
      if (evaluation.visible && rootNode.node.pointCount > 0) {
        frontier.set(rootNode.node.key, rootNode);
      }
    }

    let fallbackUsed = false;
    if (frontier.size === 0 && !camera.viewFrustum) {
      const fallback = [...hierarchy.values()]
        .filter((entry) => entry.node.pointCount > 0)
        .sort((left, right) =>
          calculateBoundsDistanceMeters(camera, left) -
          calculateBoundsDistanceMeters(camera, right)
          || left.node.key.localeCompare(right.node.key),
        )[0];

      if (fallback) {
        frontier.set(fallback.node.key, fallback);
        fallbackUsed = true;
      }
    }

    const initialFrontier = [...frontier.values()];
    const initialPointCount = initialFrontier.reduce(
      (total, node) => total + getNodePointCost(node),
      0,
    );
    const exceedsNodeBudget = initialFrontier.length > this.options.maxNodes;
    const exceedsPointBudget = initialPointCount > budget;
    this.lastSelectionMetrics.minimumFrontierExceedsNodeBudget = exceedsNodeBudget;
    this.lastSelectionMetrics.minimumFrontierExceedsPointBudget = exceedsPointBudget;

    const previousRefinementMemo = new Map<string, boolean>();
    const hasPreviouslyRefinedDescendant = (
      node: StreamingHierarchyNode,
      ancestors = new Set<string>(),
    ): boolean => {
      const memoized = previousRefinementMemo.get(node.node.key);
      if (memoized !== undefined) {
        return memoized;
      }
      if (ancestors.has(node.node.key)) {
        return false;
      }

      const nextAncestors = new Set(ancestors).add(node.node.key);
      for (const childKey of node.children) {
        if (context.previousSelectedNodeKeys?.has(childKey)) {
          previousRefinementMemo.set(node.node.key, true);
          return true;
        }
        const child = hierarchy.get(childKey);
        if (child && hasPreviouslyRefinedDescendant(child, nextAncestors)) {
          previousRefinementMemo.set(node.node.key, true);
          return true;
        }
      }

      previousRefinementMemo.set(node.node.key, false);
      return false;
    };

    const toPrioritised = (node: StreamingHierarchyNode): PrioritisedNode => {
      const evaluation = evaluations.get(node.node.key) ?? evaluate(node);
      const refinementPriority = evaluation.influence.effectiveScreenSpaceError;
      const schedulingCenterWeight = evaluation.schedulingWeight;
      // Combine automatic and explicit focus as one bounded scheduling signal.
      // A single multiplier keeps the existing 1.5x ceiling and leaves the
      // no-focus legacy score unchanged.
      const schedulingInfluence = clamp(
        schedulingCenterWeight + evaluation.focusWeight + evaluation.motionWeight,
        0,
        1,
      );
      const schedulingMultiplier = 1
        + schedulingInfluence * DEFAULT_MAX_SCHEDULING_CENTER_BOOST;
      // Start from raw SSE so the conservative, extent-aware refinement
      // influence cannot leak back into scheduling through the broad sphere
      // overlap signal. The refinement score remains a deterministic visual
      // tie-breaker in compareSchedulingPriority.
      const schedulingProduct = evaluation.screenSpaceErrorPixels * schedulingMultiplier;
      return {
        node,
        screenSpaceErrorPixels: evaluation.screenSpaceErrorPixels,
        influence: evaluation.influence,
        centerWeight: evaluation.influence.gazeWeight,
        schedulingCenterWeight,
        focusWeight: evaluation.focusWeight,
        motionWeight: evaluation.motionWeight,
        refinementPriority,
        schedulingPriority: Number.isFinite(schedulingProduct)
          ? schedulingProduct
          : Number.MAX_VALUE,
        boundsDistanceMeters: calculateBoundsDistanceMeters(camera, node),
        wasPreviouslySelected: context.previousSelectedNodeKeys?.has(node.node.key) ?? false,
        wasPreviouslyRefined: hasPreviouslyRefinedDescendant(node),
        isCached: context.isNodeCached?.(node.node.key) ?? false,
        pointCost: getNodePointCost(node),
      };
    };

    const recordCandidateInfluence = (candidate: PrioritisedNode): void => {
      if (priorityMetricsRecorded.has(candidate.node.node.key)) {
        return;
      }
      priorityMetricsRecorded.add(candidate.node.node.key);
      const { influence } = candidate;
      this.lastSelectionMetrics.effectiveScreenSpaceErrorMin = Math.min(
        this.lastSelectionMetrics.effectiveScreenSpaceErrorMin
          ?? Number.POSITIVE_INFINITY,
        influence.effectiveScreenSpaceError,
      );
      this.lastSelectionMetrics.effectiveScreenSpaceErrorMax = Math.max(
        this.lastSelectionMetrics.effectiveScreenSpaceErrorMax
          ?? Number.NEGATIVE_INFINITY,
        influence.effectiveScreenSpaceError,
      );
      this.lastSelectionMetrics.detailBiasMin = Math.min(
        this.lastSelectionMetrics.detailBiasMin ?? Number.POSITIVE_INFINITY,
        influence.detailBias,
      );
      this.lastSelectionMetrics.detailBiasMax = Math.max(
        this.lastSelectionMetrics.detailBiasMax ?? Number.NEGATIVE_INFINITY,
        influence.detailBias,
      );
      this.lastSelectionMetrics.centerWeightMin = Math.min(
        this.lastSelectionMetrics.centerWeightMin ?? Number.POSITIVE_INFINITY,
        candidate.centerWeight,
      );
      this.lastSelectionMetrics.centerWeightMax = Math.max(
        this.lastSelectionMetrics.centerWeightMax ?? Number.NEGATIVE_INFINITY,
        candidate.centerWeight,
      );
      this.lastSelectionMetrics.refinementCenterWeightMin =
        this.lastSelectionMetrics.centerWeightMin;
      this.lastSelectionMetrics.refinementCenterWeightMax =
        this.lastSelectionMetrics.centerWeightMax;
      this.lastSelectionMetrics.schedulingCenterWeightMin = Math.min(
        this.lastSelectionMetrics.schedulingCenterWeightMin ?? Number.POSITIVE_INFINITY,
        candidate.schedulingCenterWeight,
      );
      this.lastSelectionMetrics.schedulingCenterWeightMax = Math.max(
        this.lastSelectionMetrics.schedulingCenterWeightMax ?? Number.NEGATIVE_INFINITY,
        candidate.schedulingCenterWeight,
      );
      this.lastSelectionMetrics.focusWeightMin = Math.min(
        this.lastSelectionMetrics.focusWeightMin ?? Number.POSITIVE_INFINITY,
        candidate.focusWeight,
      );
      this.lastSelectionMetrics.focusWeightMax = Math.max(
        this.lastSelectionMetrics.focusWeightMax ?? Number.NEGATIVE_INFINITY,
        candidate.focusWeight,
      );
      if (candidate.focusWeight > 0) {
        this.lastSelectionMetrics.focusCandidateCount =
          (this.lastSelectionMetrics.focusCandidateCount ?? 0) + 1;
      }
      this.lastSelectionMetrics.refinementPriorityMin = Math.min(
        this.lastSelectionMetrics.refinementPriorityMin ?? Number.POSITIVE_INFINITY,
        candidate.refinementPriority,
      );
      this.lastSelectionMetrics.refinementPriorityMax = Math.max(
        this.lastSelectionMetrics.refinementPriorityMax ?? Number.NEGATIVE_INFINITY,
        candidate.refinementPriority,
      );
      this.lastSelectionMetrics.schedulingPriorityMin = Math.min(
        this.lastSelectionMetrics.schedulingPriorityMin ?? Number.POSITIVE_INFINITY,
        candidate.schedulingPriority,
      );
      this.lastSelectionMetrics.schedulingPriorityMax = Math.max(
        this.lastSelectionMetrics.schedulingPriorityMax ?? Number.NEGATIVE_INFINITY,
        candidate.schedulingPriority,
      );
      if (influence.combinedWeight > 0) {
        this.lastSelectionMetrics.candidatesWithNonZeroInfluenceCount =
          (this.lastSelectionMetrics.candidatesWithNonZeroInfluenceCount ?? 0) + 1;
      }
      if (influence.wasClamped) {
        this.lastSelectionMetrics.influenceClampCount =
          (this.lastSelectionMetrics.influenceClampCount ?? 0) + 1;
      }
    };

    if (!fallbackUsed) {
      const pending = new Map<string, RefinementCandidate>();
      const enqueue = (parent: StreamingHierarchyNode): void => {
        if (pending.has(parent.node.key)) {
          return;
        }

        const evaluation = evaluations.get(parent.node.key) ?? evaluate(parent);
        if (!evaluation.visible) {
          return;
        }
        if (parent.children.length === 0 || parent.node.level >= this.options.maxDepth) {
          return;
        }

        const prioritised = toPrioritised(parent);
        recordCandidateInfluence(prioritised);
        const decision = shouldRefine(
          parent,
          this.options,
          prioritised.influence.effectiveScreenSpaceError,
          prioritised.wasPreviouslyRefined,
        );
        const influenceWithoutManualFocus = calculateInfluenceWithoutManualFocus(
          prioritised.influence,
          this.refinementFocus,
        );
        const focusContributesToRefinement = prioritised.focusWeight > 0
          && prioritised.influence.effectiveScreenSpaceError
            > influenceWithoutManualFocus.effectiveScreenSpaceError;
        const focusChangedRefinementDecision = focusContributesToRefinement
          && shouldRefine(
            parent,
            this.options,
            influenceWithoutManualFocus.effectiveScreenSpaceError,
            prioritised.wasPreviouslyRefined,
          ) !== decision;
        const influenceWithoutMotion = calculateInfluenceWithoutMotion(
          prioritised.influence,
          this.refinementFocus,
        );
        const motionChangedRefinementDecision = prioritised.motionWeight > 0
          && prioritised.influence.effectiveScreenSpaceError
            > influenceWithoutMotion.effectiveScreenSpaceError
          && shouldRefine(
            parent,
            this.options,
            influenceWithoutMotion.effectiveScreenSpaceError,
            prioritised.wasPreviouslyRefined,
          ) !== decision;
        const hasPreviousState = prioritised.wasPreviouslySelected
          || prioritised.wasPreviouslyRefined;
        if (decision === 'hold' && hasPreviousState) {
          this.lastSelectionMetrics.hysteresisHoldCount =
            (this.lastSelectionMetrics.hysteresisHoldCount ?? 0) + 1;
        }
        if (decision === 'collapse') {
          this.lastSelectionMetrics.collapseDecisionCount =
            (this.lastSelectionMetrics.collapseDecisionCount ?? 0) + 1;
          return;
        }
        if (decision === 'hold' && !prioritised.wasPreviouslyRefined) {
          return;
        }

        this.lastSelectionMetrics.refinedNodeCount += 1;
        if (decision === 'refine') {
          this.lastSelectionMetrics.refineDecisionCount =
            (this.lastSelectionMetrics.refineDecisionCount ?? 0) + 1;
        }
        if (prioritised.centerWeight > 0) {
          this.lastSelectionMetrics.candidatesWithCenterBoostCount =
            (this.lastSelectionMetrics.candidatesWithCenterBoostCount ?? 0) + 1;
        }

        if (parent.childrenComplete !== true) {
          this.lastSelectionMetrics.refinementDeferredByIncompleteHierarchyCount =
            (this.lastSelectionMetrics.refinementDeferredByIncompleteHierarchyCount ?? 0) + 1;
          return;
        }

        const replacement: StreamingHierarchyNode[] = [];
        for (const childKey of [...parent.children].sort()) {
          const child = hierarchy.get(childKey);
          if (!child) {
            this.lastSelectionMetrics.refinementDeferredByIncompleteHierarchyCount =
              (this.lastSelectionMetrics.refinementDeferredByIncompleteHierarchyCount ?? 0) + 1;
            return;
          }

          const childEvaluation = evaluate(child);
          if (childEvaluation.visible && child.node.pointCount > 0) {
            replacement.push(child);
          }
        }

        if (replacement.length === 0) {
          return;
        }

        pending.set(parent.node.key, {
          ...prioritised,
          replacement,
          replacementPointCost: replacement.reduce(
            (total, child) => total + getNodePointCost(child),
            0,
          ),
          focusChangedRefinementDecision,
          refinementPriorityWithoutManualFocus:
            influenceWithoutManualFocus.effectiveScreenSpaceError,
          motionChangedRefinementDecision,
          refinementPriorityWithoutMotion:
            influenceWithoutMotion.effectiveScreenSpaceError,
        });
      };

      for (const node of frontier.values()) {
        enqueue(node);
      }

      let frontierPointCount = initialPointCount;
      const canApplyWithinBudgets = (
        replacementCandidate: RefinementCandidate,
        nodeCount: number,
        pointCount: number,
      ): boolean => {
        const resultingNodeCount = nodeCount - 1 + replacementCandidate.replacement.length;
        const resultingPointCount = pointCount
          - replacementCandidate.pointCost
          + replacementCandidate.replacementPointCost;
        return (resultingNodeCount <= this.options.maxNodes
          && resultingPointCount <= budget)
          || (nodeCount <= this.options.maxNodes
            && pointCount > budget
            && resultingNodeCount <= this.options.maxNodes
            && resultingPointCount < pointCount);
      };

      while (pending.size > 0) {
        const candidate = [...pending.values()]
          .sort(compareRefinementPriority)[0];
        pending.delete(candidate.node.node.key);

        if (!frontier.has(candidate.node.node.key)) {
          continue;
        }

        const nextNodeCount = frontier.size - 1 + candidate.replacement.length;
        const nextPointCount = frontierPointCount
          - candidate.pointCost
          + candidate.replacementPointCost;
        const fitsBudgets = nextNodeCount <= this.options.maxNodes
          && nextPointCount <= budget;
        // An initially oversized point frontier may need more than one
        // refinement before it fits. Permit only a strictly point-reducing
        // intermediate transaction, and never let the internal frontier
        // exceed the node budget. The returned frontier is still hard-bounded.
        const isBudgetReducingPointStep = frontier.size <= this.options.maxNodes
          && frontierPointCount > budget
          && nextNodeCount <= this.options.maxNodes
          && nextPointCount < frontierPointCount;

        const focusChangedBudgetWinner = fitsBudgets || isBudgetReducingPointStep
          ? [...pending.values()].some((other) => {
            const focusOrder = compareRefinementPriority(candidate, other);
            const noFocusOrder = compareRefinementPriorityByScore(
              candidate,
              other,
              candidate.refinementPriorityWithoutManualFocus,
              other.refinementPriorityWithoutManualFocus,
            );
            if (focusOrder >= 0 || noFocusOrder <= 0) {
              return false;
            }

            const otherFitsBefore = canApplyWithinBudgets(
              other,
              frontier.size,
              frontierPointCount,
            );
            const otherFitsAfter = canApplyWithinBudgets(other, nextNodeCount, nextPointCount);
            return otherFitsBefore && !otherFitsAfter;
          })
          : false;
        const motionChangedBudgetWinner = fitsBudgets || isBudgetReducingPointStep
          ? [...pending.values()].some((other) => {
            const motionOrder = compareRefinementPriority(candidate, other);
            const noMotionOrder = compareRefinementPriorityByScore(
              candidate,
              other,
              candidate.refinementPriorityWithoutMotion,
              other.refinementPriorityWithoutMotion,
            );
            if (motionOrder >= 0 || noMotionOrder <= 0) {
              return false;
            }

            const otherFitsBefore = canApplyWithinBudgets(
              other,
              frontier.size,
              frontierPointCount,
            );
            const otherFitsAfter = canApplyWithinBudgets(other, nextNodeCount, nextPointCount);
            return otherFitsBefore && !otherFitsAfter;
          })
          : false;

        if (!fitsBudgets && !isBudgetReducingPointStep) {
          if (nextNodeCount > this.options.maxNodes) {
            this.lastSelectionMetrics.refinementRejectedByNodeBudgetCount =
              (this.lastSelectionMetrics.refinementRejectedByNodeBudgetCount ?? 0) + 1;
          } else {
            this.lastSelectionMetrics.refinementRejectedByPointBudgetCount =
              (this.lastSelectionMetrics.refinementRejectedByPointBudgetCount ?? 0) + 1;
          }
          continue;
        }

        frontier.delete(candidate.node.node.key);
        for (const child of candidate.replacement) {
          frontier.set(child.node.key, child);
        }
        frontierPointCount = nextPointCount;
        this.lastSelectionMetrics.acceptedRefinementCount =
          (this.lastSelectionMetrics.acceptedRefinementCount ?? 0) + 1;
        this.lastSelectionMetrics.acceptedRefinementPriorityMin = Math.min(
          this.lastSelectionMetrics.acceptedRefinementPriorityMin ?? Number.POSITIVE_INFINITY,
          candidate.refinementPriority,
        );
        this.lastSelectionMetrics.acceptedRefinementPriorityMax = Math.max(
          this.lastSelectionMetrics.acceptedRefinementPriorityMax ?? Number.NEGATIVE_INFINITY,
          candidate.refinementPriority,
        );
        if (candidate.influence.gazeWeight > 0) {
          this.lastSelectionMetrics.acceptedGazeInfluencedRefinementCount =
            (this.lastSelectionMetrics.acceptedGazeInfluencedRefinementCount ?? 0) + 1;
        }
        if (candidate.focusChangedRefinementDecision || focusChangedBudgetWinner) {
          this.lastSelectionMetrics.focusInfluencedRefinementCount =
            (this.lastSelectionMetrics.focusInfluencedRefinementCount ?? 0) + 1;
        }
        if (candidate.motionChangedRefinementDecision || motionChangedBudgetWinner) {
          this.lastSelectionMetrics.motionInfluencedRefinementCount =
            (this.lastSelectionMetrics.motionInfluencedRefinementCount ?? 0) + 1;
        }

        for (const child of candidate.replacement) {
          enqueue(child);
        }
      }

      const selected = [...frontier.values()]
        .map(toPrioritised)
        .map((candidate) => {
          recordCandidateInfluence(candidate);
          return candidate;
        })
        .sort(compareSchedulingPriority)
        .map(toSelectedNode);

      // A refinement can reduce the workload of an initially oversized
      // frontier (for example, a 100-point parent replaced by two 20-point
      // children). Try those atomic replacements before applying the existing
      // deterministic hard-safety fallback. The fallback is only needed when
      // no complete refinement sequence can bring the minimum visible
      // frontier under the configured limits.
      if (
        (frontier.size > this.options.maxNodes || frontierPointCount > budget)
        && (exceedsNodeBudget || exceedsPointBudget)
      ) {
        const accepted: PrioritisedNode[] = [];
        let acceptedPointCount = 0;
        for (const candidate of initialFrontier
          .map(toPrioritised)
          .sort(compareRefinementPriority)) {
          const canFitNodeBudget = accepted.length < this.options.maxNodes;
          const canFitPointBudget = candidate.pointCost <= budget - acceptedPointCount;
          if (canFitNodeBudget && canFitPointBudget) {
            accepted.push(candidate);
            acceptedPointCount += candidate.pointCost;
          } else {
            this.lastSelectionMetrics.deferredNodeCount += 1;
            this.lastSelectionMetrics.deferredPointCount += candidate.pointCost;
            this.lastSelectionMetrics.budgetDeferDropCount += 1;
          }
        }

        const selected = accepted
          .map((candidate) => {
            recordCandidateInfluence(candidate);
            return candidate;
          })
          .sort(compareSchedulingPriority)
          .map(toSelectedNode);
        this.recordFrontierMetrics(selected, initialPointCount, acceptedPointCount);
        return selected;
      }

      this.recordFrontierMetrics(selected, initialPointCount, frontierPointCount);
      return selected;
    }

    if (fallbackUsed) {
      const fallback = [...frontier.values()][0];
      if (!fallback || this.options.maxNodes < 1 || getNodePointCost(fallback) > budget) {
        if (fallback) {
          this.lastSelectionMetrics.deferredNodeCount += 1;
          this.lastSelectionMetrics.deferredPointCount += getNodePointCost(fallback);
          this.lastSelectionMetrics.budgetDeferDropCount += 1;
        }
        this.recordFrontierMetrics([], initialPointCount, 0);
        return [];
      }
    }

    const selected = initialFrontier
      .map(toPrioritised)
      .map((candidate) => {
        recordCandidateInfluence(candidate);
        return candidate;
      })
      .sort(compareSchedulingPriority)
      .map(toSelectedNode);
    this.recordFrontierMetrics(selected, initialPointCount, initialPointCount);
    return selected;
  }

  private recordFrontierMetrics(
    frontier: readonly StreamingHierarchyNode[],
    candidatePointCount: number,
    frontierPointCount: number,
  ): void {
    this.lastSelectionMetrics.frontierNodeCount = frontier.length;
    this.lastSelectionMetrics.frontierPointCount = frontierPointCount;
    this.lastSelectionMetrics.keptNodeCount = frontier.length;
    this.lastSelectionMetrics.candidateSelectedPointCount = candidatePointCount;
    this.lastSelectionMetrics.budgetedPointCount = frontierPointCount;
  }
}
