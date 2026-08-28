import type { CopcHierarchySource } from '../hierarchy/types';
import type {
  CopcHierarchyNode,
  CopcMetadata,
  CopcPointBuffer,
  CopcPointView,
} from '../types/copc';
import type { CopcPointFieldSelection } from '../points/fieldSelection';
import type { CopcPerformanceObserver } from '../performance';

/** An opened COPC resource expressed only in project-owned types. */
export interface CopcSource extends CopcHierarchySource {
  readonly source: string;
  getMetadata(): CopcMetadata;
  loadPointDataView(
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
  ): Promise<CopcPointView>;
  /** Optional direct buffer path for backends that already decode points. */
  loadPointDataBuffer?(
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
  ): Promise<CopcPointBuffer>;
  setPerformanceObserver?(observer: CopcPerformanceObserver | undefined): void;
  /** Drop queued decode work that cannot contribute to the current view. */
  cancelPendingPointJobs?(): void;
  /** Release source-owned worker/runtime resources. */
  destroy?(): void;
}

/** Opens COPC resources without exposing the library used to read them. */
export interface CopcBackend {
  open(source: string): Promise<CopcSource>;
}
