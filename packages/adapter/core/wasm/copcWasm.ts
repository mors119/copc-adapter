import { rawWasmImports } from "./copcWasmImports";

/**
 * TypeScript view of the package's Rust/WASM C-compatible exports.
 *
 * Pointer arguments are offsets in `memory`; JSON-returning functions return
 * an owned response pointer that callers release with `free_parser_json`.
 * The declarations mirror the bundled binary and are internal to the adapter.
 */
export type CopcWasmExports = {
  /** WebAssembly linear memory shared by exported parser and transform calls. */
  memory: WebAssembly.Memory;
  /** Allocate `length` bytes in WASM memory; returns a byte pointer. */
  alloc_bytes(length: number): number;
  /** Free a byte allocation created by `alloc_bytes`. */
  dealloc_bytes(pointer: number, length: number): void;
  /** Allocate `length` f64 values; returns a byte pointer. */
  alloc_f64(length: number): number;
  /** Free an f64 allocation created by `alloc_f64`. */
  dealloc_f64(pointer: number, length: number): void;
  /** Allocate `length` u16 values; returns a byte pointer. */
  alloc_u16(length: number): number;
  /** Free a u16 allocation created by `alloc_u16`. */
  dealloc_u16(pointer: number, length: number): void;
  /** Allocate `length` u8 values; returns a byte pointer. */
  alloc_u8(length: number): number;
  /** Free a u8 allocation created by `alloc_u8`. */
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
  parse_root_hierarchy_with_limit_json(
    pointer: number,
    length: number,
    maxPageBytes: number,
  ): number;
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
  decode_copc_node_with_limit_json(
    metadataPointer: number,
    metadataLength: number,
    chunkPointer: number,
    chunkLength: number,
    pointCount: number,
    requestedFields: number,
    maxChunkBytes: number,
    coordinatesPointer: number,
    intensityPointer: number,
    classificationPointer: number,
    redPointer: number,
    greenPointer: number,
    bluePointer: number,
  ): number;
  create_crs_transform_json(pointer: number, length: number): number;
  create_crs_transform_with_height_offset_json(
    pointer: number,
    length: number,
    heightOffsetMeters: number,
  ): number;
  create_geographic_crs_transform_json(): number;
  create_geographic_crs_transform_with_height_offset_json(
    heightOffsetMeters: number,
  ): number;
  transform_crs_points_json(
    handle: number,
    inputPointer: number,
    inputLength: number,
    geographicPointer: number,
    ecefPointer: number,
  ): number;
  free_crs_transform(handle: number): void;
  create_copc_node_preparer_json(pointer: number, length: number): number;
  create_copc_node_preparer_with_limit_json(
    pointer: number,
    length: number,
    maxChunkBytes: number,
  ): number;
  create_copc_node_preparer_with_limit_and_height_offset_json(
    pointer: number,
    length: number,
    maxChunkBytes: number,
    heightOffsetMeters: number,
  ): number;
  prepare_copc_node_json(
    handle: number,
    chunkPointer: number,
    chunkLength: number,
    pointCount: number,
    requestedFields: number,
    sourcePointer: number,
    geographicPointer: number,
    ecefPointer: number,
    intensityPointer: number,
    classificationPointer: number,
    redPointer: number,
    greenPointer: number,
    bluePointer: number,
  ): number;
  free_copc_node_preparer(handle: number): void;
  free_parser_json(pointer: number): void;
};

/** Runtime or asset failure while loading the shared Rust/WASM module. */
export class CopcWasmError extends Error {
  /** Asset-fetch, compilation, or module-instantiation stage that failed. */
  readonly stage: /** Fetching the packaged WASM asset failed. */
    | "fetch"
    | /** WebAssembly compilation failed. */ "compile"
    | /** Required exports or runtime imports could not be initialized. */ "instantiate";

  constructor(
    stage: CopcWasmError["stage"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CopcWasmError";
    this.stage = stage;
  }
}

let wasmPromise: Promise<CopcWasmExports> | undefined;

let bundledWasmUrlPromise: Promise<URL> | undefined;

async function getBundledWasmUrl(): Promise<URL> {
  if (!bundledWasmUrlPromise) {
    bundledWasmUrlPromise =
      import("./copc_adapter_wasm.wasm?url&no-inline").then(
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
  return (
    typeof window !== "undefined" ||
    (typeof self !== "undefined" && typeof document === "undefined")
  );
}

async function loadWasmBinary(): Promise<Uint8Array> {
  if (isBrowser()) {
    let response: Response;
    try {
      response = await fetch(await getBundledWasmUrl());
    } catch (error: unknown) {
      throw new CopcWasmError(
        "fetch",
        "Failed to fetch the COPC Rust/WASM module",
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new CopcWasmError(
        "fetch",
        `Failed to fetch the COPC Rust/WASM module (HTTP ${response.status})`,
      );
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  const [{ readFile }, pathModule, urlModule] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("node:url"),
  ]);
  const modulePath = pathModule.resolve(
    urlModule.fileURLToPath(
      new URL("./copc_adapter_wasm.wasm?no-inline", import.meta.url),
    ),
  );
  return new Uint8Array(await readFile(modulePath));
}

/**
 * Compile and instantiate the package-owned Rust/WASM module once per thread.
 *
 * Concurrent callers share the same initialization promise.
 *
 * @returns The instantiated module's typed export table.
 * @throws `CopcWasmError` with the fetch, compile, or instantiate stage and original cause.
 */
export async function loadCopcWasm(): Promise<CopcWasmExports> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      let binary: Uint8Array;
      try {
        binary = await getCopcWasmBinary();
      } catch (error: unknown) {
        if (error instanceof CopcWasmError) throw error;
        throw new CopcWasmError(
          "fetch",
          "Failed to load the COPC Rust/WASM module",
          { cause: error },
        );
      }

      let module: WebAssembly.Module;
      try {
        module = await WebAssembly.compile(binary as unknown as BufferSource);
      } catch (error: unknown) {
        throw new CopcWasmError(
          "compile",
          "Failed to compile the COPC Rust/WASM module",
          { cause: error },
        );
      }

      try {
        const rawImports = rawWasmImports(module);
        const instance = await WebAssembly.instantiate(
          module,
          rawImports.imports,
        );
        const exports = instance.exports as unknown as CopcWasmExports;
        rawImports.setMemory(exports.memory);
        return exports;
      } catch (error: unknown) {
        throw new CopcWasmError(
          "instantiate",
          "Failed to instantiate the COPC Rust/WASM module",
          { cause: error },
        );
      }
    })();
  }

  return wasmPromise;
}
