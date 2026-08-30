import type {
  CopcHierarchyBounds,
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

function intersects(left: CopcHierarchyBounds, right: CopcHierarchyBounds): boolean {
  return left.minX <= right.maxX && left.maxX >= right.minX
    && left.minY <= right.maxY && left.maxY >= right.minY
    && left.minZ <= right.maxZ && left.maxZ >= right.minZ;
}

function getPageBounds(
  pageKey: string,
  cubeBounds: CopcHierarchyBounds,
): CopcHierarchyBounds | undefined {
  const values = pageKey.split('-').map(Number);
  if (
    values.length !== 4
    || values.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    return undefined;
  }

  const [level, x, y, z] = values;
  if (level > 31 || x >= 2 ** level || y >= 2 ** level || z >= 2 ** level) {
    return undefined;
  }

  const divisor = 2 ** level;
  const sideX = (cubeBounds.maxX - cubeBounds.minX) / divisor;
  const sideY = (cubeBounds.maxY - cubeBounds.minY) / divisor;
  const sideZ = (cubeBounds.maxZ - cubeBounds.minZ) / divisor;

  return {
    minX: cubeBounds.minX + x * sideX,
    minY: cubeBounds.minY + y * sideY,
    minZ: cubeBounds.minZ + z * sideZ,
    maxX: cubeBounds.minX + (x + 1) * sideX,
    maxY: cubeBounds.minY + (y + 1) * sideY,
    maxZ: cubeBounds.minZ + (z + 1) * sideZ,
  };
}

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
  completenessBounds?: CopcHierarchyBounds,
  cubeBounds?: CopcHierarchyBounds,
): CopcHierarchyTree {
  // A page reference is keyed by the first node in the referenced subtree.
  // Track only references that were actually discovered; absent octants are
  // valid sparse COPC topology and do not make a node incomplete. For a
  // bounded query, an unloaded page outside the query cannot contribute to
  // the replacement frontier and therefore must not block refinement.
  const incompleteParentKeys = new Set(
    [...tree.pageMap.keys()]
      .filter((pageKey) => !loadedPageKeys.has(pageKey))
      .filter((pageKey) => {
        if (!completenessBounds || !cubeBounds) {
          return true;
        }

        const bounds = getPageBounds(pageKey, cubeBounds);
        // Invalid page keys remain blocking; the loader will report them when
        // it traverses the page, and an invalid reference must not be treated
        // as safely outside the current query.
        return !bounds || intersects(bounds, completenessBounds);
      })
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
