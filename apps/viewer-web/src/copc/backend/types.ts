import type { CopcHierarchySource } from '../hierarchy/types';
import type {
  CopcHierarchyNode,
  CopcMetadata,
  CopcPointBuffer,
  CopcPointView,
  PreparedPointData,
} from '../types/copc';
import type { CopcPointFieldSelection } from '../points/fieldSelection';
import type { CopcPerformanceObserver } from '../performance';
import type { RangeRequestDiagnosticsRecorder } from '../range/requestDiagnostics';
import type { RangeValidationPolicy } from '../range/types';

export type CopcPointLoadOptions = {
  /** Cancels only this point-node read; shared hierarchy reads remain reusable. */
  signal?: AbortSignal;
};

export type CopcBackendOpenOptions = {
  /** Aborted when this source is unloaded, reloaded, or destroyed. */
  signal?: AbortSignal;
  /** Aggregate diagnostics for source-owned byte-range requests. */
  rangeRequestDiagnostics?: RangeRequestDiagnosticsRecorder;
  /** Defaults to strict Content-Range validation. */
  rangeValidation?: RangeValidationPolicy;
  /** Per-range byte ceiling. Defaults to 64 MiB; explicit values accept any positive safe integer. */
  maxRangeBytes?: number;
  /** Maximum active HTTP ranges per source. Defaults to 4; any positive safe integer is accepted. */
  maxConcurrentRangeRequests?: number;
  /** Manual additive ellipsoidal-height correction in metres; defaults to 0. */
  heightOffsetMeters?: number;
};

export type CopcWorkerDiagnostics = {
  workerCount: number;
  activeCount: number;
  queuedCount: number;
  peakActiveCount: number;
  peakQueuedCount: number;
  submittedCount: number;
  completedCount: number;
  cancelledCount: number;
  failedCount: number;
};

/** An opened COPC resource expressed only in project-owned types. */
export interface CopcSource extends CopcHierarchySource {
  readonly source: string;
  getMetadata(): CopcMetadata;
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
  open(source: string, options?: CopcBackendOpenOptions): Promise<CopcSource>;
}
