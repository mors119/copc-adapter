import { RangeSourceError, type ByteRange } from './types';

export type ParsedContentRange = {
  readonly start: number;
  readonly end: number;
  readonly total?: number;
};

export type ContentRangeParseResult =
  | { readonly ok: true; readonly value: ParsedContentRange }
  | { readonly ok: false; readonly message: string };

/** Parse the syntax without applying a request-specific range constraint. */
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

/** Apply the same exact-range contract used by HttpRangeByteSource. */
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
