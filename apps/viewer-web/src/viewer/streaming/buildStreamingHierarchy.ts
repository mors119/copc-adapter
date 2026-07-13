import type {
  CopcHierarchyNode,
  CopcMetadata,
  GeographicPoint,
} from '../../copc/types/copc';
import { extractHorizontalUnitScale } from '../../coordinates/crs/parseCopcWkt';
import { createPointTransformer } from '../../coordinates/transform/createPointTransformer';

export type StreamingHierarchyNode = {
  node: CopcHierarchyNode;
  children: string[];
  center: GeographicPoint;
  approximateSizeMeters: number;
};

function createChildKey(parent: CopcHierarchyNode, childIndex: number): string {
  const level = parent.level + 1;
  const x = parent.x * 2 + (childIndex & 1);
  const y = parent.y * 2 + ((childIndex >> 1) & 1);
  const z = parent.z * 2 + ((childIndex >> 2) & 1);

  return `${level}-${x}-${y}-${z}`;
}

function getCubeSideLength(metadata: CopcMetadata): number {
  return metadata.cube.maxX - metadata.cube.minX;
}

function getHorizontalUnitScale(metadata: CopcMetadata): number {
  if (!metadata.wkt) {
    return 1;
  }

  return extractHorizontalUnitScale(metadata.wkt);
}

function getNodeCenter(
  metadata: CopcMetadata,
  node: CopcHierarchyNode,
): { x: number; y: number; z: number } {
  const cubeSide = getCubeSideLength(metadata);
  const nodeSide = cubeSide / (2 ** node.level);

  return {
    x: metadata.cube.minX + (node.x * nodeSide) + (nodeSide / 2),
    y: metadata.cube.minY + (node.y * nodeSide) + (nodeSide / 2),
    z: metadata.cube.minZ + (node.z * nodeSide) + (nodeSide / 2),
  };
}

export function buildStreamingHierarchy(
  metadata: CopcMetadata,
  nodes: CopcHierarchyNode[],
): Map<string, StreamingHierarchyNode> {
  const transformPoint = createPointTransformer(metadata);
  const nodeMap = new Map(nodes.map((node) => [node.key, node]));
  const streamingNodes = new Map<string, StreamingHierarchyNode>();
  const horizontalUnitScale = getHorizontalUnitScale(metadata);
  const cubeSide = getCubeSideLength(metadata);

  for (const node of nodes) {
    const children = Array.from({ length: 8 }, (_, childIndex) =>
      createChildKey(node, childIndex),
    ).filter((childKey) => nodeMap.has(childKey));
    const nodeSide = cubeSide / (2 ** node.level);
    const center = getNodeCenter(metadata, node);

    streamingNodes.set(node.key, {
      node,
      children,
      center: transformPoint(center),
      approximateSizeMeters: nodeSide * horizontalUnitScale,
    });
  }

  return streamingNodes;
}
