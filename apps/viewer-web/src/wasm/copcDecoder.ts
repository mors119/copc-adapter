import type {
  CopcPointAttributes,
  CopcPointBuffer,
  CopcPointView,
} from '../copc/types/copc';
import type { CopcPointDecoder } from '../copc/points/types';
import type { CopcPointComponent } from '../copc/points/fieldSelection';
import { loadCopcWasm } from './copcWasm';

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
