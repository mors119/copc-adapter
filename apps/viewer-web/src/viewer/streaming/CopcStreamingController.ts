import {
  createCopcContext,
} from '../../copc/context/createCopcContext';
import type { CopcSource, CopcWorkerDiagnostics } from '../../copc/backend/types';
import {
  getCopcBackendName,
  type CopcBackendSelection,
  type CopcBackendName,
} from '../../copc/backend/selection';
import type { CopcPointDecoder } from '../../copc/points/types';
import { HierarchyLoader } from '../../copc/hierarchy/HierarchyLoader';
import type {
  CopcHierarchyBounds,
  CopcHierarchyDiagnostics,
  CopcHierarchyQuery,
} from '../../copc/hierarchy/types';
import { CopcHierarchyLoadError, CopcLoadError } from '../../copc/errors';
import { loadCopcMetadata } from '../../copc/metadata/loadMetadata';
import { loadCopcPointBuffer } from '../../copc/points/loadPointData';
import { createCopcPointFieldSelection, type CopcPointFieldSelection } from '../../copc/points/fieldSelection';
import {
  createProjectPointTransformer,
  transformPointBuffer,
} from '../../coordinates/transform/createPointTransformer';
import type {
  CopcMetadata,
  GeographicPointBuffer,
} from '../../copc/types/copc';
import type { CopcPerformanceObserver } from '../../copc/performance';
import { performanceNow } from '../../copc/performance';
import { buildStreamingHierarchy } from './buildStreamingHierarchy';
import {
  createNodePointCache,
  type NodePointCache,
  type NodePointCacheDiagnostics,
} from './createNodePointCache';
import { DEFAULT_MAX_RENDERED_POINTS } from './NodeSelector';
import { StreamingManager } from './StreamingManager';
import { createStreamingViewBounds } from './view';
import type {
  StreamingHierarchy,
  StreamingHierarchyNode,
  StreamingProgress,
  StreamingReplacementGroup,
  StreamingSelectionOptions,
  StreamingUpdateResult,
  StreamingView,
} from './types';
import {
  StreamingPerformanceRecorder,
  type StreamingPerformanceSnapshot,
} from './performance';

/** Lifecycle states that do not depend on an attached rendering engine. */
export type CopcStreamingLifecycleState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'destroyed';

export type CopcStreamingTransitionState = {
  /** The view generation that produced this intent. */
  generation: number;
  /** Coverage-safe replacement intents for the renderer adapter. */
  replacementGroups: StreamingReplacementGroup[];
};

export type CopcStreamingControllerOptions = {
  /** Source URL or source identity used by the selected backend. */
  url: string;
  /** Overrides for the shared selection and streaming limits. */
  streaming?: Partial<StreamingSelectionOptions>;
  /** Convenience override for the shared rendered-point workload budget. */
  maxRenderedPoints?: number;
  /** Stable `copc-js` by default, Rust or a test backend by explicit choice. */
  backend?: CopcBackendSelection;
  /** Decoder used when the source does not expose direct point buffers. */
  decoder?: CopcPointDecoder;
  /** Fields requested from each backend point chunk. Defaults to position only. */
  pointFields?: CopcPointFieldSelection;
  /** Maximum retained decoded CPU point-buffer bytes. Defaults to 256 MiB. */
  maxPointCacheBytes?: number;
  /** Emits lifecycle messages through console.debug. */
  debug?: boolean;
};

/** Core terminology alias for applications that avoid the controller name. */
export type CopcStreamingCoreOptions = CopcStreamingControllerOptions;

export type CopcStreamingProgressHandler = (progress: StreamingProgress) => void;

/** Performance values owned by the core; renderer frame/GPU timings are excluded. */
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
  | 'centerWeightMin'
  | 'centerWeightMax'
  | 'acceptedRefinementPriorityMin'
  | 'acceptedRefinementPriorityMax'
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
  | 'crsTransformDurationMs'
  | 'longestMainThreadBlockingSectionMs'
>;

export type CopcStreamingSnapshot = {
  lifecycle: CopcStreamingLifecycleState;
  source: string;
  backend: CopcBackendName | 'custom';
  selectedNodeKeys: string[];
  streamingUpdateCount: number;
  performance: CopcStreamingPerformanceSnapshot;
  transition: CopcStreamingTransitionState;
  hierarchy?: CopcHierarchyDiagnostics;
  pointCache: NodePointCacheDiagnostics;
  worker?: CopcWorkerDiagnostics;
};

type StreamingState = {
  context: CopcSource;
  metadata: CopcMetadata;
  hierarchyLoader: HierarchyLoader;
  nodes: StreamingHierarchy;
  nodesRef: { current: StreamingHierarchy };
  cache: NodePointCache<GeographicPointBuffer>;
  manager: StreamingManager;
};

const DEFAULT_STREAMING_OPTIONS: StreamingSelectionOptions = {
  maxNodes: 24,
  maxDepth: 6,
  maxScreenSpaceError: 8,
  refineDistanceMultiplier: 6,
  maxRenderDistanceMeters: 12000,
  maxRenderedPoints: DEFAULT_MAX_RENDERED_POINTS,
  maxPointsPerBatch: 100000,
};
const MAX_CACHED_NODES = 48;
const DEFAULT_POINT_CACHE_BYTES = 256 * 1024 * 1024;

function createTransitionState(): CopcStreamingTransitionState {
  return {
    generation: 0,
    replacementGroups: [],
  };
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
): CopcHierarchyBounds {
  const toProject = createProjectPointTransformer(metadata);
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

  return corners.reduce<CopcHierarchyBounds>((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    minZ: Math.min(bounds.minZ, point.z),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
    maxZ: Math.max(bounds.maxZ, point.z),
  }), {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  });
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
  private readonly performanceRecorder = new StreamingPerformanceRecorder();
  private readonly performanceObserver: CopcPerformanceObserver = (event) => {
    const stage = event.stage === 'rangeFetch'
      ? 'rangeFetchDurationMs'
      : 'decodeDurationMs';
    this.performanceRecorder.recordStage(
      stage,
      event.durationMs,
      event.blocksMainThread ?? event.stage === 'decode',
      event.bytes,
    );
  };
  private readonly initialCache: NodePointCache<GeographicPointBuffer>;
  private readonly pointFields: CopcPointFieldSelection;
  private streamingState?: StreamingState;
  private loadGeneration = 0;
  private viewGeneration = 0;
  private streamingUpdateCount = 0;
  private selectedNodeKeys = new Set<string>();
  private currentView?: StreamingView;
  private transition = createTransitionState();
  private lifecycle: CopcStreamingLifecycleState = 'idle';

  constructor(options: CopcStreamingControllerOptions) {
    this.options = options;
    this.pointFields = createCopcPointFieldSelection([
      'position',
      ...(options.pointFields ?? []),
    ]);
    this.performanceRecorder.setConfiguredPointBudget(this.getMaxRenderedPoints());
    this.initialCache = this.createEmptyCache();
  }

  /** Load metadata and the root hierarchy without requiring a renderer. */
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
    let context: CopcSource | undefined;

    try {
      context = await createCopcContext(this.options.url, this.options.backend);
      if (!this.isCurrentLoad(loadGeneration)) {
        context.destroy?.();
        return;
      }

      context.setPerformanceObserver?.(this.performanceObserver);
      const metadata = await loadCopcMetadata(context);
      if (!this.isCurrentLoad(loadGeneration)) {
        context.destroy?.();
        return;
      }

      const hierarchyLoader = new HierarchyLoader(context, metadata.cube);
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

      const nodes = buildStreamingHierarchy(metadata, rootHierarchy.nodes);
      const nodesRef = { current: nodes };
      const cache = this.createCache(context, metadata, nodesRef);
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

      this.streamingState = {
        context,
        metadata,
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
   * the promise resolves, allowing adapters to prepare nodes progressively.
   */
  async updateView(
    view: StreamingView,
    onProgress?: CopcStreamingProgressHandler,
  ): Promise<StreamingUpdateResult | undefined> {
    if (this.lifecycle === 'destroyed') {
      throw new Error('CopcStreamingController has been destroyed');
    }
    const streamingState = this.streamingState;
    if (!streamingState || this.lifecycle !== 'ready') {
      throw new Error('COPC streaming controller is not loaded');
    }

    const viewGeneration = ++this.viewGeneration;
    // Invalidate queued point work while the generation's hierarchy query is
    // still in flight. The manager also invalidates at update start, matching
    // the established stale-result semantics.
    streamingState.manager.invalidate();
    // Start measuring before a view can discover uncached hierarchy pages. The
    // manager is told to continue this recording after the query completes.
    this.performanceRecorder.beginUpdate();

    let hierarchy;
    try {
      hierarchy = await streamingState.hierarchyLoader.query(
        this.getHierarchyQuery(view),
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
    );
    streamingState.nodes = availableNodes;
    streamingState.nodesRef.current = availableNodes;
    streamingState.manager.setHierarchy(availableNodes);

    let progressApplied = false;
    const applyProgress = (progress: StreamingProgress): void => {
      if (!this.isCurrentView(viewGeneration, streamingState)) {
        return;
      }

      progressApplied = true;
      this.applyProgress(progress, onProgress, viewGeneration);
    };
    const update = await streamingState.manager.update(view, applyProgress, {
      performanceAlreadyStarted: true,
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
    this.currentView = view;
    this.streamingUpdateCount += 1;
    this.debug(`streaming view updated (${this.streamingUpdateCount})`);
    return update;
  }

  /** Return the project-coordinate query generated for a plain view. */
  getHierarchyQuery(view: StreamingView): CopcHierarchyQuery {
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
      bounds: toProjectBounds(metadata, viewBounds.bounds),
      maxLevel: streamingOptions.maxDepth,
    };
  }

  /** Remove source, hierarchy, cache, and selected-view state for reuse. */
  unload(): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }

    this.loadGeneration += 1;
    this.viewGeneration += 1;
    const state = this.streamingState;
    state?.manager.clear();
    state?.context.destroy?.();
    state?.cache.clear();
    this.streamingState = undefined;
    this.selectedNodeKeys.clear();
    this.currentView = undefined;
    this.transition = createTransitionState();
    this.streamingUpdateCount = 0;
    this.lifecycle = 'idle';
    this.debug('COPC streaming controller unloaded');
  }

  /** Unload and load the configured source again. */
  async reload(): Promise<void> {
    this.unload();
    await this.load();
  }

  /** Permanently release all source-owned state. */
  destroy(): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }

    this.unload();
    this.lifecycle = 'destroyed';
  }

  getSnapshot(): CopcStreamingSnapshot {
    const state = this.streamingState;
    const worker = state?.context.getWorkerDiagnostics?.();
    return {
      lifecycle: this.lifecycle,
      source: state?.context.source ?? this.options.url,
      backend: getCopcBackendName(this.options.backend),
      selectedNodeKeys: this.getCurrentSelection(),
      streamingUpdateCount: this.streamingUpdateCount,
      performance: this.getPerformanceSnapshot(),
      transition: cloneTransitionState(this.transition),
      ...(state ? { hierarchy: state.hierarchyLoader.getDiagnostics() } : {}),
      pointCache: state?.cache.getDiagnostics() ?? this.initialCache.getDiagnostics(),
      ...(worker ? { worker } : {}),
    };
  }

  getMetadata(): CopcMetadata | undefined {
    return this.streamingState?.metadata;
  }

  getHierarchyDiagnostics(): CopcHierarchyDiagnostics | undefined {
    return this.streamingState?.hierarchyLoader.getDiagnostics();
  }

  getPointCacheDiagnostics(): NodePointCacheDiagnostics {
    return this.streamingState?.cache.getDiagnostics()
      ?? this.initialCache.getDiagnostics();
  }

  getCurrentSelection(): string[] {
    return [...this.selectedNodeKeys].sort();
  }

  getCurrentView(): StreamingView | undefined {
    return this.currentView;
  }

  /** Return the currently available hierarchy node for an adapter-side pick. */
  getHierarchyNode(nodeKey: string): StreamingHierarchyNode | undefined {
    return this.streamingState?.nodes.get(nodeKey);
  }

  /** Invalidate an in-flight view without unloading reusable source state. */
  invalidateView(): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }

    this.viewGeneration += 1;
    this.streamingState?.manager.invalidate();
  }

  getTransitionState(): CopcStreamingTransitionState {
    return cloneTransitionState(this.transition);
  }

  /** Return a resolved point buffer retained by the current decoded cache. */
  getCachedPointBuffer(nodeKey: string): GeographicPointBuffer | undefined {
    return this.streamingState?.cache.get(nodeKey);
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

  private createEmptyCache(): NodePointCache<GeographicPointBuffer> {
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
  ): NodePointCache<GeographicPointBuffer> {
    return createNodePointCache(
      (nodeKey) => this.loadRenderableNodePoints(context, metadata, nodesRef, nodeKey),
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
    nodeKey: string,
  ): Promise<GeographicPointBuffer> {
    const streamingNode = nodesRef.current.get(nodeKey);
    if (!streamingNode) {
      throw new Error(`Unknown COPC hierarchy node: ${nodeKey}`);
    }

    const points = await loadCopcPointBuffer(
      context,
      streamingNode.node,
      this.options.decoder,
      this.pointFields,
    );
    const transformStartedAt = performanceNow();
    const transformed = transformPointBuffer(metadata, points);
    this.performanceRecorder.recordStage(
      'crsTransformDurationMs',
      performanceNow() - transformStartedAt,
      true,
    );
    return transformed;
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
      loadedNodeCount: snapshot.loadedNodeCount,
      loadedPointCount: snapshot.loadedPointCount,
      rangeFetchDurationMs: snapshot.rangeFetchDurationMs,
      rangeFetchBytes: snapshot.rangeFetchBytes,
      decodeDurationMs: snapshot.decodeDurationMs,
      crsTransformDurationMs: snapshot.crsTransformDurationMs,
      longestMainThreadBlockingSectionMs: snapshot.longestMainThreadBlockingSectionMs,
      ...(snapshot.screenSpaceErrorMin === undefined
        ? {}
        : { screenSpaceErrorMin: snapshot.screenSpaceErrorMin }),
      ...(snapshot.screenSpaceErrorMax === undefined
        ? {}
        : { screenSpaceErrorMax: snapshot.screenSpaceErrorMax }),
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
      ...(snapshot.acceptedRefinementPriorityMin === undefined
        ? {}
        : { acceptedRefinementPriorityMin: snapshot.acceptedRefinementPriorityMin }),
      ...(snapshot.acceptedRefinementPriorityMax === undefined
        ? {}
        : { acceptedRefinementPriorityMax: snapshot.acceptedRefinementPriorityMax }),
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
