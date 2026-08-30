import {
  parseContentRangeHeader,
  type ParsedContentRange,
} from './range/contentRange';
import {
  type ByteRange,
  type RangeFetch,
  validateByteRange,
} from './range/types';

const DEFAULT_PROBE_LENGTH = 1024;
const LAS_HEADER_LENGTH = 375;
const LAS_VLR_HEADER_LENGTH = 54;
const COPC_INFO_RECORD_LENGTH = 160;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_PROBE_METADATA_BYTES = 1024 * 1024;

export type ProbeTruth = boolean | 'unknown';

export type CopcSourceProbeResult = {
  readonly source: string;
  /** True means an HTTP response was received, including an HTTP error. */
  readonly reachable: boolean;
  /** False is observed incompatibility; unknown means the browser could not test it. */
  readonly rangeSupported: ProbeTruth;
  readonly status?: number;
  /** Status returned by the request carrying the Range header. */
  readonly partialStatus?: number;
  readonly requestedRange: ByteRange;
  readonly returnedRange?: ByteRange;
  readonly contentLength?: number;
  readonly contentRange?: string;
  /** True means the response was readable; unknown means fetch was blocked or failed. */
  readonly corsReadable: ProbeTruth;
  readonly copcDetected: ProbeTruth;
  readonly pointFormat?: number;
  readonly warnings: readonly string[];
};

export type CopcSourceProbeOptions = {
  readonly fetch?: RangeFetch;
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
};

type ProbeResponse = {
  readonly response: Response;
  readonly contentRange?: string;
  readonly parsedContentRange?: ParsedContentRange;
  readonly contentRangeError?: string;
  readonly bodyReadError?: string;
  readonly bytes: Uint8Array;
};

type HeaderInspection = {
  readonly copcDetected: ProbeTruth;
  readonly pointFormat?: number;
  readonly metadataEnd?: number;
  readonly warnings: readonly string[];
};

function formatRequestedRange(range: ByteRange): string {
  return `${range.offset}-${range.offset + range.length - 1}`;
}

function readContentLength(response: Response): number | undefined {
  const value = response.headers.get('Content-Length');
  if (!value || !/^\d+$/.test(value.trim())) {
    return undefined;
  }

  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

/** Read only a bounded prefix and cancel the response stream before it grows. */
async function readBodyPrefix(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maximumBytes) {
      const next = await reader.read();
      if (next.done) {
        break;
      }

      const chunk = next.value;
      const remaining = maximumBytes - total;
      const bounded = chunk.byteLength > remaining
        ? chunk.slice(0, remaining)
        : chunk;
      chunks.push(bounded);
      total += bounded.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function requestRange(
  source: string,
  range: ByteRange,
  options: CopcSourceProbeOptions,
): Promise<ProbeResponse> {
  const requestHeaders = new Headers(options.headers);
  requestHeaders.set(
    'Range',
    `bytes=${range.offset}-${range.offset + range.length - 1}`,
  );
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(source, {
    headers: requestHeaders,
    signal: options.signal,
  });
  const contentRange = response.headers.get('Content-Range') ?? undefined;
  const parsed = response.status === 206
    ? parseContentRangeHeader(contentRange ?? null)
    : undefined;
  const bodyLimit = response.status === 206 ? range.length + 1 : range.length;
  let bytes: Uint8Array;
  try {
    bytes = await readBodyPrefix(response, bodyLimit);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      response,
      contentRange,
      parsedContentRange: parsed?.ok ? parsed.value : undefined,
      contentRangeError: parsed && !parsed.ok ? parsed.message : undefined,
      bodyReadError: `The response body could not be read (${message}).`,
      bytes: new Uint8Array(),
    };
  }

  return {
    response,
    contentRange,
    parsedContentRange: parsed?.ok ? parsed.value : undefined,
    contentRangeError: parsed && !parsed.ok ? parsed.message : undefined,
    bytes,
  };
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder().decode(bytes.subarray(offset, offset + length))
    .replace(/\0+$/, '')
    .trim();
}

function inspectHeader(bytes: Uint8Array): HeaderInspection {
  if (bytes.byteLength < 4) {
    return {
      copcDetected: 'unknown',
      warnings: ['The response was too short to inspect the LAS file signature.'],
    };
  }

  if (readAscii(bytes, 0, 4) !== 'LASF') {
    return {
      copcDetected: false,
      warnings: ['The response does not begin with the LASF file signature.'],
    };
  }

  const pointFormat = bytes.byteLength > 104 ? bytes[104] : undefined;
  if (bytes.byteLength < LAS_HEADER_LENGTH) {
    return {
      copcDetected: 'unknown',
      pointFormat,
      warnings: [`The LAS header is incomplete; received ${bytes.byteLength} of ${LAS_HEADER_LENGTH} bytes.`],
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint16(94, true);
  const pointDataOffset = view.getUint32(96, true);
  const numberOfVlrs = view.getUint32(100, true);
  if (
    headerSize < LAS_HEADER_LENGTH
    || pointDataOffset < headerSize
    || pointDataOffset > MAX_METADATA_BYTES
  ) {
    return {
      copcDetected: 'unknown',
      pointFormat,
      metadataEnd: pointDataOffset,
      warnings: ['The LAS header contains an invalid metadata area; COPC metadata could not be inspected.'],
    };
  }

  if (bytes.byteLength < pointDataOffset) {
    return {
      copcDetected: 'unknown',
      pointFormat,
      metadataEnd: pointDataOffset,
      warnings: [`COPC metadata extends to byte ${pointDataOffset}; the initial probe prefix was not enough to inspect it.`],
    };
  }

  let cursor = headerSize;
  for (let index = 0; index < numberOfVlrs; index += 1) {
    if (cursor + LAS_VLR_HEADER_LENGTH > pointDataOffset) {
      return {
        copcDetected: 'unknown',
        pointFormat,
        metadataEnd: pointDataOffset,
        warnings: ['The LAS VLR area is truncated; COPC metadata could not be inspected.'],
      };
    }

    const recordId = view.getUint16(cursor + 18, true);
    const recordLength = view.getUint16(cursor + 20, true);
    const userId = readAscii(bytes, cursor + 2, 16).toLowerCase();
    cursor += LAS_VLR_HEADER_LENGTH;
    if (cursor + recordLength > pointDataOffset) {
      return {
        copcDetected: 'unknown',
        pointFormat,
        metadataEnd: pointDataOffset,
        warnings: ['A LAS VLR payload is truncated; COPC metadata could not be inspected.'],
      };
    }

    if (userId === 'copc' && recordId === 1) {
      if (recordLength < COPC_INFO_RECORD_LENGTH) {
        return {
          copcDetected: false,
          pointFormat,
          metadataEnd: pointDataOffset,
          warnings: ['The COPC info VLR is shorter than the required 160-byte record.'],
        };
      }
      return { copcDetected: true, pointFormat, metadataEnd: pointDataOffset, warnings: [] };
    }
    cursor += recordLength;
  }

  return {
    copcDetected: false,
    pointFormat,
    metadataEnd: pointDataOffset,
    warnings: ['The LASF response is readable, but no COPC info VLR was found.'],
  };
}

function resultBase(
  source: string,
  requestedRange: ByteRange,
): CopcSourceProbeResult {
  return {
    source,
    reachable: false,
    rangeSupported: 'unknown',
    requestedRange,
    corsReadable: 'unknown',
    copcDetected: 'unknown',
    warnings: [],
  };
}

function withWarnings(
  result: CopcSourceProbeResult,
  ...warnings: readonly string[][]
): CopcSourceProbeResult {
  return {
    ...result,
    warnings: [...new Set(warnings.flat())],
  };
}

/** Probe a remote source without downloading the whole COPC resource. */
export async function probeCopcSource(
  source: string,
  options: CopcSourceProbeOptions = {},
): Promise<CopcSourceProbeResult> {
  const requestedRange = validateByteRange(source, 0, DEFAULT_PROBE_LENGTH);
  const base = resultBase(source, requestedRange);
  let first: ProbeResponse;
  try {
    first = await requestRange(source, requestedRange, options);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return withWarnings(
      base,
      [`The response could not be inspected by the browser (${detail}). Check network availability and CORS policy.`],
    );
  }

  const response = first.response;
  const result: CopcSourceProbeResult = {
    ...base,
    reachable: true,
    rangeSupported: false,
    status: response.status,
    partialStatus: response.status,
    // A 206 Content-Length describes only the returned partial body. Treat the
    // resource length as known only when Content-Range supplies a valid total.
    contentLength: first.parsedContentRange?.total
      ?? (response.status === 200 ? readContentLength(response) : undefined),
    ...(first.contentRange === undefined ? {} : { contentRange: first.contentRange }),
    ...(first.parsedContentRange
      ? {
          returnedRange: {
            offset: first.parsedContentRange.start,
            length: first.parsedContentRange.end - first.parsedContentRange.start + 1,
          },
        }
      : {}),
    corsReadable: true,
    copcDetected: 'unknown',
    warnings: [],
  };

  const inspection = inspectHeader(first.bytes);
  let metadataBytes = first.bytes;
  let extraWarnings: string[] = [...inspection.warnings];
  let metadataRangeSupported = true;
  if (first.bodyReadError) {
    extraWarnings.push(first.bodyReadError);
  }

  if (response.status === 206) {
    if (first.contentRangeError) {
      extraWarnings.push(first.contentRangeError);
    }

    if (
      first.parsedContentRange
      && (
        first.parsedContentRange.start !== requestedRange.offset
        || first.parsedContentRange.end !== requestedRange.offset + requestedRange.length - 1
      )
    ) {
      extraWarnings.push(
        `Content-Range does not match the requested byte range ${formatRequestedRange(requestedRange)}.`,
      );
    }

    const bodyLengthIsExact = first.bytes.byteLength === requestedRange.length;
    if (!bodyLengthIsExact) {
      extraWarnings.push(
        `The partial response body contained ${first.bytes.byteLength} bytes; expected exactly ${requestedRange.length}.`,
      );
    }

    const exactRange = first.parsedContentRange?.start === requestedRange.offset
      && first.parsedContentRange.end === requestedRange.offset + requestedRange.length - 1;
    const rangeIsUsable = exactRange && bodyLengthIsExact && !first.contentRangeError;

    if (
      rangeIsUsable
      && inspection.metadataEnd !== undefined
      && inspection.metadataEnd > first.bytes.byteLength
      && inspection.metadataEnd - first.bytes.byteLength <= MAX_PROBE_METADATA_BYTES
    ) {
      const extensionRange = validateByteRange(
        source,
        first.bytes.byteLength,
        inspection.metadataEnd - first.bytes.byteLength,
      );
      try {
        const extension = await requestRange(source, extensionRange, options);
        if (
          extension.response.status !== 206
          || extension.contentRangeError
          || !extension.parsedContentRange
          || extension.parsedContentRange.start !== extensionRange.offset
          || extension.parsedContentRange.end !== extensionRange.offset + extensionRange.length - 1
          || extension.bytes.byteLength !== extensionRange.length
        ) {
          metadataRangeSupported = false;
          extraWarnings.push('The additional metadata range did not satisfy the exact partial-response contract.');
        } else {
          const combined = new Uint8Array(first.bytes.byteLength + extension.bytes.byteLength);
          combined.set(first.bytes);
          combined.set(extension.bytes, first.bytes.byteLength);
          metadataBytes = combined;
          extraWarnings = extraWarnings.filter((warning) =>
            !warning.startsWith('COPC metadata extends to byte'));
        }
      } catch (error: unknown) {
        metadataRangeSupported = false;
        const detail = error instanceof Error ? error.message : String(error);
        extraWarnings.push(`COPC metadata could not be inspected from the additional range (${detail}).`);
      }
    } else if (
      rangeIsUsable
      && inspection.metadataEnd !== undefined
      && inspection.metadataEnd > first.bytes.byteLength
    ) {
      extraWarnings.push(
        `COPC metadata extends beyond the probe safety limit; only the initial prefix was inspected.`,
      );
    }
  } else if (response.status === 200) {
    extraWarnings.push(
      `Requested bytes ${formatRequestedRange(requestedRange)} but the server returned HTTP 200. The server appears to ignore Range requests.`,
      'COPC streaming requires reliable partial-content access.',
    );
  } else {
    extraWarnings.push(`The range request returned HTTP ${response.status}; expected HTTP 206 Partial Content.`);
    if (response.status === 404) {
      extraWarnings.push('The COPC resource was not found at this URL.');
    }
    if (response.status === 416) {
      extraWarnings.push('The requested byte range was not satisfiable for this resource.');
    }
  }

  const finalInspection = metadataBytes === first.bytes
    ? inspection
    : inspectHeader(metadataBytes);
  const warnings = [...extraWarnings, ...finalInspection.warnings];
  const bodyWasExact = response.status === 206
    && first.bytes.byteLength === requestedRange.length;
  const contentRangeWasExact = first.parsedContentRange?.start === requestedRange.offset
    && first.parsedContentRange.end === requestedRange.offset + requestedRange.length - 1
    && !first.contentRangeError;

  return withWarnings(
    {
      ...result,
      rangeSupported: response.status === 206
        && bodyWasExact
        && contentRangeWasExact
        && metadataRangeSupported,
      copcDetected: finalInspection.copcDetected,
      ...(finalInspection.pointFormat === undefined
        ? {}
        : { pointFormat: finalInspection.pointFormat }),
    },
    warnings,
  );
}
