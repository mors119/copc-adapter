import * as Cesium from 'cesium';
import {
  CopcLayerController,
  type CopcLayerSnapshot,
} from '../viewer/CopcViewer';
import type { CopcMetadata } from '../copc/types/copc';

export type CopcStreamingOptions = {
  maxNodes?: number;
  maxDepth?: number;
  refineDistanceMultiplier?: number;
  maxRenderDistanceMeters?: number;
};

export type CopcCesiumLayerOptions = {
  /** Browser-readable COPC resource URL with HTTP range-request support. */
  url: string;
  /** Cesium point primitive size in pixels. Defaults to 3. */
  pointSize?: number;
  /** Emits COPC layer lifecycle messages through console.debug. */
  debug?: boolean;
  /** Overrides for the default streaming selection limits. */
  streaming?: CopcStreamingOptions;
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

  /** Load metadata and hierarchy from the configured COPC URL. */
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
}
