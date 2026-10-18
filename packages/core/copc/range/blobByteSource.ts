import {
  RangeSourceError,
  type ByteRange,
  type RangeReadOptions,
  type RandomAccessByteSource,
  resolveMaxConcurrentRangeRequests,
  resolveMaxRangeBytes,
  validateByteRange,
} from './types';

/** Resource limits applied to Blob/File range reads. */
export type BlobByteSourceOptions = {
  /** Maximum bytes returned by one read. Defaults to 64 MiB. */
  readonly maxRangeBytes?: number;
  /** Maximum active slice reads. Defaults to four. */
  readonly maxConcurrentRangeRequests?: number;
};

type PendingBlobRead = {
  readonly offset: number;
  readonly length: number;
  readonly options: RangeReadOptions;
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (error: unknown) => void;
  abortListener?: () => void;
  started: boolean;
  settled: boolean;
};

/** Random-access Blob/File reads; abort signals are checked before and after each non-cancellable slice read. */
export class BlobByteSource implements RandomAccessByteSource {
  readonly source: string;
  private readonly blob: Blob;
  private readonly maxRangeBytes: number;
  private readonly maxConcurrentRangeRequests: number;
  private readonly pendingReads: PendingBlobRead[] = [];
  private activeReads = 0;

  constructor(blob: Blob, identity?: string, options: BlobByteSourceOptions = {}) {
    if (!blob || typeof blob.slice !== 'function'
      || !Number.isSafeInteger(blob.size) || blob.size < 0) {
      throw new TypeError('BlobByteSource requires a valid Blob or File');
    }
    this.source = identity ?? (typeof File !== 'undefined' && blob instanceof File && blob.name
      ? `file://${encodeURIComponent(blob.name)}`
      : 'blob://local-copc');
    this.blob = blob;
    this.maxRangeBytes = resolveMaxRangeBytes(this.source, options.maxRangeBytes);
    this.maxConcurrentRangeRequests = resolveMaxConcurrentRangeRequests(
      this.source,
      options.maxConcurrentRangeRequests,
    );
  }

  async size(): Promise<number> {
    return this.blob.size;
  }

  async readRange(offset: number, length: number, options: RangeReadOptions = {}): Promise<Uint8Array> {
    this.validateRange(offset, length);
    if (options.signal?.aborted) {
      return Promise.reject(this.abortedError(offset, length));
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const pending: PendingBlobRead = {
        offset,
        length,
        options,
        resolve,
        reject,
        started: false,
        settled: false,
      };
      const signal = options.signal;
      if (signal) {
        pending.abortListener = () => {
          if (pending.started || pending.settled) return;
          pending.settled = true;
          this.removePendingRead(pending);
          reject(this.abortedError(offset, length));
          this.drainPendingReads();
        };
        signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      this.pendingReads.push(pending);
      this.drainPendingReads();
    });
  }

  async readRanges(ranges: readonly ByteRange[], options: RangeReadOptions = {}): Promise<Uint8Array[]> {
    // Validate the entire batch before queueing any work so an invalid member
    // cannot cause avoidable reads to start.
    for (const { offset, length } of ranges) this.validateRange(offset, length);
    if (ranges.length > 0 && options.signal?.aborted) {
      throw this.abortedError(ranges[0]?.offset ?? 0, ranges[0]?.length ?? 0);
    }
    return Promise.all(ranges.map(({ offset, length }) => this.readRange(offset, length, options)));
  }

  private validateRange(offset: number, length: number): void {
    validateByteRange(this.source, offset, length);
    if (length > this.maxRangeBytes) {
      throw new RangeSourceError(
        'range-too-large',
        `Requested range length ${length} exceeds the ${this.maxRangeBytes}-byte Blob read limit`,
        { source: this.source, offset, length },
      );
    }
    const end = offset + length;
    if (end > this.blob.size) {
      throw new RangeSourceError('out-of-bounds', `Requested bytes=${offset}-${end - 1} exceed source size ${this.blob.size}`, {
        source: this.source, offset, length,
      });
    }
  }

  private drainPendingReads(): void {
    while (this.activeReads < this.maxConcurrentRangeRequests && this.pendingReads.length > 0) {
      const pending = this.pendingReads.shift();
      if (!pending || pending.settled) continue;
      if (pending.options.signal?.aborted) {
        pending.settled = true;
        this.removeAbortListener(pending);
        pending.reject(this.abortedError(pending.offset, pending.length));
        continue;
      }
      pending.started = true;
      this.removeAbortListener(pending);
      this.activeReads += 1;
      void this.performRead(pending).finally(() => {
        this.activeReads -= 1;
        this.drainPendingReads();
      });
    }
  }

  private async performRead(pending: PendingBlobRead): Promise<void> {
    try {
      const bytes = await this.blob.slice(
        pending.offset,
        pending.offset + pending.length,
      ).arrayBuffer();
      if (pending.options.signal?.aborted) {
        throw this.abortedError(pending.offset, pending.length);
      }
      if (bytes.byteLength !== pending.length) {
        throw new RangeSourceError(
          'source-size-changed',
          `Blob range returned ${bytes.byteLength} bytes; expected ${pending.length}`,
          { source: this.source, offset: pending.offset, length: pending.length },
        );
      }
      pending.settled = true;
      pending.resolve(new Uint8Array(bytes));
    } catch (error: unknown) {
      pending.settled = true;
      pending.reject(error);
    }
  }

  private abortedError(offset: number, length: number): RangeSourceError {
    return new RangeSourceError('aborted', 'Blob range read was aborted', {
      source: this.source, offset, length,
    });
  }

  private removePendingRead(pending: PendingBlobRead): void {
    const index = this.pendingReads.indexOf(pending);
    if (index >= 0) this.pendingReads.splice(index, 1);
    this.removeAbortListener(pending);
  }

  private removeAbortListener(pending: PendingBlobRead): void {
    if (!pending.abortListener) return;
    pending.options.signal?.removeEventListener('abort', pending.abortListener);
    pending.abortListener = undefined;
  }
}
