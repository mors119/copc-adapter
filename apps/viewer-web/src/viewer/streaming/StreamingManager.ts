import type { GeographicPointBuffer } from '../../copc/types/copc';
import type { NodePointCache } from './createNodePointCache';
import { NodeSelector } from './NodeSelector';
import type {
  StreamingCameraState,
  StreamingHierarchy,
  StreamingSelectionOptions,
  StreamingUpdateResult,
} from './types';
import { performanceNow } from '../../copc/performance';
import { StreamingPerformanceRecorder } from './performance';
import { createStreamingWorkBatches, yieldToBrowser } from './scheduler';

export type StreamingNodePointLoader = (
  nodeKey: string,
) => Promise<GeographicPointBuffer>;

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

export class StreamingManager {
  private hierarchy: StreamingHierarchy;
  private readonly selector: NodeSelector;
  private readonly cache: NodePointCache<GeographicPointBuffer>;
  private readonly performanceRecorder: StreamingPerformanceRecorder;
  private readonly maxPointsPerBatch: number;
  private readonly onInvalidate?: () => void;
  private updateGeneration = 0;
  private readonly selectedNodeKeys = new Set<string>();

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
  ): Promise<StreamingUpdateResult> {
    const updateGeneration = ++this.updateGeneration;
    this.onInvalidate?.();
    this.performanceRecorder.beginUpdate();
    const selectionStartedAt = performanceNow();
    const selectedNodes = this.selector.selectVisibleNodes(camera, this.hierarchy);
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
    const removedNodeKeys = [...this.selectedNodeKeys]
      .filter((nodeKey) => !nextSelectedNodeKeys.has(nodeKey))
      .sort();

    this.cache.setRequiredNodeKeys(nextSelectedNodeKeys);

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

        return { nodeKey, points };
      }));

      for (const loaded of batchLoads) {
        if (!loaded || updateGeneration !== this.updateGeneration) {
          continue;
        }
        if (this.selectedNodeKeys.has(loaded.nodeKey)) {
          loadedNodePoints.set(loaded.nodeKey, loaded.points);
          this.performanceRecorder.recordLoadedNode(loaded.points.pointCount);
          onProgress?.({
            selectedNodeKeys: [...nextSelectedNodeKeys].sort(),
            removedNodeKeys,
            loadedNodePoints: new Map([[loaded.nodeKey, loaded.points]]),
            completedBatchPointCount: loaded.points.pointCount,
          });
        }
      }

      if (updateGeneration !== this.updateGeneration) {
        break;
      }

      await yieldToBrowser();
    }

    this.performanceRecorder.finishUpdate();

    return {
      selectedNodeKeys: [...nextSelectedNodeKeys].sort(),
      removedNodeKeys,
      loadedNodePoints,
    };
  }

  clear(): void {
    this.invalidate();
    this.selectedNodeKeys.clear();
    this.cache.clear();
  }

  /** Invalidate queued work while preserving reusable point-cache entries. */
  invalidate(): void {
    this.updateGeneration += 1;
    this.onInvalidate?.();
  }
}
