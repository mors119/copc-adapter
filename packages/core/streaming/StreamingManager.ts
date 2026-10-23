import type { RenderablePointData } from "../point/compactEPointCache";
import type { NodePointCache } from "./createNodePointCache";
import {
  cachedPointDataToRenderablePointData,
  type CachedPointData,
} from "../point/compactEPointCache";
import { NodeSelector } from "./NodeSelector";
import type { RefinementFocus } from "./refinementStrategies";
import type { CameraMotionPrediction } from "./motionLookahead";
import type {
  StreamingCameraState,
  StreamingHierarchy,
  StreamingSelectionOptions,
  StreamingHierarchyNode,
  StreamingReplacementGroup,
  StreamingSelectedNode,
  StreamingUpdateResult,
  StreamingWorkProgress,
} from "./types";
import { performanceNow } from "../copc/performance";
import { StreamingPerformanceRecorder } from "./performance";
import {
  DEFAULT_MAX_CONCURRENT_NODE_LOADS,
  runBoundedPriorityWork,
  StreamingWorkConcurrencyLimiter,
} from "./scheduler";

/** Loads renderer-ready point data for one selected COPC hierarchy key. */
export type StreamingNodePointLoader = (
  nodeKey: string,
) => Promise<RenderablePointData>;

/** Optional timing and scheduler callbacks for one current-view update. */
export type StreamingManagerUpdateOptions = {
  /**
   * The caller started performance recording before an async hierarchy query.
   * Keep that recording so the query remains part of this update's metrics.
   */
  performanceAlreadyStarted?: boolean;
  /** Reports queued and active node-load counts while the update is running. */
  onWorkProgress?: (progress: StreamingWorkProgress) => void;
};

function isQueuedDecodeCancellation(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "worker"
  ) {
    return false;
  }
  const cause = "cause" in error ? error.cause : undefined;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "workerCode" in cause &&
    cause.workerCode === "worker-cancelled"
  );
}

function isAncestor(
  ancestorKey: string,
  descendantKey: string,
  hierarchy: StreamingHierarchy,
): boolean {
  if (ancestorKey === descendantKey) {
    return false;
  }

  const visited = new Set<string>();
  const pending = [...(hierarchy.get(ancestorKey)?.children ?? [])];
  while (pending.length > 0) {
    const nodeKey = pending.pop();
    if (!nodeKey || visited.has(nodeKey)) {
      continue;
    }
    if (nodeKey === descendantKey) {
      return true;
    }
    visited.add(nodeKey);
    pending.push(...(hierarchy.get(nodeKey)?.children ?? []));
  }

  return false;
}

function createReplacementGroups(
  previousNodeKeys: readonly string[],
  nextNodeKeys: readonly string[],
  hierarchy: StreamingHierarchy,
): StreamingReplacementGroup[] {
  const previous = [...previousNodeKeys].sort();
  const next = [...nextNodeKeys].sort();
  const removed = previous.filter((nodeKey) => !next.includes(nodeKey));
  const added = next.filter((nodeKey) => !previous.includes(nodeKey));
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const groups: StreamingReplacementGroup[] = [];

  for (const oldNodeKey of removed) {
    const descendants = added.filter((nodeKey) =>
      isAncestor(oldNodeKey, nodeKey, hierarchy),
    );
    if (descendants.length === 0) {
      continue;
    }

    groups.push({
      kind: "refinement",
      oldNodeKeys: [oldNodeKey],
      newNodeKeys: descendants,
    });
    usedOld.add(oldNodeKey);
    for (const nodeKey of descendants) {
      usedNew.add(nodeKey);
    }
  }

  for (const newNodeKey of added) {
    if (usedNew.has(newNodeKey)) {
      continue;
    }

    const descendants = removed.filter(
      (nodeKey) =>
        !usedOld.has(nodeKey) && isAncestor(newNodeKey, nodeKey, hierarchy),
    );
    if (descendants.length === 0) {
      continue;
    }

    groups.push({
      kind: "collapse",
      oldNodeKeys: descendants,
      newNodeKeys: [newNodeKey],
    });
    for (const nodeKey of descendants) {
      usedOld.add(nodeKey);
    }
    usedNew.add(newNodeKey);
  }

  const remainingOld = removed.filter((nodeKey) => !usedOld.has(nodeKey));
  const remainingNew = added.filter((nodeKey) => !usedNew.has(nodeKey));
  if (remainingOld.length > 0 && remainingNew.length > 0) {
    groups.push({
      kind: "retarget",
      oldNodeKeys: remainingOld,
      newNodeKeys: remainingNew,
    });
  }

  return groups;
}

/**
 * Coordinate current-view selection, cache access, and bounded node loading.
 *
 * Each update gets a generation token. Starting a newer view invalidates
 * callbacks and loads from the previous token while preserving reusable cache
 * entries and already prepared point data.
 */
export class StreamingManager {
  private hierarchy: StreamingHierarchy;
  private readonly selector: NodeSelector;
  private readonly cache: NodePointCache<CachedPointData>;
  private readonly toRenderablePointData: (
    value: CachedPointData,
  ) => RenderablePointData;
  private readonly performanceRecorder: StreamingPerformanceRecorder;
  private readonly maxConcurrentNodeLoads: number;
  private readonly workLimiter: StreamingWorkConcurrencyLimiter;
  private readonly onInvalidate?: () => void;
  private updateGeneration = 0;
  private readonly selectedNodeKeys = new Set<string>();
  private readonly activeNodePointCounts = new Map<string, number>();

  constructor(
    hierarchy: StreamingHierarchy,
    options: StreamingSelectionOptions,
    cache: NodePointCache<CachedPointData>,
    performanceRecorder = new StreamingPerformanceRecorder(),
    onInvalidate?: () => void,
    toRenderablePointData: (value: CachedPointData) => RenderablePointData =
      cachedPointDataToRenderablePointData,
  ) {
    this.hierarchy = hierarchy;
    this.selector = new NodeSelector(options);
    this.cache = cache;
    this.toRenderablePointData = toRenderablePointData;
    this.performanceRecorder = performanceRecorder;
    this.performanceRecorder.setConfiguredPointBudget(
      this.selector.getSelectionMetrics().maxRenderedPoints,
    );
    this.maxConcurrentNodeLoads =
      options.maxConcurrentNodeLoads ?? DEFAULT_MAX_CONCURRENT_NODE_LOADS;
    this.workLimiter = new StreamingWorkConcurrencyLimiter(
      this.maxConcurrentNodeLoads,
    );
    this.onInvalidate = onInvalidate;
  }

  /** Return cumulative selection, loading, cache, and renderer-preparation metrics. */
  getPerformanceSnapshot() {
    return this.performanceRecorder.getSnapshot();
  }

  /** Replace the hierarchy used by subsequent view selection. */
  setHierarchy(hierarchy: StreamingHierarchy): void {
    this.hierarchy = hierarchy;
  }

  /** Change focus relevance while retaining this manager's hierarchy and cache. */
  setRefinementFocus(focus: RefinementFocus | undefined): void {
    this.selector.setRefinementFocus(focus);
  }

  /** Replace the bounded current-view motion input without rebuilding the selector. */
  setMotionPrediction(prediction: CameraMotionPrediction): void {
    this.selector.setMotionPrediction(prediction);
  }

  /** Acquire a shared node-load slot for one low-priority prefetch operation. */
  tryAcquirePrefetchSlot(): boolean {
    return this.workLimiter.tryAcquirePrefetchSlot();
  }

  /** Release a shared node-load slot acquired for predictive prefetch. */
  releasePrefetchSlot(): void {
    this.workLimiter.release();
  }

  /**
   * Select the view frontier, load its prepared points, and emit incremental progress.
   *
   * Work from a superseded generation stops contributing results. Returned
   * point data is prepared but renderer commitment remains the adapter's job.
   *
   * @param camera Geographic camera state and optional ECEF frustum.
   * @param onProgress Receives initial selection and completed-node updates.
   * @param options Timing and scheduler progress options.
   * @returns Selected keys, removed keys, loaded points, replacements, and generation.
   */
  async update(
    camera: StreamingCameraState,
    onProgress?: (progress: import("./types").StreamingProgress) => void,
    options: StreamingManagerUpdateOptions = {},
  ): Promise<StreamingUpdateResult> {
    const updateGeneration = ++this.updateGeneration;
    this.onInvalidate?.();
    this.workLimiter.notifyWaiters();
    if (!options.performanceAlreadyStarted) {
      this.performanceRecorder.beginUpdate();
    }
    const selectionStartedAt = performanceNow();
    const selectedNodes = this.selector.selectVisibleNodes(
      camera,
      this.hierarchy,
      {
        previousSelectedNodeKeys: this.selectedNodeKeys,
        isNodeCached: (nodeKey) => this.cache.has(nodeKey),
      },
    );
    const levels = selectedNodes.map((entry) => entry.node.level);
    this.performanceRecorder.setSelection(
      selectedNodes.length,
      selectedNodes.reduce((total, entry) => total + entry.node.pointCount, 0),
      performanceNow() - selectionStartedAt,
      {
        ...this.selector.getSelectionMetrics(),
        visibleLevelRange:
          levels.length > 0
            ? { min: Math.min(...levels), max: Math.max(...levels) }
            : undefined,
        cameraDirection: camera.viewFrustum?.direction,
      },
    );
    const nextSelectedNodeKeys = new Set(
      selectedNodes.map((entry) => entry.node.key),
    );
    this.cache.cancelPendingCurrentExcept(nextSelectedNodeKeys, "superseded");
    const highPriorityNodeKeys = new Set(
      selectedNodes
        .slice(0, Math.max(1, Math.ceil(selectedNodes.length * 0.25)))
        .map((entry) => entry.node.key),
    );
    const replacementGroups = createReplacementGroups(
      [...this.selectedNodeKeys],
      [...nextSelectedNodeKeys],
      this.hierarchy,
    );
    const removedNodeKeys = [...this.selectedNodeKeys]
      .filter((nodeKey) => !nextSelectedNodeKeys.has(nodeKey))
      .sort();

    this.cache.setRequiredNodeKeys(nextSelectedNodeKeys);

    for (const nodeKey of this.activeNodePointCounts.keys()) {
      if (!nextSelectedNodeKeys.has(nodeKey)) {
        this.activeNodePointCounts.delete(nodeKey);
      }
    }

    for (const nodeKey of removedNodeKeys) {
      this.selectedNodeKeys.delete(nodeKey);
    }

    for (const nodeKey of nextSelectedNodeKeys) {
      this.selectedNodeKeys.add(nodeKey);
    }

    onProgress?.({
      selectedNodeKeys: [...nextSelectedNodeKeys].sort(),
      removedNodeKeys,
      loadedNodePoints: new Map(),
      completedBatchPointCount: 0,
      replacementGroups,
      generation: updateGeneration,
    });

    const loadedNodePoints = new Map<string, RenderablePointData>();

    const loadNode = async (node: StreamingSelectedNode) => {
      if (updateGeneration !== this.updateGeneration) {
        return undefined;
      }

      const nodeKey = node.node.key;
      let points: RenderablePointData;
      try {
        points = this.toRenderablePointData(await this.cache.load(nodeKey));
      } catch (error: unknown) {
        // A view change intentionally cancels queued decode work. The
        // superseded update must finish quietly so its stale results cannot
        // affect the new selection.
        if (updateGeneration !== this.updateGeneration) {
          return undefined;
        }
        if (isQueuedDecodeCancellation(error)) {
          // The cancelled promise may still be visible in the cache for
          // this turn of the microtask queue. Evict and resubmit it for the
          // current generation rather than exposing cancellation as a
          // user-visible decode failure.
          this.cache.delete(nodeKey);
          points = this.toRenderablePointData(await this.cache.load(nodeKey));
        } else {
          throw error;
        }
      }

      if (updateGeneration !== this.updateGeneration) {
        return undefined;
      }

      return { node, nodeKey, points };
    };

    let reportedCancelledNodeCount = 0;
    await runBoundedPriorityWork(selectedNodes, {
      maxConcurrentNodeLoads: this.maxConcurrentNodeLoads,
      workLimiter: this.workLimiter,
      load: loadNode,
      getPriority: (node) => node.schedulingPriority,
      isHighPriority: (node) => highPriorityNodeKeys.has(node.node.key),
      isReady: (node) => this.cache.get(node.node.key) !== undefined,
      shouldContinue: () => updateGeneration === this.updateGeneration,
      onDiagnostics: (diagnostics) => {
        const cancelledNodeDelta =
          diagnostics.cancelledNodeCount - reportedCancelledNodeCount;
        reportedCancelledNodeCount = diagnostics.cancelledNodeCount;
        if (cancelledNodeDelta > 0) {
          this.performanceRecorder.recordSchedulingCancellations(
            cancelledNodeDelta,
          );
        }
        if (updateGeneration === this.updateGeneration) {
          this.performanceRecorder.setSchedulingDiagnostics(diagnostics);
          options.onWorkProgress?.({
            queuedNodeCount: diagnostics.queuedNodeCount,
            activeNodeCount: diagnostics.activeNodeCount,
          });
        }
      },
      onStart: (node) => {
        if (highPriorityNodeKeys.has(node.node.key)) {
          this.performanceRecorder.recordFirstHighPriorityNodeStart();
        }
      },
      onComplete: (node, loaded) => {
        if (!loaded || updateGeneration !== this.updateGeneration) {
          return;
        }

        if (highPriorityNodeKeys.has(node.node.key)) {
          this.performanceRecorder.recordFirstHighPriorityNodeReady();
        }
        if (
          this.selectedNodeKeys.has(loaded.nodeKey) &&
          this.acceptLoadedNode(loaded.node, loaded.points.pointCount)
        ) {
          loadedNodePoints.set(loaded.nodeKey, loaded.points);
          this.performanceRecorder.recordLoadedNode(loaded.points.pointCount);
          onProgress?.({
            selectedNodeKeys: [...nextSelectedNodeKeys].sort(),
            removedNodeKeys,
            loadedNodePoints: new Map<string, RenderablePointData>([
              [loaded.nodeKey, loaded.points],
            ]),
            completedBatchPointCount: loaded.points.pointCount,
            replacementGroups,
            generation: updateGeneration,
          });
        }
      },
    });

    if (updateGeneration === this.updateGeneration) {
      this.performanceRecorder.finishUpdate();
    }

    return {
      selectedNodeKeys: [...nextSelectedNodeKeys].sort(),
      removedNodeKeys,
      loadedNodePoints,
      replacementGroups,
      generation: updateGeneration,
    };
  }

  /** Invalidate active work and clear selection state and retained point values. */
  clear(): void {
    this.invalidate("lifecycle");
    this.selectedNodeKeys.clear();
    this.activeNodePointCounts.clear();
    this.cache.clear();
  }

  /** Invalidate a generation and cancel pending point reads outside its next selection. */
  invalidate(
    reason: "superseded" | "lifecycle" = "superseded",
    camera?: StreamingCameraState,
  ): void {
    this.updateGeneration += 1;
    if (reason === "lifecycle") {
      this.cache.cancelPending(reason);
    } else if (camera) {
      const selectedNodeKeys = this.selector
        .selectVisibleNodes(camera, this.hierarchy, {
          previousSelectedNodeKeys: this.selectedNodeKeys,
          isNodeCached: (nodeKey) => this.cache.has(nodeKey),
        })
        .map((entry) => entry.node.key);
      this.cache.cancelPendingExcept(selectedNodeKeys, reason);
    }
    this.onInvalidate?.();
    this.workLimiter.notifyWaiters();
  }

  private acceptLoadedNode(
    node: StreamingHierarchyNode,
    actualPointCount: number,
  ): boolean {
    const pointCount =
      Number.isSafeInteger(actualPointCount) && actualPointCount >= 0
        ? actualPointCount
        : 0;
    const budget = this.selector.getSelectionMetrics().maxRenderedPoints;
    let currentPointCount = 0;
    for (const count of this.activeNodePointCounts.values()) {
      currentPointCount += count;
    }
    const previousPointCount =
      this.activeNodePointCounts.get(node.node.key) ?? 0;
    const nextPointCount = currentPointCount - previousPointCount + pointCount;

    if (nextPointCount > budget) {
      this.performanceRecorder.recordBudgetDrop(1, pointCount);
      return false;
    }

    this.activeNodePointCounts.set(node.node.key, pointCount);
    return true;
  }
}
