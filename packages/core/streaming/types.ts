import type {
  CopcHierarchyNode,
  GeographicCamera,
  GeographicPoint,
} from "../copc/types/copc";
import type { RenderablePointData } from "../point/compactEPointCache";
import type {
  AdaptiveViewDistanceDiagnostics,
  BoundingSphere,
  ViewFrustum,
} from "./view";
import type { RefinementAlgorithm } from "./refinementStrategies";

export type {
  BoundingSphere,
  BoundingSphereInput,
  ViewFrustum,
  ViewVector3,
} from "./view";

/** Geographic node bounds used by view selection and hierarchy queries. */
export type BoundingBox = {
  /** Node bounds are geographic longitude/latitude/height, not local XYZ. */
  coordinateSystem: "wgs84-geographic";
  /** Minimum longitude in degrees. */
  minX: number;
  /** Minimum latitude in degrees. */
  minY: number;
  /** Minimum WGS84 ellipsoidal height in metres. */
  minZ: number;
  /** Maximum longitude in degrees. */
  maxX: number;
  /** Maximum latitude in degrees. */
  maxY: number;
  /** Maximum WGS84 ellipsoidal height in metres. */
  maxZ: number;
};

/**
 * Renderer-neutral perspective state consumed by hierarchy queries and node
 * selection. Engine adapters translate their camera representation into this
 * plain, serializable contract.
 */
export type StreamingView = GeographicCamera & {
  /** Approximate camera-to-visible-region distance in metres. */
  viewDistanceMeters: number;
  /** Optional camera frustum used for screen-space error and visibility tests. */
  viewFrustum?: ViewFrustum;
  /** Shared adaptive current-view estimate, when normalized by the core. */
  viewDistanceDiagnostics?: AdaptiveViewDistanceDiagnostics;
};

/** Backward-compatible name for the project-owned streaming view contract. */
export type StreamingCameraState = StreamingView;

/** Explicit core-facing aliases for engine adapters and future consumers. */
export type CopcStreamingView = StreamingView;
/** Alias emphasizing that the value is the current COPC camera state. */
export type CopcViewState = StreamingView;

/** Limits and thresholds used by the shared hierarchy node selector. */
export type StreamingSelectionOptions = {
  /** Upper bound for selected hierarchy nodes in the active view. */
  maxNodes: number;
  /** Deepest hierarchy level eligible for selection. */
  maxDepth: number;
  /** Refine while the estimated replacement error is greater than this. */
  maxScreenSpaceError?: number;
  /**
   * Half-width of the state-aware SSE hold band, in pixels. When omitted,
   * the selector derives a conservative band from maxScreenSpaceError.
   */
  screenSpaceErrorHysteresis?: number;
  /** @deprecated Planned for removal in v0.9, after v0.8; SSE no longer uses it. */
  refineDistanceMultiplier?: number;
  /** Maximum view distance from which nodes may be selected, in metres. */
  maxRenderDistanceMeters: number;
  /** Maximum estimated points allowed in the active current-view workload. */
  maxRenderedPoints?: number;
  /**
   * Maximum number of range/decode/preparation loads active at once. This is
   * independent of the rendered-point budget.
   */
  maxConcurrentNodeLoads?: number;
  /**
   * Named refinement relevance policy. Defaults to `foveated`; choose
   * `screen-projection` to retain the v0.5 passive gaze scoring.
   */
  refinementAlgorithm?: RefinementAlgorithm;
  /** Bias current visible-node refinement toward recent camera rotation; defaults to `true`. */
  motionLookahead?: boolean;
  /** Prepare a small bounded set of likely next-view nodes in the shared cache; defaults to `false`. */
  predictivePrefetch?: boolean;
  /** @deprecated Planned for removal in v0.9, after v0.8; use maxConcurrentNodeLoads. */
  maxPointsPerBatch?: number;
};

/** Prior-view and cache information used to keep selection stable and schedule work. */
export type StreamingSelectionContext = {
  /** Nodes accepted by the previous view, including LoD hysteresis state. */
  previousSelectedNodeKeys?: ReadonlySet<string>;
  /** Cache availability is a secondary optimization, never the main priority. */
  isNodeCached?: (nodeKey: string) => boolean;
};

/** Derived node shape used for renderer-neutral view selection and scheduling. */
export type StreamingHierarchyNode = {
  /** COPC hierarchy entry represented by this renderer-neutral node. */
  node: CopcHierarchyNode;
  /** Keys of direct child nodes currently known to the streaming hierarchy. */
  children: string[];
  /** True only when hierarchy loading proved that all query-relevant direct child topology is known. */
  childrenComplete?: boolean;
  /** Geographic center in WGS84 degrees and ellipsoidal metres. */
  center: GeographicPoint;
  /** Geographic node bounds; X/Y are longitude/latitude degrees and Z is metres. */
  bounds: BoundingBox;
  /** Approximate node extent used for view-distance calculations, in metres. */
  approximateSizeMeters: number;
  /** Conservative adapter-owned geometric error scale in metres. */
  geometricErrorMeters: number;
  /** Radius enclosing the node for view tests, in metres. */
  boundingRadiusMeters: number;
  /** Optional WGS84 ECEF sphere used for conservative frustum culling. */
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
  /** Optional manual focus-lens relevance used in refinement and scheduling. */
  focusWeight?: number;
};

/** Counts, point-cost estimates, and screen-space scores from one selection pass. */
export type StreamingSelectionMetrics = {
  /** Active shared-core strategy name for this selection pass. */
  refinementAlgorithm?: RefinementAlgorithm;
  /** Whether a runtime manual focus lens was enabled for this pass. */
  refinementFocusEnabled?: boolean;
  /** Whether current-view camera motion lookahead was enabled for this pass. */
  motionLookaheadEnabled?: boolean;
  /** Smoothed horizontal angular velocity toward screen-right, in degrees/second. */
  motionHorizontalAngularVelocityDegreesPerSecond?: number;
  /** Smoothed vertical angular velocity toward screen-up, in degrees/second. */
  motionVerticalAngularVelocityDegreesPerSecond?: number;
  /** Fixed camera lookahead horizon, in milliseconds. */
  motionHorizonMilliseconds?: number;
  /** Predicted horizontal camera displacement, in degrees. */
  motionPredictedHorizontalDisplacementDegrees?: number;
  /** Predicted vertical camera displacement, in degrees. */
  motionPredictedVerticalDisplacementDegrees?: number;
  /** Visible candidate nodes receiving nonzero camera-motion relevance. */
  motionCandidateCount?: number;
  /** Minimum and maximum camera-motion relevance observed among visible candidates. */
  motionWeightMin?: number;
  motionWeightMax?: number;
  /** Accepted atomic refinements whose decision or budget winner changed with motion relevance. */
  motionInfluencedRefinementCount?: number;
  /** Nodes considered before frustum and distance culling. */
  candidatesBeforeCulling: number;
  /** Candidates rejected by the camera frustum. */
  frustumCulledCount: number;
  /** Configured screen-space error threshold for this selection. */
  maxScreenSpaceError: number;
  /** Minimum raw screen-space error among measured candidates, in pixels. */
  screenSpaceErrorMin?: number;
  /** Maximum raw screen-space error among measured candidates, in pixels. */
  screenSpaceErrorMax?: number;
  /** Minimum screen-space error after refinement influence, in pixels. */
  effectiveScreenSpaceErrorMin?: number;
  /** Maximum screen-space error after refinement influence, in pixels. */
  effectiveScreenSpaceErrorMax?: number;
  /** Candidates whose children were accepted as a refinement. */
  refinedNodeCount: number;
  /** Nodes retained in the selected frontier. */
  keptNodeCount: number;
  /** Estimated point cost of the minimum coverage-preserving frontier before budget handling. */
  candidateSelectedPointCount: number;
  /** Estimated points in the returned frontier, bounded by the rendered-point budget. */
  budgetedPointCount: number;
  /** Configured point budget for the active current-view workload. */
  maxRenderedPoints: number;
  /** Nodes deferred by selection budgets or hierarchy readiness. */
  deferredNodeCount: number;
  /** Estimated points represented by deferred nodes. */
  deferredPointCount: number;
  /** Nodes dropped because the minimum frontier already exceeded a budget. */
  budgetDeferDropCount: number;
  /** Number of nodes in the coverage-preserving frontier after selection. */
  frontierNodeCount?: number;
  /** Estimated points in the coverage-preserving frontier after selection. */
  frontierPointCount?: number;
  /** Refinement decisions accepted after hierarchy and workload-budget checks. */
  acceptedRefinementCount?: number;
  /** Refinements rejected because accepting them would exceed the node budget. */
  refinementRejectedByNodeBudgetCount?: number;
  /** Refinements rejected because accepting them would exceed the point budget. */
  refinementRejectedByPointBudgetCount?: number;
  /** Refinements deferred because query-relevant child topology is incomplete. */
  refinementDeferredByIncompleteHierarchyCount?: number;
  /** Whether the minimum coverage frontier is larger than the configured node budget. */
  minimumFrontierExceedsNodeBudget?: boolean;
  /** Whether the minimum coverage frontier is larger than the configured point budget. */
  minimumFrontierExceedsPointBudget?: boolean;
  /** Lowest conservative screen-centre influence weight observed, in [0, 1]. */
  centerWeightMin?: number;
  /** Highest conservative screen-centre influence weight observed, in [0, 1]. */
  centerWeightMax?: number;
  /** Lowest refinement influence weight observed, in [0, 1]. */
  refinementCenterWeightMin?: number;
  /** Highest refinement influence weight observed, in [0, 1]. */
  refinementCenterWeightMax?: number;
  /** Lowest scheduling-only centre weight observed, in [0, 1]. */
  schedulingCenterWeightMin?: number;
  /** Highest scheduling-only centre weight observed, in [0, 1]. */
  schedulingCenterWeightMax?: number;
  /** Lowest bounded detail multiplier applied to refinement scores. */
  detailBiasMin?: number;
  /** Highest bounded detail multiplier applied to refinement scores. */
  detailBiasMax?: number;
  /** Candidates with any nonzero screen-centre influence. */
  candidatesWithNonZeroInfluenceCount?: number;
  /** Candidates whose projected node volume received manual focus weight. */
  focusCandidateCount?: number;
  /** Minimum and maximum manual focus relevance observed. */
  focusWeightMin?: number;
  focusWeightMax?: number;
  /** Accepted replacements whose threshold decision or budget priority changed
   * due to manual focus.
   */
  focusInfluencedRefinementCount?: number;
  /** Accepted refinements whose decision was affected by screen-centre influence. */
  acceptedGazeInfluencedRefinementCount?: number;
  /** Candidate influence values clamped to their configured safe bounds. */
  influenceClampCount?: number;
  /** Lowest priority score among accepted refinement candidates. */
  acceptedRefinementPriorityMin?: number;
  /** Highest priority score among accepted refinement candidates. */
  acceptedRefinementPriorityMax?: number;
  /** Lowest bounded refinement score among eligible candidates. */
  refinementPriorityMin?: number;
  /** Highest bounded refinement score among eligible candidates. */
  refinementPriorityMax?: number;
  /** Lowest scheduling score among eligible candidates. */
  schedulingPriorityMin?: number;
  /** Highest scheduling score among eligible candidates. */
  schedulingPriorityMax?: number;
  /** Candidates receiving a scheduling centre boost. */
  candidatesWithCenterBoostCount?: number;
  /** Decisions retained by the screen-space error hysteresis band. */
  hysteresisHoldCount?: number;
  /** Candidate decisions that refined to child nodes. */
  refineDecisionCount?: number;
  /** Candidate decisions that collapsed to a parent node. */
  collapseDecisionCount?: number;
};

/** Queue occupancy and scheduling-score ranges for node-load work. */
export type StreamingSchedulingDiagnostics = {
  /** Maximum node loads allowed concurrently for this streaming core. */
  maxConcurrentNodeLoads: number;
  /** Node loads waiting for a scheduler slot. */
  queuedNodeCount: number;
  /** Node loads currently active. */
  activeNodeCount: number;
  /** Queued loads classified as high priority. */
  queuedHighPriorityNodeCount: number;
  /** Active loads classified as high priority. */
  activeHighPriorityNodeCount: number;
  /** Node loads completed during the observed scheduler lifetime. */
  completedNodeCount: number;
  /** Node loads cancelled before completion. */
  cancelledNodeCount: number;
  /** Highest simultaneous active-load count observed. */
  peakActiveNodeCount: number;
  /** Lowest priority score among completed node loads in the latest snapshot. */
  completedSchedulingPriorityMin?: number;
  /** Highest priority score among completed node loads in the latest snapshot. */
  completedSchedulingPriorityMax?: number;
  /** Lowest priority score among currently pending node loads. */
  pendingSchedulingPriorityMin?: number;
  /** Highest priority score among currently pending node loads. */
  pendingSchedulingPriorityMax?: number;
};

/** Inclusive minimum and maximum hierarchy levels in a selection snapshot. */
export type StreamingLevelRange = {
  /** Lowest hierarchy level represented by the range. */
  min: number;
  /** Highest hierarchy level represented by the range. */
  max: number;
};

/** COPC node lookup keyed by each node's stable hierarchy key. */
export type StreamingHierarchy = Map<string, StreamingHierarchyNode>;

/** Reason a visible node set is being replaced. */
export type StreamingReplacementKind =
  /** Replace coarse coverage with a finer child frontier. */
  | "refinement"
  /** Replace fine coverage with a coarser parent frontier. */
  | "collapse"
  /** Replace nodes because the selected view or target frontier changed. */
  | "retarget";

/**
 * A logical visible-coverage transition. The old nodes remain valid coverage
 * until every new node has been prepared by the renderer.
 */
export type StreamingReplacementGroup = {
  /** Transition category used for diagnostics and commit handling. */
  kind: StreamingReplacementKind;
  /** Currently rendered nodes retained until the new coverage is ready. */
  oldNodeKeys: string[];
  /** Nodes that must be prepared before the old coverage can be removed. */
  newNodeKeys: string[];
};

/** Result of one renderer-neutral streaming update after node loading completes. */
export type StreamingUpdateResult = {
  /** Node keys selected for the view represented by this update. */
  selectedNodeKeys: string[];
  /** Previously rendered node keys no longer selected by this update. */
  removedNodeKeys: string[];
  /** Renderer-ready A or internal compact E values loaded for this update. */
  loadedNodePoints: Map<string, RenderablePointData>;
  /** Coverage groups that adapters should commit atomically when possible. */
  replacementGroups: StreamingReplacementGroup[];
  /** Generation token used to reject stale asynchronous work. */
  generation: number;
};

/** Incremental data emitted while a view's selected nodes are being prepared. */
export type StreamingProgress = {
  /** Node keys selected by the view update. */
  selectedNodeKeys: string[];
  /** Previously rendered nodes no longer needed by the view. */
  removedNodeKeys: string[];
  /** Renderer-ready A or internal compact E data available in this emission. */
  loadedNodePoints: Map<string, RenderablePointData>;
  /** Point count in the node work completed for this emission. */
  completedBatchPointCount: number;
  /** Coverage groups associated with the current transition. */
  replacementGroups: StreamingReplacementGroup[];
  /** Generation token used to ignore progress from superseded views. */
  generation: number;
};

/** Scheduler queue/active counts for one renderer-neutral view update. */
export type StreamingWorkProgress = {
  /** Node loads waiting for a bounded scheduler slot. */
  queuedNodeCount: number;
  /** Node loads currently consuming scheduler slots. */
  activeNodeCount: number;
};
