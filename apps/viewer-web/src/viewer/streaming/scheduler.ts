import type { StreamingHierarchyNode } from './types';

export type StreamingWorkBatch = {
  nodes: StreamingHierarchyNode[];
  estimatedPointCount: number;
};

/** Partition prioritised work before range/decode work starts. */
export function createStreamingWorkBatches(
  nodes: readonly StreamingHierarchyNode[],
  maxPointsPerBatch: number,
): StreamingWorkBatch[] {
  const boundedPointLimit = Number.isFinite(maxPointsPerBatch) && maxPointsPerBatch > 0
    ? maxPointsPerBatch
    : Number.POSITIVE_INFINITY;
  const batches: StreamingWorkBatch[] = [];
  let currentNodes: StreamingHierarchyNode[] = [];
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

export function yieldToBrowser(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}
