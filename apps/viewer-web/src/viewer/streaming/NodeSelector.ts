import { intersectsViewFrustum } from './view';
import type { StreamingHierarchyNode, StreamingSelectionMetrics } from './types';
import type {
  StreamingCameraState,
  StreamingHierarchy,
  StreamingSelectionOptions,
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

function shouldRefine(
  camera: StreamingCameraState,
  node: StreamingHierarchyNode,
  options: StreamingSelectionOptions,
): boolean {
  if (node.children.length === 0 || node.node.level >= options.maxDepth) {
    return false;
  }

  const distanceMeters = calculateDistanceMeters(camera, node);
  const refineDistance =
    node.approximateSizeMeters * options.refineDistanceMultiplier;

  return distanceMeters <= refineDistance;
}

function getRootNodes(hierarchy: StreamingHierarchy): StreamingHierarchyNode[] {
  return [...hierarchy.values()].filter((entry) => entry.node.level === 0);
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
  };

  constructor(options: StreamingSelectionOptions) {
    this.options = options;
  }

  getSelectionMetrics(): StreamingSelectionMetrics {
    return { ...this.lastSelectionMetrics };
  }

  selectVisibleNodes(
    camera: StreamingCameraState,
    hierarchy: StreamingHierarchy,
  ): StreamingHierarchyNode[] {
    this.lastSelectionMetrics = {
      candidatesBeforeCulling: 0,
      frustumCulledCount: 0,
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

      if (shouldRefine(camera, node, this.options)) {
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

    return [...selected.values()]
      .sort((left, right) => compareNodePriority(camera, left, right))
      .slice(0, this.options.maxNodes);
  }
}
