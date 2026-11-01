/**
 * Initialize one decode worker with per-source data and processing limits.
 *
 * The pool transfers copies of the source metadata and WASM bytes, so the
 * source-side buffers remain available to the owning thread.
 */
export type RustCopcDecodeWorkerInit = {
  /** Initialization message discriminator. */
  type: "init";
  /** Serialized COPC metadata transferred to the worker. */
  metadata: ArrayBuffer;
  /** Package-owned Rust/WASM module bytes transferred to the worker. */
  wasm: ArrayBuffer;
  /** Maximum range/chunk size accepted by the worker, in bytes. */
  maxRangeBytes: number;
  /** Additive correction applied to WGS84 ellipsoidal height, in metres. */
  heightOffsetMeters: number;
};

/**
 * One transferred point-node chunk to decode or prepare.
 *
 * `chunk` is a copied ArrayBuffer transferred to a worker; the input held by
 * the caller's source remains usable.
 */
export type RustCopcDecodeWorkerJob = {
  /** Select source-space decode or fused decode/CRS/ECEF preparation. */
  type: "decode" | "prepare";
  /** Request identifier used to match the response to its pending promise. */
  id: number;
  /** Stable COPC hierarchy key for diagnostics and result matching. */
  nodeKey: string;
  /** Point count declared by the hierarchy entry. */
  pointCount: number;
  /** Bit mask of optional per-point fields requested by the caller. */
  requestedFields: number;
  /** Encoded point-node bytes, transferred to the worker. */
  chunk: ArrayBuffer;
};

/** Message types accepted by a Rust/COPC decode worker. */
export type RustCopcDecodeWorkerRequest =
  | RustCopcDecodeWorkerInit
  | RustCopcDecodeWorkerJob;

/**
 * Successful worker response with transferred point buffers and timings.
 *
 * For `prepare`, `coordinates` aliases `geographicCoordinates` for the shared
 * compatibility contract. Returned buffers are independent ArrayBuffers,
 * not views into WASM linear memory.
 */
export type RustCopcDecodeWorkerResult = {
  /** Successful-result discriminator. */
  type: "result";
  /** Identifier copied from the submitted job. */
  id: number;
  /** Hierarchy key copied from the submitted job. */
  nodeKey: string;
  /** Operation that produced this result, when supplied by the worker path. */
  operation?: "decode" | "prepare";
  /** Number of points represented by the returned buffers. */
  pointCount: number;
  /** Total worker-side processing duration in milliseconds. */
  durationMs: number;
  /** LAZ decode duration in milliseconds for fused preparation. */
  decodeDurationMs?: number;
  /** CRS/ECEF and shared point preparation duration in milliseconds. */
  preparationDurationMs?: number;
  /** Coordinate space in the primary `coordinates` buffer. */
  coordinateSystem: "copc-source" | "wgs84-geographic";
  /** Coordinate space for `sourceCoordinates`, when prepared. */
  sourceCoordinateSystem?: "copc-source";
  /** Coordinate space for `worldCoordinates`, when prepared. */
  worldCoordinateSystem?: "wgs84-ecef-meters";
  /** Transferred typed coordinate storage; never a WASM memory view. */
  coordinates: ArrayBuffer;
  /** Interleaved COPC source XYZ values in source CRS units. */
  sourceCoordinates?: ArrayBuffer;
  /** Interleaved WGS84 longitude (degrees), latitude (degrees), height (metres). */
  geographicCoordinates?: ArrayBuffer;
  /** Interleaved WGS84 ECEF XYZ values in metres. */
  worldCoordinates?: ArrayBuffer;
  /** Ranges and scale used by the renderer-neutral point style. */
  statistics?: {
    /** Prepared WGS84 ellipsoidal height range in metres. */
    elevation?: {
      /** Lowest point height. */
      min: number;
      /** Highest point height. */
      max: number;
    };
    /** Raw decoded intensity range. */
    intensity?: {
      /** Lowest decoded intensity. */
      min: number;
      /** Highest decoded intensity. */
      max: number;
    };
    /** Maximum expected RGB channel value. */
    rgbMax?: 255 | 65535;
  };
  /** Transferred raw LAS intensity values, when requested and available. */
  intensity?: ArrayBuffer;
  /** Transferred raw LAS classification codes, when requested and available. */
  classification?: ArrayBuffer;
  /** Transferred raw red channel values, when requested and available. */
  red?: ArrayBuffer;
  /** Transferred raw green channel values, when requested and available. */
  green?: ArrayBuffer;
  /** Transferred raw blue channel values, when requested and available. */
  blue?: ArrayBuffer;
};

/** Structured worker failure, optionally associated with one submitted job. */
export type RustCopcDecodeWorkerErrorMessage = {
  /** Error-result discriminator. */
  type: "error";
  /** Request identifier when the worker had accepted a job. */
  id?: number;
  /** Hierarchy key when the worker had accepted a node job. */
  nodeKey?: string;
  /** Serialized error identity and message; `code` is backend-specific. */
  error: { name: string; message: string; code?: string };
};

/** Worker initialization acknowledgement, successful result, or structured failure. */
export type RustCopcDecodeWorkerResponse =
  | { type: "ready" }
  | RustCopcDecodeWorkerResult
  | RustCopcDecodeWorkerErrorMessage;
