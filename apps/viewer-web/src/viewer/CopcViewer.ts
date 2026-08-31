import * as Cesium from 'cesium';
import {
  PointPrimitiveRenderer,
  type CesiumPointRenderer,
} from '../cesium/render/CopcPointRenderer';
import {
  getCopcPointFieldSelection,
  type CopcColorMode,
} from '../copc/points/fieldSelection';
import {
  createCopcContext,
} from '../copc/context/createCopcContext';
import type { CopcSource, CopcWorkerDiagnostics } from '../copc/backend/types';
import {
  getCopcBackendName,
  type CopcBackendSelection,
  type CopcBackendName,
} from '../copc/backend/selection';
import type { CopcPointDecoder } from '../copc/points/types';
import {
  inspectCopcPoint,
  isCopcPointPickId,
  type CopcPointInspection,
  type CopcPointPickId,
} from '../copc/points/pointInspection';
import { HierarchyLoader } from '../copc/hierarchy/HierarchyLoader';
import type {
  CopcHierarchyBounds,
  CopcHierarchyQuery,
  CopcProjectBounds,
} from '../copc/hierarchy/types';
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
  createStreamingViewBounds,
  type StreamingCameraState,
  type StreamingHierarchy,
  type StreamingProgress,
  type StreamingReplacementGroup,
  type StreamingReplacementKind,
  type StreamingSelectionOptions,
  DEFAULT_MAX_RENDERED_POINTS,
} from './streaming/index';
import type {
  NodePointCache,
  NodePointCacheDiagnostics,
} from './streaming/createNodePointCache';
import type { ViewVector3 } from './streaming/index';
import { performanceNow, type CopcPerformanceObserver } from '../copc/performance';
import { StreamingPerformanceRecorder } from './streaming/performance';

export type CopcLayerOptions = {
  url: string;
  pointSize?: number;
  colorMode?: CopcColorMode;
  debug?: boolean;
  maxRenderedPoints?: number;
  streaming?: Partial<StreamingSelectionOptions>;
  backend?: CopcBackendSelection;
  decoder?: CopcPointDecoder;
  renderer?: CesiumPointRenderer;
  /** Called when a rendered COPC point is selected or selection is cleared. */
  onPointPicked?: (point: CopcPointInspection | undefined) => void;
  /** Maximum retained decoded CPU point-buffer bytes. Defaults to 256 MiB. */
  maxPointCacheBytes?: number;
};

type StreamingState = {
  context: CopcSource;
  metadata: CopcMetadata;
  hierarchyLoader: HierarchyLoader;
  nodes: StreamingHierarchy;
  manager: StreamingManager;
};

let nextPickOwnerId = 0;

function createPickOwnerId(): string {
  nextPickOwnerId += 1;
  return `copc-layer-${nextPickOwnerId}`;
}

function toProjectBounds(
  metadata: CopcMetadata,
  geographicBounds: CopcHierarchyBounds,
): CopcProjectBounds {
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

  return corners.reduce<CopcProjectBounds>((bounds, point) => ({
    coordinateSystem: 'copc-source',
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    minZ: Math.min(bounds.minZ, point.z),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
    maxZ: Math.max(bounds.maxZ, point.z),
  }), {
    coordinateSystem: 'copc-source',
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

export type CopcLayerTransitionDiagnostics = {
  activeReplacementGroupCount: number;
  replacementGroupsWaitingCount: number;
  refinementReplacementCommitCount: number;
  collapseReplacementCommitCount: number;
  staleReplacementCancellationCount: number;
  coarseNodesRetainedForCoverageCount: number;
};

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
  transition: CopcLayerTransitionDiagnostics;
  pointCache: NodePointCacheDiagnostics;
  worker?: CopcWorkerDiagnostics;
};

const STREAMING_OPTIONS: StreamingSelectionOptions = {
  maxNodes: 24,
  maxDepth: 6,
  maxScreenSpaceError: 8,
  refineDistanceMultiplier: 6,
  maxRenderDistanceMeters: 12000,
  // #48 measured ~30 ms renderer preparation at 100k points and severe
  // near-view pressure around 418k points. This conservative first default
  // is experimental workload backpressure, not a GPU-memory claim.
  maxRenderedPoints: DEFAULT_MAX_RENDERED_POINTS,
  maxPointsPerBatch: 100000,
};
const MAX_CACHED_NODES = 48;
const DEFAULT_POINT_CACHE_BYTES = 256 * 1024 * 1024;

type ActiveReplacementGroup = StreamingReplacementGroup & {
  generation: number;
};

function createTransitionDiagnostics(): CopcLayerTransitionDiagnostics {
  return {
    activeReplacementGroupCount: 0,
    replacementGroupsWaitingCount: 0,
    refinementReplacementCommitCount: 0,
    collapseReplacementCommitCount: 0,
    staleReplacementCancellationCount: 0,
    coarseNodesRetainedForCoverageCount: 0,
  };
}

/**
 * Internal streaming controller used by the public CopcCesiumLayer facade.
 */
export class CopcLayerController {
  private viewer?: Cesium.Viewer;
  private readonly options: CopcLayerOptions;
  private readonly pointRenderer: CesiumPointRenderer;
  private readonly selectedNodeKeys = new Set<string>();
  private readonly nodePointCache: NodePointCache<GeographicPointBuffer>;
  private readonly performanceRecorder = new StreamingPerformanceRecorder();
  private readonly performanceObserver: CopcPerformanceObserver = (event) => {
    const stage = event.stage === 'rangeFetch'
      ? 'rangeFetchDurationMs'
      : 'decodeDurationMs';
    this.performanceRecorder.recordStage(
      stage,
      event.durationMs,
      event.blocksMainThread ?? event.stage === 'decode',
      event.bytes,
    );
  };
  private streamingState?: StreamingState;
  private updateTimer?: number;
  private loadGeneration = 0;
  private streamingGeneration = 0;
  private streamingUpdateCount = 0;
  private transitionGeneration = 0;
  private readonly activeReplacementGroups = new Map<string, ActiveReplacementGroup>();
  private transitionDiagnostics = createTransitionDiagnostics();
  private hasFlownToDataset = false;
  private lifecycle: CopcLayerLifecycleState = 'idle';
  private selectedPointPickId?: CopcPointPickId;
  private pickHandler?: Cesium.ScreenSpaceEventHandler;
  private readonly pickOwnerId = createPickOwnerId();
  private readonly handleCameraMoveEnd = (): void => {
    void this.scheduleStreamingUpdate();
  };

  /**
   * Create a reusable COPC layer controller.
   */
  constructor(options: CopcLayerOptions) {
    this.options = options;
    this.pointRenderer = options.renderer ?? new PointPrimitiveRenderer();
    this.performanceRecorder.setConfiguredPointBudget(this.getMaxRenderedPoints());
    this.nodePointCache = createNodePointCache(
      async (nodeKey) => this.loadRenderableNodePoints(nodeKey),
      {
        maxEntries: MAX_CACHED_NODES,
        maxBytes: options.maxPointCacheBytes ?? DEFAULT_POINT_CACHE_BYTES,
      },
    );
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
    this.attachPickHandler(this.viewer);
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
    this.detachPickHandler();
    this.pointRenderer.detachFrom();
    this.resetReplacementTransitions();
    this.clearSelectedPoint();
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
      context.destroy?.();
      return;
    }

    context.setPerformanceObserver?.(this.performanceObserver);
    const metadata = await loadCopcMetadata(context);

    if (!this.isCurrentLoad(loadGeneration)) {
      context.destroy?.();
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
      context.destroy?.();
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
        {
          ...STREAMING_OPTIONS,
          ...this.options.streaming,
          ...(this.options.maxRenderedPoints === undefined
            ? {}
            : { maxRenderedPoints: this.options.maxRenderedPoints }),
        },
        this.nodePointCache,
        this.performanceRecorder,
        context.cancelPendingPointJobs?.bind(context),
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
    this.streamingState?.context.destroy?.();
    this.pointRenderer.clear();
    this.resetReplacementTransitions();
    this.clearSelectedPoint();
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
    const worker = this.streamingState?.context.getWorkerDiagnostics?.();
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
      transition: { ...this.transitionDiagnostics },
      pointCache: this.nodePointCache.getDiagnostics(),
      ...(worker ? { worker } : {}),
    };
  }

  getHierarchyDiagnostics() {
    return this.streamingState?.hierarchyLoader.getDiagnostics();
  }

  getPointCacheDiagnostics(): NodePointCacheDiagnostics {
    return this.nodePointCache.getDiagnostics();
  }

  /** Return the selected point if its node and decoded buffer are still live. */
  getSelectedPoint(): CopcPointInspection | undefined {
    const pickId = this.selectedPointPickId;
    const streamingState = this.streamingState;
    if (!pickId || !streamingState || !this.pointRenderer.hasNode(pickId.nodeKey)) {
      if (pickId) {
        this.clearSelectedPoint();
      }
      return undefined;
    }

    const node = streamingState.nodes.get(pickId.nodeKey);
    const points = this.nodePointCache.get(pickId.nodeKey);
    const inspection = node && points
      ? inspectCopcPoint(pickId, node.node, points, getCopcBackendName(this.options.backend))
      : undefined;
    if (!inspection) {
      this.clearSelectedPoint();
    }
    return inspection;
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
    const viewBounds = createStreamingViewBounds({
      camera,
      viewDistanceMeters: camera.viewDistanceMeters,
      maxRenderDistanceMeters: streamingOptions.maxRenderDistanceMeters,
      viewFrustum: camera.viewFrustum,
    });

    return {
      bounds: toProjectBounds(
        metadata,
        viewBounds.bounds,
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
    // Stop queued worker decode as soon as a new camera generation starts,
    // including while the hierarchy query for that generation is in flight.
    streamingState.manager.invalidate?.();
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
        this.applyStreamingProgress(viewer, progress, streamingGeneration);
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
      }, streamingGeneration);
    }

    if (!updateCounted) {
      this.streamingUpdateCount += 1;
    }

  }

  private applyStreamingProgress(
    viewer: Cesium.Viewer,
    progress: StreamingProgress,
    generation: number,
  ): void {
    const streamingState = this.streamingState;
    if (!streamingState) {
      return;
    }

    this.selectedNodeKeys.clear();
    for (const nodeKey of progress.selectedNodeKeys) {
      this.selectedNodeKeys.add(nodeKey);
    }

    this.reconcileReplacementGroups(
      progress.replacementGroups ?? [],
      generation,
    );

    for (const nodeKey of progress.removedNodeKeys) {
      if (this.isReplacementOldNode(nodeKey)) {
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

      const projectedPointCount = this.getProjectedPointCount(
        nodeKey,
        points.pointCount,
      );

      if (projectedPointCount > this.getMaxRenderedPoints()) {
        this.performanceRecorder.recordBudgetDrop(1, points.pointCount);
        continue;
      }

      this.addPointCollection(nodeKey, points);
    }

    this.commitReadyReplacementGroups(generation);
    this.performanceRecorder.setActiveRenderedPointCount(
      this.pointRenderer.getRenderedPointCount(),
    );
    this.updateTransitionDiagnostics();
  }

  private getMaxRenderedPoints(): number {
    return this.options.maxRenderedPoints
      ?? this.options.streaming?.maxRenderedPoints
      ?? STREAMING_OPTIONS.maxRenderedPoints
      ?? DEFAULT_MAX_RENDERED_POINTS;
  }

  private addPointCollection(
    nodeKey: string,
    points: GeographicPointBuffer,
  ): void {
    this.pointRenderer.addOrUpdateNode(nodeKey, points, {
      pointSize: this.options.pointSize ?? 3,
      colorMode: this.options.colorMode ?? 'fixed',
      elevationRange: this.getDatasetElevationRange(),
      pointId: (pointIndex) => ({
        nodeKey,
        pointIndex,
        ownerId: this.pickOwnerId,
      }),
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

  private reconcileReplacementGroups(
    replacementGroups: readonly StreamingReplacementGroup[],
    generation: number,
  ): void {
    if (this.transitionGeneration === generation) {
      return;
    }

    const previousGroups = [...this.activeReplacementGroups.values()];
    const previousStagedNodeKeys = new Set(
      previousGroups.flatMap((group) => group.newNodeKeys),
    );
    for (const nodeKey of previousStagedNodeKeys) {
      if (!this.selectedNodeKeys.has(nodeKey)) {
        this.removePointCollection(nodeKey);
      }
    }
    if (previousGroups.length > 0) {
      this.transitionDiagnostics.staleReplacementCancellationCount += 1;
    }
    this.activeReplacementGroups.clear();
    this.transitionGeneration = generation;

    const desiredNodeKeys = new Set(this.selectedNodeKeys);
    const renderedOldNodeKeys = this.pointRenderer.getRenderedNodeKeys()
      .filter((nodeKey) => !desiredNodeKeys.has(nodeKey));
    const desiredNewNodeKeys = [...desiredNodeKeys]
      .filter((nodeKey) => !this.pointRenderer.hasNode(nodeKey))
      .sort();

    // If the newest desired frontier is already fully renderer-ready, any
    // rendered node outside that frontier is obsolete coverage. This can
    // happen after a superseded transition when the old parent was omitted
    // from the newest manager diff, so it cannot be cleaned up through
    // removedNodeKeys. There is no coverage-safe staging work left in this
    // case: the desired nodes are already present, so remove the stale
    // coverage immediately.
    if (renderedOldNodeKeys.length > 0 && desiredNewNodeKeys.length === 0) {
      for (const nodeKey of renderedOldNodeKeys) {
        this.removePointCollection(nodeKey);
      }
    }

    const incomingOldNodeKeys = new Set(
      replacementGroups.flatMap((group) => group.oldNodeKeys),
    );
    const incomingNewNodeKeys = new Set(
      replacementGroups.flatMap((group) => group.newNodeKeys),
    );
    const groupsCoverCurrentRenderer = renderedOldNodeKeys.every((nodeKey) =>
      incomingOldNodeKeys.has(nodeKey))
      && desiredNewNodeKeys.every((nodeKey) => incomingNewNodeKeys.has(nodeKey));

    const groups = renderedOldNodeKeys.length > 0
      && desiredNewNodeKeys.length > 0
      && !groupsCoverCurrentRenderer
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
      });
    }
  }

  private inferReplacementKind(
    groups: readonly StreamingReplacementGroup[],
  ): StreamingReplacementKind {
    return groups.length === 1 ? groups[0].kind : 'retarget';
  }

  private getReplacementGroupKey(group: StreamingReplacementGroup): string {
    return `${group.kind}:${[...group.oldNodeKeys].sort().join(',')}->${[...group.newNodeKeys].sort().join(',')}`;
  }

  private isReplacementOldNode(nodeKey: string): boolean {
    return [...this.activeReplacementGroups.values()]
      .some((group) => group.oldNodeKeys.includes(nodeKey));
  }

  private getProjectedPointCount(
    nodeKey: string,
    pointCount: number,
  ): number {
    let projectedPointCount = this.pointRenderer.getRenderedPointCount();
    const replacedNodeKeys = new Set(
      [...this.activeReplacementGroups.values()]
        .flatMap((group) => group.oldNodeKeys),
    );

    for (const oldNodeKey of replacedNodeKeys) {
      if (!this.pointRenderer.hasNode(oldNodeKey)) {
        continue;
      }
      projectedPointCount -= this.pointRenderer.getRenderedNodePointCount?.(oldNodeKey)
        ?? this.streamingState?.nodes.get(oldNodeKey)?.node.pointCount
        ?? 0;
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

      // All replacement nodes were prepared before this synchronous commit,
      // so removing the old coverage cannot expose an intentional hole.
      for (const oldNodeKey of group.oldNodeKeys) {
        this.removePointCollection(oldNodeKey);
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

  private removePointCollection(nodeKey: string): void {
    if (this.selectedPointPickId?.nodeKey === nodeKey) {
      this.clearSelectedPoint();
    }
    this.pointRenderer.removeNode(nodeKey);
  }

  private attachPickHandler(viewer: Cesium.Viewer): void {
    const canvas = viewer.scene.canvas;
    if (!canvas) {
      return;
    }

    this.pickHandler = new Cesium.ScreenSpaceEventHandler(canvas);
    this.pickHandler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      this.handlePick(viewer, movement.position);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  private handlePick(viewer: Cesium.Viewer, position: Cesium.Cartesian2): void {
    const picked = viewer.scene.pick(position) as { id?: unknown } | undefined;
    if (!picked || !isCopcPointPickId(picked.id)
      || picked.id.ownerId !== this.pickOwnerId) {
      this.clearSelectedPoint();
      return;
    }

    const pickId = picked.id;
    const node = this.streamingState?.nodes.get(pickId.nodeKey);
    const points = this.nodePointCache.get(pickId.nodeKey);
    const inspection = node && points
      ? inspectCopcPoint(
        pickId,
        node.node,
        points,
        getCopcBackendName(this.options.backend),
      )
      : undefined;

    if (!inspection || !this.pointRenderer.hasNode(pickId.nodeKey)) {
      this.clearSelectedPoint();
      return;
    }

    this.selectedPointPickId = pickId;
    this.options.onPointPicked?.(inspection);
  }

  private detachPickHandler(): void {
    this.pickHandler?.destroy();
    this.pickHandler = undefined;
  }

  private clearSelectedPoint(): void {
    if (!this.selectedPointPickId) {
      return;
    }

    this.selectedPointPickId = undefined;
    this.options.onPointPicked?.(undefined);
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
