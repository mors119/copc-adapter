import type {
  StreamingHierarchyNode,
  StreamingSchedulingDiagnostics,
} from './types';

export const DEFAULT_MAX_CONCURRENT_NODE_LOADS = 4;

export type StreamingWorkSchedulerDiagnostics = StreamingSchedulingDiagnostics;

export type StreamingWorkBatch<TNode extends StreamingHierarchyNode = StreamingHierarchyNode> = {
  nodes: TNode[];
  estimatedPointCount: number;
};

/** Partition prioritised work before range/decode work starts. */
export function createStreamingWorkBatches<TNode extends StreamingHierarchyNode>(
  nodes: readonly TNode[],
  maxPointsPerBatch: number,
): StreamingWorkBatch<TNode>[] {
  const boundedPointLimit = Number.isFinite(maxPointsPerBatch) && maxPointsPerBatch > 0
    ? maxPointsPerBatch
    : Number.POSITIVE_INFINITY;
  const batches: StreamingWorkBatch<TNode>[] = [];
  let currentNodes: TNode[] = [];
  let currentPointCount = 0;

  for (const node of nodes) {
    const pointCount = Math.max(0, node.node.pointCount);
    if (currentNodes.length > 0 && currentPointCount + pointCount > boundedPointLimit) {
      batches.push({ nodes: currentNodes, estimatedPointCount: currentPointCount });
      currentNodes = [];
      currentPointCount = 0;
    }

    currentNodes.push(node);
    currentPointCount += pointCount;
  }

  if (currentNodes.length > 0) {
    batches.push({ nodes: currentNodes, estimatedPointCount: currentPointCount });
  }

  return batches;
}

export type StreamingWorkSchedulerOptions<TNode, TResult> = {
  maxConcurrentNodeLoads: number;
  load: (node: TNode) => Promise<TResult>;
  /** A resolved cache entry can be completed without consuming a work slot. */
  isReady?: (node: TNode) => boolean;
  /** Stop scheduling when the owning view generation is no longer current. */
  shouldContinue?: () => boolean;
  onStart?: (node: TNode) => void;
  onComplete?: (node: TNode, result: TResult) => void | Promise<void>;
  onCancel?: (node: TNode) => void;
  onDiagnostics?: (diagnostics: StreamingWorkSchedulerDiagnostics) => void;
};

type SettledWork<TResult> = {
  ok: true;
  result: TResult;
} | {
  ok: false;
  error: unknown;
};

type ActiveWork<TNode, TResult> = {
  node: TNode;
  promise: Promise<SettledWork<TResult>>;
};

function validateConcurrency(maxConcurrentNodeLoads: number): number {
  if (!Number.isInteger(maxConcurrentNodeLoads) || maxConcurrentNodeLoads < 1) {
    throw new RangeError(
      'Streaming maxConcurrentNodeLoads must be a positive integer',
    );
  }

  return maxConcurrentNodeLoads;
}

/**
 * Run selected work in priority order with bounded active loads.
 *
 * The first pending node is always started before a lower-priority pending
 * node. Resolved cache entries are zero-slot work, so they can be delivered
 * while unrelated range/decode loads are still active. Every settled result
 * yields before more work is dispatched, which keeps progressive rendering
 * responsive in browser environments.
 */
export async function runBoundedPriorityWork<TNode, TResult>(
  nodes: readonly TNode[],
  options: StreamingWorkSchedulerOptions<TNode, TResult>,
): Promise<StreamingWorkSchedulerDiagnostics> {
  const maxConcurrentNodeLoads = validateConcurrency(options.maxConcurrentNodeLoads);
  const pending = [...nodes];
  const active = new Set<ActiveWork<TNode, TResult>>();
  let completedNodeCount = 0;
  let cancelledNodeCount = 0;
  let peakActiveNodeCount = 0;

  const getDiagnostics = (): StreamingWorkSchedulerDiagnostics => ({
    maxConcurrentNodeLoads,
    queuedNodeCount: pending.length,
    activeNodeCount: active.size,
    completedNodeCount,
    cancelledNodeCount,
    peakActiveNodeCount,
  });
  const reportDiagnostics = (): void => {
    options.onDiagnostics?.(getDiagnostics());
  };

  const isCurrent = (): boolean => options.shouldContinue?.() ?? true;

  const startWork = (node: TNode): Promise<SettledWork<TResult>> => {
    try {
      return Promise.resolve(options.load(node))
        .then((result): SettledWork<TResult> => ({ ok: true, result }))
        .catch((error: unknown): SettledWork<TResult> => ({ ok: false, error }));
    } catch (error: unknown) {
      return Promise.resolve({ ok: false, error });
    }
  };

  const cancelRemaining = (): StreamingWorkSchedulerDiagnostics => {
    cancelledNodeCount += pending.length + active.size;
    for (const node of pending) {
      options.onCancel?.(node);
    }
    pending.length = 0;
    active.clear();
    reportDiagnostics();
    return getDiagnostics();
  };

  const settle = async (
    node: TNode,
    promise: Promise<SettledWork<TResult>>,
  ): Promise<void> => {
    const settled = await promise;
    completedNodeCount += 1;
    reportDiagnostics();
    if (!settled.ok) {
      throw settled.error;
    }
    await options.onComplete?.(node, settled.result);
    await yieldToBrowser();
  };

  reportDiagnostics();
  while (pending.length > 0 || active.size > 0) {
    if (!isCurrent()) {
      return cancelRemaining();
    }

    // Preserve priority while there is an available slot. A ready cache hit
    // is handled inline and does not consume one of those slots.
    if (pending.length > 0 && options.isReady?.(pending[0]) === true) {
      const node = pending.shift();
      if (node === undefined) {
        continue;
      }
      options.onStart?.(node);
      reportDiagnostics();
      await settle(node, startWork(node));
      continue;
    }

    while (active.size < maxConcurrentNodeLoads && pending.length > 0) {
      if (!isCurrent()) {
        return cancelRemaining();
      }

      const node = pending.shift();
      if (node === undefined) {
        break;
      }
      if (options.isReady?.(node) === true) {
        options.onStart?.(node);
        reportDiagnostics();
        await settle(node, startWork(node));
        continue;
      }

      const work: ActiveWork<TNode, TResult> = {
        node,
        promise: startWork(node),
      };
      active.add(work);
      peakActiveNodeCount = Math.max(peakActiveNodeCount, active.size);
      options.onStart?.(node);
      reportDiagnostics();
    }

    // A lower-priority cache hit must not wait for an unrelated slow miss.
    const readyIndex = options.isReady
      ? pending.findIndex((node) => options.isReady?.(node) === true)
      : -1;
    if (readyIndex >= 0) {
      const [node] = pending.splice(readyIndex, 1);
      if (node === undefined) {
        continue;
      }
      options.onStart?.(node);
      reportDiagnostics();
      await settle(node, startWork(node));
      continue;
    }

    if (active.size === 0) {
      continue;
    }

    const settledWork = await Promise.race(
      [...active].map(async (work) => ({
        work,
        settled: await work.promise,
      })),
    );
    active.delete(settledWork.work);
    completedNodeCount += 1;
    reportDiagnostics();
    if (!settledWork.settled.ok) {
      throw settledWork.settled.error;
    }
    await options.onComplete?.(settledWork.work.node, settledWork.settled.result);
    await yieldToBrowser();
  }

  reportDiagnostics();
  return getDiagnostics();
}

export function yieldToBrowser(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}
