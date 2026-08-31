import type { GeographicPointBuffer } from '../../copc/types/copc';
import type { NodePointCache } from './createNodePointCache';
import { NodeSelector } from './NodeSelector';
import type {
  StreamingCameraState,
  StreamingHierarchy,
  StreamingSelectionOptions,
  StreamingHierarchyNode,
  StreamingReplacementGroup,
  StreamingUpdateResult,
} from './types';
import { performanceNow } from '../../copc/performance';
import { StreamingPerformanceRecorder } from './performance';
import { createStreamingWorkBatches, yieldToBrowser } from './scheduler';

export type StreamingNodePointLoader = (
  nodeKey: string,
) => Promise<GeographicPointBuffer>;

export type StreamingManagerUpdateOptions = {
  /**
   * The caller started performance recording before an async hierarchy query.
   * Keep that recording so the query remains part of this update's metrics.
   */
  performanceAlreadyStarted?: boolean;
};

function isQueuedDecodeCancellation(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'worker') {
    return false;
  }
  const cause = 'cause' in error ? error.cause : undefined;
  return typeof cause === 'object'
    && cause !== null
    && 'workerCode' in cause
    && cause.workerCode === 'worker-cancelled';
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
      isAncestor(oldNodeKey, nodeKey, hierarchy));
    if (descendants.length === 0) {
      continue;
    }

    groups.push({
      kind: 'refinement',
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

    const descendants = removed.filter((nodeKey) =>
      !usedOld.has(nodeKey) && isAncestor(newNodeKey, nodeKey, hierarchy));
    if (descendants.length === 0) {
      continue;
    }

    groups.push({
      kind: 'collapse',
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
      kind: 'retarget',
      oldNodeKeys: remainingOld,
      newNodeKeys: remainingNew,
    });
  }

  return groups;
}

export class StreamingManager {
  private hierarchy: StreamingHierarchy;
  private readonly selector: NodeSelector;
  private readonly cache: NodePointCache<GeographicPointBuffer>;
  private readonly performanceRecorder: StreamingPerformanceRecorder;
  private readonly maxPointsPerBatch: number;
  private readonly onInvalidate?: () => void;
  private updateGeneration = 0;
  private readonly selectedNodeKeys = new Set<string>();
  private readonly activeNodePointCounts = new Map<string, number>();

  constructor(
    hierarchy: StreamingHierarchy,
    options: StreamingSelectionOptions,
    cache: NodePointCache<GeographicPointBuffer>,
    performanceRecorder = new StreamingPerformanceRecorder(),
    onInvalidate?: () => void,
  ) {
    this.hierarchy = hierarchy;
    this.selector = new NodeSelector(options);
    this.cache = cache;
    this.performanceRecorder = performanceRecorder;
    this.performanceRecorder.setConfiguredPointBudget(
      this.selector.getSelectionMetrics().maxRenderedPoints,
    );
    this.maxPointsPerBatch = options.maxPointsPerBatch ?? 100_000;
    this.onInvalidate = onInvalidate;
  }

  getPerformanceSnapshot() {
    return this.performanceRecorder.getSnapshot();
  }

  setHierarchy(hierarchy: StreamingHierarchy): void {
    this.hierarchy = hierarchy;
  }

  async update(
    camera: StreamingCameraState,
    onProgress?: (progress: import('./types').StreamingProgress) => void,
    options: StreamingManagerUpdateOptions = {},
  ): Promise<StreamingUpdateResult> {
    const updateGeneration = ++this.updateGeneration;
    this.onInvalidate?.();
    if (!options.performanceAlreadyStarted) {
      this.performanceRecorder.beginUpdate();
    }
    const selectionStartedAt = performanceNow();
    const selectedNodes = this.selector.selectVisibleNodes(camera, this.hierarchy, {
      previousSelectedNodeKeys: this.selectedNodeKeys,
      isNodeCached: (nodeKey) => this.cache.has(nodeKey),
    });
    const levels = selectedNodes.map((entry) => entry.node.level);
    this.performanceRecorder.setSelection(
      selectedNodes.length,
      selectedNodes.reduce((total, entry) => total + entry.node.pointCount, 0),
      performanceNow() - selectionStartedAt,
      {
        ...this.selector.getSelectionMetrics(),
        visibleLevelRange: levels.length > 0
          ? { min: Math.min(...levels), max: Math.max(...levels) }
          : undefined,
        cameraDirection: camera.viewFrustum?.direction,
      },
    );
    const nextSelectedNodeKeys = new Set(
      selectedNodes.map((entry) => entry.node.key),
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

    const loadedNodePoints = new Map<string, GeographicPointBuffer>();

    for (const batch of createStreamingWorkBatches(selectedNodes, this.maxPointsPerBatch)) {
      const batchLoads = await Promise.all(batch.nodes.map(async (node) => {
        if (updateGeneration !== this.updateGeneration) {
          return undefined;
        }

        const nodeKey = node.node.key;
        let points: GeographicPointBuffer;
        try {
          points = await this.cache.load(nodeKey);
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
            points = await this.cache.load(nodeKey);
          } else {
            throw error;
          }
        }

        if (updateGeneration !== this.updateGeneration) {
          return undefined;
        }

        return { node, nodeKey, points };
      }));

      for (const loaded of batchLoads) {
        if (!loaded || updateGeneration !== this.updateGeneration) {
          continue;
        }
        if (this.selectedNodeKeys.has(loaded.nodeKey)
          && this.acceptLoadedNode(loaded.node, loaded.points.pointCount)) {
          loadedNodePoints.set(loaded.nodeKey, loaded.points);
          this.performanceRecorder.recordLoadedNode(loaded.points.pointCount);
          onProgress?.({
            selectedNodeKeys: [...nextSelectedNodeKeys].sort(),
            removedNodeKeys,
            loadedNodePoints: new Map([[loaded.nodeKey, loaded.points]]),
            completedBatchPointCount: loaded.points.pointCount,
            replacementGroups,
            generation: updateGeneration,
          });
        }
      }

      if (updateGeneration !== this.updateGeneration) {
        break;
      }

      await yieldToBrowser();
    }

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

  clear(): void {
    this.invalidate();
    this.selectedNodeKeys.clear();
    this.activeNodePointCounts.clear();
    this.cache.clear();
  }

  /** Invalidate queued work while preserving reusable point-cache entries. */
  invalidate(): void {
    this.updateGeneration += 1;
    this.onInvalidate?.();
  }

  private acceptLoadedNode(
    node: StreamingHierarchyNode,
    actualPointCount: number,
  ): boolean {
    const pointCount = Number.isSafeInteger(actualPointCount) && actualPointCount >= 0
      ? actualPointCount
      : 0;
    const budget = this.selector.getSelectionMetrics().maxRenderedPoints;
    let currentPointCount = 0;
    for (const count of this.activeNodePointCounts.values()) {
      currentPointCount += count;
    }
    const previousPointCount = this.activeNodePointCounts.get(node.node.key) ?? 0;
    const nextPointCount = currentPointCount - previousPointCount + pointCount;

    if (nextPointCount > budget) {
      this.performanceRecorder.recordBudgetDrop(1, pointCount);
      return false;
    }

    this.activeNodePointCounts.set(node.node.key, pointCount);
    return true;
  }
}
