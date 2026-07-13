import * as Cesium from 'cesium';
import { renderCopcPoints, toCartesian3Array } from '../cesium/render/renderPoints';
import { createCesiumViewer } from '../cesium/viewer/createViewer';
import { loadRootHierarchy } from '../copc/hierarchy/loadRootHierarchy';
import { loadCopcMetadata } from '../copc/metadata/loadMetadata';
import { loadCopcPointBuffer } from '../copc/points/loadPointData';
import { extractHorizontalUnitScale } from '../coordinates/crs/parseCopcWkt';
import {
  createPointTransformer,
  transformPointBuffer,
} from '../coordinates/transform/createPointTransformer';
import type {
  CopcHierarchyNode,
  CopcPointBuffer,
  CopcMetadata,
  GeographicCamera,
  GeographicPoint,
  GeographicPointBuffer,
} from '../copc/types/copc';
import { buildStreamingHierarchy, type StreamingHierarchyNode } from './streaming/buildStreamingHierarchy';
import { createNodePointCache } from './streaming/createNodePointCache';
import { selectStreamingNodes } from './streaming/selectNodes';

export type CopcViewerOptions = {
  container: string | HTMLElement;
  url: string;
};

type StreamingState = {
  metadata: CopcMetadata;
  nodes: Map<string, StreamingHierarchyNode>;
};

export type CopcViewerLifecycleState =
  | 'idle'
  | 'mounted'
  | 'loading'
  | 'ready'
  | 'destroyed';

export type CopcViewerSnapshot = {
  lifecycle: CopcViewerLifecycleState;
  renderedNodeKeys: string[];
  selectedNodeKeys: string[];
  renderedPointCount: number;
  datasetUrl: string;
};

const STREAMING_OPTIONS = {
  maxNodes: 24,
  minScreenSpaceMetric: 0.01,
  refineScreenSpaceMetric: 0.08,
  maxRenderDistanceMeters: 12000,
};

export class CopcViewer {
  private viewer?: Cesium.Viewer;
  private readonly options: CopcViewerOptions;
  private readonly pointCollections = new Map<string, Cesium.PointPrimitiveCollection>();
  private readonly selectedNodeKeys = new Set<string>();
  private readonly nodePointCache = createNodePointCache(async (nodeKey) =>
    this.loadRenderableNodePoints(nodeKey),
  );
  private streamingState?: StreamingState;
  private updateTimer?: number;
  private hasFlownToDataset = false;
  private lifecycle: CopcViewerLifecycleState = 'idle';
  private readonly handleCameraMoveEnd = (): void => {
    void this.scheduleStreamingUpdate();
  };

  /**
   * Create a reusable COPC viewer controller.
   *
   * `container` may be a DOM element or an element id accepted by Cesium.
   * `url` must resolve to a browser-readable COPC resource that supports range requests.
   */
  constructor(options: CopcViewerOptions) {
    this.options = options;
  }

  /**
   * Mount the Cesium viewer into the configured container.
   *
   * This must be called before `load()` unless the caller uses `createCopcViewer()`.
   */
  async init(): Promise<void> {
    if (this.lifecycle === 'destroyed') {
      throw new Error('CopcViewer has been destroyed');
    }

    if (this.viewer) {
      return;
    }

    this.viewer = createCesiumViewer(this.options.container);
    this.viewer.camera.percentageChanged = 0.02;
    this.viewer.camera.moveEnd.addEventListener(this.handleCameraMoveEnd);
    this.lifecycle = 'mounted';
  }

  /**
   * Load COPC metadata, hierarchy, and initial streamed nodes into the viewer.
   *
   * The viewer must already be mounted.
   */
  async load(): Promise<void> {
    if (!this.viewer) {
      throw new Error('CopcViewer must be initialized before load()');
    }

    this.lifecycle = 'loading';
    const metadata = await loadCopcMetadata(this.options.url);
    const nodes = await loadRootHierarchy(this.options.url);

    this.streamingState = {
      metadata,
      nodes: buildStreamingHierarchy(metadata, nodes),
    };

    this.flyToDataset(metadata);
    await this.updateStreamingView();
    this.lifecycle = 'ready';
  }

  /**
   * Convenience lifecycle that mounts the viewer and loads the dataset.
   */
  async start(): Promise<void> {
    await this.init();
    await this.load();
  }

  /**
   * Release Cesium resources and stop streaming updates.
   */
  destroy(): void {
    if (this.updateTimer) {
      window.clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }

    if (this.viewer) {
      this.viewer.camera.moveEnd.removeEventListener(this.handleCameraMoveEnd);
      this.viewer.destroy();
      this.viewer = undefined;
    }

    this.pointCollections.clear();
    this.selectedNodeKeys.clear();
    this.streamingState = undefined;
    this.lifecycle = 'destroyed';
  }

  /**
   * Return public viewer state that callers can use for diagnostics or UI.
   */
  getSnapshot(): CopcViewerSnapshot {
    return {
      lifecycle: this.lifecycle,
      renderedNodeKeys: this.getRenderedNodeKeys(),
      selectedNodeKeys: this.getCurrentSelection(),
      renderedPointCount: this.getRenderedPointCount(),
      datasetUrl: this.options.url,
    };
  }

  private flyToDataset(metadata: CopcMetadata): void {
    if (!this.viewer || this.hasFlownToDataset) {
      return;
    }

    const transformPoint = createPointTransformer(metadata);
    const center = transformPoint({
      x: (metadata.cube.minX + metadata.cube.maxX) / 2,
      y: (metadata.cube.minY + metadata.cube.maxY) / 2,
      z: (metadata.cube.minZ + metadata.cube.maxZ) / 2,
    });
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

  private async scheduleStreamingUpdate(): Promise<void> {
    if (this.updateTimer) {
      window.clearTimeout(this.updateTimer);
    }

    this.updateTimer = window.setTimeout(() => {
      void this.updateStreamingView();
    }, 100);
  }

  private getCameraPosition(): GeographicCamera {
    if (!this.viewer) {
      throw new Error('Cesium viewer is not initialized');
    }

    const cartographic = Cesium.Cartographic.fromCartesian(this.viewer.camera.positionWC);

    return {
      longitude: Cesium.Math.toDegrees(cartographic.longitude),
      latitude: Cesium.Math.toDegrees(cartographic.latitude),
      height: cartographic.height,
    };
  }

  private async updateStreamingView(): Promise<void> {
    if (!this.viewer || !this.streamingState) {
      return;
    }

    const selectedNodeKeys = selectStreamingNodes(
      this.streamingState.nodes,
      this.getCameraPosition(),
      STREAMING_OPTIONS,
    );

    this.selectedNodeKeys.clear();

    for (const nodeKey of selectedNodeKeys) {
      this.selectedNodeKeys.add(nodeKey);
    }

    for (const [nodeKey, collection] of this.pointCollections) {
      if (!this.selectedNodeKeys.has(nodeKey)) {
        this.viewer.scene.primitives.remove(collection);
        this.pointCollections.delete(nodeKey);
      }
    }

    await Promise.all(
      selectedNodeKeys.map(async (nodeKey) => {
        if (this.pointCollections.has(nodeKey)) {
          return;
        }

        const points = await this.nodePointCache.load(nodeKey);

        if (!this.viewer || !this.selectedNodeKeys.has(nodeKey)) {
          return;
        }

        const collection = renderCopcPoints(this.viewer, points);
        this.pointCollections.set(nodeKey, collection);
      }),
    );
  }

  private async loadRenderableNodePoints(nodeKey: string): Promise<GeographicPointBuffer> {
    if (!this.streamingState) {
      throw new Error('Streaming state is not initialized');
    }

    const streamingNode = this.streamingState.nodes.get(nodeKey);

    if (!streamingNode) {
      throw new Error(`Unknown COPC hierarchy node: ${nodeKey}`);
    }

    const points = await this.loadPoints(streamingNode.node);

    return transformPointBuffer(this.streamingState.metadata, points);
  }

  private async loadPoints(node: CopcHierarchyNode): Promise<CopcPointBuffer> {
    return loadCopcPointBuffer(this.options.url, node);
  }

  getRenderedNodeKeys(): string[] {
    return [...this.pointCollections.keys()].sort();
  }

  getRenderedPointCount(): number {
    let total = 0;

    for (const collection of this.pointCollections.values()) {
      total += collection.length;
    }

    return total;
  }

  getCurrentSelection(): string[] {
    return [...this.selectedNodeKeys].sort();
  }

  getSelectionBoundingSphere(): Cesium.BoundingSphere | undefined {
    if (this.pointCollections.size === 0) {
      return undefined;
    }

    const positions = [...this.pointCollections.values()].flatMap((collection) => {
      const points: GeographicPoint[] = [];

      for (let index = 0; index < collection.length; index += 1) {
        const primitive = collection.get(index);
        const cartographic = Cesium.Cartographic.fromCartesian(primitive.position);

        points.push({
          longitude: Cesium.Math.toDegrees(cartographic.longitude),
          latitude: Cesium.Math.toDegrees(cartographic.latitude),
          height: cartographic.height,
        });
      }

      return toCartesian3Array(points);
    });

    return Cesium.BoundingSphere.fromPoints(positions);
  }
}

/**
 * Create, mount, and load a COPC viewer in one call.
 */
export async function createCopcViewer(
  options: CopcViewerOptions,
): Promise<CopcViewer> {
  const viewer = new CopcViewer(options);

  await viewer.start();

  return viewer;
}
