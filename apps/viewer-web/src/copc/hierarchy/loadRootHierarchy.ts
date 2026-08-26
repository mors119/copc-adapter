import {
  resolveCopcContext,
  type CopcContextInput,
} from '../context/createCopcContext';
import { HierarchyLoader } from './HierarchyLoader';
import type { CopcHierarchyNode } from '../types/copc';
import { CopcHierarchyLoadError } from '../errors';

export async function loadRootHierarchy(
  source: CopcContextInput,
): Promise<CopcHierarchyNode[]> {
  const context = await resolveCopcContext(source);

  try {
    const hierarchy = await new HierarchyLoader(context).load();

    return hierarchy.nodes;
  } catch (error: unknown) {
    if (error instanceof CopcHierarchyLoadError) {
      throw error;
    }

    throw new CopcHierarchyLoadError(context.source, { cause: error });
  }
}
