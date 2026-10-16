import type { CopcWasmExports } from './copcWasm';

/**
 * proj4rs ships optional wasm-bindgen exports alongside its pure Rust API.
 * The adapter calls the pure Rust CRS API through its own C ABI, so those
 * optional exports are never entered. Keep their generated placeholder imports
 * inert so both raw-WASM loaders can instantiate the module without introducing
 * a second wasm-bindgen runtime.
 */
type RawWasmImportSet = {
  imports: WebAssembly.Imports;
  setMemory(memory: WebAssembly.Memory): void;
};

export function rawWasmImports(module: WebAssembly.Module): RawWasmImportSet {
  const imports: WebAssembly.Imports = {};
  let memory: WebAssembly.Memory | undefined;
  const decoder = new TextDecoder();
  const readString = (pointer: number, length: number): string => {
    if (!memory) throw new Error('Raw WASM memory is not initialized');
    return decoder.decode(new Uint8Array(memory.buffer, pointer, length));
  };

  for (const imported of WebAssembly.Module.imports(module)) {
    if (imported.kind !== 'function') {
      throw new Error(`Unsupported raw WASM import kind: ${imported.kind}`);
    }
    const namespace = imports[imported.module] ?? {};
    if (imported.name.startsWith('__wbg_parseFloat_')) {
      namespace[imported.name] = (pointer: number, length: number) => (
        Number.parseFloat(readString(pointer, length))
      );
    } else if (imported.name.startsWith('__wbg_parseInt_')) {
      namespace[imported.name] = (pointer: number, length: number, radix: number) => (
        Number.parseInt(readString(pointer, length), radix)
      );
    } else if (imported.module === 'env' && imported.name === 'copc_now_ms') {
      namespace[imported.name] = () => globalThis.performance?.now() ?? Date.now();
    } else {
      namespace[imported.name] = () => 0;
    }
    imports[imported.module] = namespace;
  }
  return {
    imports,
    setMemory(value: WebAssembly.Memory) {
      memory = value;
    },
  };
}

export async function instantiateCopcWasm(binary: Uint8Array): Promise<CopcWasmExports> {
  const module = await WebAssembly.compile(binary as unknown as BufferSource);
  const rawImports = rawWasmImports(module);
  const instance = await WebAssembly.instantiate(module, rawImports.imports);
  const exports = instance.exports as unknown as CopcWasmExports;
  rawImports.setMemory(exports.memory);
  return exports;
}
