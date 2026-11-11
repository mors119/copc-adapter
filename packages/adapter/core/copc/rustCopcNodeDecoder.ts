import type {
  CopcPointAttributes,
  CopcPointBuffer,
  CopcExtraDimensionValues,
  PreparedPointData,
  PreparedPointStatistics,
} from "./types/copc";
import { createPreparedPointData } from "../point/preparedPoint";
import type { CopcPointFieldSelection } from "./points/fieldSelection";
import { performanceNow } from "./performance";
import { loadCopcWasm, type CopcWasmExports } from "../wasm/copcWasm";
import { requireRustWasmPointer, RustCopcParseError } from "./rustCopcErrors";
import {
  DEFAULT_MAX_RANGE_BYTES,
  resolveWasmMaxRangeBytes,
} from "./range/types";
import { resolveHeightOffsetMeters } from "../coordinates/transform/heightOffset";

const FIELD_INTENSITY = 1 << 0;
const FIELD_CLASSIFICATION = 1 << 1;
const FIELD_RGB = 1 << 2;
const MAX_EXTRA_DIMENSION_OUTPUT_BYTES = 64 * 1024 * 1024;

export function getRustPointFieldMask(fields: CopcPointFieldSelection): number {
  return (
    (fields.has("intensity") ? FIELD_INTENSITY : 0) |
    (fields.has("classification") ? FIELD_CLASSIFICATION : 0) |
    (fields.has("rgb") ? FIELD_RGB : 0)
  );
}

type RustParserResponse<T> = {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
};

type RustDecodeValue = {
  point_count: number;
  coordinate_system: "copc-source";
  intensity: boolean;
  classification: boolean;
  rgb: boolean;
  extra_dimensions: RustExtraDimensionLayout[];
};

type RustExtraDimensionLayout = {
  name: string;
  value_type: "float64" | "int64" | "uint64";
  byte_offset: number;
  byte_length: number;
};

type RustPreparerHandle = {
  handle: number;
  vertical_unit_scale: number;
  used_horizontal_fallback: boolean;
};

type RustPreparedRange = { min: number; max: number };

type RustPrepareValue = {
  point_count: number;
  source_coordinate_system: "copc-source";
  coordinate_system: "wgs84-geographic";
  world_coordinate_system: "wgs84-ecef-meters";
  intensity: boolean;
  classification: boolean;
  rgb: boolean;
  extra_dimensions: RustExtraDimensionLayout[];
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
    throw new RustCopcParseError(
      "serialization",
      "Rust decoder could not allocate a response",
    );
  }
  if (
    !Number.isSafeInteger(pointer) ||
    pointer < 0 ||
    pointer >= bytes.length
  ) {
    throw new RustCopcParseError(
      "invalid-input",
      "Rust decoder returned an invalid response pointer",
    );
  }
  let end = pointer;
  while (end < bytes.length && bytes[end] !== 0) {
    end += 1;
  }
  if (end === bytes.length) {
    throw new RustCopcParseError(
      "invalid-input",
      "Rust decoder returned an unterminated response",
    );
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
  value: {
    intensity: boolean;
    classification: boolean;
    rgb: boolean;
    extra_dimensions: RustExtraDimensionLayout[];
  },
  pointCount: number,
  memory: WebAssembly.Memory,
  pointers: {
    intensity: number;
    classification: number;
    red: number;
    green: number;
    blue: number;
    extraDimensions: number;
  },
): CopcPointAttributes | undefined {
  const extraDimensions = readExtraDimensionValues(
    value.extra_dimensions,
    pointCount,
    memory,
    pointers.extraDimensions,
  );
  const attributes: CopcPointAttributes = {
    intensity: value.intensity
      ? Uint16Array.from(
          new Uint16Array(memory.buffer, pointers.intensity, pointCount),
        )
      : undefined,
    classification: value.classification
      ? Uint8Array.from(
          new Uint8Array(memory.buffer, pointers.classification, pointCount),
        )
      : undefined,
    red: value.rgb
      ? Uint16Array.from(
          new Uint16Array(memory.buffer, pointers.red, pointCount),
        )
      : undefined,
    green: value.rgb
      ? Uint16Array.from(
          new Uint16Array(memory.buffer, pointers.green, pointCount),
        )
      : undefined,
    blue: value.rgb
      ? Uint16Array.from(
          new Uint16Array(memory.buffer, pointers.blue, pointCount),
        )
      : undefined,
    ...(extraDimensions ? { extraDimensions } : {}),
  };
  return Object.values(attributes).some((values) => values !== undefined)
    ? attributes
    : undefined;
}

function readExtraDimensionValues(
  layouts: readonly RustExtraDimensionLayout[],
  pointCount: number,
  memory: WebAssembly.Memory,
  pointer: number,
): Record<string, CopcExtraDimensionValues> | undefined {
  if (layouts.length === 0) return undefined;
  const totalByteLength = layouts.length * pointCount * 8;
  if (
    !Number.isSafeInteger(totalByteLength) ||
    totalByteLength > MAX_EXTRA_DIMENSION_OUTPUT_BYTES ||
    (pointer === 0 && totalByteLength > 0)
  ) {
    throw new RustCopcParseError(
      "invalid-input",
      "Rust decoder returned an invalid Extra Bytes output buffer",
    );
  }
  const dimensions: Record<string, CopcExtraDimensionValues> = {};
  const view = new DataView(memory.buffer);
  const seen = new Set<string>();
  for (const layout of layouts) {
    const byteEnd = layout.byte_offset + layout.byte_length;
    if (
      seen.has(layout.name) ||
      !Number.isSafeInteger(layout.byte_offset) ||
      layout.byte_offset < 0 ||
      layout.byte_length !== pointCount * 8 ||
      !Number.isSafeInteger(byteEnd) ||
      byteEnd > totalByteLength
    ) {
      throw new RustCopcParseError(
        "invalid-input",
        "Rust decoder returned an invalid Extra Bytes field layout",
      );
    }
    seen.add(layout.name);
    const start = pointer + layout.byte_offset;
    let values: CopcExtraDimensionValues;
    if (layout.value_type === "uint64") {
      const typed = new BigUint64Array(pointCount);
      for (let index = 0; index < pointCount; index += 1) {
        typed[index] = view.getBigUint64(start + index * 8, true);
      }
      values = typed;
    } else if (layout.value_type === "int64") {
      const typed = new BigInt64Array(pointCount);
      for (let index = 0; index < pointCount; index += 1) {
        typed[index] = view.getBigInt64(start + index * 8, true);
      }
      values = typed;
    } else if (layout.value_type === "float64") {
      const typed = new Float64Array(pointCount);
      for (let index = 0; index < pointCount; index += 1) {
        typed[index] = view.getFloat64(start + index * 8, true);
      }
      values = typed;
    } else {
      throw new RustCopcParseError(
        "invalid-input",
        "Rust decoder returned an unknown Extra Bytes value type",
      );
    }
    Object.defineProperty(dimensions, layout.name, {
      value: values,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return dimensions;
}

function extraDimensionOutputByteLength(
  names: readonly string[],
  pointCount: number,
): number {
  const length = names.length * pointCount * 8;
  if (
    !Number.isSafeInteger(length) ||
    length > MAX_EXTRA_DIMENSION_OUTPUT_BYTES
  ) {
    throw new RustCopcParseError(
      "unsupported-value",
      `Extra Bytes output exceeds the ${MAX_EXTRA_DIMENSION_OUTPUT_BYTES}-byte safety limit`,
    );
  }
  return length;
}

function encodeExtraDimensionSelection(names: readonly string[]): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(names));
  if (bytes.byteLength > 64 * 1024) {
    throw new RustCopcParseError(
      "unsupported-value",
      "Extra Bytes selection exceeds the 65536-byte safety limit",
    );
  }
  return bytes;
}

function hasAttributes(
  value: CopcPointAttributes | undefined,
): value is CopcPointAttributes {
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
    maxChunkBytes = DEFAULT_MAX_RANGE_BYTES,
    heightOffsetMeters = 0,
  ): Promise<RustCopcNodePreparer> {
    const maximum = resolveWasmMaxRangeBytes("[metadata]", maxChunkBytes);
    const heightOffset = resolveHeightOffsetMeters(heightOffsetMeters);
    const wasm = await loadWasm();
    const metadataPointer = requireRustWasmPointer(
      wasm.alloc_bytes(metadataBytes.byteLength),
      metadataBytes.byteLength,
      "metadata",
    );
    new Uint8Array(
      wasm.memory.buffer,
      metadataPointer,
      metadataBytes.byteLength,
    ).set(metadataBytes);
    try {
      const responsePointer =
        wasm.create_copc_node_preparer_with_limit_and_height_offset_json(
          metadataPointer,
          metadataBytes.byteLength,
          maximum,
          heightOffset,
        );
      try {
        const response = JSON.parse(
          readCString(wasm.memory, responsePointer),
        ) as RustParserResponse<RustPreparerHandle>;
        if (!response.ok || response.value === undefined) {
          throw new RustCopcParseError(
            response.error?.code ?? "invalid-input",
            response.error?.message ??
              "Rust node preparer returned an invalid error response",
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
    requestedExtraDimensions: readonly string[] = [],
  ): RustCopcNodePreparationResult {
    if (this.handle.handle === 0) {
      throw new RustCopcParseError(
        "invalid-input",
        "Rust COPC node preparer has been disposed",
      );
    }
    const requestedFields = getRustPointFieldMask(fields);
    if (
      !Number.isSafeInteger(pointCount) ||
      pointCount < 0 ||
      pointCount > Number.MAX_SAFE_INTEGER / 3
    ) {
      throw new RustCopcParseError(
        "overflow",
        "coordinate output length exceeds safe integer range",
      );
    }
    const coordinateLength = pointCount * 3;
    const selectionBytes = encodeExtraDimensionSelection(requestedExtraDimensions);
    const extraOutputByteLength = extraDimensionOutputByteLength(
      requestedExtraDimensions,
      pointCount,
    );
    let chunkPointer = 0;
    let sourcePointer = 0;
    let geographicPointer = 0;
    let ecefPointer = 0;
    let intensityPointer = 0;
    let classificationPointer = 0;
    let redPointer = 0;
    let greenPointer = 0;
    let bluePointer = 0;
    let selectionPointer = 0;
    let extraDimensionsPointer = 0;

    try {
      chunkPointer = requireRustWasmPointer(
        this.wasm.alloc_bytes(chunkBytes.byteLength),
        chunkBytes.byteLength,
        "node chunk",
      );
      sourcePointer = requireRustWasmPointer(
        this.wasm.alloc_f64(coordinateLength),
        coordinateLength,
        "source coordinates",
      );
      geographicPointer = requireRustWasmPointer(
        this.wasm.alloc_f64(coordinateLength),
        coordinateLength,
        "geographic coordinates",
      );
      ecefPointer = requireRustWasmPointer(
        this.wasm.alloc_f64(coordinateLength),
        coordinateLength,
        "ECEF coordinates",
      );
      intensityPointer = fields.has("intensity")
        ? requireRustWasmPointer(
            this.wasm.alloc_u16(pointCount),
            pointCount,
            "intensity",
          )
        : 0;
      classificationPointer = fields.has("classification")
        ? requireRustWasmPointer(
            this.wasm.alloc_u8(pointCount),
            pointCount,
            "classification",
          )
        : 0;
      redPointer = fields.has("rgb")
        ? requireRustWasmPointer(
            this.wasm.alloc_u16(pointCount),
            pointCount,
            "red",
          )
        : 0;
      greenPointer = fields.has("rgb")
        ? requireRustWasmPointer(
            this.wasm.alloc_u16(pointCount),
            pointCount,
            "green",
          )
        : 0;
      bluePointer = fields.has("rgb")
        ? requireRustWasmPointer(
            this.wasm.alloc_u16(pointCount),
            pointCount,
            "blue",
          )
        : 0;
      selectionPointer = requireRustWasmPointer(
        this.wasm.alloc_bytes(selectionBytes.byteLength),
        selectionBytes.byteLength,
        "Extra Bytes selection",
      );
      extraDimensionsPointer = extraOutputByteLength > 0
        ? requireRustWasmPointer(
            this.wasm.alloc_bytes(extraOutputByteLength),
            extraOutputByteLength,
            "Extra Bytes output",
          )
        : 0;
      new Uint8Array(
        this.wasm.memory.buffer,
        chunkPointer,
        chunkBytes.byteLength,
      ).set(chunkBytes);
      new Uint8Array(
        this.wasm.memory.buffer,
        selectionPointer,
        selectionBytes.byteLength,
      ).set(selectionBytes);
      const startedAt = performanceNow();
      const responsePointer = this.wasm.prepare_copc_node_with_extra_dimensions_json(
        this.handle.handle,
        chunkPointer,
        chunkBytes.byteLength,
        pointCount,
        requestedFields,
        selectionPointer,
        selectionBytes.byteLength,
        sourcePointer,
        geographicPointer,
        ecefPointer,
        intensityPointer,
        classificationPointer,
        redPointer,
        greenPointer,
        bluePointer,
        extraDimensionsPointer,
      );
      try {
        const response = JSON.parse(
          readCString(this.wasm.memory, responsePointer),
        ) as RustParserResponse<RustPrepareValue>;
        if (!response.ok || response.value === undefined) {
          throw new RustCopcParseError(
            response.error?.code ?? "invalid-input",
            response.error?.message ??
              "Rust node preparer returned an invalid error response",
          );
        }
        const value = response.value;
        if (value.point_count !== pointCount) {
          throw new RustCopcParseError(
            "chunk-length-mismatch",
            `Rust node preparer returned ${value.point_count} points; expected ${pointCount}`,
          );
        }
        if (
          value.source_coordinate_system !== "copc-source" ||
          value.coordinate_system !== "wgs84-geographic" ||
          value.world_coordinate_system !== "wgs84-ecef-meters"
        ) {
          throw new RustCopcParseError(
            "invalid-input",
            "Rust node preparer returned invalid coordinate systems",
          );
        }

        const sourceCoordinates = Float64Array.from(
          new Float64Array(
            this.wasm.memory.buffer,
            sourcePointer,
            coordinateLength,
          ),
        );
        const geographicCoordinates = Float64Array.from(
          new Float64Array(
            this.wasm.memory.buffer,
            geographicPointer,
            coordinateLength,
          ),
        );
        const worldCoordinates = Float64Array.from(
          new Float64Array(
            this.wasm.memory.buffer,
            ecefPointer,
            coordinateLength,
          ),
        );
        const attributes = attributesFromResponse(
          value,
          pointCount,
          this.wasm.memory,
          {
            intensity: intensityPointer,
            classification: classificationPointer,
            red: redPointer,
            green: greenPointer,
            blue: bluePointer,
            extraDimensions: extraDimensionsPointer,
          },
        );
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
      if (chunkPointer)
        this.wasm.dealloc_bytes(chunkPointer, chunkBytes.byteLength);
      if (sourcePointer) this.wasm.dealloc_f64(sourcePointer, coordinateLength);
      if (geographicPointer)
        this.wasm.dealloc_f64(geographicPointer, coordinateLength);
      if (ecefPointer) this.wasm.dealloc_f64(ecefPointer, coordinateLength);
      if (intensityPointer) this.wasm.dealloc_u16(intensityPointer, pointCount);
      if (classificationPointer)
        this.wasm.dealloc_u8(classificationPointer, pointCount);
      if (redPointer) this.wasm.dealloc_u16(redPointer, pointCount);
      if (greenPointer) this.wasm.dealloc_u16(greenPointer, pointCount);
      if (bluePointer) this.wasm.dealloc_u16(bluePointer, pointCount);
      if (selectionPointer)
        this.wasm.dealloc_bytes(selectionPointer, selectionBytes.byteLength);
      if (extraDimensionsPointer)
        this.wasm.dealloc_bytes(extraDimensionsPointer, extraOutputByteLength);
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
  maxChunkBytes = DEFAULT_MAX_RANGE_BYTES,
  requestedExtraDimensions: readonly string[] = [],
): Promise<RustCopcNodeDecodeResult> {
  const maximum = resolveWasmMaxRangeBytes("[node chunk]", maxChunkBytes);
  const requestedFields = getRustPointFieldMask(fields);
  if (
    !Number.isSafeInteger(pointCount) ||
    pointCount < 0 ||
    pointCount > Number.MAX_SAFE_INTEGER / 3
  ) {
    throw new RustCopcParseError(
      "overflow",
      "coordinate output length exceeds safe integer range",
    );
  }
  const coordinateLength = pointCount * 3;
  const selectionBytes = encodeExtraDimensionSelection(requestedExtraDimensions);
  const extraOutputByteLength = extraDimensionOutputByteLength(
    requestedExtraDimensions,
    pointCount,
  );
  const wasm = await loadWasm();
  let metadataPointer = 0;
  let chunkPointer = 0;
  let coordinatesPointer = 0;
  let intensityPointer = 0;
  let classificationPointer = 0;
  let redPointer = 0;
  let greenPointer = 0;
  let bluePointer = 0;
  let selectionPointer = 0;
  let extraDimensionsPointer = 0;

  try {
    metadataPointer = requireRustWasmPointer(
      wasm.alloc_bytes(metadataBytes.byteLength),
      metadataBytes.byteLength,
      "metadata",
    );
    chunkPointer = requireRustWasmPointer(
      wasm.alloc_bytes(chunkBytes.byteLength),
      chunkBytes.byteLength,
      "node chunk",
    );
    coordinatesPointer = requireRustWasmPointer(
      wasm.alloc_f64(coordinateLength),
      coordinateLength,
      "coordinates",
    );
    intensityPointer = fields.has("intensity")
      ? requireRustWasmPointer(
          wasm.alloc_u16(pointCount),
          pointCount,
          "intensity",
        )
      : 0;
    classificationPointer = fields.has("classification")
      ? requireRustWasmPointer(
          wasm.alloc_u8(pointCount),
          pointCount,
          "classification",
        )
      : 0;
    redPointer = fields.has("rgb")
      ? requireRustWasmPointer(wasm.alloc_u16(pointCount), pointCount, "red")
      : 0;
    greenPointer = fields.has("rgb")
      ? requireRustWasmPointer(wasm.alloc_u16(pointCount), pointCount, "green")
      : 0;
    bluePointer = fields.has("rgb")
      ? requireRustWasmPointer(wasm.alloc_u16(pointCount), pointCount, "blue")
      : 0;
    selectionPointer = requireRustWasmPointer(
      wasm.alloc_bytes(selectionBytes.byteLength),
      selectionBytes.byteLength,
      "Extra Bytes selection",
    );
    extraDimensionsPointer = extraOutputByteLength > 0
      ? requireRustWasmPointer(
          wasm.alloc_bytes(extraOutputByteLength),
          extraOutputByteLength,
          "Extra Bytes output",
        )
      : 0;
    const memory = wasm.memory.buffer;
    new Uint8Array(memory, metadataPointer, metadataBytes.byteLength).set(
      metadataBytes,
    );
    new Uint8Array(memory, chunkPointer, chunkBytes.byteLength).set(chunkBytes);
    new Uint8Array(
      wasm.memory.buffer,
      selectionPointer,
      selectionBytes.byteLength,
    ).set(selectionBytes);
    const decodeStartedAt = performanceNow();
    const responsePointer = wasm.decode_copc_node_with_limit_and_extra_dimensions_json(
      metadataPointer,
      metadataBytes.byteLength,
      chunkPointer,
      chunkBytes.byteLength,
      pointCount,
      requestedFields,
      maximum,
      selectionPointer,
      selectionBytes.byteLength,
      coordinatesPointer,
      intensityPointer,
      classificationPointer,
      redPointer,
      greenPointer,
      bluePointer,
      extraDimensionsPointer,
    );
    const durationMs = performanceNow() - decodeStartedAt;

    try {
      const response = JSON.parse(
        readCString(wasm.memory, responsePointer),
      ) as RustParserResponse<RustDecodeValue>;
      if (!response.ok || response.value === undefined) {
        throw new RustCopcParseError(
          response.error?.code ?? "invalid-input",
          response.error?.message ??
            "Rust decoder returned an invalid error response",
        );
      }

      const value = response.value;
      if (value.coordinate_system !== "copc-source") {
        throw new RustCopcParseError(
          "invalid-input",
          `Rust decoder returned an unexpected coordinate system: ${value.coordinate_system}`,
        );
      }
      if (value.point_count !== pointCount) {
        throw new RustCopcParseError(
          "chunk-length-mismatch",
          `Rust decoder returned ${value.point_count} points; expected ${pointCount}`,
        );
      }
      const coordinates = new Float64Array(coordinateLength);
      coordinates.set(
        new Float64Array(
          wasm.memory.buffer,
          coordinatesPointer,
          coordinateLength,
        ),
      );
      const attributes = attributesFromResponse(
        value,
        pointCount,
        wasm.memory,
        {
          intensity: intensityPointer,
          classification: classificationPointer,
          red: redPointer,
          green: greenPointer,
          blue: bluePointer,
          extraDimensions: extraDimensionsPointer,
        },
      );
      return {
        durationMs,
        buffer: {
          pointCount,
          coordinates,
          coordinateSystem: value.coordinate_system,
          attributes,
        },
      };
    } finally {
      wasm.free_parser_json(responsePointer);
    }
  } finally {
    if (metadataPointer)
      wasm.dealloc_bytes(metadataPointer, metadataBytes.byteLength);
    if (chunkPointer) wasm.dealloc_bytes(chunkPointer, chunkBytes.byteLength);
    if (coordinatesPointer)
      wasm.dealloc_f64(coordinatesPointer, coordinateLength);
    if (intensityPointer) wasm.dealloc_u16(intensityPointer, pointCount);
    if (classificationPointer)
      wasm.dealloc_u8(classificationPointer, pointCount);
    if (redPointer) wasm.dealloc_u16(redPointer, pointCount);
    if (greenPointer) wasm.dealloc_u16(greenPointer, pointCount);
    if (bluePointer) wasm.dealloc_u16(bluePointer, pointCount);
    if (selectionPointer)
      wasm.dealloc_bytes(selectionPointer, selectionBytes.byteLength);
    if (extraDimensionsPointer)
      wasm.dealloc_bytes(extraDimensionsPointer, extraOutputByteLength);
  }
}
