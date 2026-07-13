import { Copc } from 'copc';
import { createCopcGetter } from '../getter/createCopcGetter';
import { decodeCopcPointBuffer } from '../../wasm/copcDecoder';
import { readPointsFromBuffer } from './readPoint';
import type { CopcHierarchyNode } from '../types/copc';
import type { CopcPoint, CopcPointBuffer, CopcPointView } from '../types/copc';

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
  const buffer = await loadCopcPointBuffer(source, hierarchyNode);

  return readPointsFromBuffer(buffer);
}

export async function loadCopcPointBuffer(
  source: string,
  hierarchyNode: CopcHierarchyNode,
): Promise<CopcPointBuffer> {
  const view = await loadPointDataView(source, hierarchyNode);

  return decodeCopcPointBuffer(view);
}
