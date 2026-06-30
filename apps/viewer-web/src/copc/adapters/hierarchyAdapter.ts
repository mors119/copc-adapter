import type { Hierarchy } from 'copc';
import type { CopcHierarchyNode } from '../types/copc';

export function toCopcHierarchyNode(
  keyText: string,
  node: Hierarchy.Node,
): CopcHierarchyNode {
  const [level, x, y, z] = keyText.split('-').map(Number);

  return {
    key: keyText,
    level,
    x,
    y,
    z,
    pointCount: node.pointCount,
    pointDataOffset: node.pointDataOffset,
    pointDataLength: node.pointDataLength,
    raw: node,
  };
}
