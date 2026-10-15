import {
  parseContentRangeHeader,
  type ParsedContentRange,
} from './range/contentRange';
import {
  type ByteRange,
  type RangeFetch,
  type RangeValidationLevel,
  type RangeValidationPolicy,
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
  /** Assurance established by the browser-visible response contract. */
  readonly validationLevel: RangeValidationLevel;
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
  /** Defaults to strict Content-Range validation. */
  readonly rangeValidation?: RangeValidationPolicy;
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

type HeadProbeMetadata = {
  readonly size: number;
  readonly etag?: string;
  readonly lastModified?: string;
};

type ProbeRepresentation = {
  size?: number;
  etag?: string;
  lastModified?: string;
};

type ProbeRangeValidation = {
  readonly usable: boolean;
  readonly level: RangeValidationLevel;
  readonly total?: number;
  readonly warning?: string;
};

class ProbeHeadError extends Error {
  readonly level: 'incompatible' | 'unknown';

  constructor(level: 'incompatible' | 'unknown', message: string, options?: ErrorOptions) {
    super(message, options);
    this.level = level;
  }
}

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
    reader.releaseLock();
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

async function fetchHeadProbeMetadata(
  source: string,
  options: CopcSourceProbeOptions,
): Promise<HeadProbeMetadata> {
  const requestHeaders = new Headers(options.headers);
  requestHeaders.delete('Range');
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchImpl(source, {
      method: 'HEAD',
      headers: requestHeaders,
      signal: options.signal,
    });
  } catch (error: unknown) {
    throw new ProbeHeadError(
      'unknown',
      'HEAD metadata could not be inspected by the browser; check network availability and CORS policy.',
      { cause: error },
    );
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProbeHeadError(
      'incompatible',
      `HEAD metadata request returned HTTP ${response.status}; the compatibility path requires a successful HEAD response.`,
    );
  }

  await response.body?.cancel().catch(() => undefined);

  const contentEncoding = response.headers.get('Content-Encoding')?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    throw new ProbeHeadError(
      'incompatible',
      `HEAD reports Content-Encoding: ${contentEncoding}; byte ranges require an identity representation.`,
    );
  }

  const rawLength = response.headers.get('Content-Length');
  const size = rawLength && /^\d+$/.test(rawLength.trim())
    ? Number(rawLength)
    : Number.NaN;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new ProbeHeadError(
      'incompatible',
      'HEAD must return a positive, safe-integer Content-Length; check HEAD support and source metadata.',
    );
  }

  return {
    size,
    ...(response.headers.get('ETag') ? { etag: response.headers.get('ETag')! } : {}),
    ...(response.headers.get('Last-Modified')
      ? { lastModified: response.headers.get('Last-Modified')! }
      : {}),
  };
}

async function validateProbeRange(
  probe: ProbeResponse,
  range: ByteRange,
  options: CopcSourceProbeOptions,
  getHeadMetadata: () => Promise<HeadProbeMetadata>,
  representation: ProbeRepresentation,
): Promise<ProbeRangeValidation> {
  if (probe.response.status !== 206) {
    return { usable: false, level: 'incompatible' };
  }
  if (probe.bodyReadError) {
    return { usable: false, level: 'incompatible', warning: probe.bodyReadError };
  }
  if (probe.bytes.byteLength !== range.length) {
    return {
      usable: false,
      level: 'incompatible',
      warning: `The partial response body contained ${probe.bytes.byteLength} bytes; expected exactly ${range.length}.`,
    };
  }

  const responseContentLength = probe.response.headers.get('Content-Length');
  if (responseContentLength !== null) {
    const bodyLength = /^\d+$/.test(responseContentLength.trim())
      ? Number(responseContentLength)
      : Number.NaN;
    if (!Number.isSafeInteger(bodyLength) || bodyLength !== range.length) {
      return {
        usable: false,
        level: 'incompatible',
        warning: `The partial response declared Content-Length ${responseContentLength}; expected ${range.length}.`,
      };
    }
  }

  const contentEncoding = probe.response.headers.get('Content-Encoding')?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    return {
      usable: false,
      level: 'incompatible',
      warning: `The partial response uses Content-Encoding: ${contentEncoding}; byte ranges require an identity representation.`,
    };
  }

  if (probe.contentRange !== undefined) {
    if (probe.contentRangeError || !probe.parsedContentRange) {
      return {
        usable: false,
        level: 'incompatible',
        warning: probe.contentRangeError ?? 'Content-Range could not be validated.',
      };
    }
    const exactRange = probe.parsedContentRange.start === range.offset
      && probe.parsedContentRange.end === range.offset + range.length - 1;
    if (!exactRange) {
      return {
        usable: false,
        level: 'incompatible',
        warning: `Content-Range does not match the requested byte range ${formatRequestedRange(range)}.`,
      };
    }
    const total = probe.parsedContentRange.total;
    const etag = probe.response.headers.get('ETag') || undefined;
    const lastModified = probe.response.headers.get('Last-Modified') || undefined;
    if ((total !== undefined && representation.size !== undefined
        && total !== representation.size)
      || (representation.etag && etag && representation.etag !== etag)
      || (representation.lastModified && lastModified
        && representation.lastModified !== lastModified)) {
      return {
        usable: false,
        level: 'incompatible',
        warning: 'The source size or a readable representation validator changed between range requests.',
      };
    }
    if (total !== undefined) representation.size = total;
    representation.etag ??= etag;
    representation.lastModified ??= lastModified;
    return {
      usable: true,
      level: 'strict',
      total,
    };
  }

  if (options.rangeValidation !== 'head-fallback') {
    return {
      usable: false,
      level: 'incompatible',
      warning: 'Content-Range was not readable by JavaScript; it may be absent or hidden by CORS.',
    };
  }

  let metadata: HeadProbeMetadata;
  try {
    metadata = await getHeadMetadata();
  } catch (error: unknown) {
    return {
      usable: false,
      level: error instanceof ProbeHeadError ? error.level : 'unknown',
      warning: error instanceof Error
        ? error.message
        : 'HEAD metadata could not be inspected by the browser.',
    };
  }

  const end = range.offset + range.length - 1;
  if (representation.size !== undefined && representation.size !== metadata.size) {
    return {
      usable: false,
      level: 'incompatible',
      total: metadata.size,
      warning: `The source size changed from ${representation.size} to ${metadata.size} between range requests.`,
    };
  }
  if (end >= metadata.size) {
    return {
      usable: false,
      level: 'incompatible',
      total: metadata.size,
      warning: `The requested byte range ends at ${end}, beyond the HEAD-reported source size ${metadata.size}.`,
    };
  }

  const etag = probe.response.headers.get('ETag') || undefined;
  const lastModified = probe.response.headers.get('Last-Modified') || undefined;
  if ((metadata.etag && etag && metadata.etag !== etag)
    || (metadata.lastModified && lastModified && metadata.lastModified !== lastModified)
    || (representation.etag && etag && representation.etag !== etag)
    || (representation.lastModified && lastModified
      && representation.lastModified !== lastModified)
    || (metadata.etag && representation.etag && metadata.etag !== representation.etag)
    || (metadata.lastModified && representation.lastModified
      && metadata.lastModified !== representation.lastModified)) {
    return {
      usable: false,
      level: 'incompatible',
      total: metadata.size,
      warning: 'The HEAD and Range responses expose different representation validators; the source may have changed.',
    };
  }

  representation.size = metadata.size;
  representation.etag ??= etag ?? metadata.etag;
  representation.lastModified ??= lastModified ?? metadata.lastModified;

  return {
    usable: true,
    level: 'compatibility-limited',
    total: metadata.size,
    warning: 'Content-Range was not readable by JavaScript; HEAD size and exact body length provide limited validation but cannot prove the returned byte offset or immutable object version.',
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
    validationLevel: 'unknown',
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

  let headMetadataPromise: Promise<HeadProbeMetadata> | undefined;
  const representation: ProbeRepresentation = {};
  const getHeadMetadata = (): Promise<HeadProbeMetadata> => {
    headMetadataPromise ??= fetchHeadProbeMetadata(source, options);
    return headMetadataPromise;
  };

  const response = first.response;
  const result: CopcSourceProbeResult = {
    ...base,
    reachable: true,
    rangeSupported: false,
    status: response.status,
    partialStatus: response.status,
    // A 206 Content-Length describes only the returned partial body. The full
    // resource length is reported only after one selected validation succeeds.
    contentLength: response.status === 200 ? readContentLength(response) : undefined,
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
  let validationLevel: RangeValidationLevel = 'incompatible';
  let firstRangeUsable = false;
  let detectedContentLength = result.contentLength;

  if (response.status === 206) {
    const initialValidation = await validateProbeRange(
      first,
      requestedRange,
      options,
      getHeadMetadata,
      representation,
    );
    firstRangeUsable = initialValidation.usable;
    validationLevel = initialValidation.level;
    detectedContentLength = initialValidation.total ?? detectedContentLength;
    if (initialValidation.warning) extraWarnings.push(initialValidation.warning);

    if (
      firstRangeUsable
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
        const extensionValidation = await validateProbeRange(
          extension,
          extensionRange,
          options,
          getHeadMetadata,
          representation,
        );
        if (!extensionValidation.usable) {
          metadataRangeSupported = false;
          validationLevel = extensionValidation.level;
          extraWarnings.push(extensionValidation.warning
            ?? 'The additional metadata range did not satisfy the selected validation contract.');
        } else {
          if (extensionValidation.level === 'compatibility-limited') {
            validationLevel = 'compatibility-limited';
          }
          detectedContentLength = extensionValidation.total ?? detectedContentLength;
          const combined = new Uint8Array(first.bytes.byteLength + extension.bytes.byteLength);
          combined.set(first.bytes);
          combined.set(extension.bytes, first.bytes.byteLength);
          metadataBytes = combined;
          extraWarnings = extraWarnings.filter((warning) =>
            !warning.startsWith('COPC metadata extends to byte'));
        }
      } catch (error: unknown) {
        metadataRangeSupported = false;
        validationLevel = 'unknown';
        const detail = error instanceof Error ? error.message : String(error);
        extraWarnings.push(`COPC metadata could not be inspected from the additional range (${detail}).`);
      }
    } else if (
      firstRangeUsable
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
  const rangeSupported: ProbeTruth = response.status === 206
    && firstRangeUsable
    && metadataRangeSupported
    ? true
    : validationLevel === 'unknown'
      ? 'unknown'
      : false;

  return withWarnings(
    {
      ...result,
      rangeSupported,
      validationLevel,
      contentLength: detectedContentLength,
      copcDetected: finalInspection.copcDetected,
      ...(finalInspection.pointFormat === undefined
        ? {}
        : { pointFormat: finalInspection.pointFormat }),
    },
    warnings,
  );
}
