import { Copc } from 'copc';
import { createCopcGetter } from '../getter/createCopcGetter';
import { readAllPoints } from './readPoint';
import type { CopcHierarchyNode } from '../types/copc';
import type { CopcPoint, CopcPointView } from '../types/copc';

export async function loadPointDataView(
  source: string,
  hierarchyNode: CopcHierarchyNode,
): Promise<CopcPointView> {
  const getter = createCopcGetter(source);
  const copc = await Copc.create(getter);
  const view = await Copc.loadPointDataView(getter, copc, hierarchyNode);

  return {
    pointCount: view.pointCount,
    getter: view.getter,
  };
}

export async function loadCopcPoints(
  source: string,
  hierarchyNode: CopcHierarchyNode,
): Promise<CopcPoint[]> {
  const view = await loadPointDataView(source, hierarchyNode);

  return readAllPoints(view);
}
