import type {
  CopcHierarchyNode,
  GeographicCamera,
  GeographicPoint,
  GeographicPointBuffer,
} from '../../copc/types/copc';
import type { BoundingSphere, ViewFrustum } from './view';

export type { BoundingSphere, ViewFrustum, ViewVector3 } from './view';

export type BoundingBox = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

export type StreamingCameraState = GeographicCamera & {
  viewDistanceMeters: number;
  viewFrustum?: ViewFrustum;
};

export type StreamingSelectionOptions = {
  maxNodes: number;
  maxDepth: number;
  /** Refine while the estimated replacement error is greater than this. */
  maxScreenSpaceError?: number;
  /**
   * Half-width of the state-aware SSE hold band, in pixels. When omitted,
   * the selector derives a conservative band from maxScreenSpaceError.
   */
  screenSpaceErrorHysteresis?: number;
  /** @deprecated Retained for source compatibility; SSE no longer uses it. */
  refineDistanceMultiplier?: number;
  maxRenderDistanceMeters: number;
  /** Maximum estimated points allowed in the active current-view workload. */
  maxRenderedPoints?: number;
  /** Internal release-safety bound; this is not a rendered-point API. */
  maxPointsPerBatch?: number;
};

export type StreamingSelectionContext = {
  /** Nodes accepted by the previous view, including LoD hysteresis state. */
  previousSelectedNodeKeys?: ReadonlySet<string>;
  /** Cache availability is a secondary optimization, never the main priority. */
  isNodeCached?: (nodeKey: string) => boolean;
};

export type StreamingHierarchyNode = {
  node: CopcHierarchyNode;
  children: string[];
  /** True only when hierarchy loading proved that all query-relevant direct child topology is known. */
  childrenComplete?: boolean;
  center: GeographicPoint;
  bounds: BoundingBox;
  approximateSizeMeters: number;
  /** Conservative adapter-owned geometric error scale in metres. */
  geometricErrorMeters: number;
  boundingRadiusMeters: number;
  boundingSphere?: BoundingSphere;
};

export type StreamingSelectionMetrics = {
  candidatesBeforeCulling: number;
  frustumCulledCount: number;
  maxScreenSpaceError: number;
  screenSpaceErrorMin?: number;
  screenSpaceErrorMax?: number;
  refinedNodeCount: number;
  keptNodeCount: number;
  /** Estimated points in the minimum coarse frontier before impossible-budget handling. */
  candidateSelectedPointCount: number;
  /** Estimated points in the returned frontier, bounded by the rendered-point budget. */
  budgetedPointCount: number;
  maxRenderedPoints: number;
  deferredNodeCount: number;
  deferredPointCount: number;
  budgetDeferDropCount: number;
  /** Number and estimated point cost of the settled selected frontier. */
  frontierNodeCount?: number;
  frontierPointCount?: number;
  acceptedRefinementCount?: number;
  refinementRejectedByNodeBudgetCount?: number;
  refinementRejectedByPointBudgetCount?: number;
  refinementDeferredByIncompleteHierarchyCount?: number;
  minimumFrontierExceedsNodeBudget?: boolean;
  minimumFrontierExceedsPointBudget?: boolean;
  centerWeightMin?: number;
  centerWeightMax?: number;
  acceptedRefinementPriorityMin?: number;
  acceptedRefinementPriorityMax?: number;
  candidatesWithCenterBoostCount?: number;
  hysteresisHoldCount?: number;
  refineDecisionCount?: number;
  collapseDecisionCount?: number;
};

export type StreamingLevelRange = {
  min: number;
  max: number;
};

export type StreamingHierarchy = Map<string, StreamingHierarchyNode>;

export type StreamingReplacementKind = 'refinement' | 'collapse' | 'retarget';

/**
 * A logical visible-coverage transition. The old nodes remain valid coverage
 * until every new node has been prepared by the renderer.
 */
export type StreamingReplacementGroup = {
  kind: StreamingReplacementKind;
  oldNodeKeys: string[];
  newNodeKeys: string[];
};

export type StreamingUpdateResult = {
  selectedNodeKeys: string[];
  removedNodeKeys: string[];
  loadedNodePoints: Map<string, GeographicPointBuffer>;
  replacementGroups: StreamingReplacementGroup[];
  generation: number;
};

export type StreamingProgress = {
  selectedNodeKeys: string[];
  removedNodeKeys: string[];
  loadedNodePoints: Map<string, GeographicPointBuffer>;
  completedBatchPointCount: number;
  replacementGroups: StreamingReplacementGroup[];
  generation: number;
};
