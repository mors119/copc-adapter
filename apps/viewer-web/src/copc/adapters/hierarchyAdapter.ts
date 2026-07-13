import type { Hierarchy } from 'copc';
import type { CopcHierarchyNode } from '../types/copc';

function parseHierarchyKey(keyText: string): {
  level: number;
  x: number;
  y: number;
  z: number;
} {
  const parts = keyText.split('-').map(Number);

  if (parts.length !== 4 || parts.some((value) => Number.isNaN(value))) {
    throw new Error(`Invalid COPC hierarchy key: ${keyText}`);
  }

  const [level, x, y, z] = parts;

  return { level, x, y, z };
}

export function toCopcHierarchyNode(
  keyText: string,
  node: Hierarchy.Node,
): CopcHierarchyNode {
  const { level, x, y, z } = parseHierarchyKey(keyText);

  return {
    key: keyText,
    level,
    x,
    y,
    z,
    pointCount: node.pointCount,
    pointDataOffset: node.pointDataOffset,
    pointDataLength: node.pointDataLength,
  };
}
