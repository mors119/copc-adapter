import type { CopcPointBuffer, CopcPointView } from '../copc/types/copc';

type CopcWasmExports = {
  memory: WebAssembly.Memory;
  alloc_f64(length: number): number;
  dealloc_f64(pointer: number, length: number): void;
  decode_xyz_to_interleaved(
    xPointer: number,
    yPointer: number,
    zPointer: number,
    count: number,
    outputPointer: number,
  ): number;
};

let wasmPromise: Promise<CopcWasmExports> | undefined;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

async function loadWasmBinary(): Promise<Uint8Array> {
  if (isBrowser()) {
    const response = await fetch('/wasm/copc_wasm.wasm');

    if (!response.ok) {
      throw new Error(`Failed to fetch COPC WASM decoder: ${response.status}`);
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
  const bytes = await readFile(modulePath);

  return new Uint8Array(bytes);
}

async function loadCopcWasm(): Promise<CopcWasmExports> {
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

function readDimensionValues(view: CopcPointView, name: string): Float64Array {
  const getter = view.getter(name);
  const values = new Float64Array(view.pointCount);

  for (let index = 0; index < view.pointCount; index += 1) {
    values[index] = getter(index);
  }

  return values;
}

export async function decodeCopcPointBuffer(
  view: CopcPointView,
): Promise<CopcPointBuffer> {
  const wasm = await loadCopcWasm();
  const xValues = readDimensionValues(view, 'X');
  const yValues = readDimensionValues(view, 'Y');
  const zValues = readDimensionValues(view, 'Z');
  const count = view.pointCount;
  const outputLength = count * 3;

  const xPointer = wasm.alloc_f64(count);
  const yPointer = wasm.alloc_f64(count);
  const zPointer = wasm.alloc_f64(count);
  const outputPointer = wasm.alloc_f64(outputLength);

  try {
    const memory = wasm.memory.buffer;

    new Float64Array(memory, xPointer, count).set(xValues);
    new Float64Array(memory, yPointer, count).set(yValues);
    new Float64Array(memory, zPointer, count).set(zValues);

    const writtenLength = wasm.decode_xyz_to_interleaved(
      xPointer,
      yPointer,
      zPointer,
      count,
      outputPointer,
    );

    if (writtenLength !== outputLength) {
      throw new Error('COPC WASM decoder returned an unexpected output length');
    }

    const coordinates = new Float64Array(outputLength);
    coordinates.set(new Float64Array(wasm.memory.buffer, outputPointer, outputLength));

    return {
      pointCount: count,
      coordinates,
    };
  } finally {
    wasm.dealloc_f64(xPointer, count);
    wasm.dealloc_f64(yPointer, count);
    wasm.dealloc_f64(zPointer, count);
    wasm.dealloc_f64(outputPointer, outputLength);
  }
}
