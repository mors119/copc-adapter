import type { CopcBackend } from './types';
import { copcJsBackend } from './copcJsBackend';
import { rustCopcBackend } from './rustCopcBackend';

export type CopcBackendName = 'copc-js' | 'rust';
export type CopcBackendSelection = CopcBackendName | CopcBackend;

export function resolveCopcBackend(
  selection: CopcBackendSelection = 'copc-js',
): CopcBackend {
  if (selection === 'copc-js') {
    return copcJsBackend;
  }

  if (selection === 'rust') {
    return rustCopcBackend;
  }

  return selection;
}

export function getCopcBackendName(
  selection: CopcBackendSelection | undefined,
): CopcBackendName | 'custom' {
  if (selection === undefined || selection === 'copc-js') {
    return 'copc-js';
  }

  return selection === 'rust' ? 'rust' : 'custom';
}
