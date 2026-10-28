import { createCopcContext } from "../copc/context/createCopcContext";
import type { CopcSource, CopcWorkerDiagnostics } from "../copc/backend/types";
import {
  getCopcBackendName,
  type CopcBackendSelection,
  type CopcBackendName,
} from "../copc/backend/selection";
import type { CopcPointDecoder } from "../copc/points/types";
import { HierarchyLoader } from "../copc/hierarchy/HierarchyLoader";
import type {
  CopcHierarchyBounds,
  CopcHierarchyDiagnostics,
  CopcProjectBounds,
  CopcHierarchyQuery,
} from "../copc/hierarchy/types";
import { CopcHierarchyLoadError, CopcLoadError } from "../copc/errors";
import { loadCopcMetadata } from "../copc/metadata/loadMetadata";
import { loadCopcPointBuffer } from "../copc/points/loadPointData";
import { wasmCopcPointDecoder } from "../wasm/copcDecoder";
import {
  createCopcPointFieldSelection,
  type CopcPointFieldSelection,
} from "../copc/points/fieldSelection";
import {
  applyPreparedPointVerticalGrid,
  applyPreparedPointHeightOffset,
  createPointTransformer,
  createProjectPointTransformer,
  transformPointBufferToPreparedPointData,
} from "../coordinates/transform/createPointTransformer";
import {
  getCoordinateTransformPlan,
  type CoordinateTransformPlan,
} from "../coordinates/transform/coordinateTransformPlan";
import { resolveHeightOffsetMeters } from "../coordinates/transform/heightOffset";
import { GtxGeoidGrid } from "../coordinates/transform/verticalGrid";
import type {
  CopcMetadata,
  GeographicPointBuffer,
  PreparedPointData,
} from "../copc/types/copc";
import {
  assertPreparedPointData,
  recordPreparedCoordinateOperations,
  preparedPointDataToGeographicBuffer,
} from "../point/preparedPoint";
import {
  assertLegacyCoordinatesAvailable,
  cachedPointDataToRenderablePointData,
  createCompactEPointCacheNode,
  type CachedPointData,
  type CompactECoordinateRetention,
  type CompactEPointProvenance,
  type RenderablePointData,
} from "../point/compactEPointCache";
import type { CopcPerformanceObserver } from "../copc/performance";
import { performanceNow } from "../copc/performance";
import { buildStreamingHierarchy } from "./buildStreamingHierarchy";
import {
  createNodePointCache,
  type NodePointCache,
  type NodePointCacheDiagnostics,
  type NodePointLoadPurpose,
} from "./createNodePointCache";
import { DEFAULT_MAX_RENDERED_POINTS, NodeSelector } from "./NodeSelector";
import { StreamingManager } from "./StreamingManager";
import { AdaptiveViewDistancePolicy, createStreamingViewBounds } from "./view";
import type { AdaptiveViewDistanceDiagnostics } from "./view";
import type {
  StreamingHierarchy,
  StreamingHierarchyNode,
  StreamingProgress,
  StreamingReplacementGroup,
  StreamingSelectionOptions,
  StreamingUpdateResult,
  StreamingView,
  StreamingWorkProgress,
} from "./types";
import {
  StreamingPerformanceRecorder,
  type StreamingPerformanceSnapshot,
} from "./performance";
import { DEFAULT_MAX_CONCURRENT_NODE_LOADS } from "./scheduler";
import { areStreamingViewsEquivalent } from "./areStreamingViewsEquivalent";
import {
  CameraMotionLookaheadEstimator,
  type CameraMotionLiveDiagnostics,
  type CameraMotionObservation,
  type CameraMotionPrediction,
} from "./motionLookahead";
import {
  createPredictedStreamingView,
  isOffscreenFromCurrentView,
} from "./predictivePrefetch";
import {
  RANGE_CANCELLATION_REASON,
  RangeRequestDiagnosticsRecorder,
} from "../copc/range/requestDiagnostics";
import type { RangeRequestDiagnostics } from "../copc/range/requestDiagnostics";
import type { RangeValidationPolicy } from "../copc/range/types";
import type { CopcInputSource } from "../copc/range/types";
import { getCopcSourceIdentity } from "../copc/getter/createCopcGetter";
import {
  DEFAULT_REFINEMENT_ALGORITHM,
  normalizeRefinementFocus,
  resolveRefinementAlgorithm,
  type RefinementFocus,
} from "./refinementStrategies";

/** Lifecycle states that do not depend on an attached rendering engine. */
export type CopcStreamingLifecycleState =
  /** Constructed and not loading a source. */
  | "idle"
  /** Opening source, reading metadata, or loading the root hierarchy. */
  | "loading"
  /** Metadata and root hierarchy are ready for view-driven point loading. */
  | "ready"
  /** Permanently destroyed. */
  | "destroyed";

/** Renderer-facing coverage replacement intent for one view generation. */
export type CopcStreamingTransitionState = {
  /** The view generation that produced this intent. */
  generation: number;
  /** Coverage-safe replacement intents for the renderer adapter. */
  replacementGroups: StreamingReplacementGroup[];
};

/** Source, backend, and bounded resource policies for the shared streaming core. */
export type CopcStreamingControllerOptions = {
  /** Source URL or source identity used by the selected backend. */
  url: CopcInputSource;
  /** Overrides for shared selection and streaming limits; top-level maxRenderedPoints takes precedence over this compatibility field. */
  streaming?: Partial<StreamingSelectionOptions>;
  /** Canonical rendered-point workload budget; overrides streaming.maxRenderedPoints. Defaults to 250,000. */
  maxRenderedPoints?: number;
  /** Stable `copc-js` by default, Rust or a test backend by explicit choice. */
  backend?: CopcBackendSelection;
  /** Manual additive correction in metres applied to ellipsoidal point height. Defaults to 0. */
  heightOffsetMeters?: number;
  /** Explicit, caller-supplied GTX transform. Omitted means no vertical datum conversion. */
  verticalTransform?: GtxGeoidGrid;
  /** Decoder used when the source does not expose direct point buffers. */
  decoder?: CopcPointDecoder;
  /** Fields requested from each backend point chunk. Defaults to position only. */
  pointFields?: CopcPointFieldSelection;
  /** Maximum retained decoded CPU point-buffer bytes. Defaults to 256 MiB. */
  maxPointCacheBytes?: number;
  /** HTTP validation policy; defaults to `head-fallback`. Use `strict` to require readable Content-Range. */
  rangeValidation?: RangeValidationPolicy;
  /** Per-range byte ceiling. Defaults to 64 MiB; explicit values accept any positive safe integer. */
  maxRangeBytes?: number;
  /** Maximum active HTTP ranges per source. Defaults to 4; any positive safe integer is accepted. */
  maxConcurrentRangeRequests?: number;
  /** Emits lifecycle messages through console.debug. */
  debug?: boolean;
};

/** Core terminology alias for applications that avoid the controller name. */
export type CopcStreamingCoreOptions = CopcStreamingControllerOptions;

/** Receives incremental prepared-node data while the current view is loading. */
export type CopcStreamingProgressHandler<TPointData = PreparedPointData> = (
  progress: StreamingProgress<TPointData>,
) => void;
export type CopcStreamingWorkProgressHandler = (
  progress: StreamingWorkProgress,
) => void;

/**
 * Core-owned streaming, range-fetch, decode, and point-preparation measurements.
 *
 * Durations are in milliseconds and `rangeFetchBytes` counts byte-range
 * response bodies. Renderer-side preparation and GPU frame time are not
 * included; renderer adapters expose their own measurements separately.
 */
export type CopcStreamingPerformanceSnapshot = Pick<
  StreamingPerformanceSnapshot,
  | "updateDurationMs"
  | "nodeSelectionMs"
  | "selectedNodeCount"
  | "estimatedSelectedPointCount"
  | "configuredPointBudget"
  | "candidateSelectedPointCount"
  | "activeRenderedPointCount"
  | "deferredNodeCount"
  | "deferredPointCount"
  | "budgetDeferDropCount"
  | "budgetUtilizationPercent"
  | "candidatesBeforeCulling"
  | "frustumCulledCount"
  | "maxScreenSpaceError"
  | "screenSpaceErrorMin"
  | "screenSpaceErrorMax"
  | "effectiveScreenSpaceErrorMin"
  | "effectiveScreenSpaceErrorMax"
  | "refinedNodeCount"
  | "keptNodeCount"
  | "frontierNodeCount"
  | "frontierPointCount"
  | "acceptedRefinementCount"
  | "refinementRejectedByNodeBudgetCount"
  | "refinementRejectedByPointBudgetCount"
  | "refinementDeferredByIncompleteHierarchyCount"
  | "minimumFrontierExceedsNodeBudget"
  | "minimumFrontierExceedsPointBudget"
  | "maxConcurrentNodeLoads"
  | "queuedNodeCount"
  | "activeNodeCount"
  | "queuedHighPriorityNodeCount"
  | "activeHighPriorityNodeCount"
  | "completedNodeCount"
  | "cancelledNodeCount"
  | "peakActiveNodeCount"
  | "completedSchedulingPriorityMin"
  | "completedSchedulingPriorityMax"
  | "pendingSchedulingPriorityMin"
  | "pendingSchedulingPriorityMax"
  | "firstHighPriorityNodeStartLatencyMs"
  | "firstHighPriorityNodeReadyLatencyMs"
  | "centerWeightMin"
  | "centerWeightMax"
  | "refinementCenterWeightMin"
  | "refinementCenterWeightMax"
  | "schedulingCenterWeightMin"
  | "schedulingCenterWeightMax"
  | "detailBiasMin"
  | "detailBiasMax"
  | "candidatesWithNonZeroInfluenceCount"
  | "acceptedGazeInfluencedRefinementCount"
  | "focusCandidateCount"
  | "focusWeightMin"
  | "focusWeightMax"
  | "focusInfluencedRefinementCount"
  | "motionLookaheadEnabled"
  | "motionSampledMovementCount"
  | "motionHorizontalAngularVelocityDegreesPerSecond"
  | "motionVerticalAngularVelocityDegreesPerSecond"
  | "motionHorizonMilliseconds"
  | "motionPredictedHorizontalDisplacementDegrees"
  | "motionPredictedVerticalDisplacementDegrees"
  | "motionCandidateCount"
  | "motionWeightMin"
  | "motionWeightMax"
  | "motionInfluencedRefinementCount"
  | "refinementAlgorithm"
  | "refinementFocusEnabled"
  | "influenceClampCount"
  | "acceptedRefinementPriorityMin"
  | "acceptedRefinementPriorityMax"
  | "refinementPriorityMin"
  | "refinementPriorityMax"
  | "schedulingPriorityMin"
  | "schedulingPriorityMax"
  | "candidatesWithCenterBoostCount"
  | "hysteresisHoldCount"
  | "refineDecisionCount"
  | "collapseDecisionCount"
  | "visibleLevelRange"
  | "cameraDirection"
  | "loadedNodeCount"
  | "loadedPointCount"
  | "rangeFetchDurationMs"
  | "rangeFetchBytes"
  | "decodeDurationMs"
  | "pointPreparationDurationMs"
  | "crsTransformDurationMs"
  | "longestMainThreadBlockingSectionMs"
> & {
  /** Current decayed estimator state, sampled when `getSnapshot()` is called. */
  motionLive: CameraMotionLiveDiagnostics & {
    /** Accepted movement samples since camera-motion history was reset. */
    acceptedMovementSampleCount: number;
  };
};

/** Detached diagnostics for one shared streaming core. */
export type CopcStreamingSnapshot = {
  /** Current core lifecycle state. */
  lifecycle: CopcStreamingLifecycleState;
  /** Open resource identity or configured source URL before opening. */
  source: string;
  /** Built-in backend identifier or `custom`. */
  backend: CopcBackendName | "custom";
  /** Selected hierarchy nodes for the latest completed view update. */
  selectedNodeKeys: string[];
  /** Number of view updates completed by the core. */
  streamingUpdateCount: number;
  /** Core-owned timings, counts, and byte measurements. */
  performance: CopcStreamingPerformanceSnapshot;
  /** Coverage replacement intent produced by the latest completed update. */
  transition: CopcStreamingTransitionState;
  /** Adaptive view-distance diagnostics when a view has been evaluated. */
  viewDistance?: AdaptiveViewDistanceDiagnostics;
  /** Hierarchy request, cache, and duration counters after loading. */
  hierarchy?: CopcHierarchyDiagnostics;
  /** Retained decoded CPU point-buffer bytes and cache activity. */
  pointCache: NodePointCacheDiagnostics;
  /** Source-owned HTTP range request lifecycle counters.
   * Transferred bytes are reported in `performance.rangeFetchBytes`.
   */
  rangeRequests: RangeRequestDiagnostics;
  /** Decode-worker queue counters when exposed by the selected backend. */
  worker?: CopcWorkerDiagnostics;
  /** Bounded speculative preparation counters when enabled. */
  predictivePrefetch?: PredictivePrefetchDiagnostics;
};

type StreamingState = {
  context: CopcSource;
  metadata: CopcMetadata;
  minimumDatasetHeightMeters?: number;
  hierarchyLoader: HierarchyLoader;
  nodes: StreamingHierarchy;
  nodesRef: { current: StreamingHierarchy };
  cache: NodePointCache<CachedPointData>;
  manager: StreamingManager;
};

const INTERNAL_CACHE_LAYOUT = Symbol("internalPointCacheLayout");
type InternalStreamingOptions = CopcStreamingControllerOptions & {
  [INTERNAL_CACHE_LAYOUT]?: {
    layout: "A" | "E";
    retain: CompactECoordinateRetention;
  };
};

const cachedRenderablePointAccessors = new WeakMap<
  object,
  (nodeKey: string) => RenderablePointData | undefined
>();

const DEFAULT_STREAMING_OPTIONS: StreamingSelectionOptions = {
  maxNodes: 24,
  maxDepth: 6,
  maxScreenSpaceError: 8,
  refineDistanceMultiplier: 6,
  maxRenderDistanceMeters: 12000,
  maxRenderedPoints: DEFAULT_MAX_RENDERED_POINTS,
  maxConcurrentNodeLoads: DEFAULT_MAX_CONCURRENT_NODE_LOADS,
  refinementAlgorithm: DEFAULT_REFINEMENT_ALGORITHM,
  motionLookahead: true,
};
const MAX_CACHED_NODES = 48;
const DEFAULT_POINT_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_PREFETCH_NODES_PER_UPDATE = 2;
const MAX_PREFETCH_POINTS_PER_UPDATE = 25_000;
const MAX_PREFETCH_POINT_RANGE_BYTES_PER_UPDATE = 8 * 1024 * 1024;
const MAX_PREFETCH_HIERARCHY_PAGES_PER_UPDATE = 1;
const ESTIMATED_PREPARED_BYTES_PER_POINT = 96;

/** Detached counters for the optional bounded future-view preparation path. */
export type PredictivePrefetchDiagnostics = {
  enabled: boolean;
  generation: number;
  queuedNodeCount: number;
  activeNodeCount: number;
  completedNodeCount: number;
  failedNodeCount: number;
  cancelledNodeCount: number;
  usefulCacheHitCount: number;
  evictedUnusedNodeCount: number;
  pointRangeRequestCount: number;
  pointRangeBytesRequested: number;
  hierarchyQueryCount: number;
  hierarchyPageVisitCount: number;
  hierarchyPageRequestCount: number;
  hierarchyPageCacheHitCount: number;
  maxNodesPerUpdate: number;
  maxPointsPerUpdate: number;
  maxPointRangeBytesPerUpdate: number;
  maxHierarchyPagesPerUpdate: number;
};

type PredictivePrefetchPlan = {
  generation: number;
  controller: AbortController;
  state: StreamingState;
  queue: string[];
};

function createTransitionState(): CopcStreamingTransitionState {
  return {
    generation: 0,
    replacementGroups: [],
  };
}

function createPointLoadAbortError(signal: AbortSignal): Error {
  const error = new Error("Point-node load was cancelled", {
    cause: signal.reason,
  });
  error.name = "AbortError";
  return error;
}

function cloneTransitionState(
  state: CopcStreamingTransitionState,
): CopcStreamingTransitionState {
  return {
    generation: state.generation,
    replacementGroups: state.replacementGroups.map((group) => ({
      kind: group.kind,
      oldNodeKeys: [...group.oldNodeKeys],
      newNodeKeys: [...group.newNodeKeys],
    })),
  };
}

function toProjectBounds(
  metadata: CopcMetadata,
  geographicBounds: CopcHierarchyBounds,
  heightOffsetMeters: number,
  verticalGrid?: GtxGeoidGrid,
): CopcProjectBounds {
  // Camera-envelope corners are synthetic. Convert their horizontal position
  // without sampling a regional grid, then bound source height from extrema.
  const toProject = createProjectPointTransformer(
    metadata,
    heightOffsetMeters,
    verticalGrid,
    { sampleVerticalGrid: false },
  );
  const corners = [
    [geographicBounds.minX, geographicBounds.minY, geographicBounds.minZ],
    [geographicBounds.minX, geographicBounds.minY, geographicBounds.maxZ],
    [geographicBounds.minX, geographicBounds.maxY, geographicBounds.minZ],
    [geographicBounds.minX, geographicBounds.maxY, geographicBounds.maxZ],
    [geographicBounds.maxX, geographicBounds.minY, geographicBounds.minZ],
    [geographicBounds.maxX, geographicBounds.minY, geographicBounds.maxZ],
    [geographicBounds.maxX, geographicBounds.maxY, geographicBounds.minZ],
    [geographicBounds.maxX, geographicBounds.maxY, geographicBounds.maxZ],
  ].map(([longitude, latitude, height]) =>
    toProject({ longitude, latitude, height }),
  );

  const transformed = corners.reduce<CopcProjectBounds>(
    (bounds, point) => ({
      coordinateSystem: "copc-source",
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      minZ: Math.min(bounds.minZ, point.z),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y),
      maxZ: Math.max(bounds.maxZ, point.z),
    }),
    {
      coordinateSystem: "copc-source",
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    },
  );
  if (!verticalGrid) return transformed;
  const verticalUnitScale = verticalGrid.getSourceVerticalUnitScale(
    metadata.wkt,
  );
  const conservativeMinimum =
    (geographicBounds.minZ -
      heightOffsetMeters -
      verticalGrid.maximumUndulationMeters) /
    verticalUnitScale;
  const conservativeMaximum =
    (geographicBounds.maxZ -
      heightOffsetMeters -
      verticalGrid.minimumUndulationMeters) /
    verticalUnitScale;
  return {
    ...transformed,
    minZ: conservativeMinimum,
    maxZ: conservativeMaximum,
  };
}

function getMinimumDatasetHeightMeters(
  metadata: CopcMetadata,
  heightOffsetMeters: number,
  verticalGrid?: GtxGeoidGrid,
): number | undefined {
  try {
    if (verticalGrid) {
      const verticalUnitScale = verticalGrid.getSourceVerticalUnitScale(
        metadata.wkt,
      );
      const minimum =
        metadata.bounds.minZ * verticalUnitScale +
        verticalGrid.minimumUndulationMeters +
        heightOffsetMeters;
      return Number.isFinite(minimum) ? minimum : undefined;
    }
    const transformPoint = createPointTransformer(metadata, heightOffsetMeters);
    const minimum = transformPoint({
      x: metadata.bounds.minX,
      y: metadata.bounds.minY,
      z: metadata.bounds.minZ,
    }).height;
    return Number.isFinite(minimum) ? minimum : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Owns COPC loading and renderer-independent streaming state.
 *
 * This class intentionally has no knowledge of Cesium, Three.js, Babylon, a
 * render loop, or a scene. Engine adapters provide a `StreamingView`, consume
 * progress/update results, and decide when view updates should be scheduled.
 */
class CopcStreamingCoreImplementation<TPointData> {
  private readonly options: CopcStreamingControllerOptions;
  private readonly heightOffsetMeters: number;
  private readonly verticalGrid?: GtxGeoidGrid;
  private performanceRecorder: StreamingPerformanceRecorder;
  private readonly rangeRequestDiagnostics =
    new RangeRequestDiagnosticsRecorder();
  private readonly initialCache: NodePointCache<CachedPointData>;
  private readonly cacheLayout: "A" | "E";
  private readonly compactECoordinateRetention: CompactECoordinateRetention;
  private readonly pointFields: CopcPointFieldSelection;
  private streamingState?: StreamingState;
  private loadGeneration = 0;
  private viewGeneration = 0;
  private streamingUpdateCount = 0;
  private selectedNodeKeys = new Set<string>();
  private currentView?: StreamingView;
  private readonly adaptiveViewDistancePolicy =
    new AdaptiveViewDistancePolicy();
  private readonly motionEstimator: CameraMotionLookaheadEstimator;
  private motionSampledMovementCount = 0;
  private motionTimestampOffsetMilliseconds?: number;
  private motionTimestampAnchorMilliseconds?: number;
  private motionTimestampAnchorPerformanceMilliseconds?: number;
  private transition = createTransitionState();
  private lifecycle: CopcStreamingLifecycleState = "idle";
  private lifecycleAbortController?: AbortController;
  private refinementFocus?: RefinementFocus;
  private predictivePrefetchGeneration = 0;
  private predictivePrefetchController?: AbortController;
  private predictivePrefetchQueue: string[] = [];
  private readonly activePredictivePrefetchTasks = new Set<{
    state: StreamingState;
  }>();
  private predictivePrefetchCompletedNodeCount = 0;
  private predictivePrefetchFailedNodeCount = 0;
  private predictivePrefetchCancelledNodeCount = 0;
  private predictivePrefetchPointRangeRequestCount = 0;
  private predictivePrefetchPointRangeBytesRequested = 0;
  private predictivePrefetchHierarchyQueryCount = 0;
  private predictivePrefetchHierarchyPageVisitCount = 0;
  private predictivePrefetchHierarchyPageRequestCount = 0;
  private predictivePrefetchHierarchyPageCacheHitCount = 0;

  constructor(options: CopcStreamingControllerOptions) {
    const selectedCacheLayout = (options as InternalStreamingOptions)[
      INTERNAL_CACHE_LAYOUT
    ];
    this.cacheLayout = selectedCacheLayout?.layout ?? "A";
    this.compactECoordinateRetention = {
      sourceCoordinates: selectedCacheLayout?.retain.sourceCoordinates === true,
      geographicCoordinates:
        selectedCacheLayout?.retain.geographicCoordinates === true,
    };
    cachedRenderablePointAccessors.set(this, (nodeKey) => {
      const cached = this.streamingState?.cache.get(nodeKey);
      return cached ? cachedPointDataToRenderablePointData(cached) : undefined;
    });
    this.heightOffsetMeters = resolveHeightOffsetMeters(
      options.heightOffsetMeters,
    );
    if (
      options.verticalTransform !== undefined &&
      !(options.verticalTransform instanceof GtxGeoidGrid)
    ) {
      throw new TypeError(
        "verticalTransform must be a grid returned by loadGtxGeoidGrid()",
      );
    }
    this.verticalGrid = options.verticalTransform;
    const refinementAlgorithm = resolveRefinementAlgorithm(
      options.streaming?.refinementAlgorithm,
    );
    this.options = {
      ...options,
      streaming: {
        ...options.streaming,
        refinementAlgorithm,
      },
      heightOffsetMeters: this.heightOffsetMeters,
    };
    this.motionEstimator = new CameraMotionLookaheadEstimator(
      options.streaming?.motionLookahead !== false,
    );
    this.pointFields = createCopcPointFieldSelection([
      "position",
      ...(options.pointFields ?? []),
    ]);
    this.performanceRecorder = this.createPerformanceRecorder();
    this.initialCache = this.createEmptyCache();
  }

  /**
   * Load source metadata and the root hierarchy without a rendering engine.
   *
   * Point chunks are fetched only by later view updates. When this method
   * resolves, metadata and the root page are available, but child hierarchy
   * pages and point data remain lazy.
   *
   * @throws If source opening, metadata parsing, or root hierarchy loading fails.
   */
  async load(): Promise<void> {
    if (this.lifecycle === "destroyed") {
      throw new Error("CopcStreamingController has been destroyed");
    }
    if (this.streamingState) {
      throw new Error(
        "COPC streaming controller is already loaded; call reload() to load it again",
      );
    }
    if (this.lifecycle === "loading") {
      throw new Error("COPC streaming controller is already loading");
    }

    this.lifecycle = "loading";
    const loadGeneration = ++this.loadGeneration;
    const lifecycleAbortController = new AbortController();
    this.lifecycleAbortController = lifecycleAbortController;
    const performanceRecorder = this.performanceRecorder;
    let context: CopcSource | undefined;

    try {
      const sourceOpenStartedAt = performanceNow();
      context = await createCopcContext(
        this.options.url,
        this.options.backend,
        {
          signal: lifecycleAbortController.signal,
          rangeRequestDiagnostics: this.rangeRequestDiagnostics,
          rangeValidation: this.options.rangeValidation,
          maxRangeBytes: this.options.maxRangeBytes,
          maxConcurrentRangeRequests: this.options.maxConcurrentRangeRequests,
          heightOffsetMeters: this.heightOffsetMeters,
        },
      );
      const sourceOpenDurationMs = Math.max(
        0,
        performanceNow() - sourceOpenStartedAt,
      );
      if (!this.isCurrentLoad(loadGeneration)) {
        context.destroy?.();
        return;
      }

      context.setPerformanceObserver?.(
        this.createPerformanceObserver(performanceRecorder),
      );
      const metadataLoadStartedAt = performanceNow();
      const metadata = await loadCopcMetadata(context);
      const metadataLoadDurationMs = Math.max(
        0,
        performanceNow() - metadataLoadStartedAt,
      );
      if (!this.isCurrentLoad(loadGeneration)) {
        context.destroy?.();
        return;
      }
      this.verticalGrid?.assertCompatibleSourceWkt(metadata.wkt);

      const hierarchyLoader = new HierarchyLoader(context, metadata.cube, {
        sourceOpenDurationMs,
        metadataLoadDurationMs,
      });
      let rootHierarchy;
      try {
        rootHierarchy = await hierarchyLoader.loadRoot();
      } catch (error: unknown) {
        if (error instanceof CopcLoadError) {
          throw error;
        }
        throw new CopcHierarchyLoadError(context.source, { cause: error });
      }

      if (!this.isCurrentLoad(loadGeneration)) {
        context.destroy?.();
        return;
      }

      const nodes = buildStreamingHierarchy(
        metadata,
        rootHierarchy.nodes,
        this.heightOffsetMeters,
        this.verticalGrid,
      );
      const nodesRef = { current: nodes };
      const cache = this.createCache(
        context,
        metadata,
        nodesRef,
        performanceRecorder,
        loadGeneration,
      );
      const manager = new StreamingManager(
        nodes,
        {
          ...DEFAULT_STREAMING_OPTIONS,
          ...this.options.streaming,
          ...(this.options.maxRenderedPoints === undefined
            ? {}
            : { maxRenderedPoints: this.options.maxRenderedPoints }),
        },
        cache,
        this.performanceRecorder,
        context.cancelPendingPointJobs?.bind(context),
        cachedPointDataToRenderablePointData,
      );
      manager.setRefinementFocus(this.refinementFocus);
      manager.setMotionPrediction(
        this.motionEstimator.getPrediction(this.getMotionEstimatorTimestamp()),
      );

      this.streamingState = {
        context,
        metadata,
        minimumDatasetHeightMeters: getMinimumDatasetHeightMeters(
          metadata,
          this.heightOffsetMeters,
          this.verticalGrid,
        ),
        hierarchyLoader,
        nodes,
        nodesRef,
        cache,
        manager,
      };
      this.lifecycle = "ready";
      this.debug("COPC metadata and hierarchy loaded");
    } catch (error: unknown) {
      if (!this.isCurrentLoad(loadGeneration)) {
        context?.destroy?.();
        return;
      }
      lifecycleAbortController.abort(RANGE_CANCELLATION_REASON.lifecycle);
      if (this.lifecycleAbortController === lifecycleAbortController) {
        this.lifecycleAbortController = undefined;
      }
      context?.destroy?.();
      this.lifecycle = "idle";
      throw error;
    }
  }

  /**
   * Update selection and point streaming for a renderer-neutral view.
   * Camera motion is sampled from each supplied view, so direct core consumers
   * do not need a separate observation call for ordinary view updates.
   *
   * `undefined` means the update was superseded by a newer view or lifecycle
   * operation. Current-generation progress is delivered incrementally before
   * the promise resolves. Returned point data is prepared but is not committed
   * to any renderer; the adapter owns that commit and its completion event.
   *
   * @returns The selected keys and loaded prepared nodes, or `undefined` for stale work.
   * @throws If the core is destroyed, not loaded, or the current view's hierarchy/point work fails.
   */
  async updateView(
    view: StreamingView,
    onProgress?: CopcStreamingProgressHandler<TPointData>,
    onWorkProgress?: CopcStreamingWorkProgressHandler,
  ): Promise<StreamingUpdateResult<TPointData> | undefined> {
    if (this.lifecycle === "destroyed") {
      throw new Error("CopcStreamingController has been destroyed");
    }
    const streamingState = this.streamingState;
    if (!streamingState || this.lifecycle !== "ready") {
      throw new Error("COPC streaming controller is not loaded");
    }
    // Adapters may also sample intermediate camera events between streaming
    // transactions. Sampling here makes the documented direct-core update loop
    // participate in the same motion model without requiring adapter APIs.
    this.observeCameraMotion(view);
    const motionPrediction = this.motionEstimator.getPrediction(
      this.getMotionEstimatorTimestamp(),
    );
    const adaptiveView = this.adaptiveViewDistancePolicy.apply(
      view,
      this.getStreamingOptions().maxRenderDistanceMeters,
      streamingState.minimumDatasetHeightMeters,
    );

    const equivalentToCurrentView =
      this.currentView !== undefined &&
      areStreamingViewsEquivalent(this.currentView, adaptiveView);
    const viewGeneration = ++this.viewGeneration;
    if (!equivalentToCurrentView) {
      this.supersedePredictivePrefetch();
    }
    // Invalidate queued point work while the generation's hierarchy query is
    // still in flight. The manager also invalidates at update start, matching
    // the established stale-result semantics.
    if (!equivalentToCurrentView) {
      streamingState.manager.invalidate("superseded", adaptiveView);
    }
    // Start measuring before a view can discover uncached hierarchy pages. The
    // manager is told to continue this recording after the query completes.
    this.performanceRecorder.beginUpdate();

    let hierarchy;
    try {
      hierarchy = await streamingState.hierarchyLoader.query(
        this.createHierarchyQuery(adaptiveView),
      );
    } catch (error: unknown) {
      if (!this.isCurrentView(viewGeneration, streamingState)) {
        return undefined;
      }
      throw error;
    }
    if (!this.isCurrentView(viewGeneration, streamingState)) {
      return undefined;
    }

    const availableNodes = buildStreamingHierarchy(
      streamingState.metadata,
      hierarchy.nodes,
      this.heightOffsetMeters,
      this.verticalGrid,
    );
    streamingState.nodes = availableNodes;
    streamingState.nodesRef.current = availableNodes;
    streamingState.manager.setHierarchy(availableNodes);
    streamingState.manager.setMotionPrediction(motionPrediction);

    // Start the capped future-view hierarchy query before current point loads
    // begin. Its continuation is attached after manager.update() has
    // synchronously selected and queued current-view work.
    const predictivePrefetchPlan =
      this.getStreamingOptions().predictivePrefetch === true
        ? this.preparePredictivePrefetch(
            viewGeneration,
            adaptiveView,
            streamingState,
            motionPrediction,
          )
        : undefined;

    let progressApplied = false;
    const applyProgress = (
      progress: StreamingProgress<RenderablePointData>,
    ): void => {
      if (!this.isCurrentView(viewGeneration, streamingState)) {
        return;
      }

      progressApplied = true;
      this.applyProgress(progress, onProgress, viewGeneration);
    };
    const updatePromise = streamingState.manager.update(
      adaptiveView,
      applyProgress,
      {
        performanceAlreadyStarted: true,
        ...(onWorkProgress
          ? {
              onWorkProgress: (progress: StreamingWorkProgress) => {
                if (this.isCurrentView(viewGeneration, streamingState)) {
                  onWorkProgress(progress);
                }
              },
            }
          : {}),
      },
    );
    if (predictivePrefetchPlan) {
      void predictivePrefetchPlan
        .then((plan) => (plan ? this.runPredictivePrefetch(plan) : undefined))
        .catch(() => {
          // Speculative work is isolated from current-view update results.
        });
    }
    const update = await updatePromise;
    if (!this.isCurrentView(viewGeneration, streamingState)) {
      return undefined;
    }

    // StreamingManager emits an initial progress event today. Keep this
    // fallback so the core contract remains valid for compatible manager
    // implementations that only return an all-at-once result.
    if (!progressApplied) {
      applyProgress({
        ...update,
        completedBatchPointCount: update.loadedNodePoints.size,
      });
    }

    this.selectedNodeKeys = new Set(update.selectedNodeKeys);
    this.transition = {
      generation: viewGeneration,
      replacementGroups: update.replacementGroups ?? [],
    };
    this.currentView = adaptiveView;
    this.streamingUpdateCount += 1;
    this.debug(`streaming view updated (${this.streamingUpdateCount})`);
    return update as unknown as StreamingUpdateResult<TPointData>;
  }

  /**
   * Return the source-coordinate hierarchy query for a view without advancing the adaptive-distance state.
   *
   * The bounds use the COPC source CRS and units; `maxLevel` follows the
   * configured maximum depth.
   */
  getHierarchyQuery(view: StreamingView): CopcHierarchyQuery {
    const adaptiveView = this.adaptiveViewDistancePolicy.preview(
      view,
      this.getStreamingOptions().maxRenderDistanceMeters,
      this.streamingState?.minimumDatasetHeightMeters,
    );
    return this.createHierarchyQuery(adaptiveView);
  }

  private createHierarchyQuery(view: StreamingView): CopcHierarchyQuery {
    const metadata = this.streamingState?.metadata;
    if (!metadata) {
      throw new Error("COPC streaming controller is not loaded");
    }

    const streamingOptions = this.getStreamingOptions();
    const viewBounds = createStreamingViewBounds({
      camera: view,
      viewDistanceMeters: view.viewDistanceMeters,
      maxRenderDistanceMeters: streamingOptions.maxRenderDistanceMeters,
      viewFrustum: view.viewFrustum,
    });

    return {
      bounds: toProjectBounds(
        metadata,
        viewBounds.bounds,
        this.heightOffsetMeters,
        this.verticalGrid,
      ),
      maxLevel: streamingOptions.maxDepth,
    };
  }

  /** Remove source, hierarchy, cache, and selected-view state while keeping the core reusable. */
  unload(): void {
    if (this.lifecycle === "destroyed") {
      return;
    }

    this.loadGeneration += 1;
    this.viewGeneration += 1;
    this.supersedePredictivePrefetch();
    this.lifecycleAbortController?.abort(RANGE_CANCELLATION_REASON.lifecycle);
    this.lifecycleAbortController = undefined;
    const state = this.streamingState;
    state?.manager.clear();
    state?.hierarchyLoader.reset();
    state?.context.destroy?.();
    state?.cache.clear();
    this.streamingState = undefined;
    this.selectedNodeKeys.clear();
    this.currentView = undefined;
    this.adaptiveViewDistancePolicy.reset();
    this.transition = createTransitionState();
    this.streamingUpdateCount = 0;
    // A pending decode may still complete after the source is destroyed. Give
    // the next source a recorder that those stale continuations cannot reach.
    this.performanceRecorder = this.createPerformanceRecorder();
    this.motionEstimator.reset();
    this.motionSampledMovementCount = 0;
    this.motionTimestampOffsetMilliseconds = undefined;
    this.motionTimestampAnchorMilliseconds = undefined;
    this.motionTimestampAnchorPerformanceMilliseconds = undefined;
    this.resetPredictivePrefetchDiagnostics();
    this.lifecycle = "idle";
    this.debug("COPC streaming controller unloaded");
  }

  /** Unload current state and load the configured source again. */
  async reload(): Promise<void> {
    this.unload();
    await this.load();
  }

  /** Permanently release all source-owned state; the core cannot be loaded again. */
  destroy(): void {
    if (this.lifecycle === "destroyed") {
      return;
    }

    this.unload();
    this.lifecycle = "destroyed";
  }

  /** Return a fresh diagnostics snapshot; it does not expose mutable live state. */
  getSnapshot(): CopcStreamingSnapshot {
    const state = this.streamingState;
    const worker = state?.context.getWorkerDiagnostics?.();
    return {
      lifecycle: this.lifecycle,
      source: state?.context.source ?? getCopcSourceIdentity(this.options.url),
      backend: getCopcBackendName(this.options.backend),
      selectedNodeKeys: this.getCurrentSelection(),
      streamingUpdateCount: this.streamingUpdateCount,
      performance: this.getPerformanceSnapshot(),
      transition: cloneTransitionState(this.transition),
      ...(this.currentView?.viewDistanceDiagnostics
        ? { viewDistance: { ...this.currentView.viewDistanceDiagnostics } }
        : {}),
      ...(state ? { hierarchy: state.hierarchyLoader.getDiagnostics() } : {}),
      pointCache:
        state?.cache.getDiagnostics() ?? this.initialCache.getDiagnostics(),
      rangeRequests: this.rangeRequestDiagnostics.getSnapshot(),
      ...(worker ? { worker } : {}),
      ...(this.getStreamingOptions().predictivePrefetch === true
        ? {
            predictivePrefetch: this.getPredictivePrefetchDiagnostics(
              state?.cache,
            ),
          }
        : {}),
    };
  }

  /** Return source metadata after loading, or `undefined` before load/after unload. */
  getMetadata(): CopcMetadata | undefined {
    return this.streamingState?.metadata;
  }

  /** Return page request/cache counters after the source has opened. */
  getHierarchyDiagnostics(): CopcHierarchyDiagnostics | undefined {
    return this.streamingState?.hierarchyLoader.getDiagnostics();
  }

  /** Return current decoded CPU point-buffer cache counters. */
  getPointCacheDiagnostics(): NodePointCacheDiagnostics {
    return (
      this.streamingState?.cache.getDiagnostics() ??
      this.initialCache.getDiagnostics()
    );
  }

  /** Return sorted node keys selected for the most recent completed view. */
  getCurrentSelection(): string[] {
    return [...this.selectedNodeKeys].sort();
  }

  /** Return the normalized current streaming view, when one has completed. */
  getCurrentView(): StreamingView | undefined {
    return this.currentView;
  }

  /**
   * Update the optional screen-circle refinement focus without reopening the
   * source or rebuilding hierarchy and cache state.
   */
  setRefinementFocus(focus: RefinementFocus | undefined): void {
    this.refinementFocus = normalizeRefinementFocus(focus);
    this.streamingState?.manager.setRefinementFocus(this.refinementFocus);
  }

  /**
   * Observe a renderer-neutral camera snapshot for current-view motion priority.
   *
   * Renderer adapters call this for camera events between streaming updates,
   * including before equivalent-view early returns. Direct core consumers can
   * rely on `updateView()` to sample each supplied view.
   * Optional explicit timestamps are rebased to the core's monotonic clock.
   */
  observeCameraMotion(
    view: StreamingView,
    timestampMilliseconds?: number,
  ): CameraMotionObservation {
    const now = performanceNow();
    let estimatorTimestamp = this.getMotionEstimatorTimestamp(now);
    if (timestampMilliseconds !== undefined) {
      if (
        Number.isFinite(timestampMilliseconds) &&
        timestampMilliseconds >= 0
      ) {
        // Explicit timestamps may use another monotonic origin (for example,
        // Date.now() or a deterministic test clock). Rebase that clock once
        // onto performance.now(); the anchor below lets the internal clock
        // advance from the latest explicit sample before wall time catches up.
        this.motionTimestampOffsetMilliseconds ??= now - timestampMilliseconds;
        estimatorTimestamp =
          timestampMilliseconds + this.motionTimestampOffsetMilliseconds;
      } else {
        // Preserve the estimator's invalid-timestamp handling.
        estimatorTimestamp = timestampMilliseconds;
      }
    }
    const observation = this.motionEstimator.observe(
      view.viewFrustum,
      estimatorTimestamp,
    );
    if (observation.sampledMovement) {
      this.supersedePredictivePrefetch();
    }
    if (observation.valid) {
      this.motionTimestampAnchorMilliseconds = estimatorTimestamp;
      this.motionTimestampAnchorPerformanceMilliseconds = now;
    }
    if (
      observation.sampledMovement &&
      this.motionSampledMovementCount < Number.MAX_SAFE_INTEGER
    ) {
      this.motionSampledMovementCount += 1;
    }
    this.streamingState?.manager.setMotionPrediction(observation.prediction);
    return observation;
  }

  /** Clear camera history and remove any motion priority retained by the selector. */
  resetCameraMotion(): void {
    this.motionEstimator.reset();
    this.motionSampledMovementCount = 0;
    this.motionTimestampOffsetMilliseconds = undefined;
    this.motionTimestampAnchorMilliseconds = undefined;
    this.motionTimestampAnchorPerformanceMilliseconds = undefined;
    this.streamingState?.manager.setMotionPrediction(
      this.motionEstimator.getPrediction(this.getMotionEstimatorTimestamp()),
    );
  }

  /** Return the current hierarchy node for an adapter-side pick or transition. */
  getHierarchyNode(nodeKey: string): StreamingHierarchyNode | undefined {
    return this.streamingState?.nodes.get(nodeKey);
  }

  /** Invalidate an in-flight view and cancel reads outside an optional next view. */
  invalidateView(view?: StreamingView): void {
    if (this.lifecycle === "destroyed") {
      return;
    }

    this.viewGeneration += 1;
    this.supersedePredictivePrefetch();
    const adaptiveView = view
      ? this.adaptiveViewDistancePolicy.preview(
          view,
          this.getStreamingOptions().maxRenderDistanceMeters,
        )
      : undefined;
    this.streamingState?.manager.invalidate("superseded", adaptiveView);
  }

  /** Return a detached copy of the current replacement intent. */
  getTransitionState(): CopcStreamingTransitionState {
    return cloneTransitionState(this.transition);
  }

  /**
   * Return the exact synchronous prepared view retained by production layout A.
   *
   * @throws If this internal experimental core retains layout E. E is a
   * renderer-neutral cache view, not the complete synchronous PreparedPointData
   * contract, even when an internal policy retains optional coordinate arrays.
   */
  getCachedPreparedPointData(nodeKey: string): PreparedPointData | undefined {
    const cached = this.streamingState?.cache.get(nodeKey);
    if (!cached) return undefined;
    assertLegacyCoordinatesAvailable(cached);
    return cached;
  }

  /**
   * Return the legacy flat view over a layout A prepared result.
   *
   * @throws If this internal experimental core retains layout E, which does
   * not expose the complete synchronous geographic/source compatibility view.
   */
  getCachedPointBuffer(nodeKey: string): GeographicPointBuffer | undefined {
    const prepared = this.getCachedPreparedPointData(nodeKey);
    return prepared ? preparedPointDataToGeographicBuffer(prepared) : undefined;
  }

  private async preparePredictivePrefetch(
    viewGeneration: number,
    view: StreamingView,
    state: StreamingState,
    prediction: CameraMotionPrediction,
  ): Promise<PredictivePrefetchPlan | undefined> {
    if (
      this.predictivePrefetchController &&
      !this.predictivePrefetchController.signal.aborted
    ) {
      return undefined;
    }
    const predictedView = createPredictedStreamingView(view, prediction);
    if (!predictedView || !this.isCurrentView(viewGeneration, state))
      return undefined;

    const controller = new AbortController();
    this.predictivePrefetchController = controller;
    const generation = ++this.predictivePrefetchGeneration;
    this.predictivePrefetchHierarchyQueryCount += 1;
    let hierarchy;
    try {
      hierarchy = await state.hierarchyLoader.query(
        this.createHierarchyQuery(predictedView),
        {
          maxPages: MAX_PREFETCH_HIERARCHY_PAGES_PER_UPDATE,
          signal: controller.signal,
          performanceObserver: null,
          onPageVisited: (cached) => {
            this.predictivePrefetchHierarchyPageVisitCount += 1;
            if (cached) {
              this.predictivePrefetchHierarchyPageCacheHitCount += 1;
            } else {
              this.predictivePrefetchHierarchyPageRequestCount += 1;
            }
          },
        },
      );
    } catch {
      if (
        !controller.signal.aborted &&
        this.isCurrentPrefetch(generation, state, controller)
      ) {
        this.predictivePrefetchFailedNodeCount += 1;
      }
      if (this.predictivePrefetchController === controller) {
        this.predictivePrefetchController = undefined;
      }
      return undefined;
    }
    if (!this.isCurrentPrefetch(generation, state, controller))
      return undefined;

    const discoveredNodes = buildStreamingHierarchy(
      state.metadata,
      hierarchy.nodes,
      this.heightOffsetMeters,
      this.verticalGrid,
    );
    const availableNodes = new Map(state.nodes);
    for (const [nodeKey, node] of discoveredNodes) {
      availableNodes.set(nodeKey, node);
    }
    state.nodes = availableNodes;
    state.nodesRef.current = availableNodes;
    state.manager.setHierarchy(availableNodes);

    const currentDepth = [...this.selectedNodeKeys]
      .map((nodeKey) => availableNodes.get(nodeKey)?.node.level ?? -1)
      .reduce((maximum, level) => Math.max(maximum, level), -1);
    const maximumPrefetchDepth = Math.min(
      this.getStreamingOptions().maxDepth,
      Math.max(1, currentDepth + 1),
    );
    const selector = new NodeSelector({
      ...this.getStreamingOptions(),
      maxDepth: maximumPrefetchDepth,
      predictivePrefetch: false,
    });
    selector.setRefinementFocus(this.refinementFocus);
    const candidates = selector.selectVisibleNodes(
      predictedView,
      availableNodes,
      {
        previousSelectedNodeKeys: new Set(this.selectedNodeKeys),
        isNodeCached: (nodeKey) => state.cache.has(nodeKey),
      },
    );
    const maxDecodedBytes = Math.min(
      MAX_PREFETCH_POINTS_PER_UPDATE * ESTIMATED_PREPARED_BYTES_PER_POINT,
      MAX_PREFETCH_POINT_RANGE_BYTES_PER_UPDATE,
      state.cache.getDiagnostics().cacheByteBudget,
    );
    const queue: string[] = [];
    let queuedPointCount = 0;
    let queuedRangeBytes = 0;
    for (const candidate of candidates) {
      const node = candidate.node;
      const pointCount = node.pointCount;
      const pointRangeBytes = node.pointDataLength;
      const estimatedDecodedBytes =
        pointCount * ESTIMATED_PREPARED_BYTES_PER_POINT;
      if (
        this.selectedNodeKeys.has(node.key) ||
        state.cache.has(node.key) ||
        pointCount <= 0 ||
        !Number.isSafeInteger(pointRangeBytes) ||
        pointRangeBytes <= 0 ||
        pointRangeBytes > MAX_PREFETCH_POINT_RANGE_BYTES_PER_UPDATE ||
        !isOffscreenFromCurrentView(
          view.viewFrustum,
          predictedView.viewFrustum,
          availableNodes.get(node.key)?.boundingSphere,
        ) ||
        estimatedDecodedBytes > maxDecodedBytes ||
        queuedPointCount + pointCount > MAX_PREFETCH_POINTS_PER_UPDATE ||
        queuedRangeBytes + pointRangeBytes >
          MAX_PREFETCH_POINT_RANGE_BYTES_PER_UPDATE
      ) {
        continue;
      }
      queue.push(node.key);
      queuedPointCount += pointCount;
      queuedRangeBytes += pointRangeBytes;
      if (queue.length >= MAX_PREFETCH_NODES_PER_UPDATE) break;
    }

    this.predictivePrefetchQueue = queue;
    return {
      generation,
      controller,
      state,
      queue,
    };
  }

  private async runPredictivePrefetch(
    plan: PredictivePrefetchPlan,
  ): Promise<void> {
    const { generation, controller, state, queue } = plan;
    while (
      queue.length > 0 &&
      this.isCurrentPrefetch(generation, state, controller)
    ) {
      const currentPrediction = this.motionEstimator.getPrediction(
        this.getMotionEstimatorTimestamp(),
      );
      if (currentPrediction.activity <= 0) break;
      const worker = state.context.getWorkerDiagnostics?.();
      if (
        worker &&
        (worker.workerCount <= 1 ||
          worker.activeCount >= worker.workerCount - 1)
      ) {
        break;
      }
      if (!state.manager.tryAcquirePrefetchSlot()) break;

      const nodeKey = queue.shift();
      if (!nodeKey) {
        state.manager.releasePrefetchSlot();
        break;
      }
      const activeTask = { state };
      this.activePredictivePrefetchTasks.add(activeTask);
      try {
        await state.cache.load(nodeKey, "prefetch");
        if (this.isCurrentPrefetch(generation, state, controller)) {
          this.predictivePrefetchCompletedNodeCount += 1;
        } else if (
          this.streamingState === state &&
          this.lifecycle === "ready"
        ) {
          this.predictivePrefetchCancelledNodeCount += 1;
        }
      } catch {
        if (
          (controller.signal.aborted ||
            !this.isCurrentPrefetch(generation, state, controller)) &&
          this.streamingState === state &&
          this.lifecycle === "ready"
        ) {
          this.predictivePrefetchCancelledNodeCount += 1;
        } else if (this.isCurrentPrefetch(generation, state, controller)) {
          this.predictivePrefetchFailedNodeCount += 1;
        }
      } finally {
        this.activePredictivePrefetchTasks.delete(activeTask);
        state.manager.releasePrefetchSlot();
      }
    }
    if (
      this.isCurrentPrefetch(generation, state, controller) &&
      queue.length > 0
    ) {
      this.predictivePrefetchCancelledNodeCount += queue.length;
      queue.length = 0;
    }
    if (this.predictivePrefetchQueue === queue) {
      this.predictivePrefetchQueue = [];
    }
    if (this.predictivePrefetchController === controller) {
      this.predictivePrefetchController = undefined;
    }
  }

  private isCurrentPrefetch(
    generation: number,
    state: StreamingState,
    controller: AbortController,
  ): boolean {
    return (
      !controller.signal.aborted &&
      generation === this.predictivePrefetchGeneration &&
      this.streamingState === state &&
      this.lifecycle === "ready"
    );
  }

  private supersedePredictivePrefetch(): void {
    this.predictivePrefetchGeneration += 1;
    if (this.predictivePrefetchQueue.length > 0) {
      this.predictivePrefetchCancelledNodeCount +=
        this.predictivePrefetchQueue.length;
      this.predictivePrefetchQueue = [];
    }
    const controller = this.predictivePrefetchController;
    this.predictivePrefetchController = undefined;
    controller?.abort(RANGE_CANCELLATION_REASON.superseded);
    this.streamingState?.cache.cancelPendingExcept(
      this.selectedNodeKeys,
      "superseded",
    );
  }

  private getPredictivePrefetchDiagnostics(
    cache = this.streamingState?.cache ?? this.initialCache,
  ): PredictivePrefetchDiagnostics {
    const cacheDiagnostics = cache.getDiagnostics();
    return {
      enabled: this.getStreamingOptions().predictivePrefetch === true,
      generation: this.predictivePrefetchGeneration,
      queuedNodeCount: this.predictivePrefetchQueue.length,
      activeNodeCount: [...this.activePredictivePrefetchTasks].filter(
        (task) => task.state === this.streamingState,
      ).length,
      completedNodeCount: this.predictivePrefetchCompletedNodeCount,
      failedNodeCount: this.predictivePrefetchFailedNodeCount,
      cancelledNodeCount: this.predictivePrefetchCancelledNodeCount,
      usefulCacheHitCount: cacheDiagnostics.prefetchUsefulHitCount,
      evictedUnusedNodeCount: cacheDiagnostics.prefetchEvictedUnusedCount,
      pointRangeRequestCount: this.predictivePrefetchPointRangeRequestCount,
      pointRangeBytesRequested: this.predictivePrefetchPointRangeBytesRequested,
      hierarchyQueryCount: this.predictivePrefetchHierarchyQueryCount,
      hierarchyPageVisitCount: this.predictivePrefetchHierarchyPageVisitCount,
      hierarchyPageRequestCount:
        this.predictivePrefetchHierarchyPageRequestCount,
      hierarchyPageCacheHitCount:
        this.predictivePrefetchHierarchyPageCacheHitCount,
      maxNodesPerUpdate: MAX_PREFETCH_NODES_PER_UPDATE,
      maxPointsPerUpdate: MAX_PREFETCH_POINTS_PER_UPDATE,
      maxPointRangeBytesPerUpdate: MAX_PREFETCH_POINT_RANGE_BYTES_PER_UPDATE,
      maxHierarchyPagesPerUpdate: MAX_PREFETCH_HIERARCHY_PAGES_PER_UPDATE,
    };
  }

  private resetPredictivePrefetchDiagnostics(): void {
    this.predictivePrefetchGeneration = 0;
    this.predictivePrefetchQueue = [];
    this.predictivePrefetchCompletedNodeCount = 0;
    this.predictivePrefetchFailedNodeCount = 0;
    this.predictivePrefetchCancelledNodeCount = 0;
    this.predictivePrefetchPointRangeRequestCount = 0;
    this.predictivePrefetchPointRangeBytesRequested = 0;
    this.predictivePrefetchHierarchyQueryCount = 0;
    this.predictivePrefetchHierarchyPageVisitCount = 0;
    this.predictivePrefetchHierarchyPageRequestCount = 0;
    this.predictivePrefetchHierarchyPageCacheHitCount = 0;
  }

  private applyProgress(
    progress: StreamingProgress<RenderablePointData>,
    onProgress: CopcStreamingProgressHandler<TPointData> | undefined,
    viewGeneration: number,
  ): void {
    this.selectedNodeKeys = new Set(progress.selectedNodeKeys);
    this.transition = {
      generation: viewGeneration,
      replacementGroups: progress.replacementGroups ?? [],
    };
    onProgress?.(progress as unknown as StreamingProgress<TPointData>);
  }

  private createEmptyCache(): NodePointCache<CachedPointData> {
    return createNodePointCache(
      async () => {
        throw new Error("COPC streaming controller is not loaded");
      },
      {
        maxEntries: MAX_CACHED_NODES,
        maxBytes: this.options.maxPointCacheBytes ?? DEFAULT_POINT_CACHE_BYTES,
      },
    );
  }

  private createCache(
    context: CopcSource,
    metadata: CopcMetadata,
    nodesRef: { current: StreamingHierarchy },
    performanceRecorder: StreamingPerformanceRecorder,
    loadGeneration: number,
  ): NodePointCache<CachedPointData> {
    const coordinatePlan = getCoordinateTransformPlan(metadata, {
      heightOffsetMeters: this.heightOffsetMeters,
      verticalGrid: this.verticalGrid,
    });
    return createNodePointCache(
      (nodeKey, signal, purpose) =>
        this.loadRenderableNodePoints(
          context,
          metadata,
          nodesRef,
          performanceRecorder,
          nodeKey,
          signal,
          loadGeneration,
          coordinatePlan,
          purpose,
        ),
      {
        maxEntries: MAX_CACHED_NODES,
        maxBytes: this.options.maxPointCacheBytes ?? DEFAULT_POINT_CACHE_BYTES,
      },
    );
  }

  private async loadRenderableNodePoints(
    context: CopcSource,
    metadata: CopcMetadata,
    nodesRef: { current: StreamingHierarchy },
    performanceRecorder: StreamingPerformanceRecorder,
    nodeKey: string,
    signal: AbortSignal,
    loadGeneration: number,
    coordinatePlan: CoordinateTransformPlan,
    purpose: NodePointLoadPurpose = "current",
  ): Promise<CachedPointData> {
    const streamingNode = nodesRef.current.get(nodeKey);
    if (!streamingNode) {
      throw new Error(`Unknown COPC hierarchy node: ${nodeKey}`);
    }
    if (purpose === "prefetch") {
      this.predictivePrefetchPointRangeRequestCount += 1;
      this.predictivePrefetchPointRangeBytesRequested +=
        streamingNode.node.pointDataLength;
    }

    const usesRustPointPath =
      this.options.decoder === undefined ||
      this.options.decoder === wasmCopcPointDecoder;
    if (usesRustPointPath && context.loadPreparedPointData) {
      const prepared = await context.loadPreparedPointData(
        streamingNode.node,
        this.pointFields,
        {
          signal,
          ...(purpose === "prefetch" ? { performanceObserver: null } : {}),
        },
      );
      if (signal.aborted) {
        throw createPointLoadAbortError(signal);
      }
      assertPreparedPointData(prepared);
      const alreadyAppliedOffset = context.preparedHeightOffsetMeters ?? 0;
      recordPreparedCoordinateOperations(prepared, {
        manualHeightOffsetMeters: alreadyAppliedOffset,
      });
      if (!coordinatePlan.verticalGrid) {
        const offsetPrepared = applyPreparedPointHeightOffset(
          prepared,
          coordinatePlan.manualHeightOffsetMeters - alreadyAppliedOffset,
        );
        return this.toCacheRepresentation(
          offsetPrepared,
          nodeKey,
          context,
          metadata,
          loadGeneration,
        );
      }
      if (coordinatePlan.verticalGrid.compatibility !== "validated") {
        throw new Error(
          coordinatePlan.verticalGrid.compatibilityMessage ??
            "Coordinate transform plan contains an unsupported vertical grid",
        );
      }

      const verticalGrid = this.verticalGrid;
      if (!verticalGrid) {
        throw new Error("Coordinate transform plan requires a verified vertical grid");
      }
      const gridTransformStartedAt =
        purpose === "prefetch" ? undefined : performanceNow();
      const gridCorrected = applyPreparedPointVerticalGrid(
        prepared,
        verticalGrid,
        {
          alreadyAppliedHeightOffsetMeters: alreadyAppliedOffset,
          targetHeightOffsetMeters: coordinatePlan.manualHeightOffsetMeters,
        },
      );
      if (gridTransformStartedAt !== undefined) {
        performanceRecorder.recordStage(
          "crsTransformDurationMs",
          performanceNow() - gridTransformStartedAt,
          true,
        );
      }
      return this.toCacheRepresentation(
        gridCorrected,
        nodeKey,
        context,
        metadata,
        loadGeneration,
      );
    }

    const points = await loadCopcPointBuffer(
      context,
      streamingNode.node,
      this.options.decoder,
      this.pointFields,
      {
        signal,
        ...(purpose === "prefetch" ? { performanceObserver: null } : {}),
      },
    );
    if (signal.aborted) {
      throw createPointLoadAbortError(signal);
    }
    const transformStartedAt = performanceNow();
    const transformed = transformPointBufferToPreparedPointData(
      metadata,
      points,
      this.heightOffsetMeters,
      this.verticalGrid,
    );
    assertPreparedPointData(transformed);
    if (purpose !== "prefetch") {
      performanceRecorder.recordStage(
        "crsTransformDurationMs",
        performanceNow() - transformStartedAt,
        true,
      );
    }
    return this.toCacheRepresentation(
      transformed,
      nodeKey,
      context,
      metadata,
      loadGeneration,
    );
  }

  private toCacheRepresentation(
    prepared: PreparedPointData,
    nodeKey: string,
    context: CopcSource,
    metadata: CopcMetadata,
    loadGeneration: number,
  ): CachedPointData {
    if (this.cacheLayout === "A") return prepared;

    const provenance: CompactEPointProvenance = {
      sourceIdentity: context.source,
      ...(metadata.wkt ? { sourceCrsWkt: metadata.wkt } : {}),
      transformGeneration: loadGeneration,
      heightOffsetMeters: this.heightOffsetMeters,
      verticalDatum: this.verticalGrid
        ? {
            status: "validated-grid-applied",
            gridId: this.verticalGrid.gridId,
            sha256: this.verticalGrid.sha256,
            sourceVerticalCrs: this.verticalGrid.sourceVerticalCrs,
            targetVerticalCrs: this.verticalGrid.targetVerticalCrs,
            valueUnit: this.verticalGrid.valueUnit,
          }
        : { status: "no-validated-grid-correction" },
    };
    return createCompactEPointCacheNode(prepared, {
      nodeKey,
      provenance,
      retain: this.compactECoordinateRetention,
    });
  }

  private createPerformanceObserver(
    performanceRecorder: StreamingPerformanceRecorder,
  ): CopcPerformanceObserver {
    return (event) => {
      const stage =
        event.stage === "rangeFetch"
          ? "rangeFetchDurationMs"
          : event.stage === "pointPreparation"
            ? "pointPreparationDurationMs"
            : "decodeDurationMs";
      performanceRecorder.recordStage(
        stage,
        event.durationMs,
        event.blocksMainThread ?? event.stage === "decode",
        event.bytes,
      );
    };
  }

  private createPerformanceRecorder(): StreamingPerformanceRecorder {
    const recorder = new StreamingPerformanceRecorder();
    recorder.setConfiguredPointBudget(this.getMaxRenderedPoints());
    return recorder;
  }

  private getStreamingOptions(): StreamingSelectionOptions {
    return {
      ...DEFAULT_STREAMING_OPTIONS,
      ...this.options.streaming,
      ...(this.options.maxRenderedPoints === undefined
        ? {}
        : { maxRenderedPoints: this.options.maxRenderedPoints }),
    };
  }

  private getMotionEstimatorTimestamp(now = performanceNow()): number {
    const anchor = this.motionTimestampAnchorMilliseconds;
    const anchorPerformanceTime =
      this.motionTimestampAnchorPerformanceMilliseconds;
    if (anchor === undefined || anchorPerformanceTime === undefined) {
      return now;
    }
    return anchor + Math.max(0, now - anchorPerformanceTime);
  }

  private getPerformanceSnapshot(): CopcStreamingPerformanceSnapshot {
    const snapshot = this.performanceRecorder.getSnapshot();
    return {
      updateDurationMs: snapshot.updateDurationMs,
      nodeSelectionMs: snapshot.nodeSelectionMs,
      selectedNodeCount: snapshot.selectedNodeCount,
      estimatedSelectedPointCount: snapshot.estimatedSelectedPointCount,
      configuredPointBudget: snapshot.configuredPointBudget,
      candidateSelectedPointCount: snapshot.candidateSelectedPointCount,
      activeRenderedPointCount: snapshot.activeRenderedPointCount,
      deferredNodeCount: snapshot.deferredNodeCount,
      deferredPointCount: snapshot.deferredPointCount,
      budgetDeferDropCount: snapshot.budgetDeferDropCount,
      budgetUtilizationPercent: snapshot.budgetUtilizationPercent,
      candidatesBeforeCulling: snapshot.candidatesBeforeCulling,
      frustumCulledCount: snapshot.frustumCulledCount,
      maxScreenSpaceError: snapshot.maxScreenSpaceError,
      refinedNodeCount: snapshot.refinedNodeCount,
      keptNodeCount: snapshot.keptNodeCount,
      frontierNodeCount: snapshot.frontierNodeCount,
      frontierPointCount: snapshot.frontierPointCount,
      acceptedRefinementCount: snapshot.acceptedRefinementCount,
      refinementRejectedByNodeBudgetCount:
        snapshot.refinementRejectedByNodeBudgetCount,
      refinementRejectedByPointBudgetCount:
        snapshot.refinementRejectedByPointBudgetCount,
      refinementDeferredByIncompleteHierarchyCount:
        snapshot.refinementDeferredByIncompleteHierarchyCount,
      minimumFrontierExceedsNodeBudget:
        snapshot.minimumFrontierExceedsNodeBudget,
      minimumFrontierExceedsPointBudget:
        snapshot.minimumFrontierExceedsPointBudget,
      refinementAlgorithm:
        this.getStreamingOptions().refinementAlgorithm ??
        DEFAULT_REFINEMENT_ALGORITHM,
      refinementFocusEnabled: this.refinementFocus !== undefined,
      motionLookaheadEnabled:
        this.getStreamingOptions().motionLookahead !== false,
      motionSampledMovementCount: this.motionSampledMovementCount,
      motionLive: {
        ...this.motionEstimator.getDiagnostics(
          this.getMotionEstimatorTimestamp(),
        ),
        acceptedMovementSampleCount: this.motionSampledMovementCount,
      },
      ...(snapshot.maxConcurrentNodeLoads === undefined
        ? {}
        : {
            maxConcurrentNodeLoads: snapshot.maxConcurrentNodeLoads,
            queuedNodeCount: snapshot.queuedNodeCount,
            activeNodeCount: snapshot.activeNodeCount,
            queuedHighPriorityNodeCount: snapshot.queuedHighPriorityNodeCount,
            activeHighPriorityNodeCount: snapshot.activeHighPriorityNodeCount,
            completedNodeCount: snapshot.completedNodeCount,
            cancelledNodeCount: snapshot.cancelledNodeCount,
            peakActiveNodeCount: snapshot.peakActiveNodeCount,
            ...(snapshot.completedSchedulingPriorityMin === undefined
              ? {}
              : {
                  completedSchedulingPriorityMin:
                    snapshot.completedSchedulingPriorityMin,
                }),
            ...(snapshot.completedSchedulingPriorityMax === undefined
              ? {}
              : {
                  completedSchedulingPriorityMax:
                    snapshot.completedSchedulingPriorityMax,
                }),
            ...(snapshot.pendingSchedulingPriorityMin === undefined
              ? {}
              : {
                  pendingSchedulingPriorityMin:
                    snapshot.pendingSchedulingPriorityMin,
                }),
            ...(snapshot.pendingSchedulingPriorityMax === undefined
              ? {}
              : {
                  pendingSchedulingPriorityMax:
                    snapshot.pendingSchedulingPriorityMax,
                }),
          }),
      ...(snapshot.firstHighPriorityNodeStartLatencyMs === undefined
        ? {}
        : {
            firstHighPriorityNodeStartLatencyMs:
              snapshot.firstHighPriorityNodeStartLatencyMs,
          }),
      ...(snapshot.firstHighPriorityNodeReadyLatencyMs === undefined
        ? {}
        : {
            firstHighPriorityNodeReadyLatencyMs:
              snapshot.firstHighPriorityNodeReadyLatencyMs,
          }),
      loadedNodeCount: snapshot.loadedNodeCount,
      loadedPointCount: snapshot.loadedPointCount,
      rangeFetchDurationMs: snapshot.rangeFetchDurationMs,
      rangeFetchBytes: snapshot.rangeFetchBytes,
      decodeDurationMs: snapshot.decodeDurationMs,
      pointPreparationDurationMs: snapshot.pointPreparationDurationMs,
      crsTransformDurationMs: snapshot.crsTransformDurationMs,
      longestMainThreadBlockingSectionMs:
        snapshot.longestMainThreadBlockingSectionMs,
      ...(snapshot.screenSpaceErrorMin === undefined
        ? {}
        : { screenSpaceErrorMin: snapshot.screenSpaceErrorMin }),
      ...(snapshot.screenSpaceErrorMax === undefined
        ? {}
        : { screenSpaceErrorMax: snapshot.screenSpaceErrorMax }),
      ...(snapshot.effectiveScreenSpaceErrorMin === undefined
        ? {}
        : {
            effectiveScreenSpaceErrorMin: snapshot.effectiveScreenSpaceErrorMin,
          }),
      ...(snapshot.effectiveScreenSpaceErrorMax === undefined
        ? {}
        : {
            effectiveScreenSpaceErrorMax: snapshot.effectiveScreenSpaceErrorMax,
          }),
      ...(snapshot.visibleLevelRange === undefined
        ? {}
        : { visibleLevelRange: snapshot.visibleLevelRange }),
      ...(snapshot.cameraDirection === undefined
        ? {}
        : { cameraDirection: snapshot.cameraDirection }),
      ...(snapshot.centerWeightMin === undefined
        ? {}
        : { centerWeightMin: snapshot.centerWeightMin }),
      ...(snapshot.centerWeightMax === undefined
        ? {}
        : { centerWeightMax: snapshot.centerWeightMax }),
      ...(snapshot.refinementCenterWeightMin === undefined
        ? {}
        : { refinementCenterWeightMin: snapshot.refinementCenterWeightMin }),
      ...(snapshot.refinementCenterWeightMax === undefined
        ? {}
        : { refinementCenterWeightMax: snapshot.refinementCenterWeightMax }),
      ...(snapshot.schedulingCenterWeightMin === undefined
        ? {}
        : { schedulingCenterWeightMin: snapshot.schedulingCenterWeightMin }),
      ...(snapshot.schedulingCenterWeightMax === undefined
        ? {}
        : { schedulingCenterWeightMax: snapshot.schedulingCenterWeightMax }),
      ...(snapshot.detailBiasMin === undefined
        ? {}
        : { detailBiasMin: snapshot.detailBiasMin }),
      ...(snapshot.detailBiasMax === undefined
        ? {}
        : { detailBiasMax: snapshot.detailBiasMax }),
      ...(snapshot.candidatesWithNonZeroInfluenceCount === undefined
        ? {}
        : {
            candidatesWithNonZeroInfluenceCount:
              snapshot.candidatesWithNonZeroInfluenceCount,
          }),
      ...(snapshot.acceptedGazeInfluencedRefinementCount === undefined
        ? {}
        : {
            acceptedGazeInfluencedRefinementCount:
              snapshot.acceptedGazeInfluencedRefinementCount,
          }),
      ...(snapshot.motionHorizontalAngularVelocityDegreesPerSecond === undefined
        ? {}
        : {
            motionHorizontalAngularVelocityDegreesPerSecond:
              snapshot.motionHorizontalAngularVelocityDegreesPerSecond,
          }),
      ...(snapshot.motionVerticalAngularVelocityDegreesPerSecond === undefined
        ? {}
        : {
            motionVerticalAngularVelocityDegreesPerSecond:
              snapshot.motionVerticalAngularVelocityDegreesPerSecond,
          }),
      ...(snapshot.motionHorizonMilliseconds === undefined
        ? {}
        : { motionHorizonMilliseconds: snapshot.motionHorizonMilliseconds }),
      ...(snapshot.motionPredictedHorizontalDisplacementDegrees === undefined
        ? {}
        : {
            motionPredictedHorizontalDisplacementDegrees:
              snapshot.motionPredictedHorizontalDisplacementDegrees,
          }),
      ...(snapshot.motionPredictedVerticalDisplacementDegrees === undefined
        ? {}
        : {
            motionPredictedVerticalDisplacementDegrees:
              snapshot.motionPredictedVerticalDisplacementDegrees,
          }),
      ...(snapshot.motionCandidateCount === undefined
        ? {}
        : { motionCandidateCount: snapshot.motionCandidateCount }),
      ...(snapshot.motionWeightMin === undefined
        ? {}
        : { motionWeightMin: snapshot.motionWeightMin }),
      ...(snapshot.motionWeightMax === undefined
        ? {}
        : { motionWeightMax: snapshot.motionWeightMax }),
      ...(snapshot.motionInfluencedRefinementCount === undefined
        ? {}
        : {
            motionInfluencedRefinementCount:
              snapshot.motionInfluencedRefinementCount,
          }),
      ...(snapshot.focusCandidateCount === undefined
        ? {}
        : { focusCandidateCount: snapshot.focusCandidateCount }),
      ...(snapshot.focusWeightMin === undefined
        ? {}
        : { focusWeightMin: snapshot.focusWeightMin }),
      ...(snapshot.focusWeightMax === undefined
        ? {}
        : { focusWeightMax: snapshot.focusWeightMax }),
      ...(snapshot.focusInfluencedRefinementCount === undefined
        ? {}
        : {
            focusInfluencedRefinementCount:
              snapshot.focusInfluencedRefinementCount,
          }),
      ...(snapshot.influenceClampCount === undefined
        ? {}
        : { influenceClampCount: snapshot.influenceClampCount }),
      ...(snapshot.acceptedRefinementPriorityMin === undefined
        ? {}
        : {
            acceptedRefinementPriorityMin:
              snapshot.acceptedRefinementPriorityMin,
          }),
      ...(snapshot.acceptedRefinementPriorityMax === undefined
        ? {}
        : {
            acceptedRefinementPriorityMax:
              snapshot.acceptedRefinementPriorityMax,
          }),
      ...(snapshot.refinementPriorityMin === undefined
        ? {}
        : { refinementPriorityMin: snapshot.refinementPriorityMin }),
      ...(snapshot.refinementPriorityMax === undefined
        ? {}
        : { refinementPriorityMax: snapshot.refinementPriorityMax }),
      ...(snapshot.schedulingPriorityMin === undefined
        ? {}
        : { schedulingPriorityMin: snapshot.schedulingPriorityMin }),
      ...(snapshot.schedulingPriorityMax === undefined
        ? {}
        : { schedulingPriorityMax: snapshot.schedulingPriorityMax }),
      ...(snapshot.candidatesWithCenterBoostCount === undefined
        ? {}
        : {
            candidatesWithCenterBoostCount:
              snapshot.candidatesWithCenterBoostCount,
          }),
      ...(snapshot.hysteresisHoldCount === undefined
        ? {}
        : { hysteresisHoldCount: snapshot.hysteresisHoldCount }),
      ...(snapshot.refineDecisionCount === undefined
        ? {}
        : { refineDecisionCount: snapshot.refineDecisionCount }),
      ...(snapshot.collapseDecisionCount === undefined
        ? {}
        : { collapseDecisionCount: snapshot.collapseDecisionCount }),
    };
  }

  private getMaxRenderedPoints(): number {
    return (
      this.options.maxRenderedPoints ??
      this.options.streaming?.maxRenderedPoints ??
      DEFAULT_STREAMING_OPTIONS.maxRenderedPoints ??
      DEFAULT_MAX_RENDERED_POINTS
    );
  }

  private isCurrentLoad(loadGeneration: number): boolean {
    return (
      loadGeneration === this.loadGeneration && this.lifecycle !== "destroyed"
    );
  }

  private isCurrentView(
    viewGeneration: number,
    state: StreamingState,
  ): boolean {
    return (
      viewGeneration === this.viewGeneration &&
      this.streamingState === state &&
      this.lifecycle === "ready"
    );
  }

  private debug(message: string): void {
    if (this.options.debug) {
      console.debug(`[CopcStreamingController] ${message}`);
    }
  }
}

/**
 * Public streaming controller bound to the production A cache contract.
 * Experimental cache layouts are created only through internal factories.
 */
export class CopcStreamingCore
  extends CopcStreamingCoreImplementation<PreparedPointData> {}

/** Descriptive controller alias retained for callers that prefer the API name. */
export { CopcStreamingCore as CopcStreamingController };

/**
 * Create the renderer-layer core with its selected retained coordinate layout.
 * Normal Cesium and Three layers use E; A remains available as an explicit
 * compatibility path. The function is intentionally omitted from package
 * entry points so the public `CopcStreamingCore` contract remains A-shaped.
 */
export function createLayerStreamingCore(
  options: CopcStreamingControllerOptions,
  layout: "A" | "E" = "E",
  retain: CompactECoordinateRetention = {},
): CopcStreamingCoreImplementation<RenderablePointData> {
  const internalOptions: InternalStreamingOptions = {
    ...options,
    [INTERNAL_CACHE_LAYOUT]: { layout, retain },
  };
  return new CopcStreamingCoreImplementation<RenderablePointData>(
    internalOptions,
  );
}

/** Read a layer core's renderer-ready cache value without widening public A APIs. */
export function getCachedRenderablePointDataForAdapter(
  core: object,
  nodeKey: string,
): RenderablePointData | undefined {
  return cachedRenderablePointAccessors.get(core)?.(nodeKey);
}

/** Internal test seam retained for focused E-specific lifecycle coverage. */
export function createExperimentalCompactEStreamingCore(
  options: CopcStreamingControllerOptions,
  retain: CompactECoordinateRetention = {},
): CopcStreamingCoreImplementation<RenderablePointData> {
  return createLayerStreamingCore(options, "E", retain);
}
