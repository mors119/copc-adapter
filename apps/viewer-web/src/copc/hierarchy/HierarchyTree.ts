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

function getParentKey(key: string): string | undefined {
  const [level, x, y, z] = key.split('-').map(Number);
  if (!Number.isSafeInteger(level) || level <= 0
    || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !Number.isSafeInteger(z)) {
    return undefined;
  }

  return `${level - 1}-${Math.floor(x / 2)}-${Math.floor(y / 2)}-${Math.floor(z / 2)}`;
}

function assertPageShape(page: CopcHierarchyPage): void {
  if (
    !Number.isSafeInteger(page.pageOffset) ||
    !Number.isSafeInteger(page.pageLength) ||
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
  maxLevel?: number,
  loadedPageKeys: ReadonlySet<string> = new Set(),
): CopcHierarchyTree {
  // A page reference is keyed by the first node in the referenced subtree.
  // Track only references that were actually discovered; absent octants are
  // valid sparse COPC topology and do not make a node incomplete.
  const incompleteParentKeys = new Set(
    [...tree.pageMap.keys()]
      .filter((pageKey) => !loadedPageKeys.has(pageKey))
      .map(getParentKey)
      .filter((parentKey): parentKey is string => parentKey !== undefined),
  );
  const nodes = [...tree.nodeMap.values()]
    .filter((node) => maxLevel === undefined || node.level <= maxLevel)
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((node) => {
      const children = getNodeChildKeys(node, tree.nodeMap);
      const childrenComplete = !incompleteParentKeys.has(node.key);

      return { ...node, children, childrenComplete };
    });
  const pages = [...tree.pageMap.values()].sort((left, right) =>
    left.key.localeCompare(right.key),
  );

  return {
    nodes,
    pages,
  };
}
