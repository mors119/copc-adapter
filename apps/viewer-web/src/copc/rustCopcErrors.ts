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
