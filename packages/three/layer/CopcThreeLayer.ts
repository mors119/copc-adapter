import * as THREE from "three";
import type { CopcMetadata } from "../../core/copc/types/copc";
import type { CopcHierarchyDiagnostics } from "../../core/copc/hierarchy/types";
import type { CopcPointInspection } from "../../core/copc/points/pointInspection";
import type { NodePointCacheDiagnostics } from "../../core/streaming/createNodePointCache";
import type {
  CopcPointQuery,
  CopcPointQueryOptions,
} from "../../core/streaming/spatialPointQuery";
import type { DatasetLocalFrame } from "../../core/coordinates/types";
import type {
  CopcThreeLayerEventMap,
  CopcThreeLayerEventType,
} from "../events/CopcThreeLayerEvents";
import { ThreeLayerController } from "./ThreeLayerController";
import type {
  CopcThreeLayerAttachment,
  CopcThreeLayerOptions,
  CopcThreeLayerPickOptions,
  CopcThreeLayerPickPosition,
  CopcThreeLayerSnapshot,
} from "./types";

export type {
  CopcThreeLayerEventMap,
  CopcThreeLayerEventType,
  CopcThreeLayerErrorEvent,
  CopcThreeLayerFirstVisibleEvent,
  CopcThreeLayerMetadataReadyEvent,
  CopcThreeLayerProgressEvent,
  CopcThreeLayerViewCancelledEvent,
  CopcThreeLayerViewSettledEvent,
} from "../events/CopcThreeLayerEvents";
export type {
  CopcLayerErrorEvent,
  CopcViewCancellationReason,
} from "../../core/events/layerEventLifecycle";

export type {
  CopcThreeLayerAttachment,
  CopcThreeLayerLifecycleState,
  CopcThreeLayerOptions,
  CopcThreeLayerPickOptions,
  CopcThreeLayerPickPosition,
  CopcThreeLayerSnapshot,
  CopcThreeLayerTransitionDiagnostics,
  CopcThreePointRenderer,
  CopcThreeRendererPerformanceSnapshot,
} from "./types";

/**
 * Streams a COPC resource into a caller-owned Three.js scene.
 *
 * `load()` reads metadata and the root hierarchy. Point nodes are fetched and
 * committed as camera views are passed to `update()`; the application remains
 * responsible for rendering frames and for disposing its scene, camera, and
 * WebGL renderer.
 */
export class CopcThreeLayer {
  private readonly controller: ThreeLayerController;

  /**
   * Create an unloaded layer for a browser-readable COPC resource.
   *
   * @param options Source URL, backend, streaming limits, renderer, and callbacks.
   * @throws If the URL is empty or `pickingThreshold` is not positive and finite.
   */
  constructor(options: CopcThreeLayerOptions) {
    this.controller = new ThreeLayerController(options, this);
  }

  /** Subscribe to a typed layer lifecycle event. Listener failures are reported to `console.error`. */
  addEventListener<TType extends CopcThreeLayerEventType>(
    type: TType,
    listener: (event: CopcThreeLayerEventMap[TType]) => void,
  ): void {
    this.controller.addEventListener(type, listener);
  }

  /** Remove a listener previously registered for the same event and function. */
  removeEventListener<TType extends CopcThreeLayerEventType>(
    type: TType,
    listener: (event: CopcThreeLayerEventMap[TType]) => void,
  ): void {
    this.controller.removeEventListener(type, listener);
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
    this.controller.attachTo(attachment);
  }

  /** Detach the root and cancel active view work while retaining loaded metadata and hierarchy. */
  detachFrom(): void {
    this.controller.detachFrom();
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
  load(): Promise<void> {
    return this.controller.load();
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
    return this.controller.update();
  }

  /** Release loaded source data and rendered nodes while retaining the scene attachment. */
  unload(): void {
    this.controller.unload();
  }

  /** Unload the current source and load the configured COPC resource again. */
  reload(): Promise<void> {
    return this.controller.reload();
  }

  /** Permanently release layer-owned resources without disposing caller-owned scene, camera, or renderer. */
  destroy(): void {
    this.controller.destroy();
  }

  /**
   * Set uniform alpha for this layer and future streamed nodes.
   *
   * The update reuses existing geometry and decoded point buffers. Opacity
   * zero disables point picking for this layer.
   *
   * @param opacity Finite alpha in the inclusive range [0, 1].
   * @throws If opacity is invalid, the layer is destroyed, or a custom renderer does not support opacity.
   */
  setOpacity(opacity: number): void {
    this.controller.setOpacity(opacity);
  }

  /** Return the layer-owned root group for picking or application composition. */
  getRoot(): THREE.Group {
    return this.controller.getRoot();
  }

  /** Return the fixed dataset-local frame used by the layer, when loaded. */
  getLocalFrame(): DatasetLocalFrame | undefined {
    return this.controller.getLocalFrame();
  }

  /** Return source metadata after {@link load} has completed. */
  getMetadata(): CopcMetadata | undefined {
    return this.controller.getMetadata();
  }

  /**
   * Stream source XYZ points from an inclusive source-coordinate AABB.
   * Querying leaves the camera and rendered node selection unchanged.
   *
   * @param options Explicit query mode, depth, region, and resource budgets.
   * @returns One-shot batches and a terminal status promise.
   * @throws If the layer is not loaded or the region/limits are invalid.
   */
  queryPoints(options: CopcPointQueryOptions): CopcPointQuery {
    return this.controller.queryPoints(options);
  }

  /** Return hierarchy request and page-cache counters when available. */
  getHierarchyDiagnostics(): CopcHierarchyDiagnostics | undefined {
    return this.controller.getHierarchyDiagnostics();
  }

  /** Return decoded CPU point-buffer cache counters and retained bytes. */
  getPointCacheDiagnostics(): NodePointCacheDiagnostics {
    return this.controller.getPointCacheDiagnostics();
  }

  /** Return the selected hierarchy node keys for the most recent view. */
  getCurrentSelection(): string[] {
    return this.controller.getCurrentSelection();
  }

  /** Return node keys currently committed to the renderer. */
  getRenderedNodeKeys(): string[] {
    return this.controller.getRenderedNodeKeys();
  }

  /** Return the number of points currently committed to the renderer. */
  getRenderedPointCount(): number {
    return this.controller.getRenderedPointCount();
  }

  /** Return the selected point while its node and decoded buffer are live. */
  getSelectedPoint(): CopcPointInspection | undefined {
    return this.controller.getSelectedPoint();
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
    return this.controller.pick(position, raycasterOrOptions);
  }

  /** Return a fresh diagnostics snapshot; the returned arrays/objects are not live views. */
  getSnapshot(): CopcThreeLayerSnapshot {
    return this.controller.getSnapshot();
  }
}
