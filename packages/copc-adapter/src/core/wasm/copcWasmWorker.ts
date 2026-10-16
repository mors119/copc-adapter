import type { CopcWasmExports } from './copcWasm';
import { instantiateCopcWasm } from './copcWasmImports';

let wasmPromise: Promise<CopcWasmExports> | undefined;

/** Load the worker-local copy of the Rust/WASM module. */
export async function loadCopcWasmWorker(bundledWasmBinary: Uint8Array): Promise<CopcWasmExports> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      return instantiateCopcWasm(bundledWasmBinary);
    })();
  }
  return wasmPromise;
}
