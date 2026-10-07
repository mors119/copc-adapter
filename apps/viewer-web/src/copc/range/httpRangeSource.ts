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

// Merge only same-turn reads, with a small gap and a strict per-fetch byte cap.
const MAX_COALESCED_RANGE_GAP_BYTES = 4 * 1024;
const MAX_COALESCED_RANGE_BYTES = 1024 * 1024;

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
  private knownSize: number | undefined;
  private pendingReads: PendingRangeRead[] = [];
  private flushScheduled = false;

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
      validateByteRange(this.source, offset, length));

    return Promise.all(
      validatedRanges.map(({ offset, length }) =>
        this.readRange(offset, length, options)),
    );
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flushPendingReads());
  }

  private flushPendingReads(): void {
    this.flushScheduled = false;
    const pending = this.pendingReads.splice(0).filter((read) => !read.settled);
    for (const plannedGroup of coalescePendingReads(pending)) {
      const activeGroup: PendingRangeGroup = {
        ...plannedGroup,
        controller: new AbortController(),
      };
      for (const member of activeGroup.members) member.group = activeGroup;

      void this.fetchRange(activeGroup.range, activeGroup.controller.signal)
        .then((bytes) => {
          for (const member of activeGroup.members) {
            if (member.settled) continue;
            const start = member.range.offset - activeGroup.range.offset;
            const end = start + member.range.length;
            this.resolvePendingRead(member, bytes.slice(start, end));
          }
        })
        .catch((error: unknown) => {
          for (const member of activeGroup.members) {
            if (member.settled) continue;
            this.rejectPendingRead(member, this.errorForRange(error, member.range));
          }
        });
    }

    if (this.pendingReads.length > 0) this.scheduleFlush();
  }

  private cancelPendingRead(read: PendingRangeRead): void {
    if (read.settled) return;
    this.rejectPendingRead(read, this.abortedError(read.range, read.signal?.reason));

    const group = read.group;
    if (group && group.members.every((member) => member.settled)) {
      group.controller.abort(read.signal?.reason);
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
      if (signal.aborted || isAbortError(error)) {
        throw new RangeSourceError(
          'aborted',
          `Range response body aborted for bytes=${range.offset}-${end}`,
          rangeDetails(this.source, range, response.status),
          { cause: error },
        );
      }
      throw new RangeSourceError(
        'network',
        `Failed to read the range response for bytes=${range.offset}-${end}`,
        rangeDetails(this.source, range, response.status),
        { cause: error },
      );
    }

    if (bytes.byteLength !== range.length) {
      throw new RangeSourceError(
        'body-length',
        `Range response returned ${bytes.byteLength} bytes; expected ${range.length}`,
        rangeDetails(this.source, range, response.status),
      );
    }

    return bytes;
  }
}

function coalescePendingReads(reads: PendingRangeRead[]): PlannedRangeGroup[] {
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
      && mergedLength <= MAX_COALESCED_RANGE_BYTES) {
      group.members.push(read);
      group.range = { offset: groupOffset, length: mergedLength };
    } else {
      groups.push({ range: read.range, members: [read] });
    }
  }

  return groups;
}
