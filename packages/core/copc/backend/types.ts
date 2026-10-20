import type { CopcHierarchySource } from "../hierarchy/types";
import type {
  CopcHierarchyNode,
  CopcMetadata,
  CopcPointBuffer,
  CopcPointView,
  PreparedPointData,
} from "../types/copc";
import type { CopcPointFieldSelection } from "../points/fieldSelection";
import type { CopcPerformanceObserver } from "../performance";
import type { RangeRequestDiagnosticsRecorder } from "../range/requestDiagnostics";
import type { RangeValidationPolicy } from "../range/types";
import type { CopcInputSource } from "../range/types";

/** Cancellation options for one selected node's point-data operation. */
export type CopcPointLoadOptions = {
  /** Cancels only this point-node read; shared hierarchy reads remain reusable. */
  signal?: AbortSignal;
  /**
   * Override the source-wide performance observer for this point read.
   * `null` suppresses reporting for the request; `undefined` uses the source observer.
   */
  performanceObserver?: CopcPerformanceObserver | null;
};

/** Source-level options shared by built-in and custom COPC backends. */
export type CopcBackendOpenOptions = {
  /** Aborted when this source is unloaded, reloaded, or destroyed. */
  signal?: AbortSignal;
  /** Aggregate diagnostics for source-owned byte-range requests. */
  rangeRequestDiagnostics?: RangeRequestDiagnosticsRecorder;
  /** HTTP validation policy; defaults to `head-fallback`. Use `strict` to require readable Content-Range. */
  rangeValidation?: RangeValidationPolicy;
  /** Per-range byte ceiling. Defaults to 64 MiB; explicit values accept any positive safe integer. */
  maxRangeBytes?: number;
  /** Maximum active HTTP ranges per source. Defaults to 4; any positive safe integer is accepted. */
  maxConcurrentRangeRequests?: number;
  /** Manual additive ellipsoidal-height correction in metres; defaults to 0. */
  heightOffsetMeters?: number;
};

/** Cumulative job and concurrency counters for a backend decode worker pool. */
export type CopcWorkerDiagnostics = {
  /** Number of worker slots configured for the pool. */
  workerCount: number;
  /** Workers currently executing a job. */
  activeCount: number;
  /** Jobs waiting for a worker slot. */
  queuedCount: number;
  /** Highest simultaneous active worker count observed. */
  peakActiveCount: number;
  /** Highest simultaneous queued job count observed. */
  peakQueuedCount: number;
  /** Jobs submitted to the pool. */
  submittedCount: number;
  /** Jobs that completed successfully. */
  completedCount: number;
  /** Jobs cancelled before completion. */
  cancelledCount: number;
  /** Jobs that failed. */
  failedCount: number;
};

/** An opened COPC resource expressed only in project-owned types. */
export interface CopcSource extends CopcHierarchySource {
  /** Resource identity used for range reads and diagnostics. */
  readonly source: string;
  /** Height offset already included by `loadPreparedPointData`; omitted means zero. */
  readonly preparedHeightOffsetMeters?: number;
  /** Return metadata parsed during source initialization. */
  getMetadata(): CopcMetadata;
  /** Load a requested point-field view for one hierarchy node. */
  loadPointDataView(
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
    options?: CopcPointLoadOptions,
  ): Promise<CopcPointView>;
  /** Optional direct buffer path for backends that already decode points. */
  loadPointDataBuffer?(
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
    options?: CopcPointLoadOptions,
  ): Promise<CopcPointBuffer>;
  /** Optional fused decode/CRS/ECEF path for renderer-neutral cache entries. */
  loadPreparedPointData?(
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
    options?: CopcPointLoadOptions,
  ): Promise<PreparedPointData>;
  /**
   * Subscribe to source-side range, decode, and point-preparation measurements.
   *
   * Pass `undefined` to clear the observer.
   */
  setPerformanceObserver?(observer: CopcPerformanceObserver | undefined): void;
  /** Drop queued decode work that cannot contribute to the current view. */
  cancelPendingPointJobs?(): void;
  /** Optional decode-worker queue/concurrency diagnostics. */
  getWorkerDiagnostics?(): CopcWorkerDiagnostics | undefined;
  /** Release source-owned worker/runtime resources. */
  destroy?(): void;
}

/** Opens COPC resources without exposing the library used to read them. */
export interface CopcBackend {
  /** Open a COPC source for metadata, hierarchy, and point reads. */
  open(
    source: CopcInputSource,
    options?: CopcBackendOpenOptions,
  ): Promise<CopcSource>;
}
