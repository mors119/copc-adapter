import { Copc } from 'copc';
import { toCopcHierarchyNode } from '../adapters/hierarchyAdapter';
import { createCopcGetter } from '../getter/createCopcGetter';
import type { CopcHierarchyNode } from '../types/copc';

export async function loadRootHierarchy(
  source: string,
): Promise<CopcHierarchyNode[]> {
  const getter = createCopcGetter(source);
  const copc = await Copc.create(getter);

  const rootPage = copc.info.rootHierarchyPage;
  const subtree = await Copc.loadHierarchyPage(getter, rootPage);

  const nodes: CopcHierarchyNode[] = [];

  for (const [key, node] of Object.entries(subtree.nodes)) {
    if (!node) {
      continue;
    }

    nodes.push(
      toCopcHierarchyNode(
        key,

        node,
      ),
    );
  }

  return nodes;
}
