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
import {
  type CopcPointComponent,
  type CopcPointField,
  type CopcPointFieldSelection,
} from '../points/fieldSelection';
import type { CopcBackend, CopcSource } from './types';

const SOURCE_DIMENSIONS: Readonly<Record<CopcPointComponent, string>> = {
  x: 'X',
  y: 'Y',
  z: 'Z',
  intensity: 'Intensity',
  classification: 'Classification',
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
};

const FIELD_COMPONENTS: Readonly<Record<CopcPointField, readonly CopcPointComponent[]>> = {
  position: ['x', 'y', 'z'],
  intensity: ['intensity'],
  classification: ['classification'],
  rgb: ['red', 'green', 'blue'],
};

type SourcePointView = {
  pointCount: number;
  dimensions: Record<string, unknown>;
  getter(name: string): (index: number) => number;
};

export function toCopcPointView(
  view: SourcePointView,
  requestedFields: CopcPointFieldSelection,
): CopcPointView {
  const sourceDimensions = new Set(Object.keys(view.dimensions));
  const availableFields = new Set<CopcPointField>();
  const availableComponents = new Set<CopcPointComponent>();

  for (const field of requestedFields) {
    const components = FIELD_COMPONENTS[field];

    if (components.every((component) => sourceDimensions.has(SOURCE_DIMENSIONS[component]))) {
      availableFields.add(field);
      for (const component of components) {
        availableComponents.add(component);
      }
    }
  }

  return {
    pointCount: view.pointCount,
    availableFields,
    getter(component: CopcPointComponent): (index: number) => number {
      if (!availableComponents.has(component)) {
        throw new Error(`COPC point component is unavailable: ${component}`);
      }

      return view.getter(SOURCE_DIMENSIONS[component]);
    },
  };
}

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
    fields: CopcPointFieldSelection,
  ): Promise<CopcPointView> {
    const view = await Copc.loadPointDataView(
      this.getter,
      this.copc,
      hierarchyNode,
    );

    // copc.js currently exposes a complete point view. Keep the requested
    // fields enforced at this adapter boundary until a backend can skip LAZ
    // layers during decode.
    return toCopcPointView(view, fields);
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
