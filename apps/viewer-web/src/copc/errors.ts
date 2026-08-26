export type CopcLoadStage =
  | 'source'
  | 'metadata'
  | 'hierarchy'
  | 'point-data'
  | 'decode'
  | 'wasm';

export type CopcBackendErrorCode =
  | 'source-range'
  | 'header-parse'
  | 'hierarchy'
  | 'point-chunk'
  | 'laz-decode'
  | 'unsupported'
  | 'wasm'
  | 'unknown';

type CopcLoadErrorOptions = ErrorOptions & {
  detail?: string;
};

function displaySource(source: string): string {
  try {
    const url = new URL(source);

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    }
  } catch {
    // Relative browser URLs and filesystem paths are already safe to display.
  }

  return source;
}

/** Project-owned error returned when a public COPC load stage fails. */
export class CopcLoadError extends Error {
  readonly stage: CopcLoadStage;
  readonly source: string;

  constructor(
    message: string,
    stage: CopcLoadStage,
    source: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CopcLoadError';
    this.stage = stage;
    this.source = source;
  }
}

/** Failure while opening the configured COPC resource or creating its context. */
export class CopcSourceError extends CopcLoadError {
  constructor(source: string, options?: ErrorOptions) {
    super(
      `Failed to create COPC source context for "${displaySource(source)}". Check that the resource is reachable and supports HTTP range requests and CORS.`,
      'source',
      source,
      options,
    );
    this.name = 'CopcSourceError';
  }
}

/** Failure while reading or validating COPC metadata, including its CRS. */
export class CopcMetadataError extends CopcLoadError {
  constructor(source: string, options?: CopcLoadErrorOptions) {
    const detail = options?.detail ? ` ${options.detail}` : '';

    super(
      `Failed to read or validate COPC metadata for "${displaySource(source)}".${detail}`,
      'metadata',
      source,
      options,
    );
    this.name = 'CopcMetadataError';
  }
}

/** Failure while reading or validating the COPC hierarchy. */
export class CopcHierarchyLoadError extends CopcLoadError {
  constructor(source: string, options?: ErrorOptions) {
    super(
      `Failed to load COPC hierarchy for "${displaySource(source)}".`,
      'hierarchy',
      source,
      options,
    );
    this.name = 'CopcHierarchyLoadError';
  }
}

/** Structured failure raised by a backend while reading or decoding COPC data. */
export class CopcBackendError extends CopcLoadError {
  readonly code: CopcBackendErrorCode;
  readonly nodeKey?: string;

  constructor(
    source: string,
    stage: CopcLoadStage,
    code: CopcBackendErrorCode,
    detail: string,
    options?: ErrorOptions & { nodeKey?: string },
  ) {
    super(
      `COPC backend ${stage} failure for "${displaySource(source)}": ${detail}`,
      stage,
      source,
      options,
    );
    this.name = 'CopcBackendError';
    this.code = code;
    this.nodeKey = options?.nodeKey;
  }
}
