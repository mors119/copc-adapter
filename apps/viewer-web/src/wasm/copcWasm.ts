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

/** Runtime or asset failure while loading the shared Rust/WASM module. */
export class CopcWasmError extends Error {
  readonly stage: 'fetch' | 'compile' | 'instantiate';

  constructor(
    stage: CopcWasmError['stage'],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CopcWasmError';
    this.stage = stage;
  }
}

let wasmPromise: Promise<CopcWasmExports> | undefined;

let bundledWasmUrlPromise: Promise<URL> | undefined;

async function getBundledWasmUrl(): Promise<URL> {
  if (!bundledWasmUrlPromise) {
    bundledWasmUrlPromise = import('./copc_wasm.wasm?url&no-inline').then(
      ({ default: assetUrl }) => new URL(assetUrl, import.meta.url),
    );
  }
  return bundledWasmUrlPromise;
}

let wasmBinaryPromise: Promise<Uint8Array> | undefined;

/** Load the package-owned Rust/WASM bytes without instantiating them. */
export async function getCopcWasmBinary(): Promise<Uint8Array> {
  if (!wasmBinaryPromise) wasmBinaryPromise = loadWasmBinary();
  return wasmBinaryPromise;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined'
    || (typeof self !== 'undefined' && typeof document === 'undefined');
}

async function loadWasmBinary(): Promise<Uint8Array> {
  if (isBrowser()) {
    let response: Response;
    try {
      response = await fetch(await getBundledWasmUrl());
    } catch (error: unknown) {
      throw new CopcWasmError('fetch', 'Failed to fetch the COPC Rust/WASM module', { cause: error });
    }

    if (!response.ok) {
      throw new CopcWasmError(
        'fetch',
        `Failed to fetch the COPC Rust/WASM module (HTTP ${response.status})`,
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  const [{ readFile }, pathModule, urlModule] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
    import('node:url'),
  ]);
  const modulePath = pathModule.resolve(
    urlModule.fileURLToPath(new URL('./copc_wasm.wasm?no-inline', import.meta.url)),
  );
  return new Uint8Array(await readFile(modulePath));
}

export async function loadCopcWasm(): Promise<CopcWasmExports> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      let binary: Uint8Array;
      try {
        binary = await getCopcWasmBinary();
      } catch (error: unknown) {
        if (error instanceof CopcWasmError) throw error;
        throw new CopcWasmError('fetch', 'Failed to load the COPC Rust/WASM module', { cause: error });
      }

      let module: WebAssembly.Module;
      try {
        module = await WebAssembly.compile(binary as unknown as BufferSource);
      } catch (error: unknown) {
        throw new CopcWasmError('compile', 'Failed to compile the COPC Rust/WASM module', { cause: error });
      }

      try {
        const instance = await WebAssembly.instantiate(module);
        return instance.exports as unknown as CopcWasmExports;
      } catch (error: unknown) {
        throw new CopcWasmError('instantiate', 'Failed to instantiate the COPC Rust/WASM module', { cause: error });
      }
    })();
  }

  return wasmPromise;
}
