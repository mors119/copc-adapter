import type { CopcPerformanceObserver } from "../performance";

/** One decoded COPC hierarchy entry and its point-data byte range. */
export type CopcHierarchyNode = {
  /** Stable octree path key used by caches and renderer node identity. */
  key: string;
  /** Octree depth, with the root at level zero. */
  level: number;
  /** Integer octree cell coordinate along X at `level`, not source XYZ. */
  x: number;
  /** Integer octree cell coordinate along Y at `level`, not source XYZ. */
  y: number;
  /** Integer octree cell coordinate along Z at `level`, not source XYZ. */
  z: number;
  /** Number of points encoded in this node's point-data chunk. */
  pointCount: number;
  /** Zero-based byte offset of the point-data chunk in the COPC resource. */
  pointDataOffset: number;
  /** Length of the point-data chunk in bytes. */
  pointDataLength: number;
  /** Known direct child node keys, when discovered. */
  children?: string[];
  /**
   * True only when the loader has proved that all direct child topology
   * relevant to the query is complete.
   */
  childrenComplete?: boolean;
};

/** Axis-aligned bounds in COPC source coordinates and CRS-defined units. */
export type CopcHierarchyBounds = {
  /** Minimum source X coordinate. */
  minX: number;
  /** Minimum source Y coordinate. */
  minY: number;
  /** Minimum source Z coordinate in the CRS vertical unit. */
  minZ: number;
  /** Maximum source X coordinate. */
  maxX: number;
  /** Maximum source Y coordinate. */
  maxY: number;
  /** Maximum source Z coordinate in the CRS vertical unit. */
  maxZ: number;
};

/** Bounds accepted by the shared hierarchy boundary, always in COPC XYZ. */
export type CopcProjectBounds = CopcHierarchyBounds & {
  coordinateSystem: "copc-source";
};

/**
 * Bounds accepted by the public hierarchy query contract.
 *
 * The coordinate label is optional only for compatibility with callers of
 * the pre-#134 API. New project-owned queries should use CopcProjectBounds.
 */
export type CopcHierarchyQueryBounds = CopcHierarchyBounds & {
  coordinateSystem?: "copc-source";
};

/** Project-owned request for the hierarchy needed by one view update. */
export type CopcHierarchyQuery = {
  /** Source-space extent to query; values use the COPC CRS axis units. */
  bounds: CopcHierarchyQueryBounds;
  /** Optional deepest hierarchy level to include. */
  maxLevel?: number;
};

/** Byte range and hierarchy key identifying one on-disk hierarchy page. */
export type CopcHierarchyPage = {
  /** Node key whose hierarchy page is stored in this range. */
  key: string;
  /** Zero-based byte offset of the page in the COPC resource. */
  pageOffset: number;
  /** Encoded page length in bytes. */
  pageLength: number;
};

/** Nodes and additional page references parsed from one hierarchy page. */
export type CopcHierarchySubtree = {
  /** Entries decoded from the page. */
  nodes: CopcHierarchyNode[];
  /** Child pages discovered while parsing those entries. */
  pages: CopcHierarchyPage[];
};

/** Per-request controls for fetching one hierarchy page. */
export type CopcHierarchyPageLoadOptions = {
  /** Cancels this page request without affecting other source requests. */
  signal?: AbortSignal;
  /**
   * Override the source-wide performance observer for this page read.
   * `null` suppresses reporting for the request; `undefined` uses the source observer.
   */
  performanceObserver?: CopcPerformanceObserver | null;
};

/** Fully traversed hierarchy result returned by the legacy tree loader. */
export type CopcHierarchyTree = {
  /** All hierarchy entries visited by the traversal. */
  nodes: CopcHierarchyNode[];
  /** All hierarchy pages discovered during traversal. */
  pages: CopcHierarchyPage[];
};

/** Request, cache, and elapsed-time counters for hierarchy loading and queries. */
export type CopcHierarchyDiagnostics = {
  /** Hierarchy page requests started. */
  pageRequests: number;
  /** Requests served from the page cache. */
  pageCacheHits: number;
  /** Bytes transferred for hierarchy pages. */
  hierarchyBytesFetched: number;
  /** Distinct pages currently retained as loaded. */
  loadedPageCount: number;
  /** Pages discovered through parsed references. */
  discoveredPageCount: number;
  /** Pages whose fetch and parse completed. */
  completedPageCount: number;
  /** Page fetches currently active. */
  activePageLoads: number;
  /** Highest simultaneous active page-load count. */
  peakActivePageLoads: number;
  /** Source-open elapsed time in milliseconds. */
  sourceOpenDurationMs: number;
  /** Metadata-read and parse elapsed time in milliseconds. */
  metadataLoadDurationMs: number;
  /** Root-hierarchy initialization elapsed time in milliseconds. */
  rootHierarchyLoadDurationMs: number;
  /** Elapsed time for the most recent spatial hierarchy query, in milliseconds. */
  lastQueryDurationMs: number;
  /** Number of hierarchy entries loaded into the current tree state. */
  loadedEntryCount: number;
};

/** Backend-neutral operations required by the hierarchy loader. */
export interface CopcHierarchySource {
  /** Return the root page reference already known from COPC metadata. */
  getRootHierarchyPage(): CopcHierarchyPage;
  /** Fetch and parse a page, returning entries and child page references. */
  loadHierarchyPage(
    page: CopcHierarchyPage,
    options?: CopcHierarchyPageLoadOptions,
  ): Promise<CopcHierarchySubtree>;
}

/** Base error for hierarchy page loading or traversal failures. */
export class CopcHierarchyError extends Error {
  /** Create an error and preserve an optional underlying cause. */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CopcHierarchyError";
  }
}

/** Error raised while fetching or parsing a hierarchy page. */
export class CopcHierarchyPageError extends CopcHierarchyError {
  /** Create a page error and preserve an optional underlying cause. */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CopcHierarchyPageError";
  }
}

/** Error raised while walking hierarchy page references. */
export class CopcHierarchyTraversalError extends CopcHierarchyError {
  /** Create a traversal error and preserve an optional underlying cause. */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CopcHierarchyTraversalError";
  }
}
