import * as Cesium from "cesium";
import {
  CesiumLayerController,
  type CopcLayerSnapshot,
} from "./CesiumLayerController";
import type { CopcMetadata } from "../../core/copc/types/copc";
import type { CopcCesiumEvent } from "./cesiumLayerEvents";
import type {
  CopcLayerErrorEvent,
  CopcViewCancellationReason,
} from "../../core/events/layerEventLifecycle";
import type {
  CopcColorMode,
  CopcPointFieldSelection,
} from "../../core/copc/points/fieldSelection";
import type { CopcBackendSelection } from "../../core/copc/backend/selection";
import type { CopcPointDecoder } from "../../core/copc/points/types";
import type { CopcHierarchyDiagnostics } from "../../core/copc/hierarchy/types";
import type { CesiumPointRenderer } from "../render/CopcPointRenderer";
import type { CopcCesiumPointSizeMode } from "../render/CopcPointRenderer";
import type { CopcPointInspection } from "../../core/copc/points/pointInspection";
import type { RangeValidationPolicy } from "../../core/copc/range/types";
import type { CopcInputSource } from "../../core/copc/range/types";
import type { CopcDimensionFilter, CopcDimensionStyle } from "../../core/point/style/pointStyle";
import type { GtxGeoidGrid } from "../../core/coordinates/transform/verticalGrid";
import type {
  TerrainHeightAlignmentEstimate,
  TerrainHeightAlignmentOptions,
} from "../terrain/terrainHeightAlignment";
import type { NodePointCacheDiagnostics } from "../../core/streaming/createNodePointCache";
import type {
  CopcPointQuery,
  CopcPointQueryOptions,
} from "../../core/streaming/spatialPointQuery";
import type {
  RefinementAlgorithm,
  RefinementFocus,
} from "../../core/streaming/refinementStrategies";
import type {
  CopcCesiumPointStyle,
  CopcCesiumPointStyleUpdate,
} from "../style/CesiumPointStyle";

export type {
  CopcCesiumPointStyle,
  CopcCesiumPointStyleUpdate,
  CopcClassificationFilter,
} from "../style/CesiumPointStyle";
export type {
  TerrainHeightAlignmentEstimate,
  TerrainHeightAlignmentOptions,
  TerrainHeightAlignmentStatus,
} from "../terrain/terrainHeightAlignment";

export type { CopcColorMode } from "../../core/copc/points/fieldSelection";

/** Selection and workload limits applied while choosing nodes for each view. */
export type CopcStreamingOptions = {
  /** Maximum number of nodes in the selected frontier; defaults to 24. */
  maxNodes?: number;
  /** Deepest hierarchy level considered; defaults to 6. */
  maxDepth?: number;
  /** Refine nodes whose estimated screen-space error exceeds this pixel threshold; defaults to 8 pixels. */
  maxScreenSpaceError?: number;
  /** Half-width of the state-aware SSE hold band in pixels; defaults to 12.5% of the error threshold. */
  screenSpaceErrorHysteresis?: number;
  /** @deprecated Planned for removal in v0.9, after v0.8; has no effect. Use maxScreenSpaceError. */
  refineDistanceMultiplier?: number;
  /** Maximum camera-to-node selection distance in metres; defaults to 12,000. */
  maxRenderDistanceMeters?: number;
  /** Compatibility location for the 250,000-point default budget; the top-level value takes precedence. */
  maxRenderedPoints?: number;
  /** Maximum concurrent range/decode/preparation node loads; defaults to 4. */
  maxConcurrentNodeLoads?: number;
  /**
   * Refinement relevance policy. Defaults to `foveated`; use
   * `screen-projection` to retain the v0.5 passive gaze scoring.
   */
  refinementAlgorithm?: RefinementAlgorithm;
  /**
   * Bias refinement among currently visible nodes toward recent camera
   * rotation. Defaults to `true`; set `false` to preserve stationary-era
   * refinement priorities during camera movement as well.
   */
  motionLookahead?: boolean;
  /** Speculatively prepare a small bounded set of likely next-view nodes; defaults to `false`. */
  predictivePrefetch?: boolean;
};

/** Options for a reusable Cesium layer backed by a URL, Blob/File, or random-access byte source. */
export type CopcCesiumLayerOptions = {
  /** COPC source. Blob/File inputs are read incrementally; ordinary LAS/LAZ files are unsupported. */
  url: CopcInputSource;
  /** Cesium point primitive size in pixels. Defaults to 3. */
  pointSize?: number;
  /** Uniform per-layer alpha in [0, 1]. Omitted preserves the selected renderer's current appearance. */
  opacity?: number;
  /**
   * Point-size calculation mode. Defaults to `fixed` for compatibility.
   * `attenuated` needs a renderer with shader support, such as
   * `BatchedGeometryPointRenderer`; other renderers keep the fixed-size path.
   */
  pointSizeMode?: CopcCesiumPointSizeMode;
  /** Minimum point diameter in CSS pixels for `attenuated` mode. Defaults to 1. */
  minPointSize?: number;
  /** Maximum point diameter in CSS pixels for `attenuated` mode. Defaults to 12 and cannot exceed 64. */
  maxPointSize?: number;
  /** Point color mapping. Defaults to the backward-compatible fixed cyan. */
  colorMode?: CopcColorMode;
  /**
   * Standard LAS attributes to retain. Defaults to `all` for synchronous
   * runtime restyling. `required` keeps initial color-mode fields, classification
   * for an initial filter, and any fields in `pointFields`.
   */
  attributeLoading?: "all" | "required";
  /** Optional classification filter applied from the first rendered view. */
  classificationFilter?: CopcCesiumPointStyle["classificationFilter"];
  /** Numeric dimension ramp used with `colorMode: 'dimension'`. */
  dimension?: CopcDimensionStyle;
  /** Inclusive numeric range visibility filter applied from the first view. */
  dimensionFilter?: CopcDimensionFilter;
  /** Extra Bytes dimensions to retain for styling or point inspection. */
  extraDimensions?: readonly string[];
  /**
   * Additional standard LAS fields to retain explicitly, including in
   * `required` mode. Extra schema dimensions are configured separately.
   */
  pointFields?: CopcPointFieldSelection;
  /** Retained point-coordinate layout. Defaults to compact E; choose A to retain exact Source and Geographic arrays. */
  coordinateCacheLayout?: "A" | "E";
  /** Keep exact source XYZ in compact E cache entries for cache-only queries. Defaults to `false` and adds 24 bytes per cached point. */
  retainSourceCoordinatesForQueries?: boolean;
  /** Manual additive correction in metres applied to ellipsoidal point height. Defaults to 0. */
  heightOffsetMeters?: number;
  /** Explicit user-loaded GTX grid. Omitted keeps the existing no-conversion behavior. */
  verticalTransform?: GtxGeoidGrid;
  /** Emits COPC layer lifecycle messages through console.debug. */
  debug?: boolean;
  /** Maximum estimated points in the active current-view workload; defaults to 250,000. Takes precedence over streaming.maxRenderedPoints. */
  maxRenderedPoints?: number;
  /** Overrides for the default streaming selection limits and refinement strategy. */
  streaming?: CopcStreamingOptions;
  /** Defaults to stable `copc-js`; `rust` is explicit opt-in. */
  backend?: CopcBackendSelection;
  /** Decoder used to convert point-data views into project point buffers. */
  decoder?: CopcPointDecoder;
  /** Optional Cesium renderer implementation; defaults to Cesium point primitives. */
  renderer?: CesiumPointRenderer;
  /** Called when a rendered COPC point is selected or selection is cleared. */
  onPointPicked?: (point: CopcPointInspection | undefined) => void;
  /** Maximum retained decoded CPU point-buffer bytes. Defaults to 256 MiB. */
  maxPointCacheBytes?: number;
  /** HTTP validation policy; defaults to `head-fallback`. Use `strict` to require readable Content-Range. */
  rangeValidation?: RangeValidationPolicy;
  /** Per-range byte ceiling. Defaults to 64 MiB; explicit values accept any positive safe integer. */
  maxRangeBytes?: number;
  /** Maximum active HTTP ranges per source. Defaults to 4; any positive safe integer is accepted. */
  maxConcurrentRangeRequests?: number;
};
/** Read-only snapshot of Cesium layer lifecycle, rendering, streaming, and cache state. */
export type CopcCesiumLayerSnapshot = CopcLayerSnapshot;
export type { CopcLayerErrorEvent, CopcViewCancellationReason };
export type { RefinementAlgorithm, RefinementFocus };

/**
 * A reusable, view-driven COPC streaming layer for a caller-owned Cesium Viewer.
 *
 * `load()` reads metadata and the root hierarchy; point data is fetched only
 * for selected camera views. Loading may happen before attachment. The layer
 * owns its primitives and event listeners, but never destroys the supplied
 * Viewer. Attaching or loading into an attached Viewer may fly the camera to
 * the metadata extent.
 *
 * @example
 * ```ts
 * const layer = new CopcCesiumLayer({ url: '/data/area.copc.laz' });
 * layer.attachTo(viewer);
 * await layer.load();
 * ```
 */
export class CopcCesiumLayer {
  private readonly controller: CesiumLayerController;

  /** Create an unloaded layer configured for a COPC resource. */
  constructor(options: CopcCesiumLayerOptions) {
    this.controller = new CesiumLayerController(options);
  }

  /** Native Cesium event carrying queued count, active count, and view generation. */
  get loadProgress(): CopcCesiumEvent<[number, number, number]> {
    return this.controller.loadProgress;
  }

  /** Fires with a metadata snapshot and load generation after metadata and the root hierarchy are ready. */
  get metadataReady(): CopcCesiumEvent<[CopcMetadata, number]> {
    return this.controller.metadataReady;
  }

  /** Fires once per load after the first nonempty selected node is committed, with load and view generations. */
  get firstVisible(): CopcCesiumEvent<[number, number]> {
    return this.controller.firstVisible;
  }

  /** Fires with the settled view generation and selected node keys after renderer commitment. */
  get viewSettled(): CopcCesiumEvent<[number, readonly string[]]> {
    return this.controller.viewSettled;
  }

  /** Fires with the invalidated view generation and cancellation reason. */
  get viewCancelled(): CopcCesiumEvent<[number, CopcViewCancellationReason]> {
    return this.controller.viewCancelled;
  }

  /** Fires with a structured load or view error; view failures are reported asynchronously. */
  get error(): CopcCesiumEvent<[CopcLayerErrorEvent]> {
    return this.controller.error;
  }

  /** Return a clone of the full metadata extent in WGS84 ECEF metres, when supported. */
  get boundingSphere(): Cesium.BoundingSphere | undefined {
    return this.controller.boundingSphere;
  }

  /**
   * Fly the attached Viewer camera to the metadata extent.
   *
   * @param offset Optional Cesium heading/pitch in radians and range in metres.
   * @returns `true` when the flight completes and `false` when Cesium cancels it.
   * @throws Rejects if the layer/viewer is unavailable, the scene is morphing, or no supported extent exists.
   */
  zoomTo(offset?: Cesium.HeadingPitchRange): Promise<boolean> {
    return this.controller.zoomTo(offset);
  }

  /**
   * Set or clear the optional runtime screen-circle focus lens.
   *
   * Coordinates are normalized to the viewer canvas (`x` left→right, `y`
   * top→bottom). `radius` is a fraction of the smaller drawing-buffer
   * dimension, and `detailBias` bounds refinement pressure from 1× to 2×.
   * The lens prioritizes node detail; it does not clip points or bypass
   * selection budgets. Clearing it restores the chosen strategy's automatic
   * center relevance. Focus updates reuse source, hierarchy, and point cache.
   *
   * @param focus Screen-circle focus, or `undefined` to clear it.
   * @throws `TypeError` or `RangeError` if any supplied value is invalid.
   */
  setRefinementFocus(focus: RefinementFocus | undefined): void {
    this.controller.setRefinementFocus(focus);
  }

  /**
   * Attach layer-owned primitives and camera listeners to a caller-owned Viewer.
   *
   * If data is already loaded, attachment starts view streaming and flies to
   * the dataset extent. The layer does not take ownership of the Viewer.
   *
   * @throws If the layer has been destroyed.
   */
  attachTo(viewer: Cesium.Viewer): void {
    this.controller.attachTo(viewer);
  }

  /** Whether this layer's Cesium primitives are visible; defaults to `true`. */
  get show(): boolean {
    return this.controller.show;
  }

  /** Set primitive visibility; changing this does not unload cached point data. */
  set show(value: boolean) {
    this.controller.show = value;
  }

  /** Detach primitives and camera/picking listeners without unloading COPC metadata or cached source data. */
  detachFrom(): void {
    this.controller.detachFrom();
  }

  /**
   * Load source metadata and the root hierarchy from the configured COPC URL.
   *
   * Point nodes are streamed later for camera views. If attached, loading also
   * flies to the dataset extent and waits for the initial view update; without
   * a Viewer it resolves when the metadata and root hierarchy are ready.
   *
   * @throws `CopcLoadError` when source, metadata/CRS, or hierarchy initialization fails.
   */
  async load(): Promise<void> {
    await this.controller.load();
  }

  /** Release loaded source data, cached points, and rendered primitives; the Viewer attachment remains. */
  unload(): void {
    this.controller.unload();
  }

  /** Unload current state and load the configured COPC URL again. */
  async reload(): Promise<void> {
    await this.controller.reload();
  }

  /** Permanently release layer-owned resources and listeners without destroying the Cesium Viewer. */
  destroy(): void {
    this.controller.destroy();
  }

  /** Return a fresh state snapshot suitable for application diagnostics. */
  getSnapshot(): CopcCesiumLayerSnapshot {
    return this.controller.getSnapshot();
  }

  /** Return loaded COPC metadata, or `undefined` before loading or after unloading. */
  getMetadata(): CopcMetadata | undefined {
    return this.controller.getMetadata();
  }

  /**
   * Stream source XYZ points from an inclusive source-coordinate AABB.
   * Querying does not move the camera or change the layer's rendered selection.
   *
   * @param options Explicit query mode, maximum depth, region, and finite resource budgets.
   * @returns One-shot batches and a terminal status promise.
   * @throws If the layer is not loaded or the region/limits are invalid.
   */
  queryPoints(options: CopcPointQueryOptions): CopcPointQuery {
    return this.controller.queryPoints(options);
  }

  /** Return hierarchy page-request/cache counters after the source has opened. */
  getHierarchyDiagnostics(): CopcHierarchyDiagnostics | undefined {
    return this.controller.getHierarchyDiagnostics();
  }

  /** Return decoded CPU point-buffer cache counters and retained bytes. */
  getPointCacheDiagnostics(): NodePointCacheDiagnostics {
    return this.controller.getPointCacheDiagnostics();
  }

  /** Return the selected point while its rendered node and decoded buffer remain live. */
  getSelectedPoint(): CopcPointInspection | undefined {
    return this.controller.getSelectedPoint();
  }

  /**
   * Explicitly compare a selected COPC ground point with the attached Viewer's
   * current real Terrain provider. This returns a proposal only; geometry is
   * never changed by estimation or preview.
   */
  estimateTerrainHeightAlignment(
    anchor: CopcPointInspection,
    options?: TerrainHeightAlignmentOptions,
  ): Promise<TerrainHeightAlignmentEstimate> {
    return this.controller.estimateTerrainHeightAlignment(anchor, options);
  }

  /** Return whether an estimate still belongs to this live layer selection. */
  isTerrainHeightAlignmentEstimateCurrent(
    estimate: TerrainHeightAlignmentEstimate,
  ): boolean {
    return this.controller.isTerrainHeightAlignmentEstimateCurrent(estimate);
  }

  /** Return the current runtime color mode and classification filter. */
  getStyle(): CopcCesiumPointStyle {
    return this.controller.getStyle();
  }

  /**
   * Update point colors and classification visibility from retained point data.
   *
   * This restyles the current renderer contents without issuing metadata,
   * hierarchy, or point-chunk requests. A later streamed node uses the same
   * current style.
   */
  setStyle(style: CopcCesiumPointStyleUpdate): void {
    this.controller.setStyle(style);
  }

  /**
   * Set uniform alpha for this layer and future streamed nodes without reading or decoding COPC data.
   *
   * @param opacity Finite alpha in the inclusive range `[0, 1]`.
   * @throws If the value is invalid, the layer is destroyed, or the custom renderer does not support opacity.
   */
  setOpacity(opacity: number): void {
    this.controller.setOpacity(opacity);
  }
}
