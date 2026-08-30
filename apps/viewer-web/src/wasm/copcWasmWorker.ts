import type { CopcWasmExports } from './copcWasm';

let wasmPromise: Promise<CopcWasmExports> | undefined;

/** Load the worker-local copy of the Rust/WASM module. */
export async function loadCopcWasmWorker(bundledWasmBinary: Uint8Array): Promise<CopcWasmExports> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const module = await WebAssembly.compile(bundledWasmBinary as unknown as BufferSource);
      const instance = await WebAssembly.instantiate(module);
      return instance.exports as unknown as CopcWasmExports;
    })();
  }
  return wasmPromise;
}
