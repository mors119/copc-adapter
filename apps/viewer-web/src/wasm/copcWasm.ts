export type CopcWasmExports = {
  memory: WebAssembly.Memory;
  alloc_bytes(length: number): number;
  dealloc_bytes(pointer: number, length: number): void;
  alloc_f64(length: number): number;
  dealloc_f64(pointer: number, length: number): void;
  alloc_u16(length: number): number;
  dealloc_u16(pointer: number, length: number): void;
  alloc_u8(length: number): number;
  dealloc_u8(pointer: number, length: number): void;
  decode_xyz_to_interleaved(
    xPointer: number,
    yPointer: number,
    zPointer: number,
    count: number,
    outputPointer: number,
  ): number;
  parse_copc_header_json(pointer: number, length: number): number;
  parse_root_hierarchy_json(pointer: number, length: number): number;
  decode_copc_node_json(
    metadataPointer: number,
    metadataLength: number,
    chunkPointer: number,
    chunkLength: number,
    pointCount: number,
    requestedFields: number,
    coordinatesPointer: number,
    intensityPointer: number,
    classificationPointer: number,
    redPointer: number,
    greenPointer: number,
    bluePointer: number,
  ): number;
  free_parser_json(pointer: number): void;
};

let wasmPromise: Promise<CopcWasmExports> | undefined;

const bundledWasmUrl = new URL('./copc_wasm.wasm', import.meta.url);

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

async function loadWasmBinary(): Promise<Uint8Array> {
  if (isBrowser()) {
    const response = await fetch(bundledWasmUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch COPC WASM module: ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  const [{ readFile }, pathModule, urlModule] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
    import('node:url'),
  ]);
  const modulePath = pathModule.resolve(
    pathModule.dirname(urlModule.fileURLToPath(import.meta.url)),
    '../../../../target/wasm32-unknown-unknown/release/copc_wasm.wasm',
  );
  return new Uint8Array(await readFile(modulePath));
}

export async function loadCopcWasm(): Promise<CopcWasmExports> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const binary = await loadWasmBinary();
      const module = await WebAssembly.compile(binary as unknown as BufferSource);
      const instance = await WebAssembly.instantiate(module);
      return instance.exports as unknown as CopcWasmExports;
    })();
  }

  return wasmPromise;
}
