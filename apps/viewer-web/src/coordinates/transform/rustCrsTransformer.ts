import type { CopcMetadata } from '../../copc/types/copc';
import { requireRustWasmPointer, RustCopcParseError } from '../../copc/rustCopcErrors';
import { loadCopcWasm, type CopcWasmExports } from '../../wasm/copcWasm';
import { resolveHeightOffsetMeters } from './heightOffset';

type RustResponse<T> = {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
};

type RustCrsHandle = {
  handle: number;
  vertical_unit_scale: number;
  used_horizontal_fallback: boolean;
};

type RustCrsTransformResult = {
  point_count: number;
};

/** Coordinate buffers and preparation metadata returned by the Rust CRS path. */
export type RustPreparedCoordinateBuffer = {
  /** Number of coordinate triples in each output buffer. */
  pointCount: number;
  /** Interleaved WGS84 longitude (degrees), latitude (degrees), height (metres). */
  geographicCoordinates: Float64Array;
  /** Interleaved WGS84 ECEF XYZ positions in metres. */
  ecefCoordinates: Float64Array;
  /** Source vertical-unit conversion used before applying the height offset. */
  verticalUnitScale: number;
  /** True when metadata without WKT used the geographic-coordinate fallback. */
  usedHorizontalFallback: boolean;
};

function readCString(memory: WebAssembly.Memory, pointer: number): string {
  const bytes = new Uint8Array(memory.buffer);
  if (pointer === 0) {
    throw new RustCopcParseError('serialization', 'Rust CRS could not allocate a response');
  }
  if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer >= bytes.length) {
    throw new RustCopcParseError('invalid-input', 'Rust CRS returned an invalid response pointer');
  }
  let end = pointer;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  if (end === bytes.length) {
    throw new RustCopcParseError('invalid-input', 'Rust CRS returned an unterminated response');
  }
  return new TextDecoder().decode(bytes.subarray(pointer, end));
}

function parseResponse<T>(wasm: CopcWasmExports, pointer: number): T {
  try {
    const response = JSON.parse(readCString(wasm.memory, pointer)) as RustResponse<T>;
    if (!response.ok || response.value === undefined) {
      throw new RustCopcParseError(
        response.error?.code ?? 'invalid-input',
        response.error?.message ?? 'Rust CRS returned an invalid error response',
      );
    }
    return response.value;
  } finally {
    wasm.free_parser_json(pointer);
  }
}

function hasGeographicBounds(metadata: Pick<CopcMetadata, 'bounds'>): boolean {
  const { minX, minY, maxX, maxY } = metadata.bounds;
  return minX >= -180 && maxX <= 180 && minY >= -90 && maxY <= 90;
}

/**
 * Reusable TypeScript/WASM handle for a dataset's Rust CRS path.
 *
 * The class is intentionally opt-in while proj4js remains the existing
 * runtime reference path. A Worker can keep one instance for all node jobs
 * belonging to the same dataset.
 */
export class RustCrsTransformer {
  private readonly wasm: CopcWasmExports;
  private readonly handle: RustCrsHandle;

  private constructor(wasm: CopcWasmExports, handle: RustCrsHandle) {
    this.wasm = wasm;
    this.handle = handle;
  }

  /**
   * Create a reusable Rust/WASM transform handle from source CRS metadata.
   *
   * Geographic bounds may use the built-in geographic path when WKT is absent;
   * projected bounds require WKT. The supplied height correction is applied to
   * WGS84 ellipsoidal height in metres.
   *
   * @throws `RangeError` if `heightOffsetMeters` is not finite.
   * @throws `CopcWasmError` if the WASM asset cannot be fetched, compiled, or instantiated.
   * @throws `RustCopcParseError` if projected WKT is missing, WKT parsing fails,
   * or Rust rejects CRS creation.
   */
  static async fromMetadata(
    metadata: Pick<CopcMetadata, 'wkt' | 'bounds'>,
    heightOffsetMeters = 0,
  ): Promise<RustCrsTransformer> {
    const heightOffset = resolveHeightOffsetMeters(heightOffsetMeters);
    const wasm = await loadCopcWasm();
    let responsePointer: number;
    let wktPointer = 0;
    let wktLength = 0;

    try {
      if (metadata.wkt) {
        const bytes = new TextEncoder().encode(metadata.wkt);
        wktLength = bytes.byteLength;
        wktPointer = requireRustWasmPointer(wasm.alloc_bytes(wktLength), wktLength, 'CRS WKT');
        new Uint8Array(wasm.memory.buffer, wktPointer, wktLength).set(bytes);
        responsePointer = wasm.create_crs_transform_with_height_offset_json(
          wktPointer,
          wktLength,
          heightOffset,
        );
      } else if (hasGeographicBounds(metadata)) {
        responsePointer = wasm.create_geographic_crs_transform_with_height_offset_json(heightOffset);
      } else {
        throw new RustCopcParseError(
          'missing-wkt',
          'COPC metadata WKT is required for projected source coordinates',
        );
      }
      return new RustCrsTransformer(wasm, parseResponse<RustCrsHandle>(wasm, responsePointer));
    } finally {
      if (wktLength > 0) wasm.dealloc_bytes(wktPointer, wktLength);
    }
  }

  /**
   * Transform interleaved source-CRS XYZ triples to geographic and ECEF buffers.
   *
   * Source X/Y/Z units follow the dataset CRS. The outputs use longitude and
   * latitude degrees with ellipsoidal metres, and WGS84 ECEF metres.
   *
   * @throws `RustCopcParseError` if the input is not XYZ triples, the handle was disposed, or Rust rejects the data.
   */
  transform(sourceCoordinates: Float64Array): RustPreparedCoordinateBuffer {
    if (sourceCoordinates.length % 3 !== 0) {
      throw new RustCopcParseError(
        'invalid-value',
        'source coordinate buffer must contain XYZ triples',
      );
    }
    if (this.handle.handle === 0) {
      throw new RustCopcParseError('invalid-input', 'Rust CRS transformer has been disposed');
    }
    if (sourceCoordinates.length === 0) {
      return {
        pointCount: 0,
        geographicCoordinates: new Float64Array(),
        ecefCoordinates: new Float64Array(),
        verticalUnitScale: this.handle.vertical_unit_scale,
        usedHorizontalFallback: this.handle.used_horizontal_fallback,
      };
    }

    const coordinateLength = sourceCoordinates.length;
    let inputPointer = 0;
    let geographicPointer = 0;
    let ecefPointer = 0;
    try {
      inputPointer = requireRustWasmPointer(
        this.wasm.alloc_f64(coordinateLength),
        coordinateLength,
        'CRS input coordinates',
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
      new Float64Array(this.wasm.memory.buffer, inputPointer, coordinateLength).set(sourceCoordinates);
      const responsePointer = this.wasm.transform_crs_points_json(
        this.handle.handle,
        inputPointer,
        coordinateLength,
        geographicPointer,
        ecefPointer,
      );
      const response = parseResponse<RustCrsTransformResult>(this.wasm, responsePointer);
      const returnedCoordinateLength = Number.isSafeInteger(response.point_count)
        && response.point_count >= 0
        && response.point_count <= Number.MAX_SAFE_INTEGER / 3
        ? response.point_count * 3
        : Number.NaN;
      if (returnedCoordinateLength !== coordinateLength) {
        throw new RustCopcParseError(
          'chunk-length-mismatch',
          `Rust CRS returned ${response.point_count} points; expected ${coordinateLength / 3}`,
        );
      }
      return {
        pointCount: response.point_count,
        geographicCoordinates: Float64Array.from(
          new Float64Array(this.wasm.memory.buffer, geographicPointer, coordinateLength),
        ),
        ecefCoordinates: Float64Array.from(
          new Float64Array(this.wasm.memory.buffer, ecefPointer, coordinateLength),
        ),
        verticalUnitScale: this.handle.vertical_unit_scale,
        usedHorizontalFallback: this.handle.used_horizontal_fallback,
      };
    } finally {
      if (inputPointer) this.wasm.dealloc_f64(inputPointer, coordinateLength);
      if (geographicPointer) this.wasm.dealloc_f64(geographicPointer, coordinateLength);
      if (ecefPointer) this.wasm.dealloc_f64(ecefPointer, coordinateLength);
    }
  }

  /** Release the dataset-specific Rust CRS handle; repeated calls are harmless. */
  dispose(): void {
    if (this.handle.handle !== 0) {
      this.wasm.free_crs_transform(this.handle.handle);
      this.handle.handle = 0;
    }
  }
}
