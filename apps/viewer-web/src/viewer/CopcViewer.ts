import * as Cesium from 'cesium';
import { renderCopcPoints, toCartesian3Array } from '../cesium/render/renderPoints';
import {
  createCopcContext,
  type CopcContext,
} from '../copc/context/createCopcContext';
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
import {
  buildStreamingHierarchy,
  createNodePointCache,
  StreamingManager,
  type StreamingCameraState,
  type StreamingHierarchy,
  type StreamingSelectionOptions,
} from './streaming/index';

export type CopcLayerOptions = {
  url: string;
  pointSize?: number;
  debug?: boolean;
  streaming?: Partial<StreamingSelectionOptions>;
};

type StreamingState = {
  context: CopcContext;
  metadata: CopcMetadata;
  nodes: StreamingHierarchy;
  manager: StreamingManager;
};

export type CopcLayerLifecycleState =
  | 'idle'
  | 'mounted'
  | 'loading'
  | 'ready'
  | 'destroyed';

export type CopcLayerSnapshot = {
  lifecycle: CopcLayerLifecycleState;
  renderedNodeKeys: string[];
  selectedNodeKeys: string[];
  renderedPointCount: number;
  streamingUpdateCount: number;
  datasetUrl: string;
  attached: boolean;
};

const STREAMING_OPTIONS: StreamingSelectionOptions = {
  maxNodes: 24,
  maxDepth: 6,
  refineDistanceMultiplier: 6,
  maxRenderDistanceMeters: 12000,
};
const MAX_CACHED_NODES = 48;

/**
 * Internal streaming controller used by the public CopcCesiumLayer facade.
 */
export class CopcLayerController {
  private viewer?: Cesium.Viewer;
  private readonly options: CopcLayerOptions;
  private readonly pointCollections = new Map<string, Cesium.PointPrimitiveCollection>();
  private readonly selectedNodeKeys = new Set<string>();
  private readonly nodePointCache = createNodePointCache(async (nodeKey) =>
    this.loadRenderableNodePoints(nodeKey),
    { maxEntries: MAX_CACHED_NODES },
  );
  private streamingState?: StreamingState;
  private updateTimer?: number;
  private streamingUpdateCount = 0;
  private hasFlownToDataset = false;
  private lifecycle: CopcLayerLifecycleState = 'idle';
  private readonly handleCameraMoveEnd = (): void => {
    void this.scheduleStreamingUpdate();
  };

  /**
   * Create a reusable COPC layer controller.
   */
  constructor(options: CopcLayerOptions) {
    this.options = options;
  }

  /**
   * Attach this layer to a caller-owned Cesium viewer.
   */
  attachTo(viewer: Cesium.Viewer): void {
    if (this.lifecycle === 'destroyed') {
      throw new Error('CopcCesiumLayer has been destroyed');
    }

    if (this.viewer && this.viewer !== viewer) {
      this.detachFrom();
    }

    if (this.viewer === viewer) {
      return;
    }

    this.viewer = viewer;
    this.viewer.camera.percentageChanged = 0.02;
    this.viewer.camera.moveEnd.addEventListener(this.handleCameraMoveEnd);
    this.lifecycle = this.streamingState ? 'ready' : 'mounted';

    if (this.streamingState) {
      this.flyToDataset(this.streamingState.metadata);
      void this.updateStreamingView();
    }
  }

  /**
   * Remove this layer's primitives and camera listener without destroying the
   * caller-owned Cesium viewer.
   */
  detachFrom(): void {
    if (!this.viewer) {
      return;
    }

    this.viewer.camera.moveEnd.removeEventListener(this.handleCameraMoveEnd);
    this.removePointCollections();
    this.viewer = undefined;
    this.lifecycle = this.streamingState ? 'ready' : 'idle';
  }

  /**
   * Load COPC metadata and hierarchy. Rendering begins when a viewer is attached.
   */
  async load(): Promise<void> {
    if (this.lifecycle === 'destroyed') {
      throw new Error('CopcCesiumLayer has been destroyed');
    }

    if (this.streamingState) {
      throw new Error('COPC layer is already loaded; call reload() to load it again');
    }

    this.lifecycle = 'loading';
    const context = await createCopcContext(this.options.url);
    const metadata = await loadCopcMetadata(context);
    const nodes = await loadRootHierarchy(context);
    const hierarchy = buildStreamingHierarchy(metadata, nodes);

    this.streamingState = {
      context,
      metadata,
      nodes: hierarchy,
      manager: new StreamingManager(
        hierarchy,
        { ...STREAMING_OPTIONS, ...this.options.streaming },
        this.nodePointCache,
      ),
    };

    this.lifecycle = 'ready';
    this.debug('COPC metadata and hierarchy loaded');

    if (this.viewer) {
      this.flyToDataset(metadata);
      await this.updateStreamingView();
    }
  }

  /**
   * Remove loaded data and rendered primitives while keeping the layer reusable.
   */
  unload(): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }

    this.removePointCollections();
    this.selectedNodeKeys.clear();
    this.nodePointCache.clear();
    this.streamingState = undefined;
    this.streamingUpdateCount = 0;
    this.hasFlownToDataset = false;
    this.lifecycle = this.viewer ? 'mounted' : 'idle';
    this.debug('COPC layer unloaded');
  }

  /**
   * Replace the currently loaded COPC state using the configured URL.
   */
  async reload(): Promise<void> {
    this.unload();
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

    this.unload();
    this.detachFrom();
    this.lifecycle = 'destroyed';
  }

  /**
   * Return public viewer state that callers can use for diagnostics or UI.
   */
  getSnapshot(): CopcLayerSnapshot {
    return {
      lifecycle: this.lifecycle,
      renderedNodeKeys: this.getRenderedNodeKeys(),
      selectedNodeKeys: this.getCurrentSelection(),
      renderedPointCount: this.getRenderedPointCount(),
      streamingUpdateCount: this.streamingUpdateCount,
      datasetUrl: this.options.url,
      attached: this.viewer !== undefined,
    };
  }

  /**
   * Return the currently loaded COPC metadata if the dataset has been loaded.
   */
  getMetadata(): CopcMetadata | undefined {
    return this.streamingState?.metadata;
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

  private getStreamingCameraState(): StreamingCameraState {
    const camera = this.getCameraPosition();

    return {
      ...camera,
      viewDistanceMeters: Math.max(camera.height * 6, 2000),
    };
  }

  private async updateStreamingView(): Promise<void> {
    if (!this.viewer || !this.streamingState) {
      return;
    }

    const update = await this.streamingState.manager.update(
      this.getStreamingCameraState(),
    );
    this.streamingUpdateCount += 1;

    this.selectedNodeKeys.clear();

    for (const nodeKey of update.selectedNodeKeys) {
      this.selectedNodeKeys.add(nodeKey);
    }

    for (const nodeKey of update.removedNodeKeys) {
      const collection = this.pointCollections.get(nodeKey);

      if (!collection) {
        continue;
      }

      this.viewer.scene.primitives.remove(collection);
      this.pointCollections.delete(nodeKey);
    }

    for (const [nodeKey, points] of update.loadedNodePoints) {
      if (!this.viewer || !this.selectedNodeKeys.has(nodeKey)) {
        continue;
      }

      if (this.pointCollections.has(nodeKey)) {
        continue;
      }

      const collection = renderCopcPoints(this.viewer, points, {
        pointSize: this.options.pointSize ?? 3,
      });
      this.pointCollections.set(nodeKey, collection);
    }
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
    if (!this.streamingState) {
      throw new Error('Streaming state is not initialized');
    }

    return loadCopcPointBuffer(this.streamingState.context, node);
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

  private removePointCollections(): void {
    if (this.viewer) {
      for (const collection of this.pointCollections.values()) {
        this.viewer.scene.primitives.remove(collection);
      }
    }

    this.pointCollections.clear();
  }

  private debug(message: string): void {
    if (this.options.debug) {
      console.debug(`[CopcCesiumLayer] ${message}`);
    }
  }
}
