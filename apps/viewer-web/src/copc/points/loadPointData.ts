import { Copc, Getter } from 'copc';
import type { CopcHierarchyNode } from '../types/copc';

export async function loadPointDataView(
  url: string,
  hierarchyNode: CopcHierarchyNode,
) {
  const getter = Getter.http(url);
  const copc = await Copc.create(getter);

  console.log('Selected hierarchy node:', hierarchyNode);

  const view = await Copc.loadPointDataView(getter, copc, hierarchyNode.raw);

  console.log('Raw point data view:', view);
  console.log('View keys:', Object.keys(view));
  console.log(view.getter);

  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');
  console.log(getX(0));
  console.log(getY(0));
  console.log(getZ(0));
  return view;
}
