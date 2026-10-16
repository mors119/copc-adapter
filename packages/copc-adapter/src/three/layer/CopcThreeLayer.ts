import * as THREE from 'three';
import {
  getCopcPointFieldSelection,
  type CopcColorMode,
} from '../../core/copc/points/fieldSelection';
import type {
  CopcBackendName,
  CopcBackendSelection,
} from '../../core/copc/backend/selection';
import type { CopcWorkerDiagnostics } from '../../core/copc/backend/types';
import {
  inspectCopcPoint,
  isCopcPointPickId,
  type CopcPointInspection,
  type CopcPointPickId,
} from '../../core/copc/points/pointInspection';
import type {
  CopcMetadata,
  GeographicPointBuffer,
  PreparedPointData,
} from '../../core/copc/types/copc';
import {
  createDatasetLocalFrame,
} from '../../core/coordinates/transform/datasetLocalFrame';
import type { DatasetLocalFrame } from '../../core/coordinates/types';
import {
  CopcStreamingCore,
  type CopcStreamingPerformanceSnapshot,
  type CopcStreamingProgressHandler,
  type CopcStreamingWorkProgressHandler,
} from '../../core/streaming/CopcStreamingController';
import type {
  StreamingProgress,
  StreamingReplacementGroup,
  StreamingReplacementKind,
  StreamingSelectionOptions,
  StreamingView,
} from '../../core/streaming/types';
import { DEFAULT_MAX_RENDERED_POINTS } from '../../core/streaming/NodeSelector';
import type { NodePointCacheDiagnostics } from '../../core/streaming/createNodePointCache';
import type { AdaptiveViewDistanceDiagnostics } from '../../core/streaming/view';
import type { RangeValidationPolicy } from '../../core/copc/range/types';
import {
  ThreePointRenderer,
  type ThreePointRendererOptions,
  type ThreePointRendererPerformanceStage,
} from '../render/ThreePointRenderer';
import {
  createThreeStreamingView,
  type ThreeViewportSource,
} from '../view/ThreeViewAdapter';
import type { CopcPointRenderer } from '../../core/streaming/renderer';
import {
  createCopcPointStyleState,
  getDatasetElevationRange,
} from '../../core/point/style/pointStyle';
import {
  CopcThreeLayerEventDispatcher,
  CopcLayerEventLifecycle,
  type CopcThreeLayerEventMap,
  type CopcThreeLayerEventType,
  type CopcViewCancellationReason,
  snapshotCopcError,
  snapshotCopcMetadata,
} from '../../core/events/layerEventLifecycle';

export type {
  CopcLayerErrorEvent,
  CopcThreeLayerEventMap,
  CopcThreeLayerEventType,
  CopcThreeLayerErrorEvent,
  CopcThreeLayerFirstVisibleEvent,
  CopcThreeLayerMetadataReadyEvent,
  CopcThreeLayerProgressEvent,
  CopcThreeLayerViewCancelledEvent,
  CopcThreeLayerViewSettledEvent,
  CopcViewCancellationReason,
} from '../../core/events/layerEventLifecycle';

/** Configuration for a {@link CopcThreeLayer} and its shared streaming core. */
export type CopcThreeLayerOptions = {
  /** Browser-readable COPC resource URL with HTTP range-request support. */
  url: string;
  /** Three.js point size in screen-facing pixels. Defaults to 3. */
  pointSize?: number;
  /** Point color mapping. Defaults to the fixed cyan fallback. */
  colorMode?: CopcColorMode;
  /** Manual additive correction in metres applied to ellipsoidal point height. Defaults to 0. */
  heightOffsetMeters?: number;
  /** Maximum estimated points in the active current-view workload; defaults to 250,000. */
  maxRenderedPoints?: number;
  /** Overrides for the shared streaming limits; unspecified values use core defaults. */
  streaming?: Partial<StreamingSelectionOptions>;
  /** Defaults to stable `copc-js`; `rust` is explicit opt-in. */
  backend?: CopcBackendSelection;
  /** Decoder used to convert point-data views into project point buffers. */
  decoder?: import('../../core/copc/points/types').CopcPointDecoder;
  /** Maximum retained decoded CPU point-buffer bytes; defaults to 256 MiB. */
  maxPointCacheBytes?: number;
  /** Defaults to strict Content-Range validation. */
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
  | 'idle'
  /** Attached to a scene without loaded metadata. */
  | 'mounted'
  /** Metadata and root hierarchy load is in progress. */
  | 'loading'
  /** Metadata and root hierarchy are available; point nodes stream per view. */
  | 'ready'
  /** Permanently destroyed; only repeated `destroy()` calls are harmless. */
  | 'destroyed';

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
  backend: CopcBackendName | 'custom';
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
  hierarchy?: import('../../core/copc/hierarchy/types').CopcHierarchyDiagnostics;
  /** Decoded CPU point-buffer cache counters and retained bytes. */
  pointCache: NodePointCacheDiagnostics;
  /** Rust/WASM worker queue counters, when that backend exposes them. */
  worker?: CopcWorkerDiagnostics;
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
    points: GeographicPointBuffer | PreparedPointData,
    options: ThreePointRendererOptions,
  ): void;
  /** Install the dataset frame before adding local point geometry, when supported. */
  setLocalFrame?(frame: DatasetLocalFrame): void;
}

type ActiveReplacementGroup = StreamingReplacementGroup & {
  generation: number;
  viewGeneration: number;
};

type ActiveStreamingUpdate = {
  progressApplied: boolean;
};

function createTransitionDiagnostics(): CopcThreeLayerTransitionDiagnostics {
  return {
    activeReplacementGroupCount: 0,
    replacementGroupsWaitingCount: 0,
    refinementReplacementCommitCount: 0,
    collapseReplacementCommitCount: 0,
    staleReplacementCancellationCount: 0,
    coarseNodesRetainedForCoverageCount: 0,
  };
}

function createRendererPerformanceSnapshot(): CopcThreeRendererPerformanceSnapshot {
  return {
    worldToLocalDurationMs: 0,
    geometryCreationDurationMs: 0,
    materialCreationDurationMs: 0,
    rendererPreparationDurationMs: 0,
    nodeRemovalDurationMs: 0,
  };
}

const STREAMING_VIEW_POSITION_EPSILON = 0.1;
const STREAMING_VIEW_ANGLE_EPSILON = 1e-5;
const STREAMING_VIEW_DISTANCE_EPSILON = 1;

function isClose(left: number, right: number, epsilon: number): boolean {
  return Math.abs(left - right) <= epsilon;
}

function areStreamingViewsEquivalent(left: StreamingView, right: StreamingView): boolean {
  if (!isClose(left.longitude, right.longitude, 1e-7)
    || !isClose(left.latitude, right.latitude, 1e-7)
    || !isClose(left.height, right.height, STREAMING_VIEW_POSITION_EPSILON)
    || !isClose(left.viewDistanceMeters, right.viewDistanceMeters, STREAMING_VIEW_DISTANCE_EPSILON)) {
    return false;
  }

  const leftFrustum = left.viewFrustum;
  const rightFrustum = right.viewFrustum;
  if (!leftFrustum || !rightFrustum) {
    return leftFrustum === rightFrustum;
  }

  return [
    [leftFrustum.position, rightFrustum.position],
    [leftFrustum.direction, rightFrustum.direction],
    [leftFrustum.up, rightFrustum.up],
    [leftFrustum.right, rightFrustum.right],
  ].every(([leftVector, rightVector]) =>
    isClose(leftVector.x, rightVector.x, STREAMING_VIEW_ANGLE_EPSILON)
      && isClose(leftVector.y, rightVector.y, STREAMING_VIEW_ANGLE_EPSILON)
      && isClose(leftVector.z, rightVector.z, STREAMING_VIEW_ANGLE_EPSILON),
  )
    && isClose(leftFrustum.verticalFovRadians, rightFrustum.verticalFovRadians, STREAMING_VIEW_ANGLE_EPSILON)
    && isClose(leftFrustum.aspectRatio, rightFrustum.aspectRatio, STREAMING_VIEW_ANGLE_EPSILON)
    && isClose(leftFrustum.viewportHeightPixels, rightFrustum.viewportHeightPixels, 1)
    && isClose(leftFrustum.nearMeters, rightFrustum.nearMeters, STREAMING_VIEW_DISTANCE_EPSILON)
    && isClose(leftFrustum.farMeters, rightFrustum.farMeters, STREAMING_VIEW_DISTANCE_EPSILON);
}

function isPickOptions(value: unknown): value is CopcThreeLayerPickOptions {
  return value !== null
    && typeof value === 'object'
    && ('raycaster' in value || 'threshold' in value);
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

let nextPickOwnerId = 0;

function createPickOwnerId(): string {
  nextPickOwnerId += 1;
  return `copc-three-layer-${nextPickOwnerId}`;
}

/**
 * Streams a COPC resource into a caller-owned Three.js scene.
 *
 * `load()` reads metadata and the root hierarchy. Point nodes are fetched and
 * committed as camera views are passed to `update()`; the application remains
 * responsible for rendering frames and for disposing its scene, camera, and
 * WebGL renderer.
 */
export class CopcThreeLayer {
  private readonly eventDispatcher: CopcThreeLayerEventDispatcher;
  private readonly eventLifecycle = new CopcLayerEventLifecycle();
  private readonly core: CopcStreamingCore;
  private readonly options: CopcThreeLayerOptions;
  private readonly pointRenderer: CopcThreePointRenderer;
  private readonly pointStyleState = createCopcPointStyleState();
  private datasetElevationRange?: { min: number; max: number };
  private readonly pickOwnerId = createPickOwnerId();
  private attachment?: CopcThreeLayerAttachment;
  private localFrame?: DatasetLocalFrame;
  private lifecycle: CopcThreeLayerLifecycleState = 'idle';
  private loadGeneration = 0;
  private loadOperationGeneration?: number;
  private firstVisibleLoadGeneration?: number;
  private streamingGeneration = 0;
  private lastStreamingView?: StreamingView;
  private updatePending = false;
  private updateInFlight = false;
  private updateInFlightPromise?: Promise<void>;
  private activeStreamingUpdate?: ActiveStreamingUpdate;
  private readonly activeReplacementGroups = new Map<string, ActiveReplacementGroup>();
  private transitionGeneration = 0;
  private transitionDiagnostics = createTransitionDiagnostics();
  private rendererPerformance = createRendererPerformanceSnapshot();
  private selectedPointPickId?: CopcPointPickId;
  private selectedPointLoadGeneration = 0;

  /**
   * Create an unloaded layer for a browser-readable COPC resource.
   *
   * @param options Source URL, backend, streaming limits, renderer, and callbacks.
   * @throws If the URL is empty or `pickingThreshold` is not positive and finite.
   */
  constructor(options: CopcThreeLayerOptions) {
    if (!options || typeof options.url !== 'string' || options.url.length === 0) {
      throw new Error('CopcThreeLayer requires a non-empty URL');
    }
    if (options.pickingThreshold !== undefined
      && !isFinitePositive(options.pickingThreshold)) {
      throw new Error('CopcThreeLayer pickingThreshold must be a positive finite number');
    }

    this.options = options;
    this.eventDispatcher = new CopcThreeLayerEventDispatcher(this);
    this.pointRenderer = options.renderer ?? new ThreePointRenderer();
    this.core = new CopcStreamingCore({
      url: options.url,
      backend: options.backend,
      heightOffsetMeters: options.heightOffsetMeters,
      decoder: options.decoder,
      debug: options.debug,
      maxRenderedPoints: options.maxRenderedPoints,
      maxPointCacheBytes: options.maxPointCacheBytes,
      rangeValidation: options.rangeValidation,
      maxRangeBytes: options.maxRangeBytes,
      maxConcurrentRangeRequests: options.maxConcurrentRangeRequests,
      pointFields: getCopcPointFieldSelection(options.colorMode ?? 'fixed'),
      streaming: options.streaming,
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
      throw new Error('CopcThreeLayer has been destroyed');
    }
    if (!attachment || !attachment.scene || typeof attachment.scene.add !== 'function') {
      throw new Error('CopcThreeLayer requires a Three.js scene');
    }
    if (!attachment.camera || typeof attachment.camera.getWorldPosition !== 'function') {
      throw new Error('CopcThreeLayer requires a Three.js camera');
    }
    if (this.attachment === attachment) {
      return;
    }
    if (this.attachment) {
      this.detachFrom();
    }
    if (this.isDestroyed()) {
      throw new Error('CopcThreeLayer has been destroyed');
    }

    this.attachment = attachment;
    this.pointRenderer.attachTo(attachment.scene);
    this.applyLocalFrame();
    if (this.lifecycle !== 'loading') {
      this.lifecycle = this.core.getMetadata() ? 'ready' : 'mounted';
    }
  }

  /** Detach the root and cancel active view work while retaining loaded metadata and hierarchy. */
  detachFrom(): void {
    if (this.isDestroyed()) {
      return;
    }

    this.cancelActiveView('detach');
    if (this.isDestroyed()) {
      return;
    }
    this.streamingGeneration += 1;
    this.core.invalidateView();
    this.updatePending = false;
    this.pointRenderer.detachFrom();
    this.resetReplacementTransitions();
    this.clearSelectedPoint();
    this.lastStreamingView = undefined;
    this.activeStreamingUpdate = undefined;
    this.attachment = undefined;
    this.resetRendererPerformance();
    if (this.lifecycle !== 'loading') {
      this.lifecycle = this.core.getMetadata() ? 'ready' : 'idle';
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
    if (this.lifecycle === 'destroyed') {
      throw new Error('CopcThreeLayer has been destroyed');
    }
    if (this.core.getMetadata()) {
      throw new Error('COPC layer is already loaded; call reload() to load it again');
    }
    if (this.lifecycle === 'loading') {
      throw new Error('COPC layer is already loading');
    }

    this.lifecycle = 'loading';
    const loadGeneration = ++this.loadGeneration;
    this.loadOperationGeneration = loadGeneration;
    try {
      await this.core.load();
      if (loadGeneration !== this.loadGeneration) {
        return;
      }

      const metadata = this.core.getMetadata();
      if (!metadata) {
        throw new Error('COPC layer loaded without metadata');
      }
      this.localFrame = createDatasetLocalFrame(metadata, this.options.heightOffsetMeters);
      this.datasetElevationRange = getDatasetElevationRange(
        metadata,
        this.options.heightOffsetMeters,
      );
      this.applyLocalFrame();
      this.lifecycle = 'ready';
      this.debug('COPC metadata and hierarchy loaded');
      this.firstVisibleLoadGeneration = undefined;
      this.eventDispatcher.dispatchEvent({
        type: 'metadataready',
        metadata: snapshotCopcMetadata(metadata),
        loadGeneration,
      });
    } catch (error: unknown) {
      if (loadGeneration === this.loadGeneration) {
        this.eventDispatcher.dispatchEvent({
          type: 'error',
          error: snapshotCopcError(error),
          phase: 'load',
          loadGeneration,
        });
        this.unloadInternal('unload');
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
    if (this.lifecycle === 'destroyed') {
      throw new Error('CopcThreeLayer has been destroyed');
    }
    const attachment = this.attachment;
    if (!attachment || !this.core.getMetadata() || this.lifecycle === 'loading') {
      return Promise.resolve();
    }

    const view = this.createView(attachment);
    if (this.updateInFlight) {
      if (!this.lastStreamingView || !areStreamingViewsEquivalent(this.lastStreamingView, view)) {
        this.updatePending = true;
        this.streamingGeneration += 1;
        // The recorded view belongs to the invalidated generation. Clearing it
        // prevents a retry from being mistaken for an unchanged view if the
        // camera returns to that generation before the stale update settles.
        this.lastStreamingView = undefined;
        this.core.invalidateView();
        this.cancelActiveView('camera-change');
        if (this.isDestroyed()) {
          return this.updateInFlightPromise ?? Promise.resolve();
        }
      }
      return this.updateInFlightPromise ?? Promise.resolve();
    }
    if (this.lastStreamingView && areStreamingViewsEquivalent(this.lastStreamingView, view)) {
      return Promise.resolve();
    }

    this.updatePending = true;
    const updatePromise = this.runPendingStreamingUpdates();
    this.updateInFlightPromise = updatePromise;
    this.updateInFlight = true;
    void updatePromise.then(() => {
      if (this.updateInFlightPromise === updatePromise) {
        this.updateInFlightPromise = undefined;
        this.updateInFlight = false;
      }
    }, () => {
      if (this.updateInFlightPromise === updatePromise) {
        this.updateInFlightPromise = undefined;
        this.updateInFlight = false;
      }
    });
    return updatePromise;
  }

  /** Release loaded source data and rendered nodes while retaining the scene attachment. */
  unload(): void {
    if (this.isDestroyed()) {
      return;
    }

    this.unloadInternal('unload');
  }

  private unloadInternal(reason: CopcViewCancellationReason): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }
    this.cancelActiveView(reason);
    if (this.isDestroyed()) {
      return;
    }
    this.loadGeneration += 1;
    this.streamingGeneration += 1;
    this.updatePending = false;
    this.core.unload();
    this.datasetElevationRange = undefined;
    this.pointRenderer.clear();
    this.pointStyleState.reset();
    this.resetReplacementTransitions();
    this.clearSelectedPoint();
    this.lastStreamingView = undefined;
    this.activeStreamingUpdate = undefined;
    this.localFrame = undefined;
    this.resetRendererPerformance();
    this.lifecycle = this.attachment ? 'mounted' : 'idle';
    this.debug('COPC layer unloaded');
  }

  /** Unload the current source and load the configured COPC resource again. */
  async reload(): Promise<void> {
    if (this.lifecycle === 'destroyed') {
      throw new Error('CopcThreeLayer has been destroyed');
    }
    this.unloadInternal('reload');
    await this.load();
  }

  /** Permanently release layer-owned resources without disposing caller-owned scene, camera, or renderer. */
  destroy(): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }

    this.lifecycle = 'destroyed';
    this.loadGeneration += 1;
    this.streamingGeneration += 1;
    this.cancelActiveView('destroy');
    this.core.destroy();
    this.updatePending = false;
    this.pointRenderer.detachFrom();
    this.resetReplacementTransitions();
    this.clearSelectedPoint();
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

  /** Return the selected point while its node and decoded buffer are live. */
  getSelectedPoint(): CopcPointInspection | undefined {
    const pickId = this.selectedPointPickId;
    if (!pickId || this.selectedPointLoadGeneration !== this.loadGeneration) {
      if (pickId) {
        this.clearSelectedPoint();
      }
      return undefined;
    }

    const node = this.core.getHierarchyNode(pickId.nodeKey);
    const points = this.core.getCachedPointBuffer(pickId.nodeKey);
    const inspection = node && points && this.pointRenderer.hasNode(pickId.nodeKey)
      ? inspectCopcPoint(pickId, node.node, points, this.core.getSnapshot().backend)
      : undefined;
    if (!inspection) {
      this.clearSelectedPoint();
    }
    return inspection;
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
    const attachment = this.attachment;
    if (!attachment || !this.localFrame || !Number.isFinite(position.x)
      || !Number.isFinite(position.y)) {
      this.clearSelectedPoint();
      return undefined;
    }

    const options = isPickOptions(raycasterOrOptions) ? raycasterOrOptions : undefined;
    const raycaster = options?.raycaster
      ?? (raycasterOrOptions && !isPickOptions(raycasterOrOptions)
        ? raycasterOrOptions
        : new THREE.Raycaster());
    const threshold = options?.threshold
      ?? this.options.pickingThreshold
      ?? 1;
    if (!isFinitePositive(threshold)) {
      throw new Error('CopcThreeLayer pick threshold must be a positive finite number');
    }

    raycaster.params.Points.threshold = threshold;
    raycaster.setFromCamera(new THREE.Vector2(position.x, position.y), attachment.camera);
    const intersections = raycaster.intersectObject(this.pointRenderer.getRoot(), true);
    for (const intersection of intersections) {
      const pointObject = this.getOwnedPointObject(intersection.object);
      const pointIndex = intersection.index;
      if (!pointObject || pointIndex === undefined
        || !Number.isSafeInteger(pointIndex) || pointIndex < 0) {
        continue;
      }

      const pointIdFactory = pointObject.userData.copcPointId;
      const pickId = typeof pointIdFactory === 'function'
        ? pointIdFactory(pointIndex)
        : undefined;
      if (!isCopcPointPickId(pickId) || pickId.ownerId !== this.pickOwnerId) {
        continue;
      }

      const node = this.core.getHierarchyNode(pickId.nodeKey);
      const points = this.core.getCachedPointBuffer(pickId.nodeKey);
      const inspection = node && points
        ? inspectCopcPoint(pickId, node.node, points, this.core.getSnapshot().backend)
        : undefined;
      if (!inspection || !this.pointRenderer.hasNode(pickId.nodeKey)) {
        continue;
      }

      this.selectedPointPickId = {
        nodeKey: pickId.nodeKey,
        pointIndex: pickId.pointIndex,
        ownerId: pickId.ownerId,
      };
      this.selectedPointLoadGeneration = this.loadGeneration;
      this.options.onPointPicked?.(inspection);
      return inspection;
    }

    this.clearSelectedPoint();
    return undefined;
  }

  /** Return a fresh diagnostics snapshot; the returned arrays/objects are not live views. */
  getSnapshot(): CopcThreeLayerSnapshot {
    const coreSnapshot = this.core.getSnapshot();
    return {
      lifecycle: this.lifecycle,
      attached: this.attachment !== undefined,
      datasetUrl: this.options.url,
      backend: coreSnapshot.backend,
      selectedNodeKeys: coreSnapshot.selectedNodeKeys,
      renderedNodeKeys: this.getRenderedNodeKeys(),
      renderedPointCount: this.getRenderedPointCount(),
      streamingUpdateCount: coreSnapshot.streamingUpdateCount
        + (this.activeStreamingUpdate?.progressApplied ? 1 : 0),
      performance: coreSnapshot.performance,
      renderer: { ...this.rendererPerformance },
      transition: { ...this.transitionDiagnostics },
      ...(coreSnapshot.viewDistance ? { viewDistance: coreSnapshot.viewDistance } : {}),
      ...(coreSnapshot.hierarchy ? { hierarchy: coreSnapshot.hierarchy } : {}),
      pointCache: coreSnapshot.pointCache,
      ...(coreSnapshot.worker ? { worker: coreSnapshot.worker } : {}),
    };
  }

  private async runPendingStreamingUpdates(): Promise<void> {
    while (this.updatePending) {
      this.updatePending = false;
      await this.performStreamingUpdate();
    }
  }

  private async performStreamingUpdate(): Promise<void> {
    const attachment = this.attachment;
    if (!attachment || !this.core.getMetadata() || this.lifecycle === 'destroyed') {
      return;
    }

    const generation = ++this.streamingGeneration;
    const view = this.createView(attachment);
    if (this.lastStreamingView && areStreamingViewsEquivalent(this.lastStreamingView, view)) {
      return;
    }
    const begunView = this.eventLifecycle.beginView();
    if (begunView.superseded) {
      this.eventDispatcher.dispatchEvent({
        type: 'viewcancelled',
        ...begunView.superseded,
      });
    }
    const publicViewGeneration = begunView.viewGeneration;
    if (this.isDestroyed()
      || !this.eventLifecycle.isActiveView(publicViewGeneration)) {
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
    const onProgress: CopcStreamingProgressHandler = (progress) => {
      if (!this.isCurrentStreamingGeneration(generation, attachment)
        || !this.eventLifecycle.isActiveView(publicViewGeneration)) {
        return;
      }
      progressApplied = true;
      if (progress.loadedNodePoints.size > 0) {
        activeStreamingUpdate.progressApplied = true;
      }
      this.applyStreamingProgress(progress, generation, publicViewGeneration);
    };
    const onWorkProgress: CopcStreamingWorkProgressHandler | undefined =
      this.eventDispatcher.hasEventListener('progress')
        ? (progress) => {
            if (!this.isCurrentStreamingGeneration(generation, attachment)
              || !this.eventLifecycle.isActiveView(publicViewGeneration)
              || (progress.queuedNodeCount === lastQueuedNodeCount
                && progress.activeNodeCount === lastActiveNodeCount)) {
              return;
            }
            lastQueuedNodeCount = progress.queuedNodeCount;
            lastActiveNodeCount = progress.activeNodeCount;
            this.eventDispatcher.dispatchEvent({
              type: 'progress',
              queuedNodeCount: progress.queuedNodeCount,
              activeNodeCount: progress.activeNodeCount,
              viewGeneration: publicViewGeneration,
            });
          }
        : undefined;

    let update: Awaited<ReturnType<CopcStreamingCore['updateView']>>;
    try {
      update = await this.core.updateView(view, onProgress, onWorkProgress);
    } catch (error: unknown) {
      if (this.lastStreamingView === view) {
        this.lastStreamingView = undefined;
      }
      if (this.eventLifecycle.failView(publicViewGeneration)) {
        this.eventDispatcher.dispatchEvent({
          type: 'error',
          error: snapshotCopcError(error),
          phase: 'view',
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
        this.cancelActiveView('camera-change');
      }
      return;
    }
    if (!progressApplied) {
      this.applyStreamingProgress({
        ...update,
        completedBatchPointCount: update.loadedNodePoints.size,
      }, generation, publicViewGeneration);
    }
    if (this.eventLifecycle.isActiveView(publicViewGeneration)
      && this.isViewRendererCommitted(
        update.selectedNodeKeys,
        update.loadedNodePoints,
        publicViewGeneration,
      )
      && this.eventLifecycle.settleView(publicViewGeneration)) {
      this.eventDispatcher.dispatchEvent({
        type: 'viewsettled',
        viewGeneration: publicViewGeneration,
        selectedNodeKeys: Object.freeze([...update.selectedNodeKeys]),
      });
    }
  }

  private applyStreamingProgress(
    progress: StreamingProgress,
    generation: number,
    viewGeneration: number,
  ): void {
    this.reconcileReplacementGroups(
      progress.replacementGroups ?? [],
      generation,
      progress.selectedNodeKeys,
      viewGeneration,
    );

    for (const nodeKey of progress.removedNodeKeys) {
      if (!this.isReplacementOldNode(nodeKey)) {
        this.removeRenderedNode(nodeKey);
      }
    }
    for (const [nodeKey, points] of progress.loadedNodePoints) {
      if (!progress.selectedNodeKeys.includes(nodeKey) || this.pointRenderer.hasNode(nodeKey)) {
        continue;
      }
      if (this.getProjectedPointCount(nodeKey, points.pointCount) > this.getMaxRenderedPoints()) {
        continue;
      }
      this.addRenderedNode(nodeKey, points);
      if (points.pointCount > 0
        && this.pointRenderer.hasNode(nodeKey)
        && this.firstVisibleLoadGeneration !== this.loadGeneration) {
        this.firstVisibleLoadGeneration = this.loadGeneration;
        this.eventDispatcher.dispatchEvent({
          type: 'firstvisible',
          loadGeneration: this.loadGeneration,
          viewGeneration,
        });
        if (generation !== this.streamingGeneration || this.isDestroyed()) {
          return;
        }
      }
    }

    this.commitReadyReplacementGroups(generation);
    this.updateTransitionDiagnostics();
  }

  private addRenderedNode(nodeKey: string, points: PreparedPointData): void {
    this.pointRenderer.addOrUpdateNode(nodeKey, points, {
      pointSize: this.options.pointSize ?? 3,
      colorMode: this.options.colorMode ?? 'fixed',
      elevationRange: this.datasetElevationRange,
      rgbMax: this.pointStyleState.getRgbMax(points),
      pointId: (pointIndex) => ({
        nodeKey,
        pointIndex,
        ownerId: this.pickOwnerId,
      }),
      onPerformance: (stage: ThreePointRendererPerformanceStage, durationMs: number) => {
        const metric = `${stage}DurationMs` as keyof CopcThreeRendererPerformanceSnapshot;
        if (metric in this.rendererPerformance) {
          this.rendererPerformance[metric] += durationMs;
        }
      },
    } satisfies ThreePointRendererOptions);
  }

  private reconcileReplacementGroups(
    replacementGroups: readonly StreamingReplacementGroup[],
    generation: number,
    selectedNodeKeys: readonly string[],
    viewGeneration: number,
  ): void {
    if (this.transitionGeneration === generation) {
      return;
    }

    const previousGroups = [...this.activeReplacementGroups.values()];
    const stagedNodeKeys = new Set(previousGroups.flatMap((group) => group.newNodeKeys));
    for (const nodeKey of stagedNodeKeys) {
      if (!selectedNodeKeys.includes(nodeKey)) {
        this.removeRenderedNode(nodeKey);
      }
    }
    if (previousGroups.length > 0) {
      this.transitionDiagnostics.staleReplacementCancellationCount += 1;
    }
    this.activeReplacementGroups.clear();
    this.transitionGeneration = generation;

    const desiredNodeKeys = new Set(selectedNodeKeys);
    const renderedOldNodeKeys = this.pointRenderer.getRenderedNodeKeys()
      .filter((nodeKey) => !desiredNodeKeys.has(nodeKey));
    const desiredNewNodeKeys = [...desiredNodeKeys]
      .filter((nodeKey) => !this.pointRenderer.hasNode(nodeKey))
      .sort();
    if (renderedOldNodeKeys.length > 0 && desiredNewNodeKeys.length === 0) {
      for (const nodeKey of renderedOldNodeKeys) {
        this.removeRenderedNode(nodeKey);
      }
    }

    const incomingOldNodeKeys = new Set(replacementGroups.flatMap((group) => group.oldNodeKeys));
    const incomingNewNodeKeys = new Set(replacementGroups.flatMap((group) => group.newNodeKeys));
    const groupsCoverRenderer = renderedOldNodeKeys.every((key) => incomingOldNodeKeys.has(key))
      && desiredNewNodeKeys.every((key) => incomingNewNodeKeys.has(key));
    const groups = renderedOldNodeKeys.length > 0 && desiredNewNodeKeys.length > 0
      && !groupsCoverRenderer
      ? [{
          kind: this.inferReplacementKind(replacementGroups),
          oldNodeKeys: renderedOldNodeKeys,
          newNodeKeys: desiredNewNodeKeys,
        }]
      : replacementGroups;

    for (const group of groups) {
      if (group.newNodeKeys.length === 0) {
        continue;
      }
      this.activeReplacementGroups.set(this.getReplacementGroupKey(group), {
        ...group,
        oldNodeKeys: [...group.oldNodeKeys].sort(),
        newNodeKeys: [...group.newNodeKeys].sort(),
        generation,
        viewGeneration,
      });
    }
  }

  private inferReplacementKind(groups: readonly StreamingReplacementGroup[]): StreamingReplacementKind {
    return groups.length === 1 ? groups[0].kind : 'retarget';
  }

  private getReplacementGroupKey(group: StreamingReplacementGroup): string {
    return `${group.kind}:${[...group.oldNodeKeys].sort().join(',')}->${[...group.newNodeKeys].sort().join(',')}`;
  }

  private isReplacementOldNode(nodeKey: string): boolean {
    return [...this.activeReplacementGroups.values()]
      .some((group) => group.oldNodeKeys.includes(nodeKey));
  }

  private getProjectedPointCount(nodeKey: string, pointCount: number): number {
    let projectedPointCount = this.getRenderedPointCount();
    const replacedNodeKeys = new Set(
      [...this.activeReplacementGroups.values()].flatMap((group) => group.oldNodeKeys),
    );
    for (const oldNodeKey of replacedNodeKeys) {
      if (this.pointRenderer.hasNode(oldNodeKey)) {
        projectedPointCount -= this.pointRenderer.getRenderedNodePointCount?.(oldNodeKey)
          ?? this.core.getHierarchyNode(oldNodeKey)?.node.pointCount
          ?? 0;
      }
    }
    if (!this.pointRenderer.hasNode(nodeKey)) {
      projectedPointCount += pointCount;
    }
    return projectedPointCount;
  }

  private commitReadyReplacementGroups(generation: number): void {
    for (const [groupKey, group] of [...this.activeReplacementGroups.entries()]) {
      if (group.generation !== generation
        || !group.newNodeKeys.every((nodeKey) => this.pointRenderer.hasNode(nodeKey))) {
        continue;
      }
      for (const oldNodeKey of group.oldNodeKeys) {
        this.removeRenderedNode(oldNodeKey);
      }
      this.activeReplacementGroups.delete(groupKey);
      if (group.kind === 'refinement') {
        this.transitionDiagnostics.refinementReplacementCommitCount += 1;
      } else if (group.kind === 'collapse') {
        this.transitionDiagnostics.collapseReplacementCommitCount += 1;
      }
    }
  }

  private updateTransitionDiagnostics(): void {
    this.transitionDiagnostics.activeReplacementGroupCount = this.activeReplacementGroups.size;
    this.transitionDiagnostics.replacementGroupsWaitingCount = [...this.activeReplacementGroups.values()]
      .filter((group) => !group.newNodeKeys.every((nodeKey) => this.pointRenderer.hasNode(nodeKey)))
      .length;
    this.transitionDiagnostics.coarseNodesRetainedForCoverageCount = [...this.activeReplacementGroups.values()]
      .filter((group) => group.kind === 'refinement')
      .flatMap((group) => group.oldNodeKeys)
      .filter((nodeKey) => this.pointRenderer.hasNode(nodeKey))
      .length;
  }

  private resetReplacementTransitions(): void {
    this.activeReplacementGroups.clear();
    this.transitionGeneration = 0;
    this.transitionDiagnostics = createTransitionDiagnostics();
  }

  private isViewRendererCommitted(
    selectedNodeKeys: readonly string[],
    readyPointBuffers: ReadonlyMap<string, PreparedPointData>,
    viewGeneration: number,
  ): boolean {
    if ([...this.activeReplacementGroups.values()]
      .some((group) => group.viewGeneration === viewGeneration)) {
      return false;
    }
    return selectedNodeKeys.every((nodeKey) => {
      if (this.pointRenderer.hasNode(nodeKey)) {
        return true;
      }
      const readyPoints = readyPointBuffers.get(nodeKey);
      return readyPoints === undefined || readyPoints.pointCount === 0;
    });
  }

  private cancelActiveView(reason: CopcViewCancellationReason): void {
    const cancelled = this.eventLifecycle.cancelView(reason);
    if (cancelled) {
      this.eventDispatcher.dispatchEvent({
        type: 'viewcancelled',
        ...cancelled,
      });
    }
  }

  private isDestroyed(): boolean {
    return this.lifecycle === 'destroyed';
  }

  private removeRenderedNode(nodeKey: string): void {
    if (this.selectedPointPickId?.nodeKey === nodeKey) {
      this.clearSelectedPoint();
    }
    this.pointRenderer.removeNode(nodeKey);
  }

  private getOwnedPointObject(object: THREE.Object3D): THREE.Object3D | undefined {
    const root = this.pointRenderer.getRoot();
    let candidate: THREE.Object3D | null = object;
    while (candidate && candidate.parent && candidate.parent !== root) {
      candidate = candidate.parent;
    }
    if (!candidate || candidate.parent !== root) {
      return undefined;
    }
    const nodeKey = candidate.userData.copcNodeKey;
    return typeof nodeKey === 'string' && this.pointRenderer.hasNode(nodeKey)
      ? candidate
      : undefined;
  }

  private clearSelectedPoint(): void {
    if (!this.selectedPointPickId) {
      return;
    }
    this.selectedPointPickId = undefined;
    this.selectedPointLoadGeneration = 0;
    this.options.onPointPicked?.(undefined);
  }

  private createView(attachment: CopcThreeLayerAttachment): StreamingView {
    if (!this.localFrame) {
      throw new Error('CopcThreeLayer has no dataset-local frame');
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
    const value = this.options.maxRenderedPoints ?? this.options.streaming?.maxRenderedPoints;
    return value !== undefined && isFinitePositive(value) ? value : DEFAULT_MAX_RENDERED_POINTS;
  }

  private resetRendererPerformance(): void {
    this.rendererPerformance = createRendererPerformanceSnapshot();
  }

  private isCurrentStreamingGeneration(
    generation: number,
    attachment: CopcThreeLayerAttachment,
  ): boolean {
    return generation === this.streamingGeneration
      && this.attachment === attachment
      && this.lifecycle !== 'destroyed';
  }

  private debug(message: string): void {
    if (this.options.debug) {
      console.debug(`[CopcThreeLayer] ${message}`);
    }
  }
}
