/** A non-empty byte interval using an inclusive HTTP range end. */
export type ByteRange = {
  /** Zero-based byte offset from the start of the resource. */
  readonly offset: number;
  /** Positive number of bytes to read. The represented interval is inclusive at its HTTP end. */
  readonly length: number;
};

/** Cancellation options for one or more byte-range reads. */
export type RangeReadOptions = {
  /** Cancels this read when aborted; a source may have shared cached work. */
  readonly signal?: AbortSignal;
};

/** Validation policy requested for HTTP byte sources; defaults to `head-fallback`. */
export type RangeValidationPolicy =
  /** Require a valid partial-content response and readable, matching Content-Range; never use HEAD fallback. */
  | "strict"
  /** Use limited HEAD checks only when JavaScript cannot read Content-Range. */
  | "head-fallback";

/** Validation assurance observed by a source probe or HTTP byte source. */
export type RangeValidationLevel =
  /** The source satisfied the strict byte-range response checks. */
  | "strict"
  /** The source was accepted using a compatibility path with reduced assurance. */
  | "compatibility-limited"
  /** The source did not satisfy the required range semantics. */
  | "incompatible"
  /** The probe could not establish the source's range semantics. */
  | "unknown";

/** Fetch-compatible function injected into an HTTP range source. */
export type RangeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Stable machine-readable failure categories raised by random-access sources. */
export type RangeSourceErrorCode =
  /** Offset/length is invalid or exceeds safe integer arithmetic. */
  | "invalid-range"
  /** The requested interval extends beyond the known resource size. */
  | "out-of-bounds"
  /** The read was cancelled through its AbortSignal. */
  | "aborted"
  /** Fetch failed before an HTTP response was received. */
  | "network"
  /** The server returned an unsuccessful status for the range request. */
  | "http-status"
  /** The server returned the whole representation instead of the requested range. */
  | "whole-file-response"
  /** The requested interval exceeds the configured per-range byte limit. */
  | "range-too-large"
  /** Resource size could not be established from HEAD metadata. */
  | "head-metadata"
  /** The resource size changed during the source lifetime. */
  | "source-size-changed"
  /** The resource representation changed while it was being read. */
  | "source-changed"
  /** The response representation is unsupported or inconsistent. */
  | "representation"
  /** The Content-Range header is missing or does not match the request. */
  | "content-range"
  /** The response body length differs from the requested range length. */
  | "body-length";

/** Context attached to a structured random-access source failure. */
export type RangeSourceErrorDetails = {
  /** Resource identifier, redacted before it is exposed on the error. */
  readonly source: string;
  /** Requested byte offset, when the failure concerns one range. */
  readonly offset?: number;
  /** Requested or configured byte length, when applicable. */
  readonly length?: number;
  /** HTTP response status, when a response was received. */
  readonly status?: number;
};

/** Default maximum range length: 64 MiB. */
export const DEFAULT_MAX_RANGE_BYTES = 64 * 1024 * 1024;
/** Default maximum of four concurrent HTTP ranges per source. */
export const DEFAULT_MAX_CONCURRENT_RANGE_REQUESTS = 4;

/**
 * Resolve the configured per-range byte ceiling.
 *
 * @param source Resource identity used when constructing a validation error.
 * @param requested Positive safe integer override; defaults to 64 MiB.
 * @returns The effective maximum range length in bytes.
 * @throws `RangeSourceError` with code `invalid-range` for an invalid override.
 */
export function resolveMaxRangeBytes(
  source: string,
  requested?: number,
): number {
  const maximum = requested ?? DEFAULT_MAX_RANGE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RangeSourceError(
      "invalid-range",
      "maxRangeBytes must be a positive safe integer",
      { source, length: maximum },
    );
  }
  return maximum;
}

/**
 * Resolve the configured per-source HTTP range concurrency.
 *
 * @param source Resource identity used when constructing a validation error.
 * @param requested Positive safe integer override; defaults to four requests.
 * @returns The effective maximum number of concurrent range requests.
 * @throws `RangeSourceError` with code `invalid-range` for an invalid override.
 */
export function resolveMaxConcurrentRangeRequests(
  source: string,
  requested?: number,
): number {
  const maximum = requested ?? DEFAULT_MAX_CONCURRENT_RANGE_REQUESTS;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RangeSourceError(
      "invalid-range",
      "maxConcurrentRangeRequests must be a positive safe integer",
      { source, length: maximum },
    );
  }
  return maximum;
}

/**
 * Resolve a byte ceiling that fits the WASM u32 range-length field.
 *
 * @returns The requested/default ceiling capped at `0xffff_ffff` bytes.
 */
export function resolveWasmMaxRangeBytes(
  source: string,
  requested?: number,
): number {
  return Math.min(resolveMaxRangeBytes(source, requested), 0xffff_ffff);
}

/** Remove URL credentials and query/fragment values before exposing diagnostics. */
export function redactSourceForDiagnostics(source: string): string {
  if (source.startsWith("//")) {
    try {
      const url = new URL(source, "https://diagnostic.invalid");
      return `//${url.host}${url.pathname}`;
    } catch {
      return (
        source.split(/[?#]/, 1)[0].replace(/^\/\/[^/]*@/, "//") || "[source]"
      );
    }
  }

  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return source.split(/[?#]/, 1)[0] || "[source]";
  }
}

/** Structured failure from a random-access byte source. */
export class RangeSourceError extends Error {
  /** Stable machine-readable failure category. */
  readonly code: RangeSourceErrorCode;
  /** Redacted resource identifier. Credentials and query/fragment data are removed. */
  readonly source: string;
  /** Byte offset associated with the failure, when available. */
  readonly offset?: number;
  /** Byte length associated with the failure, when available. */
  readonly length?: number;
  /** HTTP status associated with the failure, when available. */
  readonly status?: number;

  /** Create a structured range-source failure and preserve an optional cause. */
  constructor(
    code: RangeSourceErrorCode,
    message: string,
    details: RangeSourceErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RangeSourceError";
    this.code = code;
    this.source = redactSourceForDiagnostics(details.source);
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
  /** Resource identifier used for diagnostics; implementations should redact secrets. */
  readonly source: string;
  /** Read exactly one byte interval or reject with a source error. */
  readRange(
    offset: number,
    length: number,
    options?: RangeReadOptions,
  ): Promise<Uint8Array>;
  /** Read several ranges, preserving the input order in the returned array. */
  readRanges(
    ranges: readonly ByteRange[],
    options?: RangeReadOptions,
  ): Promise<Uint8Array[]>;
  /** Return the known resource size in bytes, or `undefined` when it is unknown. */
  size(): Promise<number | undefined>;
}

/** A caller-supplied URL, Blob/File, or random-access source for COPC data. */
export type CopcInputSource = string | Blob | RandomAccessByteSource;

/**
 * Validate a positive byte interval using safe integer bounds.
 *
 * @throws `RangeSourceError` with code `invalid-range` for an invalid or unsafe interval.
 */
export function validateByteRange(
  source: string,
  offset: number,
  length: number,
): ByteRange {
  const validOffset = Number.isSafeInteger(offset) && offset >= 0;
  const validLength = Number.isSafeInteger(length) && length > 0;
  const fitsSafeInteger =
    validOffset &&
    validLength &&
    offset <= Number.MAX_SAFE_INTEGER - length + 1;

  if (!validOffset || !validLength || !fitsSafeInteger) {
    throw new RangeSourceError(
      "invalid-range",
      `Invalid byte range: offset=${offset}, length=${length}`,
      { source, offset, length },
    );
  }

  return { offset, length };
}
