import {
  createCopcContext,
} from '../copc/context/createCopcContext';
import type { CopcSource, CopcWorkerDiagnostics } from '../copc/backend/types';
import {
  getCopcBackendName,
  type CopcBackendSelection,
  type CopcBackendName,
} from '../copc/backend/selection';
import type { CopcPointDecoder } from '../copc/points/types';
import { HierarchyLoader } from '../copc/hierarchy/HierarchyLoader';
import type {
  CopcHierarchyBounds,
  CopcHierarchyDiagnostics,
  CopcProjectBounds,
  CopcHierarchyQuery,
} from '../copc/hierarchy/types';
import { CopcHierarchyLoadError, CopcLoadError } from '../copc/errors';
import { loadCopcMetadata } from '../copc/metadata/loadMetadata';
import { loadCopcPointBuffer } from '../copc/points/loadPointData';
import { wasmCopcPointDecoder } from '../wasm/copcDecoder';
import { createCopcPointFieldSelection, type CopcPointFieldSelection } from '../copc/points/fieldSelection';
import {
  applyPreparedPointHeightOffset,
  createPointTransformer,
  createProjectPointTransformer,
  transformPointBufferToPreparedPointData,
} from '../coordinates/transform/createPointTransformer';
import { resolveHeightOffsetMeters } from '../coordinates/transform/heightOffset';
import type {
  CopcMetadata,
  GeographicPointBuffer,
  PreparedPointData,
} from '../copc/types/copc';
import {
  assertPreparedPointData,
  preparedPointDataToGeographicBuffer,
} from '../point/preparedPoint';
import type { CopcPerformanceObserver } from '../copc/performance';
import { performanceNow } from '../copc/performance';
import { buildStreamingHierarchy } from './buildStreamingHierarchy';
import {
  createNodePointCache,
  type NodePointCache,
  type NodePointCacheDiagnostics,
} from './createNodePointCache';
import { DEFAULT_MAX_RENDERED_POINTS } from './NodeSelector';
import { StreamingManager } from './StreamingManager';
import {
  AdaptiveViewDistancePolicy,
  createStreamingViewBounds,
} from './view';
import type { AdaptiveViewDistanceDiagnostics } from './view';
import type {
  StreamingHierarchy,
  StreamingHierarchyNode,
  StreamingProgress,
  StreamingReplacementGroup,
  StreamingSelectionOptions,
  StreamingUpdateResult,
  StreamingView,
  StreamingWorkProgress,
} from './types';
import {
  StreamingPerformanceRecorder,
  type StreamingPerformanceSnapshot,
} from './performance';
import { DEFAULT_MAX_CONCURRENT_NODE_LOADS } from './scheduler';
import {
  CameraMotionLookaheadEstimator,
  type CameraMotionObservation,
} from './motionLookahead';
import {
  RANGE_CANCELLATION_REASON,
  RangeRequestDiagnosticsRecorder,
} from '../copc/range/requestDiagnostics';
import type { RangeRequestDiagnostics } from '../copc/range/requestDiagnostics';
import type { RangeValidationPolicy } from '../copc/range/types';
import type { CopcInputSource } from '../copc/range/types';
import { getCopcSourceIdentity } from '../copc/getter/createCopcGetter';
import {
  DEFAULT_REFINEMENT_ALGORITHM,
  normalizeRefinementFocus,
  resolveRefinementAlgorithm,
  type RefinementFocus,
} from './refinementStrategies';

/** Lifecycle states that do not depend on an attached rendering engine. */
export type CopcStreamingLifecycleState =
  /** Constructed and not loading a source. */
  | 'idle'
  /** Opening source, reading metadata, or loading the root hierarchy. */
  | 'loading'
  /** Metadata and root hierarchy are ready for view-driven point loading. */
  | 'ready'
  /** Permanently destroyed. */
  | 'destroyed';

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
  /** Overrides for the shared selection and streaming limits. */
  streaming?: Partial<StreamingSelectionOptions>;
  /** Convenience override for the shared rendered-point workload budget. */
  maxRenderedPoints?: number;
  /** Stable `copc-js` by default, Rust or a test backend by explicit choice. */
  backend?: CopcBackendSelection;
  /** Manual additive correction in metres applied to ellipsoidal point height. Defaults to 0. */
  heightOffsetMeters?: number;
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
export type CopcStreamingProgressHandler = (progress: StreamingProgress) => void;
export type CopcStreamingWorkProgressHandler = (progress: StreamingWorkProgress) => void;

/**
 * Core-owned streaming, range-fetch, decode, and point-preparation measurements.
 *
 * Durations are in milliseconds and `rangeFetchBytes` counts byte-range
 * response bodies. Renderer-side preparation and GPU frame time are not
 * included; renderer adapters expose their own measurements separately.
 */
export type CopcStreamingPerformanceSnapshot = Pick<
  StreamingPerformanceSnapshot,
  | 'updateDurationMs'
  | 'nodeSelectionMs'
  | 'selectedNodeCount'
  | 'estimatedSelectedPointCount'
  | 'configuredPointBudget'
  | 'candidateSelectedPointCount'
  | 'activeRenderedPointCount'
  | 'deferredNodeCount'
  | 'deferredPointCount'
  | 'budgetDeferDropCount'
  | 'budgetUtilizationPercent'
  | 'candidatesBeforeCulling'
  | 'frustumCulledCount'
  | 'maxScreenSpaceError'
  | 'screenSpaceErrorMin'
  | 'screenSpaceErrorMax'
  | 'effectiveScreenSpaceErrorMin'
  | 'effectiveScreenSpaceErrorMax'
  | 'refinedNodeCount'
  | 'keptNodeCount'
  | 'frontierNodeCount'
  | 'frontierPointCount'
  | 'acceptedRefinementCount'
  | 'refinementRejectedByNodeBudgetCount'
  | 'refinementRejectedByPointBudgetCount'
  | 'refinementDeferredByIncompleteHierarchyCount'
  | 'minimumFrontierExceedsNodeBudget'
  | 'minimumFrontierExceedsPointBudget'
  | 'maxConcurrentNodeLoads'
  | 'queuedNodeCount'
  | 'activeNodeCount'
  | 'queuedHighPriorityNodeCount'
  | 'activeHighPriorityNodeCount'
  | 'completedNodeCount'
  | 'cancelledNodeCount'
  | 'peakActiveNodeCount'
  | 'completedSchedulingPriorityMin'
  | 'completedSchedulingPriorityMax'
  | 'pendingSchedulingPriorityMin'
  | 'pendingSchedulingPriorityMax'
  | 'firstHighPriorityNodeStartLatencyMs'
  | 'firstHighPriorityNodeReadyLatencyMs'
  | 'centerWeightMin'
  | 'centerWeightMax'
  | 'refinementCenterWeightMin'
  | 'refinementCenterWeightMax'
  | 'schedulingCenterWeightMin'
  | 'schedulingCenterWeightMax'
  | 'detailBiasMin'
  | 'detailBiasMax'
  | 'candidatesWithNonZeroInfluenceCount'
  | 'acceptedGazeInfluencedRefinementCount'
  | 'focusCandidateCount'
  | 'focusWeightMin'
  | 'focusWeightMax'
  | 'focusInfluencedRefinementCount'
  | 'motionLookaheadEnabled'
  | 'motionHorizontalAngularVelocityDegreesPerSecond'
  | 'motionVerticalAngularVelocityDegreesPerSecond'
  | 'motionHorizonMilliseconds'
  | 'motionPredictedHorizontalDisplacementDegrees'
  | 'motionPredictedVerticalDisplacementDegrees'
  | 'motionCandidateCount'
  | 'motionWeightMin'
  | 'motionWeightMax'
  | 'motionInfluencedRefinementCount'
  | 'refinementAlgorithm'
  | 'refinementFocusEnabled'
  | 'influenceClampCount'
  | 'acceptedRefinementPriorityMin'
  | 'acceptedRefinementPriorityMax'
  | 'refinementPriorityMin'
  | 'refinementPriorityMax'
  | 'schedulingPriorityMin'
  | 'schedulingPriorityMax'
  | 'candidatesWithCenterBoostCount'
  | 'hysteresisHoldCount'
  | 'refineDecisionCount'
  | 'collapseDecisionCount'
  | 'visibleLevelRange'
  | 'cameraDirection'
  | 'loadedNodeCount'
  | 'loadedPointCount'
  | 'rangeFetchDurationMs'
  | 'rangeFetchBytes'
  | 'decodeDurationMs'
  | 'pointPreparationDurationMs'
  | 'crsTransformDurationMs'
  | 'longestMainThreadBlockingSectionMs'
>;

/** Detached diagnostics for one shared streaming core. */
export type CopcStreamingSnapshot = {
  /** Current core lifecycle state. */
  lifecycle: CopcStreamingLifecycleState;
  /** Open resource identity or configured source URL before opening. */
  source: string;
  /** Built-in backend identifier or `custom`. */
  backend: CopcBackendName | 'custom';
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
};

type StreamingState = {
  context: CopcSource;
  metadata: CopcMetadata;
  minimumDatasetHeightMeters?: number;
  hierarchyLoader: HierarchyLoader;
  nodes: StreamingHierarchy;
  nodesRef: { current: StreamingHierarchy };
  cache: NodePointCache<PreparedPointData>;
  manager: StreamingManager;
};

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

function createTransitionState(): CopcStreamingTransitionState {
  return {
    generation: 0,
    replacementGroups: [],
  };
}

function createPointLoadAbortError(signal: AbortSignal): Error {
  const error = new Error('Point-node load was cancelled', { cause: signal.reason });
  error.name = 'AbortError';
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
): CopcProjectBounds {
  const toProject = createProjectPointTransformer(metadata, heightOffsetMeters);
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
    toProject({ longitude, latitude, height }));

  return corners.reduce<CopcProjectBounds>((bounds, point) => ({
    coordinateSystem: 'copc-source',
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    minZ: Math.min(bounds.minZ, point.z),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
    maxZ: Math.max(bounds.maxZ, point.z),
  }), {
    coordinateSystem: 'copc-source',
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  });
}

function getMinimumDatasetHeightMeters(
  metadata: CopcMetadata,
  heightOffsetMeters: number,
): number | undefined {
  try {
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
export class CopcStreamingCore {
  private readonly options: CopcStreamingControllerOptions;
  private readonly heightOffsetMeters: number;
  private performanceRecorder: StreamingPerformanceRecorder;
  private readonly rangeRequestDiagnostics = new RangeRequestDiagnosticsRecorder();
  private readonly initialCache: NodePointCache<PreparedPointData>;
  private readonly pointFields: CopcPointFieldSelection;
  private streamingState?: StreamingState;
  private loadGeneration = 0;
  private viewGeneration = 0;
  private streamingUpdateCount = 0;
  private selectedNodeKeys = new Set<string>();
  private currentView?: StreamingView;
  private readonly adaptiveViewDistancePolicy = new AdaptiveViewDistancePolicy();
  private readonly motionEstimator: CameraMotionLookaheadEstimator;
  private transition = createTransitionState();
  private lifecycle: CopcStreamingLifecycleState = 'idle';
  private lifecycleAbortController?: AbortController;
  private refinementFocus?: RefinementFocus;

  constructor(options: CopcStreamingControllerOptions) {
    this.heightOffsetMeters = resolveHeightOffsetMeters(options.heightOffsetMeters);
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
      'position',
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
    if (this.lifecycle === 'destroyed') {
      throw new Error('CopcStreamingController has been destroyed');
    }
    if (this.streamingState) {
      throw new Error('COPC streaming controller is already loaded; call reload() to load it again');
    }
    if (this.lifecycle === 'loading') {
      throw new Error('COPC streaming controller is already loading');
    }

    this.lifecycle = 'loading';
    const loadGeneration = ++this.loadGeneration;
    const lifecycleAbortController = new AbortController();
    this.lifecycleAbortController = lifecycleAbortController;
    const performanceRecorder = this.performanceRecorder;
    let context: CopcSource | undefined;

    try {
      const sourceOpenStartedAt = performanceNow();
      context = await createCopcContext(this.options.url, this.options.backend, {
        signal: lifecycleAbortController.signal,
        rangeRequestDiagnostics: this.rangeRequestDiagnostics,
        rangeValidation: this.options.rangeValidation,
        maxRangeBytes: this.options.maxRangeBytes,
        maxConcurrentRangeRequests: this.options.maxConcurrentRangeRequests,
        heightOffsetMeters: this.heightOffsetMeters,
      });
      const sourceOpenDurationMs = Math.max(0, performanceNow() - sourceOpenStartedAt);
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
      );
      const nodesRef = { current: nodes };
      const cache = this.createCache(
        context,
        metadata,
        nodesRef,
        performanceRecorder,
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
      );
      manager.setRefinementFocus(this.refinementFocus);
      manager.setMotionPrediction(this.motionEstimator.getPrediction(performanceNow()));

      this.streamingState = {
        context,
        metadata,
        minimumDatasetHeightMeters: getMinimumDatasetHeightMeters(
          metadata,
          this.heightOffsetMeters,
        ),
        hierarchyLoader,
        nodes,
        nodesRef,
        cache,
        manager,
      };
      this.lifecycle = 'ready';
      this.debug('COPC metadata and hierarchy loaded');
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
      this.lifecycle = 'idle';
      throw error;
    }
  }

  /**
   * Update selection and point streaming for a renderer-neutral view.
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
    onProgress?: CopcStreamingProgressHandler,
    onWorkProgress?: CopcStreamingWorkProgressHandler,
  ): Promise<StreamingUpdateResult | undefined> {
    if (this.lifecycle === 'destroyed') {
      throw new Error('CopcStreamingController has been destroyed');
    }
    const streamingState = this.streamingState;
    if (!streamingState || this.lifecycle !== 'ready') {
      throw new Error('COPC streaming controller is not loaded');
    }
    const adaptiveView = this.adaptiveViewDistancePolicy.apply(
      view,
      this.getStreamingOptions().maxRenderDistanceMeters,
      streamingState.minimumDatasetHeightMeters,
    );

    const viewGeneration = ++this.viewGeneration;
    // Invalidate queued point work while the generation's hierarchy query is
    // still in flight. The manager also invalidates at update start, matching
    // the established stale-result semantics.
    streamingState.manager.invalidate('superseded', adaptiveView);
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
    );
    streamingState.nodes = availableNodes;
    streamingState.nodesRef.current = availableNodes;
    streamingState.manager.setHierarchy(availableNodes);
    streamingState.manager.setMotionPrediction(
      this.motionEstimator.getPrediction(performanceNow()),
    );

    let progressApplied = false;
    const applyProgress = (progress: StreamingProgress): void => {
      if (!this.isCurrentView(viewGeneration, streamingState)) {
        return;
      }

      progressApplied = true;
      this.applyProgress(progress, onProgress, viewGeneration);
    };
    const update = await streamingState.manager.update(adaptiveView, applyProgress, {
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
    });
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
    return update;
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
      throw new Error('COPC streaming controller is not loaded');
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
      ),
      maxLevel: streamingOptions.maxDepth,
    };
  }

  /** Remove source, hierarchy, cache, and selected-view state while keeping the core reusable. */
  unload(): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }

    this.loadGeneration += 1;
    this.viewGeneration += 1;
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
    this.lifecycle = 'idle';
    this.debug('COPC streaming controller unloaded');
  }

  /** Unload current state and load the configured source again. */
  async reload(): Promise<void> {
    this.unload();
    await this.load();
  }

  /** Permanently release all source-owned state; the core cannot be loaded again. */
  destroy(): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }

    this.unload();
    this.lifecycle = 'destroyed';
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
      pointCache: state?.cache.getDiagnostics() ?? this.initialCache.getDiagnostics(),
      rangeRequests: this.rangeRequestDiagnostics.getSnapshot(),
      ...(worker ? { worker } : {}),
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
    return this.streamingState?.cache.getDiagnostics()
      ?? this.initialCache.getDiagnostics();
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
   * Adapters call this before equivalent-view early returns so a stationary
   * camera can complete bounded decay without requiring another view change.
   */
  observeCameraMotion(
    view: StreamingView,
    timestampMilliseconds = performanceNow(),
  ): CameraMotionObservation {
    const observation = this.motionEstimator.observe(view.viewFrustum, timestampMilliseconds);
    this.streamingState?.manager.setMotionPrediction(observation.prediction);
    return observation;
  }

  /** Clear camera history and remove any motion priority retained by the selector. */
  resetCameraMotion(): void {
    this.motionEstimator.reset();
    this.streamingState?.manager.setMotionPrediction(
      this.motionEstimator.getPrediction(performanceNow()),
    );
  }

  /** Return the current hierarchy node for an adapter-side pick or transition. */
  getHierarchyNode(nodeKey: string): StreamingHierarchyNode | undefined {
    return this.streamingState?.nodes.get(nodeKey);
  }

  /** Invalidate an in-flight view and cancel reads outside an optional next view. */
  invalidateView(view?: StreamingView): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }

    this.viewGeneration += 1;
    const adaptiveView = view
      ? this.adaptiveViewDistancePolicy.preview(
        view,
        this.getStreamingOptions().maxRenderDistanceMeters,
      )
      : undefined;
    this.streamingState?.manager.invalidate('superseded', adaptiveView);
  }

  /** Return a detached copy of the current replacement intent. */
  getTransitionState(): CopcStreamingTransitionState {
    return cloneTransitionState(this.transition);
  }

  /** Return a resolved prepared result retained by the current decoded cache. */
  getCachedPreparedPointData(nodeKey: string): PreparedPointData | undefined {
    return this.streamingState?.cache.get(nodeKey);
  }

  /** Return the legacy flat view over a prepared result without copying arrays. */
  getCachedPointBuffer(nodeKey: string): GeographicPointBuffer | undefined {
    const prepared = this.getCachedPreparedPointData(nodeKey);
    return prepared ? preparedPointDataToGeographicBuffer(prepared) : undefined;
  }

  private applyProgress(
    progress: StreamingProgress,
    onProgress: CopcStreamingProgressHandler | undefined,
    viewGeneration: number,
  ): void {
    this.selectedNodeKeys = new Set(progress.selectedNodeKeys);
    this.transition = {
      generation: viewGeneration,
      replacementGroups: progress.replacementGroups ?? [],
    };
    onProgress?.(progress);
  }

  private createEmptyCache(): NodePointCache<PreparedPointData> {
    return createNodePointCache(
      async () => {
        throw new Error('COPC streaming controller is not loaded');
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
  ): NodePointCache<PreparedPointData> {
    return createNodePointCache(
      (nodeKey, signal) => this.loadRenderableNodePoints(
        context,
        metadata,
        nodesRef,
        performanceRecorder,
        nodeKey,
        signal,
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
  ): Promise<PreparedPointData> {
    const streamingNode = nodesRef.current.get(nodeKey);
    if (!streamingNode) {
      throw new Error(`Unknown COPC hierarchy node: ${nodeKey}`);
    }

    const usesRustPointPath = this.options.decoder === undefined
      || this.options.decoder === wasmCopcPointDecoder;
    if (usesRustPointPath && context.loadPreparedPointData) {
      const prepared = await context.loadPreparedPointData(
        streamingNode.node,
        this.pointFields,
        { signal },
      );
      if (signal.aborted) {
        throw createPointLoadAbortError(signal);
      }
      assertPreparedPointData(prepared);
      const alreadyAppliedOffset = context.preparedHeightOffsetMeters ?? 0;
      return applyPreparedPointHeightOffset(
        prepared,
        this.heightOffsetMeters - alreadyAppliedOffset,
      );
    }

    const points = await loadCopcPointBuffer(
      context,
      streamingNode.node,
      this.options.decoder,
      this.pointFields,
      { signal },
    );
    if (signal.aborted) {
      throw createPointLoadAbortError(signal);
    }
    const transformStartedAt = performanceNow();
    const transformed = transformPointBufferToPreparedPointData(
      metadata,
      points,
      this.heightOffsetMeters,
    );
    assertPreparedPointData(transformed);
    performanceRecorder.recordStage(
      'crsTransformDurationMs',
      performanceNow() - transformStartedAt,
      true,
    );
    return transformed;
  }

  private createPerformanceObserver(
    performanceRecorder: StreamingPerformanceRecorder,
  ): CopcPerformanceObserver {
    return (event) => {
      const stage = event.stage === 'rangeFetch'
        ? 'rangeFetchDurationMs'
        : event.stage === 'pointPreparation'
          ? 'pointPreparationDurationMs'
          : 'decodeDurationMs';
      performanceRecorder.recordStage(
        stage,
        event.durationMs,
        event.blocksMainThread ?? event.stage === 'decode',
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
      refinementRejectedByNodeBudgetCount: snapshot.refinementRejectedByNodeBudgetCount,
      refinementRejectedByPointBudgetCount: snapshot.refinementRejectedByPointBudgetCount,
      refinementDeferredByIncompleteHierarchyCount: snapshot.refinementDeferredByIncompleteHierarchyCount,
      minimumFrontierExceedsNodeBudget: snapshot.minimumFrontierExceedsNodeBudget,
      minimumFrontierExceedsPointBudget: snapshot.minimumFrontierExceedsPointBudget,
      refinementAlgorithm: this.getStreamingOptions().refinementAlgorithm
        ?? DEFAULT_REFINEMENT_ALGORITHM,
      refinementFocusEnabled: this.refinementFocus !== undefined,
      motionLookaheadEnabled: this.getStreamingOptions().motionLookahead !== false,
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
            : { completedSchedulingPriorityMin: snapshot.completedSchedulingPriorityMin }),
          ...(snapshot.completedSchedulingPriorityMax === undefined
            ? {}
            : { completedSchedulingPriorityMax: snapshot.completedSchedulingPriorityMax }),
          ...(snapshot.pendingSchedulingPriorityMin === undefined
            ? {}
            : { pendingSchedulingPriorityMin: snapshot.pendingSchedulingPriorityMin }),
          ...(snapshot.pendingSchedulingPriorityMax === undefined
            ? {}
            : { pendingSchedulingPriorityMax: snapshot.pendingSchedulingPriorityMax }),
        }),
      ...(snapshot.firstHighPriorityNodeStartLatencyMs === undefined
        ? {}
        : { firstHighPriorityNodeStartLatencyMs: snapshot.firstHighPriorityNodeStartLatencyMs }),
      ...(snapshot.firstHighPriorityNodeReadyLatencyMs === undefined
        ? {}
        : { firstHighPriorityNodeReadyLatencyMs: snapshot.firstHighPriorityNodeReadyLatencyMs }),
      loadedNodeCount: snapshot.loadedNodeCount,
      loadedPointCount: snapshot.loadedPointCount,
      rangeFetchDurationMs: snapshot.rangeFetchDurationMs,
      rangeFetchBytes: snapshot.rangeFetchBytes,
      decodeDurationMs: snapshot.decodeDurationMs,
      pointPreparationDurationMs: snapshot.pointPreparationDurationMs,
      crsTransformDurationMs: snapshot.crsTransformDurationMs,
      longestMainThreadBlockingSectionMs: snapshot.longestMainThreadBlockingSectionMs,
      ...(snapshot.screenSpaceErrorMin === undefined
        ? {}
        : { screenSpaceErrorMin: snapshot.screenSpaceErrorMin }),
      ...(snapshot.screenSpaceErrorMax === undefined
        ? {}
        : { screenSpaceErrorMax: snapshot.screenSpaceErrorMax }),
      ...(snapshot.effectiveScreenSpaceErrorMin === undefined
        ? {}
        : { effectiveScreenSpaceErrorMin: snapshot.effectiveScreenSpaceErrorMin }),
      ...(snapshot.effectiveScreenSpaceErrorMax === undefined
        ? {}
        : { effectiveScreenSpaceErrorMax: snapshot.effectiveScreenSpaceErrorMax }),
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
        : { candidatesWithNonZeroInfluenceCount: snapshot.candidatesWithNonZeroInfluenceCount }),
      ...(snapshot.acceptedGazeInfluencedRefinementCount === undefined
        ? {}
        : { acceptedGazeInfluencedRefinementCount: snapshot.acceptedGazeInfluencedRefinementCount }),
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
        : { motionInfluencedRefinementCount: snapshot.motionInfluencedRefinementCount }),
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
        : { focusInfluencedRefinementCount: snapshot.focusInfluencedRefinementCount }),
      ...(snapshot.influenceClampCount === undefined
        ? {}
        : { influenceClampCount: snapshot.influenceClampCount }),
      ...(snapshot.acceptedRefinementPriorityMin === undefined
        ? {}
        : { acceptedRefinementPriorityMin: snapshot.acceptedRefinementPriorityMin }),
      ...(snapshot.acceptedRefinementPriorityMax === undefined
        ? {}
        : { acceptedRefinementPriorityMax: snapshot.acceptedRefinementPriorityMax }),
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
        : { candidatesWithCenterBoostCount: snapshot.candidatesWithCenterBoostCount }),
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
    return this.options.maxRenderedPoints
      ?? this.options.streaming?.maxRenderedPoints
      ?? DEFAULT_STREAMING_OPTIONS.maxRenderedPoints
      ?? DEFAULT_MAX_RENDERED_POINTS;
  }

  private isCurrentLoad(loadGeneration: number): boolean {
    return loadGeneration === this.loadGeneration && this.lifecycle !== 'destroyed';
  }

  private isCurrentView(
    viewGeneration: number,
    state: StreamingState,
  ): boolean {
    return viewGeneration === this.viewGeneration
      && this.streamingState === state
      && this.lifecycle === 'ready';
  }

  private debug(message: string): void {
    if (this.options.debug) {
      console.debug(`[CopcStreamingController] ${message}`);
    }
  }
}

/** Descriptive controller alias retained for callers that prefer the API name. */
export { CopcStreamingCore as CopcStreamingController };
