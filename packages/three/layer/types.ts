import type * as THREE from "three";
import type {
  CopcBackendName,
  CopcBackendSelection,
} from "../../core/copc/backend/selection";
import type { CopcWorkerDiagnostics } from "../../core/copc/backend/types";
import type { CopcPointInspection } from "../../core/copc/points/pointInspection";
import type { CopcColorMode } from "../../core/copc/points/fieldSelection";
import type {
  GeographicPointBuffer,
  PreparedPointData,
} from "../../core/copc/types/copc";
import type { RenderablePointData } from "../../core/point/compactEPointCache";
import type {
  CopcStreamingPerformanceSnapshot,
  PredictivePrefetchDiagnostics,
} from "../../core/streaming/CopcStreamingCore";
import type { StreamingSelectionOptions } from "../../core/streaming/types";
import type { NodePointCacheDiagnostics } from "../../core/streaming/createNodePointCache";
import type { AdaptiveViewDistanceDiagnostics } from "../../core/streaming/view";
import type { RangeValidationPolicy } from "../../core/copc/range/types";
import type { CopcInputSource } from "../../core/copc/range/types";
import type { CopcPointRenderer } from "../../core/streaming/renderer";
import type { DatasetLocalFrame } from "../../core/coordinates/types";
import type { GtxGeoidGrid } from "../../core/coordinates/transform/verticalGrid";
import type { ThreePointRendererOptions } from "../render/ThreePointRenderer";
import type { ThreeViewportSource } from "../view/ThreeViewAdapter";
import type { CopcThreeLayer } from "./CopcThreeLayer";

/** Configuration for a {@link CopcThreeLayer} and its shared streaming core. */
export type CopcThreeLayerOptions = {
  /** COPC URL, Blob/File, or random-access source. Ordinary LAS/LAZ files are unsupported. */
  url: CopcInputSource;
  /** Three.js point size in screen-facing pixels. Defaults to 3. */
  pointSize?: number;
  /** Point color mapping. Defaults to the fixed cyan fallback. */
  colorMode?: CopcColorMode;
  /** Retained point-coordinate layout. Defaults to compact E; choose A to retain exact Source and Geographic arrays. */
  coordinateCacheLayout?: "A" | "E";
  /** Manual additive correction in metres applied to ellipsoidal point height. Defaults to 0. */
  heightOffsetMeters?: number;
  /** Explicit user-loaded GTX grid; absent means no vertical datum conversion. */
  verticalTransform?: GtxGeoidGrid;
  /** Maximum estimated points in the active current-view workload; defaults to 250,000. Takes precedence over streaming.maxRenderedPoints. */
  maxRenderedPoints?: number;
  /** Overrides for shared streaming limits; top-level maxRenderedPoints takes precedence over this compatibility field. */
  streaming?: Partial<StreamingSelectionOptions>;
  /** Defaults to stable `copc-js`; `rust` is explicit opt-in. */
  backend?: CopcBackendSelection;
  /** Decoder used to convert point-data views into project point buffers. */
  decoder?: import("../../core/copc/points/types").CopcPointDecoder;
  /** Maximum retained decoded CPU point-buffer bytes; defaults to 256 MiB. */
  maxPointCacheBytes?: number;
  /** HTTP validation policy; defaults to `head-fallback`. Use `strict` to require readable Content-Range. */
  rangeValidation?: RangeValidationPolicy;
  /** Per-range byte ceiling. Defaults to 64 MiB; explicit values accept any positive safe integer. */
  maxRangeBytes?: number;
  /** Maximum active HTTP ranges per source. Defaults to 4; any positive safe integer is accepted. */
  maxConcurrentRangeRequests?: number;
  /** Emits layer/core lifecycle messages through console.debug. */
  debug?: boolean;
  /** Scene-unit threshold used by the default point raycaster. Defaults to 1. */
  pickingThreshold?: number;
  /** Optional renderer seam for tests or a compatible Three renderer. */
  renderer?: CopcThreePointRenderer;
  /** Called when a point is selected or selection is cleared. */
  onPointPicked?: (point: CopcPointInspection | undefined) => void;
};

/** Caller-owned Three.js objects used to attach and update a layer. */
export type CopcThreeLayerAttachment = {
  /** Application-owned Three scene. */
  scene: THREE.Scene;
  /** Application-owned camera whose local coordinates use the layer frame. */
  camera: THREE.Camera;
  /** Application-owned renderer, used only to read the drawing-buffer size. */
  renderer?: ThreeViewportSource;
};

/** Public lifecycle states reported in {@link CopcThreeLayerSnapshot}. */
export type CopcThreeLayerLifecycleState =
  /** Constructed but not attached or loading. */
  | "idle"
  /** Attached to a scene without loaded metadata. */
  | "mounted"
  /** Metadata and root hierarchy load is in progress. */
  | "loading"
  /** Metadata and root hierarchy are available; point nodes stream per view. */
  | "ready"
  /** Permanently destroyed; only repeated `destroy()` calls are harmless. */
  | "destroyed";

/** Counts describing visible-node replacement transitions. */
export type CopcThreeLayerTransitionDiagnostics = {
  /** Replacement groups currently awaiting completion. */
  activeReplacementGroupCount: number;
  /** Replacement groups waiting for required new nodes to be prepared. */
  replacementGroupsWaitingCount: number;
  /** Refinement groups whose new coverage was committed. */
  refinementReplacementCommitCount: number;
  /** Collapse groups whose new coverage was committed. */
  collapseReplacementCommitCount: number;
  /** Replacement work cancelled because its view became stale. */
  staleReplacementCancellationCount: number;
  /** Coarse nodes retained to preserve coverage during replacement. */
  coarseNodesRetainedForCoverageCount: number;
};

/** Wall-clock durations measured by the default Three point renderer, in milliseconds. */
export type CopcThreeRendererPerformanceSnapshot = {
  /** Time to transform point positions from shared world coordinates to the dataset frame. */
  worldToLocalDurationMs: number;
  /** Time to create node geometry. */
  geometryCreationDurationMs: number;
  /** Time to create or update node materials. */
  materialCreationDurationMs: number;
  /** Total renderer preparation time for node changes. */
  rendererPreparationDurationMs: number;
  /** Time spent removing renderer nodes. */
  nodeRemovalDurationMs: number;
};

/** Read-only snapshot of current layer, streaming, cache, and renderer state. */
export type CopcThreeLayerSnapshot = {
  /** Current lifecycle state. */
  lifecycle: CopcThreeLayerLifecycleState;
  /** Whether caller-owned scene/camera integration is currently attached. */
  attached: boolean;
  /** Configured COPC resource URL supplied to the layer. */
  datasetUrl: string;
  /** Built-in backend name or `custom` for a supplied backend object. */
  backend: CopcBackendName | "custom";
  /** Hierarchy nodes selected for the current streaming view. */
  selectedNodeKeys: string[];
  /** Nodes currently committed to the renderer. */
  renderedNodeKeys: string[];
  /** Total number of points currently committed to the renderer. */
  renderedPointCount: number;
  /** Number of streaming updates started, including active incremental progress. */
  streamingUpdateCount: number;
  /** Shared-core range, decode, and point-preparation performance measurements. */
  performance: CopcStreamingPerformanceSnapshot;
  /** Default renderer preparation and removal durations in milliseconds. */
  renderer: CopcThreeRendererPerformanceSnapshot;
  /** Visible-node coverage transition counters. */
  transition: CopcThreeLayerTransitionDiagnostics;
  /** Adaptive view-distance estimate, when a camera view has been observed. */
  viewDistance?: AdaptiveViewDistanceDiagnostics;
  /** Hierarchy request and page-cache counters, after source initialization. */
  hierarchy?: import("../../core/copc/hierarchy/types").CopcHierarchyDiagnostics;
  /** Decoded CPU point-buffer cache counters and retained bytes. */
  pointCache: NodePointCacheDiagnostics;
  /** Rust/WASM worker queue counters, when that backend exposes them. */
  worker?: CopcWorkerDiagnostics;
  /** Bounded speculative preparation counters when enabled. */
  predictivePrefetch?: PredictivePrefetchDiagnostics;
};

/** Pointer location in Three.js normalized device coordinates. */
export type CopcThreeLayerPickPosition = {
  /** Horizontal normalized device coordinate, passed unchanged to Raycaster. */
  x: number;
  /** Vertical normalized device coordinate, passed unchanged to Raycaster. */
  y: number;
};

/** Optional raycaster and point-distance threshold used for one pick. */
export type CopcThreeLayerPickOptions = {
  /** Caller-owned raycaster; its point threshold and ray are updated by `pick`. */
  raycaster?: THREE.Raycaster;
  /** Positive finite distance threshold in Three.js scene units; defaults to the layer setting or 1. */
  threshold?: number;
};

/** Renderer seam required by {@link CopcThreeLayer}; implementations own their created GPU resources. */
export interface CopcThreePointRenderer extends CopcPointRenderer {
  /** Attach the renderer-owned root group to a caller-owned scene. */
  attachTo(scene: THREE.Scene): void;
  /** Remove the root group from its current scene without disposing the scene. */
  detachFrom(): void;
  /** Return the renderer-owned root group for picking or application composition. */
  getRoot(): THREE.Group;
  /** Prepare or replace one node's renderable points using the layer's fixed local frame. */
  addOrUpdateNode(
    nodeKey: string,
    points: GeographicPointBuffer | PreparedPointData | RenderablePointData,
    options: ThreePointRendererOptions,
  ): void;
  /** Install the dataset frame before adding local point geometry, when supported. */
  setLocalFrame?(frame: DatasetLocalFrame): void;
}
