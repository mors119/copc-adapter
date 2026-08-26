import {
  resolveCopcContext,
  type CopcContextInput,
} from '../context/createCopcContext';
import { wasmCopcPointDecoder } from '../../wasm/copcDecoder';
import { readPointsFromBuffer } from './readPoint';
import type { CopcHierarchyNode } from '../types/copc';
import type { CopcPoint, CopcPointBuffer, CopcPointView } from '../types/copc';
import type { CopcPointDecoder } from './types';
import { allCopcPointFields, type CopcPointFieldSelection } from './fieldSelection';

export async function loadPointDataView(
  source: CopcContextInput,
  hierarchyNode: CopcHierarchyNode,
  fields: CopcPointFieldSelection = allCopcPointFields(),
): Promise<CopcPointView> {
  const context = await resolveCopcContext(source);

  return context.loadPointDataView(hierarchyNode, fields);
}

export async function loadCopcPoints(
  source: CopcContextInput,
  hierarchyNode: CopcHierarchyNode,
  decoder: CopcPointDecoder = wasmCopcPointDecoder,
  fields: CopcPointFieldSelection = allCopcPointFields(),
): Promise<CopcPoint[]> {
  const buffer = await loadCopcPointBuffer(source, hierarchyNode, decoder, fields);

  return readPointsFromBuffer(buffer);
}

export async function loadCopcPointBuffer(
  source: CopcContextInput,
  hierarchyNode: CopcHierarchyNode,
  decoder: CopcPointDecoder = wasmCopcPointDecoder,
  fields: CopcPointFieldSelection = allCopcPointFields(),
): Promise<CopcPointBuffer> {
  const context = await resolveCopcContext(source);

  if (decoder === wasmCopcPointDecoder && context.loadPointDataBuffer) {
    return validateCopcPointBuffer(await context.loadPointDataBuffer(hierarchyNode, fields));
  }

  const view = await context.loadPointDataView(hierarchyNode, fields);

  return validateCopcPointBuffer(await decoder.decode(view));
}

/** Reject malformed buffers instead of letting renderers consume partial attributes. */
export function validateCopcPointBuffer(buffer: CopcPointBuffer): CopcPointBuffer {
  if (buffer.coordinates.length !== buffer.pointCount * 3) {
    throw new Error('COPC point buffer coordinates must contain three values per point');
  }

  for (const [name, values] of Object.entries(buffer.attributes ?? {})) {
    if (values && values.length !== buffer.pointCount) {
      throw new Error(`COPC point buffer attribute length mismatch: ${name}`);
    }
  }

  return buffer;
}
