import * as THREE from 'three';
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
import type {
  CopcMetadata,
  GeographicPointBuffer,
  PreparedPointData,
} from '../copc/types/copc';
import {
  createDatasetLocalFrame,
} from '../coordinates/transform/datasetLocalFrame';
import type { DatasetLocalFrame } from '../coordinates/types';
import {
  CopcStreamingCore,
  type CopcStreamingPerformanceSnapshot,
  type CopcStreamingProgressHandler,
} from '../viewer/streaming/CopcStreamingController';
import type {
  StreamingProgress,
  StreamingReplacementGroup,
  StreamingReplacementKind,
  StreamingSelectionOptions,
  StreamingView,
} from '../viewer/streaming/types';
import { DEFAULT_MAX_RENDERED_POINTS } from '../viewer/streaming/NodeSelector';
import type { NodePointCacheDiagnostics } from '../viewer/streaming/createNodePointCache';
import {
  ThreePointRenderer,
  type ThreePointRendererOptions,
  type ThreePointRendererPerformanceStage,
} from '../three/render/ThreePointRenderer';
import {
  createThreeStreamingView,
  type ThreeViewportSource,
} from '../three/view/ThreeViewAdapter';
import type { CopcPointRenderer } from '../viewer/streaming/renderer';
import { createCopcPointStyleState } from '../point/style/pointStyle';

export type CopcThreeLayerOptions = {
  /** Browser-readable COPC resource URL with HTTP range-request support. */
  url: string;
  /** Three.js point size in screen-facing pixels. Defaults to 3. */
  pointSize?: number;
  /** Point color mapping. Defaults to the fixed cyan fallback. */
  colorMode?: CopcColorMode;
  /** Maximum estimated points in the active current-view workload. */
  maxRenderedPoints?: number;
  /** Overrides for the shared streaming selection limits. */
  streaming?: Partial<StreamingSelectionOptions>;
  /** Defaults to stable `copc-js`; `rust` is explicit opt-in. */
  backend?: CopcBackendSelection;
  /** Decoder used to convert point-data views into project point buffers. */
  decoder?: import('../copc/points/types').CopcPointDecoder;
  /** Maximum retained decoded CPU point-buffer bytes. */
  maxPointCacheBytes?: number;
  /** Emits layer/core lifecycle messages through console.debug. */
  debug?: boolean;
  /** Scene-unit threshold used by the default point raycaster. Defaults to 1. */
  pickingThreshold?: number;
  /** Optional renderer seam for tests or a compatible Three renderer. */
  renderer?: CopcThreePointRenderer;
  /** Called when a point is selected or selection is cleared. */
  onPointPicked?: (point: CopcPointInspection | undefined) => void;
};

export type CopcThreeLayerAttachment = {
  /** Application-owned Three scene. */
  scene: THREE.Scene;
  /** Application-owned camera whose local coordinates use the layer frame. */
  camera: THREE.Camera;
  /** Application-owned renderer, used only to read the drawing-buffer size. */
  renderer?: ThreeViewportSource;
};

export type CopcThreeLayerLifecycleState =
  | 'idle'
  | 'mounted'
  | 'loading'
  | 'ready'
  | 'destroyed';

export type CopcThreeLayerTransitionDiagnostics = {
  activeReplacementGroupCount: number;
  replacementGroupsWaitingCount: number;
  refinementReplacementCommitCount: number;
  collapseReplacementCommitCount: number;
  staleReplacementCancellationCount: number;
  coarseNodesRetainedForCoverageCount: number;
};

export type CopcThreeRendererPerformanceSnapshot = {
  worldToLocalDurationMs: number;
  geometryCreationDurationMs: number;
  materialCreationDurationMs: number;
  rendererPreparationDurationMs: number;
  nodeRemovalDurationMs: number;
};

export type CopcThreeLayerSnapshot = {
  lifecycle: CopcThreeLayerLifecycleState;
  attached: boolean;
  datasetUrl: string;
  backend: CopcBackendName | 'custom';
  selectedNodeKeys: string[];
  renderedNodeKeys: string[];
  renderedPointCount: number;
  streamingUpdateCount: number;
  performance: CopcStreamingPerformanceSnapshot;
  renderer: CopcThreeRendererPerformanceSnapshot;
  transition: CopcThreeLayerTransitionDiagnostics;
  hierarchy?: import('../copc/hierarchy/types').CopcHierarchyDiagnostics;
  pointCache: NodePointCacheDiagnostics;
  worker?: CopcWorkerDiagnostics;
};

export type CopcThreeLayerPickPosition = {
  /** Normalized device coordinate in the range normally used by Three.js. */
  x: number;
  /** Normalized device coordinate in the range normally used by Three.js. */
  y: number;
};

export type CopcThreeLayerPickOptions = {
  raycaster?: THREE.Raycaster;
  threshold?: number;
};

export interface CopcThreePointRenderer extends CopcPointRenderer {
  attachTo(scene: THREE.Scene): void;
  detachFrom(): void;
  getRoot(): THREE.Group;
  addOrUpdateNode(
    nodeKey: string,
    points: GeographicPointBuffer | PreparedPointData,
    options: ThreePointRendererOptions,
  ): void;
  setLocalFrame?(frame: DatasetLocalFrame): void;
}

type ActiveReplacementGroup = StreamingReplacementGroup & {
  generation: number;
};

type ActiveStreamingUpdate = {
  progressApplied: boolean;
};

function createTransitionDiagnostics(): CopcThreeLayerTransitionDiagnostics {
  return {
    activeReplacementGroupCount: 0,
    replacementGroupsWaitingCount: 0,
    refinementReplacementCommitCount: 0,
    collapseReplacementCommitCount: 0,
    staleReplacementCancellationCount: 0,
    coarseNodesRetainedForCoverageCount: 0,
  };
}

function createRendererPerformanceSnapshot(): CopcThreeRendererPerformanceSnapshot {
  return {
    worldToLocalDurationMs: 0,
    geometryCreationDurationMs: 0,
    materialCreationDurationMs: 0,
    rendererPreparationDurationMs: 0,
    nodeRemovalDurationMs: 0,
  };
}

const STREAMING_VIEW_POSITION_EPSILON = 0.1;
const STREAMING_VIEW_ANGLE_EPSILON = 1e-5;
const STREAMING_VIEW_DISTANCE_EPSILON = 1;

function isClose(left: number, right: number, epsilon: number): boolean {
  return Math.abs(left - right) <= epsilon;
}

function areStreamingViewsEquivalent(left: StreamingView, right: StreamingView): boolean {
  if (!isClose(left.longitude, right.longitude, 1e-7)
    || !isClose(left.latitude, right.latitude, 1e-7)
    || !isClose(left.height, right.height, STREAMING_VIEW_POSITION_EPSILON)
    || !isClose(left.viewDistanceMeters, right.viewDistanceMeters, STREAMING_VIEW_DISTANCE_EPSILON)) {
    return false;
  }

  const leftFrustum = left.viewFrustum;
  const rightFrustum = right.viewFrustum;
  if (!leftFrustum || !rightFrustum) {
    return leftFrustum === rightFrustum;
  }

  return [
    [leftFrustum.position, rightFrustum.position],
    [leftFrustum.direction, rightFrustum.direction],
    [leftFrustum.up, rightFrustum.up],
    [leftFrustum.right, rightFrustum.right],
  ].every(([leftVector, rightVector]) =>
    isClose(leftVector.x, rightVector.x, STREAMING_VIEW_ANGLE_EPSILON)
      && isClose(leftVector.y, rightVector.y, STREAMING_VIEW_ANGLE_EPSILON)
      && isClose(leftVector.z, rightVector.z, STREAMING_VIEW_ANGLE_EPSILON),
  )
    && isClose(leftFrustum.verticalFovRadians, rightFrustum.verticalFovRadians, STREAMING_VIEW_ANGLE_EPSILON)
    && isClose(leftFrustum.aspectRatio, rightFrustum.aspectRatio, STREAMING_VIEW_ANGLE_EPSILON)
    && isClose(leftFrustum.viewportHeightPixels, rightFrustum.viewportHeightPixels, 1)
    && isClose(leftFrustum.nearMeters, rightFrustum.nearMeters, STREAMING_VIEW_DISTANCE_EPSILON)
    && isClose(leftFrustum.farMeters, rightFrustum.farMeters, STREAMING_VIEW_DISTANCE_EPSILON);
}

function isPickOptions(value: unknown): value is CopcThreeLayerPickOptions {
  return value !== null
    && typeof value === 'object'
    && ('raycaster' in value || 'threshold' in value);
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

let nextPickOwnerId = 0;

function createPickOwnerId(): string {
  nextPickOwnerId += 1;
  return `copc-three-layer-${nextPickOwnerId}`;
}

/** Public Three.js façade over the renderer-neutral COPC streaming core. */
export class CopcThreeLayer {
  private readonly core: CopcStreamingCore;
  private readonly options: CopcThreeLayerOptions;
  private readonly pointRenderer: CopcThreePointRenderer;
  private readonly pointStyleState = createCopcPointStyleState();
  private readonly pickOwnerId = createPickOwnerId();
  private attachment?: CopcThreeLayerAttachment;
  private localFrame?: DatasetLocalFrame;
  private lifecycle: CopcThreeLayerLifecycleState = 'idle';
  private loadGeneration = 0;
  private streamingGeneration = 0;
  private lastStreamingView?: StreamingView;
  private updatePending = false;
  private updateInFlight = false;
  private updateInFlightPromise?: Promise<void>;
  private activeStreamingUpdate?: ActiveStreamingUpdate;
  private readonly activeReplacementGroups = new Map<string, ActiveReplacementGroup>();
  private transitionGeneration = 0;
  private transitionDiagnostics = createTransitionDiagnostics();
  private rendererPerformance = createRendererPerformanceSnapshot();
  private selectedPointPickId?: CopcPointPickId;
  private selectedPointLoadGeneration = 0;

  constructor(options: CopcThreeLayerOptions) {
    if (!options || typeof options.url !== 'string' || options.url.length === 0) {
      throw new Error('CopcThreeLayer requires a non-empty URL');
    }
    if (options.pickingThreshold !== undefined
      && !isFinitePositive(options.pickingThreshold)) {
      throw new Error('CopcThreeLayer pickingThreshold must be a positive finite number');
    }

    this.options = options;
    this.pointRenderer = options.renderer ?? new ThreePointRenderer();
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

  /** Attach only the layer-owned root group to an application scene. */
  attachTo(attachment: CopcThreeLayerAttachment): void {
    if (this.lifecycle === 'destroyed') {
      throw new Error('CopcThreeLayer has been destroyed');
    }
    if (!attachment || !attachment.scene || typeof attachment.scene.add !== 'function') {
      throw new Error('CopcThreeLayer requires a Three.js scene');
    }
    if (!attachment.camera || typeof attachment.camera.getWorldPosition !== 'function') {
      throw new Error('CopcThreeLayer requires a Three.js camera');
    }
    if (this.attachment === attachment) {
      return;
    }
    if (this.attachment) {
      this.detachFrom();
    }

    this.attachment = attachment;
    this.pointRenderer.attachTo(attachment.scene);
    this.applyLocalFrame();
    if (this.lifecycle !== 'loading') {
      this.lifecycle = this.core.getMetadata() ? 'ready' : 'mounted';
    }
  }

  /** Detach the root and integration state while retaining loaded source data. */
  detachFrom(): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }

    this.streamingGeneration += 1;
    this.core.invalidateView();
    this.updatePending = false;
    this.pointRenderer.detachFrom();
    this.resetReplacementTransitions();
    this.clearSelectedPoint();
    this.lastStreamingView = undefined;
    this.activeStreamingUpdate = undefined;
    this.attachment = undefined;
    this.resetRendererPerformance();
    if (this.lifecycle !== 'loading') {
      this.lifecycle = this.core.getMetadata() ? 'ready' : 'idle';
    }
  }

  /** Load metadata and root hierarchy without requiring a scene attachment. */
  async load(): Promise<void> {
    if (this.lifecycle === 'destroyed') {
      throw new Error('CopcThreeLayer has been destroyed');
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
      if (loadGeneration !== this.loadGeneration) {
        return;
      }

      const metadata = this.core.getMetadata();
      if (!metadata) {
        throw new Error('COPC layer loaded without metadata');
      }
      this.localFrame = createDatasetLocalFrame(metadata);
      this.applyLocalFrame();
      this.lifecycle = 'ready';
      this.debug('COPC metadata and hierarchy loaded');
    } catch (error: unknown) {
      if (loadGeneration === this.loadGeneration) {
        this.unload();
      }
      throw error;
    }
  }

  /** Update streaming from the current camera; never renders or schedules frames. */
  update(): Promise<void> {
    if (this.lifecycle === 'destroyed') {
      throw new Error('CopcThreeLayer has been destroyed');
    }
    const attachment = this.attachment;
    if (!attachment || !this.core.getMetadata() || this.lifecycle === 'loading') {
      return Promise.resolve();
    }

    const view = this.createView(attachment);
    if (this.updateInFlight) {
      if (!this.lastStreamingView || !areStreamingViewsEquivalent(this.lastStreamingView, view)) {
        this.updatePending = true;
        this.streamingGeneration += 1;
        // The recorded view belongs to the invalidated generation. Clearing it
        // prevents a retry from being mistaken for an unchanged view if the
        // camera returns to that generation before the stale update settles.
        this.lastStreamingView = undefined;
        this.core.invalidateView();
      }
      return this.updateInFlightPromise ?? Promise.resolve();
    }
    if (this.lastStreamingView && areStreamingViewsEquivalent(this.lastStreamingView, view)) {
      return Promise.resolve();
    }

    this.updatePending = true;
    const updatePromise = this.runPendingStreamingUpdates();
    this.updateInFlightPromise = updatePromise;
    this.updateInFlight = true;
    void updatePromise.then(() => {
      if (this.updateInFlightPromise === updatePromise) {
        this.updateInFlightPromise = undefined;
        this.updateInFlight = false;
      }
    }, () => {
      if (this.updateInFlightPromise === updatePromise) {
        this.updateInFlightPromise = undefined;
        this.updateInFlight = false;
      }
    });
    return updatePromise;
  }

  /** Release loaded source and rendered nodes while retaining the attachment. */
  unload(): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }

    this.loadGeneration += 1;
    this.streamingGeneration += 1;
    this.updatePending = false;
    this.core.unload();
    this.pointRenderer.clear();
    this.pointStyleState.reset();
    this.resetReplacementTransitions();
    this.clearSelectedPoint();
    this.lastStreamingView = undefined;
    this.activeStreamingUpdate = undefined;
    this.localFrame = undefined;
    this.resetRendererPerformance();
    this.lifecycle = this.attachment ? 'mounted' : 'idle';
    this.debug('COPC layer unloaded');
  }

  /** Unload and load the configured COPC resource again. */
  async reload(): Promise<void> {
    this.unload();
    await this.load();
  }

  /** Release layer-owned resources without touching scene, camera, or renderer. */
  destroy(): void {
    if (this.lifecycle === 'destroyed') {
      return;
    }

    this.loadGeneration += 1;
    this.core.destroy();
    this.updatePending = false;
    this.detachFrom();
    this.pointRenderer.destroy();
    this.lifecycle = 'destroyed';
  }

  /** Return the layer-owned root group for optional application composition. */
  getRoot(): THREE.Group {
    return this.pointRenderer.getRoot();
  }

  /** Return the fixed dataset-local frame used by the layer, when loaded. */
  getLocalFrame(): DatasetLocalFrame | undefined {
    return this.localFrame;
  }

  getMetadata(): CopcMetadata | undefined {
    return this.core.getMetadata();
  }

  getHierarchyDiagnostics() {
    return this.core.getHierarchyDiagnostics();
  }

  getPointCacheDiagnostics(): NodePointCacheDiagnostics {
    return this.core.getPointCacheDiagnostics();
  }

  getCurrentSelection(): string[] {
    return this.core.getCurrentSelection();
  }

  getRenderedNodeKeys(): string[] {
    return this.pointRenderer.getRenderedNodeKeys();
  }

  getRenderedPointCount(): number {
    return this.pointRenderer.getRenderedPointCount();
  }

  /** Return the selected point while its node and decoded buffer are live. */
  getSelectedPoint(): CopcPointInspection | undefined {
    const pickId = this.selectedPointPickId;
    if (!pickId || this.selectedPointLoadGeneration !== this.loadGeneration) {
      if (pickId) {
        this.clearSelectedPoint();
      }
      return undefined;
    }

    const node = this.core.getHierarchyNode(pickId.nodeKey);
    const points = this.core.getCachedPointBuffer(pickId.nodeKey);
    const inspection = node && points && this.pointRenderer.hasNode(pickId.nodeKey)
      ? inspectCopcPoint(pickId, node.node, points, this.core.getSnapshot().backend)
      : undefined;
    if (!inspection) {
      this.clearSelectedPoint();
    }
    return inspection;
  }

  /**
   * Raycast in normalized device coordinates and resolve the first owned COPC
   * point through the current decoded cache. The threshold is in scene units.
   */
  pick(
    position: CopcThreeLayerPickPosition,
    raycasterOrOptions?: THREE.Raycaster | CopcThreeLayerPickOptions,
  ): CopcPointInspection | undefined {
    const attachment = this.attachment;
    if (!attachment || !this.localFrame || !Number.isFinite(position.x)
      || !Number.isFinite(position.y)) {
      this.clearSelectedPoint();
      return undefined;
    }

    const options = isPickOptions(raycasterOrOptions) ? raycasterOrOptions : undefined;
    const raycaster = options?.raycaster
      ?? (raycasterOrOptions && !isPickOptions(raycasterOrOptions)
        ? raycasterOrOptions
        : new THREE.Raycaster());
    const threshold = options?.threshold
      ?? this.options.pickingThreshold
      ?? 1;
    if (!isFinitePositive(threshold)) {
      throw new Error('CopcThreeLayer pick threshold must be a positive finite number');
    }

    raycaster.params.Points.threshold = threshold;
    raycaster.setFromCamera(new THREE.Vector2(position.x, position.y), attachment.camera);
    const intersections = raycaster.intersectObject(this.pointRenderer.getRoot(), true);
    for (const intersection of intersections) {
      const pointObject = this.getOwnedPointObject(intersection.object);
      const pointIndex = intersection.index;
      if (!pointObject || pointIndex === undefined
        || !Number.isSafeInteger(pointIndex) || pointIndex < 0) {
        continue;
      }

      const pointIdFactory = pointObject.userData.copcPointId;
      const pickId = typeof pointIdFactory === 'function'
        ? pointIdFactory(pointIndex)
        : undefined;
      if (!isCopcPointPickId(pickId) || pickId.ownerId !== this.pickOwnerId) {
        continue;
      }

      const node = this.core.getHierarchyNode(pickId.nodeKey);
      const points = this.core.getCachedPointBuffer(pickId.nodeKey);
      const inspection = node && points
        ? inspectCopcPoint(pickId, node.node, points, this.core.getSnapshot().backend)
        : undefined;
      if (!inspection || !this.pointRenderer.hasNode(pickId.nodeKey)) {
        continue;
      }

      this.selectedPointPickId = {
        nodeKey: pickId.nodeKey,
        pointIndex: pickId.pointIndex,
        ownerId: pickId.ownerId,
      };
      this.selectedPointLoadGeneration = this.loadGeneration;
      this.options.onPointPicked?.(inspection);
      return inspection;
    }

    this.clearSelectedPoint();
    return undefined;
  }

  getSnapshot(): CopcThreeLayerSnapshot {
    const coreSnapshot = this.core.getSnapshot();
    return {
      lifecycle: this.lifecycle,
      attached: this.attachment !== undefined,
      datasetUrl: this.options.url,
      backend: coreSnapshot.backend,
      selectedNodeKeys: coreSnapshot.selectedNodeKeys,
      renderedNodeKeys: this.getRenderedNodeKeys(),
      renderedPointCount: this.getRenderedPointCount(),
      streamingUpdateCount: coreSnapshot.streamingUpdateCount
        + (this.activeStreamingUpdate?.progressApplied ? 1 : 0),
      performance: coreSnapshot.performance,
      renderer: { ...this.rendererPerformance },
      transition: { ...this.transitionDiagnostics },
      ...(coreSnapshot.hierarchy ? { hierarchy: coreSnapshot.hierarchy } : {}),
      pointCache: coreSnapshot.pointCache,
      ...(coreSnapshot.worker ? { worker: coreSnapshot.worker } : {}),
    };
  }

  private async runPendingStreamingUpdates(): Promise<void> {
    while (this.updatePending) {
      this.updatePending = false;
      await this.performStreamingUpdate();
    }
  }

  private async performStreamingUpdate(): Promise<void> {
    const attachment = this.attachment;
    if (!attachment || !this.core.getMetadata() || this.lifecycle === 'destroyed') {
      return;
    }

    const generation = ++this.streamingGeneration;
    const view = this.createView(attachment);
    if (this.lastStreamingView && areStreamingViewsEquivalent(this.lastStreamingView, view)) {
      return;
    }
    this.lastStreamingView = view;
    const activeStreamingUpdate: ActiveStreamingUpdate = { progressApplied: false };
    this.activeStreamingUpdate = activeStreamingUpdate;
    let progressApplied = false;
    const onProgress: CopcStreamingProgressHandler = (progress) => {
      if (!this.isCurrentStreamingGeneration(generation, attachment)) {
        return;
      }
      progressApplied = true;
      if (progress.loadedNodePoints.size > 0) {
        activeStreamingUpdate.progressApplied = true;
      }
      this.applyStreamingProgress(progress, generation);
    };

    let update: Awaited<ReturnType<CopcStreamingCore['updateView']>>;
    try {
      update = await this.core.updateView(view, onProgress);
    } catch (error: unknown) {
      if (this.lastStreamingView === view) {
        this.lastStreamingView = undefined;
      }
      if (this.activeStreamingUpdate === activeStreamingUpdate) {
        this.activeStreamingUpdate = undefined;
      }
      throw error;
    }
    if (this.activeStreamingUpdate === activeStreamingUpdate) {
      this.activeStreamingUpdate = undefined;
    }
    if (!this.isCurrentStreamingGeneration(generation, attachment) || !update) {
      return;
    }
    if (!progressApplied) {
      this.applyStreamingProgress({
        ...update,
        completedBatchPointCount: update.loadedNodePoints.size,
      }, generation);
    }
  }

  private applyStreamingProgress(progress: StreamingProgress, generation: number): void {
    this.reconcileReplacementGroups(
      progress.replacementGroups ?? [],
      generation,
      progress.selectedNodeKeys,
    );

    for (const nodeKey of progress.removedNodeKeys) {
      if (!this.isReplacementOldNode(nodeKey)) {
        this.removeRenderedNode(nodeKey);
      }
    }
    for (const [nodeKey, points] of progress.loadedNodePoints) {
      if (!progress.selectedNodeKeys.includes(nodeKey) || this.pointRenderer.hasNode(nodeKey)) {
        continue;
      }
      if (this.getProjectedPointCount(nodeKey, points.pointCount) > this.getMaxRenderedPoints()) {
        continue;
      }
      this.addRenderedNode(nodeKey, points);
    }

    this.commitReadyReplacementGroups(generation);
    this.updateTransitionDiagnostics();
  }

  private addRenderedNode(nodeKey: string, points: PreparedPointData): void {
    this.pointRenderer.addOrUpdateNode(nodeKey, points, {
      pointSize: this.options.pointSize ?? 3,
      colorMode: this.options.colorMode ?? 'fixed',
      elevationRange: points.statistics?.elevation,
      rgbMax: points.statistics?.rgbMax ?? this.pointStyleState.getRgbMax(points),
      pointId: (pointIndex) => ({
        nodeKey,
        pointIndex,
        ownerId: this.pickOwnerId,
      }),
      onPerformance: (stage: ThreePointRendererPerformanceStage, durationMs: number) => {
        const metric = `${stage}DurationMs` as keyof CopcThreeRendererPerformanceSnapshot;
        if (metric in this.rendererPerformance) {
          this.rendererPerformance[metric] += durationMs;
        }
      },
    } satisfies ThreePointRendererOptions);
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
    const stagedNodeKeys = new Set(previousGroups.flatMap((group) => group.newNodeKeys));
    for (const nodeKey of stagedNodeKeys) {
      if (!selectedNodeKeys.includes(nodeKey)) {
        this.removeRenderedNode(nodeKey);
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
        this.removeRenderedNode(nodeKey);
      }
    }

    const incomingOldNodeKeys = new Set(replacementGroups.flatMap((group) => group.oldNodeKeys));
    const incomingNewNodeKeys = new Set(replacementGroups.flatMap((group) => group.newNodeKeys));
    const groupsCoverRenderer = renderedOldNodeKeys.every((key) => incomingOldNodeKeys.has(key))
      && desiredNewNodeKeys.every((key) => incomingNewNodeKeys.has(key));
    const groups = renderedOldNodeKeys.length > 0 && desiredNewNodeKeys.length > 0
      && !groupsCoverRenderer
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

  private inferReplacementKind(groups: readonly StreamingReplacementGroup[]): StreamingReplacementKind {
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
      [...this.activeReplacementGroups.values()].flatMap((group) => group.oldNodeKeys),
    );
    for (const oldNodeKey of replacedNodeKeys) {
      if (this.pointRenderer.hasNode(oldNodeKey)) {
        projectedPointCount -= this.pointRenderer.getRenderedNodePointCount?.(oldNodeKey)
          ?? this.core.getHierarchyNode(oldNodeKey)?.node.pointCount
          ?? 0;
      }
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
        this.removeRenderedNode(oldNodeKey);
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

  private removeRenderedNode(nodeKey: string): void {
    if (this.selectedPointPickId?.nodeKey === nodeKey) {
      this.clearSelectedPoint();
    }
    this.pointRenderer.removeNode(nodeKey);
  }

  private getOwnedPointObject(object: THREE.Object3D): THREE.Object3D | undefined {
    const root = this.pointRenderer.getRoot();
    let candidate: THREE.Object3D | null = object;
    while (candidate && candidate.parent && candidate.parent !== root) {
      candidate = candidate.parent;
    }
    if (!candidate || candidate.parent !== root) {
      return undefined;
    }
    const nodeKey = candidate.userData.copcNodeKey;
    return typeof nodeKey === 'string' && this.pointRenderer.hasNode(nodeKey)
      ? candidate
      : undefined;
  }

  private clearSelectedPoint(): void {
    if (!this.selectedPointPickId) {
      return;
    }
    this.selectedPointPickId = undefined;
    this.selectedPointLoadGeneration = 0;
    this.options.onPointPicked?.(undefined);
  }

  private createView(attachment: CopcThreeLayerAttachment): StreamingView {
    if (!this.localFrame) {
      throw new Error('CopcThreeLayer has no dataset-local frame');
    }
    return createThreeStreamingView({
      camera: attachment.camera,
      frame: this.localFrame,
      renderer: attachment.renderer,
      maxRenderDistanceMeters: this.getMaxRenderDistanceMeters(),
    });
  }

  private applyLocalFrame(): void {
    if (this.localFrame) {
      this.pointRenderer.setLocalFrame?.(this.localFrame);
    }
  }

  private getMaxRenderDistanceMeters(): number {
    const value = this.options.streaming?.maxRenderDistanceMeters;
    return value !== undefined && isFinitePositive(value) ? value : 12000;
  }

  private getMaxRenderedPoints(): number {
    const value = this.options.maxRenderedPoints ?? this.options.streaming?.maxRenderedPoints;
    return value !== undefined && isFinitePositive(value) ? value : DEFAULT_MAX_RENDERED_POINTS;
  }

  private resetRendererPerformance(): void {
    this.rendererPerformance = createRendererPerformanceSnapshot();
  }

  private isCurrentStreamingGeneration(
    generation: number,
    attachment: CopcThreeLayerAttachment,
  ): boolean {
    return generation === this.streamingGeneration
      && this.attachment === attachment
      && this.lifecycle !== 'destroyed';
  }

  private debug(message: string): void {
    if (this.options.debug) {
      console.debug(`[CopcThreeLayer] ${message}`);
    }
  }
}
