import * as Cesium from 'cesium';
import {
  CopcLayerController,
  type CopcLayerSnapshot,
} from '../viewer/CopcViewer';
import type { CopcMetadata } from '../copc/types/copc';
import type { CopcColorMode } from '../cesium/style/pointStyle';
import type { CopcBackendSelection } from '../copc/backend/selection';
import type { CopcPointDecoder } from '../copc/points/types';
import type { CopcHierarchyDiagnostics } from '../copc/hierarchy/types';
import type { CopcPointRenderer } from '../cesium/render/CopcPointRenderer';
import type { NodePointCacheDiagnostics } from '../viewer/streaming/createNodePointCache';

export type { CopcColorMode } from '../cesium/style/pointStyle';

export type CopcStreamingOptions = {
  maxNodes?: number;
  maxDepth?: number;
  /** Maximum allowed projected replacement error in pixels. Defaults to 8. */
  maxScreenSpaceError?: number;
  /** @deprecated SSE refinement replaces the distance multiplier policy. */
  refineDistanceMultiplier?: number;
  maxRenderDistanceMeters?: number;
  /** Maximum estimated points in the active current-view workload. */
  maxRenderedPoints?: number;
};

export type CopcCesiumLayerOptions = {
  /** Browser-readable COPC resource URL with HTTP range-request support. */
  url: string;
  /** Cesium point primitive size in pixels. Defaults to 3. */
  pointSize?: number;
  /** Point color mapping. Defaults to the backward-compatible fixed cyan. */
  colorMode?: CopcColorMode;
  /** Emits COPC layer lifecycle messages through console.debug. */
  debug?: boolean;
  /** Maximum estimated points in the active current-view workload. */
  maxRenderedPoints?: number;
  /** Overrides for the default streaming selection limits. */
  streaming?: CopcStreamingOptions;
  /** Defaults to stable `copc-js`; `rust` is explicit opt-in. */
  backend?: CopcBackendSelection;
  /** Decoder used to convert point-data views into project point buffers. */
  decoder?: CopcPointDecoder;
  /** Optional renderer implementation; the default uses Cesium point primitives. */
  renderer?: CopcPointRenderer;
  /** Maximum retained decoded CPU point-buffer bytes. Defaults to 256 MiB. */
  maxPointCacheBytes?: number;
};
export type CopcCesiumLayerSnapshot = CopcLayerSnapshot;

/**
 * A reusable COPC streaming layer for a caller-owned Cesium Viewer.
 *
 * Loading is independent of attachment, so applications can prepare a COPC
 * layer before adding it to a viewer.
 */
export class CopcCesiumLayer {
  private readonly controller: CopcLayerController;

  constructor(options: CopcCesiumLayerOptions) {
    this.controller = new CopcLayerController(options);
  }

  /** Attach the layer's rendered primitives to a Cesium Viewer. */
  attachTo(viewer: Cesium.Viewer): void {
    this.controller.attachTo(viewer);
  }

  /** Detach from the current Cesium Viewer without unloading COPC data. */
  detachFrom(): void {
    this.controller.detachFrom();
  }

  /**
   * Load metadata and hierarchy from the configured COPC URL.
   *
   * Rejects with a project-owned CopcLoadError when source, metadata/CRS, or
   * hierarchy initialization fails.
   */
  async load(): Promise<void> {
    await this.controller.load();
  }

  /** Release loaded COPC data and rendered primitives. */
  unload(): void {
    this.controller.unload();
  }

  /** Unload and load the configured COPC URL again. */
  async reload(): Promise<void> {
    await this.controller.reload();
  }

  /** Permanently release layer resources without destroying the Cesium Viewer. */
  destroy(): void {
    this.controller.destroy();
  }

  /** Return state suitable for application diagnostics. */
  getSnapshot(): CopcCesiumLayerSnapshot {
    return this.controller.getSnapshot();
  }

  /** Return loaded COPC metadata, if available. */
  getMetadata(): CopcMetadata | undefined {
    return this.controller.getMetadata();
  }

  /** Return hierarchy request/cache counters for diagnostics and tests. */
  getHierarchyDiagnostics(): CopcHierarchyDiagnostics | undefined {
    return this.controller.getHierarchyDiagnostics();
  }

  /** Return decoded CPU point-buffer cache counters for diagnostics and tests. */
  getPointCacheDiagnostics(): NodePointCacheDiagnostics {
    return this.controller.getPointCacheDiagnostics();
  }
}
