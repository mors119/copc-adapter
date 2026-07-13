import { Copc } from 'copc';
import { toCopcMetadata } from '../adapters/metadataAdapter';
import { createCopcGetter } from '../getter/createCopcGetter';
import type { CopcMetadata } from '../types/copc';

export async function loadCopcMetadata(source: string): Promise<CopcMetadata> {
  const getter = createCopcGetter(source);
  const copc = await Copc.create(getter);

  return toCopcMetadata(copc);
}
