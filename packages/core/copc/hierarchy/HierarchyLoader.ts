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
import { performanceNow } from '../performance';

type MutableHierarchyTree = ReturnType<typeof createHierarchyTree>;

const DEFAULT_CUBE_BOUNDS: CopcHierarchyBounds = {
  minX: 0,
  minY: 0,
  minZ: 0,
  maxX: 1,
  maxY: 1,
  maxZ: 1,
};

const DEFAULT_MAX_CONCURRENT_PAGE_LOADS = 4;

type HierarchyLoaderOptions = {
  /** Internal scheduler override used by deterministic hierarchy benchmarks. */
  maxConcurrentPageLoads?: number;
  sourceOpenDurationMs?: number;
  metadataLoadDurationMs?: number;
};

/** Internal controls for a conservative future-view hierarchy query. */
export type HierarchyQueryOptions = {
  /** Maximum relevant child pages visited; omitted for an ordinary current-view query. */
  maxPages?: number;
  /** Stops expanding a stale speculative traversal after its active page reads settle. */
  signal?: AbortSignal;
  /** Reports relevant page visits and whether the page was already cached. */
  onPageVisited?: (cached: boolean) => void;
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
  const values = [
    bounds.minX,
    bounds.minY,
    bounds.minZ,
    bounds.maxX,
    bounds.maxY,
    bounds.maxZ,
  ];
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
  // The optional runtime check keeps JavaScript callers from accidentally
  // sending a geographic or renderer-local envelope to the source-space
  // hierarchy traversal. Missing labels remain accepted for old callers.
  if (
    'coordinateSystem' in query.bounds
    && query.bounds.coordinateSystem !== 'copc-source'
  ) {
    throw new CopcHierarchyError(
      'Hierarchy query bounds must use the copc-source coordinate system',
    );
  }
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
  private readonly maxConcurrentPageLoads: number;
  private tree: MutableHierarchyTree = createHierarchyTree();
  private readonly pageCache = new Map<string, Promise<CopcHierarchySubtree>>();
  private readonly pageChildren = new Map<string, string[]>();
  private readonly loadedPageKeys = new Set<string>();
  private readonly pendingPageLoadSlots: Array<() => void> = [];
  private activePageLoads = 0;
  private peakActivePageLoads = 0;
  private pageRequests = 0;
  private pageCacheHits = 0;
  private hierarchyBytesFetched = 0;
  private readonly sourceOpenDurationMs: number;
  private readonly metadataLoadDurationMs: number;
  private rootHierarchyLoadDurationMs = 0;
  private lastQueryDurationMs = 0;
  private cacheGeneration = 0;

  constructor(
    source: CopcHierarchySource,
    cubeBounds: CopcHierarchyBounds = DEFAULT_CUBE_BOUNDS,
    options: HierarchyLoaderOptions = {},
  ) {
    assertBounds(cubeBounds, 'COPC cube');
    const maxConcurrentPageLoads = options.maxConcurrentPageLoads
      ?? DEFAULT_MAX_CONCURRENT_PAGE_LOADS;
    if (!Number.isSafeInteger(maxConcurrentPageLoads) || maxConcurrentPageLoads < 1) {
      throw new CopcHierarchyError('Hierarchy page concurrency must be a positive safe integer');
    }
    this.source = source;
    this.cubeBounds = cubeBounds;
    this.maxConcurrentPageLoads = maxConcurrentPageLoads;
    this.sourceOpenDurationMs = options.sourceOpenDurationMs ?? 0;
    this.metadataLoadDurationMs = options.metadataLoadDurationMs ?? 0;
  }

  /** Compatibility path for callers that explicitly need a full traversal. */
  async load(): Promise<CopcHierarchyTree> {
    return this.query({
      bounds: {
        ...this.cubeBounds,
        coordinateSystem: 'copc-source',
      },
    });
  }

  /** Load only the root page and retain its child page references. */
  async loadRoot(): Promise<CopcHierarchyTree> {
    const startedAt = performanceNow();
    const generation = this.cacheGeneration;
    try {
      await this.loadPage(this.source.getRootHierarchyPage());
    } finally {
      if (generation === this.cacheGeneration) {
        this.rootHierarchyLoadDurationMs = Math.max(0, performanceNow() - startedAt);
      }
    }
    this.assertCurrentGeneration(generation);
    return finalizeHierarchyTree(this.tree, undefined, this.loadedPageKeys);
  }

  /**
   * Load pages intersecting the requested project-coordinate bounds up to the
   * requested hierarchy level. Previously loaded pages are returned from the
   * per-loader cache and remain available for later view movement.
   */
  async query(
    query: CopcHierarchyQuery,
    options: HierarchyQueryOptions = {},
  ): Promise<CopcHierarchyTree> {
    const startedAt = performanceNow();
    const generation = this.cacheGeneration;
    try {
      assertQuery(query);
      if (options.maxPages !== undefined
        && (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1)) {
        throw new CopcHierarchyError('Hierarchy query maxPages must be a positive safe integer');
      }
      await this.loadPage(this.source.getRootHierarchyPage());
      this.assertCurrentGeneration(generation);

      const pendingPages = [...this.tree.pageMap.values()];
      const considered = new Set<string>();
      let nextPageIndex = 0;
      let inFlightPages = 0;
      let visitedPageCount = 0;
      let failed = false;
      let failure: unknown;
      const waitingWorkers = new Set<() => void>();

      const wakeWaitingWorkers = (): void => {
        const workers = [...waitingWorkers];
        waitingWorkers.clear();
        for (const wake of workers) {
          wake();
        }
      };

      const worker = async (): Promise<void> => {
        while (true) {
          if (failed || options.signal?.aborted) {
            return;
          }
          const page = pendingPages[nextPageIndex];
          if (!page) {
            if (inFlightPages === 0) {
              return;
            }
            await new Promise<void>((resolve) => {
              waitingWorkers.add(resolve);
            });
            continue;
          }
          nextPageIndex += 1;
          inFlightPages += 1;

          const cacheKey = createPageCacheKey(page);
          if (considered.has(cacheKey)) {
            inFlightPages -= 1;
            wakeWaitingWorkers();
            continue;
          }
          considered.add(cacheKey);

          try {
            const { level } = parseHierarchyKey(page.key);
            if (
              (query.maxLevel !== undefined && level > query.maxLevel) ||
              !intersects(pageBounds(page, this.cubeBounds), query.bounds)
            ) {
              continue;
            }

            if (options.maxPages !== undefined
              && visitedPageCount >= options.maxPages) {
              continue;
            }
            visitedPageCount += 1;
            options.onPageVisited?.(this.pageCache.has(cacheKey));
            if (options.signal?.aborted) {
              continue;
            }

            await this.loadPage(page);
            this.assertCurrentGeneration(generation);
            if (options.signal?.aborted) {
              continue;
            }
            for (const discoveredPage of this.tree.pageMap.values()) {
              if (!considered.has(createPageCacheKey(discoveredPage))) {
                pendingPages.push(discoveredPage);
              }
            }
          } catch (error: unknown) {
            if (!failed) {
              failed = true;
              failure = error;
            }
          } finally {
            inFlightPages -= 1;
            wakeWaitingWorkers();
          }
        }
      };

      const workerCount = Math.min(
        this.maxConcurrentPageLoads,
        options.maxPages ?? Number.POSITIVE_INFINITY,
        Math.max(1, pendingPages.length),
      );
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      if (failed) {
        throw failure;
      }
      if (options.signal?.aborted) {
        const error = new Error('Hierarchy query was cancelled', { cause: options.signal.reason });
        error.name = 'AbortError';
        throw error;
      }

      this.assertCurrentGeneration(generation);
      assertNoPageCycles(this.pageChildren);
      return finalizeHierarchyTree(
        this.tree,
        query.maxLevel,
        this.loadedPageKeys,
        query.bounds,
        this.cubeBounds,
      );
    } finally {
      if (generation === this.cacheGeneration) {
        this.lastQueryDurationMs = Math.max(0, performanceNow() - startedAt);
      }
    }
  }

  getDiagnostics(): CopcHierarchyDiagnostics {
    return {
      pageRequests: this.pageRequests,
      pageCacheHits: this.pageCacheHits,
      hierarchyBytesFetched: this.hierarchyBytesFetched,
      loadedPageCount: this.pageCache.size,
      discoveredPageCount: this.tree.pageMap.size + Number(this.loadedPageKeys.size > 0),
      completedPageCount: this.loadedPageKeys.size,
      activePageLoads: this.activePageLoads,
      peakActivePageLoads: this.peakActivePageLoads,
      sourceOpenDurationMs: this.sourceOpenDurationMs,
      metadataLoadDurationMs: this.metadataLoadDurationMs,
      rootHierarchyLoadDurationMs: this.rootHierarchyLoadDurationMs,
      lastQueryDurationMs: this.lastQueryDurationMs,
      loadedEntryCount: this.tree.nodeMap.size + this.tree.pageMap.size,
    };
  }

  /** Clear hierarchy pages and diagnostics when a source is explicitly reused. */
  reset(): void {
    this.cacheGeneration += 1;
    this.tree = createHierarchyTree();
    this.pageCache.clear();
    this.pageChildren.clear();
    this.loadedPageKeys.clear();
    this.pageRequests = 0;
    this.pageCacheHits = 0;
    this.hierarchyBytesFetched = 0;
    this.rootHierarchyLoadDurationMs = 0;
    this.lastQueryDurationMs = 0;
    this.peakActivePageLoads = this.activePageLoads;
  }

  private async loadPage(page: CopcHierarchyPage): Promise<CopcHierarchySubtree> {
    assertPageIsValid(page);
    const cacheKey = createPageCacheKey(page);
    const generation = this.cacheGeneration;
    const cached = this.pageCache.get(cacheKey);
    if (cached) {
      this.pageCacheHits += 1;
      const subtree = await cached;
      if (generation === this.cacheGeneration) {
        this.loadedPageKeys.add(page.key);
      }
      return subtree;
    }

    this.pageRequests += 1;
    this.hierarchyBytesFetched += page.pageLength;
    const request = this.withPageLoadSlot(
      generation,
      () => this.source.loadHierarchyPage(page),
    )
      .then((subtree) => {
        if (generation !== this.cacheGeneration) {
          return subtree;
        }
        mergeHierarchySubtree(this.tree, subtree);
        this.loadedPageKeys.add(page.key);
        this.pageChildren.set(page.key, subtree.pages.map((child) => child.key));
        return subtree;
      })
      .catch((error: unknown) => {
        if (this.pageCache.get(cacheKey) === request) {
          this.pageCache.delete(cacheKey);
        }
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

  private async withPageLoadSlot<T>(
    generation: number,
    load: () => Promise<T>,
  ): Promise<T> {
    if (this.activePageLoads >= this.maxConcurrentPageLoads) {
      await new Promise<void>((resolve) => {
        this.pendingPageLoadSlots.push(resolve);
      });
    } else {
      this.activePageLoads += 1;
      this.peakActivePageLoads = Math.max(
        this.peakActivePageLoads,
        this.activePageLoads,
      );
    }

    try {
      this.assertCurrentGeneration(generation);
      return await load();
    } finally {
      const next = this.pendingPageLoadSlots.shift();
      if (next) {
        next();
      } else {
        this.activePageLoads -= 1;
      }
    }
  }

  private assertCurrentGeneration(generation: number): void {
    if (generation !== this.cacheGeneration) {
      throw new CopcHierarchyTraversalError('Hierarchy loader was reset during a query');
    }
  }
}
