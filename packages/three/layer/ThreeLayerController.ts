import type * as THREE from "three";
import { getCopcPointFieldSelection } from "../../core/copc/points/fieldSelection";
import {
  inspectCopcPoint,
  type CopcPointInspection,
} from "../../core/copc/points/pointInspection";
import type { CopcMetadata } from "../../core/copc/types/copc";
import type { RenderablePointData } from "../../core/point/compactEPointCache";
import { createDatasetLocalFrame } from "../../core/coordinates/transform/datasetLocalFrame";
import type { DatasetLocalFrame } from "../../core/coordinates/types";
import {
  createLayerStreamingCore,
  getCachedRenderablePointDataForAdapter,
  type CopcStreamingProgressHandler,
  type CopcStreamingWorkProgressHandler,
} from "../../core/streaming/CopcStreamingCore";
import { assertCopcLayerOpacity } from "../../core/streaming/renderer";
import { areStreamingViewsEquivalent } from "../../core/streaming/areStreamingViewsEquivalent";
import { ReplacementTransitionManager } from "../../core/streaming/ReplacementTransitionManager";
import type {
  StreamingProgress,
  StreamingView,
} from "../../core/streaming/types";
import { DEFAULT_MAX_RENDERED_POINTS } from "../../core/streaming/NodeSelector";
import { MOTION_LOOKAHEAD_DECAY_MS } from "../../core/streaming/motionLookahead";
import type { NodePointCacheDiagnostics } from "../../core/streaming/createNodePointCache";
import type {
  CopcPointQuery,
  CopcPointQueryOptions,
} from "../../core/streaming/spatialPointQuery";
import {
  ThreePointRenderer,
  type ThreePointRendererOptions,
  type ThreePointRendererPerformanceStage,
} from "../render/ThreePointRenderer";
import { createThreeStreamingView } from "../view/ThreeViewAdapter";
import {
  createCopcPointStyleState,
  getDatasetElevationRange,
} from "../../core/point/style/pointStyle";
import { ThreePointPicker } from "../picking/ThreePointPicker";
import {
  CopcThreeLayerEventDispatcher,
  type CopcThreeLayerEventMap,
  type CopcThreeLayerEventType,
} from "../events/CopcThreeLayerEvents";
import {
  CopcLayerEventLifecycle,
  type CopcViewCancellationReason,
  snapshotCopcError,
  snapshotCopcMetadata,
} from "../../core/events/layerEventLifecycle";
import type {
  CopcThreeLayerAttachment,
  CopcThreeLayerLifecycleState,
  CopcThreeLayerOptions,
  CopcThreeLayerPickOptions,
  CopcThreeLayerPickPosition,
  CopcThreeLayerSnapshot,
  CopcThreePointRenderer,
  CopcThreeRendererPerformanceSnapshot,
} from "./types";
import { getCopcSourceIdentity } from "../../core/copc/getter/createCopcGetter";
import { resolveCopcExtraDimensionSelection } from "../../core/copc/points/extraDimensions";
import {
  cloneCopcElevationRange,
  cloneCopcElevationStyle,
  cloneCopcDimensionStyle,
  isCopcDimensionMetadataStyleable,
} from "../../core/point/style/pointStyle";
import { createCopcPointFieldSelection } from "../../core/copc/points/fieldSelection";

type ActiveStreamingUpdate = {
  progressApplied: boolean;
};

type LayerStreamingCore = ReturnType<typeof createLayerStreamingCore>;

function createRendererPerformanceSnapshot(): CopcThreeRendererPerformanceSnapshot {
  return {
    worldToLocalDurationMs: 0,
    geometryCreationDurationMs: 0,
    materialCreationDurationMs: 0,
    rendererPreparationDurationMs: 0,
    nodeRemovalDurationMs: 0,
  };
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Owns Three.js layer lifecycle, streaming state, and renderer coordination. */
export class ThreeLayerController {
  private readonly eventDispatcher: CopcThreeLayerEventDispatcher;
  private readonly eventLifecycle = new CopcLayerEventLifecycle();
  private readonly core: LayerStreamingCore;
  private readonly options: CopcThreeLayerOptions;
  private readonly extraDimensionNames: readonly string[];
  private readonly pointRenderer: CopcThreePointRenderer;
  private opacity?: number;
  private readonly pointPicker: ThreePointPicker;
  private readonly pointStyleState = createCopcPointStyleState();
  private datasetElevationRange?: { min: number; max: number };
  private attachment?: CopcThreeLayerAttachment;
  private localFrame?: DatasetLocalFrame;
  private lifecycle: CopcThreeLayerLifecycleState = "idle";
  private loadGeneration = 0;
  private loadOperationGeneration?: number;
  private firstVisibleLoadGeneration?: number;
  private streamingGeneration = 0;
  private lastStreamingView?: StreamingView;
  private updatePending = false;
  private pendingForceSelection = false;
  private updateInFlight = false;
  private updateInFlightPromise?: Promise<void>;
  private motionDecayTimer?: ReturnType<typeof setTimeout>;
  private activeStreamingUpdate?: ActiveStreamingUpdate;
  private readonly replacementTransitions: ReplacementTransitionManager;
  private rendererPerformance = createRendererPerformanceSnapshot();

  /**
   * Create an unloaded layer for a browser-readable COPC resource.
   *
   * @param options Source URL, backend, streaming limits, renderer, and callbacks.
   * @throws If the URL is empty, `pickingThreshold` is invalid, opacity is outside `[0, 1]`, or a custom renderer lacks opacity support.
   */
  constructor(options: CopcThreeLayerOptions, eventTarget: object) {
    if (
      !options ||
      options.url === undefined ||
      options.url === null ||
      (typeof options.url === "string" && options.url.length === 0)
    ) {
      throw new Error("CopcThreeLayer requires a COPC source");
    }
    if (
      options.pickingThreshold !== undefined &&
      !isFinitePositive(options.pickingThreshold)
    ) {
      throw new Error(
        "CopcThreeLayer pickingThreshold must be a positive finite number",
      );
    }
    if (options.opacity !== undefined) {
      assertCopcLayerOpacity(options.opacity);
    }
    if (options.colorMode === "dimension" && options.dimension === undefined) {
      throw new TypeError(
        'colorMode "dimension" requires a dimension style with a name and range',
      );
    }
    if (options.dimension !== undefined) {
      options = { ...options, dimension: cloneCopcDimensionStyle(options.dimension) };
    }
    if (options.elevationRange !== undefined) {
      options = {
        ...options,
        elevationRange: cloneCopcElevationRange(options.elevationRange),
      };
    }
    if (options.elevationStyle !== undefined) {
      options = {
        ...options,
        elevationStyle: cloneCopcElevationStyle(options.elevationStyle),
      };
    }

    this.options = options;
    this.extraDimensionNames =
      resolveCopcExtraDimensionSelection(options.extraDimensions, [
        options.dimension?.name,
      ]) ?? [];
    this.opacity = options.opacity;
    this.eventDispatcher = new CopcThreeLayerEventDispatcher(eventTarget);
    this.pointRenderer = options.renderer ?? new ThreePointRenderer();
    if (options.opacity !== undefined) {
      if (!this.pointRenderer.setOpacity) {
        throw new TypeError(
          "Configured Three.js point renderer does not support layer opacity",
        );
      }
      this.pointRenderer.setOpacity(options.opacity);
    }
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
      pointFields: (() => {
        const fields = new Set(
          getCopcPointFieldSelection(options.colorMode ?? "fixed"),
        );
        if (options.dimension?.name === "Intensity") fields.add("intensity");
        return createCopcPointFieldSelection(fields);
      })(),
      ...(this.extraDimensionNames.length === 0
        ? {}
        : { extraDimensions: this.extraDimensionNames }),
      streaming: options.streaming,
    }, options.coordinateCacheLayout ?? "E", {
      sourceCoordinates: options.retainSourceCoordinatesForQueries === true,
    });
    this.pointPicker = new ThreePointPicker({
      getRoot: () => this.pointRenderer.getRoot(),
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
      getLoadGeneration: () => this.loadGeneration,
      pickingThreshold: options.pickingThreshold,
      onPointPicked: options.onPointPicked,
    });
    this.replacementTransitions = new ReplacementTransitionManager({
      renderer: this.pointRenderer,
      getHierarchyNodePointCount: (nodeKey) =>
        this.core.getHierarchyNode(nodeKey)?.node.pointCount,
      removeNode: (nodeKey) => this.removeRenderedNode(nodeKey),
    });
  }

  /** Subscribe to a typed layer lifecycle event. Listener failures are reported to `console.error`. */
  addEventListener<TType extends CopcThreeLayerEventType>(
    type: TType,
    listener: (event: CopcThreeLayerEventMap[TType]) => void,
  ): void {
    this.eventDispatcher.addEventListener(type, listener);
  }

  /** Remove a listener previously registered for the same event and function. */
  removeEventListener<TType extends CopcThreeLayerEventType>(
    type: TType,
    listener: (event: CopcThreeLayerEventMap[TType]) => void,
  ): void {
    this.eventDispatcher.removeEventListener(type, listener);
  }

  /**
   * Attach the layer-owned root group and camera integration to caller-owned objects.
   *
   * Reattaching replaces the previous attachment. Call {@link update} after
   * camera movement; this method does not take ownership of or dispose the
   * supplied scene, camera, or renderer.
   *
   * @throws If the layer is destroyed or the attachment lacks a usable scene or camera.
   */
  attachTo(attachment: CopcThreeLayerAttachment): void {
    if (this.isDestroyed()) {
      throw new Error("CopcThreeLayer has been destroyed");
    }
    if (
      !attachment ||
      !attachment.scene ||
      typeof attachment.scene.add !== "function"
    ) {
      throw new Error("CopcThreeLayer requires a Three.js scene");
    }
    if (
      !attachment.camera ||
      typeof attachment.camera.getWorldPosition !== "function"
    ) {
      throw new Error("CopcThreeLayer requires a Three.js camera");
    }
    if (this.attachment === attachment) {
      return;
    }
    if (this.attachment) {
      this.detachFrom();
    }
    if (this.isDestroyed()) {
      throw new Error("CopcThreeLayer has been destroyed");
    }

    this.attachment = attachment;
    this.pointRenderer.attachTo(attachment.scene);
    this.applyLocalFrame();
    if (this.lifecycle !== "loading") {
      this.lifecycle = this.core.getMetadata() ? "ready" : "mounted";
    }
  }

  /** Detach the root and cancel active view work while retaining loaded metadata and hierarchy. */
  detachFrom(): void {
    if (this.isDestroyed()) {
      return;
    }

    this.cancelActiveView("detach");
    if (this.isDestroyed()) {
      return;
    }
    this.streamingGeneration += 1;
    this.core.invalidateView();
    this.updatePending = false;
    this.pendingForceSelection = false;
    this.clearMotionDecayTimer();
    this.core.resetCameraMotion();
    this.pointRenderer.detachFrom();
    this.replacementTransitions.reset();
    this.pointPicker.clear();
    this.lastStreamingView = undefined;
    this.activeStreamingUpdate = undefined;
    this.attachment = undefined;
    this.resetRendererPerformance();
    if (this.lifecycle !== "loading") {
      this.lifecycle = this.core.getMetadata() ? "ready" : "idle";
    }
  }

  /**
   * Load source metadata and the root hierarchy; no point nodes are downloaded by this call.
   *
   * The layer may be loaded before it is attached. When it resolves, metadata
   * and hierarchy are ready for view-driven streaming, but the dataset is not
   * necessarily downloaded or rendered in full.
   *
   * @throws If the layer is destroyed, already loading/loaded, or source initialization fails.
   */
  async load(): Promise<void> {
    if (this.lifecycle === "destroyed") {
      throw new Error("CopcThreeLayer has been destroyed");
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
    const loadGeneration = ++this.loadGeneration;
    this.loadOperationGeneration = loadGeneration;
    try {
      await this.core.load();
      if (loadGeneration !== this.loadGeneration) {
        return;
      }

      const metadata = this.core.getMetadata();
      if (!metadata) {
        throw new Error("COPC layer loaded without metadata");
      }
      const dimensionName = this.options.dimension?.name;
      if (dimensionName && dimensionName !== "Intensity") {
        const descriptor = metadata.extraDimensions?.find(
          (dimension) => dimension.name === dimensionName,
        );
        if (!descriptor) {
          const backend = this.options.backend === "rust" ? "Rust" : "selected";
          throw new Error(
            `The ${backend} COPC backend does not expose Extra Bytes dimension ${dimensionName}; use the copc-js backend for numeric Extra Bytes styling.`,
          );
        }
        if (!isCopcDimensionMetadataStyleable(descriptor)) {
          throw new Error(
            `Extra Bytes dimension ${dimensionName} is not supported for numeric styling; supported types are signed/unsigned 8-, 16-, and 32-bit integers and 32-/64-bit floats.`,
          );
        }
        if (
          descriptor.noData !== undefined &&
          this.options.dimension !== undefined &&
          this.options.dimension.missingValue === undefined
        ) {
          this.options.dimension = cloneCopcDimensionStyle({
            ...this.options.dimension,
            missingValue: descriptor.noData,
          });
        }
      }
      this.localFrame = createDatasetLocalFrame(
        metadata,
        this.options.heightOffsetMeters,
        this.options.verticalTransform,
      );
      this.datasetElevationRange = getDatasetElevationRange(
        metadata,
        this.options.heightOffsetMeters,
        this.options.verticalTransform,
      );
      this.applyLocalFrame();
      this.lifecycle = "ready";
      this.debug("COPC metadata and hierarchy loaded");
      this.firstVisibleLoadGeneration = undefined;
      this.eventDispatcher.dispatchEvent({
        type: "metadataready",
        metadata: snapshotCopcMetadata(metadata),
        loadGeneration,
      });
    } catch (error: unknown) {
      if (loadGeneration === this.loadGeneration) {
        this.eventDispatcher.dispatchEvent({
          type: "error",
          error: snapshotCopcError(error),
          phase: "load",
          loadGeneration,
        });
        this.unloadInternal("unload");
      }
      throw error;
    } finally {
      if (this.loadOperationGeneration === loadGeneration) {
        this.loadOperationGeneration = undefined;
      }
    }
  }

  /**
   * Recompute the current camera view and stream its selected nodes.
   *
   * Resolves after the coalesced current-view work and renderer commits finish.
   * It does not call the application's render loop or schedule animation frames.
   * An unattached or not-yet-loaded layer resolves without doing work.
   *
   * @throws If the layer has been destroyed.
   */
  update(): Promise<void> {
    return this.updateCurrentView(false);
  }

  private updateCurrentView(forceSelection: boolean): Promise<void> {
    if (this.lifecycle === "destroyed") {
      throw new Error("CopcThreeLayer has been destroyed");
    }
    const attachment = this.attachment;
    if (
      !attachment ||
      !this.core.getMetadata() ||
      this.lifecycle === "loading"
    ) {
      return Promise.resolve();
    }

    const view = this.createView(attachment);
    const motion = this.core.observeCameraMotion(view);
    if (motion.sampledMovement) {
      this.scheduleMotionDecayUpdate();
    }
    const viewEquivalent =
      this.lastStreamingView !== undefined &&
      areStreamingViewsEquivalent(this.lastStreamingView, view);
    const shouldForceSelection =
      forceSelection || (viewEquivalent && motion.priorityChanged);
    if (this.updateInFlight) {
      if (!viewEquivalent || shouldForceSelection) {
        this.updatePending = true;
        this.pendingForceSelection ||= shouldForceSelection;
        if (!viewEquivalent) {
          this.streamingGeneration += 1;
          // The recorded view belongs to the invalidated generation. Clearing it
          // prevents a retry from being mistaken for an unchanged view if the
          // camera returns to that generation before the stale update settles.
          this.lastStreamingView = undefined;
          this.core.invalidateView();
          this.cancelActiveView("camera-change");
          if (this.isDestroyed()) {
            return this.updateInFlightPromise ?? Promise.resolve();
          }
        }
      }
      return this.updateInFlightPromise ?? Promise.resolve();
    }
    if (viewEquivalent && !shouldForceSelection) {
      return Promise.resolve();
    }

    this.updatePending = true;
    this.pendingForceSelection ||= shouldForceSelection;
    const updatePromise = this.runPendingStreamingUpdates();
    this.updateInFlightPromise = updatePromise;
    this.updateInFlight = true;
    void updatePromise.then(
      () => {
        if (this.updateInFlightPromise === updatePromise) {
          this.updateInFlightPromise = undefined;
          this.updateInFlight = false;
        }
      },
      () => {
        if (this.updateInFlightPromise === updatePromise) {
          this.updateInFlightPromise = undefined;
          this.updateInFlight = false;
        }
      },
    );
    return updatePromise;
  }

  /** Release loaded source data and rendered nodes while retaining the scene attachment. */
  unload(): void {
    if (this.isDestroyed()) {
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
    this.loadGeneration += 1;
    this.streamingGeneration += 1;
    this.updatePending = false;
    this.pendingForceSelection = false;
    this.clearMotionDecayTimer();
    this.core.unload();
    this.datasetElevationRange = undefined;
    this.pointRenderer.clear();
    this.pointStyleState.reset();
    this.replacementTransitions.reset();
    this.pointPicker.clear();
    this.lastStreamingView = undefined;
    this.activeStreamingUpdate = undefined;
    this.localFrame = undefined;
    this.resetRendererPerformance();
    this.lifecycle = this.attachment ? "mounted" : "idle";
    this.debug("COPC layer unloaded");
  }

  /** Unload the current source and load the configured COPC resource again. */
  async reload(): Promise<void> {
    if (this.lifecycle === "destroyed") {
      throw new Error("CopcThreeLayer has been destroyed");
    }
    this.unloadInternal("reload");
    await this.load();
  }

  /** Permanently release layer-owned resources without disposing caller-owned scene, camera, or renderer. */
  destroy(): void {
    if (this.lifecycle === "destroyed") {
      return;
    }

    this.lifecycle = "destroyed";
    this.loadGeneration += 1;
    this.streamingGeneration += 1;
    this.cancelActiveView("destroy");
    this.core.destroy();
    this.updatePending = false;
    this.pendingForceSelection = false;
    this.clearMotionDecayTimer();
    this.pointRenderer.detachFrom();
    this.replacementTransitions.reset();
    this.pointPicker.clear();
    this.lastStreamingView = undefined;
    this.activeStreamingUpdate = undefined;
    this.attachment = undefined;
    this.localFrame = undefined;
    this.resetRendererPerformance();
    this.pointRenderer.destroy();
    this.eventDispatcher.dispose();
  }

  /** Return the layer-owned root group for picking or application composition. */
  getRoot(): THREE.Group {
    return this.pointRenderer.getRoot();
  }

  /** Return the fixed dataset-local frame used by the layer, when loaded. */
  getLocalFrame(): DatasetLocalFrame | undefined {
    return this.localFrame;
  }

  /** Return source metadata after {@link load} has completed. */
  getMetadata(): CopcMetadata | undefined {
    return this.core.getMetadata();
  }

  /** Stream source-coordinate points from an inclusive AABB without changing the current render selection. */
  queryPoints(options: CopcPointQueryOptions): CopcPointQuery {
    return this.core.queryPoints(options);
  }

  /** Return hierarchy request and page-cache counters when available. */
  getHierarchyDiagnostics() {
    return this.core.getHierarchyDiagnostics();
  }

  /** Return decoded CPU point-buffer cache counters and retained bytes. */
  getPointCacheDiagnostics(): NodePointCacheDiagnostics {
    return this.core.getPointCacheDiagnostics();
  }

  /** Return the selected hierarchy node keys for the most recent view. */
  getCurrentSelection(): string[] {
    return this.core.getCurrentSelection();
  }

  /** Return node keys currently committed to the renderer. */
  getRenderedNodeKeys(): string[] {
    return this.pointRenderer.getRenderedNodeKeys();
  }

  /** Return the number of points currently committed to the renderer. */
  getRenderedPointCount(): number {
    return this.pointRenderer.getRenderedPointCount();
  }

  /** Update the layer's alpha without refetching or decoding point data. */
  setOpacity(opacity: number): void {
    if (this.isDestroyed()) {
      throw new Error("CopcThreeLayer has been destroyed");
    }
    assertCopcLayerOpacity(opacity);
    if (!this.pointRenderer.setOpacity) {
      throw new TypeError(
        "Configured Three.js point renderer does not support layer opacity",
      );
    }
    this.pointRenderer.setOpacity(opacity);
    this.opacity = opacity;
    if (opacity === 0) {
      this.pointPicker.clear();
    }
  }

  /** Return the selected point while its node and decoded buffer are live. */
  getSelectedPoint(): CopcPointInspection | undefined {
    return this.pointPicker.getSelectedPoint();
  }

  /**
   * Raycast in normalized device coordinates and resolve the first owned COPC
   * point through the current decoded cache. The threshold is a positive
   * finite distance in Three.js scene units; omitted values use the layer
   * setting or 1. The supplied raycaster, when present, is updated in place.
   * Returns `undefined` when there is no attached view or no live layer-owned hit.
   *
   * @throws If the effective point threshold is not positive and finite.
   */
  pick(
    position: CopcThreeLayerPickPosition,
    raycasterOrOptions?: THREE.Raycaster | CopcThreeLayerPickOptions,
  ): CopcPointInspection | undefined {
    if (this.opacity === 0) {
      this.pointPicker.clear();
      return undefined;
    }
    const attachment = this.attachment;
    if (!attachment || !this.localFrame) {
      this.pointPicker.clear();
      return undefined;
    }
    return this.pointPicker.pick(
      position,
      attachment.camera,
      raycasterOrOptions,
    );
  }

  /** Return a fresh diagnostics snapshot; the returned arrays/objects are not live views. */
  getSnapshot(): CopcThreeLayerSnapshot {
    const coreSnapshot = this.core.getSnapshot();
    return {
      lifecycle: this.lifecycle,
      attached: this.attachment !== undefined,
      datasetUrl: getCopcSourceIdentity(this.options.url),
      backend: coreSnapshot.backend,
      selectedNodeKeys: coreSnapshot.selectedNodeKeys,
      renderedNodeKeys: this.getRenderedNodeKeys(),
      renderedPointCount: this.getRenderedPointCount(),
      streamingUpdateCount:
        coreSnapshot.streamingUpdateCount +
        (this.activeStreamingUpdate?.progressApplied ? 1 : 0),
      performance: coreSnapshot.performance,
      renderer: { ...this.rendererPerformance },
      transition: this.replacementTransitions.getDiagnostics(),
      ...(coreSnapshot.viewDistance
        ? { viewDistance: coreSnapshot.viewDistance }
        : {}),
      ...(coreSnapshot.hierarchy ? { hierarchy: coreSnapshot.hierarchy } : {}),
      pointCache: coreSnapshot.pointCache,
      ...(coreSnapshot.worker ? { worker: coreSnapshot.worker } : {}),
      ...(coreSnapshot.predictivePrefetch
        ? { predictivePrefetch: coreSnapshot.predictivePrefetch }
        : {}),
    };
  }

  private async runPendingStreamingUpdates(): Promise<void> {
    while (this.updatePending) {
      const forceSelection = this.pendingForceSelection;
      this.pendingForceSelection = false;
      this.updatePending = false;
      await this.performStreamingUpdate(forceSelection);
    }
  }

  private async performStreamingUpdate(forceSelection = false): Promise<void> {
    const attachment = this.attachment;
    if (
      !attachment ||
      !this.core.getMetadata() ||
      this.lifecycle === "destroyed"
    ) {
      return;
    }

    const generation = ++this.streamingGeneration;
    const view = this.createView(attachment);
    if (
      !forceSelection &&
      this.lastStreamingView &&
      areStreamingViewsEquivalent(this.lastStreamingView, view)
    ) {
      return;
    }
    const begunView = this.eventLifecycle.beginView();
    if (begunView.superseded) {
      this.eventDispatcher.dispatchEvent({
        type: "viewcancelled",
        ...begunView.superseded,
      });
    }
    const publicViewGeneration = begunView.viewGeneration;
    if (
      this.isDestroyed() ||
      !this.eventLifecycle.isActiveView(publicViewGeneration)
    ) {
      return;
    }
    this.lastStreamingView = view;
    const activeStreamingUpdate: ActiveStreamingUpdate = {
      progressApplied: false,
    };
    this.activeStreamingUpdate = activeStreamingUpdate;
    let progressApplied = false;
    let lastQueuedNodeCount: number | undefined;
    let lastActiveNodeCount: number | undefined;
    const onProgress: CopcStreamingProgressHandler<RenderablePointData> = (
      progress,
    ) => {
      if (
        !this.isCurrentStreamingGeneration(generation, attachment) ||
        !this.eventLifecycle.isActiveView(publicViewGeneration)
      ) {
        return;
      }
      progressApplied = true;
      if (progress.loadedNodePoints.size > 0) {
        activeStreamingUpdate.progressApplied = true;
      }
      this.applyStreamingProgress(progress, generation, publicViewGeneration);
    };
    const onWorkProgress: CopcStreamingWorkProgressHandler | undefined =
      this.eventDispatcher.hasEventListener("progress")
        ? (progress) => {
            if (
              !this.isCurrentStreamingGeneration(generation, attachment) ||
              !this.eventLifecycle.isActiveView(publicViewGeneration) ||
              (progress.queuedNodeCount === lastQueuedNodeCount &&
                progress.activeNodeCount === lastActiveNodeCount)
            ) {
              return;
            }
            lastQueuedNodeCount = progress.queuedNodeCount;
            lastActiveNodeCount = progress.activeNodeCount;
            this.eventDispatcher.dispatchEvent({
              type: "progress",
              queuedNodeCount: progress.queuedNodeCount,
              activeNodeCount: progress.activeNodeCount,
              viewGeneration: publicViewGeneration,
            });
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
        this.eventDispatcher.dispatchEvent({
          type: "error",
          error: snapshotCopcError(error),
          phase: "view",
          viewGeneration: publicViewGeneration,
        });
      }
      if (this.activeStreamingUpdate === activeStreamingUpdate) {
        this.activeStreamingUpdate = undefined;
      }
      throw error;
    }
    if (this.activeStreamingUpdate === activeStreamingUpdate) {
      this.activeStreamingUpdate = undefined;
    }
    if (!this.isCurrentStreamingGeneration(generation, attachment) || !update) {
      if (this.eventLifecycle.isActiveView(publicViewGeneration)) {
        this.cancelActiveView("camera-change");
      }
      return;
    }
    if (!progressApplied) {
      this.applyStreamingProgress(
        {
          ...update,
          completedBatchPointCount: update.loadedNodePoints.size,
        },
        generation,
        publicViewGeneration,
      );
    }
    if (
      this.eventLifecycle.isActiveView(publicViewGeneration) &&
      this.replacementTransitions.isViewRendererCommitted(
        update.selectedNodeKeys,
        update.loadedNodePoints,
        publicViewGeneration,
      ) &&
      this.eventLifecycle.settleView(publicViewGeneration)
    ) {
      this.eventDispatcher.dispatchEvent({
        type: "viewsettled",
        viewGeneration: publicViewGeneration,
        selectedNodeKeys: Object.freeze([...update.selectedNodeKeys]),
      });
    }
  }

  private scheduleMotionDecayUpdate(): void {
    this.clearMotionDecayTimer();
    this.motionDecayTimer = setTimeout(() => {
      this.motionDecayTimer = undefined;
      const attachment = this.attachment;
      if (
        !attachment ||
        !this.core.getMetadata() ||
        this.lifecycle === "destroyed"
      ) {
        return;
      }
      const observation = this.core.observeCameraMotion(
        this.createView(attachment),
      );
      if (observation.priorityChanged) {
        void this.updateCurrentView(true);
      }
    }, MOTION_LOOKAHEAD_DECAY_MS + 25);
  }

  private clearMotionDecayTimer(): void {
    if (this.motionDecayTimer !== undefined) {
      clearTimeout(this.motionDecayTimer);
      this.motionDecayTimer = undefined;
    }
  }

  private applyStreamingProgress(
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
        this.removeRenderedNode(nodeKey);
      }
    }
    for (const [nodeKey, points] of progress.loadedNodePoints) {
      if (
        !progress.selectedNodeKeys.includes(nodeKey) ||
        this.pointRenderer.hasNode(nodeKey)
      ) {
        continue;
      }
      if (
        this.replacementTransitions.getProjectedPointCount(
          nodeKey,
          points.pointCount,
        ) > this.getMaxRenderedPoints()
      ) {
        continue;
      }
      this.addRenderedNode(nodeKey, points);
      if (
        points.pointCount > 0 &&
        this.pointRenderer.hasNode(nodeKey) &&
        this.firstVisibleLoadGeneration !== this.loadGeneration
      ) {
        this.firstVisibleLoadGeneration = this.loadGeneration;
        this.eventDispatcher.dispatchEvent({
          type: "firstvisible",
          loadGeneration: this.loadGeneration,
          viewGeneration,
        });
        if (generation !== this.streamingGeneration || this.isDestroyed()) {
          return;
        }
      }
    }

    this.replacementTransitions.commitReady(generation);
    this.replacementTransitions.updateDiagnostics();
  }

  private addRenderedNode(nodeKey: string, points: RenderablePointData): void {
    this.pointRenderer.addOrUpdateNode(nodeKey, points, {
      pointSize: this.options.pointSize ?? 3,
      colorMode: this.options.colorMode ?? "fixed",
      dimension: this.options.dimension,
      elevationRange: this.options.elevationRange ?? this.datasetElevationRange,
      elevationStyle: this.options.elevationStyle,
      rgbMax: this.pointStyleState.getRgbMax(points),
      pointId: (pointIndex) => ({
        nodeKey,
        pointIndex,
        ownerId: this.pointPicker.ownerId,
      }),
      onPerformance: (
        stage: ThreePointRendererPerformanceStage,
        durationMs: number,
      ) => {
        const metric =
          `${stage}DurationMs` as keyof CopcThreeRendererPerformanceSnapshot;
        if (metric in this.rendererPerformance) {
          this.rendererPerformance[metric] += durationMs;
        }
      },
    } satisfies ThreePointRendererOptions);
  }

  private cancelActiveView(reason: CopcViewCancellationReason): void {
    const cancelled = this.eventLifecycle.cancelView(reason);
    if (cancelled) {
      this.eventDispatcher.dispatchEvent({
        type: "viewcancelled",
        ...cancelled,
      });
    }
  }

  private isDestroyed(): boolean {
    return this.lifecycle === "destroyed";
  }

  private removeRenderedNode(nodeKey: string): void {
    this.pointPicker.clearIfNode(nodeKey);
    this.pointRenderer.removeNode(nodeKey);
  }

  private createView(attachment: CopcThreeLayerAttachment): StreamingView {
    if (!this.localFrame) {
      throw new Error("CopcThreeLayer has no dataset-local frame");
    }
    return createThreeStreamingView({
      camera: attachment.camera,
      frame: this.localFrame,
      renderer: attachment.renderer,
      maxRenderDistanceMeters: this.getMaxRenderDistanceMeters(),
    });
  }

  private applyLocalFrame(): void {
    if (this.localFrame) {
      this.pointRenderer.setLocalFrame?.(this.localFrame);
    }
  }

  private getMaxRenderDistanceMeters(): number {
    const value = this.options.streaming?.maxRenderDistanceMeters;
    return value !== undefined && isFinitePositive(value) ? value : 12000;
  }

  private getMaxRenderedPoints(): number {
    const value =
      this.options.maxRenderedPoints ??
      this.options.streaming?.maxRenderedPoints;
    return value !== undefined && isFinitePositive(value)
      ? value
      : DEFAULT_MAX_RENDERED_POINTS;
  }

  private resetRendererPerformance(): void {
    this.rendererPerformance = createRendererPerformanceSnapshot();
  }

  private isCurrentStreamingGeneration(
    generation: number,
    attachment: CopcThreeLayerAttachment,
  ): boolean {
    return (
      generation === this.streamingGeneration &&
      this.attachment === attachment &&
      this.lifecycle !== "destroyed"
    );
  }

  private debug(message: string): void {
    if (this.options.debug) {
      console.debug(`[CopcThreeLayer] ${message}`);
    }
  }
}
