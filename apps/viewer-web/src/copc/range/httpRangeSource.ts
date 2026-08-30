import {
  RangeSourceError,
  type ByteRange,
  type RangeFetch,
  type RangeReadOptions,
  type RandomAccessByteSource,
  validateByteRange,
} from './types';
import { validateContentRange } from './contentRange';

export type HttpRangeByteSourceOptions = {
  readonly fetch?: RangeFetch;
  readonly headers?: HeadersInit;
  readonly size?: number;
};

function rangeDetails(source: string, range: ByteRange, status?: number) {
  return {
    source,
    offset: range.offset,
    length: range.length,
    status,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}

/** HTTP implementation of the project-owned random-access byte source. */
export class HttpRangeByteSource implements RandomAccessByteSource {
  readonly source: string;
  private readonly fetchImpl: RangeFetch;
  private readonly headers: Headers;
  private knownSize: number | undefined;

  constructor(source: string, options: HttpRangeByteSourceOptions = {}) {
    this.source = source;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = new Headers(options.headers);

    if (options.size !== undefined) {
      if (!Number.isSafeInteger(options.size) || options.size < 0) {
        throw new RangeSourceError(
          'invalid-range',
          `Invalid source size: ${options.size}`,
          { source },
        );
      }
      this.knownSize = options.size;
    }
  }

  async size(): Promise<number | undefined> {
    return this.knownSize;
  }

  async readRange(
    offset: number,
    length: number,
    options: RangeReadOptions = {},
  ): Promise<Uint8Array> {
    const range = validateByteRange(this.source, offset, length);
    const end = offset + length - 1;

    if (this.knownSize !== undefined && end >= this.knownSize) {
      throw new RangeSourceError(
        'out-of-bounds',
        `Requested bytes=${offset}-${end} exceed source size ${this.knownSize}`,
        rangeDetails(this.source, range),
      );
    }

    const requestHeaders = new Headers(this.headers);
    requestHeaders.set('Range', `bytes=${offset}-${end}`);

    let response: Response;
    try {
      response = await this.fetchImpl(this.source, {
        headers: requestHeaders,
        signal: options.signal,
      });
    } catch (error: unknown) {
      if (options.signal?.aborted || isAbortError(error)) {
        throw new RangeSourceError(
          'aborted',
          `Range request aborted for bytes=${offset}-${end}`,
          rangeDetails(this.source, range),
          { cause: error },
        );
      }

      throw new RangeSourceError(
        'network',
        `Range request failed for bytes=${offset}-${end}`,
        rangeDetails(this.source, range),
        { cause: error },
      );
    }

    if (response.status === 200) {
      throw new RangeSourceError(
        'whole-file-response',
        'The server ignored the Range request and returned the whole resource (200)',
        rangeDetails(this.source, range, response.status),
      );
    }

    if (response.status !== 206) {
      throw new RangeSourceError(
        'http-status',
        `Range request failed with HTTP ${response.status}`,
        rangeDetails(this.source, range, response.status),
      );
    }

    const contentRange = validateContentRange(
      this.source,
      range,
      response.headers.get('Content-Range'),
      response.status,
    );

    if (contentRange.total !== undefined) {
      this.knownSize = contentRange.total;
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error: unknown) {
      throw new RangeSourceError(
        'network',
        `Failed to read the range response for bytes=${offset}-${end}`,
        rangeDetails(this.source, range, response.status),
        { cause: error },
      );
    }

    if (bytes.byteLength !== length) {
      throw new RangeSourceError(
        'body-length',
        `Range response returned ${bytes.byteLength} bytes; expected ${length}`,
        rangeDetails(this.source, range, response.status),
      );
    }

    return bytes;
  }

  async readRanges(
    ranges: readonly ByteRange[],
    options: RangeReadOptions = {},
  ): Promise<Uint8Array[]> {
    const validatedRanges = ranges.map(({ offset, length }) =>
      validateByteRange(this.source, offset, length));

    return Promise.all(
      validatedRanges.map(({ offset, length }) =>
        this.readRange(offset, length, options)),
    );
  }
}
