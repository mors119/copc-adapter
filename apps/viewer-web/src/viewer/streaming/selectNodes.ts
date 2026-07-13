import type { GeographicCamera } from '../../copc/types/copc';
import type { StreamingHierarchyNode } from './buildStreamingHierarchy';

type SelectionOptions = {
  maxNodes: number;
  minScreenSpaceMetric: number;
  refineScreenSpaceMetric: number;
  maxRenderDistanceMeters: number;
};

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function calculateDistanceMeters(
  camera: GeographicCamera,
  node: StreamingHierarchyNode,
): number {
  const earthRadiusMeters = 6371000;
  const latitude1 = toRadians(camera.latitude);
  const latitude2 = toRadians(node.center.latitude);
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = toRadians(node.center.longitude - camera.longitude);
  const haversine =
    (Math.sin(deltaLatitude / 2) ** 2) +
    (Math.cos(latitude1) * Math.cos(latitude2) * (Math.sin(deltaLongitude / 2) ** 2));
  const surfaceDistance =
    2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  const heightDelta = node.center.height - camera.height;

  return Math.hypot(surfaceDistance, heightDelta);
}

function shouldRefine(
  node: StreamingHierarchyNode,
  distanceMeters: number,
  options: SelectionOptions,
): boolean {
  if (node.children.length === 0) {
    return false;
  }

  const screenSpaceMetric = node.approximateSizeMeters / Math.max(distanceMeters, 1);

  return screenSpaceMetric >= options.refineScreenSpaceMetric;
}

function shouldRender(
  node: StreamingHierarchyNode,
  distanceMeters: number,
  options: SelectionOptions,
): boolean {
  if (distanceMeters > options.maxRenderDistanceMeters) {
    return false;
  }

  const screenSpaceMetric = node.approximateSizeMeters / Math.max(distanceMeters, 1);

  return screenSpaceMetric >= options.minScreenSpaceMetric || node.node.level === 0;
}

function getRootNodes(
  hierarchy: Map<string, StreamingHierarchyNode>,
): StreamingHierarchyNode[] {
  return [...hierarchy.values()].filter((entry) => entry.node.level === 0);
}

export function selectStreamingNodes(
  hierarchy: Map<string, StreamingHierarchyNode>,
  camera: GeographicCamera,
  options: SelectionOptions,
): string[] {
  const selected = new Set<string>();

  function visit(node: StreamingHierarchyNode): void {
    const distanceMeters = calculateDistanceMeters(camera, node);

    if (shouldRefine(node, distanceMeters, options)) {
      let selectedChildCount = 0;

      for (const childKey of node.children) {
        const child = hierarchy.get(childKey);

        if (!child || child.node.pointCount <= 0) {
          continue;
        }

        visit(child);
        selectedChildCount += 1;
      }

      if (selectedChildCount > 0) {
        return;
      }
    }

    if (node.node.pointCount > 0 && shouldRender(node, distanceMeters, options)) {
      selected.add(node.node.key);
    }
  }

  for (const rootNode of getRootNodes(hierarchy)) {
    visit(rootNode);
  }

  if (selected.size === 0) {
    const fallback = [...hierarchy.values()]
      .filter((entry) => entry.node.pointCount > 0)
      .sort(
        (left, right) =>
          calculateDistanceMeters(camera, left) - calculateDistanceMeters(camera, right),
      )[0];

    if (fallback) {
      selected.add(fallback.node.key);
    }
  }

  return [...selected]
    .sort((left, right) => {
      const leftNode = hierarchy.get(left);
      const rightNode = hierarchy.get(right);

      if (!leftNode || !rightNode) {
        return 0;
      }

      return (
        calculateDistanceMeters(camera, leftNode) -
        calculateDistanceMeters(camera, rightNode)
      );
    })
    .slice(0, options.maxNodes);
}

export { calculateDistanceMeters };
