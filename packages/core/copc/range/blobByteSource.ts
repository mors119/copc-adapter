import {
  RangeSourceError,
  type ByteRange,
  type RangeReadOptions,
  type RandomAccessByteSource,
  validateByteRange,
} from './types';

/** Random-access Blob/File reads; abort signals are checked before and after each non-cancellable slice read. */
export class BlobByteSource implements RandomAccessByteSource {
  readonly source: string;
  private readonly blob: Blob;

  constructor(blob: Blob, identity?: string) {
    if (!blob || typeof blob.slice !== 'function'
      || !Number.isSafeInteger(blob.size) || blob.size < 0) {
      throw new TypeError('BlobByteSource requires a valid Blob or File');
    }
    this.source = identity ?? (typeof File !== 'undefined' && blob instanceof File && blob.name
      ? `file://${encodeURIComponent(blob.name)}`
      : 'blob://local-copc');
    this.blob = blob;
  }

  async size(): Promise<number> {
    return this.blob.size;
  }

  async readRange(offset: number, length: number, options: RangeReadOptions = {}): Promise<Uint8Array> {
    validateByteRange(this.source, offset, length);
    if (options.signal?.aborted) {
      throw new RangeSourceError('aborted', 'Blob range read was aborted', { source: this.source, offset, length });
    }
    const end = offset + length;
    if (end > this.blob.size) {
      throw new RangeSourceError('out-of-bounds', `Requested bytes=${offset}-${end - 1} exceed source size ${this.blob.size}`, {
        source: this.source, offset, length,
      });
    }
    const read = this.blob.slice(offset, end).arrayBuffer();
    const bytes = await read;
    if (options.signal?.aborted) {
      throw new RangeSourceError('aborted', 'Blob range read was aborted', { source: this.source, offset, length });
    }
    if (bytes.byteLength !== length) {
      throw new RangeSourceError('source-size-changed', `Blob range returned ${bytes.byteLength} bytes; expected ${length}`, {
        source: this.source, offset, length,
      });
    }
    return new Uint8Array(bytes);
  }

  async readRanges(ranges: readonly ByteRange[], options: RangeReadOptions = {}): Promise<Uint8Array[]> {
    return Promise.all(ranges.map(({ offset, length }) => this.readRange(offset, length, options)));
  }
}
