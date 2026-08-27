import * as Cesium from 'cesium';
import { renderCopcPoints, toCartesian3Array } from '../cesium/render/renderPoints';
import {
  getCopcPointFieldSelection,
  type CopcColorMode,
} from '../cesium/style/pointStyle';
import {
  createCopcContext,
} from '../copc/context/createCopcContext';
import type { CopcSource } from '../copc/backend/types';
import {
  getCopcBackendName,
  type CopcBackendSelection,
  type CopcBackendName,
} from '../copc/backend/selection';
import type { CopcPointDecoder } from '../copc/points/types';
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
  type StreamingProgress,
  type StreamingSelectionOptions,
} from './streaming/index';
import { performanceNow, type CopcPerformanceObserver } from '../copc/performance';
import { StreamingPerformanceRecorder } from './streaming/performance';

export type CopcLayerOptions = {
  url: string;
  pointSize?: number;
  colorMode?: CopcColorMode;
  debug?: boolean;
  streaming?: Partial<StreamingSelectionOptions>;
  backend?: CopcBackendSelection;
  decoder?: CopcPointDecoder;
};

type StreamingState = {
  context: CopcSource;
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
  backend: CopcBackendName | 'custom';
  performance: ReturnType<StreamingManager['getPerformanceSnapshot']>;
};

const STREAMING_OPTIONS: StreamingSelectionOptions = {
  maxNodes: 24,
  maxDepth: 6,
  refineDistanceMultiplier: 6,
  maxRenderDistanceMeters: 12000,
  maxPointsPerBatch: 100000,
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
  private readonly performanceRecorder = new StreamingPerformanceRecorder();
  private readonly performanceObserver: CopcPerformanceObserver = (event) => {
    const stage = event.stage === 'rangeFetch'
      ? 'rangeFetchDurationMs'
      : 'decodeDurationMs';
    this.performanceRecorder.recordStage(stage, event.durationMs, event.stage === 'decode');
  };
  private streamingState?: StreamingState;
  private updateTimer?: number;
  private loadGeneration = 0;
  private streamingGeneration = 0;
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
    this.streamingGeneration += 1;
    this.streamingState?.manager.invalidate();

    if (this.updateTimer) {
      window.clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }

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

    if (this.lifecycle === 'loading') {
      throw new Error('COPC layer is already loading');
    }

    this.lifecycle = 'loading';
    const loadGeneration = ++this.loadGeneration;
    const context = await createCopcContext(
      this.options.url,
      this.options.backend,
    );

    if (!this.isCurrentLoad(loadGeneration)) {
      return;
    }

    context.setPerformanceObserver?.(this.performanceObserver);
    const metadata = await loadCopcMetadata(context);

    if (!this.isCurrentLoad(loadGeneration)) {
      return;
    }

    const nodes = await loadRootHierarchy(context);

    if (!this.isCurrentLoad(loadGeneration)) {
      return;
    }

    const hierarchy = buildStreamingHierarchy(metadata, nodes);

    this.streamingState = {
      context,
      metadata,
      nodes: hierarchy,
      manager: new StreamingManager(
        hierarchy,
        { ...STREAMING_OPTIONS, ...this.options.streaming },
        this.nodePointCache,
        this.performanceRecorder,
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

    this.loadGeneration += 1;
    this.streamingGeneration += 1;

    if (this.updateTimer) {
      window.clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }

    this.streamingState?.manager.clear?.();
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
      backend: getCopcBackendName(this.options.backend),
      performance: this.performanceRecorder.getSnapshot(),
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
      this.updateTimer = undefined;
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
    const viewer = this.viewer;
    const streamingState = this.streamingState;

    if (!viewer || !streamingState) {
      return;
    }

    const streamingGeneration = ++this.streamingGeneration;
    let progressApplied = false;
    const update = await streamingState.manager.update(
      this.getStreamingCameraState(),
      (progress) => {
        if (
          streamingGeneration !== this.streamingGeneration
          || this.viewer !== viewer
          || this.streamingState !== streamingState
          || this.lifecycle === 'destroyed'
        ) {
          return;
        }

        this.streamingUpdateCount += 1;
        progressApplied = true;
        this.applyStreamingProgress(viewer, progress);
      },
    );

    if (
      streamingGeneration !== this.streamingGeneration
      || this.viewer !== viewer
      || this.streamingState !== streamingState
      || this.lifecycle === 'destroyed'
    ) {
      return;
    }

    // Keep compatibility with custom/test managers that implement the
    // original all-at-once update contract and do not emit progress.
    if (!progressApplied) {
      this.streamingUpdateCount += 1;
      this.applyStreamingProgress(viewer, {
        ...update,
        completedBatchPointCount: update.loadedNodePoints.size,
      });
    }

  }

  private applyStreamingProgress(
    viewer: Cesium.Viewer,
    progress: StreamingProgress,
  ): void {
    const streamingState = this.streamingState;
    if (!streamingState) {
      return;
    }

    this.selectedNodeKeys.clear();
    for (const nodeKey of progress.selectedNodeKeys) {
      this.selectedNodeKeys.add(nodeKey);
    }

    for (const nodeKey of progress.removedNodeKeys) {
      if (this.isAncestorOfSelectedNode(nodeKey, progress.selectedNodeKeys, streamingState.nodes)) {
        continue;
      }
      this.removePointCollection(viewer, nodeKey);
    }

    for (const [nodeKey, points] of progress.loadedNodePoints) {
      if (this.viewer !== viewer || !this.selectedNodeKeys.has(nodeKey)) {
        continue;
      }

      if (this.pointCollections.has(nodeKey)) {
        continue;
      }

      const collection = renderCopcPoints(viewer, points, {
        pointSize: this.options.pointSize ?? 3,
        colorMode: this.options.colorMode ?? 'fixed',
        elevationRange: this.getDatasetElevationRange(),
        onPerformance: (stage, durationMs) => {
          const metricStage = stage === 'geographicToCartesian'
            ? 'geographicToCartesianDurationMs'
            : stage === 'pointStylePreparation'
              ? 'pointStylePreparationDurationMs'
              : stage === 'pointCollectionCreation'
                ? 'pointCollectionCreationDurationMs'
                : 'pointAddDurationMs';
          this.performanceRecorder.recordStage(metricStage, durationMs, true);
        },
      });
      this.pointCollections.set(nodeKey, collection);
    }

    this.removeReplacedCoarseNodes(viewer, streamingState.nodes);
  }

  private removeReplacedCoarseNodes(
    viewer: Cesium.Viewer,
    hierarchy: StreamingHierarchy,
  ): void {
    for (const nodeKey of this.pointCollections.keys()) {
      if (this.selectedNodeKeys.has(nodeKey)) {
        continue;
      }

      const selectedDescendants = [...this.selectedNodeKeys]
        .filter((selectedNodeKey) => this.isAncestor(nodeKey, selectedNodeKey, hierarchy));

      if (
        selectedDescendants.length === 0
        || selectedDescendants.every((selectedNodeKey) => this.pointCollections.has(selectedNodeKey))
      ) {
        this.removePointCollection(viewer, nodeKey);
      }
    }
  }

  private isAncestorOfSelectedNode(
    ancestorKey: string,
    selectedNodeKeys: readonly string[],
    hierarchy: StreamingHierarchy,
  ): boolean {
    return selectedNodeKeys.some((nodeKey) => this.isAncestor(ancestorKey, nodeKey, hierarchy));
  }

  private isAncestor(
    ancestorKey: string,
    descendantKey: string,
    hierarchy: StreamingHierarchy,
  ): boolean {
    if (ancestorKey === descendantKey) {
      return false;
    }

    const visited = new Set<string>();
    const pending = [...(hierarchy.get(ancestorKey)?.children ?? [])];
    while (pending.length > 0) {
      const nodeKey = pending.pop();
      if (!nodeKey || visited.has(nodeKey)) {
        continue;
      }
      if (nodeKey === descendantKey) {
        return true;
      }
      visited.add(nodeKey);
      pending.push(...(hierarchy.get(nodeKey)?.children ?? []));
    }

    return false;
  }

  private removePointCollection(viewer: Cesium.Viewer, nodeKey: string): void {
    const collection = this.pointCollections.get(nodeKey);
    if (!collection) {
      return;
    }

    viewer.scene.primitives.remove(collection);
    this.pointCollections.delete(nodeKey);
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

    const transformStartedAt = performanceNow();
    const transformed = transformPointBuffer(this.streamingState.metadata, points);
    this.performanceRecorder.recordStage(
      'crsTransformDurationMs',
      performanceNow() - transformStartedAt,
      true,
    );

    return transformed;
  }

  private async loadPoints(node: CopcHierarchyNode): Promise<CopcPointBuffer> {
    if (!this.streamingState) {
      throw new Error('Streaming state is not initialized');
    }

    return loadCopcPointBuffer(
      this.streamingState.context,
      node,
      this.options.decoder,
      getCopcPointFieldSelection(this.options.colorMode ?? 'fixed'),
    );
  }

  private getDatasetElevationRange(): { min: number; max: number } {
    if (!this.streamingState) {
      return { min: 0, max: 0 };
    }

    const { metadata } = this.streamingState;
    const transformPoint = createPointTransformer(metadata);
    const x = (metadata.bounds.minX + metadata.bounds.maxX) / 2;
    const y = (metadata.bounds.minY + metadata.bounds.maxY) / 2;

    return {
      min: transformPoint({ x, y, z: metadata.bounds.minZ }).height,
      max: transformPoint({ x, y, z: metadata.bounds.maxZ }).height,
    };
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

  private isCurrentLoad(loadGeneration: number): boolean {
    return loadGeneration === this.loadGeneration && this.lifecycle !== 'destroyed';
  }
}
