import type {
  CopcPointAttributes,
  CopcPointBuffer,
} from './types/copc';
import type { CopcPointFieldSelection } from './points/fieldSelection';
import { performanceNow } from './performance';
import { loadCopcWasm } from '../wasm/copcWasm';
import { RustCopcParseError } from './rustCopcErrors';

const FIELD_INTENSITY = 1 << 0;
const FIELD_CLASSIFICATION = 1 << 1;
const FIELD_RGB = 1 << 2;

export function getRustPointFieldMask(fields: CopcPointFieldSelection): number {
  return (fields.has('intensity') ? FIELD_INTENSITY : 0)
    | (fields.has('classification') ? FIELD_CLASSIFICATION : 0)
    | (fields.has('rgb') ? FIELD_RGB : 0);
}

type RustParserResponse<T> = {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
};

type RustDecodeValue = {
  point_count: number;
  intensity: boolean;
  classification: boolean;
  rgb: boolean;
};

function readCString(memory: WebAssembly.Memory, pointer: number): string {
  const bytes = new Uint8Array(memory.buffer);
  let end = pointer;
  while (end < bytes.length && bytes[end] !== 0) {
    end += 1;
  }
  if (end === bytes.length) {
    throw new RustCopcParseError('invalid-input', 'Rust decoder returned an unterminated response');
  }
  return new TextDecoder().decode(bytes.subarray(pointer, end));
}

export type RustCopcNodeDecodeResult = {
  buffer: CopcPointBuffer;
  durationMs: number;
};

/** Decode one compressed node without performing I/O or touching Cesium. */
export async function decodeRustCopcNode(
  metadataBytes: Uint8Array,
  chunkBytes: Uint8Array,
  pointCount: number,
  fields: CopcPointFieldSelection,
): Promise<RustCopcNodeDecodeResult> {
  const requestedFields = getRustPointFieldMask(fields);
  const coordinateLength = pointCount * 3;
  const wasm = await loadCopcWasm();
  const metadataPointer = wasm.alloc_bytes(metadataBytes.byteLength);
  const chunkPointer = wasm.alloc_bytes(chunkBytes.byteLength);
  const coordinatesPointer = wasm.alloc_f64(coordinateLength);
  const intensityPointer = fields.has('intensity') ? wasm.alloc_u16(pointCount) : 0;
  const classificationPointer = fields.has('classification') ? wasm.alloc_u8(pointCount) : 0;
  const redPointer = fields.has('rgb') ? wasm.alloc_u16(pointCount) : 0;
  const greenPointer = fields.has('rgb') ? wasm.alloc_u16(pointCount) : 0;
  const bluePointer = fields.has('rgb') ? wasm.alloc_u16(pointCount) : 0;

  try {
    const memory = wasm.memory.buffer;
    new Uint8Array(memory, metadataPointer, metadataBytes.byteLength).set(metadataBytes);
    new Uint8Array(memory, chunkPointer, chunkBytes.byteLength).set(chunkBytes);
    const decodeStartedAt = performanceNow();
    const responsePointer = wasm.decode_copc_node_json(
      metadataPointer,
      metadataBytes.byteLength,
      chunkPointer,
      chunkBytes.byteLength,
      pointCount,
      requestedFields,
      coordinatesPointer,
      intensityPointer,
      classificationPointer,
      redPointer,
      greenPointer,
      bluePointer,
    );
    const durationMs = performanceNow() - decodeStartedAt;

    try {
      const response = JSON.parse(readCString(wasm.memory, responsePointer)) as RustParserResponse<RustDecodeValue>;
      if (!response.ok || response.value === undefined) {
        throw new RustCopcParseError(
          response.error?.code ?? 'invalid-input',
          response.error?.message ?? 'Rust decoder returned an invalid error response',
        );
      }

      const value = response.value;
      if (value.point_count !== pointCount) {
        throw new RustCopcParseError(
          'chunk-length-mismatch',
          `Rust decoder returned ${value.point_count} points; expected ${pointCount}`,
        );
      }
      const coordinates = new Float64Array(coordinateLength);
      coordinates.set(new Float64Array(wasm.memory.buffer, coordinatesPointer, coordinateLength));
      const attributes: CopcPointAttributes = {
        intensity: value.intensity
          ? Uint16Array.from(new Uint16Array(wasm.memory.buffer, intensityPointer, pointCount))
          : undefined,
        classification: value.classification
          ? Uint8Array.from(new Uint8Array(wasm.memory.buffer, classificationPointer, pointCount))
          : undefined,
        red: value.rgb ? Uint16Array.from(new Uint16Array(wasm.memory.buffer, redPointer, pointCount)) : undefined,
        green: value.rgb ? Uint16Array.from(new Uint16Array(wasm.memory.buffer, greenPointer, pointCount)) : undefined,
        blue: value.rgb ? Uint16Array.from(new Uint16Array(wasm.memory.buffer, bluePointer, pointCount)) : undefined,
      };
      return {
        durationMs,
        buffer: {
          pointCount,
          coordinates,
          attributes: Object.values(attributes).some((values) => values !== undefined)
            ? attributes
            : undefined,
        },
      };
    } finally {
      wasm.free_parser_json(responsePointer);
    }
  } finally {
    wasm.dealloc_bytes(metadataPointer, metadataBytes.byteLength);
    wasm.dealloc_bytes(chunkPointer, chunkBytes.byteLength);
    wasm.dealloc_f64(coordinatesPointer, coordinateLength);
    if (intensityPointer) wasm.dealloc_u16(intensityPointer, pointCount);
    if (classificationPointer) wasm.dealloc_u8(classificationPointer, pointCount);
    if (redPointer) wasm.dealloc_u16(redPointer, pointCount);
    if (greenPointer) wasm.dealloc_u16(greenPointer, pointCount);
    if (bluePointer) wasm.dealloc_u16(bluePointer, pointCount);
  }
}
