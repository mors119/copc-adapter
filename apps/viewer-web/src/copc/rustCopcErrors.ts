export type RustCopcParseErrorCode =
  | 'invalid-input'
  | 'truncated'
  | 'invalid-header'
  | 'unsupported-value'
  | 'invalid-value'
  | 'missing-copc-info'
  | 'malformed-copc-info'
  | 'malformed-wkt'
  | 'invalid-hierarchy'
  | 'overflow'
  | 'allocation'
  | 'serialization'
  | string;

/** Structured validation failure returned by the Rust COPC parser. */
export class RustCopcParseError extends Error {
  readonly code: RustCopcParseErrorCode;

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
