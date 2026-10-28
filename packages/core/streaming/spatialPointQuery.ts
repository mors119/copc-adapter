/** Finite safety defaults for one spatial point query. */
export const DEFAULT_SPATIAL_POINT_QUERY_LIMITS = Object.freeze({
  /** Maximum source points examined by one query. */
  maxPoints: 100_000,
  /** Maximum range bytes requested by one query, including hierarchy pages. */
  maxBytes: 64 * 1024 * 1024,
  /** Maximum hierarchy pages visited by one query. */
  maxHierarchyPages: 64,
  /** Maximum point range/decode operations active for one query. */
  maxConcurrentPointReads: 1,
  /** Maximum query lifetime in milliseconds. */
  maxDurationMs: 30_000,
  /** Maximum records retained in one consumer batch. */
  batchSize: 4_096,
} as const);

const MAX_SPATIAL_POINT_QUERY_LIMITS = {
  maxPoints: 1_000_000,
  maxBytes: 256 * 1024 * 1024,
  maxHierarchyPages: 1_024,
  maxConcurrentPointReads: 4,
  maxDurationMs: 5 * 60_000,
} as const;

/** Source-coordinate 3D box. Values use the COPC metadata axis units. */
export type CopcPointQueryRegion = {
  /** Explicit source frame; geographic and renderer-local coordinates are rejected. */
  coordinateSystem: "copc-source";
  /** Inclusive lower source XYZ corner. */
  min: { x: number; y: number; z: number };
  /** Inclusive upper source XYZ corner. */
  max: { x: number; y: number; z: number };
};

/** Bounded request for a renderer-neutral spatial point query. */
export type CopcPointQueryOptions = {
  /** Inclusive AABB in the COPC source coordinate frame. */
  region: CopcPointQueryRegion;
  /** Cache reads only, or fetch missing hierarchy pages and point chunks. */
  mode: "cache-only" | "fetch-missing";
  /** Maximum octree depth to include, with the root at depth zero. */
  maxDepth: number;
  /** Maximum source points scanned. Defaults to 100,000; hard maximum is 1,000,000. */
  maxPoints?: number;
  /** Maximum query-triggered range bytes, including hierarchy pages. Defaults to 64 MiB; hard maximum is 256 MiB. */
  maxBytes?: number;
  /** Maximum hierarchy pages visited. Defaults to 64; hard maximum is 1,024. */
  maxHierarchyPages?: number;
  /** Maximum simultaneous point range/decode operations for this query. Defaults to 1; hard maximum is 4. */
  maxConcurrentPointReads?: number;
  /** Maximum elapsed query time. Defaults to 30 seconds; hard maximum is 5 minutes. */
  maxDurationMs?: number;
  /** Cancels this query without cancelling another consumer's work. */
  signal?: AbortSignal;
};

/** One source point and its stable COPC node/index provenance. */
export type CopcPointQueryPoint = {
  /** Exact source CRS X value. */
  readonly x: number;
  /** Exact source CRS Y value. */
  readonly y: number;
  /** Exact source CRS Z value in its declared vertical units. */
  readonly z: number;
  /** Hierarchy node containing this point record. */
  readonly nodeKey: string;
  /** Zero-based point index in that node's decoded point chunk. */
  readonly pointIndex: number;
};

/** A bounded batch. Each point retains source coordinates and node/index identity. */
export type CopcPointQueryBatch = readonly CopcPointQueryPoint[];

/** Reasons a query can return a truthful partial result. */
export type CopcPointQueryPartialReason =
  | "missing-hierarchy"
  | "missing-nodes"
  | "hierarchy-page-limit"
  | "point-limit"
  | "byte-limit"
  | "time-limit"
  | "invalid-point-coordinate"
  | "unsupported-backend"
  | "query-concurrency-limit";

/** Terminal state returned after iteration completes, is cancelled, or fails. */
export type CopcPointQuerySummary = {
  /** `complete` refers only to the selected non-overlapping frontier at maxDepth. */
  readonly status: "complete" | "partial" | "cancelled" | "failed";
  /** True only when status is `complete`. */
  readonly complete: boolean;
  /** Requested maximum octree depth, with root at zero. */
  readonly maxDepth: number;
  /** Number of source point records examined, including non-matching records. */
  readonly pointsScanned: number;
  /** Number of matching points yielded to the consumer. */
  readonly pointsReturned: number;
  /** Number of selected frontier nodes whose point data was processed. */
  readonly nodesProcessed: number;
  /** Number of relevant hierarchy pages visited. */
  readonly hierarchyPagesVisited: number;
  /** Exact hierarchy bytes reserved and point chunks whose reads were started. */
  readonly bytesRequested: number;
  /** Query-triggered range response bytes reported by the selected backend. */
  readonly bytesRead: number;
  /** Distinct partial-result reasons. */
  readonly reasonCodes: readonly CopcPointQueryPartialReason[];
  /** Structured failure details when status is `failed`. */
  readonly error?: { readonly name: string; readonly message: string };
  /** Cancellation reason when status is `cancelled`. */
  readonly cancelReason?: "aborted" | "source-unloaded" | "consumer-stopped";
};

/** Mutable accounting passed only between the query and its core executor. */
export type CopcPointQueryAccounting = {
  maxDepth: number;
  pointsScanned: number;
  pointsReturned: number;
  nodesProcessed: number;
  hierarchyPagesVisited: number;
  bytesRequested: number;
  bytesRead: number;
  reasonCodes: Set<CopcPointQueryPartialReason>;
  error?: { name: string; message: string };
  cancelReason?: CopcPointQuerySummary["cancelReason"];
};

export type NormalizedCopcPointQueryOptions = Omit<
  CopcPointQueryOptions,
  "maxPoints" | "maxBytes" | "maxHierarchyPages" | "maxDurationMs"
> & {
  maxPoints: number;
  maxBytes: number;
  maxHierarchyPages: number;
  maxConcurrentPointReads: number;
  maxDurationMs: number;
};

const TIME_LIMIT_REASON = "spatial-point-query-time-limit";

function positiveSafeInteger(
  value: number,
  name: string,
  maximum: number,
  allowZero = false,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value > maximum ||
    (allowZero ? value < 0 : value < 1)
  ) {
    throw new RangeError(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer no greater than ${maximum}`,
    );
  }
}

/** Validate request semantics and install finite defaults before query work starts. */
export function normalizeCopcPointQueryOptions(
  options: CopcPointQueryOptions,
): NormalizedCopcPointQueryOptions {
  if (!options || typeof options !== "object") {
    throw new TypeError("COPC point query options must be an object");
  }
  if (options.mode !== "cache-only" && options.mode !== "fetch-missing") {
    throw new TypeError("COPC point query mode must be cache-only or fetch-missing");
  }
  if (options.region?.coordinateSystem !== "copc-source") {
    throw new TypeError("COPC point query region must use copc-source coordinates");
  }
  const coordinates = [
    options.region.min?.x,
    options.region.min?.y,
    options.region.min?.z,
    options.region.max?.x,
    options.region.max?.y,
    options.region.max?.z,
  ];
  if (coordinates.some((coordinate) => !Number.isFinite(coordinate))) {
    throw new RangeError("COPC point query bounds must contain finite XYZ values");
  }
  if (
    options.region.min.x > options.region.max.x ||
    options.region.min.y > options.region.max.y ||
    options.region.min.z > options.region.max.z
  ) {
    throw new RangeError("COPC point query minimums must not exceed maximums");
  }
  if (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 0 || options.maxDepth > 31) {
    throw new RangeError("COPC point query maxDepth must be a safe integer from 0 through 31");
  }

  const maxPoints = options.maxPoints ?? DEFAULT_SPATIAL_POINT_QUERY_LIMITS.maxPoints;
  const maxBytes = options.maxBytes ?? DEFAULT_SPATIAL_POINT_QUERY_LIMITS.maxBytes;
  const maxHierarchyPages =
    options.maxHierarchyPages ?? DEFAULT_SPATIAL_POINT_QUERY_LIMITS.maxHierarchyPages;
  const maxConcurrentPointReads =
    options.maxConcurrentPointReads ??
    DEFAULT_SPATIAL_POINT_QUERY_LIMITS.maxConcurrentPointReads;
  const maxDurationMs =
    options.maxDurationMs ?? DEFAULT_SPATIAL_POINT_QUERY_LIMITS.maxDurationMs;
  positiveSafeInteger(maxPoints, "maxPoints", MAX_SPATIAL_POINT_QUERY_LIMITS.maxPoints, true);
  positiveSafeInteger(maxBytes, "maxBytes", MAX_SPATIAL_POINT_QUERY_LIMITS.maxBytes, true);
  positiveSafeInteger(
    maxHierarchyPages,
    "maxHierarchyPages",
    MAX_SPATIAL_POINT_QUERY_LIMITS.maxHierarchyPages,
    true,
  );
  positiveSafeInteger(
    maxConcurrentPointReads,
    "maxConcurrentPointReads",
    MAX_SPATIAL_POINT_QUERY_LIMITS.maxConcurrentPointReads,
  );
  positiveSafeInteger(
    maxDurationMs,
    "maxDurationMs",
    MAX_SPATIAL_POINT_QUERY_LIMITS.maxDurationMs,
  );

  return {
    ...options,
    region: {
      coordinateSystem: "copc-source",
      min: { ...options.region.min },
      max: { ...options.region.max },
    },
    maxPoints,
    maxBytes,
    maxHierarchyPages,
    maxConcurrentPointReads,
    maxDurationMs,
  };
}

function createAccounting(maxDepth: number): CopcPointQueryAccounting {
  return {
    maxDepth,
    pointsScanned: 0,
    pointsReturned: 0,
    nodesProcessed: 0,
    hierarchyPagesVisited: 0,
    bytesRequested: 0,
    bytesRead: 0,
    reasonCodes: new Set(),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function snapshot(
  accounting: CopcPointQueryAccounting,
  status: CopcPointQuerySummary["status"],
): CopcPointQuerySummary {
  return {
    status,
    complete: status === "complete",
    maxDepth: accounting.maxDepth,
    pointsScanned: accounting.pointsScanned,
    pointsReturned: accounting.pointsReturned,
    nodesProcessed: accounting.nodesProcessed,
    hierarchyPagesVisited: accounting.hierarchyPagesVisited,
    bytesRequested: accounting.bytesRequested,
    bytesRead: accounting.bytesRead,
    reasonCodes: [...accounting.reasonCodes].sort(),
    ...(accounting.error ? { error: { ...accounting.error } } : {}),
    ...(accounting.cancelReason
      ? { cancelReason: accounting.cancelReason }
      : {}),
  };
}

/** One-shot async point stream with a structured terminal summary. */
export interface CopcPointQuery extends AsyncIterable<CopcPointQueryBatch> {
  /** Resolves after stream completion, cancellation, or failure. */
  readonly result: Promise<CopcPointQuerySummary>;
  /** Abort this query without cancelling another consumer's work. */
  cancel(): void;
}

class CopcPointQueryImpl implements CopcPointQuery {
  readonly result: Promise<CopcPointQuerySummary>;
  private readonly controller = new AbortController();
  private readonly accounting: CopcPointQueryAccounting;
  private readonly options: NormalizedCopcPointQueryOptions;
  private readonly execute: (
    signal: AbortSignal,
    accounting: CopcPointQueryAccounting,
  ) => AsyncGenerator<CopcPointQueryBatch>;
  private readonly listeners: Array<{
    signal: AbortSignal;
    listener: () => void;
  }> = [];
  private resolveResult!: (summary: CopcPointQuerySummary) => void;
  private iteratorClaimed = false;
  private executionStarted = false;
  private settled = false;
  private timer?: ReturnType<typeof setTimeout>;
  private iterator?: AsyncGenerator<CopcPointQueryBatch>;

  constructor(
    options: NormalizedCopcPointQueryOptions,
    execute: (
      signal: AbortSignal,
      accounting: CopcPointQueryAccounting,
    ) => AsyncGenerator<CopcPointQueryBatch>,
    lifecycleSignal?: AbortSignal,
  ) {
    this.options = options;
    this.execute = execute;
    this.accounting = createAccounting(options.maxDepth);
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
    for (const signal of [options.signal, lifecycleSignal]) {
      if (!signal) continue;
      const listener = (): void => {
        if (this.settled) return;
        const reason = signal.reason;
        this.accounting.cancelReason = reason === "source-unloaded" || reason === "lifecycle"
          ? "source-unloaded"
          : "aborted";
        this.controller.abort(reason);
        if (!this.executionStarted) {
          this.finish("cancelled");
        } else {
          this.closeIterator();
        }
      };
      if (signal.aborted) {
        listener();
      } else {
        signal.addEventListener("abort", listener, { once: true });
        this.listeners.push({ signal, listener });
      }
    }
    this.timer = undefined;
  }

  /** Abort this query. Shared render or query work remains owned by its caller. */
  cancel(): void {
    if (this.settled) return;
    this.accounting.cancelReason ??= "aborted";
    this.controller.abort("caller-cancelled");
    if (!this.executionStarted) {
      this.finish("cancelled");
    } else {
      this.closeIterator();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CopcPointQueryBatch> {
    if (this.iteratorClaimed) {
      throw new TypeError("COPC point query streams can only be consumed once");
    }
    this.iteratorClaimed = true;
    this.iterator = this.iterate();
    return this.iterator;
  }

  private async *iterate(): AsyncGenerator<CopcPointQueryBatch> {
    this.executionStarted = true;
    if (this.settled) return;
    this.timer = setTimeout(() => {
      if (this.settled) return;
      this.controller.abort(TIME_LIMIT_REASON);
      this.closeIterator();
    }, this.options.maxDurationMs);
    let status: CopcPointQuerySummary["status"] = "complete";
    let completed = false;
    try {
      if (this.controller.signal.aborted) {
        status = "cancelled";
        completed = true;
        return;
      }
      for await (const batch of this.execute(this.controller.signal, this.accounting)) {
        if (this.controller.signal.aborted) break;
        yield batch;
      }
      if (this.controller.signal.reason === TIME_LIMIT_REASON) {
        this.accounting.reasonCodes.add("time-limit");
        status = "partial";
      } else if (this.controller.signal.aborted) {
        status = "cancelled";
      } else if (this.accounting.reasonCodes.size > 0) {
        status = "partial";
      }
      completed = true;
    } catch (error: unknown) {
      if (this.controller.signal.reason === TIME_LIMIT_REASON) {
        this.accounting.reasonCodes.add("time-limit");
        status = "partial";
        completed = true;
      } else if (this.controller.signal.aborted || isAbortError(error)) {
        status = "cancelled";
        completed = true;
      } else {
        this.accounting.error = {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        };
        status = "failed";
        completed = true;
        throw error;
      }
    } finally {
      if (!completed) {
        if (this.controller.signal.reason === TIME_LIMIT_REASON) {
          this.accounting.reasonCodes.add("time-limit");
          status = "partial";
        } else {
          this.accounting.cancelReason ??= "consumer-stopped";
          this.controller.abort("consumer-stopped");
          status = "cancelled";
        }
      }
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.finish(status);
    }
  }

  private finish(status: CopcPointQuerySummary["status"]): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const { signal, listener } of this.listeners) {
      signal.removeEventListener("abort", listener);
    }
    this.resolveResult(snapshot(this.accounting, status));
  }

  private closeIterator(): void {
    if (!this.iterator) return;
    void this.iterator.return(undefined).catch(() => undefined);
  }
}

/** Create a one-shot query stream for the renderer-neutral core. */
export function createCopcPointQuery(
  options: NormalizedCopcPointQueryOptions,
  execute: (
    signal: AbortSignal,
    accounting: CopcPointQueryAccounting,
  ) => AsyncGenerator<CopcPointQueryBatch>,
  lifecycleSignal?: AbortSignal,
): CopcPointQuery {
  return new CopcPointQueryImpl(options, execute, lifecycleSignal);
}

/** Private timeout reason used by the query wrapper and its range signal. */
export function isSpatialPointQueryTimeout(signal: AbortSignal): boolean {
  return signal.reason === TIME_LIMIT_REASON;
}

/** Yield to timers and other consumers during long point scans. */
export function yieldSpatialPointQuery(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
