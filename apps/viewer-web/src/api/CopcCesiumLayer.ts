import * as Cesium from 'cesium';
import {
  CopcLayerController,
  type CopcLayerSnapshot,
} from '../viewer/CopcViewer';
import type { CopcMetadata } from '../copc/types/copc';
import type { CopcCesiumEvent } from './cesiumLayerEvents';
import type { CopcLayerErrorEvent, CopcViewCancellationReason } from './layerEventLifecycle';
import type { CopcColorMode } from '../copc/points/fieldSelection';
import type { CopcBackendSelection } from '../copc/backend/selection';
import type { CopcPointDecoder } from '../copc/points/types';
import type { CopcHierarchyDiagnostics } from '../copc/hierarchy/types';
import type { CesiumPointRenderer } from '../cesium/render/CopcPointRenderer';
import type { CopcPointInspection } from '../copc/points/pointInspection';
import type { RangeValidationPolicy } from '../copc/range/types';
import type { NodePointCacheDiagnostics } from '../viewer/streaming/createNodePointCache';
import type {
  CopcCesiumPointStyle,
  CopcCesiumPointStyleUpdate,
} from '../cesium/style/CesiumPointStyle';

export type {
  CopcCesiumPointStyle,
  CopcCesiumPointStyleUpdate,
  CopcClassificationFilter,
} from '../cesium/style/CesiumPointStyle';

export type { CopcColorMode } from '../copc/points/fieldSelection';

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
  /** @deprecated Planned for removal in v0.9, after v0.8. Retained for compatibility; use maxScreenSpaceError. */
  refineDistanceMultiplier?: number;
  /** Maximum camera-to-node selection distance in metres; defaults to 12,000. */
  maxRenderDistanceMeters?: number;
  /** Maximum estimated points in the active current-view workload; defaults to 250,000. */
  maxRenderedPoints?: number;
};

/** Options for a reusable Cesium layer backed by a browser-readable COPC URL. */
export type CopcCesiumLayerOptions = {
  /** Browser-readable COPC resource URL with HTTP range-request support. */
  url: string;
  /** Cesium point primitive size in pixels. Defaults to 3. */
  pointSize?: number;
  /** Point color mapping. Defaults to the backward-compatible fixed cyan. */
  colorMode?: CopcColorMode;
  /** Manual additive correction in metres applied to ellipsoidal point height. Defaults to 0. */
  heightOffsetMeters?: number;
  /** Emits COPC layer lifecycle messages through console.debug. */
  debug?: boolean;
  /** Maximum estimated points in the active current-view workload; defaults to 250,000. */
  maxRenderedPoints?: number;
  /** Overrides for the default streaming selection limits. */
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
  /** Defaults to strict Content-Range validation. */
  rangeValidation?: RangeValidationPolicy;
  /** Per-range byte ceiling. Defaults to 64 MiB; explicit values accept any positive safe integer. */
  maxRangeBytes?: number;
  /** Maximum active HTTP ranges per source. Defaults to 4; any positive safe integer is accepted. */
  maxConcurrentRangeRequests?: number;
};
/** Read-only snapshot of Cesium layer lifecycle, rendering, streaming, and cache state. */
export type CopcCesiumLayerSnapshot = CopcLayerSnapshot;
export type { CopcLayerErrorEvent, CopcViewCancellationReason };

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
  private readonly controller: CopcLayerController;

  /** Create an unloaded layer configured for a COPC resource. */
  constructor(options: CopcCesiumLayerOptions) {
    this.controller = new CopcLayerController(options);
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
}
