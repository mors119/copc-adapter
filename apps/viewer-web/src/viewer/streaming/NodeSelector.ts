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
};

function compareBudgetPriority(
  camera: StreamingCameraState,
  context: StreamingSelectionContext,
  left: PrioritisedNode,
  right: PrioritisedNode,
): number {
  // Projected error is the primary signal. The remaining visual signals are
  // deterministic tie-breakers; continuity/cache availability only prevent
  // avoidable churn when visual priority is otherwise equal.
  return right.screenSpaceErrorPixels - left.screenSpaceErrorPixels
    || calculateBoundsDistanceMeters(camera, left.node) - calculateBoundsDistanceMeters(camera, right.node)
    || right.node.node.level - left.node.node.level
    || Number(context.previousSelectedNodeKeys?.has(right.node.node.key) ?? false)
      - Number(context.previousSelectedNodeKeys?.has(left.node.node.key) ?? false)
    || Number(context.isNodeCached?.(right.node.node.key) ?? false)
      - Number(context.isNodeCached?.(left.node.node.key) ?? false)
    || getNodePointCost(left.node) - getNodePointCost(right.node)
    || left.node.node.key.localeCompare(right.node.node.key);
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
  private lastSelectionMetrics: StreamingSelectionMetrics = {
    candidatesBeforeCulling: 0,
    frustumCulledCount: 0,
    maxScreenSpaceError: DEFAULT_MAX_SCREEN_SPACE_ERROR,
    refinedNodeCount: 0,
    keptNodeCount: 0,
    candidateSelectedPointCount: 0,
    budgetedPointCount: 0,
    maxRenderedPoints: DEFAULT_MAX_RENDERED_POINTS,
    deferredNodeCount: 0,
    deferredPointCount: 0,
    budgetDeferDropCount: 0,
  };

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
    this.lastSelectionMetrics = {
      candidatesBeforeCulling: 0,
      frustumCulledCount: 0,
      maxScreenSpaceError: this.options.maxScreenSpaceError ?? DEFAULT_MAX_SCREEN_SPACE_ERROR,
      refinedNodeCount: 0,
      keptNodeCount: 0,
      candidateSelectedPointCount: 0,
      budgetedPointCount: 0,
      maxRenderedPoints: this.options.maxRenderedPoints ?? DEFAULT_MAX_RENDERED_POINTS,
      deferredNodeCount: 0,
      deferredPointCount: 0,
      budgetDeferDropCount: 0,
    };
    const selected = new Map<string, StreamingHierarchyNode>();

    const visit = (node: StreamingHierarchyNode): boolean => {
      this.lastSelectionMetrics.candidatesBeforeCulling += 1;

      if (!isNodeFrustumVisible(camera, node)) {
        this.lastSelectionMetrics.frustumCulledCount += 1;
        return false;
      }

      if (!isNodeVisible(camera, node, this.options)) {
        return false;
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

      if (shouldRefine(node, this.options, screenSpaceErrorPixels)) {
        this.lastSelectionMetrics.refinedNodeCount += 1;
        let descendantSelected = false;

        for (const childKey of node.children) {
          const child = hierarchy.get(childKey);

          if (!child || child.node.pointCount <= 0) {
            continue;
          }

          if (visit(child)) {
            descendantSelected = true;
          }
        }

        // Keep the parent out when any visible descendant represents it.
        if (descendantSelected) {
          return true;
        }
      }

      this.lastSelectionMetrics.keptNodeCount += 1;

      if (node.node.pointCount > 0) {
        selected.set(node.node.key, node);

        return true;
      }

      return false;
    };

    for (const rootNode of getRootNodes(hierarchy)) {
      visit(rootNode);
    }

    if (selected.size === 0 && !camera.viewFrustum) {
      const fallback = [...hierarchy.values()]
        .filter((entry) => entry.node.pointCount > 0)
        .sort(
          (left, right) =>
            calculateBoundsDistanceMeters(camera, left) -
            calculateBoundsDistanceMeters(camera, right),
        )[0];

      if (fallback) {
        selected.set(fallback.node.key, fallback);
      }
    }

    const maxNodesSelected = [...selected.values()]
      .sort((left, right) => compareNodePriority(camera, left, right))
      .slice(0, this.options.maxNodes);

    this.lastSelectionMetrics.candidateSelectedPointCount = maxNodesSelected.reduce(
      (total, node) => total + getNodePointCost(node),
      0,
    );

    const prioritised = maxNodesSelected
      .map((node) => ({
        node,
        screenSpaceErrorPixels: calculateScreenSpaceErrorPixels(camera, node),
      }))
      .sort((left, right) => compareBudgetPriority(camera, context, left, right));
    const budget = this.options.maxRenderedPoints ?? DEFAULT_MAX_RENDERED_POINTS;
    const accepted: StreamingHierarchyNode[] = [];
    let acceptedPointCount = 0;

    for (const candidate of prioritised) {
      const pointCost = getNodePointCost(candidate.node);
      if (pointCost <= budget - acceptedPointCount) {
        accepted.push(candidate.node);
        acceptedPointCount += pointCost;
        continue;
      }

      this.lastSelectionMetrics.deferredNodeCount += 1;
      this.lastSelectionMetrics.deferredPointCount += pointCost;
      this.lastSelectionMetrics.budgetDeferDropCount += 1;
    }

    this.lastSelectionMetrics.budgetedPointCount = acceptedPointCount;

    return accepted;
  }
}
