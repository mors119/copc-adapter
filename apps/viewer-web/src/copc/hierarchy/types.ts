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
