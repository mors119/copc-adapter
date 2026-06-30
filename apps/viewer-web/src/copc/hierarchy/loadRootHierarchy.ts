import { Copc, Getter, Key } from 'copc';
import { toCopcHierarchyNode } from '../adapters/hierarchyAdapter';
import type { CopcHierarchyNode } from '../types/copc';

export async function loadRootHierarchy(
  url: string,
): Promise<CopcHierarchyNode[]> {
  const getter = Getter.http(url);
  const copc = await Copc.create(getter);

  const rootPage = copc.info.rootHierarchyPage;
  const subtree = await Copc.loadHierarchyPage(getter, rootPage);

  console.log('Raw hierarchy subtree:', subtree);
  console.log('Hierarchy nodes:', subtree.nodes);
  console.log('Hierarchy pages:', subtree.pages);

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
