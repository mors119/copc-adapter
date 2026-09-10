import type {
  CopcHierarchyNode,
  GeographicCamera,
  GeographicPoint,
  PreparedPointData,
} from '../../copc/types/copc';
import type { BoundingSphere, ViewFrustum } from './view';

export type {
  BoundingSphere,
  BoundingSphereInput,
  ViewFrustum,
  ViewVector3,
} from './view';

export type BoundingBox = {
  /** Node bounds are geographic longitude/latitude/height, not local XYZ. */
  coordinateSystem: 'wgs84-geographic';
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

/**
 * Renderer-neutral perspective state consumed by hierarchy queries and node
 * selection. Engine adapters translate their camera representation into this
 * plain, serializable contract.
 */
export type StreamingView = GeographicCamera & {
  viewDistanceMeters: number;
  viewFrustum?: ViewFrustum;
};

/** Backward-compatible name for the project-owned streaming view contract. */
export type StreamingCameraState = StreamingView;

/** Explicit core-facing aliases for engine adapters and future consumers. */
export type CopcStreamingView = StreamingView;
export type CopcViewState = StreamingView;

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
  /**
   * Maximum number of range/decode/preparation loads active at once. This is
   * independent of the rendered-point budget.
   */
  maxConcurrentNodeLoads?: number;
  /** @deprecated Retained for source compatibility; use maxConcurrentNodeLoads. */
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

/**
 * A selected node with the priority computed by the renderer-neutral
 * selector. The hierarchy-node shape is preserved so existing consumers can
 * continue to read `node.node`, while downstream work can keep the exact
 * visual priority that produced the frontier order.
 */
export type StreamingSelectedNode = StreamingHierarchyNode & {
  /** Bounded SSE score used for refinement and coverage decisions. */
  refinementPriority: number;
  /** Bounded SSE score with the sharper scheduling centre relevance applied. */
  schedulingPriority: number;
  /** Deterministic work-order alias retained for existing consumers. */
  priority: number;
  /** Raw screen-space error before bounded visual influence is applied. */
  rawScreenSpaceError: number;
  /** Screen-space error after bounded refinement influence is applied. */
  effectiveScreenSpaceError: number;
  /** Conservative bounded screen-centre influence used by refinement, in [0, 1]. */
  centerWeight: number;
  /** Sharper bounded screen-centre relevance used only for scheduling, in [0, 1]. */
  schedulingCenterWeight: number;
};

export type StreamingSelectionMetrics = {
  candidatesBeforeCulling: number;
  frustumCulledCount: number;
  maxScreenSpaceError: number;
  screenSpaceErrorMin?: number;
  screenSpaceErrorMax?: number;
  effectiveScreenSpaceErrorMin?: number;
  effectiveScreenSpaceErrorMax?: number;
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
  /** Explicit names for the conservative refinement influence range. */
  refinementCenterWeightMin?: number;
  refinementCenterWeightMax?: number;
  schedulingCenterWeightMin?: number;
  schedulingCenterWeightMax?: number;
  detailBiasMin?: number;
  detailBiasMax?: number;
  candidatesWithNonZeroInfluenceCount?: number;
  acceptedGazeInfluencedRefinementCount?: number;
  influenceClampCount?: number;
  acceptedRefinementPriorityMin?: number;
  acceptedRefinementPriorityMax?: number;
  refinementPriorityMin?: number;
  refinementPriorityMax?: number;
  schedulingPriorityMin?: number;
  schedulingPriorityMax?: number;
  candidatesWithCenterBoostCount?: number;
  hysteresisHoldCount?: number;
  refineDecisionCount?: number;
  collapseDecisionCount?: number;
};

export type StreamingSchedulingDiagnostics = {
  maxConcurrentNodeLoads: number;
  queuedNodeCount: number;
  activeNodeCount: number;
  queuedHighPriorityNodeCount: number;
  activeHighPriorityNodeCount: number;
  completedNodeCount: number;
  cancelledNodeCount: number;
  peakActiveNodeCount: number;
  completedSchedulingPriorityMin?: number;
  completedSchedulingPriorityMax?: number;
  pendingSchedulingPriorityMin?: number;
  pendingSchedulingPriorityMax?: number;
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
  /** Prepared values are shared by the cache and renderer adapters. */
  loadedNodePoints: Map<string, PreparedPointData>;
  replacementGroups: StreamingReplacementGroup[];
  generation: number;
};

export type StreamingProgress = {
  selectedNodeKeys: string[];
  removedNodeKeys: string[];
  /** Prepared values are shared by the cache and renderer adapters. */
  loadedNodePoints: Map<string, PreparedPointData>;
  completedBatchPointCount: number;
  replacementGroups: StreamingReplacementGroup[];
  generation: number;
};
