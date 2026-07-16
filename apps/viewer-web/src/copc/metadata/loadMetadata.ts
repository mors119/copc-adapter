import {
  resolveCopcContext,
  type CopcContextInput,
} from '../context/createCopcContext';
import type { CopcMetadata } from '../types/copc';

export async function loadCopcMetadata(
  source: CopcContextInput,
): Promise<CopcMetadata> {
  const context = await resolveCopcContext(source);

  return context.getMetadata();
}
