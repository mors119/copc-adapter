import {
  resolveCopcContext,
  type CopcContextInput,
} from '../context/createCopcContext';
import { decodeCopcPointBuffer } from '../../wasm/copcDecoder';
import { readPointsFromBuffer } from './readPoint';
import type { CopcHierarchyNode } from '../types/copc';
import type { CopcPoint, CopcPointBuffer, CopcPointView } from '../types/copc';

export async function loadPointDataView(
  source: CopcContextInput,
  hierarchyNode: CopcHierarchyNode,
): Promise<CopcPointView> {
  const context = await resolveCopcContext(source);

  return context.loadPointDataView(hierarchyNode);
}

export async function loadCopcPoints(
  source: CopcContextInput,
  hierarchyNode: CopcHierarchyNode,
): Promise<CopcPoint[]> {
  const buffer = await loadCopcPointBuffer(source, hierarchyNode);

  return readPointsFromBuffer(buffer);
}

export async function loadCopcPointBuffer(
  source: CopcContextInput,
  hierarchyNode: CopcHierarchyNode,
): Promise<CopcPointBuffer> {
  const view = await loadPointDataView(source, hierarchyNode);

  return decodeCopcPointBuffer(view);
}
