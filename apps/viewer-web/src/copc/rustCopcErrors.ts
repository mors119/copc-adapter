/** Rust parser and WASM-boundary validation codes; unknown future codes remain strings. */
export type RustCopcParseErrorCode =
  /** Request data or ABI arguments are malformed. */
  | 'invalid-input'
  /** Input bytes ended before the requested structure was complete. */
  | 'truncated'
  /** LAS/COPC header fields are inconsistent or invalid. */
  | 'invalid-header'
  /** A parsed value is outside the supported domain. */
  | 'unsupported-value'
  /** A required value violates the format's structural constraints. */
  | 'invalid-value'
  /** Required COPC info metadata is absent. */
  | 'missing-copc-info'
  /** COPC info record is malformed. */
  | 'malformed-copc-info'
  /** CRS WKT could not be parsed. */
  | 'malformed-wkt'
  /** Hierarchy entry or page data is invalid. */
  | 'invalid-hierarchy'
  /** A checked offset, length, or count calculation overflowed. */
  | 'overflow'
  /** Memory allocation failed. */
  | 'allocation'
  /** Rust could not serialize a response. */
  | 'serialization'
  /** Other parser code retained for forward compatibility. */
  | string;

/** Structured validation failure returned by the Rust COPC parser. */
export class RustCopcParseError extends Error {
  /** Parser-owned machine-readable failure code. */
  readonly code: RustCopcParseErrorCode;

  /** Create a structured parser error and preserve an optional cause. */
  constructor(code: RustCopcParseErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RustCopcParseError';
    this.code = code;
  }
}

export function requireRustWasmPointer(pointer: number, length: number, what: string): number {
  if (!Number.isSafeInteger(pointer) || pointer < 0 || (length > 0 && pointer === 0)) {
    throw new RustCopcParseError('allocation', `Rust WASM allocation for ${what} failed`);
  }
  return pointer;
}
