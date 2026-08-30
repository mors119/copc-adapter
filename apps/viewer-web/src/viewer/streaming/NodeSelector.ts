import { intersectsViewFrustum } from './view';
import type { StreamingHierarchyNode, StreamingSelectionMetrics } from './types';
import type {
  StreamingCameraState,
  StreamingHierarchy,
  StreamingSelectionOptions,
  StreamingSelectionContext,
  ViewFrustum,
  ViewVector3,
} from './types';

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
/** Maximum additional refinement priority available to a screen-center node. */
export const DEFAULT_CENTER_PRIORITY_BOOST = 0.25;
/**
 * Conservative first workload default, informed by the issue-48 renderer
 * measurements. It is a point-pressure guard, not a GPU-memory limit.
 */
export const DEFAULT_MAX_RENDERED_POINTS = 250_000;
const DEFAULT_VERTICAL_FOV_RADIANS = Math.PI / 3;
const DEFAULT_VIEWPORT_HEIGHT_PIXELS = 1080;

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

function calculateCenterWeightForProjection(
  node: StreamingHierarchyNode,
  projection: GazeProjection | undefined,
): number {
  if (!projection || !node.boundingSphere || !isFiniteVector(node.boundingSphere.center)) {
    return 0;
  }

  const vector = {
    x: node.boundingSphere.center.x - projection.position.x,
    y: node.boundingSphere.center.y - projection.position.y,
    z: node.boundingSphere.center.z - projection.position.z,
  };
  const forward = dot(vector, projection.direction);
  if (!Number.isFinite(forward) || forward <= 0) {
    return 0;
  }

  const horizontalDisplacement = Math.abs(dot(vector, projection.right)) /
    (forward * projection.horizontalTangent);
  const verticalDisplacement = Math.abs(dot(vector, projection.up)) /
    (forward * projection.verticalTangent);
  if (!Number.isFinite(horizontalDisplacement) || !Number.isFinite(verticalDisplacement)) {
    return 0;
  }

  // Treat the sphere's angular extent conservatively: a large sphere gets
  // credit when its visible extent reaches toward the screen centre, while a
  // sphere whose centre is behind the camera never receives a bonus.
  const radius = Number.isFinite(node.boundingSphere.radiusMeters)
    ? Math.max(node.boundingSphere.radiusMeters, 0)
    : 0;
  const angularRadius = radius / Math.max(forward, 1e-6) /
    Math.min(projection.horizontalTangent, projection.verticalTangent);
  const normalizedScreenRadius = Math.hypot(
    horizontalDisplacement,
    verticalDisplacement,
  );

  return clamp(
    1 - Math.max(0, normalizedScreenRadius - angularRadius),
    0,
    1,
  );
}

/** Calculate the bounded screen-centre relevance for a project-owned view. */
export function calculateGazeCenterWeight(
  camera: StreamingCameraState,
  node: StreamingHierarchyNode,
): number {
  return calculateCenterWeightForProjection(node, createGazeProjection(camera.viewFrustum));
}

function getGeometricErrorMeters(node: StreamingHierarchyNode): number {
  return node.geometricErrorMeters ?? node.approximateSizeMeters / 2;
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

  return geometricErrorMeters * viewportHeightPixels /
    (2 * distanceMeters * Math.tan(verticalFovRadians / 2));
}

function shouldRefine(
  node: StreamingHierarchyNode,
  options: StreamingSelectionOptions,
  screenSpaceErrorPixels: number,
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
    if (screenSpaceErrorPixels < collapseThreshold) {
      return 'collapse';
    }
    if (screenSpaceErrorPixels <= refineThreshold) {
      return 'hold';
    }
    return 'refine';
  }

  return screenSpaceErrorPixels > refineThreshold ? 'refine' : 'hold';
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
  centerWeight: number;
  priority: number;
  boundsDistanceMeters: number;
  wasPreviouslySelected: boolean;
  wasPreviouslyRefined: boolean;
  isCached: boolean;
  pointCost: number;
};

function compareBudgetPriority(
  left: PrioritisedNode,
  right: PrioritisedNode,
): number {
  // Projected error remains primary through the bounded priority multiplier.
  // The remaining visual signals are deterministic tie-breakers; continuity
  // and cache availability only prevent avoidable churn when visual priority
  // is otherwise equal. All values are precomputed before sorting.
  return right.priority - left.priority
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

type RefinementCandidate = PrioritisedNode & {
  replacement: StreamingHierarchyNode[];
  replacementPointCost: number;
};

function createSelectionMetrics(
  maxScreenSpaceError: number,
  maxRenderedPoints: number,
): StreamingSelectionMetrics {
  return {
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
    candidatesWithCenterBoostCount: 0,
    hysteresisHoldCount: 0,
    refineDecisionCount: 0,
    collapseDecisionCount: 0,
  };
}

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

export class NodeSelector {
  private readonly options: StreamingSelectionOptions;
  private lastSelectionMetrics: StreamingSelectionMetrics = createSelectionMetrics(
    DEFAULT_MAX_SCREEN_SPACE_ERROR,
    DEFAULT_MAX_RENDERED_POINTS,
  );

  constructor(options: StreamingSelectionOptions) {
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
      maxScreenSpaceError,
      screenSpaceErrorHysteresis,
      maxRenderedPoints: validateMaxRenderedPoints(
        options.maxRenderedPoints ?? DEFAULT_MAX_RENDERED_POINTS,
      ),
    };
  }

  getSelectionMetrics(): StreamingSelectionMetrics {
    return { ...this.lastSelectionMetrics };
  }

  selectVisibleNodes(
    camera: StreamingCameraState,
    hierarchy: StreamingHierarchy,
    context: StreamingSelectionContext = {},
  ): StreamingHierarchyNode[] {
    const maxScreenSpaceError = this.options.maxScreenSpaceError
      ?? DEFAULT_MAX_SCREEN_SPACE_ERROR;
    const budget = this.options.maxRenderedPoints ?? DEFAULT_MAX_RENDERED_POINTS;
    this.lastSelectionMetrics = createSelectionMetrics(maxScreenSpaceError, budget);

    const frontier = new Map<string, StreamingHierarchyNode>();
    const gazeProjection = createGazeProjection(camera.viewFrustum);
    const evaluations = new Map<string, {
      visible: boolean;
      screenSpaceErrorPixels: number;
    }>();

    const evaluate = (node: StreamingHierarchyNode) => {
      const existing = evaluations.get(node.node.key);
      if (existing) {
        return existing;
      }

      this.lastSelectionMetrics.candidatesBeforeCulling += 1;
      if (!isNodeFrustumVisible(camera, node)) {
        this.lastSelectionMetrics.frustumCulledCount += 1;
        const result = { visible: false, screenSpaceErrorPixels: 0 };
        evaluations.set(node.node.key, result);
        return result;
      }

      if (!isNodeVisible(camera, node, this.options)) {
        const result = { visible: false, screenSpaceErrorPixels: 0 };
        evaluations.set(node.node.key, result);
        return result;
      }

      const screenSpaceErrorPixels = calculateScreenSpaceErrorPixels(camera, node);
      this.lastSelectionMetrics.screenSpaceErrorMin = Math.min(
        this.lastSelectionMetrics.screenSpaceErrorMin ?? Number.POSITIVE_INFINITY,
        screenSpaceErrorPixels,
      );
      this.lastSelectionMetrics.screenSpaceErrorMax = Math.max(
        this.lastSelectionMetrics.screenSpaceErrorMax ?? Number.NEGATIVE_INFINITY,
        screenSpaceErrorPixels,
      );
      const result = { visible: true, screenSpaceErrorPixels };
      evaluations.set(node.node.key, result);
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
      const centerWeight = calculateCenterWeightForProjection(node, gazeProjection);
      return {
        node,
        screenSpaceErrorPixels: evaluation.screenSpaceErrorPixels,
        centerWeight,
        priority: evaluation.screenSpaceErrorPixels *
          (1 + DEFAULT_CENTER_PRIORITY_BOOST * centerWeight),
        boundsDistanceMeters: calculateBoundsDistanceMeters(camera, node),
        wasPreviouslySelected: context.previousSelectedNodeKeys?.has(node.node.key) ?? false,
        wasPreviouslyRefined: hasPreviouslyRefinedDescendant(node),
        isCached: context.isNodeCached?.(node.node.key) ?? false,
        pointCost: getNodePointCost(node),
      };
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
        const decision = shouldRefine(
          parent,
          this.options,
          evaluation.screenSpaceErrorPixels,
          prioritised.wasPreviouslyRefined,
        );
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
        this.lastSelectionMetrics.centerWeightMin = Math.min(
          this.lastSelectionMetrics.centerWeightMin ?? Number.POSITIVE_INFINITY,
          prioritised.centerWeight,
        );
        this.lastSelectionMetrics.centerWeightMax = Math.max(
          this.lastSelectionMetrics.centerWeightMax ?? Number.NEGATIVE_INFINITY,
          prioritised.centerWeight,
        );
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
        });
      };

      for (const node of frontier.values()) {
        enqueue(node);
      }

      let frontierPointCount = initialPointCount;
      while (pending.size > 0) {
        const candidate = [...pending.values()]
          .sort(compareBudgetPriority)[0];
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
          candidate.priority,
        );
        this.lastSelectionMetrics.acceptedRefinementPriorityMax = Math.max(
          this.lastSelectionMetrics.acceptedRefinementPriorityMax ?? Number.NEGATIVE_INFINITY,
          candidate.priority,
        );

        for (const child of candidate.replacement) {
          enqueue(child);
        }
      }

      const selected = [...frontier.values()]
        .sort((left, right) => compareNodePriority(camera, left, right));

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
        const accepted: StreamingHierarchyNode[] = [];
        let acceptedPointCount = 0;
        for (const candidate of initialFrontier
          .map(toPrioritised)
          .sort(compareBudgetPriority)) {
          const canFitNodeBudget = accepted.length < this.options.maxNodes;
          const canFitPointBudget = candidate.pointCost <= budget - acceptedPointCount;
          if (canFitNodeBudget && canFitPointBudget) {
            accepted.push(candidate.node);
            acceptedPointCount += candidate.pointCost;
          } else {
            this.lastSelectionMetrics.deferredNodeCount += 1;
            this.lastSelectionMetrics.deferredPointCount += candidate.pointCost;
            this.lastSelectionMetrics.budgetDeferDropCount += 1;
          }
        }

        this.recordFrontierMetrics(accepted, initialPointCount, acceptedPointCount);
        return accepted.sort((left, right) => compareNodePriority(camera, left, right));
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

    this.recordFrontierMetrics(initialFrontier, initialPointCount, initialPointCount);
    return initialFrontier.sort((left, right) => compareNodePriority(camera, left, right));
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
