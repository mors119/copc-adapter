/** Stage at which a COPC resource operation failed. */
export type CopcLoadStage =
  /** Opening the byte source or establishing random access. */
  | 'source'
  /** Reading or validating COPC/LAS header, VLR, or CRS metadata. */
  | 'metadata'
  /** Reading or traversing hierarchy pages. */
  | 'hierarchy'
  /** Reading a selected point-data byte range. */
  | 'point-data'
  /** Decoding a selected point chunk. */
  | 'decode'
  /** Loading or invoking the Rust/WASM runtime. */
  | 'wasm';

/** Stable backend failure categories for programmatic error handling. */
export type CopcBackendErrorCode =
  /** Random-access source failure while reading bytes. */
  | 'source-range'
  /** COPC/LAS header or metadata could not be parsed. */
  | 'header-parse'
  /** Hierarchy page read, parse, or traversal failed. */
  | 'hierarchy'
  /** Selected node point-data range could not be read. */
  | 'point-chunk'
  /** LAZ point chunk could not be decoded. */
  | 'laz-decode'
  /** Requested format, field, or feature is unsupported. */
  | 'unsupported'
  /** Rust/WASM runtime or ABI failed. */
  | 'wasm'
  /** Decode worker creation, communication, or execution failed. */
  | 'worker'
  /** Failure did not match a more specific category. */
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
  /** Public load stage associated with the failure. */
  readonly stage: CopcLoadStage;
  /** Resource identifier supplied by the caller. */
  readonly source: string;

  /** Create a project-owned load error and preserve an optional cause. */
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
  /** Stable machine-readable backend failure category. */
  readonly code: CopcBackendErrorCode;
  /** COPC hierarchy key associated with a node-level failure, when known. */
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
