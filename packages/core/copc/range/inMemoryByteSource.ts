import {
  RangeSourceError,
  type ByteRange,
  type RangeReadOptions,
  type RandomAccessByteSource,
  validateByteRange,
} from "./types";

/** Deterministic random-access source for parser and backend tests. */
export class InMemoryByteSource implements RandomAccessByteSource {
  /** Diagnostic identity for this byte array. */
  readonly source: string;
  private readonly bytes: Uint8Array;

  /** Copy the supplied bytes so later caller mutations do not change this source. */
  constructor(
    bytes: ArrayBuffer | ArrayLike<number>,
    source = "memory://copc",
  ) {
    this.source = source;
    this.bytes =
      bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes.slice(0))
        : Uint8Array.from(bytes);
  }

  /** Return the copied byte-array length. */
  async size(): Promise<number> {
    return this.bytes.byteLength;
  }

  /** Read one exact interval, rejecting ranges that exceed the copied bytes. */
  async readRange(
    offset: number,
    length: number,
    _options: RangeReadOptions = {},
  ): Promise<Uint8Array> {
    const range = validateByteRange(this.source, offset, length);
    const end = offset + length;

    if (end > this.bytes.byteLength) {
      throw new RangeSourceError(
        "out-of-bounds",
        `Requested bytes=${offset}-${end - 1} exceed source size ${this.bytes.byteLength}`,
        { source: this.source, offset, length },
      );
    }

    return this.bytes.slice(range.offset, end);
  }

  /** Read several intervals concurrently and preserve their input order. */
  async readRanges(
    ranges: readonly ByteRange[],
    options: RangeReadOptions = {},
  ): Promise<Uint8Array[]> {
    return Promise.all(
      ranges.map(({ offset, length }) =>
        this.readRange(offset, length, options),
      ),
    );
  }
}
