import { Copc, Getter } from 'copc';
import { toCopcMetadata } from '../adapters/metadataAdapter';
import type { CopcMetadata } from '../types/copc';

export async function loadCopcMetadata(source: string): Promise<CopcMetadata> {
  const getter = Getter.create(source);
  const copc = await Copc.create(getter);

  return toCopcMetadata(copc);
}
