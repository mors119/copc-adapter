import {
  resolveCopcContext,
  type CopcContextInput,
} from '../context/createCopcContext';
import { HierarchyLoader } from './HierarchyLoader';
import type { CopcHierarchyNode } from '../types/copc';

export async function loadRootHierarchy(
  source: CopcContextInput,
): Promise<CopcHierarchyNode[]> {
  const context = await resolveCopcContext(source);
  const hierarchy = await new HierarchyLoader(context).load();

  return hierarchy.nodes;
}
