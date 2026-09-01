import * as Cesium from 'cesium';
import {
  PointPrimitiveRenderer,
  type CesiumPointRenderer,
} from '../cesium/render/CopcPointRenderer';
import { createCesiumStreamingView } from '../cesium/view/CesiumViewAdapter';
import {
  getCopcPointFieldSelection,
  type CopcColorMode,
} from '../copc/points/fieldSelection';
import type {
  CopcBackendName,
  CopcBackendSelection,
} from '../copc/backend/selection';
import type { CopcWorkerDiagnostics } from '../copc/backend/types';
import {
  inspectCopcPoint,
  isCopcPointPickId,
  type CopcPointInspection,
  type CopcPointPickId,
} from '../copc/points/pointInspection';
import type { CopcMetadata, GeographicPointBuffer } from '../copc/types/copc';
import { extractHorizontalUnitScale } from '../coordinates/crs/parseCopcWkt';
import { createPointTransformer } from '../coordinates/transform/createPointTransformer';
import {
  CopcStreamingCore,
  type CopcStreamingPerformanceSnapshot,
  type CopcStreamingProgressHandler,
} from './streaming/CopcStreamingController';
import type {
  StreamingProgress,
  StreamingReplacementGroup,
  StreamingReplacementKind,
  StreamingSelectionOptions,
} from './streaming/types';
import { DEFAULT_MAX_RENDERED_POINTS } from './streaming/NodeSelector';
import { StreamingPerformanceRecorder } from './streaming/performance';
import type { NodePointCacheDiagnostics } from './streaming/createNodePointCache';

export type CopcLayerOptions = {
  url: string;
  pointSize?: number;
  colorMode?: CopcColorMode;
  debug?: boolean;
  maxRenderedPoints?: number;
  streaming?: Partial<StreamingSelectionOptions>;
  backend?: CopcBackendSelection;
  decoder?: import('../copc/points/types').CopcPointDecoder;
  renderer?: CesiumPointRenderer;
  /** Called when a rendered COPC point is selected or selection is cleared. */
  onPointPicked?: (point: CopcPointInspection | undefined) => void;
  /** Maximum retained decoded CPU point-buffer bytes. Defaults to 256 MiB. */
  maxPointCacheBytes?: number;
};

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
  performance: ReturnType<StreamingPerformanceRecorder['getSnapshot']>;
  transition: CopcLayerTransitionDiagnostics;
  pointCache: NodePointCacheDiagnostics;
  worker?: CopcWorkerDiagnostics;
};

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

function combinePerformance(
  corePerformance: CopcStreamingPerformanceSnapshot,
  rendererPerformance: ReturnType<StreamingPerformanceRecorder['getSnapshot']>,
  renderedPointCount: number,
): ReturnType<StreamingPerformanceRecorder['getSnapshot']> {
  const configuredPointBudget = corePerformance.configuredPointBudget
    || rendererPerformance.configuredPointBudget;
  const activeRenderedPointCount = Math.max(0, renderedPointCount);

  return {
    ...corePerformance,
    configuredPointBudget,
    activeRenderedPointCount,
    budgetUtilizationPercent: configuredPointBudget > 0
      ? (activeRenderedPointCount / configuredPointBudget) * 100
      : 0,
    deferredNodeCount: corePerformance.deferredNodeCount
      + rendererPerformance.deferredNodeCount,
    deferredPointCount: corePerformance.deferredPointCount
      + rendererPerformance.deferredPointCount,
    budgetDeferDropCount: corePerformance.budgetDeferDropCount
      + rendererPerformance.budgetDeferDropCount,
    geographicToCartesianDurationMs: rendererPerformance.geographicToCartesianDurationMs,
    pointStylePreparationDurationMs: rendererPerformance.pointStylePreparationDurationMs,
    pointCollectionCreationDurationMs: rendererPerformance.pointCollectionCreationDurationMs,
    pointAddDurationMs: rendererPerformance.pointAddDurationMs,
    rendererPreparationDurationMs: rendererPerformance.rendererPreparationDurationMs,
    nodeRemovalDurationMs: rendererPerformance.nodeRemovalDurationMs,
    longestMainThreadBlockingSectionMs: Math.max(
      corePerformance.longestMainThreadBlockingSectionMs,
      rendererPerformance.longestMainThreadBlockingSectionMs,
    ),
  };
}

let nextPickOwnerId = 0;

function createPickOwnerId(): string {
  nextPickOwnerId += 1;
  return `copc-layer-${nextPickOwnerId}`;
}

/**
 * Cesium adapter for the renderer-neutral COPC streaming core.
 *
 * This class owns only Cesium attachment, camera scheduling, point primitive
 * reconciliation, and picking. Source loading, hierarchy traversal,
 * selection, point caching, and view generations belong to `CopcStreamingCore`.
 */
export class CopcLayerController {
  private readonly core: CopcStreamingCore;
  private readonly options: CopcLayerOptions;
  private readonly pointRenderer: CesiumPointRenderer;
  private readonly rendererPerformance = new StreamingPerformanceRecorder();
  private viewer?: Cesium.Viewer;
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

  constructor(options: CopcLayerOptions) {
    this.options = options;
    this.pointRenderer = options.renderer ?? new PointPrimitiveRenderer();
    this.rendererPerformance.setConfiguredPointBudget(this.getMaxRenderedPoints());
    this.core = new CopcStreamingCore({
      url: options.url,
      backend: options.backend,
      decoder: options.decoder,
      debug: options.debug,
      maxRenderedPoints: options.maxRenderedPoints,
      maxPointCacheBytes: options.maxPointCacheBytes,
      pointFields: getCopcPointFieldSelection(options.colorMode ?? 'fixed'),
      streaming: options.streaming,
    });
  }

  /** Attach the layer's Cesium primitives and camera listeners. */
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
    this.attachPickHandler(viewer);
    if (this.lifecycle !== 'loading') {
      this.lifecycle = this.core.getMetadata() ? 'ready' : 'mounted';
    }

    const metadata = this.core.getMetadata();
    if (metadata) {
      this.flyToDataset(metadata);
      void this.updateStreamingView();
    }
  }

  /** Detach primitives and listeners without unloading COPC data. */
  detachFrom(): void {
    this.streamingGeneration += 1;
    this.core.invalidateView();
    this.clearScheduledUpdate();

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
    this.lifecycle = this.core.getMetadata() ? 'ready' : 'idle';
  }

  /** Load source metadata and the root hierarchy without requiring a viewer. */
  async load(): Promise<void> {
    if (this.lifecycle === 'destroyed') {
      throw new Error('CopcCesiumLayer has been destroyed');
    }
    if (this.core.getMetadata()) {
      throw new Error('COPC layer is already loaded; call reload() to load it again');
    }
    if (this.lifecycle === 'loading') {
      throw new Error('COPC layer is already loading');
    }

    this.lifecycle = 'loading';
    const loadGeneration = ++this.loadGeneration;
    try {
      await this.core.load();
    } catch (error: unknown) {
      if (loadGeneration === this.loadGeneration) {
        this.lifecycle = this.viewer ? 'mounted' : 'idle';
      }
      throw error;
    }

    if (loadGeneration !== this.loadGeneration) {
      return;
    }

    this.lifecycle = 'ready';
    this.debug('COPC metadata and hierarchy loaded');
    if (this.viewer) {
      const metadata = this.core.getMetadata();
      if (metadata) {
        this.flyToDataset(metadata);
      }
      await this.updateStreamingView();
    }
  }

  /** Release loaded COPC data while retaining the layer and viewer attachment. */
  unload(): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }

    this.loadGeneration += 1;
    this.streamingGeneration += 1;
    this.clearScheduledUpdate();
    this.core.unload();
    this.pointRenderer.clear();
    this.resetReplacementTransitions();
    this.clearSelectedPoint();
    this.streamingUpdateCount = 0;
    this.hasFlownToDataset = false;
    this.lifecycle = this.viewer ? 'mounted' : 'idle';
    this.debug('COPC layer unloaded');
  }

  /** Unload and load the configured COPC resource again. */
  async reload(): Promise<void> {
    this.unload();
    await this.load();
  }

  /** Release layer resources without destroying the caller-owned viewer. */
  destroy(): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }

    this.loadGeneration += 1;
    this.core.destroy();
    this.clearScheduledUpdate();
    this.detachFrom();
    this.pointRenderer.destroy();
    this.lifecycle = 'destroyed';
  }

  getSnapshot(): CopcLayerSnapshot {
    const coreSnapshot = this.core.getSnapshot();
    const renderedPointCount = this.getRenderedPointCount();
    return {
      lifecycle: this.lifecycle,
      renderedNodeKeys: this.getRenderedNodeKeys(),
      selectedNodeKeys: this.core.getCurrentSelection(),
      renderedPointCount,
      streamingUpdateCount: this.streamingUpdateCount,
      datasetUrl: this.options.url,
      attached: this.viewer !== undefined,
      backend: coreSnapshot.backend,
      performance: combinePerformance(
        coreSnapshot.performance,
        this.rendererPerformance.getSnapshot(),
        renderedPointCount,
      ),
      transition: { ...this.transitionDiagnostics },
      pointCache: coreSnapshot.pointCache,
      ...(coreSnapshot.worker ? { worker: coreSnapshot.worker } : {}),
    };
  }

  getHierarchyDiagnostics() {
    return this.core.getHierarchyDiagnostics();
  }

  getPointCacheDiagnostics(): NodePointCacheDiagnostics {
    return this.core.getPointCacheDiagnostics();
  }

  getMetadata(): CopcMetadata | undefined {
    return this.core.getMetadata();
  }

  /** Return the selected point while its node and decoded buffer are live. */
  getSelectedPoint(): CopcPointInspection | undefined {
    const pickId = this.selectedPointPickId;
    const node = pickId ? this.core.getHierarchyNode(pickId.nodeKey) : undefined;
    if (!pickId || !node || !this.pointRenderer.hasNode(pickId.nodeKey)) {
      if (pickId) {
        this.clearSelectedPoint();
      }
      return undefined;
    }

    const points = this.core.getCachedPointBuffer(pickId.nodeKey);
    const inspection = points
      ? inspectCopcPoint(
        pickId,
        node.node,
        points,
        this.core.getSnapshot().backend,
      )
      : undefined;
    if (!inspection) {
      this.clearSelectedPoint();
    }
    return inspection;
  }

  getRenderedNodeKeys(): string[] {
    return this.pointRenderer.getRenderedNodeKeys();
  }

  getRenderedPointCount(): number {
    return this.pointRenderer.getRenderedPointCount();
  }

  getCurrentSelection(): string[] {
    return this.core.getCurrentSelection();
  }

  getSelectionBoundingSphere(): Cesium.BoundingSphere | undefined {
    return this.pointRenderer.getSelectionBoundingSphere();
  }

  private async updateStreamingView(): Promise<void> {
    const viewer = this.viewer;
    if (!viewer || !this.core.getMetadata() || this.lifecycle === 'destroyed') {
      return;
    }

    const streamingGeneration = ++this.streamingGeneration;
    const view = createCesiumStreamingView(viewer);
    this.rendererPerformance.beginUpdate();
    let progressApplied = false;
    let updateCounted = false;
    const onProgress: CopcStreamingProgressHandler = (progress) => {
      if (!this.isCurrentStreamingGeneration(streamingGeneration, viewer)) {
        return;
      }

      progressApplied = true;
      if (progress.loadedNodePoints.size > 0 && !updateCounted) {
        this.streamingUpdateCount += 1;
        updateCounted = true;
      }
      this.applyStreamingProgress(viewer, progress, streamingGeneration);
    };

    const update = await this.core.updateView(view, onProgress);
    if (!this.isCurrentStreamingGeneration(streamingGeneration, viewer) || !update) {
      return;
    }

    // Keep the adapter tolerant of alternate core implementations that only
    // return an all-at-once update and do not emit progress.
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
    this.reconcileReplacementGroups(
      progress.replacementGroups ?? [],
      generation,
      progress.selectedNodeKeys,
    );

    for (const nodeKey of progress.removedNodeKeys) {
      if (!this.isReplacementOldNode(nodeKey)) {
        this.removePointCollection(nodeKey);
      }
    }

    for (const [nodeKey, points] of progress.loadedNodePoints) {
      if (this.viewer !== viewer || !progress.selectedNodeKeys.includes(nodeKey)) {
        continue;
      }
      if (this.pointRenderer.hasNode(nodeKey)) {
        continue;
      }

      if (this.getProjectedPointCount(nodeKey, points.pointCount) > this.getMaxRenderedPoints()) {
        this.rendererPerformance.recordBudgetDrop(1, points.pointCount);
        continue;
      }

      this.addPointCollection(nodeKey, points);
    }

    this.commitReadyReplacementGroups(generation);
    this.rendererPerformance.setActiveRenderedPointCount(this.getRenderedPointCount());
    this.updateTransitionDiagnostics();
  }

  private addPointCollection(nodeKey: string, points: GeographicPointBuffer): void {
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
        this.rendererPerformance.recordStage(metricStage, durationMs, true);
      },
    });
  }

  private reconcileReplacementGroups(
    replacementGroups: readonly StreamingReplacementGroup[],
    generation: number,
    selectedNodeKeys: readonly string[],
  ): void {
    if (this.transitionGeneration === generation) {
      return;
    }

    const previousGroups = [...this.activeReplacementGroups.values()];
    const previousStagedNodeKeys = new Set(
      previousGroups.flatMap((group) => group.newNodeKeys),
    );
    for (const nodeKey of previousStagedNodeKeys) {
      if (!selectedNodeKeys.includes(nodeKey)) {
        this.removePointCollection(nodeKey);
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

  private getProjectedPointCount(nodeKey: string, pointCount: number): number {
    let projectedPointCount = this.getRenderedPointCount();
    const replacedNodeKeys = new Set(
      [...this.activeReplacementGroups.values()]
        .flatMap((group) => group.oldNodeKeys),
    );

    for (const oldNodeKey of replacedNodeKeys) {
      if (!this.pointRenderer.hasNode(oldNodeKey)) {
        continue;
      }
      projectedPointCount -= this.pointRenderer.getRenderedNodePointCount?.(oldNodeKey)
        ?? this.core.getHierarchyNode(oldNodeKey)?.node.pointCount
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
    const node = this.core.getHierarchyNode(pickId.nodeKey);
    const points = this.core.getCachedPointBuffer(pickId.nodeKey);
    const inspection = node && points
      ? inspectCopcPoint(
        pickId,
        node.node,
        points,
        this.core.getSnapshot().backend,
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

  private getDatasetElevationRange(): { min: number; max: number } {
    const metadata = this.core.getMetadata();
    if (!metadata) {
      return { min: 0, max: 0 };
    }

    const transformPoint = createPointTransformer(metadata);
    const x = (metadata.bounds.minX + metadata.bounds.maxX) / 2;
    const y = (metadata.bounds.minY + metadata.bounds.maxY) / 2;
    return {
      min: transformPoint({ x, y, z: metadata.bounds.minZ }).height,
      max: transformPoint({ x, y, z: metadata.bounds.maxZ }).height,
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
    this.clearScheduledUpdate();
    this.updateTimer = window.setTimeout(() => {
      this.updateTimer = undefined;
      void this.updateStreamingView();
    }, 100);
  }

  private clearScheduledUpdate(): void {
    if (this.updateTimer !== undefined) {
      window.clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
  }

  private isCurrentStreamingGeneration(
    generation: number,
    viewer: Cesium.Viewer,
  ): boolean {
    return generation === this.streamingGeneration
      && this.viewer === viewer
      && this.lifecycle !== 'destroyed';
  }

  private getMaxRenderedPoints(): number {
    return this.options.maxRenderedPoints
      ?? this.options.streaming?.maxRenderedPoints
      ?? DEFAULT_MAX_RENDERED_POINTS;
  }

  private debug(message: string): void {
    if (this.options.debug) {
      console.debug(`[CopcCesiumLayer] ${message}`);
    }
  }
}
