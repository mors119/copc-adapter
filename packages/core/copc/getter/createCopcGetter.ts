import { Getter } from "copc";
import { HttpRangeByteSource } from "../range/httpRangeSource";
import { BlobByteSource } from "../range/blobByteSource";
import type { CopcInputSource, RandomAccessByteSource } from "../range/types";
import {
  ProjectOwnedByteSource,
  RangeRequestDiagnosticsRecorder,
} from "../range/requestDiagnostics";
import type { RangeReadOptions, RangeValidationPolicy } from "../range/types";

export type CopcRangeGetter = (
  begin: number,
  end: number,
  options?: RangeReadOptions,
) => Promise<Uint8Array>;

export type CopcGetterOptions = {
  signal?: AbortSignal;
  rangeRequestDiagnostics?: RangeRequestDiagnosticsRecorder;
  rangeValidation?: RangeValidationPolicy;
  /** Defaults to 64 MiB; explicit values accept any positive safe integer. */
  maxRangeBytes?: number;
  /** Defaults to 4; explicit values accept any positive safe integer. */
  maxConcurrentRangeRequests?: number;
};

function isHttpSource(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function isBlobSource(source: unknown): source is Blob {
  return typeof Blob !== "undefined" && source instanceof Blob;
}

function isRandomAccessByteSource(
  source: unknown,
): source is RandomAccessByteSource {
  if (!source || typeof source !== "object") return false;
  const candidate = source as Partial<RandomAccessByteSource>;
  return (
    typeof candidate.source === "string" &&
    candidate.source.length > 0 &&
    typeof candidate.readRange === "function" &&
    typeof candidate.readRanges === "function" &&
    typeof candidate.size === "function"
  );
}

export function getCopcSourceIdentity(source: CopcInputSource): string {
  if (typeof source === "string") return source;
  if (isBlobSource(source)) {
    return typeof File !== "undefined" && source instanceof File && source.name
      ? `file://${encodeURIComponent(source.name)}`
      : "blob://local-copc";
  }
  if (!isRandomAccessByteSource(source)) {
    throw new TypeError(
      "COPC source must be a URL, Blob/File, or RandomAccessByteSource",
    );
  }
  return source.source;
}

export function createCopcGetter(
  input: CopcInputSource,
  options: CopcGetterOptions = {},
): CopcRangeGetter {
  const source = getCopcSourceIdentity(input);
  if (typeof input !== "string") {
    const byteSource: RandomAccessByteSource = isBlobSource(input)
      ? new BlobByteSource(input, source, {
          maxRangeBytes: options.maxRangeBytes,
          maxConcurrentRangeRequests: options.maxConcurrentRangeRequests,
        })
      : input;
    const owned = new ProjectOwnedByteSource(
      byteSource,
      options.signal,
      options.rangeRequestDiagnostics ?? new RangeRequestDiagnosticsRecorder(),
    );
    return async (begin, end, readOptions) => {
      const sourceSize = await owned.size();
      const boundedEnd =
        sourceSize === undefined ? end : Math.min(end, sourceSize);
      if (begin >= boundedEnd) {
        throw new RangeError(
          `COPC byte range starts beyond source end: ${begin}`,
        );
      }
      return owned.readRange(begin, boundedEnd - begin, {
        signal: readOptions?.signal,
      });
    };
  }
  if (isHttpSource(source) || isBrowser()) {
    const resolvedSource = isHttpSource(source)
      ? source
      : new URL(source, window.location.href).toString();
    const byteSource = new ProjectOwnedByteSource(
      new HttpRangeByteSource(resolvedSource, {
        rangeValidation: options.rangeValidation,
        maxRangeBytes: options.maxRangeBytes,
        maxConcurrentRangeRequests: options.maxConcurrentRangeRequests,
      }),
      options.signal,
      options.rangeRequestDiagnostics ?? new RangeRequestDiagnosticsRecorder(),
    );
    return (begin, end, readOptions) =>
      byteSource.readRange(begin, end - begin, {
        signal: readOptions?.signal,
      });
  }

  return Getter.create(source);
}
