import type {
  CopcPointAttributes,
  CopcPointBuffer,
  CopcPointView,
} from '../copc/types/copc';
import type { CopcPointDecoder } from '../copc/points/types';
import type { CopcPointComponent } from '../copc/points/fieldSelection';

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

function readDimensionValues(
  view: CopcPointView,
  component: CopcPointComponent,
): Float64Array {
  const getter = view.getter(component);
  const values = new Float64Array(view.pointCount);

  for (let index = 0; index < view.pointCount; index += 1) {
    values[index] = getter(index);
  }

  return values;
}

function readOptionalUint16Dimension(
  view: CopcPointView,
  field: 'intensity' | 'rgb',
  component: CopcPointComponent,
): Uint16Array | undefined {
  if (!view.availableFields.has(field)) {
    return undefined;
  }

  const getter = view.getter(component);
  const values = new Uint16Array(view.pointCount);

  for (let index = 0; index < view.pointCount; index += 1) {
    values[index] = getter(index);
  }

  return values;
}

function readOptionalUint8Dimension(
  view: CopcPointView,
  field: 'classification',
  component: CopcPointComponent,
): Uint8Array | undefined {
  if (!view.availableFields.has(field)) {
    return undefined;
  }

  const getter = view.getter(component);
  const values = new Uint8Array(view.pointCount);

  for (let index = 0; index < view.pointCount; index += 1) {
    values[index] = getter(index);
  }

  return values;
}

function readPointAttributes(view: CopcPointView): CopcPointAttributes | undefined {
  const attributes: CopcPointAttributes = {
    intensity: readOptionalUint16Dimension(view, 'intensity', 'intensity'),
    classification: readOptionalUint8Dimension(view, 'classification', 'classification'),
    red: readOptionalUint16Dimension(view, 'rgb', 'red'),
    green: readOptionalUint16Dimension(view, 'rgb', 'green'),
    blue: readOptionalUint16Dimension(view, 'rgb', 'blue'),
  };

  return Object.values(attributes).some((values) => values !== undefined)
    ? attributes
    : undefined;
}

export async function decodeCopcPointBuffer(
  view: CopcPointView,
): Promise<CopcPointBuffer> {
  if (!view.availableFields.has('position')) {
    throw new Error('COPC point view does not contain the requested position field');
  }

  const wasm = await loadCopcWasm();
  const xValues = readDimensionValues(view, 'x');
  const yValues = readDimensionValues(view, 'y');
  const zValues = readDimensionValues(view, 'z');
  const attributes = readPointAttributes(view);
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
      attributes,
    };
  } finally {
    wasm.dealloc_f64(xPointer, count);
    wasm.dealloc_f64(yPointer, count);
    wasm.dealloc_f64(zPointer, count);
    wasm.dealloc_f64(outputPointer, outputLength);
  }
}

/** Default point decoder backed by the Rust WebAssembly module. */
export const wasmCopcPointDecoder: CopcPointDecoder = {
  decode: decodeCopcPointBuffer,
};
