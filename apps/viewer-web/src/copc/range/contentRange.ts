import { RangeSourceError, type ByteRange } from './types';

/** Numeric byte interval and optional total resource size parsed from a header. */
export type ParsedContentRange = {
  /** First byte offset, inclusive. */
  readonly start: number;
  /** Last byte offset, inclusive. */
  readonly end: number;
  /** Total resource size in bytes when the header specifies it. */
  readonly total?: number;
};

/** Parse success or a non-throwing syntax/value failure description. */
export type ContentRangeParseResult =
  | { readonly ok: true; readonly value: ParsedContentRange }
  | { readonly ok: false; readonly message: string };

/**
 * Parse `Content-Range: bytes start-end/total` without a request-specific check.
 *
 * A `*` total is represented by an omitted `total` property. Malformed or
 * unsafe numeric fields are returned as `{ ok: false }`.
 */
export function parseContentRangeHeader(
  value: string | null,
): ContentRangeParseResult {
  if (!value) {
    return {
      ok: false,
      message: 'A 206 response must include a Content-Range header',
    };
  }

  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) {
    return {
      ok: false,
      message: `Malformed Content-Range header: ${value}`,
    };
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? undefined : Number(match[3]);
  const length = end - start + 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || !Number.isSafeInteger(length)
    || end < start
    || (total !== undefined && (!Number.isSafeInteger(total) || total <= end))
  ) {
    return {
      ok: false,
      message: `Invalid Content-Range values: ${value}`,
    };
  }

  return { ok: true, value: { start, end, total } };
}

/**
 * Validate that a Content-Range header describes the exact requested interval.
 *
 * @throws `RangeSourceError` with code `content-range` for absent, malformed,
 * unsafe, or mismatched range values.
 */
export function validateContentRange(
  source: string,
  range: ByteRange,
  value: string | null,
  status: number,
): ParsedContentRange {
  const parsed = parseContentRangeHeader(value);
  if (!parsed.ok) {
    throw new RangeSourceError(
      'content-range',
      parsed.message,
      { source, offset: range.offset, length: range.length, status },
    );
  }

  const expectedEnd = range.offset + range.length - 1;
  const matchesRequest = parsed.value.start === range.offset
    && parsed.value.end === expectedEnd;
  if (!matchesRequest) {
    throw new RangeSourceError(
      'content-range',
      `Content-Range does not match bytes=${range.offset}-${expectedEnd}: ${value}`,
      { source, offset: range.offset, length: range.length, status },
    );
  }

  return parsed.value;
}
