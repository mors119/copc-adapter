import * as Cesium from 'cesium';
import { PointPrimitiveRenderer, type CopcPointRenderer } from '../cesium/render/CopcPointRenderer';
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
import { HierarchyLoader } from '../copc/hierarchy/HierarchyLoader';
import type { CopcHierarchyBounds, CopcHierarchyQuery } from '../copc/hierarchy/types';
import { CopcHierarchyLoadError, CopcLoadError } from '../copc/errors';
import { loadCopcMetadata } from '../copc/metadata/loadMetadata';
import { loadCopcPointBuffer } from '../copc/points/loadPointData';
import { extractHorizontalUnitScale } from '../coordinates/crs/parseCopcWkt';
import {
  createPointTransformer,
  createProjectPointTransformer,
  transformPointBuffer,
} from '../coordinates/transform/createPointTransformer';
import type {
  CopcHierarchyNode,
  CopcPointBuffer,
  CopcMetadata,
  GeographicCamera,
  GeographicPointBuffer,
} from '../copc/types/copc';
import {
  buildStreamingHierarchy,
  createNodePointCache,
  StreamingManager,
  createPerspectiveViewFrustum,
  type StreamingCameraState,
  type StreamingHierarchy,
  type StreamingProgress,
  type StreamingSelectionOptions,
} from './streaming/index';
import type { ViewVector3 } from './streaming/index';
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
  renderer?: CopcPointRenderer;
};

type StreamingState = {
  context: CopcSource;
  metadata: CopcMetadata;
  hierarchyLoader: HierarchyLoader;
  nodes: StreamingHierarchy;
  manager: StreamingManager;
};

function createViewBounds(
  camera: StreamingCameraState,
  radiusMeters: number,
): CopcHierarchyBounds {
  const latitudeRadius = radiusMeters / 111_320;
  const longitudeRadius = radiusMeters /
    (111_320 * Math.max(Math.cos((camera.latitude * Math.PI) / 180), 0.1));

  return {
    minX: camera.longitude - longitudeRadius,
    minY: camera.latitude - latitudeRadius,
    minZ: camera.height - radiusMeters,
    maxX: camera.longitude + longitudeRadius,
    maxY: camera.latitude + latitudeRadius,
    maxZ: camera.height + radiusMeters,
  };
}

function toProjectBounds(
  metadata: CopcMetadata,
  geographicBounds: CopcHierarchyBounds,
): CopcHierarchyBounds {
  const toProject = createProjectPointTransformer(metadata);
  const corners = [
    [geographicBounds.minX, geographicBounds.minY, geographicBounds.minZ],
    [geographicBounds.minX, geographicBounds.minY, geographicBounds.maxZ],
    [geographicBounds.minX, geographicBounds.maxY, geographicBounds.minZ],
    [geographicBounds.minX, geographicBounds.maxY, geographicBounds.maxZ],
    [geographicBounds.maxX, geographicBounds.minY, geographicBounds.minZ],
    [geographicBounds.maxX, geographicBounds.minY, geographicBounds.maxZ],
    [geographicBounds.maxX, geographicBounds.maxY, geographicBounds.minZ],
    [geographicBounds.maxX, geographicBounds.maxY, geographicBounds.maxZ],
  ].map(([longitude, latitude, height]) =>
    toProject({ longitude, latitude, height }));

  return corners.reduce<CopcHierarchyBounds>((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    minZ: Math.min(bounds.minZ, point.z),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
    maxZ: Math.max(bounds.maxZ, point.z),
  }), {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  });
}

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
  maxScreenSpaceError: 8,
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
  private readonly pointRenderer: CopcPointRenderer;
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
    this.pointRenderer = options.renderer ?? new PointPrimitiveRenderer();
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
    this.pointRenderer.attachTo(viewer);
    this.viewer.camera.percentageChanged = 0.02;
    this.viewer.camera.moveEnd.addEventListener(this.handleCameraMoveEnd);
    this.viewer.camera.changed?.addEventListener(this.handleCameraMoveEnd);
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
    this.viewer.camera.changed?.removeEventListener(this.handleCameraMoveEnd);
    this.pointRenderer.detachFrom();
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

    const hierarchyLoader = new HierarchyLoader(context, metadata.cube);
    let rootHierarchy;
    try {
      rootHierarchy = await hierarchyLoader.loadRoot();
    } catch (error: unknown) {
      if (error instanceof CopcLoadError) {
        throw error;
      }

      throw new CopcHierarchyLoadError(context.source, { cause: error });
    }

    if (!this.isCurrentLoad(loadGeneration)) {
      return;
    }

    const hierarchy = buildStreamingHierarchy(metadata, rootHierarchy.nodes);

    this.streamingState = {
      context,
      metadata,
      hierarchyLoader,
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
    this.pointRenderer.clear();
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
    this.pointRenderer.destroy();
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

  getHierarchyDiagnostics() {
    return this.streamingState?.hierarchyLoader.getDiagnostics();
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
    const viewFrustum = this.getViewFrustum();
    const frustumFar = viewFrustum?.farMeters;

    return {
      ...camera,
      viewDistanceMeters: Number.isFinite(frustumFar)
        ? Math.max(frustumFar as number, 2000)
        : Math.max(camera.height * 6, 2000),
      viewFrustum,
    };
  }

  private getViewFrustum(): StreamingCameraState['viewFrustum'] {
    if (!this.viewer) {
      return undefined;
    }

    const camera = this.viewer.camera;
    const frustum = camera.frustum as unknown as {
      fov?: number;
      fovy?: number;
      aspectRatio?: number;
      near?: number;
      far?: number;
    } | undefined;
    if (!frustum) {
      return undefined;
    }
    const { fov, fovy, aspectRatio, near, far } = frustum;
    const viewportHeightPixels = this.viewer.scene.drawingBufferHeight
      || this.viewer.scene.canvas.clientHeight
      || this.viewer.scene.canvas.height;
    const toVector = (value: Cesium.Cartesian3): ViewVector3 => ({
      x: value.x,
      y: value.y,
      z: value.z,
    });

    if (
      typeof fov !== 'number' ||
      typeof aspectRatio !== 'number' ||
      typeof near !== 'number' ||
      typeof far !== 'number' ||
      !Number.isFinite(viewportHeightPixels) ||
      viewportHeightPixels <= 0 ||
      (typeof fovy !== 'number' && typeof fov !== 'number') ||
      !Number.isFinite(aspectRatio) ||
      !Number.isFinite(near) ||
      !Number.isFinite(far)
    ) {
      return undefined;
    }

    const verticalFovRadians = typeof fovy === 'number' && Number.isFinite(fovy)
      ? fovy
      : aspectRatio! > 1
        ? 2 * Math.atan(Math.tan(fov! / 2) / aspectRatio!)
        : fov!;
    if (!Number.isFinite(verticalFovRadians)) {
      return undefined;
    }

    try {
      return createPerspectiveViewFrustum({
        position: toVector(camera.positionWC),
        direction: toVector(camera.directionWC),
        up: toVector(camera.upWC),
        right: toVector(camera.rightWC),
        verticalFovRadians,
        viewportHeightPixels,
        aspectRatio,
        nearMeters: near,
        farMeters: far,
      });
    } catch {
      // Orthographic/custom frustums, or an incomplete camera during startup,
      // fall back to the selector's documented default projection
      // conservatively.
      return undefined;
    }
  }

  private getHierarchyQuery(camera: StreamingCameraState): CopcHierarchyQuery {
    const streamingOptions = { ...STREAMING_OPTIONS, ...this.options.streaming };
    const metadata = this.streamingState?.metadata;
    if (!metadata) {
      throw new Error('Streaming state is not initialized');
    }
    const radiusMeters = Math.min(
      camera.viewDistanceMeters,
      streamingOptions.maxRenderDistanceMeters,
    );

    return {
      bounds: toProjectBounds(
        metadata,
        createViewBounds(camera, radiusMeters),
      ),
      maxLevel: streamingOptions.maxDepth,
    };
  }

  private async updateStreamingView(): Promise<void> {
    const viewer = this.viewer;
    const streamingState = this.streamingState;

    if (!viewer || !streamingState) {
      return;
    }

    const streamingGeneration = ++this.streamingGeneration;
    const camera = this.getStreamingCameraState();
    if (streamingState.hierarchyLoader) {
      const availableHierarchy = await streamingState.hierarchyLoader.query(
        this.getHierarchyQuery(camera),
      );
      if (
        streamingGeneration !== this.streamingGeneration
        || this.viewer !== viewer
        || this.streamingState !== streamingState
        || this.lifecycle === 'destroyed'
      ) {
        return;
      }
      const hierarchy = buildStreamingHierarchy(streamingState.metadata, availableHierarchy.nodes);
      streamingState.nodes = hierarchy;
      streamingState.manager.setHierarchy(hierarchy);
    }
    let progressApplied = false;
    let updateCounted = false;
    const update = await streamingState.manager.update(
      camera,
      (progress) => {
        if (
          streamingGeneration !== this.streamingGeneration
          || this.viewer !== viewer
          || this.streamingState !== streamingState
          || this.lifecycle === 'destroyed'
        ) {
          return;
        }

        progressApplied = true;
        if (progress.loadedNodePoints.size > 0 && !updateCounted) {
          this.streamingUpdateCount += 1;
          updateCounted = true;
        }
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
      this.applyStreamingProgress(viewer, {
        ...update,
        completedBatchPointCount: update.loadedNodePoints.size,
      });
    }

    if (!updateCounted) {
      this.streamingUpdateCount += 1;
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
      this.removePointCollection(nodeKey);
    }

    for (const [nodeKey, points] of progress.loadedNodePoints) {
      if (this.viewer !== viewer || !this.selectedNodeKeys.has(nodeKey)) {
        continue;
      }

      if (this.pointRenderer.hasNode(nodeKey)) {
        continue;
      }

      this.pointRenderer.addOrUpdateNode(nodeKey, points, {
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
                  : stage === 'pointAdd'
                    ? 'pointAddDurationMs'
                    : stage === 'rendererPreparation'
                      ? 'rendererPreparationDurationMs'
                      : 'nodeRemovalDurationMs';
          this.performanceRecorder.recordStage(metricStage, durationMs, true);
        },
      });
    }

    this.removeReplacedCoarseNodes(streamingState.nodes);
  }

  private removeReplacedCoarseNodes(
    hierarchy: StreamingHierarchy,
  ): void {
    for (const nodeKey of this.pointRenderer.getRenderedNodeKeys()) {
      if (this.selectedNodeKeys.has(nodeKey)) {
        continue;
      }

      const selectedDescendants = [...this.selectedNodeKeys]
        .filter((selectedNodeKey) => this.isAncestor(nodeKey, selectedNodeKey, hierarchy));

      if (
        selectedDescendants.length === 0
        || selectedDescendants.every((selectedNodeKey) => this.pointRenderer.hasNode(selectedNodeKey))
      ) {
        this.removePointCollection(nodeKey);
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

  private removePointCollection(nodeKey: string): void {
    this.pointRenderer.removeNode(nodeKey);
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
    return this.pointRenderer.getRenderedNodeKeys();
  }

  getRenderedPointCount(): number {
    return this.pointRenderer.getRenderedPointCount();
  }

  getCurrentSelection(): string[] {
    return [...this.selectedNodeKeys].sort();
  }

  getSelectionBoundingSphere(): Cesium.BoundingSphere | undefined {
    return this.pointRenderer.getSelectionBoundingSphere();
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
