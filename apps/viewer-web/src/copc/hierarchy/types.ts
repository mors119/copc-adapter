export type CopcHierarchyNode = {
  key: string;
  level: number;
  x: number;
  y: number;
  z: number;
  pointCount: number;
  pointDataOffset: number;
  pointDataLength: number;
  children?: string[];
  /**
   * True only when the loader has proved that all direct child topology
   * relevant to the query is complete.
   */
  childrenComplete?: boolean;
};

export type CopcHierarchyBounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

/** Project-owned request for the hierarchy needed by one view update. */
export type CopcHierarchyQuery = {
  bounds: CopcHierarchyBounds;
  maxLevel?: number;
};

export type CopcHierarchyPage = {
  key: string;
  pageOffset: number;
  pageLength: number;
};

export type CopcHierarchySubtree = {
  nodes: CopcHierarchyNode[];
  pages: CopcHierarchyPage[];
};

export type CopcHierarchyTree = {
  nodes: CopcHierarchyNode[];
  pages: CopcHierarchyPage[];
};

export type CopcHierarchyDiagnostics = {
  pageRequests: number;
  pageCacheHits: number;
  hierarchyBytesFetched: number;
  loadedPageCount: number;
  loadedEntryCount: number;
};

export interface CopcHierarchySource {
  getRootHierarchyPage(): CopcHierarchyPage;
  loadHierarchyPage(page: CopcHierarchyPage): Promise<CopcHierarchySubtree>;
}

export class CopcHierarchyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CopcHierarchyError';
  }
}

export class CopcHierarchyPageError extends CopcHierarchyError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CopcHierarchyPageError';
  }
}

export class CopcHierarchyTraversalError extends CopcHierarchyError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CopcHierarchyTraversalError';
  }
}
