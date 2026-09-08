import type { CopcMetadata } from '../../copc/types/copc';
import { RustCopcParseError } from '../../copc/rustCopcErrors';
import { loadCopcWasm, type CopcWasmExports } from '../../wasm/copcWasm';

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

export type RustPreparedCoordinateBuffer = {
  pointCount: number;
  geographicCoordinates: Float64Array;
  ecefCoordinates: Float64Array;
  verticalUnitScale: number;
  usedHorizontalFallback: boolean;
};

function readCString(memory: WebAssembly.Memory, pointer: number): string {
  const bytes = new Uint8Array(memory.buffer);
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

  static async fromMetadata(metadata: Pick<CopcMetadata, 'wkt' | 'bounds'>): Promise<RustCrsTransformer> {
    const wasm = await loadCopcWasm();
    let responsePointer: number;
    let wktPointer = 0;
    let wktLength = 0;

    if (metadata.wkt) {
      const bytes = new TextEncoder().encode(metadata.wkt);
      wktLength = bytes.byteLength;
      wktPointer = wasm.alloc_bytes(wktLength);
      new Uint8Array(wasm.memory.buffer, wktPointer, wktLength).set(bytes);
      responsePointer = wasm.create_crs_transform_json(wktPointer, wktLength);
    } else if (hasGeographicBounds(metadata)) {
      responsePointer = wasm.create_geographic_crs_transform_json();
    } else {
      throw new RustCopcParseError(
        'missing-wkt',
        'COPC metadata WKT is required for projected source coordinates',
      );
    }

    try {
      return new RustCrsTransformer(wasm, parseResponse<RustCrsHandle>(wasm, responsePointer));
    } finally {
      if (wktLength > 0) wasm.dealloc_bytes(wktPointer, wktLength);
    }
  }

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
    const inputPointer = this.wasm.alloc_f64(coordinateLength);
    const geographicPointer = this.wasm.alloc_f64(coordinateLength);
    const ecefPointer = this.wasm.alloc_f64(coordinateLength);
    try {
      new Float64Array(this.wasm.memory.buffer, inputPointer, coordinateLength).set(sourceCoordinates);
      const responsePointer = this.wasm.transform_crs_points_json(
        this.handle.handle,
        inputPointer,
        coordinateLength,
        geographicPointer,
        ecefPointer,
      );
      const response = parseResponse<RustCrsTransformResult>(this.wasm, responsePointer);
      if (response.point_count * 3 !== coordinateLength) {
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
      this.wasm.dealloc_f64(inputPointer, coordinateLength);
      this.wasm.dealloc_f64(geographicPointer, coordinateLength);
      this.wasm.dealloc_f64(ecefPointer, coordinateLength);
    }
  }

  dispose(): void {
    if (this.handle.handle !== 0) {
      this.wasm.free_crs_transform(this.handle.handle);
      this.handle.handle = 0;
    }
  }
}
