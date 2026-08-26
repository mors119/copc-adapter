import {
  resolveCopcContext,
  type CopcContextInput,
} from '../context/createCopcContext';
import type { CopcMetadata } from '../types/copc';
import { CopcMetadataError } from '../errors';
import {
  CopcMetadataValidationError,
  validateCopcMetadata,
} from './validateMetadata';

export async function loadCopcMetadata(
  source: CopcContextInput,
): Promise<CopcMetadata> {
  const context = await resolveCopcContext(source);

  try {
    const metadata = context.getMetadata();
    validateCopcMetadata(metadata);

    return metadata;
  } catch (error: unknown) {
    if (error instanceof CopcMetadataError) {
      throw error;
    }

    throw new CopcMetadataError(context.source, {
      cause: error,
      detail: error instanceof CopcMetadataValidationError
        ? error.message
        : undefined,
    });
  }
}
