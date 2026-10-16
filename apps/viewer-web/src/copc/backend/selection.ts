import type { CopcBackend } from './types';
import { copcJsBackend } from './copcJsBackend';
import { rustCopcBackend } from './rustCopcBackend';

/** Built-in COPC decoding backend identifiers. */
export type CopcBackendName =
  /** The JavaScript COPC backend; this is the default selection. */
  | 'copc-js'
  /** The opt-in Rust/WASM backend. Errors are surfaced without backend fallback. */
  | 'rust';

/** Select a built-in backend by name or supply a project-compatible backend. */
export type CopcBackendSelection = CopcBackendName | CopcBackend;

/** Resolve a name or custom backend object to the backend used for a source. */
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

/** Return the diagnostic name for a backend selection without opening it. */
export function getCopcBackendName(
  selection: CopcBackendSelection | undefined,
): CopcBackendName | 'custom' {
  if (selection === undefined || selection === 'copc-js') {
    return 'copc-js';
  }

  return selection === 'rust' ? 'rust' : 'custom';
}
