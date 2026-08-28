import {
  createHierarchyTree,
  finalizeHierarchyTree,
  mergeHierarchySubtree,
} from './HierarchyTree';
import type {
  CopcHierarchyBounds,
  CopcHierarchyDiagnostics,
  CopcHierarchyPage,
  CopcHierarchyQuery,
  CopcHierarchySource,
  CopcHierarchySubtree,
  CopcHierarchyTree,
} from './types';
import {
  CopcHierarchyError,
  CopcHierarchyPageError,
  CopcHierarchyTraversalError,
} from './types';
import { CopcLoadError } from '../errors';

type MutableHierarchyTree = ReturnType<typeof createHierarchyTree>;

const DEFAULT_CUBE_BOUNDS: CopcHierarchyBounds = {
  minX: 0,
  minY: 0,
  minZ: 0,
  maxX: 1,
  maxY: 1,
  maxZ: 1,
};

function createPageCacheKey(page: CopcHierarchyPage): string {
  return `${page.pageOffset}:${page.pageLength}`;
}

function assertPageIsValid(page: CopcHierarchyPage): void {
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

function assertBounds(bounds: CopcHierarchyBounds, name: string): void {
  const values = Object.values(bounds);
  if (
    values.some((value) => !Number.isFinite(value)) ||
    bounds.minX > bounds.maxX ||
    bounds.minY > bounds.maxY ||
    bounds.minZ > bounds.maxZ
  ) {
    throw new CopcHierarchyError(`Invalid ${name} bounds`);
  }
}

function assertQuery(query: CopcHierarchyQuery): void {
  assertBounds(query.bounds, 'hierarchy query');
  if (
    query.maxLevel !== undefined &&
    (!Number.isSafeInteger(query.maxLevel) || query.maxLevel < 0)
  ) {
    throw new CopcHierarchyError('Hierarchy query maxLevel must be a non-negative integer');
  }
}

function parseHierarchyKey(key: string): {
  level: number;
  x: number;
  y: number;
  z: number;
} {
  const values = key.split('-').map(Number);
  if (
    values.length !== 4 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new CopcHierarchyTraversalError(`Invalid hierarchy key: ${key}`);
  }

  const [level, x, y, z] = values;
  if (
    level > 31 ||
    x >= 2 ** level ||
    y >= 2 ** level ||
    z >= 2 ** level
  ) {
    throw new CopcHierarchyTraversalError(`Hierarchy key is outside its level: ${key}`);
  }

  return { level, x, y, z };
}

function intersects(left: CopcHierarchyBounds, right: CopcHierarchyBounds): boolean {
  return left.minX <= right.maxX && left.maxX >= right.minX
    && left.minY <= right.maxY && left.maxY >= right.minY
    && left.minZ <= right.maxZ && left.maxZ >= right.minZ;
}

function pageBounds(
  page: CopcHierarchyPage,
  cube: CopcHierarchyBounds,
): CopcHierarchyBounds {
  const { level, x, y, z } = parseHierarchyKey(page.key);
  const divisor = 2 ** level;
  const sideX = (cube.maxX - cube.minX) / divisor;
  const sideY = (cube.maxY - cube.minY) / divisor;
  const sideZ = (cube.maxZ - cube.minZ) / divisor;

  return {
    minX: cube.minX + x * sideX,
    minY: cube.minY + y * sideY,
    minZ: cube.minZ + z * sideZ,
    maxX: cube.minX + (x + 1) * sideX,
    maxY: cube.minY + (y + 1) * sideY,
    maxZ: cube.minZ + (z + 1) * sideZ,
  };
}

function assertNoPageCycles(pageChildren: Map<string, string[]>): void {
  const states = new Map<string, 'visiting' | 'visited'>();

  const visit = (key: string): void => {
    const state = states.get(key);
    if (state === 'visited') {
      return;
    }
    if (state === 'visiting') {
      throw new CopcHierarchyTraversalError(
        `Recursive hierarchy page reference detected for key: ${key}`,
      );
    }

    states.set(key, 'visiting');
    for (const childKey of pageChildren.get(key) ?? []) {
      visit(childKey);
    }
    states.set(key, 'visited');
  };

  for (const key of pageChildren.keys()) {
    visit(key);
  }
}

/**
 * Incremental hierarchy state for one opened source.
 *
 * The page cache is deliberately owned by this loader instance, so unrelated
 * layers/sources never share hierarchy bytes or page promises.
 */
export class HierarchyLoader {
  private readonly source: CopcHierarchySource;
  private readonly cubeBounds: CopcHierarchyBounds;
  private tree: MutableHierarchyTree = createHierarchyTree();
  private readonly pageCache = new Map<string, Promise<CopcHierarchySubtree>>();
  private readonly pageChildren = new Map<string, string[]>();
  private pageRequests = 0;
  private pageCacheHits = 0;
  private hierarchyBytesFetched = 0;

  constructor(
    source: CopcHierarchySource,
    cubeBounds: CopcHierarchyBounds = DEFAULT_CUBE_BOUNDS,
  ) {
    assertBounds(cubeBounds, 'COPC cube');
    this.source = source;
    this.cubeBounds = cubeBounds;
  }

  /** Compatibility path for callers that explicitly need a full traversal. */
  async load(): Promise<CopcHierarchyTree> {
    return this.query({ bounds: this.cubeBounds });
  }

  /** Load only the root page and retain its child page references. */
  async loadRoot(): Promise<CopcHierarchyTree> {
    await this.loadPage(this.source.getRootHierarchyPage());
    return finalizeHierarchyTree(this.tree);
  }

  /**
   * Load pages intersecting the requested project-coordinate bounds up to the
   * requested hierarchy level. Previously loaded pages are returned from the
   * per-loader cache and remain available for later view movement.
   */
  async query(query: CopcHierarchyQuery): Promise<CopcHierarchyTree> {
    assertQuery(query);
    await this.loadPage(this.source.getRootHierarchyPage());

    const pendingPages = [...this.tree.pageMap.values()];
    const considered = new Set<string>();
    for (let index = 0; index < pendingPages.length; index += 1) {
      const page = pendingPages[index];
      const cacheKey = createPageCacheKey(page);
      if (considered.has(cacheKey)) {
        continue;
      }
      considered.add(cacheKey);

      const { level } = parseHierarchyKey(page.key);
      if (
        (query.maxLevel !== undefined && level > query.maxLevel) ||
        !intersects(pageBounds(page, this.cubeBounds), query.bounds)
      ) {
        continue;
      }

      await this.loadPage(page);
      for (const discoveredPage of this.tree.pageMap.values()) {
        if (!considered.has(createPageCacheKey(discoveredPage))) {
          pendingPages.push(discoveredPage);
        }
      }
    }

    assertNoPageCycles(this.pageChildren);
    return finalizeHierarchyTree(this.tree, query.maxLevel);
  }

  getDiagnostics(): CopcHierarchyDiagnostics {
    return {
      pageRequests: this.pageRequests,
      pageCacheHits: this.pageCacheHits,
      hierarchyBytesFetched: this.hierarchyBytesFetched,
      loadedPageCount: this.pageCache.size,
      loadedEntryCount: this.tree.nodeMap.size + this.tree.pageMap.size,
    };
  }

  /** Clear hierarchy pages and diagnostics when a source is explicitly reused. */
  reset(): void {
    this.tree = createHierarchyTree();
    this.pageCache.clear();
    this.pageChildren.clear();
    this.pageRequests = 0;
    this.pageCacheHits = 0;
    this.hierarchyBytesFetched = 0;
  }

  private async loadPage(page: CopcHierarchyPage): Promise<CopcHierarchySubtree> {
    assertPageIsValid(page);
    const cacheKey = createPageCacheKey(page);
    const cached = this.pageCache.get(cacheKey);
    if (cached) {
      this.pageCacheHits += 1;
      return cached;
    }

    this.pageRequests += 1;
    this.hierarchyBytesFetched += page.pageLength;
    const request = this.source.loadHierarchyPage(page)
      .then((subtree) => {
        mergeHierarchySubtree(this.tree, subtree);
        this.pageChildren.set(page.key, subtree.pages.map((child) => child.key));
        return subtree;
      })
      .catch((error: unknown) => {
        this.pageCache.delete(cacheKey);
        if (
          error instanceof CopcHierarchyError ||
          error instanceof CopcLoadError
        ) {
          throw error;
        }
        throw new CopcHierarchyTraversalError(
          `Failed to load hierarchy page "${page.key}"`,
          { cause: error },
        );
      });
    this.pageCache.set(cacheKey, request);
    return request;
  }
}
