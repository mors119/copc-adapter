import {
  resolveCopcBackend,
  type CopcBackendSelection,
} from "../backend/selection";
import type {
  CopcBackendOpenOptions,
  CopcPointLoadOptions,
  CopcSource,
} from "../backend/types";
import { CopcBackendError, CopcLoadError, CopcSourceError } from "../errors";
import type { CopcHierarchySubtree } from "../hierarchy/types";
import type {
  CopcHierarchyNode,
  CopcHierarchyPage,
  CopcMetadata,
  CopcPointBuffer,
  CopcPointView,
  PreparedPointData,
} from "../types/copc";
import type { CopcPointFieldSelection } from "../points/fieldSelection";
import type { CopcPerformanceObserver } from "../performance";
import type { CopcWorkerDiagnostics } from "../backend/types";
import type { CopcInputSource } from "../range/types";
import {
  getCopcSourceIdentity,
  isBlobSource,
} from "../getter/createCopcGetter";

/**
 * Reusable project-owned context around an opened backend source.
 *
 * The wrapper preserves the existing context API while keeping backend-specific
 * state behind the CopcSource interface.
 */
export class CopcContext implements CopcSource {
  private readonly delegate: CopcSource;
  readonly preparedHeightOffsetMeters?: number;
  readonly loadPointDataBuffer?: (
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
    options?: CopcPointLoadOptions,
  ) => Promise<CopcPointBuffer>;
  readonly loadPreparedPointData?: (
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
    options?: CopcPointLoadOptions,
  ) => Promise<PreparedPointData>;
  readonly setPerformanceObserver?: (
    observer: CopcPerformanceObserver | undefined,
  ) => void;
  readonly cancelPendingPointJobs?: () => void;
  readonly getWorkerDiagnostics?: () => CopcWorkerDiagnostics | undefined;
  readonly destroy?: () => void;

  private constructor(delegate: CopcSource) {
    this.delegate = delegate;
    this.preparedHeightOffsetMeters = delegate.preparedHeightOffsetMeters;
    if (delegate.loadPointDataBuffer) {
      this.loadPointDataBuffer = delegate.loadPointDataBuffer.bind(delegate);
    }
    if (delegate.loadPreparedPointData) {
      this.loadPreparedPointData =
        delegate.loadPreparedPointData.bind(delegate);
    }
    if (delegate.setPerformanceObserver) {
      this.setPerformanceObserver =
        delegate.setPerformanceObserver.bind(delegate);
    }
    if (delegate.cancelPendingPointJobs) {
      this.cancelPendingPointJobs =
        delegate.cancelPendingPointJobs.bind(delegate);
    }
    if (delegate.getWorkerDiagnostics) {
      this.getWorkerDiagnostics = delegate.getWorkerDiagnostics.bind(delegate);
    }
    if (delegate.destroy) {
      this.destroy = delegate.destroy.bind(delegate);
    }
  }

  get source(): string {
    return this.delegate.source;
  }

  static async create(
    source: CopcInputSource,
    backend: CopcBackendSelection = "copc-js",
    options: CopcBackendOpenOptions = {},
  ): Promise<CopcContext> {
    try {
      return new CopcContext(
        await resolveCopcBackend(backend).open(source, options),
      );
    } catch (error: unknown) {
      if (error instanceof CopcBackendError && error.stage === "source") {
        throw new CopcSourceError(getCopcSourceIdentity(source), {
          cause: error,
        });
      }
      if (error instanceof CopcLoadError) {
        throw error;
      }

      throw new CopcSourceError(getCopcSourceIdentity(source), {
        cause: error,
      });
    }
  }

  getMetadata(): CopcMetadata {
    return this.delegate.getMetadata();
  }

  getRootHierarchyPage(): CopcHierarchyPage {
    return this.delegate.getRootHierarchyPage();
  }

  loadHierarchyPage(
    page: CopcHierarchyPage,
    options?: Parameters<CopcSource["loadHierarchyPage"]>[1],
  ): Promise<CopcHierarchySubtree> {
    return this.delegate.loadHierarchyPage(page, options);
  }

  loadPointDataView(
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
    options?: CopcPointLoadOptions,
  ): Promise<CopcPointView> {
    return this.delegate.loadPointDataView(node, fields, options);
  }
}

export type CopcContextInput = CopcInputSource | CopcSource;

/** Open a source using the selected backend. */
export async function createCopcContext(
  source: CopcInputSource,
  backend: CopcBackendSelection = "copc-js",
  options: CopcBackendOpenOptions = {},
): Promise<CopcContext> {
  return CopcContext.create(source, backend, options);
}

/** Resolve an input source to a context or reuse an already-open project source. */
export async function resolveCopcContext(
  input: CopcContextInput,
  backend: CopcBackendSelection = "copc-js",
): Promise<CopcSource> {
  if (
    typeof input === "string" ||
    isBlobSource(input) ||
    "readRange" in input
  ) {
    return createCopcContext(input as CopcInputSource, backend);
  }

  return input;
}
