import type {
  CopcHierarchyNode,
  CopcHierarchyPage,
  CopcHierarchySubtree,
  CopcHierarchyTree,
} from './types';
import {
  CopcHierarchyPageError,
  CopcHierarchyTraversalError,
} from './types';

type MutableHierarchyTree = {
  nodeMap: Map<string, CopcHierarchyNode>;
  pageMap: Map<string, CopcHierarchyPage>;
};

function getNodeChildKeys(
  node: CopcHierarchyNode,
  nodeMap: Map<string, CopcHierarchyNode>,
): string[] {
  const childKeys: string[] = [];

  for (let childIndex = 0; childIndex < 8; childIndex += 1) {
    const childKey = `${node.level + 1}-${(node.x * 2) + (childIndex & 1)}-${(node.y * 2) + ((childIndex >> 1) & 1)}-${(node.z * 2) + ((childIndex >> 2) & 1)}`;

    if (nodeMap.has(childKey)) {
      childKeys.push(childKey);
    }
  }

  return childKeys;
}

function assertPageShape(page: CopcHierarchyPage): void {
  if (
    !Number.isFinite(page.pageOffset) ||
    !Number.isFinite(page.pageLength) ||
    page.pageOffset < 0 ||
    page.pageLength <= 0
  ) {
    throw new CopcHierarchyPageError(
      `Invalid hierarchy page "${page.key}" (${page.pageOffset}, ${page.pageLength})`,
    );
  }
}

export function createHierarchyTree(): MutableHierarchyTree {
  return {
    nodeMap: new Map<string, CopcHierarchyNode>(),
    pageMap: new Map<string, CopcHierarchyPage>(),
  };
}

export function mergeHierarchySubtree(
  tree: MutableHierarchyTree,
  subtree: CopcHierarchySubtree,
): void {
  for (const page of subtree.pages) {
    assertPageShape(page);

    const existingPage = tree.pageMap.get(page.key);

    if (
      existingPage &&
      (
        existingPage.pageOffset !== page.pageOffset ||
        existingPage.pageLength !== page.pageLength
      )
    ) {
      throw new CopcHierarchyTraversalError(
        `Conflicting hierarchy page definition for key: ${page.key}`,
      );
    }

    tree.pageMap.set(page.key, page);
  }

  for (const node of subtree.nodes) {
    const existingNode = tree.nodeMap.get(node.key);

    if (
      existingNode &&
      (
        existingNode.pointCount !== node.pointCount ||
        existingNode.pointDataOffset !== node.pointDataOffset ||
        existingNode.pointDataLength !== node.pointDataLength
      )
    ) {
      throw new CopcHierarchyTraversalError(
        `Conflicting hierarchy node definition for key: ${node.key}`,
      );
    }

    tree.nodeMap.set(node.key, node);
  }
}

export function finalizeHierarchyTree(
  tree: MutableHierarchyTree,
): CopcHierarchyTree {
  const nodes = [...tree.nodeMap.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((node) => ({
      ...node,
      children: getNodeChildKeys(node, tree.nodeMap),
    }));
  const pages = [...tree.pageMap.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );

  return {
    nodes,
    pages,
  };
}
