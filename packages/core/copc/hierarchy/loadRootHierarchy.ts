import {
  resolveCopcContext,
  type CopcContextInput,
} from "../context/createCopcContext";
import { HierarchyLoader } from "./HierarchyLoader";
import type { CopcHierarchyNode } from "../types/copc";
import { CopcHierarchyLoadError, CopcLoadError } from "../errors";

/**
 * Load and decode hierarchy pages across the full COPC cube from an existing
 * or URL-backed source.
 *
 * @param source Source context, source instance, or URL accepted by the context resolver.
 * @returns Hierarchy nodes after metadata loading and a full-cube hierarchy traversal.
 * @throws `CopcLoadError` when the source cannot be opened.
 * @throws `CopcHierarchyLoadError` when a traversed hierarchy page cannot be loaded or decoded.
 */
export async function loadRootHierarchy(
  source: CopcContextInput,
): Promise<CopcHierarchyNode[]> {
  const context = await resolveCopcContext(source);

  try {
    const hierarchy = await new HierarchyLoader(context).load();

    return hierarchy.nodes;
  } catch (error: unknown) {
    if (
      error instanceof CopcHierarchyLoadError ||
      error instanceof CopcLoadError
    ) {
      throw error;
    }

    throw new CopcHierarchyLoadError(context.source, { cause: error });
  }
}
