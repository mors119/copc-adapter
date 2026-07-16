import type {
  CopcHierarchyNode,
  CopcMetadata,
  GeographicPoint,
} from '../../copc/types/copc';
import { extractHorizontalUnitScale } from '../../coordinates/crs/parseCopcWkt';
import { createPointTransformer } from '../../coordinates/transform/createPointTransformer';
import type {
  BoundingBox,
  StreamingHierarchy,
} from './types';

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

function getChildKeys(
  node: CopcHierarchyNode,
  nodeMap: Map<string, CopcHierarchyNode>,
): string[] {
  if (node.children) {
    return node.children.filter((childKey) => nodeMap.has(childKey));
  }

  return Array.from({ length: 8 }, (_, childIndex) =>
    createChildKey(node, childIndex),
  ).filter((childKey) => nodeMap.has(childKey));
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

function getNodeBounds(
  metadata: CopcMetadata,
  node: CopcHierarchyNode,
): BoundingBox {
  const cubeSide = getCubeSideLength(metadata);
  const nodeSide = cubeSide / (2 ** node.level);

  return {
    minX: metadata.cube.minX + (node.x * nodeSide),
    minY: metadata.cube.minY + (node.y * nodeSide),
    minZ: metadata.cube.minZ + (node.z * nodeSide),
    maxX: metadata.cube.minX + ((node.x + 1) * nodeSide),
    maxY: metadata.cube.minY + ((node.y + 1) * nodeSide),
    maxZ: metadata.cube.minZ + ((node.z + 1) * nodeSide),
  };
}

function toGeographicBounds(
  transformPoint: (point: { x: number; y: number; z: number }) => GeographicPoint,
  bounds: BoundingBox,
): BoundingBox {
  const corners = [
    transformPoint({ x: bounds.minX, y: bounds.minY, z: bounds.minZ }),
    transformPoint({ x: bounds.minX, y: bounds.minY, z: bounds.maxZ }),
    transformPoint({ x: bounds.minX, y: bounds.maxY, z: bounds.minZ }),
    transformPoint({ x: bounds.minX, y: bounds.maxY, z: bounds.maxZ }),
    transformPoint({ x: bounds.maxX, y: bounds.minY, z: bounds.minZ }),
    transformPoint({ x: bounds.maxX, y: bounds.minY, z: bounds.maxZ }),
    transformPoint({ x: bounds.maxX, y: bounds.maxY, z: bounds.minZ }),
    transformPoint({ x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ }),
  ];

  return corners.reduce<BoundingBox>((accumulator, corner) => ({
    minX: Math.min(accumulator.minX, corner.longitude),
    minY: Math.min(accumulator.minY, corner.latitude),
    minZ: Math.min(accumulator.minZ, corner.height),
    maxX: Math.max(accumulator.maxX, corner.longitude),
    maxY: Math.max(accumulator.maxY, corner.latitude),
    maxZ: Math.max(accumulator.maxZ, corner.height),
  }), {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  });
}

export function buildStreamingHierarchy(
  metadata: CopcMetadata,
  nodes: CopcHierarchyNode[],
): StreamingHierarchy {
  const transformPoint = createPointTransformer(metadata);
  const nodeMap = new Map(nodes.map((node) => [node.key, node]));
  const streamingNodes: StreamingHierarchy = new Map();
  const horizontalUnitScale = getHorizontalUnitScale(metadata);
  const cubeSide = getCubeSideLength(metadata);

  for (const node of nodes) {
    const children = getChildKeys(node, nodeMap);
    const nodeSide = cubeSide / (2 ** node.level);
    const center = getNodeCenter(metadata, node);
    const bounds = toGeographicBounds(transformPoint, getNodeBounds(metadata, node));

    streamingNodes.set(node.key, {
      node,
      children,
      center: transformPoint(center),
      bounds,
      approximateSizeMeters: nodeSide * horizontalUnitScale,
      boundingRadiusMeters: (Math.sqrt(3) * nodeSide * horizontalUnitScale) / 2,
    });
  }

  return streamingNodes;
}
