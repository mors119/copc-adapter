import { intersectsViewFrustum } from './view';
import type { StreamingHierarchyNode, StreamingSelectionMetrics } from './types';
import type {
  StreamingCameraState,
  StreamingHierarchy,
  StreamingSelectionOptions,
  StreamingSelectionContext,
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
  return !camera.viewFrustum || !node.boundingSphere
    || intersectsViewFrustum(camera.viewFrustum, node.boundingSphere);
}

const DEFAULT_MAX_SCREEN_SPACE_ERROR = 8;
/**
 * Conservative first workload default, informed by the issue-48 renderer
 * measurements. It is a point-pressure guard, not a GPU-memory limit.
 */
export const DEFAULT_MAX_RENDERED_POINTS = 250_000;
const DEFAULT_VERTICAL_FOV_RADIANS = Math.PI / 3;
const DEFAULT_VIEWPORT_HEIGHT_PIXELS = 1080;

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
  const viewportHeightPixels = projection?.viewportHeightPixels
    ?? DEFAULT_VIEWPORT_HEIGHT_PIXELS;
  const verticalFovRadians = projection?.verticalFovRadians
    ?? DEFAULT_VERTICAL_FOV_RADIANS;
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
): boolean {
  if (node.children.length === 0 || node.node.level >= options.maxDepth) {
    return false;
  }

  return screenSpaceErrorPixels > (
    options.maxScreenSpaceError ?? DEFAULT_MAX_SCREEN_SPACE_ERROR
  );
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
  boundsDistanceMeters: number;
  wasPreviouslySelected: boolean;
  isCached: boolean;
  pointCost: number;
};

function compareBudgetPriority(
  left: PrioritisedNode,
  right: PrioritisedNode,
): number {
  // Projected error is the primary signal. The remaining visual signals are
  // deterministic tie-breakers; continuity/cache availability only prevent
  // avoidable churn when visual priority is otherwise equal. All values are
  // precomputed when a refinement enters the frontier queue.
  return right.screenSpaceErrorPixels - left.screenSpaceErrorPixels
    || left.boundsDistanceMeters - right.boundsDistanceMeters
    || right.node.node.level - left.node.node.level
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
    this.options = {
      ...options,
      maxScreenSpaceError: options.maxScreenSpaceError ?? DEFAULT_MAX_SCREEN_SPACE_ERROR,
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

    const toPrioritised = (node: StreamingHierarchyNode): PrioritisedNode => {
      const evaluation = evaluations.get(node.node.key) ?? evaluate(node);
      return {
        node,
        screenSpaceErrorPixels: evaluation.screenSpaceErrorPixels,
        boundsDistanceMeters: calculateBoundsDistanceMeters(camera, node),
        wasPreviouslySelected: context.previousSelectedNodeKeys?.has(node.node.key) ?? false,
        isCached: context.isNodeCached?.(node.node.key) ?? false,
        pointCost: getNodePointCost(node),
      };
    };

    // A minimum frontier that cannot fit is the one explicit exception to
    // atomic refinement. Keep the existing hard-safety behavior by returning
    // a deterministic bounded subset and recording that coverage is impossible
    // under the configured limits.
    if (exceedsNodeBudget || exceedsPointBudget) {
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

    if (!fallbackUsed) {
      const pending = new Map<string, RefinementCandidate>();
      const enqueue = (parent: StreamingHierarchyNode): void => {
        if (pending.has(parent.node.key)) {
          return;
        }

        const evaluation = evaluations.get(parent.node.key) ?? evaluate(parent);
        if (!evaluation.visible || !shouldRefine(parent, this.options, evaluation.screenSpaceErrorPixels)) {
          return;
        }

        this.lastSelectionMetrics.refinedNodeCount += 1;
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

        const prioritised = toPrioritised(parent);
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
        if (nextNodeCount > this.options.maxNodes) {
          this.lastSelectionMetrics.refinementRejectedByNodeBudgetCount =
            (this.lastSelectionMetrics.refinementRejectedByNodeBudgetCount ?? 0) + 1;
          continue;
        }
        if (nextPointCount > budget) {
          this.lastSelectionMetrics.refinementRejectedByPointBudgetCount =
            (this.lastSelectionMetrics.refinementRejectedByPointBudgetCount ?? 0) + 1;
          continue;
        }

        frontier.delete(candidate.node.node.key);
        for (const child of candidate.replacement) {
          frontier.set(child.node.key, child);
        }
        frontierPointCount = nextPointCount;
        this.lastSelectionMetrics.acceptedRefinementCount =
          (this.lastSelectionMetrics.acceptedRefinementCount ?? 0) + 1;

        for (const child of candidate.replacement) {
          enqueue(child);
        }
      }

      const selected = [...frontier.values()]
        .sort((left, right) => compareNodePriority(camera, left, right));
      this.recordFrontierMetrics(selected, initialPointCount, frontierPointCount);
      return selected;
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
