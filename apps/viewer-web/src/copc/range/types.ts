/** A non-empty byte interval using an inclusive HTTP range end. */
export type ByteRange = {
  readonly offset: number;
  readonly length: number;
};

export type RangeReadOptions = {
  readonly signal?: AbortSignal;
};

export type RangeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type RangeSourceErrorCode =
  | 'invalid-range'
  | 'out-of-bounds'
  | 'aborted'
  | 'network'
  | 'http-status'
  | 'whole-file-response'
  | 'content-range'
  | 'body-length';

export type RangeSourceErrorDetails = {
  readonly source: string;
  readonly offset?: number;
  readonly length?: number;
  readonly status?: number;
};

/** Structured failure from a random-access byte source. */
export class RangeSourceError extends Error {
  readonly code: RangeSourceErrorCode;
  readonly source: string;
  readonly offset?: number;
  readonly length?: number;
  readonly status?: number;

  constructor(
    code: RangeSourceErrorCode,
    message: string,
    details: RangeSourceErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RangeSourceError';
    this.code = code;
    this.source = details.source;
    this.offset = details.offset;
    this.length = details.length;
    this.status = details.status;
  }
}

/**
 * Backend-neutral random-access semantics for COPC readers.
 *
 * Implementations may use HTTP, a local file bridge, a worker, or memory. The
 * interface intentionally contains no Cesium, fetch, or Rust-specific types.
 */
export interface RandomAccessByteSource {
  readonly source: string;
  readRange(
    offset: number,
    length: number,
    options?: RangeReadOptions,
  ): Promise<Uint8Array>;
  readRanges(
    ranges: readonly ByteRange[],
    options?: RangeReadOptions,
  ): Promise<Uint8Array[]>;
  size(): Promise<number | undefined>;
}

export function validateByteRange(
  source: string,
  offset: number,
  length: number,
): ByteRange {
  const validOffset = Number.isSafeInteger(offset) && offset >= 0;
  const validLength = Number.isSafeInteger(length) && length > 0;
  const fitsSafeInteger = validOffset
    && validLength
    && offset <= Number.MAX_SAFE_INTEGER - length + 1;

  if (!validOffset || !validLength || !fitsSafeInteger) {
    throw new RangeSourceError(
      'invalid-range',
      `Invalid byte range: offset=${offset}, length=${length}`,
      { source, offset, length },
    );
  }

  return { offset, length };
}
