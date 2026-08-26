import { copcJsBackend } from '../backend/copcJsBackend';
import type { CopcBackend, CopcSource } from '../backend/types';
import { CopcSourceError } from '../errors';
import type { CopcHierarchySubtree } from '../hierarchy/types';
import type {
  CopcHierarchyNode,
  CopcHierarchyPage,
  CopcMetadata,
  CopcPointView,
} from '../types/copc';

/**
 * Reusable project-owned context around an opened backend source.
 *
 * The wrapper preserves the existing context API while keeping backend-specific
 * state behind the CopcSource interface.
 */
export class CopcContext implements CopcSource {
  private readonly delegate: CopcSource;

  private constructor(delegate: CopcSource) {
    this.delegate = delegate;
  }

  get source(): string {
    return this.delegate.source;
  }

  static async create(
    source: string,
    backend: CopcBackend = copcJsBackend,
  ): Promise<CopcContext> {
    try {
      return new CopcContext(await backend.open(source));
    } catch (error: unknown) {
      if (error instanceof CopcSourceError) {
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

  loadPointDataView(node: CopcHierarchyNode): Promise<CopcPointView> {
    return this.delegate.loadPointDataView(node);
  }
}

export type CopcContextInput = string | CopcSource;

/** Open a source using the selected backend. */
export async function createCopcContext(
  source: string,
  backend: CopcBackend = copcJsBackend,
): Promise<CopcContext> {
  return CopcContext.create(source, backend);
}

/** Resolve a URL to a context or reuse an already-open project source. */
export async function resolveCopcContext(
  input: CopcContextInput,
  backend: CopcBackend = copcJsBackend,
): Promise<CopcSource> {
  if (typeof input === 'string') {
    return createCopcContext(input, backend);
  }

  return input;
}
