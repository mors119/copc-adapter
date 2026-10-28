import * as Cesium from "cesium";
import {
  PointPrimitiveRenderer,
  type CesiumPointRenderer,
  type CopcCesiumPointRendererOptions,
} from "../render/CopcPointRenderer";
import {
  DEFAULT_MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS,
  DEFAULT_MIN_ATTENUATED_POINT_SIZE_CSS_PIXELS,
  MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS,
} from "../render/projectedPointSize";
import { deriveNodePointSpacingMeters } from "../render/pointSpacing";
import { createCesiumStreamingView } from "../view/CesiumViewAdapter";
import { createMetadataBoundingSphere } from "../geometry/metadataBoundingSphere";
import { CesiumPointPicker } from "../picking/CesiumPointPicker";
import { CopcCesiumEvent } from "./cesiumLayerEvents";
import {
  CopcLayerEventLifecycle,
  type CopcLayerErrorEvent,
  type CopcViewCancellationReason,
  snapshotCopcError,
  snapshotCopcMetadata,
} from "../../core/events/layerEventLifecycle";
import {
  allCopcPointFields,
  createCopcPointFieldSelection,
  getCopcPointFieldSelection,
  type CopcColorMode,
  type CopcPointField,
  type CopcPointFieldSelection,
} from "../../core/copc/points/fieldSelection";
import type {
  CopcBackendName,
  CopcBackendSelection,
} from "../../core/copc/backend/selection";
import type { CopcWorkerDiagnostics } from "../../core/copc/backend/types";
import {
  inspectCopcPoint,
  type CopcPointInspection,
} from "../../core/copc/points/pointInspection";
import type { CopcMetadata } from "../../core/copc/types/copc";
import type { GtxGeoidGrid } from "../../core/coordinates/transform/verticalGrid";
import {
  createUnavailableTerrainHeightAlignmentEstimate,
  estimateTerrainHeightAlignment as estimateTerrainHeightAlignmentForViewer,
  type TerrainHeightAlignmentEstimate,
  type TerrainHeightAlignmentOptions,
} from "../terrain/terrainHeightAlignment";
import { extractHorizontalUnitScale } from "../../core/coordinates/crs/parseCopcWkt";
import { createPointTransformer } from "../../core/coordinates/transform/createPointTransformer";
import {
  createCopcPointStyleState,
  getDatasetElevationRange,
} from "../../core/point/style/pointStyle";
import {
  createLayerStreamingCore,
  getCachedRenderablePointDataForAdapter,
  type CopcStreamingPerformanceSnapshot,
  type PredictivePrefetchDiagnostics,
  type CopcStreamingProgressHandler,
  type CopcStreamingWorkProgressHandler,
} from "../../core/streaming/CopcStreamingCore";
import { areStreamingViewsEquivalent } from "../../core/streaming/areStreamingViewsEquivalent";
import { ReplacementTransitionManager } from "../../core/streaming/ReplacementTransitionManager";
import type {
  StreamingProgress,
  StreamingSelectionOptions,
} from "../../core/streaming/types";
import type { RenderablePointData } from "../../core/point/compactEPointCache";
import { DEFAULT_MAX_RENDERED_POINTS } from "../../core/streaming/NodeSelector";
import {
  normalizeRefinementFocus,
  type RefinementFocus,
} from "../../core/streaming/refinementStrategies";
import { StreamingPerformanceRecorder } from "../../core/streaming/performance";
import { MOTION_LOOKAHEAD_DECAY_MS } from "../../core/streaming/motionLookahead";
import type { NodePointCacheDiagnostics } from "../../core/streaming/createNodePointCache";
import type { AdaptiveViewDistanceDiagnostics } from "../../core/streaming/view";
import type { RangeRequestDiagnostics } from "../../core/copc/range/requestDiagnostics";
import type { RangeValidationPolicy } from "../../core/copc/range/types";
import type { CopcInputSource } from "../../core/copc/range/types";
import { getCopcSourceIdentity } from "../../core/copc/getter/createCopcGetter";
import type {
  CopcCesiumPointStyle,
  CopcCesiumPointStyleUpdate,
  CopcClassificationFilter,
} from "../style/CesiumPointStyle";

export type {
  CopcCesiumPointStyle,
  CopcCesiumPointStyleUpdate,
  CopcClassificationFilter,
} from "../style/CesiumPointStyle";

export type CopcLayerOptions = {
  url: CopcInputSource;
  /** Fixed CSS-pixel point diameter. Defaults to 3. */
  pointSize?: number;
  /** Fixed by default; attenuation requires renderer shader support. */
  pointSizeMode?: "fixed" | "attenuated";
  /** Lower attenuated point diameter in CSS pixels. Defaults to 1. */
  minPointSize?: number;
  /** Upper attenuated point diameter in CSS pixels. Defaults to 12; maximum is 64. */
  maxPointSize?: number;
  colorMode?: CopcColorMode;
  /** Source fields retained for point rendering. Defaults to all standard fields. */
  attributeLoading?: "all" | "required";
  /** Additional standard fields to retain explicitly, including in required mode. */
  pointFields?: CopcPointFieldSelection;
  /** Optional classification filter applied from the first rendered view. */
  classificationFilter?: CopcClassificationFilter;
  coordinateCacheLayout?: "A" | "E";
  /** Manual additive correction in metres applied to ellipsoidal point height. Defaults to 0. */
  heightOffsetMeters?: number;
  /** Explicit user-loaded GTX grid; absent means no vertical datum conversion. */
  verticalTransform?: GtxGeoidGrid;
  debug?: boolean;
  maxRenderedPoints?: number;
  streaming?: Partial<StreamingSelectionOptions>;
  backend?: CopcBackendSelection;
  decoder?: import("../../core/copc/points/types").CopcPointDecoder;
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

type LayerStreamingCore = ReturnType<typeof createLayerStreamingCore>;

/** Lifecycle values included in the Cesium layer diagnostic snapshot. */
export type CopcLayerLifecycleState =
  /** Constructed but not attached or loading. */
  | "idle"
  /** Attached to a Viewer without loaded metadata. */
  | "mounted"
  /** Source metadata and root hierarchy are loading. */
  | "loading"
  /** Metadata and root hierarchy are ready for view-driven point streaming. */
  | "ready"
  /** Permanently destroyed. */
  | "destroyed";

/** Counts describing visible-node coverage transitions. */
export type CopcLayerTransitionDiagnostics = {
  /** Replacement groups currently awaiting completion. */
  activeReplacementGroupCount: number;
  /** Groups waiting for required new nodes to be prepared. */
  replacementGroupsWaitingCount: number;
  /** Refinement groups committed. */
  refinementReplacementCommitCount: number;
  /** Collapse groups committed. */
  collapseReplacementCommitCount: number;
  /** Groups cancelled because their view became stale. */
  staleReplacementCancellationCount: number;
  /** Coarse nodes retained to preserve coverage during replacement. */
  coarseNodesRetainedForCoverageCount: number;
};

/** Diagnostic snapshot of the Cesium adapter and its shared streaming core. */
export type CopcLayerSnapshot = {
  /** Current layer lifecycle state. */
  lifecycle: CopcLayerLifecycleState;
  /** Hierarchy nodes currently committed to the renderer. */
  renderedNodeKeys: string[];
  /** Hierarchy nodes selected for the current view. */
  selectedNodeKeys: string[];
  /** Number of points currently committed to the renderer. */
  renderedPointCount: number;
  /** Number of view updates started. */
  streamingUpdateCount: number;
  /** Configured COPC resource URL. */
  datasetUrl: string;
  /** Whether the layer is attached to a Cesium Viewer. */
  attached: boolean;
  /** Built-in backend name or `custom` for a supplied backend. */
  backend: CopcBackendName | "custom";
  /** Core range-fetch, decode, and point-preparation measurements. */
  performance: ReturnType<StreamingPerformanceRecorder["getSnapshot"]> &
    Pick<CopcStreamingPerformanceSnapshot, "motionLive">;
  /** Visible-node replacement diagnostics. */
  transition: CopcLayerTransitionDiagnostics;
  /** Adaptive current-view distance diagnostics, when a view has been evaluated. */
  viewDistance?: AdaptiveViewDistanceDiagnostics;
  /** Decoded CPU point-buffer cache counters and retained bytes. */
  pointCache: NodePointCacheDiagnostics;
  /** Source-owned HTTP range-request counters and transferred bytes. */
  rangeRequests: RangeRequestDiagnostics;
  /** Decode worker counters when exposed by the selected backend. */
  worker?: CopcWorkerDiagnostics;
  /** Bounded speculative preparation counters when enabled. */
  predictivePrefetch?: PredictivePrefetchDiagnostics;
};

type ActiveCameraFlight = {
  viewer: Cesium.Viewer;
  settle: (completed: boolean) => void;
};

type ActiveStreamingUpdate = {
  progressApplied: boolean;
};

function combinePerformance(
  corePerformance: CopcStreamingPerformanceSnapshot,
  rendererPerformance: ReturnType<StreamingPerformanceRecorder["getSnapshot"]>,
  renderedPointCount: number,
): ReturnType<StreamingPerformanceRecorder["getSnapshot"]> &
  Pick<CopcStreamingPerformanceSnapshot, "motionLive"> {
  const configuredPointBudget =
    corePerformance.configuredPointBudget ||
    rendererPerformance.configuredPointBudget;
  const activeRenderedPointCount = Math.max(0, renderedPointCount);

  return {
    ...corePerformance,
    configuredPointBudget,
    activeRenderedPointCount,
    budgetUtilizationPercent:
      configuredPointBudget > 0
        ? (activeRenderedPointCount / configuredPointBudget) * 100
        : 0,
    geographicToCartesianDurationMs:
      rendererPerformance.geographicToCartesianDurationMs,
    worldToCartesianDurationMs: rendererPerformance.worldToCartesianDurationMs,
    pointStylePreparationDurationMs:
      rendererPerformance.pointStylePreparationDurationMs,
    pointCollectionCreationDurationMs:
      rendererPerformance.pointCollectionCreationDurationMs,
    pointAddDurationMs: rendererPerformance.pointAddDurationMs,
    rendererPreparationDurationMs:
      rendererPerformance.rendererPreparationDurationMs,
    nodeRemovalDurationMs: rendererPerformance.nodeRemovalDurationMs,
    longestMainThreadBlockingSectionMs: Math.max(
      corePerformance.longestMainThreadBlockingSectionMs,
      rendererPerformance.longestMainThreadBlockingSectionMs,
    ),
  };
}

const SUPPORTED_COLOR_MODES = new Set<CopcColorMode>([
  "fixed",
  "elevation",
  "rgb",
  "intensity",
  "classification",
]);

function cloneClassificationFilter(
  filter: CopcClassificationFilter,
): CopcClassificationFilter {
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) {
    throw new TypeError("Classification filter must be an object");
  }

  const cloneCodes = (values: readonly number[] | undefined, name: string) => {
    if (values === undefined) {
      return undefined;
    }
    if (!Array.isArray(values)) {
      throw new TypeError(`Classification filter ${name} must be an array`);
    }
    for (const value of values) {
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new RangeError(
          `Classification filter codes must be integers from 0 to 255`,
        );
      }
    }
    return [...values];
  };

  const include = cloneCodes(filter.include, "include");
  const exclude = cloneCodes(filter.exclude, "exclude");
  return {
    ...(include === undefined ? {} : { include }),
    ...(exclude === undefined ? {} : { exclude }),
  };
}

function isPointVisibleForStyle(
  points: RenderablePointData,
  pointIndex: number,
  style: CopcCesiumPointStyle,
): boolean {
  const filter = style.classificationFilter;
  if (
    !filter ||
    (filter.include === undefined && filter.exclude === undefined)
  ) {
    return true;
  }

  const classification = points.attributes?.classification?.[pointIndex];
  // A classification filter cannot match data that did not retain a
  // classification value, so those points are hidden explicitly.
  if (classification === undefined) {
    return false;
  }
  if (filter.include && !filter.include.includes(classification)) {
    return false;
  }
  return !filter.exclude?.includes(classification);
}

/**
 * Cesium adapter for the renderer-neutral COPC streaming core.
 *
 * This class owns only Cesium attachment, camera scheduling, point primitive
 * reconciliation, and picking. Source loading, hierarchy traversal,
 * selection, point caching, and view generations belong to `CopcStreamingCore`.
 */
export class CesiumLayerController {
  readonly loadProgress = new CopcCesiumEvent<[number, number, number]>();
  readonly metadataReady = new CopcCesiumEvent<[CopcMetadata, number]>();
  readonly firstVisible = new CopcCesiumEvent<[number, number]>();
  readonly viewSettled = new CopcCesiumEvent<[number, readonly string[]]>();
  readonly viewCancelled = new CopcCesiumEvent<
    [number, CopcViewCancellationReason]
  >();
  readonly error = new CopcCesiumEvent<[CopcLayerErrorEvent]>();

  private readonly core: LayerStreamingCore;
  private readonly eventLifecycle = new CopcLayerEventLifecycle();
  private readonly options: CopcLayerOptions;
  private readonly pointFields: CopcPointFieldSelection;
  private readonly pointRenderer: CesiumPointRenderer;
  private readonly pointPicker: CesiumPointPicker;
  private activeTerrainEstimate?: {
    estimate: TerrainHeightAlignmentEstimate;
    viewer: Cesium.Viewer;
    provider: Cesium.TerrainProvider;
    loadGeneration: number;
    anchor: CopcPointInspection;
  };
  private readonly pointStyleState = createCopcPointStyleState();
  private style: CopcCesiumPointStyle;
  private readonly rendererPerformance = new StreamingPerformanceRecorder();
  private datasetElevationRange?: { min: number; max: number };
  private viewer?: Cesium.Viewer;
  private showState = true;
  private updateTimer?: number;
  private motionDecayTimer?: number;
  private scheduledUpdateShouldInvalidate = false;
  private scheduledUpdateForceSelection = false;
  private updateInFlight = false;
  private updateInFlightPromise?: Promise<void>;
  private updatePending = false;
  private pendingForceSelection = false;
  private loadGeneration = 0;
  private loadOperationGeneration?: number;
  private loadOperationViewErrorGeneration?: number;
  private firstVisibleLoadGeneration?: number;
  private metadataBoundingSphere?: Cesium.BoundingSphere;
  private activeCameraFlight?: ActiveCameraFlight;
  private streamingGeneration = 0;
  private readonly replacementTransitions: ReplacementTransitionManager;
  private hasFlownToDataset = false;
  private lifecycle: CopcLayerLifecycleState = "idle";
  private lastStreamingView?: import("../../core/streaming/types").StreamingView;
  private refinementFocus?: RefinementFocus;
  private pendingInvalidatedView?: import("../../core/streaming/types").StreamingView;
  private activeStreamingUpdate?: ActiveStreamingUpdate;
  private readonly handleCameraMoveEnd = (): void => {
    const motion = this.observeCurrentCameraMotion();
    void this.scheduleStreamingUpdate(true, motion?.priorityChanged ?? false);
  };
  private readonly handleCameraChanged = (): void => {
    const motion = this.observeCurrentCameraMotion();
    void this.scheduleStreamingUpdate(false, motion?.priorityChanged ?? false);
  };

  constructor(options: CopcLayerOptions) {
    const pointSize = options.pointSize ?? 3;
    const minPointSize =
      options.minPointSize ?? DEFAULT_MIN_ATTENUATED_POINT_SIZE_CSS_PIXELS;
    const maxPointSize =
      options.maxPointSize ?? DEFAULT_MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS;
    if (!Number.isFinite(pointSize) || pointSize <= 0) {
      throw new RangeError("pointSize must be a positive finite number");
    }
    if (
      options.pointSizeMode !== undefined &&
      options.pointSizeMode !== "fixed" &&
      options.pointSizeMode !== "attenuated"
    ) {
      throw new TypeError('pointSizeMode must be "fixed" or "attenuated"');
    }
    if (
      options.attributeLoading !== undefined &&
      options.attributeLoading !== "all" &&
      options.attributeLoading !== "required"
    ) {
      throw new TypeError('attributeLoading must be "all" or "required"');
    }
    if (
      !Number.isFinite(minPointSize) ||
      minPointSize <= 0 ||
      !Number.isFinite(maxPointSize) ||
      maxPointSize < minPointSize ||
      maxPointSize > MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS
    ) {
      throw new RangeError(
        `minPointSize and maxPointSize must satisfy 0 < minPointSize <= maxPointSize <= ${MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS}`,
      );
    }
    this.options = options;
    this.style = {
      colorMode: options.colorMode ?? "fixed",
      ...(options.classificationFilter === undefined
        ? {}
        : {
            classificationFilter: cloneClassificationFilter(
              options.classificationFilter,
            ),
          }),
    };
    this.pointFields = this.getInitialPointFields(this.style);
    this.pointRenderer = options.renderer ?? new PointPrimitiveRenderer();
    this.rendererPerformance.setConfiguredPointBudget(
      this.getMaxRenderedPoints(),
    );
    this.core = createLayerStreamingCore({
      url: options.url,
      backend: options.backend,
      heightOffsetMeters: options.heightOffsetMeters,
      verticalTransform: options.verticalTransform,
      decoder: options.decoder,
      debug: options.debug,
      maxRenderedPoints: options.maxRenderedPoints,
      maxPointCacheBytes: options.maxPointCacheBytes,
      rangeValidation: options.rangeValidation,
      maxRangeBytes: options.maxRangeBytes,
      maxConcurrentRangeRequests: options.maxConcurrentRangeRequests,
      // All remains the compatibility default. Required mode retains only
      // fields used by the initial style and any initial classification filter.
      pointFields: this.pointFields,
      streaming: options.streaming,
    }, options.coordinateCacheLayout ?? "E");
    this.pointPicker = new CesiumPointPicker({
      inspectPoint: (pickId) => {
        const node = this.core.getHierarchyNode(pickId.nodeKey);
        const points = getCachedRenderablePointDataForAdapter(
          this.core,
          pickId.nodeKey,
        );
        return node && points
          ? inspectCopcPoint(
              pickId,
              node.node,
              points,
              this.core.getSnapshot().backend,
            )
          : undefined;
      },
      hasNode: (nodeKey) => this.pointRenderer.hasNode(nodeKey),
      resolveBatchedPoint: this.pointRenderer.resolvePointPick
        ? (scene, position, pickedObject) =>
            this.pointRenderer.resolvePointPick?.(scene, position, pickedObject)
        : undefined,
      onPointPicked: (point) => {
        this.activeTerrainEstimate = undefined;
        options.onPointPicked?.(point);
      },
    });
    this.replacementTransitions = new ReplacementTransitionManager({
      renderer: this.pointRenderer,
      getHierarchyNodePointCount: (nodeKey) =>
        this.core.getHierarchyNode(nodeKey)?.node.pointCount,
      removeNode: (nodeKey) => this.removePointCollection(nodeKey),
    });
  }

  /** Attach the layer's Cesium primitives and camera listeners. */
  attachTo(viewer: Cesium.Viewer): void {
    if (this.lifecycle === "destroyed") {
      throw new Error("CopcCesiumLayer has been destroyed");
    }

    if (this.viewer && this.viewer !== viewer) {
      this.detachFrom();
    }
    if (this.viewer === viewer) {
      return;
    }

    this.viewer = viewer;
    this.pointRenderer.attachTo(viewer);
    this.pointRenderer.setShow?.(this.showState);
    this.viewer.camera.percentageChanged = 0.02;
    this.viewer.camera.moveEnd.addEventListener(this.handleCameraMoveEnd);
    this.viewer.camera.changed?.addEventListener(this.handleCameraChanged);
    this.pointPicker.attach(viewer);
    // Seed orientation history before the next user movement. Detach clears
    // camera history, and a first movement event alone cannot estimate a delta.
    this.observeCurrentCameraMotion();
    if (this.lifecycle !== "loading") {
      this.lifecycle = this.core.getMetadata() ? "ready" : "mounted";
    }

    const metadata = this.core.getMetadata();
    if (metadata) {
      this.flyToDataset(metadata);
      this.startStreamingUpdate();
    }
  }

  get show(): boolean {
    return this.showState;
  }

  set show(value: boolean) {
    if (this.lifecycle === "destroyed") {
      throw new Error("CopcCesiumLayer has been destroyed");
    }
    if (typeof value !== "boolean") {
      throw new TypeError("COPC layer show must be a boolean");
    }
    this.showState = value;
    this.pointRenderer.setShow?.(value);
  }

  /** Full metadata extent transformed to WGS84 ECEF, when safely supported. */
  get boundingSphere(): Cesium.BoundingSphere | undefined {
    return this.metadataBoundingSphere
      ? Cesium.BoundingSphere.clone(this.metadataBoundingSphere)
      : undefined;
  }

  /** Fly the attached application's camera to the metadata-derived extent. */
  zoomTo(offset?: Cesium.HeadingPitchRange): Promise<boolean> {
    if (this.lifecycle === "destroyed") {
      return Promise.reject(new Error("CopcCesiumLayer has been destroyed"));
    }
    const viewer = this.viewer;
    if (!viewer) {
      return Promise.reject(
        new Error("CopcCesiumLayer must be attached before zoomTo()"),
      );
    }
    if (viewer.isDestroyed()) {
      return Promise.reject(
        new Error("The attached Cesium Viewer has been destroyed"),
      );
    }
    if (viewer.scene.mode === Cesium.SceneMode.MORPHING) {
      return Promise.reject(
        new Error("Cannot start zoomTo() while the Cesium scene is morphing"),
      );
    }
    const sphere = this.boundingSphere;
    if (!sphere) {
      return Promise.reject(
        new Error("COPC dataset does not have a supported bounding sphere"),
      );
    }
    if (
      offset &&
      (![offset.heading, offset.pitch, offset.range].every(Number.isFinite) ||
        offset.range < 0)
    ) {
      return Promise.reject(
        new RangeError(
          "zoomTo offset must contain finite values and a non-negative range",
        ),
      );
    }

    this.cancelCameraFlight();
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const settle = (completed: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.activeCameraFlight?.settle === settle) {
          this.activeCameraFlight = undefined;
        }
        resolve(completed);
      };
      this.activeCameraFlight = { viewer, settle };
      try {
        viewer.camera.flyToBoundingSphere(sphere, {
          ...(offset ? { offset } : {}),
          complete: () => settle(true),
          cancel: () => settle(false),
        });
      } catch (error: unknown) {
        if (this.activeCameraFlight?.settle === settle) {
          this.activeCameraFlight = undefined;
        }
        settled = true;
        reject(error);
      }
    });
  }

  /** Detach primitives and listeners without unloading COPC data. */
  detachFrom(): void {
    if (this.lifecycle === "destroyed") {
      return;
    }

    this.cancelActiveView("detach");
    if (this.isDestroyed()) {
      return;
    }
    this.cancelCameraFlight();
    this.streamingGeneration += 1;
    this.core.invalidateView();
    this.clearScheduledUpdate();
    this.clearMotionDecayTimer();
    this.core.resetCameraMotion();
    this.updatePending = false;
    this.pendingForceSelection = false;

    this.detachViewerResources();
    if (this.lifecycle !== "loading") {
      this.lifecycle = this.core.getMetadata() ? "ready" : "idle";
    }
  }

  private detachViewerResources(): void {
    this.activeTerrainEstimate = undefined;
    if (this.viewer) {
      this.viewer.camera.moveEnd.removeEventListener(this.handleCameraMoveEnd);
      this.viewer.camera.changed?.removeEventListener(this.handleCameraChanged);
    }

    this.pointPicker.detach();
    this.pointRenderer.detachFrom();
    this.replacementTransitions.reset();
    this.pointPicker.clear();
    this.rendererPerformance.reset();
    this.clearMotionDecayTimer();
    this.lastStreamingView = undefined;
    this.pendingInvalidatedView = undefined;
    this.activeStreamingUpdate = undefined;
    this.viewer = undefined;
  }

  /** Load source metadata and the root hierarchy without requiring a viewer. */
  async load(): Promise<void> {
    if (this.lifecycle === "destroyed") {
      throw new Error("CopcCesiumLayer has been destroyed");
    }
    if (this.core.getMetadata()) {
      throw new Error(
        "COPC layer is already loaded; call reload() to load it again",
      );
    }
    if (this.lifecycle === "loading") {
      throw new Error("COPC layer is already loading");
    }

    this.lifecycle = "loading";
    this.activeTerrainEstimate = undefined;
    const loadGeneration = ++this.loadGeneration;
    this.loadOperationGeneration = loadGeneration;
    this.loadOperationViewErrorGeneration = undefined;
    try {
      await this.core.load();
      if (loadGeneration !== this.loadGeneration) {
        return;
      }

      const metadata = this.core.getMetadata();
      if (!metadata) {
        throw new Error("COPC layer loaded without metadata");
      }
      if (this.viewer) {
        // Source replacement resets the shared estimator while the layer may
        // remain attached; establish a fresh baseline before automatic framing.
        this.observeCurrentCameraMotion();
      }
      this.metadataBoundingSphere = createMetadataBoundingSphere(
        metadata,
        this.options.heightOffsetMeters,
        this.options.verticalTransform,
      );
      this.datasetElevationRange = getDatasetElevationRange(
        metadata,
        this.options.heightOffsetMeters,
        this.options.verticalTransform,
      );
      this.firstVisibleLoadGeneration = undefined;
      this.metadataReady.raiseEvent(
        snapshotCopcMetadata(metadata),
        loadGeneration,
      );
      if (loadGeneration !== this.loadGeneration || this.isDestroyed()) {
        return;
      }
      this.lifecycle = "ready";
      this.debug("COPC metadata and hierarchy loaded");
      if (this.viewer) {
        const metadata = this.core.getMetadata();
        if (metadata) {
          this.flyToDataset(metadata);
        }
        await this.updateStreamingView();
      }
    } catch (error: unknown) {
      if (loadGeneration === this.loadGeneration) {
        if (this.loadOperationViewErrorGeneration !== loadGeneration) {
          this.error.raiseEvent(
            Object.freeze({
              error: snapshotCopcError(error),
              phase: "load",
              loadGeneration,
            }),
          );
        }
        this.unloadInternal("unload");
      }
      throw error;
    } finally {
      if (this.loadOperationGeneration === loadGeneration) {
        this.loadOperationGeneration = undefined;
      }
      if (this.loadOperationViewErrorGeneration === loadGeneration) {
        this.loadOperationViewErrorGeneration = undefined;
      }
    }
  }

  /** Release loaded COPC data while retaining the layer and viewer attachment. */
  unload(): void {
    if (this.lifecycle === "destroyed") {
      return;
    }

    this.unloadInternal("unload");
  }

  private unloadInternal(reason: CopcViewCancellationReason): void {
    if (this.lifecycle === "destroyed") {
      return;
    }
    this.cancelActiveView(reason);
    if (this.isDestroyed()) {
      return;
    }
    this.cancelCameraFlight();
    this.activeTerrainEstimate = undefined;

    this.loadGeneration += 1;
    this.streamingGeneration += 1;
    this.clearScheduledUpdate();
    this.clearMotionDecayTimer();
    this.updatePending = false;
    this.pendingForceSelection = false;
    this.core.unload();
    this.datasetElevationRange = undefined;
    this.metadataBoundingSphere = undefined;
    this.firstVisibleLoadGeneration = undefined;
    this.pointRenderer.clear();
    this.pointStyleState.reset();
    this.replacementTransitions.reset();
    this.pointPicker.clear();
    this.rendererPerformance.reset();
    this.lastStreamingView = undefined;
    this.activeStreamingUpdate = undefined;
    this.hasFlownToDataset = false;
    this.lifecycle = this.viewer ? "mounted" : "idle";
    this.debug("COPC layer unloaded");
  }

  /** Unload and load the configured COPC resource again. */
  async reload(): Promise<void> {
    if (this.lifecycle === "destroyed") {
      throw new Error("CopcCesiumLayer has been destroyed");
    }
    this.unloadInternal("reload");
    await this.load();
  }

  /** Release layer resources without destroying the caller-owned viewer. */
  destroy(): void {
    if (this.lifecycle === "destroyed") {
      return;
    }

    this.lifecycle = "destroyed";
    this.loadGeneration += 1;
    this.streamingGeneration += 1;
    this.cancelActiveView("destroy");
    this.cancelCameraFlight();
    this.clearScheduledUpdate();
    this.clearMotionDecayTimer();
    this.updatePending = false;
    this.pendingForceSelection = false;
    this.core.destroy();
    this.detachViewerResources();
    this.metadataBoundingSphere = undefined;
    this.datasetElevationRange = undefined;
    this.pointRenderer.destroy();
    this.disposeEvents();
  }

  getSnapshot(): CopcLayerSnapshot {
    const coreSnapshot = this.core.getSnapshot();
    const renderedPointCount = this.getRenderedPointCount();
    const streamingUpdateCount =
      coreSnapshot.streamingUpdateCount +
      (this.activeStreamingUpdate?.progressApplied ? 1 : 0);
    return {
      lifecycle: this.lifecycle,
      renderedNodeKeys: this.getRenderedNodeKeys(),
      selectedNodeKeys: this.core.getCurrentSelection(),
      renderedPointCount,
      streamingUpdateCount,
      datasetUrl: getCopcSourceIdentity(this.options.url),
      attached: this.viewer !== undefined,
      backend: coreSnapshot.backend,
      performance: combinePerformance(
        coreSnapshot.performance,
        this.rendererPerformance.getSnapshot(),
        renderedPointCount,
      ),
      transition: this.replacementTransitions.getDiagnostics(),
      ...(coreSnapshot.viewDistance
        ? { viewDistance: coreSnapshot.viewDistance }
        : {}),
      pointCache: coreSnapshot.pointCache,
      rangeRequests: coreSnapshot.rangeRequests,
      ...(coreSnapshot.worker ? { worker: coreSnapshot.worker } : {}),
      ...(coreSnapshot.predictivePrefetch
        ? { predictivePrefetch: coreSnapshot.predictivePrefetch }
        : {}),
    };
  }

  getHierarchyDiagnostics() {
    return this.core.getHierarchyDiagnostics();
  }

  getPointCacheDiagnostics(): NodePointCacheDiagnostics {
    return this.core.getPointCacheDiagnostics();
  }

  getMetadata(): CopcMetadata | undefined {
    return this.core.getMetadata();
  }

  /** Return the selected point while its node and decoded buffer are live. */
  getSelectedPoint(): CopcPointInspection | undefined {
    return this.pointPicker.getSelectedPoint();
  }

  /**
   * Compare one explicitly selected ground point with the active real Terrain
   * provider. The estimate never changes rendered positions.
   */
  async estimateTerrainHeightAlignment(
    anchor: CopcPointInspection,
    options: TerrainHeightAlignmentOptions = {},
  ): Promise<TerrainHeightAlignmentEstimate> {
    this.activeTerrainEstimate = undefined;
    const metadata = this.core.getMetadata();
    const viewer = this.viewer;
    if (!metadata || !viewer || this.lifecycle !== "ready") {
      return createUnavailableTerrainHeightAlignmentEstimate(
        {
          anchor,
          metadata: metadata ?? { wkt: undefined },
          verticalTransform: this.options.verticalTransform,
          existingHeightOffsetMeters: this.options.heightOffsetMeters ?? 0,
          sourceId: getCopcSourceIdentity(this.options.url),
        },
        "The COPC layer must be loaded and attached to a Viewer before estimating.",
      );
    }

    const provider = viewer.terrainProvider;
    const loadGeneration = this.loadGeneration;
    const isCurrent = (): boolean =>
      this.viewer === viewer &&
      !viewer.isDestroyed() &&
      this.lifecycle === "ready" &&
      this.loadGeneration === loadGeneration &&
      viewer.terrainProvider === provider &&
      this.isSameSelectedAnchor(anchor, this.pointPicker.getSelectedPoint());

    const estimate = await estimateTerrainHeightAlignmentForViewer({
      viewer,
      provider,
      metadata,
      verticalTransform: this.options.verticalTransform,
      anchor,
      expectedOwnerId: this.pointPicker.ownerId,
      existingHeightOffsetMeters: this.options.heightOffsetMeters ?? 0,
      sourceId: getCopcSourceIdentity(this.options.url),
      terrainSourceId: options.terrainSourceId,
      options,
      isCurrent,
    });
    if (anchor && isCurrent()) {
      this.activeTerrainEstimate = {
        estimate,
        viewer,
        provider,
        loadGeneration,
        anchor,
      };
    }
    return estimate;
  }

  /** Confirm that an estimate still belongs to this selected point and live layer. */
  isTerrainHeightAlignmentEstimateCurrent(
    estimate: TerrainHeightAlignmentEstimate,
  ): boolean {
    const active = this.activeTerrainEstimate;
    return (
      active !== undefined &&
      active.estimate === estimate &&
      active.viewer === this.viewer &&
      !active.viewer.isDestroyed() &&
      active.provider === active.viewer.terrainProvider &&
      active.loadGeneration === this.loadGeneration &&
      this.lifecycle === "ready" &&
      this.isSameSelectedAnchor(active.anchor, this.pointPicker.getSelectedPoint())
    );
  }

  private isSameSelectedAnchor(
    expected: CopcPointInspection,
    selected: CopcPointInspection | undefined,
  ): boolean {
    if (!selected) return false;
    return (
      expected.ownerId === selected.ownerId &&
      expected.nodeKey === selected.nodeKey &&
      expected.pointIndex === selected.pointIndex &&
      expected.longitude === selected.longitude &&
      expected.latitude === selected.latitude &&
      expected.height === selected.height &&
      expected.source?.x === selected.source?.x &&
      expected.source?.y === selected.source?.y &&
      expected.source?.z === selected.source?.z &&
      expected.classification === selected.classification
    );
  }

  /** Return a detached snapshot of the current Cesium presentation style. */
  getStyle(): CopcCesiumPointStyle {
    return {
      colorMode: this.style.colorMode,
      ...(this.style.classificationFilter === undefined
        ? {}
        : {
            classificationFilter: cloneClassificationFilter(
              this.style.classificationFilter,
            ),
          }),
    };
  }

  /** Update colors and classification visibility using currently cached nodes. */
  setStyle(update: CopcCesiumPointStyleUpdate): void {
    if (this.lifecycle === "destroyed") {
      throw new Error("CopcCesiumLayer has been destroyed");
    }
    if (update === null || typeof update !== "object") {
      throw new TypeError("Point style update must be an object");
    }

    const nextStyle: CopcCesiumPointStyle = {
      colorMode: this.style.colorMode,
      ...(this.style.classificationFilter === undefined
        ? {}
        : {
            classificationFilter: cloneClassificationFilter(
              this.style.classificationFilter,
            ),
          }),
    };
    if (update.colorMode !== undefined) {
      if (!SUPPORTED_COLOR_MODES.has(update.colorMode)) {
        throw new RangeError(
          `Unsupported COPC point color mode: ${String(update.colorMode)}`,
        );
      }
      nextStyle.colorMode = update.colorMode;
    }
    if (update.classificationFilter === null) {
      delete nextStyle.classificationFilter;
    } else if (update.classificationFilter !== undefined) {
      nextStyle.classificationFilter = cloneClassificationFilter(
        update.classificationFilter,
      );
    }

    this.assertStyleFieldsWereLoaded(nextStyle);

    const renderedNodes = this.pointRenderer
      .getRenderedNodeKeys()
      .map((nodeKey) => {
        const points = getCachedRenderablePointDataForAdapter(
          this.core,
          nodeKey,
        );
        if (!points) {
          throw new Error(
            `Cannot restyle rendered node ${nodeKey}: its decoded point buffer is not cached; ` +
              "the style update does not reload or re-decode COPC data.",
          );
        }
        return { nodeKey, points };
      });

    const previousStyle = this.style;
    this.style = nextStyle;
    try {
      for (const { nodeKey, points } of renderedNodes) {
        this.updatePointCollectionStyle(nodeKey, points, nextStyle);
      }
    } catch (error: unknown) {
      this.style = previousStyle;
      for (const { nodeKey, points } of renderedNodes) {
        try {
          this.updatePointCollectionStyle(nodeKey, points, previousStyle);
        } catch {
          // Preserve the original renderer failure while attempting to restore
          // every already-updated node with the prior presentation.
        }
      }
      throw error;
    }

    const selectedPick = this.pointPicker.getSelectedPickId();
    if (selectedPick) {
      const selectedPoints = getCachedRenderablePointDataForAdapter(
        this.core,
        selectedPick.nodeKey,
      );
      if (
        !selectedPoints ||
        !isPointVisibleForStyle(
          selectedPoints,
          selectedPick.pointIndex,
          nextStyle,
        )
      ) {
        this.pointPicker.clear();
      }
    }
    this.rendererPerformance.setActiveRenderedPointCount(
      this.getRenderedPointCount(),
    );
  }

  private getInitialPointFields(
    style: CopcCesiumPointStyle,
  ): CopcPointFieldSelection {
    if ((this.options.attributeLoading ?? "all") === "all") {
      return allCopcPointFields();
    }
    const fields = new Set<CopcPointField>(
      getCopcPointFieldSelection(style.colorMode),
    );
    for (const field of this.options.pointFields ?? []) {
      fields.add(field);
    }
    if (style.classificationFilter !== undefined) {
      fields.add("classification");
    }
    return createCopcPointFieldSelection(fields);
  }

  private assertStyleFieldsWereLoaded(style: CopcCesiumPointStyle): void {
    if ((this.options.attributeLoading ?? "all") !== "required") {
      return;
    }
    const requiredFields = new Set<CopcPointField>(
      getCopcPointFieldSelection(style.colorMode),
    );
    if (style.classificationFilter !== undefined) {
      requiredFields.add("classification");
    }
    const missingFields = [...requiredFields].filter(
      (field) => field !== "position" && !this.pointFields.has(field),
    );
    if (missingFields.length === 0) {
      return;
    }
    const names = missingFields.join(", ");
    throw new Error(
      `Cannot apply this style because ${names} ${missingFields.length === 1 ? "was" : "were"} not requested under attributeLoading: "required"; source availability was not checked. ` +
        `Recreate the layer with attributeLoading: "all" or include the required field in the initial colorMode, classificationFilter, or pointFields.`,
    );
  }

  getRenderedNodeKeys(): string[] {
    return this.pointRenderer.getRenderedNodeKeys();
  }

  getRenderedPointCount(): number {
    return this.pointRenderer.getRenderedPointCount();
  }

  getCurrentSelection(): string[] {
    return this.core.getCurrentSelection();
  }

  setRefinementFocus(focus: RefinementFocus | undefined): void {
    if (this.lifecycle === "destroyed") {
      throw new Error("CopcCesiumLayer has been destroyed");
    }
    const nextFocus = normalizeRefinementFocus(focus);
    if (this.areRefinementFociEquivalent(this.refinementFocus, nextFocus)) {
      return;
    }
    this.refinementFocus = nextFocus;
    this.core.setRefinementFocus(nextFocus);

    if (!this.viewer || !this.core.getMetadata()) {
      return;
    }

    // Cancel stale commits immediately, retain source/hierarchy/cache state,
    // and force a fresh selector pass even though the camera did not move.
    this.streamingGeneration += 1;
    this.lastStreamingView = undefined;
    this.cancelActiveView("focus-change");
    const currentView = createCesiumStreamingView(this.viewer);
    this.pendingInvalidatedView = currentView;
    this.core.invalidateView(currentView);
    void this.scheduleStreamingUpdate(true);
  }

  getSelectionBoundingSphere(): Cesium.BoundingSphere | undefined {
    return this.pointRenderer.getSelectionBoundingSphere();
  }

  private async updateStreamingView(
    shouldInvalidateActive = false,
    forceSelection = false,
  ): Promise<void> {
    if (this.updateInFlight) {
      // Keep only the latest camera event. A materially changed settled view
      // also invalidates the active adapter generation immediately, so stale
      // progress cannot reach the renderer while the update drains.
      this.updatePending = true;
      this.pendingForceSelection ||= forceSelection;
      const currentView =
        this.viewer && this.core.getMetadata()
          ? createCesiumStreamingView(this.viewer)
          : undefined;
      if (
        !this.lastStreamingView ||
        !currentView ||
        !areStreamingViewsEquivalent(this.lastStreamingView, currentView)
      ) {
        this.cancelActiveView("camera-change");
        this.streamingGeneration += 1;
        if (
          !this.pendingInvalidatedView ||
          !currentView ||
          !areStreamingViewsEquivalent(this.pendingInvalidatedView, currentView)
        ) {
          this.pendingInvalidatedView = currentView;
          this.core.invalidateView(
            shouldInvalidateActive ? currentView : undefined,
          );
        }
      }

      const inFlightPromise = this.updateInFlightPromise;
      if (inFlightPromise) {
        await inFlightPromise;
      }
      return;
    }

    this.pendingForceSelection ||= forceSelection;
    this.updateInFlight = true;
    const updatePromise = this.runPendingStreamingUpdates();
    this.updateInFlightPromise = updatePromise;
    try {
      await updatePromise;
    } finally {
      if (this.updateInFlightPromise === updatePromise) {
        this.updateInFlightPromise = undefined;
        this.updateInFlight = false;
      }
    }
  }

  private async runPendingStreamingUpdates(): Promise<void> {
    while (true) {
      try {
        const forceSelection = this.pendingForceSelection;
        this.pendingForceSelection = false;
        await this.performStreamingUpdate(forceSelection);
      } catch (error: unknown) {
        this.updatePending = false;
        throw error;
      }
      if (!this.updatePending) {
        return;
      }
      this.updatePending = false;
    }
  }

  private async performStreamingUpdate(forceSelection = false): Promise<void> {
    const viewer = this.viewer;
    if (!viewer || !this.core.getMetadata() || this.lifecycle === "destroyed") {
      return;
    }

    const streamingGeneration = ++this.streamingGeneration;
    const view = createCesiumStreamingView(viewer);
    if (
      !forceSelection &&
      this.lastStreamingView &&
      areStreamingViewsEquivalent(this.lastStreamingView, view)
    ) {
      this.pendingInvalidatedView = undefined;
      return;
    }
    const begunView = this.eventLifecycle.beginView();
    if (begunView.superseded) {
      this.viewCancelled.raiseEvent(
        begunView.superseded.viewGeneration,
        begunView.superseded.reason,
      );
    }
    const publicViewGeneration = begunView.viewGeneration;
    if (
      this.isDestroyed() ||
      !this.eventLifecycle.isActiveView(publicViewGeneration)
    ) {
      return;
    }
    this.pendingInvalidatedView = undefined;
    this.lastStreamingView = view;
    this.rendererPerformance.beginUpdate();
    let progressApplied = false;
    const activeStreamingUpdate: ActiveStreamingUpdate = {
      progressApplied: false,
    };
    this.activeStreamingUpdate = activeStreamingUpdate;
    let lastQueuedNodeCount: number | undefined;
    let lastActiveNodeCount: number | undefined;
    const onProgress: CopcStreamingProgressHandler<RenderablePointData> = (
      progress,
    ) => {
      if (
        !this.isCurrentStreamingGeneration(streamingGeneration, viewer) ||
        !this.eventLifecycle.isActiveView(publicViewGeneration)
      ) {
        return;
      }

      progressApplied = true;
      if (progress.loadedNodePoints.size > 0) {
        activeStreamingUpdate.progressApplied = true;
      }
      this.applyStreamingProgress(
        viewer,
        progress,
        streamingGeneration,
        publicViewGeneration,
      );
    };
    const onWorkProgress: CopcStreamingWorkProgressHandler | undefined =
      this.loadProgress.numberOfListeners > 0
        ? (progress) => {
            if (
              !this.isCurrentStreamingGeneration(streamingGeneration, viewer) ||
              !this.eventLifecycle.isActiveView(publicViewGeneration) ||
              (progress.queuedNodeCount === lastQueuedNodeCount &&
                progress.activeNodeCount === lastActiveNodeCount)
            ) {
              return;
            }
            lastQueuedNodeCount = progress.queuedNodeCount;
            lastActiveNodeCount = progress.activeNodeCount;
            this.loadProgress.raiseEvent(
              progress.queuedNodeCount,
              progress.activeNodeCount,
              publicViewGeneration,
            );
          }
        : undefined;

    let update: Awaited<ReturnType<LayerStreamingCore["updateView"]>>;
    try {
      update = await this.core.updateView(view, onProgress, onWorkProgress);
    } catch (error: unknown) {
      if (this.lastStreamingView === view) {
        this.lastStreamingView = undefined;
      }
      if (this.eventLifecycle.failView(publicViewGeneration)) {
        if (this.loadOperationGeneration === this.loadGeneration) {
          this.loadOperationViewErrorGeneration = this.loadGeneration;
        }
        this.error.raiseEvent(
          Object.freeze({
            error: snapshotCopcError(error),
            phase: "view",
            viewGeneration: publicViewGeneration,
          }),
        );
      }
      if (this.activeStreamingUpdate === activeStreamingUpdate) {
        this.activeStreamingUpdate = undefined;
      }
      throw error;
    }
    if (this.activeStreamingUpdate === activeStreamingUpdate) {
      // The core increments its completed-update counter before resolving.
      // From here on, the normal snapshot is already consistent with any
      // progress that was delivered during the update.
      this.activeStreamingUpdate = undefined;
    }
    if (
      !this.isCurrentStreamingGeneration(streamingGeneration, viewer) ||
      !update
    ) {
      if (this.eventLifecycle.isActiveView(publicViewGeneration)) {
        this.cancelActiveView("camera-change");
      }
      return;
    }

    // Keep the adapter tolerant of alternate core implementations that only
    // return an all-at-once update and do not emit progress.
    if (!progressApplied) {
      this.applyStreamingProgress(
        viewer,
        {
          ...update,
          completedBatchPointCount: update.loadedNodePoints.size,
        },
        streamingGeneration,
        publicViewGeneration,
      );
    }
    if (
      !this.updatePending &&
      this.eventLifecycle.isActiveView(publicViewGeneration) &&
      this.replacementTransitions.isViewRendererCommitted(
        update.selectedNodeKeys,
        update.loadedNodePoints,
        publicViewGeneration,
      ) &&
      this.eventLifecycle.settleView(publicViewGeneration)
    ) {
      this.viewSettled.raiseEvent(
        publicViewGeneration,
        Object.freeze([...update.selectedNodeKeys]),
      );
    }
  }

  private applyStreamingProgress(
    viewer: Cesium.Viewer,
    progress: StreamingProgress<RenderablePointData>,
    generation: number,
    viewGeneration: number,
  ): void {
    this.replacementTransitions.reconcile(
      progress.replacementGroups ?? [],
      generation,
      progress.selectedNodeKeys,
      viewGeneration,
    );

    for (const nodeKey of progress.removedNodeKeys) {
      if (!this.replacementTransitions.isReplacementOldNode(nodeKey)) {
        this.removePointCollection(nodeKey);
      }
    }

    for (const [nodeKey, points] of progress.loadedNodePoints) {
      if (
        this.viewer !== viewer ||
        !progress.selectedNodeKeys.includes(nodeKey)
      ) {
        continue;
      }
      if (this.pointRenderer.hasNode(nodeKey)) {
        continue;
      }

      if (
        this.replacementTransitions.getProjectedPointCount(
          nodeKey,
          points.pointCount,
        ) > this.getMaxRenderedPoints()
      ) {
        // The shared manager owns workload-budget diagnostics. This adapter
        // guard only prevents a renderer-side replacement oversubscription.
        continue;
      }

      this.addPointCollection(nodeKey, points);
      if (
        points.pointCount > 0 &&
        this.pointRenderer.hasNode(nodeKey) &&
        this.firstVisibleLoadGeneration !== this.loadGeneration
      ) {
        this.firstVisibleLoadGeneration = this.loadGeneration;
        this.firstVisible.raiseEvent(this.loadGeneration, viewGeneration);
        if (!this.isCurrentStreamingGeneration(generation, viewer)) {
          return;
        }
      }
    }

    this.replacementTransitions.commitReady(generation);
    this.rendererPerformance.setActiveRenderedPointCount(
      this.getRenderedPointCount(),
    );
    this.replacementTransitions.updateDiagnostics();
  }

  private addPointCollection(nodeKey: string, points: RenderablePointData): void {
    this.pointRenderer.addOrUpdateNode(
      nodeKey,
      points,
      this.createPointRendererOptions(nodeKey, points, this.style),
    );
  }

  private updatePointCollectionStyle(
    nodeKey: string,
    points: RenderablePointData,
    style: CopcCesiumPointStyle,
  ): void {
    const rendererOptions = this.createPointRendererOptions(
      nodeKey,
      points,
      style,
    );
    if (this.pointRenderer.updateNodeStyle) {
      this.pointRenderer.updateNodeStyle(nodeKey, points, rendererOptions);
    } else {
      this.pointRenderer.addOrUpdateNode(nodeKey, points, rendererOptions);
    }
  }

  private createPointRendererOptions(
    nodeKey: string,
    points: RenderablePointData,
    style: CopcCesiumPointStyle,
  ): CopcCesiumPointRendererOptions {
    const metadata = this.core.getMetadata();
    const hierarchyNode = this.core.getHierarchyNode(nodeKey);
    let pointSizeMode: "fixed" | "attenuated" =
      this.options.pointSizeMode === "attenuated" &&
      this.pointRenderer.supportsPointSizeAttenuation === true
        ? "attenuated"
        : "fixed";
    const pointSpacingMeters =
      pointSizeMode === "attenuated" && metadata && hierarchyNode
        ? deriveNodePointSpacingMeters(
            metadata,
            hierarchyNode.node.level,
            hierarchyNode.center,
            this.options.verticalTransform,
          )
        : undefined;
    if (pointSpacingMeters === undefined) pointSizeMode = "fixed";
    return {
      pointSize: this.options.pointSize ?? 3,
      pointSizeMode,
      minPointSize:
        this.options.minPointSize ??
        DEFAULT_MIN_ATTENUATED_POINT_SIZE_CSS_PIXELS,
      maxPointSize:
        this.options.maxPointSize ??
        DEFAULT_MAX_ATTENUATED_POINT_SIZE_CSS_PIXELS,
      ...(pointSpacingMeters === undefined ? {} : { pointSpacingMeters }),
      colorMode: style.colorMode,
      elevationRange: this.datasetElevationRange,
      rgbMax: this.pointStyleState.getRgbMax(points),
      pointFilter: (pointIndex: number) =>
        isPointVisibleForStyle(points, pointIndex, style),
      pointId: (pointIndex: number) => ({
        nodeKey,
        pointIndex,
        ownerId: this.pointPicker.ownerId,
      }),
      onPerformance: (stage, durationMs) => {
        const metricStage =
          stage === "geographicToCartesian"
            ? "geographicToCartesianDurationMs"
            : stage === "worldToCartesian"
              ? "worldToCartesianDurationMs"
              : stage === "pointStylePreparation"
                ? "pointStylePreparationDurationMs"
                : stage === "pointCollectionCreation"
                  ? "pointCollectionCreationDurationMs"
                  : stage === "pointAdd"
                    ? "pointAddDurationMs"
                    : stage === "rendererPreparation"
                      ? "rendererPreparationDurationMs"
                      : "nodeRemovalDurationMs";
        this.rendererPerformance.recordStage(metricStage, durationMs, true);
      },
    };
  }

  private cancelActiveView(reason: CopcViewCancellationReason): void {
    const cancelled = this.eventLifecycle.cancelView(reason);
    if (cancelled) {
      this.viewCancelled.raiseEvent(cancelled.viewGeneration, cancelled.reason);
    }
  }

  private isDestroyed(): boolean {
    return this.lifecycle === "destroyed";
  }

  private cancelCameraFlight(): void {
    const flight = this.activeCameraFlight;
    if (!flight) {
      return;
    }
    this.activeCameraFlight = undefined;
    flight.settle(false);
    try {
      if (!flight.viewer.isDestroyed()) {
        flight.viewer.camera.cancelFlight();
      }
    } catch {
      // The application may already have destroyed its Viewer during teardown.
    }
  }

  private disposeEvents(): void {
    this.loadProgress.dispose();
    this.metadataReady.dispose();
    this.firstVisible.dispose();
    this.viewSettled.dispose();
    this.viewCancelled.dispose();
    this.error.dispose();
  }

  private removePointCollection(nodeKey: string): void {
    this.pointPicker.clearIfNode(nodeKey);
    this.pointRenderer.removeNode(nodeKey);
  }

  private flyToDataset(metadata: CopcMetadata): void {
    if (!this.viewer || this.hasFlownToDataset) {
      return;
    }

    const transformPoint = createPointTransformer(
      metadata,
      this.options.heightOffsetMeters,
      this.options.verticalTransform,
      { sampleVerticalGrid: false },
    );
    const center = transformPoint({
      x: (metadata.cube.minX + metadata.cube.maxX) / 2,
      y: (metadata.cube.minY + metadata.cube.maxY) / 2,
      z: (metadata.cube.minZ + metadata.cube.maxZ) / 2,
    });
    if (this.options.verticalTransform) {
      // The cube centre is a framing estimate, not a point that must sample
      // within a regional grid's coverage.
      center.height +=
        (this.options.verticalTransform.minimumUndulationMeters +
          this.options.verticalTransform.maximumUndulationMeters) /
        2;
    }
    const cubeWidth = metadata.cube.maxX - metadata.cube.minX;
    const cubeHeight = metadata.cube.maxY - metadata.cube.minY;
    const horizontalUnitScale = metadata.wkt
      ? extractHorizontalUnitScale(metadata.wkt)
      : 1;
    const range = Math.max(cubeWidth, cubeHeight) * horizontalUnitScale * 1.2;

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        center.longitude,
        center.latitude,
        Math.max(center.height + range, 1500),
      ),
      duration: 0,
    });
    this.hasFlownToDataset = true;
  }

  private async scheduleStreamingUpdate(
    shouldInvalidateActive = false,
    forceSelection = false,
  ): Promise<void> {
    if (this.updateTimer !== undefined) {
      window.clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
    this.scheduledUpdateShouldInvalidate ||= shouldInvalidateActive;
    this.scheduledUpdateForceSelection ||= forceSelection;
    this.updateTimer = window.setTimeout(() => {
      this.updateTimer = undefined;
      const shouldInvalidate = this.scheduledUpdateShouldInvalidate;
      this.scheduledUpdateShouldInvalidate = false;
      const shouldForceSelection = this.scheduledUpdateForceSelection;
      this.scheduledUpdateForceSelection = false;
      this.startStreamingUpdate(shouldInvalidate, shouldForceSelection);
    }, 100);
  }

  private startStreamingUpdate(
    shouldInvalidateActive = false,
    forceSelection = false,
  ): void {
    void this.updateStreamingView(shouldInvalidateActive, forceSelection).catch(
      (error: unknown) => {
        this.debug(
          `COPC streaming update failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  }

  private clearScheduledUpdate(): void {
    if (this.updateTimer !== undefined) {
      window.clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
    this.scheduledUpdateShouldInvalidate = false;
    this.scheduledUpdateForceSelection = false;
  }

  private observeCurrentCameraMotion():
    | ReturnType<LayerStreamingCore["observeCameraMotion"]>
    | undefined {
    if (!this.viewer) {
      return undefined;
    }
    const observation = this.core.observeCameraMotion(
      createCesiumStreamingView(this.viewer),
    );
    if (observation.sampledMovement) {
      this.scheduleMotionDecayUpdate();
    }
    return observation;
  }

  private scheduleMotionDecayUpdate(): void {
    this.clearMotionDecayTimer();
    this.motionDecayTimer = window.setTimeout(() => {
      this.motionDecayTimer = undefined;
      if (
        !this.viewer ||
        !this.core.getMetadata() ||
        this.lifecycle === "destroyed"
      ) {
        return;
      }
      const observation = this.core.observeCameraMotion(
        createCesiumStreamingView(this.viewer),
      );
      if (observation.priorityChanged) {
        void this.scheduleStreamingUpdate(false, true);
      }
    }, MOTION_LOOKAHEAD_DECAY_MS + 25);
  }

  private clearMotionDecayTimer(): void {
    if (this.motionDecayTimer !== undefined) {
      window.clearTimeout(this.motionDecayTimer);
      this.motionDecayTimer = undefined;
    }
  }

  private areRefinementFociEquivalent(
    left: RefinementFocus | undefined,
    right: RefinementFocus | undefined,
  ): boolean {
    return left === undefined || right === undefined
      ? left === right
      : left.type === right.type &&
          left.center.x === right.center.x &&
          left.center.y === right.center.y &&
          left.radius === right.radius &&
          left.detailBias === right.detailBias;
  }

  private isCurrentStreamingGeneration(
    generation: number,
    viewer: Cesium.Viewer,
  ): boolean {
    return (
      generation === this.streamingGeneration &&
      this.viewer === viewer &&
      this.lifecycle !== "destroyed"
    );
  }

  private getMaxRenderedPoints(): number {
    return (
      this.options.maxRenderedPoints ??
      this.options.streaming?.maxRenderedPoints ??
      DEFAULT_MAX_RENDERED_POINTS
    );
  }

  private debug(message: string): void {
    if (this.options.debug) {
      console.debug(`[CopcCesiumLayer] ${message}`);
    }
  }
}
