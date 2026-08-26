import type { CopcHierarchySource } from '../hierarchy/types';
import type {
  CopcHierarchyNode,
  CopcMetadata,
  CopcPointView,
} from '../types/copc';
import type { CopcPointFieldSelection } from '../points/fieldSelection';

/** An opened COPC resource expressed only in project-owned types. */
export interface CopcSource extends CopcHierarchySource {
  readonly source: string;
  getMetadata(): CopcMetadata;
  loadPointDataView(
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
  ): Promise<CopcPointView>;
}

/** Opens COPC resources without exposing the library used to read them. */
export interface CopcBackend {
  open(source: string): Promise<CopcSource>;
}
