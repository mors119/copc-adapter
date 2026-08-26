import {
  resolveCopcBackend,
  type CopcBackendSelection,
} from '../backend/selection';
import type { CopcSource } from '../backend/types';
import { CopcLoadError, CopcSourceError } from '../errors';
import type { CopcHierarchySubtree } from '../hierarchy/types';
import type {
  CopcHierarchyNode,
  CopcHierarchyPage,
  CopcMetadata,
  CopcPointBuffer,
  CopcPointView,
} from '../types/copc';
import type { CopcPointFieldSelection } from '../points/fieldSelection';

/**
 * Reusable project-owned context around an opened backend source.
 *
 * The wrapper preserves the existing context API while keeping backend-specific
 * state behind the CopcSource interface.
 */
export class CopcContext implements CopcSource {
  private readonly delegate: CopcSource;
  readonly loadPointDataBuffer?: (
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
  ) => Promise<CopcPointBuffer>;

  private constructor(delegate: CopcSource) {
    this.delegate = delegate;
    if (delegate.loadPointDataBuffer) {
      this.loadPointDataBuffer = delegate.loadPointDataBuffer.bind(delegate);
    }
  }

  get source(): string {
    return this.delegate.source;
  }

  static async create(
    source: string,
    backend: CopcBackendSelection = 'copc-js',
  ): Promise<CopcContext> {
    try {
      return new CopcContext(await resolveCopcBackend(backend).open(source));
    } catch (error: unknown) {
      if (error instanceof CopcLoadError) {
        throw error;
      }

      throw new CopcSourceError(source, { cause: error });
    }
  }

  getMetadata(): CopcMetadata {
    return this.delegate.getMetadata();
  }

  getRootHierarchyPage(): CopcHierarchyPage {
    return this.delegate.getRootHierarchyPage();
  }

  loadHierarchyPage(page: CopcHierarchyPage): Promise<CopcHierarchySubtree> {
    return this.delegate.loadHierarchyPage(page);
  }

  loadPointDataView(
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
  ): Promise<CopcPointView> {
    return this.delegate.loadPointDataView(node, fields);
  }
}

export type CopcContextInput = string | CopcSource;

/** Open a source using the selected backend. */
export async function createCopcContext(
  source: string,
  backend: CopcBackendSelection = 'copc-js',
): Promise<CopcContext> {
  return CopcContext.create(source, backend);
}

/** Resolve a URL to a context or reuse an already-open project source. */
export async function resolveCopcContext(
  input: CopcContextInput,
  backend: CopcBackendSelection = 'copc-js',
): Promise<CopcSource> {
  if (typeof input === 'string') {
    return createCopcContext(input, backend);
  }

  return input;
}
