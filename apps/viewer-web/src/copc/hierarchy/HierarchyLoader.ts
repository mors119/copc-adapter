import {
  createHierarchyTree,
  finalizeHierarchyTree,
  mergeHierarchySubtree,
} from './HierarchyTree';
import type {
  CopcHierarchyPage,
  CopcHierarchySource,
  CopcHierarchyTree,
} from './types';
import {
  CopcHierarchyPageError,
  CopcHierarchyTraversalError,
} from './types';

type PageVisitState = 'visiting' | 'visited';

function createPageVisitKey(page: CopcHierarchyPage): string {
  return `${page.pageOffset}:${page.pageLength}`;
}

function assertPageIsValid(page: CopcHierarchyPage): void {
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

export class HierarchyLoader {
  private readonly source: CopcHierarchySource;
  private readonly pageStates = new Map<string, PageVisitState>();

  constructor(source: CopcHierarchySource) {
    this.source = source;
  }

  async load(): Promise<CopcHierarchyTree> {
    const tree = createHierarchyTree();

    await this.loadPage(this.source.getRootHierarchyPage(), tree);

    return finalizeHierarchyTree(tree);
  }

  private async loadPage(
    page: CopcHierarchyPage,
    tree: ReturnType<typeof createHierarchyTree>,
  ): Promise<void> {
    assertPageIsValid(page);

    const visitKey = createPageVisitKey(page);
    const state = this.pageStates.get(visitKey);

    if (state === 'visited') {
      return;
    }

    if (state === 'visiting') {
      throw new CopcHierarchyTraversalError(
        `Recursive hierarchy page reference detected for key: ${page.key}`,
      );
    }

    this.pageStates.set(visitKey, 'visiting');

    try {
      const subtree = await this.source.loadHierarchyPage(page);
      mergeHierarchySubtree(tree, subtree);

      for (const childPage of subtree.pages) {
        await this.loadPage(childPage, tree);
      }

      this.pageStates.set(visitKey, 'visited');
    } catch (error: unknown) {
      this.pageStates.delete(visitKey);

      if (
        error instanceof CopcHierarchyPageError ||
        error instanceof CopcHierarchyTraversalError
      ) {
        throw error;
      }

      throw new CopcHierarchyTraversalError(
        `Failed to load hierarchy page "${page.key}"`,
        { cause: error },
      );
    }
  }
}
