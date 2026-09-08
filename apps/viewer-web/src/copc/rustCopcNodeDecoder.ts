import type {
  CopcPointAttributes,
  CopcPointBuffer,
  PreparedPointData,
  PreparedPointStatistics,
} from './types/copc';
import { createPreparedPointData } from '../point/preparedPoint';
import type { CopcPointFieldSelection } from './points/fieldSelection';
import { performanceNow } from './performance';
import { loadCopcWasm, type CopcWasmExports } from '../wasm/copcWasm';
import { requireRustWasmPointer, RustCopcParseError } from './rustCopcErrors';

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
  coordinate_system: 'copc-source';
  intensity: boolean;
  classification: boolean;
  rgb: boolean;
};

type RustPreparerHandle = {
  handle: number;
  vertical_unit_scale: number;
  used_horizontal_fallback: boolean;
};

type RustPreparedRange = { min: number; max: number };

type RustPrepareValue = {
  point_count: number;
  source_coordinate_system: 'copc-source';
  coordinate_system: 'wgs84-geographic';
  world_coordinate_system: 'wgs84-ecef-meters';
  intensity: boolean;
  classification: boolean;
  rgb: boolean;
  statistics: {
    elevation?: RustPreparedRange;
    intensity?: RustPreparedRange;
    rgb_max?: 255 | 65535;
  };
  decode_duration_ms: number;
  preparation_duration_ms: number;
};

function readCString(memory: WebAssembly.Memory, pointer: number): string {
  const bytes = new Uint8Array(memory.buffer);
  if (pointer === 0) {
    throw new RustCopcParseError('serialization', 'Rust decoder could not allocate a response');
  }
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer >= bytes.length) {
    throw new RustCopcParseError('invalid-input', 'Rust decoder returned an invalid response pointer');
  }
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

export type RustCopcNodePreparationResult = {
  prepared: PreparedPointData;
  durationMs: number;
  decodeDurationMs: number;
  preparationDurationMs: number;
};

function attributesFromResponse(
  value: { intensity: boolean; classification: boolean; rgb: boolean },
  pointCount: number,
  memory: WebAssembly.Memory,
  pointers: {
    intensity: number;
    classification: number;
    red: number;
    green: number;
    blue: number;
  },
): CopcPointAttributes | undefined {
  const attributes: CopcPointAttributes = {
    intensity: value.intensity
      ? Uint16Array.from(new Uint16Array(memory.buffer, pointers.intensity, pointCount))
      : undefined,
    classification: value.classification
      ? Uint8Array.from(new Uint8Array(memory.buffer, pointers.classification, pointCount))
      : undefined,
    red: value.rgb ? Uint16Array.from(new Uint16Array(memory.buffer, pointers.red, pointCount)) : undefined,
    green: value.rgb ? Uint16Array.from(new Uint16Array(memory.buffer, pointers.green, pointCount)) : undefined,
    blue: value.rgb ? Uint16Array.from(new Uint16Array(memory.buffer, pointers.blue, pointCount)) : undefined,
  };
  return Object.values(attributes).some((values) => values !== undefined) ? attributes : undefined;
}

function hasAttributes(value: CopcPointAttributes | undefined): value is CopcPointAttributes {
  return value !== undefined;
}

/** Dataset-scoped Rust decode/CRS/preparation state. */
export class RustCopcNodePreparer {
  private readonly wasm: CopcWasmExports;
  private readonly handle: RustPreparerHandle;

  private constructor(wasm: CopcWasmExports, handle: RustPreparerHandle) {
    this.wasm = wasm;
    this.handle = handle;
  }

  static async fromMetadata(
    metadataBytes: Uint8Array,
    loadWasm: () => Promise<CopcWasmExports> = loadCopcWasm,
  ): Promise<RustCopcNodePreparer> {
    const wasm = await loadWasm();
    const metadataPointer = requireRustWasmPointer(
      wasm.alloc_bytes(metadataBytes.byteLength),
      metadataBytes.byteLength,
      'metadata',
    );
    new Uint8Array(wasm.memory.buffer, metadataPointer, metadataBytes.byteLength).set(metadataBytes);
    try {
      const responsePointer = wasm.create_copc_node_preparer_json(
        metadataPointer,
        metadataBytes.byteLength,
      );
      try {
        const response = JSON.parse(readCString(wasm.memory, responsePointer)) as RustParserResponse<RustPreparerHandle>;
        if (!response.ok || response.value === undefined) {
          throw new RustCopcParseError(
            response.error?.code ?? 'invalid-input',
            response.error?.message ?? 'Rust node preparer returned an invalid error response',
          );
        }
        return new RustCopcNodePreparer(wasm, response.value);
      } finally {
        wasm.free_parser_json(responsePointer);
      }
    } finally {
      wasm.dealloc_bytes(metadataPointer, metadataBytes.byteLength);
    }
  }

  prepare(
    chunkBytes: Uint8Array,
    pointCount: number,
    fields: CopcPointFieldSelection,
  ): RustCopcNodePreparationResult {
    if (this.handle.handle === 0) {
      throw new RustCopcParseError('invalid-input', 'Rust COPC node preparer has been disposed');
    }
    const requestedFields = getRustPointFieldMask(fields);
    if (!Number.isSafeInteger(pointCount) || pointCount < 0 || pointCount > Number.MAX_SAFE_INTEGER / 3) {
      throw new RustCopcParseError('overflow', 'coordinate output length exceeds safe integer range');
    }
    const coordinateLength = pointCount * 3;
    let chunkPointer = 0;
    let sourcePointer = 0;
    let geographicPointer = 0;
    let ecefPointer = 0;
    let intensityPointer = 0;
    let classificationPointer = 0;
    let redPointer = 0;
    let greenPointer = 0;
    let bluePointer = 0;

    try {
      chunkPointer = requireRustWasmPointer(
        this.wasm.alloc_bytes(chunkBytes.byteLength),
        chunkBytes.byteLength,
        'node chunk',
      );
      sourcePointer = requireRustWasmPointer(
        this.wasm.alloc_f64(coordinateLength),
        coordinateLength,
        'source coordinates',
      );
      geographicPointer = requireRustWasmPointer(
        this.wasm.alloc_f64(coordinateLength),
        coordinateLength,
        'geographic coordinates',
      );
      ecefPointer = requireRustWasmPointer(
        this.wasm.alloc_f64(coordinateLength),
        coordinateLength,
        'ECEF coordinates',
      );
      intensityPointer = fields.has('intensity')
        ? requireRustWasmPointer(this.wasm.alloc_u16(pointCount), pointCount, 'intensity')
        : 0;
      classificationPointer = fields.has('classification')
        ? requireRustWasmPointer(this.wasm.alloc_u8(pointCount), pointCount, 'classification')
        : 0;
      redPointer = fields.has('rgb')
        ? requireRustWasmPointer(this.wasm.alloc_u16(pointCount), pointCount, 'red')
        : 0;
      greenPointer = fields.has('rgb')
        ? requireRustWasmPointer(this.wasm.alloc_u16(pointCount), pointCount, 'green')
        : 0;
      bluePointer = fields.has('rgb')
        ? requireRustWasmPointer(this.wasm.alloc_u16(pointCount), pointCount, 'blue')
        : 0;
      new Uint8Array(this.wasm.memory.buffer, chunkPointer, chunkBytes.byteLength).set(chunkBytes);
      const startedAt = performanceNow();
      const responsePointer = this.wasm.prepare_copc_node_json(
        this.handle.handle,
        chunkPointer,
        chunkBytes.byteLength,
        pointCount,
        requestedFields,
        sourcePointer,
        geographicPointer,
        ecefPointer,
        intensityPointer,
        classificationPointer,
        redPointer,
        greenPointer,
        bluePointer,
      );
      try {
        const response = JSON.parse(readCString(this.wasm.memory, responsePointer)) as RustParserResponse<RustPrepareValue>;
        if (!response.ok || response.value === undefined) {
          throw new RustCopcParseError(
            response.error?.code ?? 'invalid-input',
            response.error?.message ?? 'Rust node preparer returned an invalid error response',
          );
        }
        const value = response.value;
        if (value.point_count !== pointCount) {
          throw new RustCopcParseError(
            'chunk-length-mismatch',
            `Rust node preparer returned ${value.point_count} points; expected ${pointCount}`,
          );
        }
        if (value.source_coordinate_system !== 'copc-source'
          || value.coordinate_system !== 'wgs84-geographic'
          || value.world_coordinate_system !== 'wgs84-ecef-meters') {
          throw new RustCopcParseError('invalid-input', 'Rust node preparer returned invalid coordinate systems');
        }

        const sourceCoordinates = Float64Array.from(
          new Float64Array(this.wasm.memory.buffer, sourcePointer, coordinateLength),
        );
        const geographicCoordinates = Float64Array.from(
          new Float64Array(this.wasm.memory.buffer, geographicPointer, coordinateLength),
        );
        const worldCoordinates = Float64Array.from(
          new Float64Array(this.wasm.memory.buffer, ecefPointer, coordinateLength),
        );
        const attributes = attributesFromResponse(value, pointCount, this.wasm.memory, {
          intensity: intensityPointer,
          classification: classificationPointer,
          red: redPointer,
          green: greenPointer,
          blue: bluePointer,
        });
        const statistics: PreparedPointStatistics = {
          elevation: value.statistics.elevation,
          intensity: value.statistics.intensity,
          rgbMax: value.statistics.rgb_max,
        };
        return {
          prepared: createPreparedPointData({
            pointCount,
            sourceCoordinates,
            geographicCoordinates,
            worldCoordinates,
            attributes: hasAttributes(attributes) ? attributes : undefined,
            statistics,
          }),
          durationMs: performanceNow() - startedAt,
          decodeDurationMs: value.decode_duration_ms,
          preparationDurationMs: value.preparation_duration_ms,
        };
      } finally {
        this.wasm.free_parser_json(responsePointer);
      }
    } finally {
      if (chunkPointer) this.wasm.dealloc_bytes(chunkPointer, chunkBytes.byteLength);
      if (sourcePointer) this.wasm.dealloc_f64(sourcePointer, coordinateLength);
      if (geographicPointer) this.wasm.dealloc_f64(geographicPointer, coordinateLength);
      if (ecefPointer) this.wasm.dealloc_f64(ecefPointer, coordinateLength);
      if (intensityPointer) this.wasm.dealloc_u16(intensityPointer, pointCount);
      if (classificationPointer) this.wasm.dealloc_u8(classificationPointer, pointCount);
      if (redPointer) this.wasm.dealloc_u16(redPointer, pointCount);
      if (greenPointer) this.wasm.dealloc_u16(greenPointer, pointCount);
      if (bluePointer) this.wasm.dealloc_u16(bluePointer, pointCount);
    }
  }

  dispose(): void {
    if (this.handle.handle !== 0) {
      this.wasm.free_copc_node_preparer(this.handle.handle);
      this.handle.handle = 0;
    }
  }
}

/** Decode one compressed node without performing I/O or touching Cesium. */
export async function decodeRustCopcNode(
  metadataBytes: Uint8Array,
  chunkBytes: Uint8Array,
  pointCount: number,
  fields: CopcPointFieldSelection,
  loadWasm: () => Promise<CopcWasmExports>,
): Promise<RustCopcNodeDecodeResult> {
  const requestedFields = getRustPointFieldMask(fields);
  if (!Number.isSafeInteger(pointCount) || pointCount < 0 || pointCount > Number.MAX_SAFE_INTEGER / 3) {
    throw new RustCopcParseError('overflow', 'coordinate output length exceeds safe integer range');
  }
  const coordinateLength = pointCount * 3;
  const wasm = await loadWasm();
  let metadataPointer = 0;
  let chunkPointer = 0;
  let coordinatesPointer = 0;
  let intensityPointer = 0;
  let classificationPointer = 0;
  let redPointer = 0;
  let greenPointer = 0;
  let bluePointer = 0;

  try {
    metadataPointer = requireRustWasmPointer(
      wasm.alloc_bytes(metadataBytes.byteLength),
      metadataBytes.byteLength,
      'metadata',
    );
    chunkPointer = requireRustWasmPointer(
      wasm.alloc_bytes(chunkBytes.byteLength),
      chunkBytes.byteLength,
      'node chunk',
    );
    coordinatesPointer = requireRustWasmPointer(
      wasm.alloc_f64(coordinateLength),
      coordinateLength,
      'coordinates',
    );
    intensityPointer = fields.has('intensity')
      ? requireRustWasmPointer(wasm.alloc_u16(pointCount), pointCount, 'intensity')
      : 0;
    classificationPointer = fields.has('classification')
      ? requireRustWasmPointer(wasm.alloc_u8(pointCount), pointCount, 'classification')
      : 0;
    redPointer = fields.has('rgb')
      ? requireRustWasmPointer(wasm.alloc_u16(pointCount), pointCount, 'red')
      : 0;
    greenPointer = fields.has('rgb')
      ? requireRustWasmPointer(wasm.alloc_u16(pointCount), pointCount, 'green')
      : 0;
    bluePointer = fields.has('rgb')
      ? requireRustWasmPointer(wasm.alloc_u16(pointCount), pointCount, 'blue')
      : 0;
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
      if (value.coordinate_system !== 'copc-source') {
        throw new RustCopcParseError(
          'invalid-input',
          `Rust decoder returned an unexpected coordinate system: ${value.coordinate_system}`,
        );
      }
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
          coordinateSystem: value.coordinate_system,
          attributes: Object.values(attributes).some((values) => values !== undefined)
            ? attributes
            : undefined,
        },
      };
    } finally {
      wasm.free_parser_json(responsePointer);
    }
  } finally {
    if (metadataPointer) wasm.dealloc_bytes(metadataPointer, metadataBytes.byteLength);
    if (chunkPointer) wasm.dealloc_bytes(chunkPointer, chunkBytes.byteLength);
    if (coordinatesPointer) wasm.dealloc_f64(coordinatesPointer, coordinateLength);
    if (intensityPointer) wasm.dealloc_u16(intensityPointer, pointCount);
    if (classificationPointer) wasm.dealloc_u8(classificationPointer, pointCount);
    if (redPointer) wasm.dealloc_u16(redPointer, pointCount);
    if (greenPointer) wasm.dealloc_u16(greenPointer, pointCount);
    if (bluePointer) wasm.dealloc_u16(bluePointer, pointCount);
  }
}
