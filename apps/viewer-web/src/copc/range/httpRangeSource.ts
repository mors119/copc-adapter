import {
  RangeSourceError,
  resolveMaxConcurrentRangeRequests,
  type ByteRange,
  type RangeFetch,
  type RangeReadOptions,
  type RangeValidationPolicy,
  type RandomAccessByteSource,
  resolveMaxRangeBytes,
  validateByteRange,
} from './types';
import { validateContentRange } from './contentRange';

export type HttpRangeByteSourceOptions = {
  readonly fetch?: RangeFetch;
  readonly headers?: HeadersInit;
  readonly size?: number;
  /** Defaults to strict, request-matching Content-Range validation. */
  readonly rangeValidation?: RangeValidationPolicy;
  /** Per-range byte ceiling. Defaults to 64 MiB; explicit values accept any positive safe integer. */
  readonly maxRangeBytes?: number;
  /** Maximum active HTTP ranges per source. Defaults to 4; any positive safe integer is accepted. */
  readonly maxConcurrentRangeRequests?: number;
};

// Merge only same-turn reads, with a small gap and a strict per-fetch byte cap.
const MAX_COALESCED_RANGE_GAP_BYTES = 4 * 1024;
const MAX_COALESCED_RANGE_BYTES = 1024 * 1024;
type HeadMetadata = {
  readonly size: number;
  readonly etag?: string;
  readonly lastModified?: string;
};

type PendingHeadRequest = {
  readonly controller: AbortController;
  readonly promise: Promise<HeadMetadata>;
  readonly waiters: Set<symbol>;
};

type PendingRangeRead = {
  readonly range: ByteRange;
  readonly signal?: AbortSignal;
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (error: RangeSourceError) => void;
  abortListener?: () => void;
  group?: PendingRangeGroup;
  settled: boolean;
};

type PendingRangeGroup = {
  readonly range: ByteRange;
  readonly members: PendingRangeRead[];
  readonly controller: AbortController;
  started: boolean;
};

type PlannedRangeGroup = {
  range: ByteRange;
  members: PendingRangeRead[];
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
  private readonly rangeValidation: RangeValidationPolicy;
  private readonly maxRangeBytes: number;
  private readonly maxConcurrentRangeRequests: number;
  private knownSize: number | undefined;
  private knownETag: string | undefined;
  private knownLastModified: string | undefined;
  private headMetadata: HeadMetadata | undefined;
  private pendingHeadRequest: PendingHeadRequest | undefined;
  private pendingReads: PendingRangeRead[] = [];
  private pendingRangeGroups: PendingRangeGroup[] = [];
  private activeRangeFetches = 0;
  private flushScheduled = false;

  constructor(source: string, options: HttpRangeByteSourceOptions = {}) {
    this.source = source;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = new Headers(options.headers);
    this.rangeValidation = options.rangeValidation ?? 'strict';
    this.maxRangeBytes = resolveMaxRangeBytes(source, options.maxRangeBytes);
    this.maxConcurrentRangeRequests = resolveMaxConcurrentRangeRequests(
      source,
      options.maxConcurrentRangeRequests,
    );

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
    const range = this.validateReadRange(offset, length);
    const end = range.offset + range.length - 1;

    if (this.knownSize !== undefined && end >= this.knownSize) {
      throw new RangeSourceError(
        'out-of-bounds',
        `Requested bytes=${offset}-${end} exceed source size ${this.knownSize}`,
        rangeDetails(this.source, range),
      );
    }

    if (options.signal?.aborted) {
      throw this.abortedError(range, options.signal.reason);
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const pending: PendingRangeRead = {
        range,
        signal: options.signal,
        resolve,
        reject,
        settled: false,
      };

      if (options.signal) {
        pending.abortListener = () => this.cancelPendingRead(pending);
        options.signal.addEventListener('abort', pending.abortListener, { once: true });
        if (options.signal.aborted) {
          this.cancelPendingRead(pending);
          return;
        }
      }

      this.pendingReads.push(pending);
      this.scheduleFlush();
    });
  }

  async readRanges(
    ranges: readonly ByteRange[],
    options: RangeReadOptions = {},
  ): Promise<Uint8Array[]> {
    const validatedRanges = ranges.map(({ offset, length }) =>
      this.validateReadRange(offset, length));

    return Promise.all(
      validatedRanges.map(({ offset, length }) =>
        this.readRange(offset, length, options)),
    );
  }

  private validateReadRange(offset: number, length: number): ByteRange {
    const range = validateByteRange(this.source, offset, length);
    if (range.length > this.maxRangeBytes) {
      throw new RangeSourceError(
        'range-too-large',
        `Requested range length ${range.length} exceeds the ${this.maxRangeBytes}-byte HTTP read limit`,
        rangeDetails(this.source, range),
      );
    }
    return range;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flushPendingReads());
  }

  private flushPendingReads(): void {
    this.flushScheduled = false;
    const pending = this.pendingReads.splice(0).filter((read) => !read.settled);
    for (const plannedGroup of coalescePendingReads(
      pending,
      Math.min(MAX_COALESCED_RANGE_BYTES, this.maxRangeBytes),
    )) {
      const activeGroup: PendingRangeGroup = {
        ...plannedGroup,
        controller: new AbortController(),
        started: false,
      };
      for (const member of activeGroup.members) member.group = activeGroup;
      this.pendingRangeGroups.push(activeGroup);
    }

    this.startPendingRangeGroups();
    if (this.pendingReads.length > 0) this.scheduleFlush();
  }

  private startPendingRangeGroups(): void {
    while (
      this.activeRangeFetches < this.maxConcurrentRangeRequests
      && this.pendingRangeGroups.length > 0
    ) {
      const group = this.pendingRangeGroups.shift();
      if (!group || group.members.every((member) => member.settled)) continue;

      group.started = true;
      this.activeRangeFetches += 1;
      void this.fetchRange(group.range, group.controller.signal)
        .then((bytes) => {
          for (const member of group.members) {
            if (member.settled) continue;
            const start = member.range.offset - group.range.offset;
            const end = start + member.range.length;
            const result = group.members.length === 1
              && start === 0
              && end === bytes.byteLength
              ? bytes
              : bytes.slice(start, end);
            this.resolvePendingRead(member, result);
          }
        })
        .catch((error: unknown) => {
          for (const member of group.members) {
            if (member.settled) continue;
            this.rejectPendingRead(member, this.errorForRange(error, member.range));
          }
        })
        .finally(() => {
          this.activeRangeFetches -= 1;
          this.startPendingRangeGroups();
        });
    }
  }

  private cancelPendingRead(read: PendingRangeRead): void {
    if (read.settled) return;
    this.rejectPendingRead(read, this.abortedError(read.range, read.signal?.reason));

    const group = read.group;
    if (group && group.members.every((member) => member.settled)) {
      group.controller.abort(read.signal?.reason);
      if (!group.started) {
        const pendingIndex = this.pendingRangeGroups.indexOf(group);
        if (pendingIndex >= 0) this.pendingRangeGroups.splice(pendingIndex, 1);
      }
    }
  }

  private resolvePendingRead(read: PendingRangeRead, bytes: Uint8Array): void {
    if (read.settled) return;
    read.settled = true;
    this.disposePendingRead(read);
    read.resolve(bytes);
  }

  private rejectPendingRead(read: PendingRangeRead, error: RangeSourceError): void {
    if (read.settled) return;
    read.settled = true;
    this.disposePendingRead(read);
    read.reject(error);
  }

  private disposePendingRead(read: PendingRangeRead): void {
    if (read.abortListener && read.signal) {
      read.signal.removeEventListener('abort', read.abortListener);
      read.abortListener = undefined;
    }
  }

  private abortedError(range: ByteRange, cause: unknown): RangeSourceError {
    const end = range.offset + range.length - 1;
    return new RangeSourceError(
      'aborted',
      `Range request aborted for bytes=${range.offset}-${end}`,
      rangeDetails(this.source, range),
      { cause },
    );
  }

  private errorForRange(error: unknown, range: ByteRange): RangeSourceError {
    if (error instanceof RangeSourceError) {
      return new RangeSourceError(
        error.code,
        error.message,
        rangeDetails(this.source, range, error.status),
        { cause: error.cause ?? error },
      );
    }

    return new RangeSourceError(
      'network',
      error instanceof Error ? error.message : String(error),
      rangeDetails(this.source, range),
      { cause: error },
    );
  }

  private rememberSize(size: number, range: ByteRange, status?: number): void {
    this.assertSizeMatches(size, range, status);
    this.knownSize = size;
  }

  private assertSizeMatches(size: number, range: ByteRange, status?: number): void {
    if (this.knownSize !== undefined && this.knownSize !== size) {
      throw new RangeSourceError(
        'source-size-changed',
        `The source size changed from ${this.knownSize} to ${size}; reload the source from a stable URL`,
        rangeDetails(this.source, range, status),
      );
    }
  }

  private checkRepresentation(
    headers: Headers,
    range: ByteRange,
    status?: number,
  ): void {
    const contentEncoding = headers.get('Content-Encoding')?.trim().toLowerCase();
    if (contentEncoding && contentEncoding !== 'identity') {
      throw new RangeSourceError(
        'representation',
        `The source uses Content-Encoding: ${contentEncoding}; byte ranges require an identity representation`,
        rangeDetails(this.source, range, status),
      );
    }

    const etag = headers.get('ETag') || undefined;
    const lastModified = headers.get('Last-Modified') || undefined;
    if (this.knownETag && etag && this.knownETag !== etag) {
      throw new RangeSourceError(
        'source-changed',
        'The source ETag changed between range requests; reload the source from a stable URL',
        rangeDetails(this.source, range, status),
      );
    }
    if (this.knownLastModified && lastModified && this.knownLastModified !== lastModified) {
      throw new RangeSourceError(
        'source-changed',
        'The source Last-Modified value changed between range requests; reload the source from a stable URL',
        rangeDetails(this.source, range, status),
      );
    }
  }

  private rememberRepresentation(headers: Headers): void {
    this.knownETag ??= headers.get('ETag') || undefined;
    this.knownLastModified ??= headers.get('Last-Modified') || undefined;
  }

  private async getHeadMetadata(
    range: ByteRange,
    signal: AbortSignal,
  ): Promise<HeadMetadata> {
    if (signal.aborted) {
      throw this.abortedError(range, signal.reason);
    }

    if (this.headMetadata) {
      this.rememberSize(this.headMetadata.size, range);
      this.checkHeadRange(this.headMetadata.size, range);
      return this.headMetadata;
    }

    let request = this.pendingHeadRequest;
    if (!request) {
      const controller = new AbortController();
      const waiters = new Set<symbol>();
      let createdRequest: PendingHeadRequest;
      const promise = this.fetchHeadMetadata(controller.signal, range)
        .then((metadata) => {
          this.rememberSize(metadata.size, range);
          this.headMetadata = metadata;
          return metadata;
        })
        .finally(() => {
          if (this.pendingHeadRequest === createdRequest) {
            this.pendingHeadRequest = undefined;
          }
        });
      createdRequest = { controller, promise, waiters };
      request = createdRequest;
      this.pendingHeadRequest = createdRequest;
    }

    return new Promise<HeadMetadata>((resolve, reject) => {
      const waiter = Symbol('head-metadata-waiter');
      request.waiters.add(waiter);
      let settled = false;

      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
        request.waiters.delete(waiter);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(this.abortedError(range, signal.reason));
        if (request.waiters.size === 0) request.controller.abort(signal.reason);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }

      request.promise.then(
        (metadata) => {
          if (settled) return;
          settled = true;
          cleanup();
          try {
            this.checkHeadRange(metadata.size, range);
            resolve(metadata);
          } catch (error: unknown) {
            reject(error);
          }
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  }

  private checkHeadRange(size: number, range: ByteRange): void {
    const end = range.offset + range.length - 1;
    if (end >= size) {
      throw new RangeSourceError(
        'out-of-bounds',
        `Requested bytes=${range.offset}-${end} exceed the HEAD-reported source size ${size}`,
        rangeDetails(this.source, range, 200),
      );
    }
  }

  private async fetchHeadMetadata(
    signal: AbortSignal,
    range: ByteRange,
  ): Promise<HeadMetadata> {
    const requestHeaders = new Headers(this.headers);
    requestHeaders.delete('Range');

    let response: Response;
    try {
      response = await this.fetchImpl(this.source, {
        method: 'HEAD',
        headers: requestHeaders,
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted || isAbortError(error)) {
        throw this.abortedError(range, error);
      }
      throw new RangeSourceError(
        'head-metadata',
        'HEAD metadata request failed; allow the method through CORS and return a readable Content-Length',
        rangeDetails(this.source, range),
        { cause: error },
      );
    }

    if (!response.ok) {
      await cancelResponseBody(response);
      throw new RangeSourceError(
        'head-metadata',
        `HEAD metadata request returned HTTP ${response.status}; the compatibility path requires a successful HEAD response`,
        rangeDetails(this.source, range, response.status),
      );
    }

    const rawLength = response.headers.get('Content-Length');
    const size = rawLength && /^\d+$/.test(rawLength.trim())
      ? Number(rawLength)
      : Number.NaN;
    if (!Number.isSafeInteger(size) || size <= 0) {
      await cancelResponseBody(response);
      throw new RangeSourceError(
        'head-metadata',
        'HEAD must return a positive, safe-integer Content-Length; check HEAD support and source metadata',
        rangeDetails(this.source, range, response.status),
      );
    }

    this.checkRepresentation(response.headers, range, response.status);
    this.rememberRepresentation(response.headers);
    await cancelResponseBody(response);
    return {
      size,
      ...(response.headers.get('ETag') ? { etag: response.headers.get('ETag')! } : {}),
      ...(response.headers.get('Last-Modified')
        ? { lastModified: response.headers.get('Last-Modified')! }
        : {}),
    };
  }

  private checkHeadRangeIfCached(range: ByteRange): void {
    if (!this.headMetadata) return;
    this.rememberSize(this.headMetadata.size, range);
    this.checkHeadRange(this.headMetadata.size, range);
  }

  private async readExactRangeBody(
    response: Response,
    range: ByteRange,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (signal.aborted) {
      await cancelResponseBody(response);
      throw this.abortedError(range, signal.reason);
    }

    const rawLength = response.headers.get('Content-Length');
    if (rawLength !== null) {
      const declaredLength = /^\d+$/.test(rawLength.trim())
        ? Number(rawLength)
        : Number.NaN;
      if (!Number.isSafeInteger(declaredLength) || declaredLength !== range.length) {
        await cancelResponseBody(response);
        throw new RangeSourceError(
          'body-length',
          `Range response declared Content-Length ${rawLength}; expected ${range.length}`,
          rangeDetails(this.source, range, response.status),
        );
      }
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(range.length);
    } catch (error: unknown) {
      await cancelResponseBody(response);
      throw new RangeSourceError(
        'range-too-large',
        `Could not allocate the bounded ${range.length}-byte range buffer`,
        rangeDetails(this.source, range, response.status),
        { cause: error },
      );
    }

    if (!response.body) {
      throw new RangeSourceError(
        'body-length',
        `Range response body was unavailable; expected ${range.length} bytes`,
        rangeDetails(this.source, range, response.status),
      );
    }

    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = response.body.getReader();
    } catch (error: unknown) {
      await cancelResponseBody(response);
      throw new RangeSourceError(
        'network',
        'Range response body could not be opened for reading',
        rangeDetails(this.source, range, response.status),
        { cause: error },
      );
    }
    let received = 0;
    const cancelOnAbort = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener('abort', cancelOnAbort, { once: true });
    if (signal.aborted) cancelOnAbort();
    try {
      while (true) {
        const next = await reader.read();
        if (signal.aborted) {
          throw this.abortedError(range, signal.reason);
        }
        if (next.done) {
          if (received !== range.length) {
            throw new RangeSourceError(
              'body-length',
              `Range response returned ${received} bytes; expected ${range.length}`,
              rangeDetails(this.source, range, response.status),
            );
          }
          return bytes;
        }

        const remaining = range.length - received;
        if (next.value.byteLength > remaining) {
          throw new RangeSourceError(
            'body-length',
            `Range response exceeded the ${range.length}-byte received-body limit`,
            rangeDetails(this.source, range, response.status),
          );
        }
        bytes.set(next.value, received);
        received += next.value.byteLength;
      }
    } catch (error: unknown) {
      await reader.cancel(error).catch(() => undefined);
      if (error instanceof RangeSourceError) throw error;
      if (signal.aborted || isAbortError(error)) {
        throw new RangeSourceError(
          'aborted',
          `Range response body aborted for bytes=${range.offset}-${range.offset + range.length - 1}`,
          rangeDetails(this.source, range, response.status),
          { cause: error },
        );
      }
      throw new RangeSourceError(
        'network',
        `Failed to read the range response for bytes=${range.offset}-${range.offset + range.length - 1}`,
        rangeDetails(this.source, range, response.status),
        { cause: error },
      );
    } finally {
      signal.removeEventListener('abort', cancelOnAbort);
      reader.releaseLock();
    }
  }

  private async fetchRange(range: ByteRange, signal: AbortSignal): Promise<Uint8Array> {
    const end = range.offset + range.length - 1;
    const requestHeaders = new Headers(this.headers);
    requestHeaders.set('Range', `bytes=${range.offset}-${end}`);

    let response: Response;
    try {
      response = await this.fetchImpl(this.source, {
        headers: requestHeaders,
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted || isAbortError(error)) {
        throw new RangeSourceError(
          'aborted',
          `Range request aborted for bytes=${range.offset}-${end}`,
          rangeDetails(this.source, range),
          { cause: error },
        );
      }

      throw new RangeSourceError(
        'network',
        `Range request failed for bytes=${range.offset}-${end}`,
        rangeDetails(this.source, range),
        { cause: error },
      );
    }

    if (signal.aborted) {
      await cancelResponseBody(response);
      throw this.abortedError(range, signal.reason);
    }

    if (response.status === 200) {
      await cancelResponseBody(response);
      throw new RangeSourceError(
        'whole-file-response',
        'The server ignored the Range request and returned the whole resource (200); full-resource fallback is disabled',
        rangeDetails(this.source, range, response.status),
      );
    }

    if (response.status !== 206) {
      await cancelResponseBody(response);
      throw new RangeSourceError(
        'http-status',
        `Range request failed with HTTP ${response.status}`,
        rangeDetails(this.source, range, response.status),
      );
    }

    try {
      const rawContentRange = response.headers.get('Content-Range');
      let responseSize: number | undefined;
      if (rawContentRange !== null) {
        const contentRange = validateContentRange(
          this.source,
          range,
          rawContentRange,
          response.status,
        );
        if (contentRange.total !== undefined) {
          responseSize = contentRange.total;
          this.assertSizeMatches(responseSize, range, response.status);
        }
      } else if (this.rangeValidation === 'head-fallback') {
        const metadata = await this.getHeadMetadata(range, signal);
        this.rememberSize(metadata.size, range, response.status);
        this.checkHeadRange(metadata.size, range);
      } else {
        validateContentRange(this.source, range, null, response.status);
      }

      this.checkHeadRangeIfCached(range);
      this.checkRepresentation(response.headers, range, response.status);
      this.rememberRepresentation(response.headers);
      const bytes = await this.readExactRangeBody(response, range, signal);
      if (responseSize !== undefined) {
        this.rememberSize(responseSize, range, response.status);
      }
      return bytes;
    } catch (error: unknown) {
      await cancelResponseBody(response);
      throw error;
    }
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function coalescePendingReads(
  reads: PendingRangeRead[],
  maximumMergedBytes: number,
): PlannedRangeGroup[] {
  const ordered = [...reads].sort((left, right) =>
    left.range.offset - right.range.offset || left.range.length - right.range.length);
  const groups: PlannedRangeGroup[] = [];

  for (const read of ordered) {
    const group = groups[groups.length - 1];
    if (!group) {
      groups.push({ range: read.range, members: [read] });
      continue;
    }

    const groupOffset = group.range.offset;
    const groupEnd = groupOffset + group.range.length - 1;
    const readEnd = read.range.offset + read.range.length - 1;
    const gap = Math.max(0, read.range.offset - groupEnd - 1);
    const mergedLength = Math.max(groupEnd, readEnd) - groupOffset + 1;

    if (gap <= MAX_COALESCED_RANGE_GAP_BYTES
      && Number.isSafeInteger(mergedLength)
      && mergedLength <= maximumMergedBytes) {
      group.members.push(read);
      group.range = { offset: groupOffset, length: mergedLength };
    } else {
      groups.push({ range: read.range, members: [read] });
    }
  }

  return groups;
}
