import { Copc } from 'copc';
import {
  toCopcHierarchyNode,
  toCopcHierarchyPage,
} from '../adapters/hierarchyAdapter';
import { toCopcMetadata } from '../adapters/metadataAdapter';
import { createCopcGetter } from '../getter/createCopcGetter';
import type { CopcHierarchySubtree } from '../hierarchy/types';
import type {
  CopcHierarchyNode,
  CopcHierarchyPage,
  CopcMetadata,
  CopcPointView,
} from '../types/copc';
import type { CopcBackend, CopcSource } from './types';

/** The production source adapter backed by copc.js. */
class CopcJsSource implements CopcSource {
  readonly source: string;
  private readonly getter: ReturnType<typeof createCopcGetter>;
  private readonly copc: Copc;

  constructor(
    source: string,
    getter: ReturnType<typeof createCopcGetter>,
    copc: Copc,
  ) {
    this.source = source;
    this.getter = getter;
    this.copc = copc;
  }

  getMetadata(): CopcMetadata {
    return toCopcMetadata(this.copc);
  }

  getRootHierarchyPage(): CopcHierarchyPage {
    return {
      key: '0-0-0-0',
      pageOffset: this.copc.info.rootHierarchyPage.pageOffset,
      pageLength: this.copc.info.rootHierarchyPage.pageLength,
    };
  }

  async loadHierarchyPage(
    page: CopcHierarchyPage,
  ): Promise<CopcHierarchySubtree> {
    const subtree = await Copc.loadHierarchyPage(this.getter, {
      pageOffset: page.pageOffset,
      pageLength: page.pageLength,
    });
    const nodes: CopcHierarchySubtree['nodes'] = [];
    const pages: CopcHierarchySubtree['pages'] = [];

    for (const [key, node] of Object.entries(subtree.nodes)) {
      if (node) {
        nodes.push(toCopcHierarchyNode(key, node));
      }
    }

    for (const [key, childPage] of Object.entries(subtree.pages)) {
      if (childPage) {
        pages.push(toCopcHierarchyPage(key, childPage));
      }
    }

    return { nodes, pages };
  }

  async loadPointDataView(
    hierarchyNode: CopcHierarchyNode,
  ): Promise<CopcPointView> {
    const view = await Copc.loadPointDataView(
      this.getter,
      this.copc,
      hierarchyNode,
    );

    return {
      pointCount: view.pointCount,
      dimensions: Object.keys(view.dimensions),
      getter: view.getter,
    };
  }
}

/** Opens COPC resources through copc.js. */
export class CopcJsBackend implements CopcBackend {
  async open(source: string): Promise<CopcSource> {
    const getter = createCopcGetter(source);
    const copc = await Copc.create(getter);

    return new CopcJsSource(source, getter, copc);
  }
}

/** Shared default backend used when callers do not provide one. */
export const copcJsBackend: CopcBackend = new CopcJsBackend();
